import { documentSchema } from "./schema.js";
import { stylesheetList, type DocumentIR, type IpeObject, type Layer, type Page, type View } from "./ir.js";
import { isPersistentEntityId, type PersistentEntityKind } from "./identity.js";
import { isXmlElement } from "./xml-node.js";
import { nestedReferences } from "../objects/references.js";
import { assertObjectContent } from "../objects/content-model.js";

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  code: string;
  path: string;
  severity: DiagnosticSeverity;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
  value?: DocumentIR;
}

const RESERVED_LAYERS = new Set(["BBOX", "VIEWBBOX", "BACKGROUND", "GRID", "NOPDF"]);

const pathOf = (parts: (string | number)[]): string => {
  let result = "$";
  for (const part of parts) result += typeof part === "number" ? `[${part}]` : `.${part}`;
  return result;
};

const diagnostic = (diagnostics: Diagnostic[], code: string, path: (string | number)[], message: string, severity: DiagnosticSeverity = "error"): void => {
  diagnostics.push({ code, path: pathOf(path), severity, message });
};

function checkEntityId(
  diagnostics: Diagnostic[],
  globalIds: Set<string>,
  kind: PersistentEntityKind,
  id: string,
  path: (string | number)[],
): void {
  if (!isPersistentEntityId(kind, id)) diagnostic(diagnostics, "ENTITY_ID_INVALID", path, `${kind} id '${id}' is not a canonical persistent identity`);
  if (globalIds.has(id)) diagnostic(diagnostics, "ENTITY_ID_DUPLICATE", path, `persistent entity id '${id}' is duplicated`);
  globalIds.add(id);
}

function schemaDiagnostics(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): Diagnostic[] {
  return error.issues.map((issue) => ({
    code: "SCHEMA_INVALID",
    path: pathOf(issue.path.map((part) => typeof part === "symbol" ? String(part) : part)),
    severity: "error" as const,
    message: issue.message,
  }));
}

function checkReferences(document: DocumentIR, page: Page, pageIndex: number, object: IpeObject, objectIndex: number, diagnostics: Diagnostic[]): void {
  const styles = new Set(stylesheetList(document).map((style) => style.id));
  const assets = new Set((document.assets ?? []).map((asset) => asset.id));
  const symbols = new Set<string>(["arrow/normal(spx)"]);
  for (const style of stylesheetList(document)) {
    for (const child of style.xml?.children ?? []) {
      if (isXmlElement(child) && child.name === "symbol" && child.attributes?.name) symbols.add(child.attributes.name);
    }
  }
  const layers = new Set(page.layers.map((layer) => layer.id));
  const objects = new Set(page.objects.map((candidate) => candidate.id));
  const pages = new Set(document.pages.map((candidate) => candidate.id));
  const views = new Set(document.pages.flatMap((candidate) => candidate.views.map((entry) => entry.id)));
  const references = object.references ?? [];
  for (let refIndex = 0; refIndex < references.length; refIndex += 1) {
    const ref = references[refIndex];
    if (!ref) continue;
    const target = ref.kind === "style" ? styles : ref.kind === "asset" ? assets : ref.kind === "symbol" ? symbols : ref.kind === "layer" ? layers : ref.kind === "object" ? objects : ref.kind === "page" ? pages : ref.kind === "view" ? views : undefined;
    if (target && !target.has(ref.id)) diagnostic(diagnostics, "REF_UNRESOLVED", ["pages", pageIndex, "objects", objectIndex, "references", refIndex, "id"], `${ref.kind} reference '${ref.id}' does not resolve`);
  }
  for (const [field, target] of [["styleId", styles], ["assetId", assets], ["symbolId", symbols], ["layerId", layers]] as const) {
    const value = object[field];
    if (typeof value === "string" && target instanceof Set && !target.has(value)) diagnostic(diagnostics, "REF_UNRESOLVED", ["pages", pageIndex, "objects", objectIndex, field], `${field} '${value}' does not resolve`);
  }
  if (object.xml !== undefined) {
    try {
      assertObjectContent(object.xml);
      nestedReferences(document, object.xml);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostic(diagnostics, "OBJECT_XML_UNSUPPORTED", ["pages", pageIndex, "objects", objectIndex, "xml"], message);
    }
  }
}

function validatePage(document: DocumentIR, page: Page, pageIndex: number, diagnostics: Diagnostic[], globalEntityIds: Set<string>, customIds: Map<string, string>): void {
  checkEntityId(diagnostics, globalEntityIds, "page", page.id, ["pages", pageIndex, "id"]);
  if (page.layers.length === 0) diagnostic(diagnostics, "PAGE_NO_LAYER", ["pages", pageIndex, "layers"], "a page must contain at least one layer");
  if (page.views.length === 0) diagnostic(diagnostics, "PAGE_NO_VIEW", ["pages", pageIndex, "views"], "a page must contain at least one view");
  const layerIds = new Set<string>();
  const layerNames = new Set<string>();
  for (let layerIndex = 0; layerIndex < page.layers.length; layerIndex += 1) {
    const layer = page.layers[layerIndex] as Layer;
    checkEntityId(diagnostics, globalEntityIds, "layer", layer.id, ["pages", pageIndex, "layers", layerIndex, "id"]);
    if (layerIds.has(layer.id)) diagnostic(diagnostics, "LAYER_ID_DUPLICATE", ["pages", pageIndex, "layers", layerIndex, "id"], `duplicate layer id '${layer.id}'`);
    layerIds.add(layer.id);
    if (layerNames.has(layer.name)) diagnostic(diagnostics, "LAYER_NAME_DUPLICATE", ["pages", pageIndex, "layers", layerIndex, "name"], `duplicate layer name '${layer.name}'`);
    layerNames.add(layer.name);
    if (/\s/u.test(layer.name)) diagnostic(diagnostics, "LAYER_NAME_WHITESPACE", ["pages", pageIndex, "layers", layerIndex, "name"], "layer names may not contain whitespace");
    if (RESERVED_LAYERS.has(layer.name) && layer.intentional !== true) diagnostic(diagnostics, "LAYER_RESERVED_NAME", ["pages", pageIndex, "layers", layerIndex, "name"], `reserved layer '${layer.name}' requires intentional=true`);
  }
  const viewIds = new Set<string>();
  for (let viewIndex = 0; viewIndex < page.views.length; viewIndex += 1) {
    const view = page.views[viewIndex] as View;
    if (view.layerTransforms !== undefined && view.transforms !== undefined) diagnostic(diagnostics, "TRANSFORM_REPRESENTATION_CONFLICT", ["pages", pageIndex, "views", viewIndex], "a view must use either layerTransforms or transforms, not both");
    checkEntityId(diagnostics, globalEntityIds, "view", view.id, ["pages", pageIndex, "views", viewIndex, "id"]);
    if (viewIds.has(view.id)) diagnostic(diagnostics, "VIEW_ID_DUPLICATE", ["pages", pageIndex, "views", viewIndex, "id"], `duplicate view id '${view.id}'`);
    viewIds.add(view.id);
    if (!layerIds.has(view.activeLayerId)) diagnostic(diagnostics, "ACTIVE_LAYER_MISSING", ["pages", pageIndex, "views", viewIndex, "activeLayerId"], `active layer '${view.activeLayerId}' does not exist`);
    else {
      const layer = page.layers.find((candidate) => candidate.id === view.activeLayerId);
      if (layer && (layer.locked === true || layer.edit === false)) diagnostic(diagnostics, "ACTIVE_LAYER_LOCKED", ["pages", pageIndex, "views", viewIndex, "activeLayerId"], "active layer must not be locked");
    }
    const visible = new Set<string>();
    for (let layerIndex = 0; layerIndex < view.visibleLayerIds.length; layerIndex += 1) {
      const layerId = view.visibleLayerIds[layerIndex];
      if (!layerId) continue;
      if (!layerIds.has(layerId)) diagnostic(diagnostics, "VIEW_LAYER_UNRESOLVED", ["pages", pageIndex, "views", viewIndex, "visibleLayerIds", layerIndex], `visible layer '${layerId}' does not exist`);
      if (visible.has(layerId)) diagnostic(diagnostics, "VIEW_LAYER_DUPLICATE", ["pages", pageIndex, "views", viewIndex, "visibleLayerIds", layerIndex], `duplicate visible layer '${layerId}'`);
      visible.add(layerId);
    }
    if (!visible.has(view.activeLayerId)) diagnostic(diagnostics, "ACTIVE_LAYER_NOT_VISIBLE", ["pages", pageIndex, "views", viewIndex, "activeLayerId"], "active layer must be visible in the view");
    for (const [layerId, matrix] of Object.entries(view.layerTransforms ?? {})) {
      if (!layerIds.has(layerId)) diagnostic(diagnostics, "TRANSFORM_LAYER_UNRESOLVED", ["pages", pageIndex, "views", viewIndex, "layerTransforms", layerId], `transform layer '${layerId}' does not exist`);
      if (matrix.some((number) => !Number.isFinite(number))) diagnostic(diagnostics, "NON_FINITE_NUMBER", ["pages", pageIndex, "views", viewIndex, "layerTransforms", layerId], "transform contains a non-finite number");
    }
    for (let transformIndex = 0; transformIndex < (view.transforms ?? []).length; transformIndex += 1) {
      const transform = view.transforms?.[transformIndex];
      if (transform && !layerIds.has(transform.layerId)) diagnostic(diagnostics, "TRANSFORM_LAYER_UNRESOLVED", ["pages", pageIndex, "views", viewIndex, "transforms", transformIndex, "layerId"], `transform layer '${transform.layerId}' does not exist`);
    }
  }
  for (let objectIndex = 0; objectIndex < page.objects.length; objectIndex += 1) {
    const object = page.objects[objectIndex] as IpeObject;
    checkEntityId(diagnostics, globalEntityIds, "object", object.id, ["pages", pageIndex, "objects", objectIndex, "id"]);
    if (!layerIds.has(object.layerId)) diagnostic(diagnostics, "OBJECT_LAYER_UNRESOLVED", ["pages", pageIndex, "objects", objectIndex, "layerId"], `object layer '${object.layerId}' does not exist`);
    if (object.zOrder !== objectIndex) diagnostic(diagnostics, "Z_ORDER_MISMATCH", ["pages", pageIndex, "objects", objectIndex, "zOrder"], `zOrder ${object.zOrder} does not match global sequence index ${objectIndex}`);
    if (object.custom === undefined) {
      diagnostic(diagnostics, "OBJECT_CUSTOM_REQUIRED", ["pages", pageIndex, "objects", objectIndex, "custom"], "a serializable object must have persistent custom identity");
    } else {
      const prior = customIds.get(object.custom);
      if (prior !== undefined) diagnostic(diagnostics, "CUSTOM_DUPLICATE", ["pages", pageIndex, "objects", objectIndex, "custom"], `custom value is already used by ${prior}`, "warning");
      else customIds.set(object.custom, `pages[${pageIndex}].objects[${objectIndex}]`);
    }
    checkReferences(document, page, pageIndex, object, objectIndex, diagnostics);
  }
}

export function validateDocument(input: unknown): ValidationResult {
  const parsed = documentSchema.safeParse(input);
  if (!parsed.success) {
    const diagnostics = schemaDiagnostics(parsed.error);
    return { ok: false, diagnostics, errors: diagnostics, warnings: [] };
  }
  // The schema intentionally accepts lossless extension payloads; the
  // domain interfaces keep those payloads opaque, so narrow after parsing.
  const document = parsed.data as unknown as DocumentIR;
  const diagnostics: Diagnostic[] = [];
  for (const [scope, source] of [["source", document.source], ...document.pages.map((page, index) => [`pages[${index}]`, page.source] as const)] as const) {
    for (const [omissionIndex, omission] of (source?.omissions ?? []).entries()) {
      diagnostic(diagnostics, "SOURCE_OMISSION", [scope, "source", "omissions", omissionIndex], omission.reason, "warning");
    }
  }
  if (document.pages.length === 0) diagnostic(diagnostics, "DOCUMENT_NO_PAGE", ["pages"], "a document must contain at least one page");
  const destinations = new Map<string, string>();
  const globalEntityIds = new Set<string>();
  const customIds = new Map<string, string>();
  const styles = document.stylesheets ?? document.styles ?? [];
  for (let index = 0; index < styles.length; index += 1) {
    checkEntityId(diagnostics, globalEntityIds, "style", styles[index]!.id, ["stylesheets", index, "id"]);
  }
  for (let index = 0; index < (document.assets ?? []).length; index += 1) {
    checkEntityId(diagnostics, globalEntityIds, "asset", document.assets![index]!.id, ["assets", index, "id"]);
  }
  for (let pageIndex = 0; pageIndex < document.pages.length; pageIndex += 1) {
    const page = document.pages[pageIndex] as Page;
    if (page.name !== undefined) {
      const prior = destinations.get(page.name);
      if (prior !== undefined) diagnostic(diagnostics, "DESTINATION_NAME_DUPLICATE", ["pages", pageIndex, "name"], `destination name '${page.name}' is already used by ${prior}`);
      else destinations.set(page.name, `pages[${pageIndex}]`);
    }
    for (let viewIndex = 0; viewIndex < page.views.length; viewIndex += 1) {
      const view = page.views[viewIndex];
      if (view?.name !== undefined) {
        const prior = destinations.get(view.name);
        if (prior !== undefined) diagnostic(diagnostics, "DESTINATION_NAME_DUPLICATE", ["pages", pageIndex, "views", viewIndex, "name"], `destination name '${view.name}' is already used by ${prior}`);
        else destinations.set(view.name, `pages[${pageIndex}].views[${viewIndex}]`);
      }
    }
    validatePage(document, page, pageIndex, diagnostics, globalEntityIds, customIds);
  }
  const errors = diagnostics.filter((item) => item.severity === "error");
  const warnings = diagnostics.filter((item) => item.severity === "warning");
  return { ok: errors.length === 0, diagnostics, errors, warnings, value: document };
}

export const validateIR = validateDocument;
export const validateStructure = validateDocument;
