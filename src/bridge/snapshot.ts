import { ipeDocumentCodec, type IpeDocument } from "../core/ipe-document-codec.js";
import type { IpeObject, Page, View } from "../domain/ir.js";
import { assertMappingPreserved, assertMinimalPreamble } from "../native/adapter.js";
import { checkDocumentShapeLimits } from "../limits.js";

export class BridgeConflictError extends Error {
  readonly code = "BRIDGE_CONFLICT";
  constructor(readonly aspect: string) { super("Bridge identity or baseline conflict: " + aspect); }
}

function derivedTextMetrics(object: IpeObject): readonly string[] {
  return object.xml?.attributes?.type === "minipage" ? ["height", "depth"] : ["width", "height", "depth"];
}

export function parseBridgeSnapshot(bytes: Uint8Array): IpeDocument {
  const parsed = ipeDocumentCodec.parse(bytes);
  checkDocumentShapeLimits(parsed);
  assertMinimalPreamble(parsed.preamble);
  if (ipeDocumentCodec.validate(parsed).some(({ severity }) => severity === "error")) {
    throw new BridgeConflictError("invalid snapshot");
  }
  return parsed;
}

/** Pair the initial snapshots only after proving their native semantics agree. */
export function checkInitialBridgeSnapshot(base: IpeDocument, snapshot: IpeDocument): void {
  const comparable = structuredClone(snapshot);
  const expected = structuredClone(base);
  if (comparable.pages.length !== base.pages.length) throw new BridgeConflictError("page count");
  for (const [index, page] of comparable.pages.entries()) {
    const reference = expected.pages[index]!;
    if (page.objects.length !== reference.objects.length) throw new BridgeConflictError("object count");
    for (const [position, object] of page.objects.entries()) {
      const old = reference.objects[position]!;
      // Ipe Qt can save a working copy before LaTeX metrics have been built.
      // A present metric still has to match exactly.
      if (object.xml?.name === "text" && old.xml?.name === "text" && old.xml.attributes !== undefined) {
        for (const metric of derivedTextMetrics(old)) {
          if (object.xml.attributes?.[metric] === undefined) delete old.xml.attributes[metric];
        }
      }
      if (object.xml?.attributes?.custom === undefined && old.xml?.attributes?.custom === undefined) {
        // Ipe may assign a different positional fallback after native XML normalization.
        object.id = old.id;
        if (old.custom !== undefined) object.custom = old.custom;
      }
    }
  }
  try { assertMappingPreserved(expected, comparable); }
  catch { throw new BridgeConflictError("open Ipe and MCP documents differ"); }
}

function indexes<T>(items: readonly T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (value === undefined) continue;
    const list = result.get(value) ?? [];
    list.push(item);
    result.set(value, list);
  }
  return result;
}

function pair<T>(
  before: readonly T[],
  after: readonly T[],
  candidates: Map<T, T>,
  key: (item: T) => string | undefined,
): void {
  const used = new Set(candidates.values());
  const left = indexes(before.filter((item) => !used.has(item)), key);
  const right = indexes(after.filter((item) => !candidates.has(item)), key);
  for (const [value, matches] of right) {
    const originals = left.get(value);
    if (originals?.length === 1 && matches.length === 1) candidates.set(matches[0]!, originals[0]!);
  }
}

function unambiguous<T>(before: readonly T[], after: readonly T[], matches: Map<T, T>, aspect: string): void {
  if (matches.size < before.length && matches.size < after.length) throw new BridgeConflictError(aspect);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "x-ipe-mcp-id")
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
}

function objectFingerprint(object: IpeObject): string | undefined {
  if (!object.xml) return undefined;
  const { custom: _custom, layer: _layer, ...attributes } = object.xml.attributes ?? {};
  return JSON.stringify(stableValue({ ...object.xml, attributes }));
}

function titleKey(page: Page): string | undefined {
  return page.title || page.section || page.subsection ? JSON.stringify([page.title, page.section, page.subsection]) : undefined;
}

function viewKey(view: View, page: Page): string {
  const layerName = (id: string) => page.layers.find((layer) => layer.id === id)?.name;
  return JSON.stringify(stableValue({
    name: view.name, visible: view.visibleLayerIds.map(layerName), active: layerName(view.activeLayerId),
    marked: view.marked, attributeMaps: view.attributeMaps, transition: view.transition,
    transforms: Object.fromEntries(Object.entries(view.layerTransforms ?? {}).map(([id, matrix]) => [layerName(id), matrix])),
  }));
}

function pageKey(page: Page): string {
  return JSON.stringify([titleKey(page), page.notes, page.layers.map(({ name }) => name),
    page.views.map((view) => viewKey(view, page)), page.objects.map(objectFingerprint)]);
}

function rebindLayers(previous: Page, canonical: Page, current: Page): void {
  const byName = new Map(previous.layers.map((layer, index) => [layer.name, canonical.layers[index]!.id]));
  const replacements = new Map<string, string>();
  for (const layer of current.layers) {
    const stable = byName.get(layer.name);
    if (stable !== undefined) replacements.set(layer.id, stable);
  }
  if (replacements.size < previous.layers.length && replacements.size < current.layers.length) {
    throw new BridgeConflictError("layer rename or replacement");
  }
  const change = (id: string) => replacements.get(id) ?? id;
  for (const layer of current.layers) layer.id = change(layer.id);
  for (const object of current.objects) {
    object.layerId = change(object.layerId);
    if (object.references) object.references = object.references.map((ref) => ref.kind === "layer" ? { ...ref, id: change(ref.id) } : ref);
  }
  for (const view of current.views) {
    view.activeLayerId = change(view.activeLayerId);
    view.visibleLayerIds = view.visibleLayerIds.map(change);
    if (view.layerTransforms) view.layerTransforms = Object.fromEntries(Object.entries(view.layerTransforms).map(([id, matrix]) => [change(id), matrix]));
  }
}

function rebindViews(previous: Page, canonical: Page, current: Page): void {
  const priorKeys = previous.views.map((view) => viewKey(view, previous));
  const currentKeys = current.views.map((view) => viewKey(view, current));
  if (JSON.stringify(priorKeys) === JSON.stringify(currentKeys)) {
    current.views.forEach((view, index) => { view.id = canonical.views[index]!.id; });
    return;
  }
  const matches = new Map<View, View>();
  pair(previous.views, current.views, matches, ({ name }) => name);
  const key = (view: View) => {
    const prior = previous.views.indexOf(view);
    return prior >= 0 ? priorKeys[prior] : currentKeys[current.views.indexOf(view)];
  };
  pair(previous.views, current.views, matches, key);
  unambiguous(previous.views, current.views, matches, "view identity");
  for (const [view, prior] of matches) view.id = canonical.views[previous.views.indexOf(prior)]!.id;
}

function rebindStyles(previous: IpeDocument, canonical: IpeDocument, current: IpeDocument): void {
  const before = previous.stylesheets ?? [];
  const after = current.stylesheets ?? [];
  const base = canonical.stylesheets ?? [];
  const matches = new Map<(typeof before)[number], (typeof before)[number]>();
  pair(before, after, matches, ({ name }) => name);
  pair(before, after, matches, ({ xml }) => JSON.stringify(stableValue(xml)));
  unambiguous(before, after, matches, "stylesheet identity");
  const baselineStyles = new Map<(typeof before)[number], (typeof before)[number]>();
  pair(base, before, baselineStyles, ({ name }) => name);
  pair(base, before, baselineStyles, ({ xml }) => JSON.stringify(stableValue(xml)));
  for (const [style, prior] of matches) {
    const counterpart = baselineStyles.get(prior);
    if (counterpart === undefined) throw new BridgeConflictError("working stylesheet identity");
    style.id = counterpart.id;
  }
}

/** Reconcile against the admitted GUI baseline while retaining MCP entity identities. */
export function reconcileBridgeSnapshot(canonical: IpeDocument, previous: IpeDocument, current: IpeDocument): IpeDocument {
  const next = structuredClone(current);
  const beforeObjects = previous.pages.flatMap(({ objects }) => objects);
  const afterObjects = next.pages.flatMap(({ objects }) => objects);
  const objects = new Map<IpeObject, IpeObject>();
  const custom = (object: IpeObject) => object.xml?.attributes?.custom;
  const priorCustoms = indexes(beforeObjects, custom);
  for (const [value, matches] of indexes(afterObjects, custom)) {
    if (matches.length > 1 && priorCustoms.get(value)?.length === 1) throw new BridgeConflictError("duplicated object identity");
  }
  pair(beforeObjects, afterObjects, objects, custom);
  pair(beforeObjects, afterObjects, objects, objectFingerprint);
  unambiguous(beforeObjects, afterObjects, objects, "object identity");

  const beforeOwner = new Map<IpeObject, Page>();
  const canonicalObject = new Map<IpeObject, IpeObject>();
  const canonicalPage = new Map<Page, Page>();
  if (canonical.pages.length !== previous.pages.length) throw new BridgeConflictError("working baseline");
  previous.pages.forEach((page, index) => {
    const baseline = canonical.pages[index]!;
    if (page.objects.length !== baseline.objects.length || page.layers.length !== baseline.layers.length
      || page.views.length !== baseline.views.length) throw new BridgeConflictError("working baseline");
    canonicalPage.set(page, baseline);
    page.objects.forEach((object, position) => {
      beforeOwner.set(object, page);
      canonicalObject.set(object, baseline.objects[position]!);
    });
  });
  const pages = new Map<Page, Page>();
  pair(previous.pages, next.pages, pages, titleKey);
  const claims = new Map<Page, Page[]>();
  for (const page of next.pages) {
    if (pages.has(page)) continue;
    const owners = new Set(page.objects.flatMap((object) => {
      const old = objects.get(object);
      return old === undefined ? [] : [beforeOwner.get(old)!];
    }));
    if (owners.size !== 1) continue;
    const [owner] = owners;
    const others = claims.get(owner!) ?? [];
    others.push(page);
    claims.set(owner!, others);
  }
  for (const [owner, proposed] of claims) {
    if (proposed.length === 1 && ![...pages.values()].includes(owner)) pages.set(proposed[0]!, owner);
  }
  pair(previous.pages, next.pages, pages, pageKey);
  unambiguous(previous.pages, next.pages, pages, "page identity");

  for (const [page, prior] of pages) {
    const baseline = canonicalPage.get(prior)!;
    page.id = baseline.id;
    if (page.name === undefined && baseline.name !== undefined) page.name = baseline.name;
    if (page.marked === undefined && baseline.marked !== undefined) page.marked = baseline.marked;
    rebindLayers(prior, baseline, page);
    rebindViews(prior, baseline, page);
  }
  for (const [object, prior] of objects) {
    const baseline = canonicalObject.get(prior)!;
    object.id = baseline.id;
    if (custom(object) === undefined && baseline.custom !== undefined) object.custom = baseline.custom;
  }
  rebindStyles(previous, canonical, next);
  // GUI render metrics describe a particular LaTeX run. Recompute them through
  // the native pipeline instead of declaring them as persistent geometry.
  for (const object of afterObjects) {
    if (object.xml?.name === "text" && object.xml.attributes !== undefined) {
      for (const metric of derivedTextMetrics(object)) delete object.xml.attributes[metric];
    }
  }
  if (ipeDocumentCodec.validate(next).some(({ severity }) => severity === "error")) throw new BridgeConflictError("reconciled identity");
  return next;
}
