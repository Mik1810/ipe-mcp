import { PNG } from "pngjs";
import { SaxesParser } from "saxes";

import { NativeIpeError, type NativeErrorCode } from "./errors.js";

export interface RasterLimits {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
  readonly maxDecodedBytes: number;
}

export const DEFAULT_RASTER_LIMITS: RasterLimits = {
  maxWidth: 16_384,
  maxHeight: 16_384,
  maxPixels: 64 * 1024 * 1024,
  maxDecodedBytes: 256 * 1024 * 1024,
};

export function validatePdfEnvelope(data: Buffer, failure: NativeErrorCode): void {
  if (!data.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new NativeIpeError(failure, "export did not produce a PDF header");
  const tail = data.subarray(Math.max(0, data.length - 1024));
  if (!/%%EOF[\t\r\n ]*$/u.test(tail.toString("latin1"))) throw new NativeIpeError(failure, "exported PDF has no final EOF trailer");
  if (!/\b(?:startxref|xref)\b/u.test(data.toString("latin1"))) throw new NativeIpeError(failure, "exported PDF has no cross-reference trailer");
}

export function validatePngHeader(data: Buffer, limits: RasterLimits, failure: NativeErrorCode): { readonly width: number; readonly height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 33 || !data.subarray(0, 8).equals(signature) || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new NativeIpeError(failure, "rendered PNG has an invalid signature or IHDR");
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const bitDepth = data[24]!;
  const colorType = data[25]!;
  const compression = data[26]!;
  const filter = data[27]!;
  const interlace = data[28]!;
  const legalDepths: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (compression !== 0 || filter !== 0 || interlace !== 0 || !legalDepths[colorType]?.includes(bitDepth)) {
    throw new NativeIpeError(failure, "rendered PNG has an unsupported or invalid IHDR encoding");
  }
  const pixels = width * height;
  const decodedBytes = pixels * 4;
  if (width < 1 || height < 1 || width > limits.maxWidth || height > limits.maxHeight || pixels > limits.maxPixels || decodedBytes > limits.maxDecodedBytes) {
    throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `rendered PNG dimensions ${width}x${height} exceed safe raster limits`);
  }
  return { width, height };
}

export function validatePng(data: Buffer, limits: RasterLimits, failure: NativeErrorCode): { readonly width: number; readonly height: number } {
  const { width, height } = validatePngHeader(data, limits, failure);
  const decodedBytes = width * height * 4;
  let png: PNG;
  try { png = PNG.sync.read(data); }
  catch (error) { throw new NativeIpeError(failure, "rendered PNG is invalid", [], { cause: error }); }
  if (png.width !== width || png.height !== height || png.data.length !== decodedBytes) throw new NativeIpeError(failure, "rendered PNG decoded dimensions are inconsistent");
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (png.data[offset + 3]! > 0 && (png.data[offset]! < 255 || png.data[offset + 1]! < 255 || png.data[offset + 2]! < 255)) return { width, height };
  }
  throw new NativeIpeError(failure, "rendered PNG contains no visible non-white pixels");
}

export function comparePngSemantics(actual: Buffer, expected: Buffer, limits: RasterLimits, failure: NativeErrorCode): void {
  validatePng(actual, limits, failure);
  validatePng(expected, limits, failure);
  const left = PNG.sync.read(actual);
  const right = PNG.sync.read(expected);
  if (left.width !== right.width || left.height !== right.height) throw new NativeIpeError(failure, "rasterized PDF page dimensions do not match its expected view");
  let materiallyDifferent = 0;
  const pixels = left.width * left.height;
  const paint = (image: PNG): Uint8Array => {
    const mask = new Uint8Array(pixels);
    for (let pixel = 0, offset = 0; pixel < pixels; pixel += 1, offset += 4) mask[pixel] = image.data[offset + 3]! > 0 && (image.data[offset]! < 255 || image.data[offset + 1]! < 255 || image.data[offset + 2]! < 255) ? 1 : 0;
    return mask;
  };
  const leftPaint = paint(left); const rightPaint = paint(right);
  for (let offset = 0; offset < left.data.length; offset += 4) {
    const delta = Math.max(
      Math.abs(left.data[offset]! - right.data[offset]!),
      Math.abs(left.data[offset + 1]! - right.data[offset + 1]!),
      Math.abs(left.data[offset + 2]! - right.data[offset + 2]!),
      Math.abs(left.data[offset + 3]! - right.data[offset + 3]!),
    );
    if (delta > 32) materiallyDifferent += 1;
  }
  const hasNearby = (mask: Uint8Array, pixel: number): boolean => {
    const x = pixel % left.width; const y = Math.floor(pixel / left.width);
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      const nx = x + dx; const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < left.width && ny < left.height && mask[ny * left.width + nx]) return true;
    }
    return false;
  };
  const unmatched = (mask: Uint8Array, opposite: Uint8Array): boolean => {
    const seen = new Uint8Array(pixels);
    for (let start = 0; start < pixels; start += 1) {
      if (!mask[start] || seen[start]) continue;
      let matched = false; const queue = [start]; seen[start] = 1;
      while (queue.length > 0) {
        const pixel = queue.pop()!; if (hasNearby(opposite, pixel)) matched = true;
        const x = pixel % left.width; const y = Math.floor(pixel / left.width);
        for (const next of [x > 0 ? pixel - 1 : -1, x + 1 < left.width ? pixel + 1 : -1, y > 0 ? pixel - left.width : -1, y + 1 < left.height ? pixel + left.width : -1]) if (next >= 0 && mask[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
      }
      if (!matched) return true;
    }
    return false;
  };
  // Poppler and Ipe use different antialiasers; tolerate edge-level drift only.
  if (materiallyDifferent / pixels > 0.02 || unmatched(leftPaint, rightPaint) || unmatched(rightPaint, leftPaint)) throw new NativeIpeError(failure, "rasterized PDF page does not match its expected page/view render");
}

interface SvgNode { readonly name: string; readonly attributes: Record<string, string>; readonly children: SvgNode[]; text: string }
interface Paint { readonly display: boolean; readonly opacity: number; readonly fill: boolean; readonly stroke: boolean; readonly strokeWidth: number }

function number(value: string | undefined): number | undefined {
  if (value === undefined || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px|pt)?$/iu.test(value.trim())) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function viewBoxNumber(value: string): number | undefined {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function style(attributes: Record<string, string>, parent: Paint): Paint {
  const declarations = Object.fromEntries((attributes.style ?? "").split(";").map((part) => part.split(":", 2).map((item) => item.trim())).filter((pair) => pair.length === 2 && pair[0] !== "")) as Record<string, string>;
  const get = (name: string) => attributes[name] ?? declarations[name];
  const localOpacity = number(get("opacity")) ?? 1;
  const transparent = (value: string | undefined) => value !== undefined && (/^(?:none|transparent)$/iu.test(value) || /rgba\([^)]*,\s*0(?:\.0*)?\s*\)$/iu.test(value) || /^#[0-9a-f]{6}00$/iu.test(value));
  const fill = get("fill") === undefined ? parent.fill : !transparent(get("fill"));
  const stroke = get("stroke") === undefined ? parent.stroke : !transparent(get("stroke"));
  return {
    display: parent.display && get("display") !== "none" && get("visibility") !== "hidden" && get("visibility") !== "collapse",
    opacity: parent.opacity * Math.max(0, Math.min(1, localOpacity)),
    fill: fill && (number(get("fill-opacity")) ?? 1) > 0,
    stroke: stroke && (number(get("stroke-opacity")) ?? 1) > 0,
    strokeWidth: number(get("stroke-width")) ?? parent.strokeWidth,
  };
}

function nonzeroGeometry(node: SvgNode, paint: Paint): boolean {
  const a = node.attributes;
  const positive = (name: string) => (number(a[name]) ?? 0) > 0;
  if (node.name === "rect" || node.name === "image") return positive("width") && positive("height") && (node.name === "image" || paint.fill || (paint.stroke && paint.strokeWidth > 0));
  if (node.name === "circle") return positive("r") && (paint.fill || (paint.stroke && paint.strokeWidth > 0));
  if (node.name === "ellipse") return positive("rx") && positive("ry") && (paint.fill || (paint.stroke && paint.strokeWidth > 0));
  if (node.name === "line") return (number(a.x1) !== number(a.x2) || number(a.y1) !== number(a.y2)) && paint.stroke && paint.strokeWidth > 0;
  if (node.name === "polygon" || node.name === "polyline") return new Set((a.points ?? "").match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/gu) ?? []).size > 1 && (paint.fill || (paint.stroke && paint.strokeWidth > 0));
  if (node.name === "path") return ((a.d ?? "").match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/gu)?.length ?? 0) >= 2 && (paint.fill || (paint.stroke && paint.strokeWidth > 0));
  if (node.name === "text") return node.text.trim() !== "" && (paint.fill || (paint.stroke && paint.strokeWidth > 0));
  return false;
}

export function validateSvg(data: Buffer, limits: RasterLimits, failure: NativeErrorCode): { readonly width: number; readonly height: number } {
  if (data.length > 4 * 1024 * 1024) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", "rendered SVG source exceeds the 4 MiB parser limit");
  const source = data.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) throw new NativeIpeError(failure, "rendered SVG contains prohibited declarations");
  const withoutDeclaration = source.replace(/^\uFEFF?\s*<\?xml\s+[^?]*\?>/iu, "");
  if (/<\?/u.test(withoutDeclaration)) throw new NativeIpeError(failure, "rendered SVG contains a prohibited processing instruction");
  const root: SvgNode = { name: "#document", attributes: {}, children: [], text: "" };
  const stack = [root];
  let nodes = 0;
  try {
    const parser = new SaxesParser({ xmlns: false });
    parser.on("processinginstruction", () => { throw new Error("SVG processing instructions are prohibited"); });
    parser.on("opentag", (tag) => {
      nodes += 1;
      if (nodes > 100_000 || stack.length > 256) throw new Error("SVG structure limit exceeded");
      const node: SvgNode = { name: tag.name.toLowerCase(), attributes: Object.fromEntries(Object.entries(tag.attributes).map(([key, value]) => [key.toLowerCase(), String(value)])), children: [], text: "" };
      stack.at(-1)!.children.push(node); stack.push(node);
    });
    parser.on("text", (text) => { stack.at(-1)!.text += text; });
    parser.on("closetag", () => { stack.pop(); });
    parser.write(source).close();
  } catch (error) { throw new NativeIpeError(failure, "rendered SVG is invalid or too complex", [], { cause: error }); }
  const svg = root.children.find((node) => node.name === "svg");
  if (svg === undefined) throw new NativeIpeError(failure, "rendered SVG has no root element");
  const viewBoxTokens = (svg.attributes.viewbox ?? "").trim().split(/[ ,]+/u).filter(Boolean);
  const viewBox = viewBoxTokens.map(viewBoxNumber);
  if (svg.attributes.viewbox === undefined || viewBox.length !== 4 || viewBox.some((value) => value === undefined) || viewBox[2]! <= 0 || viewBox[3]! <= 0) {
    throw new NativeIpeError(failure, "rendered SVG viewBox must contain exactly four finite numbers with positive extents");
  }
  const explicitWidth = number(svg.attributes.width);
  const explicitHeight = number(svg.attributes.height);
  if ((svg.attributes.width !== undefined && (explicitWidth === undefined || explicitWidth <= 0))
    || (svg.attributes.height !== undefined && (explicitHeight === undefined || explicitHeight <= 0))) {
    throw new NativeIpeError(failure, "rendered SVG explicit dimensions must be finite and positive");
  }
  const width = explicitWidth ?? viewBox[2];
  const height = explicitHeight ?? viewBox[3];
  if (width === undefined || height === undefined || width <= 0 || height <= 0 || width > limits.maxWidth || height > limits.maxHeight || width * height > limits.maxPixels || width * height * 4 > limits.maxDecodedBytes) {
    throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", "rendered SVG has unsafe or invalid dimensions");
  }
  const ids = new Map<string, SvgNode>();
  const index = (node: SvgNode): void => { if (node.attributes.id) ids.set(node.attributes.id, node); for (const child of node.children) index(child); };
  index(svg);
  const assertReferences = (node: SvgNode): void => {
    if (node.name === "image") {
      const href = node.attributes.href ?? node.attributes["xlink:href"];
      if (href === undefined || href.trim() === "") throw new NativeIpeError(failure, "rendered SVG image has no href");
    }
    if (node.name === "use") {
      const href = node.attributes.href ?? node.attributes["xlink:href"];
      if (href === undefined || !href.startsWith("#") || !ids.has(href.slice(1))) throw new NativeIpeError(failure, "rendered SVG use has an invalid or missing local href");
    }
    for (const child of node.children) assertReferences(child);
  };
  assertReferences(svg);
  const base: Paint = { display: true, opacity: 1, fill: true, stroke: false, strokeWidth: 1 };
  const painted = (node: SvgNode, inherited: Paint, references: ReadonlySet<string>, inDefs = false): boolean => {
    const current = style(node.attributes, inherited);
    if (!current.display || current.opacity <= 0) return false;
    const definitions = inDefs || node.name === "defs";
    if (!definitions && nonzeroGeometry(node, current)) return true;
    if (!definitions && node.name === "use") {
      const href = node.attributes.href ?? node.attributes["xlink:href"];
      if (href?.startsWith("#") && !references.has(href.slice(1))) {
        const target = ids.get(href.slice(1));
        if (target !== undefined && painted(target, current, new Set([...references, href.slice(1)]), false)) return true;
      }
    }
    return node.children.some((child) => painted(child, current, references, definitions));
  };
  if (!painted(svg, base, new Set())) throw new NativeIpeError(failure, "rendered SVG contains no painted nonzero visible geometry");
  return { width, height };
}
