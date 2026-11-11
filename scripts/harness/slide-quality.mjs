import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { PNG } from "pngjs";
import { z } from "zod";

import { ipeDocumentCodec } from "../../dist/src/core/ipe-document-codec.js";
import { hasArtifactSignature } from "./adapters/portable-mcp.mjs";
import { compareHeadingAnchors, parsePdfLines } from "./slide-style.mjs";

const exec = promisify(execFile);
export const run = (command, args, options = {}) => exec(command, args, {
  timeout: 90_000, maxBuffer: 4 * 1024 * 1024, ...options,
});
export const maxViews = 24;
const ordinal = z.int().positive().max(500);
const labels = z.array(z.string().min(1).max(200)).max(16);
export const reviewSchema = z.strictObject({
  views: z.array(z.strictObject({
    slide: ordinal, view: ordinal,
    layers: labels.min(1),
    present: labels.min(1),
    absent: labels.default([]),
  })).min(1).max(maxViews),
  stableHeadings: z.array(z.strictObject({
    slide: ordinal,
    text: z.string().trim().min(1).max(200),
    intentionalMoves: z.array(z.strictObject({
      view: ordinal,
      reason: z.string().trim().min(1).max(500),
    })).max(maxViews - 1).default([]),
  })).max(maxViews).default([]),
  intentionalOverlaps: z.array(z.strictObject({
    slide: ordinal, view: ordinal, objects: z.tuple([ordinal, ordinal]),
    reason: z.string().trim().min(1).max(500),
  })).max(500).default([]),
}).superRefine(({ views, intentionalOverlaps, stableHeadings }, context) => {
  const states = new Set(views.map(({ slide, view }) => viewKey(slide, view)));
  const pairs = new Set();
  if (states.size !== views.length) context.addIssue({ code: "custom", message: "Duplicate view" });
  const anchoredSlides = new Set();
  for (const { slide, intentionalMoves } of stableHeadings) {
    if (anchoredSlides.has(slide) || !states.has(viewKey(slide, 1)) || !states.has(viewKey(slide, 2))) {
      context.addIssue({ code: "custom", message: "Stable heading needs a unique slide with a reveal" });
    }
    anchoredSlides.add(slide);
    const moves = new Set();
    for (const { view } of intentionalMoves) {
      if (view === 1 || !states.has(viewKey(slide, view - 1)) ||
          !states.has(viewKey(slide, view)) || moves.has(view)) {
        context.addIssue({ code: "custom", message: "Invalid intentional heading move" });
      }
      moves.add(view);
    }
  }
  for (const { slide, view, objects: [first, second] } of intentionalOverlaps) {
    const key = overlapKey(slide, view, first, second);
    if (!states.has(viewKey(slide, view)) || first >= second || pairs.has(key)) {
      context.addIssue({ code: "custom", message: "Invalid intentional overlap" });
    }
    pairs.add(key);
  }
});

const viewKey = (slide, view) => "s" + slide + "-v" + view;
const overlapKey = (slide, view, first, second) => viewKey(slide, view) + ":" + first + ":" + second;
const normalized = (text) => text.replace(/\s+/gu, " ").trim();
const sameSet = (first, second) => isDeepStrictEqual([...first].sort(), [...second].sort());
// Ignore generated object identities when comparing editable CLI and MCP content.
export const editableContent = (source) =>
  source.replace(/ (?:custom="ipe-mcp:[0-9a-f-]+"|x-ipe-mcp-id="object-[0-9a-f]+")/gu, "");

export class CheckFailure extends Error {
  constructor(criterion, location = {}) {
    super(criterion);
    this.finding = { criterion, slide: null, view: null, evidence: null, ...location };
  }
}

export function requireCheck(value, criterion, location) {
  if (!value) throw new CheckFailure(criterion, location);
}

async function nativeBounds(pdf) {
  const { stdout } = await run("ipescript", ["slide-bounds", pdf], {
    env: { PATH: process.env.PATH, IPESCRIPTS: fileURLToPath(new URL(".", import.meta.url)) },
  });
  const [paperLine, ...lines] = stdout.trim().split("\n");
  const [x, y, width, height, ...extra] = paperLine.split(/\s+/u).map(Number);
  requireCheck(extra.length === 0 && [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0, "NATIVE_PAPER");
  const views = [];
  for (const line of lines) {
    const [kind, ...fields] = line.split(/\s+/u);
    const values = fields.map(Number);
    requireCheck(values.every(Number.isFinite), "NATIVE_BOUNDS");
    if (kind === "view" && values.length === 2) {
      const [slide, view] = values;
      views.push({ slide, view, boxes: [] });
    } else if (kind === "box" && values.length === 5 && views.length) {
      const [index, left, bottom, right, top] = values;
      views.at(-1).boxes.push({ index, left, bottom, right, top });
    } else {
      throw new CheckFailure("NATIVE_BOUNDS");
    }
  }
  return { paper: { x, y, width, height }, views };
}

function intersection(a, b) {
  return {
    left: Math.max(a.left, b.left), bottom: Math.max(a.bottom, b.bottom),
    right: Math.min(a.right, b.right), top: Math.min(a.top, b.top),
  };
}

function geometryFindings(state, paper, allowed) {
  // Paper bounds and pair intersections use the same 1 bp tolerance.
  const tolerance = 1;
  const { slide, view, boxes } = state;
  const findings = [];
  for (const [i, box] of boxes.entries()) {
    if (box.left < paper.x - tolerance || box.bottom < paper.y - tolerance ||
        box.right > paper.x + paper.width + tolerance || box.top > paper.y + paper.height + tolerance) {
      findings.push({ criterion: "OVERFLOW", slide, view, objects: [box.index], region: box });
    }
    for (const other of boxes.slice(i + 1)) {
      const region = intersection(box, other);
      if (region.right - region.left <= tolerance || region.top - region.bottom <= tolerance) continue;
      const key = overlapKey(slide, view, box.index, other.index);
      if (allowed.has(key)) {
        allowed.get(key).used = true;
      } else {
        findings.push({ criterion: "OVERLAP", slide, view, objects: [box.index, other.index], region });
      }
    }
  }
  return findings;
}

async function highlight(directory, stem, bytes, image, paper, findings) {
  const margin = 48;
  const sx = image.width / paper.width;
  const sy = image.height / paper.height;
  const projectX = (x) => Math.max(-margin + 3, Math.min(image.width + margin - 3, (x - paper.x) * sx));
  const projectY = (y) => Math.max(-margin + 3, Math.min(image.height + margin - 3, (paper.y + paper.height - y) * sy));
  const marks = findings.map(({ region }) => {
    const x = projectX(region.left);
    const y = projectY(region.top);
    const w = Math.max(3, projectX(region.right) - x);
    const h = Math.max(3, projectY(region.bottom) - y);
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"/>';
  }).join("");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
    [-margin, -margin, image.width + 2 * margin, image.height + 2 * margin].join(" ") + '">' +
    '<rect x="' + -margin + '" y="' + -margin + '" width="100%" height="100%" fill="#e8ebee"/>' +
    '<image width="' + image.width + '" height="' + image.height + '" href="data:image/png;base64,' + bytes.toString("base64") + '"/>' +
    '<g fill="#d6194520" stroke="#d61945" stroke-width="2">' + marks + '</g></svg>\n';
  const name = stem + "-findings.svg";
  await writeFile(join(directory, name), svg);
  return name;
}

export async function evaluateSlides(ipe, pdf, review, directory) {
  const source = await readFile(ipe, "utf8");
  requireCheck(source.startsWith("<?xml") && source.includes('version="70218"'), "EDITABLE_IPE");
  requireCheck(hasArtifactSignature("pdf", await readFile(pdf)), "PDF_SIGNATURE");
  const document = ipeDocumentCodec.parse(source);
  const ordered = document.pages.flatMap((page, i) => page.views.map((state, j) => ({
    slide: i + 1, view: j + 1,
    layers: page.layers.filter(({ id }) => state.visibleLayerIds.includes(id)).map(({ name }) => name),
    objects: page.objects.flatMap(({ layerId }, index) => state.visibleLayerIds.includes(layerId) ? [index + 1] : []),
  })));
  const { paper, views } = await nativeBounds(pdf);
  const { stdout } = await run("pdftotext", ["-layout", pdf, "-"]);
  const text = stdout.replace(/\f\s*$/u, "").split("\f").map(normalized);
  requireCheck(text.length === ordered.length, "PDF_PAGE_COUNT");
  requireCheck(views.length === ordered.length, "NATIVE_VIEW_COUNT");
  const allowed = new Map(review.intentionalOverlaps.map((entry) => [
    overlapKey(entry.slide, entry.view, ...entry.objects), { ...entry, used: false },
  ]));
  const findings = [];
  const rasters = new Map();
  for (const [i, state] of ordered.entries()) {
    const { slide, view } = state;
    const stem = viewKey(slide, view);
    const page = String(i + 1);
    const png = stem + ".png";
    const location = { slide, view, evidence: null };
    let bytes, raster;
    try {
      await run("pdftoppm", ["-f", page, "-l", page, "-singlefile", "-scale-to", "1280", "-png", pdf, join(directory, stem)]);
      bytes = await readFile(join(directory, png));
      requireCheck(hasArtifactSignature("png", bytes), "PDF_RASTER");
      raster = PNG.sync.read(bytes);
    } catch {
      findings.push({ criterion: "PDF_RASTER", ...location });
      continue;
    }
    location.evidence = png;
    rasters.set(stem, bytes);
    const expectation = review.views[i];
    if (!expectation || expectation.slide !== slide || expectation.view !== view || !sameSet(state.layers, expectation.layers)) {
      findings.push({ criterion: "VIEW_ORDER", ...location });
    }
    if (expectation && (!expectation.present.every((value) => text[i].includes(normalized(value))) ||
        expectation.absent.some((value) => text[i].includes(normalized(value))))) {
      findings.push({ criterion: "PDF_REVEAL_CONTENT", ...location });
    }
    const bounds = views[i];
    if (bounds.slide !== slide || bounds.view !== view ||
        !isDeepStrictEqual(bounds.boxes.map(({ index }) => index), state.objects)) {
      findings.push({ criterion: "NATIVE_VIEW_GEOMETRY", ...location });
      continue;
    }
    const geometry = geometryFindings(bounds, paper, allowed);
    const annotated = geometry.length ? await highlight(directory, stem, bytes, raster, paper, geometry) : png;
    findings.push(...geometry.map((finding) => ({ ...finding, evidence: annotated })));
  }
  for (const { slide, view } of review.views.slice(ordered.length)) {
    findings.push({ criterion: "VIEW_MISSING", slide, view, evidence: null });
  }
  for (const { slide, view, objects, used } of allowed.values()) {
    if (!used) {
      const stem = viewKey(slide, view);
      findings.push({ criterion: "UNUSED_OVERLAP_EXCEPTION", slide, view, objects,
        evidence: rasters.has(stem) ? stem + ".png" : null });
    }
  }
  let headingAnchors;
  if (review.stableHeadings.length) {
    const { stdout: layout } = await run("pdftotext", ["-bbox-layout", pdf, "-"]);
    const pages = parsePdfLines(layout);
    requireCheck(pages.length === ordered.length, "PDF_TEXT_BOUNDS_PAGE_COUNT");
    const { findings: headingFindings, ...summary } = compareHeadingAnchors(ordered, pages, review.stableHeadings, rasters);
    headingAnchors = summary;
    findings.push(...headingFindings);
  }
  return { findings, rasters, views: ordered.length, headingAnchors,
    intentionalOverlaps: [...allowed.values()].filter(({ used }) => used).length };
}
