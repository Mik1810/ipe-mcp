import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ipeDocumentCodec, type IpeDocument } from "../core/ipe-document-codec.js";
import type { DocumentIR } from "../domain/ir.js";
import { validateDocument } from "../domain/validate.js";
import { mapPdfPages } from "../composition/index.js";
import {
  DEFAULT_NATIVE_EXECUTABLES,
  detectNativeCapabilities,
  type NativeCapabilities,
  type NativeExecutables,
} from "./capabilities.js";
import { NativeIpeError, type NativeErrorCode } from "./errors.js";
import { runControlledProcess, type ProcessLimits, type ProcessResult } from "./process.js";
import { NATIVE_SUBPROCESS_COUNTS } from "./process-accounting.js";
import { openStableArtifact, type StableArtifact } from "./stable-artifact.js";
import { DEFAULT_RASTER_LIMITS, type RasterLimits } from "./artifact-validation.js";

const DEFAULT_LIMITS: ProcessLimits = { timeoutMs: 30_000, maxOutputBytes: 256 * 1024, maxMemoryBytes: 2 * 1024 * 1024 * 1024, maxProcesses: 256, maxFileBytes: 64 * 1024 * 1024 };
const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_OPERATION_LIMITS: NativeOperationLimits = {
  maxPageViewStates: 512,
  maxCumulativeArtifactBytes: 128 * 1024 * 1024,
  maxSubprocesses: 1024,
  deadlineMs: 120_000,
  maxDocumentObjects: 100_000,
  maxDocumentXmlNodes: 200_000,
  maxDocumentNestingDepth: 256,
  maxDocumentSourceBytes: 16 * 1024 * 1024,
};
const SAFE_PACKAGES = new Set(["amsmath", "amssymb", "mathtools", "xcolor"]);

export interface NativeAdapterOptions {
  readonly executables?: Partial<NativeExecutables>;
  readonly helperDirectory?: string;
  readonly temporaryRoot?: string;
  readonly limits?: Partial<ProcessLimits>;
  readonly maxArtifactBytes?: number;
  readonly operationLimits?: Partial<NativeOperationLimits>;
  readonly rasterLimits?: Partial<RasterLimits>;
}

export interface NativeOperationLimits {
  readonly maxPageViewStates: number;
  readonly maxCumulativeArtifactBytes: number;
  readonly maxSubprocesses: number;
  readonly deadlineMs: number;
  readonly maxDocumentObjects: number;
  readonly maxDocumentXmlNodes: number;
  readonly maxDocumentNestingDepth: number;
  readonly maxDocumentSourceBytes: number;
}

interface OperationBudget {
  readonly deadline: number;
  subprocesses: number;
  artifactBytes: number;
}

export interface NativeDiagnostic {
  readonly level: "ipelib" | "styles" | "latex" | "pdf" | "visual";
  readonly code: string;
  readonly message: string;
}

export interface NativeDocumentArtifact {
  readonly source: string;
  readonly sha256: string;
  readonly diagnostics: readonly NativeDiagnostic[];
}

function semanticXml(value: unknown, unorderedChildren = false, ignoreLatexMetrics = false, managedObjectRoot = false): unknown {
  if (!value || typeof value !== "object") return value;
  const node = value as { type?: string; name?: string; attributes?: Record<string, string>; children?: unknown[]; text?: string };
  if (node.type === "text") return { type: "text", text: (node.text ?? "").replace(/\s+/gu, " ").trim() };
  const attributes = Object.fromEntries(Object.entries(node.attributes ?? {})
    .filter(([name, item]) => name !== "x-ipe-mcp-id" && !(managedObjectRoot && name === "custom") && name !== "layer" && !(name === "valign" && item === "bottom") && !(name === "BitsPerComponent" && item === "8") && !(name === "transition" && item === "1") && !(ignoreLatexMetrics && ["width", "height", "depth"].includes(name)))
    .sort(([a], [b]) => a.localeCompare(b)));
  const children = (node.children ?? []).map((child) => semanticXml(child, unorderedChildren, ignoreLatexMetrics, false)).filter((child) => JSON.stringify(child) !== '{"type":"text","text":""}');
  if (unorderedChildren) children.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { name: node.name, attributes, children };
}

function assertEqualRecord(before: Record<string, string | undefined> | undefined, after: Record<string, string | undefined> | undefined, label: string): void {
  const canonical = (record: Record<string, string | undefined> | undefined) => Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(canonical(before)) !== JSON.stringify(canonical(after))) throw new NativeIpeError("NATIVE_LOAD_ERROR", `native reload changed ${label}`);
}

function canonicalTransforms(view: DocumentIR["pages"][number]["views"][number], page: DocumentIR["pages"][number]): readonly (readonly [string, readonly number[]])[] {
  const effective = view.layerTransforms ?? Object.fromEntries((view.transforms ?? []).map(({ layerId, matrix }) => [layerId, matrix]));
  return Object.entries(effective).filter(([, matrix]) => JSON.stringify(matrix) !== "[1,0,0,1,0,0]")
    .map(([id, matrix]) => [page.layers.find((layer) => layer.id === id)?.name ?? `missing:${id}`, matrix] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function canonicalCollection(values: readonly unknown[] | undefined): readonly unknown[] {
  return (values ?? []).map((value) => semanticXml(value)).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalJson(item)]));
  return value;
}

function canonicalAttributeMaps(view: DocumentIR["pages"][number]["views"][number]): readonly unknown[] {
  return (view.attributeMaps ?? []).flatMap((map) => Object.entries(map.values).map(([from, to]) => ({ attribute: map.attribute, from, to })))
    .sort((left, right) => left.attribute.localeCompare(right.attribute) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
}

function retainedViewXml(view: DocumentIR["pages"][number]["views"][number]): unknown {
  const xml = view.xml as { attributes?: Record<string, string>; children?: readonly unknown[] } | undefined;
  if (xml === undefined) return undefined;
  const managed = new Set(["layers", "active", "marked", "name", "effect", "x-ipe-mcp-id"]);
  const attributes = Object.fromEntries(Object.entries(xml.attributes ?? {}).filter(([name]) => !managed.has(name)).sort(([left], [right]) => left.localeCompare(right)));
  const children = (xml.children ?? []).filter((child) => typeof child !== "object" || child === null || !["map", "transform"].includes((child as { name?: string }).name ?? ""))
    .map((child) => semanticXml(child)).filter((child) => JSON.stringify(child) !== '{"type":"text","text":""}');
  return { attributes, children };
}

export interface BinaryArtifactMetadata {
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PdfArtifact {
  readonly data: Uint8Array;
  readonly metadata: BinaryArtifactMetadata & { readonly mapping: ReturnType<typeof mapPdfPages> };
}

export interface ViewArtifact {
  readonly data: Uint8Array;
  readonly metadata: BinaryArtifactMetadata & {
    readonly format: "png" | "svg";
    readonly page: number;
    readonly view: number;
    readonly pageId: string;
    readonly viewId: string;
    readonly width?: number;
    readonly height?: number;
  };
  readonly diagnostics: readonly NativeDiagnostic[];
}

export interface NativeValidationReport {
  readonly ok: true;
  readonly capabilities: NativeCapabilities;
  readonly diagnostics: readonly NativeDiagnostic[];
  readonly reloaded: NativeDocumentArtifact;
  readonly latex: NativeDocumentArtifact;
  readonly pdf: PdfArtifact;
  readonly previews: readonly ViewArtifact[];
}

function digest(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function assertMinimalPreamble(preamble: string | undefined): void {
  if (preamble === undefined || preamble.trim() === "") return;
  const remainder = preamble.replace(/%[^\n]*(?:\n|$)/gu, "").replace(/\\usepackage(?:\[[A-Za-z0-9,= ._-]*\])?\{([^{}]+)\}/gu, (_all, list: string) => {
    for (const name of list.split(",").map((value) => value.trim())) {
      if (!SAFE_PACKAGES.has(name)) throw new NativeIpeError("NATIVE_TEX_ERROR", `LaTeX package is not allowed: ${name}`);
    }
    return "";
  });
  if (remainder.trim() !== "") throw new NativeIpeError("NATIVE_TEX_ERROR", "only allowlisted \\usepackage declarations are permitted in the M6 preamble");
}

function assertMappingPreserved(before: DocumentIR, after: DocumentIR): readonly NativeDiagnostic[] {
  const diagnostics: NativeDiagnostic[] = [];
  if (after.format !== 70218) throw new NativeIpeError("NATIVE_LOAD_ERROR", `native save emitted XML ${after.format}, expected 70218`);
  assertEqualRecord(before.metadata, after.metadata, "metadata");
  if ((before.preamble ?? "") !== (after.preamble ?? "")) throw new NativeIpeError("NATIVE_LOAD_ERROR", "native reload changed the preamble");
  const beforeAssets = canonicalCollection((before.assets ?? []).map((asset) => asset.xml));
  const afterAssets = canonicalCollection((after.assets ?? []).map((asset) => asset.xml));
  if (JSON.stringify(beforeAssets) !== JSON.stringify(afterAssets)) throw new NativeIpeError("NATIVE_LOAD_ERROR", "native reload changed bitmap asset semantics");
  const extensionSemantics = (document: DocumentIR) => Object.entries(document.extensions ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => [name, canonicalCollection(Array.isArray(value) ? value : [value])]);
  if (JSON.stringify(extensionSemantics(before)) !== JSON.stringify(extensionSemantics(after))) throw new NativeIpeError("NATIVE_LOAD_ERROR", "native reload changed root extension semantics");
  const beforeStyles = (before.stylesheets ?? before.styles ?? []).map((style) => ({ name: style.name, xml: semanticXml(style.xml, true) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const afterStyles = (after.stylesheets ?? after.styles ?? []).map((style) => ({ name: style.name, xml: semanticXml(style.xml, true) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (JSON.stringify(beforeStyles) !== JSON.stringify(afterStyles)) throw new NativeIpeError("NATIVE_LOAD_ERROR", "native reload changed stylesheet semantics");
  if (before.pages.length !== after.pages.length) throw new NativeIpeError("NATIVE_LOAD_ERROR", "native reload changed the page count");
  before.pages.forEach((page, pageIndex) => {
    const native = after.pages[pageIndex]!;
    for (const key of ["title", "section", "subsection", "notes"] as const) {
      if (page[key] !== native[key]) throw new NativeIpeError("NATIVE_LOAD_ERROR", `native reload changed page ${pageIndex + 1} ${key}`);
    }
    if (page.name !== undefined || page.marked !== undefined) diagnostics.push({ level: "ipelib", code: "NATIVE_PAGE_SIDECAR_REQUIRED", message: `Native Ipe XML does not retain managed page name/marked identity on page ${pageIndex + 1}; the verified positional mapping requires the composition sidecar` });
    const layerSemantics = (documentPage: typeof page) => documentPage.layers.map(({ name, edit, locked, snap }) => ({ name, edit: edit ?? (locked === undefined ? true : !locked), snap: snap ?? "visible" }));
    if (JSON.stringify(layerSemantics(page)) !== JSON.stringify(layerSemantics(native))) {
      throw new NativeIpeError("NATIVE_LOAD_ERROR", `native reload changed layer order on page ${pageIndex + 1}`);
    }
    const viewSemantics = (documentPage: typeof page) => documentPage.views.map((view) => ({
      name: view.name, marked: view.marked,
      visible: view.visibleLayerIds.map((id) => documentPage.layers.find((layer) => layer.id === id)?.name ?? `missing:${id}`),
      active: documentPage.layers.find((layer) => layer.id === view.activeLayerId)?.name ?? `missing:${view.activeLayerId}`,
      attributeMaps: canonicalAttributeMaps(view),
      transforms: canonicalTransforms(view, documentPage),
      transition: canonicalJson(view.transition),
      retainedXml: retainedViewXml(view),
    }));
    if (JSON.stringify(viewSemantics(page)) !== JSON.stringify(viewSemantics(native))) {
      throw new NativeIpeError("NATIVE_LOAD_ERROR", `native reload changed view/layer mapping on page ${pageIndex + 1}`);
    }
    const objectSemantics = (documentPage: typeof page) => documentPage.objects.map((object) => ({
      id: object.id, custom: object.custom, zOrder: object.zOrder,
      layer: documentPage.layers.find((layer) => layer.id === object.layerId)?.name,
      matrix: object.matrix, pin: object.pin, transformationMode: object.transformationMode,
      references: (object.references ?? []).map(({ kind, id, path }) => ({ kind, id, path })),
      styleId: object.styleId, symbolId: object.symbolId, assetId: object.assetId,
      xml: semanticXml(object.xml, false, true, true),
    }));
    if (JSON.stringify(objectSemantics(page)) !== JSON.stringify(objectSemantics(native))) {
      throw new NativeIpeError("NATIVE_LOAD_ERROR", `native reload changed object semantics or supported object identity on page ${pageIndex + 1}`);
    }
    page.objects.forEach((object, objectIndex) => {
      const beforeAttributes = (object.xml as { attributes?: Record<string, string> } | undefined)?.attributes ?? {};
      const afterAttributes = (native.objects[objectIndex]?.xml as { attributes?: Record<string, string> } | undefined)?.attributes ?? {};
      for (const metric of ["width", "height", "depth"] as const) {
        if (beforeAttributes[metric] !== undefined && afterAttributes[metric] !== beforeAttributes[metric]) {
          throw new NativeIpeError("NATIVE_LOAD_ERROR", `native reload changed object ${objectIndex + 1} declared ${metric} on page ${pageIndex + 1}`);
        }
      }
    });
  });
  return [...diagnostics, { level: "ipelib", code: "NATIVE_IDENTITY_MAPPED", message: "Native Ipe drops page/layer/view/style extension IDs; ordered page/style/object and layer-name/view mappings were verified, while object IDs were preserved through the supported custom carrier" }];
}

export class NativeIpeAdapter {
  readonly #executables: NativeExecutables;
  readonly #helperDirectory: string;
  readonly #temporaryRoot: string;
  readonly #limits: ProcessLimits;
  readonly #maxArtifactBytes: number;
  readonly #operationLimits: NativeOperationLimits;
  readonly #rasterLimits: RasterLimits;

  private constructor(executables: NativeExecutables, helperDirectory: string, temporaryRoot: string, limits: ProcessLimits, maxArtifactBytes: number, operationLimits: NativeOperationLimits, rasterLimits: RasterLimits) {
    this.#executables = executables;
    this.#helperDirectory = helperDirectory;
    this.#temporaryRoot = temporaryRoot;
    this.#limits = limits;
    this.#maxArtifactBytes = maxArtifactBytes;
    this.#operationLimits = operationLimits;
    this.#rasterLimits = rasterLimits;
  }

  static async create(options: NativeAdapterOptions = {}): Promise<NativeIpeAdapter> {
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1 || !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1
      || !Number.isSafeInteger(limits.maxMemoryBytes) || limits.maxMemoryBytes < 64 * 1024 * 1024 || !Number.isSafeInteger(limits.maxProcesses) || limits.maxProcesses < 1
      || !Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 1) {
      throw new Error("native process limits must be positive safe integers");
    }
    const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) throw new Error("maxArtifactBytes must be a positive safe integer");
    const operationLimits = { ...DEFAULT_OPERATION_LIMITS, ...options.operationLimits };
    if (Object.values(operationLimits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error("native operation limits must be positive safe integers");
    const rasterLimits = { ...DEFAULT_RASTER_LIMITS, ...options.rasterLimits };
    if (Object.values(rasterLimits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error("native raster limits must be positive safe integers");
    const temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    return new NativeIpeAdapter(
      { ...DEFAULT_NATIVE_EXECUTABLES, ...options.executables },
      resolve(options.helperDirectory ?? join(process.cwd(), "scripts", "conformance")),
      await realpath(temporaryRoot),
      { ...limits, maxFileBytes: Math.min(limits.maxFileBytes, maxArtifactBytes) },
      maxArtifactBytes,
      operationLimits,
      rasterLimits,
    );
  }

  async capabilities(): Promise<NativeCapabilities> {
    this.#preflightProcesses(NATIVE_SUBPROCESS_COUNTS.capabilities);
    const budget = this.#budget();
    return await this.#workspace((workspace) => detectNativeCapabilities(this.#executables, this.#helperDirectory, workspace, this.#limits, () => this.#processLimits(budget), () => this.#remaining(budget)));
  }

  async reload(document: IpeDocument): Promise<NativeDocumentArtifact> {
    assertMinimalPreamble(document.preamble);
    this.#preflightProcesses(NATIVE_SUBPROCESS_COUNTS.reload);
    return await this.#reload(document, this.#budget());
  }

  async #reload(document: IpeDocument, budget: OperationBudget): Promise<NativeDocumentArtifact> {
    return await this.#withDocument(document, budget, async (workspace, input) => {
      const output = join(workspace, "reloaded.ipe");
      await this.#helper("reload", [input, output], workspace, "NATIVE_LOAD_ERROR", budget);
      const artifact = await this.#stableArtifact(output, workspace, "NATIVE_LOAD_ERROR", budget);
      try {
      await this.#artifact("xml", [artifact], workspace, "NATIVE_LOAD_ERROR", budget);
      const source = (await this.#readArtifact(artifact, "NATIVE_LOAD_ERROR", budget)).toString("utf8");
      const parsed = this.#parseNative(source, "NATIVE_LOAD_ERROR");
      if (parsed.format !== 70218) throw new NativeIpeError("NATIVE_LOAD_ERROR", `native reload emitted XML ${parsed.format}, expected 70218`);
      const identity = assertMappingPreserved(document, parsed);
      return { source, sha256: digest(source), diagnostics: [{ level: "ipelib", code: "NATIVE_RELOAD_OK", message: "Ipe loaded, saved, and reloaded XML 70218 without semantic changes" }, ...identity] };
      } finally { await artifact.close(); }
    });
  }

  async checkStyle(document: IpeDocument): Promise<readonly NativeDiagnostic[]> {
    assertMinimalPreamble(document.preamble);
    this.#preflightProcesses(NATIVE_SUBPROCESS_COUNTS.checkStyle);
    return await this.#checkStyle(document, this.#budget());
  }

  async #checkStyle(document: IpeDocument, budget: OperationBudget): Promise<readonly NativeDiagnostic[]> {
    return await this.#withDocument(document, budget, async (workspace, input) => {
      await this.#helper("check-style", [input], workspace, "NATIVE_STYLE_ERROR", budget);
      return [{ level: "styles", code: "NATIVE_STYLE_OK", message: "Document:checkStyle() reported no undefined styles" }];
    });
  }

  async runLatex(document: IpeDocument): Promise<NativeDocumentArtifact> {
    this.#preflightProcesses(NATIVE_SUBPROCESS_COUNTS.runLatex);
    return await this.#runLatex(document, this.#budget());
  }

  async #runLatex(document: IpeDocument, budget: OperationBudget): Promise<NativeDocumentArtifact> {
    assertMinimalPreamble(document.preamble);
    return await this.#withDocument(document, budget, async (workspace, input) => {
      const output = join(workspace, "latex.ipe");
      await this.#helper("run-latex", [input, output], workspace, "NATIVE_TEX_ERROR", budget);
      const artifact = await this.#stableArtifact(output, workspace, "NATIVE_TEX_ERROR", budget);
      try {
      await this.#artifact("xml", [artifact], workspace, "NATIVE_TEX_ERROR", budget);
      const source = (await this.#readArtifact(artifact, "NATIVE_TEX_ERROR", budget)).toString("utf8");
      const parsed = this.#parseNative(source, "NATIVE_TEX_ERROR");
      const identity = assertMappingPreserved(document, parsed);
      return { source, sha256: digest(source), diagnostics: [{ level: "latex", code: "NATIVE_LATEX_OK", message: "Document:runLatex() completed in a confined workspace and saved XML 70218" }, ...identity] };
      } finally { await artifact.close(); }
    });
  }

  async exportPdf(document: IpeDocument): Promise<PdfArtifact> {
    assertMinimalPreamble(document.preamble);
    const states = document.pages.reduce((total, page) => total + page.views.length, 0);
    this.#preflight(document, NATIVE_SUBPROCESS_COUNTS.exportPdf(states));
    return await this.#exportPdf(document, this.#budget());
  }

  async #exportPdf(document: IpeDocument, budget: OperationBudget): Promise<PdfArtifact> {
    return await this.#withDocument(document, budget, async (workspace, input) => {
      const output = join(workspace, "document.pdf");
      await this.#run(this.#executables.ipetoipe, ["-pdf", "-nozip", input, output], workspace, "NATIVE_EXPORT_ERROR", budget);
      const pdf = await this.#stableArtifact(output, workspace, "NATIVE_EXPORT_ERROR", budget);
      try {
      await this.#artifact("pdf", [pdf], workspace, "NATIVE_EXPORT_ERROR", budget);
      const data = await this.#readArtifact(pdf, "NATIVE_EXPORT_ERROR", budget);
      const mapping = mapPdfPages(document);
      const states = document.pages.flatMap((page, pageIndex) => page.views.map((_view, viewIndex) => ({ page: pageIndex + 1, view: viewIndex + 1 })));
      const info = await this.#run("/usr/bin/pdfinfo", [pdf.path], workspace, "NATIVE_EXPORT_ERROR", budget);
      const physicalPages = Number(/^Pages:\s+(\d+)$/mu.exec(info.stdout)?.[1]);
      if (!Number.isSafeInteger(physicalPages) || physicalPages !== mapping.length) {
        throw new NativeIpeError("NATIVE_EXPORT_ERROR", `PDF contains ${Number.isSafeInteger(physicalPages) ? physicalPages : "an unknown number of"} physical pages, expected ${mapping.length}`);
      }
      for (const [index] of mapping.entries()) {
        const expected = states[index]!;
        const direct = join(workspace, `pdf-expected-${index + 1}.png`);
        await this.#run(this.#executables.iperender, ["-png", "-nocrop", "-page", String(expected.page), "-view", String(expected.view), input, direct], workspace, "NATIVE_EXPORT_ERROR", budget);
        const prefix = join(workspace, `pdf-physical-${index + 1}`);
        const directSnapshot = await this.#stableArtifact(direct, workspace, "NATIVE_EXPORT_ERROR", budget);
        try {
          await this.#run("/usr/bin/pdftoppm", ["-f", String(index + 1), "-l", String(index + 1), "-singlefile", "-r", "72", "-png", pdf.path, prefix], workspace, "NATIVE_EXPORT_ERROR", budget);
          const physicalSnapshot = await this.#stableArtifact(`${prefix}.png`, workspace, "NATIVE_EXPORT_ERROR", budget);
          try { await this.#artifact("compare-png", [physicalSnapshot, directSnapshot], workspace, "NATIVE_EXPORT_ERROR", budget); }
          finally { await physicalSnapshot.close(); }
        } finally { await directSnapshot.close(); }
      }
      const roundTrip = join(workspace, "document-from-pdf.ipe");
      await this.#run(this.#executables.ipetoipe, ["-xml", pdf.path, roundTrip], workspace, "NATIVE_EXPORT_ERROR", budget);
      const recoveredSnapshot = await this.#stableArtifact(roundTrip, workspace, "NATIVE_EXPORT_ERROR", budget);
      try {
      await this.#artifact("xml", [recoveredSnapshot], workspace, "NATIVE_EXPORT_ERROR", budget);
      const recovered = this.#parseNative((await this.#readArtifact(recoveredSnapshot, "NATIVE_EXPORT_ERROR", budget)).toString("utf8"), "NATIVE_EXPORT_ERROR");
      const structural = validateDocument(recovered);
      if (!structural.ok) throw new NativeIpeError("NATIVE_EXPORT_ERROR", "PDF round-trip recovered structurally invalid Ipe XML");
      assertMappingPreserved(document, recovered);
      const recoveredStates = recovered.pages.reduce((total, page) => total + page.views.length, 0);
      if (recoveredStates !== mapping.length) throw new NativeIpeError("NATIVE_EXPORT_ERROR", `PDF round-trip contains ${recoveredStates} page/view states, expected ${mapping.length}`);
      return { data, metadata: { mediaType: "application/pdf", bytes: data.length, sha256: digest(data), mapping } };
      } finally { await recoveredSnapshot.close(); }
      } finally { await pdf.close(); }
    });
  }

  async renderViews(document: IpeDocument, format: "png" | "svg" = "png"): Promise<readonly ViewArtifact[]> {
    assertMinimalPreamble(document.preamble);
    const states = document.pages.reduce((total, page) => total + page.views.length, 0);
    this.#preflight(document, NATIVE_SUBPROCESS_COUNTS.renderViews(states));
    return await this.#renderViews(document, format, this.#budget());
  }

  async #renderViews(document: IpeDocument, format: "png" | "svg", budget: OperationBudget): Promise<readonly ViewArtifact[]> {
    const states = document.pages.reduce((total, page) => total + page.views.length, 0);
    this.#preflight(document, NATIVE_SUBPROCESS_COUNTS.renderViews(states));
    return await this.#withDocument(document, budget, async (workspace, input) => {
      const results: ViewArtifact[] = [];
      for (let pageIndex = 0; pageIndex < document.pages.length; pageIndex += 1) {
        const page = document.pages[pageIndex]!;
        for (let viewIndex = 0; viewIndex < page.views.length; viewIndex += 1) {
          const view = page.views[viewIndex]!;
          const output = join(workspace, `page-${pageIndex + 1}-view-${viewIndex + 1}.${format}`);
          await this.#run(this.#executables.iperender, [`-${format}`, "-nocrop", "-page", String(pageIndex + 1), "-view", String(viewIndex + 1), input, output], workspace, "NATIVE_RENDER_ERROR", budget);
          const stable = await this.#stableArtifact(output, workspace, "NATIVE_RENDER_ERROR", budget);
          try {
            const visual = await this.#artifact(format === "png" ? "png-header" : "svg", [stable], workspace, "NATIVE_RENDER_ERROR", budget) as { width: number; height: number };
            const data = await this.#readArtifact(stable, "NATIVE_RENDER_ERROR", budget);
            const checked = join(workspace, `page-${pageIndex + 1}-view-${viewIndex + 1}-${format}-checked.png`);
            await this.#run("/usr/bin/mutool", ["draw", "-q", "-F", "png", "-r", "72", "-w", String(this.#rasterLimits.maxWidth), "-h", String(this.#rasterLimits.maxHeight), "-m", String(this.#limits.maxMemoryBytes), "-o", checked, stable.path], workspace, "NATIVE_RENDER_ERROR", budget);
            const checkedSnapshot = await this.#stableArtifact(checked, workspace, "NATIVE_RENDER_ERROR", budget);
            try { await this.#artifact("png", [checkedSnapshot], workspace, "NATIVE_RENDER_ERROR", budget); }
            finally { await checkedSnapshot.close(); }
            results.push({
              data,
              metadata: { mediaType: format === "png" ? "image/png" : "image/svg+xml", bytes: data.length, sha256: digest(data), format, page: pageIndex + 1, view: viewIndex + 1, pageId: page.id, viewId: view.id, ...visual },
              diagnostics: [{ level: "visual", code: "VISUAL_NON_EMPTY", message: `${format.toUpperCase()} contains rendered content for page ${pageIndex + 1}, view ${viewIndex + 1}` }],
            });
          } finally { await stable.close(); }
        }
      }
      return results;
    });
  }

  async validateFull(document: IpeDocument): Promise<NativeValidationReport> {
    assertMinimalPreamble(document.preamble);
    const structural = validateDocument(document);
    if (!structural.ok) throw new NativeIpeError("NATIVE_LOAD_ERROR", "structural validation failed", structural.errors.map((item) => `${item.code}: ${item.message}`));
    const states = document.pages.reduce((total, page) => total + page.views.length, 0);
    this.#preflight(document, NATIVE_SUBPROCESS_COUNTS.validateFull(states));
    const budget = this.#budget();
    this.#preflightDocument(document, budget);
    const capabilities = await this.#workspace((workspace) => detectNativeCapabilities(this.#executables, this.#helperDirectory, workspace, this.#limits, () => this.#processLimits(budget), () => this.#remaining(budget)));
    if (capabilities.mode === "structural-only") throw new NativeIpeError("NATIVE_UNAVAILABLE", "full native validation is unavailable", capabilities.diagnostics);
    const reloaded = await this.#reload(document, budget);
    const style = await this.#checkStyle(document, budget);
    const latex = await this.#runLatex(document, budget);
    const pdf = await this.#exportPdf(document, budget);
    const previews = await this.#renderViews(document, "png", budget);
    return { ok: true, capabilities, diagnostics: [...reloaded.diagnostics, ...style, ...latex.diagnostics, { level: "pdf", code: "PDF_EXPORT_OK", message: `PDF maps ${pdf.metadata.mapping.length} page/view states` }, ...previews.flatMap((preview) => preview.diagnostics)], reloaded, latex, pdf, previews };
  }

  async #withDocument<Result>(document: IpeDocument, budget: OperationBudget, operation: (workspace: string, input: string) => Promise<Result>): Promise<Result> {
    assertMinimalPreamble(document.preamble);
    this.#preflight(document, 1);
    this.#remaining(budget);
    this.#preflightDocument(document, budget);
    const source = ipeDocumentCodec.serialize(document);
    this.#remaining(budget);
    if (Buffer.byteLength(source) > this.#operationLimits.maxDocumentSourceBytes) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `serialized document exceeded ${this.#operationLimits.maxDocumentSourceBytes} bytes`);
    return await this.#workspace(async (workspace) => {
      const input = join(workspace, "input.ipe");
      await writeFile(input, source, { mode: 0o600, flag: "wx" });
      return await operation(workspace, input);
    });
  }

  async #workspace<Result>(operation: (workspace: string) => Promise<Result>): Promise<Result> {
    const workspace = await mkdtemp(join(this.#temporaryRoot, "ipe-mcp-m6-"));
    try { return await operation(workspace); }
    finally { await rm(workspace, { recursive: true, force: true }); }
  }

  async #helper(mode: string, paths: readonly string[], workspace: string, failure: NativeErrorCode, budget: OperationBudget): Promise<void> {
    const result = await this.#run(this.#executables.ipescript, ["m6-native", mode, ...paths], workspace, failure, budget, { IPESCRIPTS: this.#helperDirectory });
    const markers = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith("IPE_M6_PROTOCOL=") || line.startsWith("IPE_M6_RESULT="));
    if (JSON.stringify(markers) !== JSON.stringify(["IPE_M6_PROTOCOL=ipe-mcp-native/1", "IPE_M6_RESULT=PASS"])) {
      throw new NativeIpeError(failure, `native helper ${mode} did not attest protocol success`);
    }
  }

  async #artifact(operation: string, stable: readonly StableArtifact[], workspace: string, failure: NativeErrorCode, budget: OperationBudget): Promise<unknown> {
    {
    const worker = join(this.#helperDirectory, "m6-artifact-worker.mjs");
    let result: ProcessResult;
    try {
      result = await this.#run(process.execPath, [worker, operation, ...stable.map((item) => item.path)], workspace, failure, budget, { IPE_M6_ARTIFACT_LIMITS: JSON.stringify({ ...this.#rasterLimits, maxArtifactBytes: this.#maxArtifactBytes }) });
    } catch (error) {
      if (error instanceof NativeIpeError && error.diagnostics.includes("IPE_M6_ERROR=resource")) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", "artifact exceeded safe resource limits", error.diagnostics, { cause: error });
      throw error;
    }
    if (!/^IPE_M6_PROTOCOL=ipe-mcp-artifact\/1$/mu.test(result.stdout) || !/^IPE_M6_RESULT=PASS$/mu.test(result.stdout)) throw new NativeIpeError(failure, "artifact worker did not attest protocol success");
    const payload = /^IPE_M6_DATA=(.+)$/mu.exec(result.stdout)?.[1];
    if (payload === undefined) throw new NativeIpeError(failure, "artifact worker returned no result");
    try { return JSON.parse(payload); } catch (error) { throw new NativeIpeError(failure, "artifact worker returned invalid data", [], { cause: error }); }
    }
  }

  async #stableArtifact(path: string, workspace: string, failure: NativeErrorCode, budget: OperationBudget): Promise<Awaited<ReturnType<typeof openStableArtifact>>> {
    try {
      const artifact = await openStableArtifact(path, workspace, this.#maxArtifactBytes, () => this.#remaining(budget));
      if (budget.artifactBytes + artifact.size > this.#operationLimits.maxCumulativeArtifactBytes) { await artifact.close(); throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `native operation artifacts exceeded ${this.#operationLimits.maxCumulativeArtifactBytes} bytes`); }
      budget.artifactBytes += artifact.size;
      return artifact;
    }
    catch (error) {
      if (error instanceof NativeIpeError) throw error;
      throw new NativeIpeError(failure, "native artifact could not be snapshotted", [], { cause: error });
    }
  }

  async #run(executable: string, args: readonly string[], workspace: string, failure: NativeErrorCode, budget: OperationBudget, environment: Readonly<Record<string, string>> = {}): Promise<ProcessResult> {
    try {
      return await runControlledProcess(executable, args, workspace, this.#processLimits(budget), failure, {
        TMPDIR: workspace,
        TEXMFOUTPUT: workspace,
        openin_any: "p",
        openout_any: "p",
        shell_escape: "0",
        PATH: `${dirname(this.#executables.pdflatex)}:/usr/bin:/bin`,
        ...environment,
      });
    }
    catch (error) {
      if (error instanceof NativeIpeError && failure === "NATIVE_TEX_ERROR" && error.diagnostics.some((line) => line.includes("IPE_M6_ERROR=latex"))) {
        throw new NativeIpeError("NATIVE_TEX_ERROR", "native LaTeX validation failed", error.diagnostics, { cause: error });
      }
      throw error;
    }
  }

  async #readArtifact(artifact: StableArtifact, failure: NativeErrorCode, budget: OperationBudget): Promise<Buffer> {
    try {
      return await artifact.read(() => this.#remaining(budget));
    } catch (error) {
      if (error instanceof NativeIpeError) throw error;
      throw new NativeIpeError(failure, "native artifact could not be read", [], { cause: error });
    }
  }

  #budget(): OperationBudget { return { deadline: Date.now() + this.#operationLimits.deadlineMs, subprocesses: 0, artifactBytes: 0 }; }

  #remaining(budget: OperationBudget): number {
    const remaining = budget.deadline - Date.now();
    if (remaining < 1) throw new NativeIpeError("NATIVE_TIMEOUT", `native operation exceeded ${this.#operationLimits.deadlineMs} ms`);
    return remaining;
  }

  #processLimits(budget: OperationBudget): ProcessLimits {
    if (budget.subprocesses >= this.#operationLimits.maxSubprocesses) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `native operation exceeded ${this.#operationLimits.maxSubprocesses} subprocesses`);
    budget.subprocesses += 1;
    return { ...this.#limits, timeoutMs: Math.min(this.#limits.timeoutMs, this.#remaining(budget)) };
  }

  #preflight(document: IpeDocument, subprocesses: number): void {
    const states = document.pages.reduce((total, page) => total + page.views.length, 0);
    if (states > this.#operationLimits.maxPageViewStates) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `document has ${states} page/view states; limit is ${this.#operationLimits.maxPageViewStates}`);
    this.#preflightProcesses(subprocesses);
  }

  #preflightDocument(document: IpeDocument, budget: OperationBudget): void {
    let objects = 0;
    for (const page of document.pages) {
      objects += page.objects.length;
      if (objects > this.#operationLimits.maxDocumentObjects) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `document has more than ${this.#operationLimits.maxDocumentObjects} objects`);
      this.#remaining(budget);
    }
    const pending: { value: unknown; depth: number; exit?: boolean }[] = [{ value: document, depth: 0 }];
    const active = new WeakSet<object>();
    let xmlNodes = 0;
    let estimatedBytes = 0;
    let visits = 0;
    let structureEntries = 0;
    while (pending.length > 0) {
      const frame = pending.pop()!;
      const value = frame.value;
      if (frame.exit) { active.delete(value as object); continue; }
      if (frame.depth > this.#operationLimits.maxDocumentNestingDepth) {
        throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `document nesting exceeds ${this.#operationLimits.maxDocumentNestingDepth} levels`);
      }
      if (typeof value === "string") estimatedBytes += Buffer.byteLength(value);
      else if (value !== null && typeof value === "object") {
        if (active.has(value)) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", "document graph contains a cycle");
        active.add(value);
        pending.push({ value, depth: frame.depth, exit: true });
        estimatedBytes += 64;
        if (!Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          if (record.type === "element" || record.type === "text") xmlNodes += 1;
          for (const key in record) {
            if (!Object.hasOwn(record, key)) continue;
            estimatedBytes += Buffer.byteLength(key); pending.push({ value: record[key], depth: frame.depth + 1 }); structureEntries += 1;
            if (structureEntries > this.#operationLimits.maxDocumentXmlNodes) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `document graph has more than ${this.#operationLimits.maxDocumentXmlNodes} entries`);
          }
        } else {
          for (let index = 0; index < value.length; index += 1) {
            pending.push({ value: value[index], depth: frame.depth + 1 }); structureEntries += 1;
            if (structureEntries > this.#operationLimits.maxDocumentXmlNodes) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `document graph has more than ${this.#operationLimits.maxDocumentXmlNodes} entries`);
          }
        }
      }
      if (xmlNodes > this.#operationLimits.maxDocumentXmlNodes) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `document has more than ${this.#operationLimits.maxDocumentXmlNodes} XML nodes`);
      if (estimatedBytes > this.#operationLimits.maxDocumentSourceBytes) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `document source estimate exceeded ${this.#operationLimits.maxDocumentSourceBytes} bytes`);
      if ((visits += 1) % 1024 === 0) this.#remaining(budget);
    }
    this.#remaining(budget);
  }

  #preflightProcesses(subprocesses: number): void {
    if (subprocesses > this.#operationLimits.maxSubprocesses) throw new NativeIpeError("NATIVE_RESOURCE_LIMIT", `operation requires ${subprocesses} subprocesses; limit is ${this.#operationLimits.maxSubprocesses}`);
  }

  #parseNative(source: string, failure: NativeErrorCode): IpeDocument {
    try { return ipeDocumentCodec.parse(source); }
    catch (error) { throw new NativeIpeError(failure, "native output is not valid Ipe XML", [], { cause: error }); }
  }

}
