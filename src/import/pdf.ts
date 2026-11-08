import { access, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { ipeDocumentCodec, type IpeDocument } from "../core/ipe-document-codec.js";
import { IPE_FORMAT_VERSION, IR_SCHEMA_VERSION, type DocumentIR, type Matrix } from "../domain/ir.js";
import { assertDomainNumber } from "../domain/numeric.js";
import { applyMatrix, multiplyMatrices } from "../layout/matrix.js";
import { checkDocumentShapeLimits, NATIVE_PROCESS_LIMITS } from "../limits.js";
import { NATIVE_VALIDATORS } from "../native/capabilities.js";
import { NativeIpeError } from "../native/errors.js";
import { runControlledProcess } from "../native/process.js";
import { addBitmapAsset } from "../objects/assets.js";
import { glyphOutlines } from "./pdf-glyphs.js";
import { PACKAGE_ROOT } from "../version.js";
import { rejectImport, VectorImportError } from "./errors.js";

export const PDF_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const WORKER = join(PACKAGE_ROOT, "scripts", "conformance", "m10-pdf-import.js");
const PDF_LIMITS = {
  ...NATIVE_PROCESS_LIMITS, timeoutMs: 8_000, maxOutputBytes: 1024 * 1024,
  maxMemoryBytes: 384 * 1024 * 1024, maxProcesses: 8, maxFileBytes: 1024 * 1024,
};

const finite = z.number().min(-1_000_000).max(1_000_000);
const channel = z.number().min(0).max(1);
const color = z.union([z.tuple([channel]), z.tuple([channel, channel, channel])]);
const affine = z.tuple([finite, finite, finite, finite, finite, finite]);
const geometry = {
  path: z.array(z.union([
    z.tuple([z.literal("m"), finite, finite]),
    z.tuple([z.literal("l"), finite, finite]),
    z.tuple([z.literal("c"), finite, finite, finite, finite, finite, finite]),
    z.tuple([z.literal("h")]),
  ])).min(1).max(12_000),
  matrix: affine,
};
const traceEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fill"), ...geometry, evenOdd: z.boolean(), color }).strict(),
  z.object({ kind: z.literal("stroke"), ...geometry, width: z.number().positive().max(1_000_000), cap: z.number().int().min(0).max(2),
    join: z.number().int().min(0).max(2), color }).strict(),
  z.object({ kind: z.literal("clip"), ...geometry, evenOdd: z.boolean() }).strict(),
  z.object({ kind: z.literal("pop") }).strict(),
  z.object({ kind: z.literal("text"), svg: z.string().max(256 * 1024), color }).strict(),
  z.object({ kind: z.literal("image"), matrix: affine, png: z.string().max(512 * 1024),
    width: z.number().int().positive().max(100_000), height: z.number().int().positive().max(100_000) }).strict(),
]);
const protocol = z.literal("ipe-mcp-pdf-import/1");
const receipt = z.union([
  z.object({ protocol, result: z.object({
    pages: z.array(z.object({ bounds: z.tuple([finite, finite, finite, finite]), events: z.array(traceEvent).max(2000) }).strict()).min(1).max(24),
    metadataInSource: z.boolean(), outlinedText: z.boolean(), importedImages: z.boolean(),
  }).strict() }).strict(),
  z.object({ protocol, error: z.object({
    code: z.string().max(64).regex(/^PDF_[A-Z_]+$/u),
    location: z.string().max(64).regex(/^pdf(?:\.page\[\d+\](?:\.operator\[\d+\])?)?$/u),
  }).strict() }).strict(),
]);

type TraceEvent = z.infer<typeof traceEvent>;

function ipeNumber(value: number): string {
  assertDomainNumber(value, "PDF coordinate");
  return String(Number(Number(value.toFixed(8)).toPrecision(6)));
}

function pathPayload(event: Extract<TraceEvent, { kind: "fill" | "stroke" | "clip" }>, matrix: Matrix): string {
  return event.path.map(([command, ...coordinates]) => {
    const points: string[] = [];
    for (let i = 0; i < coordinates.length; i += 2) {
      const { x, y } = applyMatrix(matrix, { x: coordinates[i]!, y: coordinates[i + 1]! });
      points.push(ipeNumber(x), ipeNumber(y));
    }
    return [...points, command].join(" ");
  }).join(" ");
}

function strokeScale(matrix: Matrix, location: string): number {
  const [a, b, c, d] = matrix;
  const scale = Math.hypot(a, b), other = Math.hypot(c, d);
  if (Math.abs(scale - other) > 1e-6 * Math.max(scale, other) || Math.abs(a * c + b * d) > 1e-6 * scale * other) {
    return rejectImport("PDF_AFFINE_STROKE_UNSUPPORTED", location);
  }
  return scale;
}

function pageXml(events: TraceEvent[], origin: Matrix, assets: DocumentIR, location: string): string {
  const root: string[] = [];
  const stack: { clip: string; objects: string[] }[] = [];
  const layer = () => stack.length === 0 ? ' layer="import"' : "";
  const append = (value: string) => (stack.at(-1)?.objects ?? root).push(value);
  const ink = (components: z.infer<typeof color>) => components.map((component) => String(Math.floor(component * 1000 + 0.0001) / 1000)).join(" ");
  const matrixText = (matrix: Matrix) => matrix.map(ipeNumber).join(" ");
  for (const event of events) {
    if (event.kind === "pop") {
      const group = stack.pop();
      if (!group || group.objects.length === 0) return rejectImport("PDF_EMPTY_OR_INVALID_CLIP", location);
      append("<group" + layer() + ' clip="' + group.clip + '">' + group.objects.join("\n") + "</group>");
      continue;
    }
    if (event.kind === "text") {
      for (const glyph of glyphOutlines(event.svg, origin, location)) {
        const path = glyph.path.split(/\s+/u).map((token) => /^[a-z]$/u.test(token) ? token : ipeNumber(Number(token))).join(" ");
        append('<path' + layer() + ' matrix="' + matrixText(glyph.matrix) + '" fill="' + ink(event.color) + '" fillrule="wind">' + path + "</path>");
      }
      continue;
    }
    const matrix = multiplyMatrices(origin, event.matrix);
    if (event.kind === "image") {
      const bytes = Buffer.from(event.png, "base64");
      if (bytes.toString("base64") !== event.png) return rejectImport("PDF_IMAGE_UNSUPPORTED", location);
      const { asset, info } = addBitmapAsset(assets, bytes, "image/png", { maxPixels: 100_000 });
      if (info.hasAlpha || info.width !== event.width || info.height !== event.height) return rejectImport("PDF_IMAGE_UNSUPPORTED", location);
      const placement = multiplyMatrices(matrix, [1, 0, 0, -1, 0, 1]);
      append('<image' + layer() + ' bitmap="' + asset.xml!.attributes!.id + '" matrix="' + matrixText(placement) + '" rect="0 0 1 1"/>');
      continue;
    }
    const path = pathPayload(event, matrix);
    if (event.kind === "clip") {
      // MuPDF can emit an implicit, even-odd CropBox rectangle. A single
      // rectangle has the same interior under either winding rule.
      if (event.evenOdd && (event.path.length !== 5 || event.path.map(([command]) => command).join("") !== "mlllh")) {
        return rejectImport("PDF_EVEN_ODD_CLIP_UNSUPPORTED", location);
      }
      stack.push({ clip: path, objects: [] });
      continue;
    }
    const paint = event.kind === "fill"
      ? 'fill="' + ink(event.color) + '" fillrule="' + (event.evenOdd ? "eofill" : "wind") + '"'
      : 'stroke="' + ink(event.color) + '" pen="' + ipeNumber(event.width * strokeScale(matrix, location)) + '" cap="' + event.cap + '" join="' + event.join + '"';
    append("<path" + layer() + " " + paint + ">" + path + "</path>");
  }
  if (stack.length !== 0 || root.length === 0) return rejectImport("PDF_EMPTY_OR_INVALID_PAGE", location);
  return '<page><layer name="import"/><view layers="import" active="import"/>' + root.join("\n") + "</page>";
}

export async function importPdf(input: Uint8Array): Promise<{ document: IpeDocument; diagnostics: string[] }> {
  if (input.length === 0 || input.length > PDF_IMPORT_MAX_BYTES) rejectImport("PDF_BYTE_LIMIT", "pdf");
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/u.test(Buffer.from(input.subarray(0, 16)).toString("latin1"))
    || !/%%EOF[\t\n\f\r ]*$/u.test(Buffer.from(input.subarray(-1024)).toString("latin1"))) {
    rejectImport("PDF_INVALID_ENVELOPE", "pdf");
  }
  if (process.platform !== "linux") throw new NativeIpeError("NATIVE_UNAVAILABLE", "PDF import requires the isolated Linux native runtime");
  try { await access(NATIVE_VALIDATORS.mutool); }
  catch { throw new NativeIpeError("NATIVE_UNAVAILABLE", "PDF import requires the fixed MuPDF executable"); }

  const workspace = await mkdtemp(join(tmpdir(), "ipe-mcp-pdf-import-"));
  try {
    await copyFile(WORKER, join(workspace, "worker.js"));
    await writeFile(join(workspace, "source.pdf"), input, { mode: 0o600, flag: "wx" });
    const output = await runControlledProcess(NATIVE_VALIDATORS.mutool, ["run", "worker.js"], workspace,
      PDF_LIMITS, "NATIVE_LOAD_ERROR", {}, "pdf-import").catch((error: unknown) => {
      if (error instanceof NativeIpeError && error.code === "NATIVE_CANCELLED") throw error;
      if (error instanceof NativeIpeError && (error.code === "NATIVE_OUTPUT_LIMIT" || error.code === "NATIVE_TIMEOUT")) {
        return rejectImport("PDF_ENGINE_LIMIT", "pdf");
      }
      return rejectImport("PDF_ENGINE_REJECTED", "pdf");
    });
    let parsed: unknown;
    try { parsed = JSON.parse(output.stdout); }
    catch { return rejectImport("PDF_ENGINE_PROTOCOL", "pdf"); }
    const response = receipt.safeParse(parsed);
    if (!response.success) return rejectImport("PDF_ENGINE_PROTOCOL", "pdf");
    if ("error" in response.data) return rejectImport(response.data.error.code, response.data.error.location);
    if (output.stderr.trim() !== "") return rejectImport("PDF_ENGINE_WARNING", "pdf");
    const { pages, metadataInSource, outlinedText, importedImages } = response.data.result;
    const assets: DocumentIR = { format: IPE_FORMAT_VERSION, schemaVersion: IR_SCHEMA_VERSION, pages: [] };
    let paper: string | undefined;
    const xml = pages.map(({ bounds: [x0, y0, x1, y1], events }, index) => {
      const location = "pdf.page[" + index + "]";
      const width = x1 - x0, height = y1 - y0;
      if (width < 1 || height < 1 || width > 12_000 || height > 12_000) rejectImport("PDF_VIEWPORT_LIMIT", location);
      const size = ipeNumber(width) + " " + ipeNumber(height);
      if (paper !== undefined && paper !== size) rejectImport("PDF_MIXED_PAGE_SIZES_UNSUPPORTED", location);
      paper = size;
      try { return pageXml(events, [1, 0, 0, -1, -x0, y1], assets, location); }
      catch (error) {
        if (error instanceof VectorImportError) throw error;
        return rejectImport("PDF_INVALID_GEOMETRY", location);
      }
    });
    const bitmaps = (assets.assets ?? []).map((asset) => {
      const attributes = Object.entries(asset.xml!.attributes!).map(([key, value]) => " " + key + '="' + value + '"').join("");
      return "<bitmap" + attributes + ">" + asset.data + "</bitmap>";
    });
    const document = ipeDocumentCodec.parse('<ipe version="70218"><ipestyle name="pdf-import"><layout paper="' + paper
      + '" origin="0 0" frame="' + paper + '"/></ipestyle>' + bitmaps.join("\n") + xml.join("\n") + "</ipe>");
    checkDocumentShapeLimits(document);
    if (ipeDocumentCodec.validate(document).some(({ severity }) => severity === "error")) rejectImport("PDF_IPE_VALIDATION_FAILED", "pdf");
    const diagnostics = [
      ...(metadataInSource ? ["PDF_METADATA_RETAINED_IN_SOURCE"] : []),
      ...(outlinedText ? ["PDF_TEXT_OUTLINED"] : []),
      ...(importedImages ? ["PDF_IMAGE_INTERPOLATION_RENDERER_DEPENDENT"] : []),
    ];
    return { document, diagnostics };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
