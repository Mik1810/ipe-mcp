#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { PNG } from "pngjs";
import { SaxesParser } from "saxes";
import jpeg from "jpeg-js";

process.on("uncaughtException", (error) => {
  if (process.env.IPE_M6_DEBUG === "1") process.stderr.write(`${error?.stack ?? error}\n`);
  if (/^RESOURCE:/u.test(String(error?.message))) process.stderr.write("IPE_M6_ERROR=resource\n");
  else process.stderr.write("IPE_M6_ERROR=artifact\n");
  process.exit(1);
});

const [, , operation, ...paths] = process.argv;
const limits = JSON.parse(process.env.IPE_M6_ARTIFACT_LIMITS ?? "{}");
const fail = (message) => { throw new Error(message); };
const read = async (path) => {
  const data = await readFile(path);
  if (data.length < 1 || data.length > limits.maxArtifactBytes) fail("invalid artifact size");
  return data;
};

function png(data, requirePaint = true) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 33 || !data.subarray(0, 8).equals(signature) || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") fail("invalid PNG header");
  const width = data.readUInt32BE(16); const height = data.readUInt32BE(20);
  const depth = data[24]; const color = data[25];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (data[26] !== 0 || data[27] !== 0 || data[28] !== 0 || !depths[color]?.includes(depth)) fail("invalid PNG encoding");
  if (width < 1 || height < 1) fail("invalid PNG dimensions");
  if (width > limits.maxWidth || height > limits.maxHeight || width * height > limits.maxPixels || width * height * 4 > limits.maxDecodedBytes) fail("RESOURCE: PNG dimensions");
  let decoded;
  try { decoded = PNG.sync.read(data); } catch { fail("invalid PNG stream"); }
  if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) fail("inconsistent PNG dimensions");
  if (requirePaint && !paintedPixels(decoded).some(Boolean)) fail("PNG has no visible content");
  return { width, height, decoded };
}

function paintedPixels(image) {
  const result = new Uint8Array(image.width * image.height);
  for (let pixel = 0, offset = 0; offset < image.data.length; pixel += 1, offset += 4) {
    result[pixel] = image.data[offset + 3] > 0 && (image.data[offset] < 255 || image.data[offset + 1] < 255 || image.data[offset + 2] < 255) ? 1 : 0;
  }
  return result;
}

function compare(leftData, rightData) {
  const left = png(leftData).decoded; const right = png(rightData).decoded;
  if (left.width !== right.width || left.height !== right.height) fail("raster dimensions differ");
  const leftPaint = paintedPixels(left); const rightPaint = paintedPixels(right);
  let foreground = 0; let foregroundMismatch = 0; let material = 0;
  const hasNearby = (paint, pixel) => {
    const x = pixel % left.width; const y = Math.floor(pixel / left.width);
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      const nx = x + dx; const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < left.width && ny < left.height && paint[ny * left.width + nx]) return true;
    }
    return false;
  };
  for (let pixel = 0, offset = 0; pixel < leftPaint.length; pixel += 1, offset += 4) {
    const relevant = leftPaint[pixel] || rightPaint[pixel];
    if (relevant) foreground += 1;
    const delta = Math.max(...[0, 1, 2, 3].map((channel) => Math.abs(left.data[offset + channel] - right.data[offset + channel])));
    if (leftPaint[pixel] && rightPaint[pixel] && delta > 32) foregroundMismatch += 1;
    if (leftPaint[pixel] && rightPaint[pixel] && delta > 64) material += 1;
  }
  // A foreground component is matched when any of its pixels overlaps the
  // opposite raster's two-pixel antialias neighborhood. This is symmetric and
  // size-independent: an isolated one-pixel addition or omission still fails.
  const unmatchedComponents = (mask, opposite) => { let count = 0; const seen = new Uint8Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let matched = false; const queue = [start]; seen[start] = 1;
    while (queue.length) {
      const pixel = queue.pop(); if (hasNearby(opposite, pixel)) matched = true; const x = pixel % left.width; const y = Math.floor(pixel / left.width);
      for (const next of [x > 0 ? pixel - 1 : -1, x + 1 < left.width ? pixel + 1 : -1, y > 0 ? pixel - left.width : -1, y + 1 < left.height ? pixel + left.width : -1]) {
        if (next >= 0 && mask[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
      }
    }
    if (!matched) count += 1;
  } return count; };
  const additions = unmatchedComponents(leftPaint, rightPaint); const omissions = unmatchedComponents(rightPaint, leftPaint);
  if (foreground === 0 || foregroundMismatch / foreground > 0.35 || material / foreground > 0.25 || additions > 0 || omissions > 0) fail(`raster content mismatch foreground=${foreground} mismatch=${foregroundMismatch} material=${material} additions=${additions} omissions=${omissions}`);
  return { width: left.width, height: left.height };
}

function svg(data) {
  if (data.length > 4 * 1024 * 1024) fail("RESOURCE: SVG source");
  const source = data.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) fail("prohibited SVG declaration");
  const withoutDeclaration = source.replace(/^\uFEFF?\s*<\?xml\s+[^?]*\?>/iu, "");
  if (/<\?/u.test(withoutDeclaration)) fail("prohibited SVG processing instruction");
  const root = { name: "#document", attributes: {}, children: [], text: "" }; const stack = [root]; let nodes = 0;
  const parser = new SaxesParser({ xmlns: false });
  parser.on("processinginstruction", () => fail("prohibited SVG processing instruction"));
  parser.on("opentag", (tag) => { if (++nodes > 100000 || stack.length > 256) fail("RESOURCE: SVG structure"); const node = { name: tag.name.toLowerCase(), attributes: Object.fromEntries(Object.entries(tag.attributes).map(([k, v]) => [k.toLowerCase(), String(v)])), children: [], text: "" }; stack.at(-1).children.push(node); stack.push(node); });
  parser.on("text", (text) => { stack.at(-1).text += text; }); parser.on("closetag", () => stack.pop()); parser.write(source).close();
  const document = root.children.find((node) => node.name === "svg"); if (!document) fail("missing SVG root");
  const idNodes = new Map(); const visit = (node) => { if (node.attributes.id) { if (idNodes.has(node.attributes.id)) fail("duplicate SVG id"); idNodes.set(node.attributes.id, node); } for (const child of node.children) visit(child); }; visit(document);
  let embeddedBytes = 0;
  const refs = (node) => {
    if (["script", "foreignobject", "iframe", "object", "embed", "audio", "video", "style"].includes(node.name)) fail("prohibited active SVG element");
    for (const [name, raw] of Object.entries(node.attributes)) {
      for (const match of raw.matchAll(/url\(([^)]*)\)/giu)) {
        const reference = match[1].trim().replace(/^['"]|['"]$/gu, "");
        if (!reference.startsWith("#") || !idNodes.has(reference.slice(1))) fail("external or invalid SVG URL reference");
      }
      if (name === "xml:base" || name === "src") fail("prohibited SVG base or source reference");
      if (!["href", "xlink:href"].includes(name)) continue;
      const value = raw.trim();
      if (value.startsWith("#")) {
        const target = idNodes.get(value.slice(1));
        if (!target || (node.name !== "use" && !(node.name === "image" && target.name === "image"))) fail("invalid local fragment");
        continue;
      }
      if (node.name !== "image") fail("external SVG reference");
      const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
      if (!match || match[2].length % 4 !== 0) fail("external or invalid image reference");
      const decoded = Buffer.from(match[2], "base64");
      if (decoded.length < 1 || decoded.toString("base64") !== match[2]) fail("embedded image encoding mismatch");
      embeddedBytes += decoded.length; if (embeddedBytes > Math.min(limits.maxArtifactBytes, 4 * 1024 * 1024)) fail("RESOURCE: embedded images");
      if (match[1] === "png") png(decoded, false);
      else {
        let image; try { image = jpeg.decode(decoded, { useTArray: true, formatAsRGBA: true }); } catch { fail("invalid embedded JPEG"); }
        if (!image || image.width < 1 || image.height < 1 || image.width > limits.maxWidth || image.height > limits.maxHeight || image.width * image.height > limits.maxPixels || image.data.length > limits.maxDecodedBytes) fail("RESOURCE: embedded JPEG dimensions");
      }
    }
    for (const child of node.children) refs(child);
  }; refs(document);
  const number = (value) => value && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px|pt)?$/iu.test(value.trim()) ? Number.parseFloat(value) : undefined;
  const viewBoxNumber = (value) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) && Number.isFinite(Number(value)) ? Number(value) : undefined;
  const vb = (document.attributes.viewbox ?? "").trim().split(/[ ,]+/u).filter(Boolean).map(viewBoxNumber);
  if (document.attributes.viewbox === undefined || vb.length !== 4 || vb.some((value) => value === undefined) || vb[2] <= 0 || vb[3] <= 0) fail("invalid SVG viewBox");
  const explicitWidth = number(document.attributes.width); const explicitHeight = number(document.attributes.height);
  if ((document.attributes.width !== undefined && (!explicitWidth || !Number.isFinite(explicitWidth))) || (document.attributes.height !== undefined && (!explicitHeight || !Number.isFinite(explicitHeight)))) fail("invalid explicit SVG dimensions");
  const width = explicitWidth ?? vb[2]; const height = explicitHeight ?? vb[3];
  if (width > limits.maxWidth || height > limits.maxHeight || width * height > limits.maxPixels || width * height * 4 > limits.maxDecodedBytes) fail("RESOURCE: SVG dimensions");
  const paint = (attributes, parent) => {
    const declarations = Object.fromEntries((attributes.style ?? "").split(";").map((part) => part.split(":", 2).map((item) => item.trim())).filter((pair) => pair.length === 2 && pair[0]));
    const get = (name) => attributes[name] ?? declarations[name]; const transparent = (value) => value !== undefined && /^(?:none|transparent)$/iu.test(value);
    return { display: parent.display && get("display") !== "none" && !["hidden", "collapse"].includes(get("visibility")), opacity: parent.opacity * Math.max(0, Math.min(1, number(get("opacity")) ?? 1)), fill: (get("fill") === undefined ? parent.fill : !transparent(get("fill"))) && (number(get("fill-opacity")) ?? 1) > 0, stroke: (get("stroke") === undefined ? parent.stroke : !transparent(get("stroke"))) && (number(get("stroke-opacity")) ?? 1) > 0, strokeWidth: number(get("stroke-width")) ?? parent.strokeWidth };
  };
  const geometry = (node, current) => {
    const positive = (name) => (number(node.attributes[name]) ?? 0) > 0;
    if (["rect", "image"].includes(node.name)) return positive("width") && positive("height") && (node.name === "image" || current.fill || (current.stroke && current.strokeWidth > 0));
    if (node.name === "circle") return positive("r") && (current.fill || current.stroke);
    if (node.name === "ellipse") return positive("rx") && positive("ry") && (current.fill || current.stroke);
    if (node.name === "line") return (number(node.attributes.x1) !== number(node.attributes.x2) || number(node.attributes.y1) !== number(node.attributes.y2)) && current.stroke && current.strokeWidth > 0;
    if (["polygon", "polyline"].includes(node.name)) return new Set((node.attributes.points ?? "").match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/gu) ?? []).size > 1 && (current.fill || current.stroke);
    if (node.name === "path") return ((node.attributes.d ?? "").match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/gu)?.length ?? 0) >= 2 && (current.fill || current.stroke);
    if (node.name === "text") return node.text.trim() && (current.fill || current.stroke);
    return false;
  };
  const painted = (node, parent, references = new Set(), inDefs = false) => {
    const current = paint(node.attributes, parent); if (!current.display || current.opacity <= 0) return false;
    const definitions = inDefs || node.name === "defs"; if (!definitions && geometry(node, current)) return true;
    const href = node.attributes.href ?? node.attributes["xlink:href"];
    if (!definitions && node.name === "use" && href?.startsWith("#") && !references.has(href.slice(1))) { const target = idNodes.get(href.slice(1)); if (target && painted(target, current, new Set([...references, href.slice(1)]))) return true; }
    return node.children.some((child) => painted(child, current, references, definitions));
  };
  if (!painted(document, { display: true, opacity: 1, fill: true, stroke: false, strokeWidth: 1 })) fail("SVG has no visible content");
  return { width, height };
}

function xml(data) {
  if (/<!ENTITY/iu.test(data.toString("utf8"))) fail("prohibited XML entity");
  let depth = 0; let nodes = 0; const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", () => { if (++nodes > 200000 || ++depth > 512) fail("RESOURCE: XML structure"); }); parser.on("closetag", () => { depth -= 1; }); parser.write(data.toString("utf8")).close();
  return {};
}

let result;
if (operation === "png") result = png(await read(paths[0]));
else if (operation === "png-header") { const value = png(await read(paths[0]), false); result = { width: value.width, height: value.height }; }
else if (operation === "svg") result = svg(await read(paths[0]));
else if (operation === "compare-png") result = compare(await read(paths[0]), await read(paths[1]));
else if (operation === "pdf") { const data = await read(paths[0]); const tail = data.subarray(Math.max(0, data.length - 1024)); if (!data.subarray(0, 5).equals(Buffer.from("%PDF-")) || !/%%EOF[\t\r\n ]*$/u.test(tail.toString("latin1")) || !/\b(?:startxref|xref)\b/u.test(data.toString("latin1"))) fail("invalid PDF envelope"); result = {}; }
else if (operation === "xml") result = xml(await read(paths[0]));
else fail("unknown operation");
process.stdout.write(`IPE_M6_PROTOCOL=ipe-mcp-artifact/1\nIPE_M6_RESULT=PASS\nIPE_M6_DATA=${JSON.stringify(result, (key, value) => key === "decoded" ? undefined : value)}\n`);
