/**
 * Central M9 release-limit contract.
 *
 * Every module imports the value it enforces from here; nothing duplicates a
 * limit number in another module.  The complete table of values is documented
 * in docs/core-m9-limits.md and exposed to clients through the ipe_orientation
 * `limits` field and `ipe_get_capabilities`.
 *
 * Only type-only imports are allowed in this module so that it never
 * participates in a runtime import cycle.
 */
import type { DocumentIR } from "./domain/ir.js";
import type { XmlParseLimits } from "./ipe/xml/parser.js";
import type { ExpansionLimits } from "./animation/spec.js";
import type { ProcessLimits } from "./native/process.js";
import type { NativeOperationLimits } from "./native/adapter.js";
import type { RasterLimits } from "./native/artifact-validation.js";
import type { BitmapLimits } from "./objects/assets.js";

/** Lossless Ipe XML parse surface. */
export const XML_PARSE_DEFAULT_LIMITS: Required<XmlParseLimits> = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 128,
  maxNodes: 500_000,
  maxAttributes: 10_000,
});

/** IR sanity ceilings before documents leave the domain layer. */
export const SCHEMA_CAPS = Object.freeze({
  text: 1_000_000,
  id: 256,
  elementName: 4096,
  attributeName: 4096,
  attributeList: 10_000,
  children: 100_000,
  omissions: 10_000,
  assetData: 100_000_000,
  metadataKey: 256,
  checksum: 512,
  visibleLayerIds: 10_000,
  attributeMaps: 10_000,
  transforms: 10_000,
  layersPerPage: 10_000,
  viewsPerPage: 10_000,
  objectsPerPage: 100_000_000,
  zOrder: 100_000_000,
  pages: 10_000,
  stylesheets: 10_000,
  assets: 100_000,
  preamble: 10_000_000,
  references: 100_000,
} as const);

/** Document shape enforced at mutation time, before serialize or native work. */
export const DOCUMENT_SHAPE_LIMITS = Object.freeze({
  maxPages: 512,
  maxLayersPerPage: 256,
  maxViewsPerPage: 512,
  maxObjectsPerDocument: 100_000,
  maxAssetsPerDocument: 10_000,
} as const);

/** Document dimension identifiers used by LimitsExceededError and orientation. */
export type LimitDimension = "pages" | "layers" | "views" | "objects" | "assets";

export class LimitsExceededError extends Error {
  readonly code = "LIMIT_EXCEEDED";

  constructor(
    readonly dimension: LimitDimension,
    readonly actual: number,
    readonly limit: number,
  ) {
    super(`document exceeded the ${dimension} limit: ${actual} > ${limit}`);
    this.name = "LimitsExceededError";
  }
}

/** Early, cheap document-shape guard: counts only, no allocation. */
export function checkDocumentShapeLimits(document: DocumentIR): void {
  const maxPages = DOCUMENT_SHAPE_LIMITS.maxPages;
  if (document.pages.length > maxPages) throw new LimitsExceededError("pages", document.pages.length, maxPages);
  let objects = 0;
  for (const page of document.pages) {
    const maxLayers = DOCUMENT_SHAPE_LIMITS.maxLayersPerPage;
    if (page.layers.length > maxLayers) throw new LimitsExceededError("layers", page.layers.length, maxLayers);
    const maxViews = DOCUMENT_SHAPE_LIMITS.maxViewsPerPage;
    if (page.views.length > maxViews) throw new LimitsExceededError("views", page.views.length, maxViews);
    objects += page.objects.length;
    const maxObjects = DOCUMENT_SHAPE_LIMITS.maxObjectsPerDocument;
    if (objects > maxObjects) throw new LimitsExceededError("objects", objects, maxObjects);
  }
  const assets = document.assets?.length ?? 0;
  const maxAssets = DOCUMENT_SHAPE_LIMITS.maxAssetsPerDocument;
  if (assets > maxAssets) throw new LimitsExceededError("assets", assets, maxAssets);
}

/** Controlled native-job defaults (bwrap + prlimit inherited). */
export const NATIVE_PROCESS_LIMITS: ProcessLimits = Object.freeze({
  timeoutMs: 30_000,
  maxOutputBytes: 256 * 1024,
  maxMemoryBytes: 2 * 1024 * 1024 * 1024,
  maxProcesses: 256,
  maxFileBytes: 64 * 1024 * 1024,
});
/** Minimum memory ceiling validated on adapter construction. */
export const NATIVE_MIN_MEMORY_BYTES = 64 * 1024 * 1024;
/** Per-native-operation document/depth/source budgets. */
export const NATIVE_OPERATION_LIMITS: NativeOperationLimits = Object.freeze({
  maxPageViewStates: 512,
  maxCumulativeArtifactBytes: 128 * 1024 * 1024,
  maxSubprocesses: 1024,
  deadlineMs: 120_000,
  maxDocumentObjects: 100_000,
  maxDocumentXmlNodes: 200_000,
  maxDocumentNestingDepth: 256,
  maxDocumentSourceBytes: 16 * 1024 * 1024,
});
/** Rendered raster validation limits. */
export const NATIVE_RASTER_LIMITS: RasterLimits = Object.freeze({
  maxWidth: 16_384,
  maxHeight: 16_384,
  maxPixels: 64 * 1024 * 1024,
  maxDecodedBytes: 256 * 1024 * 1024,
});
/** SVG validator parser surface (source bytes, nodes, depth). */
export const NATIVE_SVG_PARSE_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxNodes: 100_000,
  maxDepth: 256,
});
/** Large retained artifact ceiling per adapter instance. */
export const NATIVE_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
/** Per-m6-artifact-worker JSON envelope. */
export const NATIVE_WORKER_ARTIFACT_BYTES = 4 * 1024 * 1024;

/** Bitmap asset decode policy (object insertion and native project path). */
export const BITMAP_DEFAULT_LIMITS: Required<BitmapLimits> = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxPixels: 100_000_000,
  maxDecoderMemoryMB: 512,
});

/** M7 animation expansion budget. */
export const ANIMATION_DEFAULT_LIMITS: ExpansionLimits = Object.freeze({
  maxGeneratedViews: 64,
  maxGeneratedCopies: 512,
  maxPdfPages: 1000,
});

/** Sources, sidecars, manifests, and lock behaviour. */
export const PERSISTENCE_LIMITS = Object.freeze({
  maxSourceBytes: 16 * 1024 * 1024,
  maxSidecarBytes: 4 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
  lockWaitMs: 10,
  lockTimeoutMs: 10_000,
} as const);

/** Retained in-memory/preview resource store. */
export const RESOURCE_STORE_LIMITS = Object.freeze({
  maxItemBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
} as const);

/** M3 layout sidecar caps. */
export const LAYOUT_CAPS = Object.freeze({
  constraints: 10_000,
  connectors: 10_000,
} as const);

/** Package allowlist for the minimal LaTeX fragment profile. */
export const LATEX_SAFE_PACKAGES = Object.freeze(["amsmath", "amssymb", "mathtools", "xcolor"] as const);

/** Model-facing MCP contract limits (schema and orientation). */
export const MCP_LIMITS = Object.freeze({
  operationsPerBatch: 64,
  inspectObjectsDefault: 100,
  maxInspectObjects: 500,
  sourceResourceBytes: 128 * 1024,
  maxHints: 3,
  idListMax: 128,
  reorderPagesMax: 512,
  reorderViewsMax: 256,
  stepsMax: 32,
  revealGroupsMax: 32,
  motionObjectIdsMax: 32,
  cameraObjectIdsMax: 128,
  transitionViewIdsMax: 128,
  styleDefinitionsMax: 128,
  layoutItemsMax: 128,
  gridColumnsMax: 64,
  composeLayersMax: 32,
  pathPointsMax: 1000,
  pathChars: 4096,
  nameChars: 120,
  titleChars: 500,
  notesChars: 4000,
  latexTextChars: 8000,
  imageBase64Chars: 12_000_000,
  imageDecodedBytes: 9_000_000,
  diagnosticChars: 300,
} as const);

/** Public model-facing text ceilings. */
export const MODEL_TEXT_CAPS = Object.freeze({
  eventKind: 80,
  hintCode: 80,
  hintMessage: 500,
  summary: 1000,
  errorCode: 80,
  errorMessage: 500,
  correction: 500,
  name: 120,
  title: 500,
  notes: 4000,
  styleText: 80,
  dashPattern: 160,
  url: 2048,
} as const);
