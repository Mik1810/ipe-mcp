import { createHash } from "node:crypto";
import type { DocumentIR, IpeObject, Layer, Matrix, Page, View } from "../domain/ir.js";
import { objectIdFromCustom } from "../domain/identity.js";
import { validateDocument } from "../domain/validate.js";
import { resolveIpeLayout, type IpeLayoutDefinition } from "../layout/ipe-layout.js";

export type SlidePreset = "standard" | "16:9";
export interface SlidePresetDefinition { readonly name: SlidePreset; readonly paper: readonly [number, number]; readonly origin: readonly [number, number]; readonly frame: readonly [number, number]; }
export const SLIDE_PRESETS: Readonly<Record<SlidePreset, SlidePresetDefinition>> = { standard: { name: "standard", paper: [595, 842], origin: [0, 0], frame: [595, 842] }, "16:9": { name: "16:9", paper: [1280, 720], origin: [32, 0], frame: [1216, 648] } };
const digest = (kind: string, seed: string, salt = 0) => `${kind}-${createHash("sha256").update(`ipe-mcp/m5/${kind}/${seed}/${salt}`).digest("hex").slice(0, 24)}`;
const clone = <T>(v: T): T => structuredClone(v);
const allIds = (d: DocumentIR) => new Set([...(d.stylesheets ?? d.styles ?? []).map((x) => x.id), ...(d.assets ?? []).map((x) => x.id), ...d.pages.flatMap((p) => [p.id, ...p.layers.map((x) => x.id), ...p.views.map((x) => x.id), ...p.objects.map((x) => x.id)])]);
const fresh = (kind: "page" | "layer" | "view" | "object" | "style", seed: string, used: Set<string>) => { let n = 0; let result = digest(kind, seed, n); while (used.has(result)) result = digest(kind, seed, ++n); used.add(result); return result; };
const freshObject = (seed: string, used: Set<string>, _editable = "template") => { let n = 0; let custom = `ipe-mcp:${digest("object", `${seed}/custom`, n)}`; let id = objectIdFromCustom(custom); while (used.has(id)) { custom = `ipe-mcp:${digest("object", `${seed}/custom`, ++n)}`; id = objectIdFromCustom(custom); } used.add(id); return { id, custom }; };
const page = (d: DocumentIR, id: string) => { const x = d.pages.find((p) => p.id === id); if (!x) throw new Error(`page '${id}' does not exist`); return x; };
const layer = (p: Page, id: string) => { const x = p.layers.find((l) => l.id === id); if (!x) throw new Error(`layer '${id}' does not exist on page '${p.id}'`); return x; };
const view = (p: Page, id: string) => { const x = p.views.find((v) => v.id === id); if (!x) throw new Error(`view '${id}' does not exist on page '${p.id}'`); return x; };
function commit(d: DocumentIR, c: DocumentIR): void { c.pages.forEach((p) => p.views.forEach((v) => { if (v.marked === undefined) v.marked = false; })); const r = validateDocument(c); if (!r.ok) throw new Error(r.errors.map((e) => `${e.code}: ${e.message}`).join("; ")); d.pages = c.pages; if (c.stylesheets === undefined) delete d.stylesheets; else d.stylesheets = c.stylesheets; if (c.styles === undefined) delete d.styles; else d.styles = c.styles; }
function mutate<T>(d: DocumentIR, f: (c: DocumentIR) => T): T { const c = clone(d); const out = f(c); commit(d, c); return out; }

export interface PageSpec { readonly id?: string; readonly name?: string; readonly title?: string; readonly section?: string; readonly subsection?: string; readonly notes?: string; readonly marked?: boolean; readonly layers?: readonly Layer[]; readonly views?: readonly View[]; }
export function createPage(d: DocumentIR, s: PageSpec = {}): Page { return mutate(d, (c) => { const used = allIds(c); const ls = (s.layers?.length ? s.layers : [{ id: fresh("layer", `${c.pages.length}/base`, used), name: "alpha" }]).map(clone); const first = ls[0]!; const vs = (s.views?.length ? s.views : [{ id: fresh("view", `${c.pages.length}/normal`, used), name: "normal", visibleLayerIds: ls.map((x) => x.id), activeLayerId: first.id, marked: false }]).map(clone); const p: Page = { id: s.id ?? fresh("page", `${c.pages.length}/${s.name ?? "page"}`, used), ...(s.name === undefined ? {} : { name: s.name }), ...(s.title === undefined ? {} : { title: s.title }), ...(s.section === undefined ? {} : { section: s.section }), ...(s.subsection === undefined ? {} : { subsection: s.subsection }), ...(s.notes === undefined ? {} : { notes: s.notes }), ...(s.marked === undefined ? {} : { marked: s.marked }), layers: ls, views: vs, objects: [] }; c.pages.push(p); return p; }); }
export function updatePage(d: DocumentIR, id: string, patch: Partial<Pick<Page, "name" | "title" | "section" | "subsection" | "notes" | "marked">>): Page { mutate(d, (c) => Object.assign(page(c, id), patch)); return page(d, id); }
export function deletePage(d: DocumentIR, id: string): void { mutate(d, (c) => { if (c.pages.length <= 1) throw new Error("a document must retain at least one page"); const n = c.pages.length; c.pages = c.pages.filter((p) => p.id !== id); if (n === c.pages.length) throw new Error(`page '${id}' does not exist`); }); }
export function reorderPages(d: DocumentIR, order: readonly string[]): void { mutate(d, (c) => { if (new Set(order).size !== c.pages.length || order.some((id) => !c.pages.some((p) => p.id === id))) throw new Error("page order must contain every page exactly once"); c.pages = order.map((id) => c.pages.find((p) => p.id === id)!); }); }

export interface LayerSpec { readonly id?: string; readonly name: string; readonly edit?: boolean; readonly snap?: Layer["snap"]; readonly intentional?: boolean; }
export function addLayer(d: DocumentIR, pageId: string, s: LayerSpec): Layer { return mutate(d, (c) => { const p = page(c, pageId); if (p.layers.some((x) => x.name === s.name)) throw new Error(`layer name '${s.name}' already exists`); const id = s.id ?? fresh("layer", `${pageId}/${p.layers.length}/${s.name}`, allIds(c)); const x = { id, name: s.name, ...(s.edit === undefined ? {} : { edit: s.edit }), ...(s.snap === undefined ? {} : { snap: s.snap }), ...(s.intentional === undefined ? {} : { intentional: s.intentional }) }; p.layers.push(x); return x; }); }
export function updateLayer(d: DocumentIR, pageId: string, id: string, patch: Partial<Pick<Layer, "name" | "edit" | "snap" | "locked" | "intentional">>): Layer { mutate(d, (c) => Object.assign(layer(page(c, pageId), id), patch)); return layer(page(d, pageId), id); }
export function deleteLayer(d: DocumentIR, pageId: string, id: string): void { mutate(d, (c) => { const p = page(c, pageId); if (p.layers.length <= 1) throw new Error("a page must retain at least one layer"); layer(p, id); if (p.objects.some((o) => o.layerId === id)) throw new Error("cannot delete a layer containing objects"); p.layers = p.layers.filter((x) => x.id !== id); p.views.forEach((v) => { v.visibleLayerIds = v.visibleLayerIds.filter((x) => x !== id); if (v.activeLayerId === id) v.activeLayerId = p.layers[0]!.id; }); }); }
export function reorderLayers(d: DocumentIR, pageId: string, order: readonly string[]): void { mutate(d, (c) => { const p = page(c, pageId); if (new Set(order).size !== p.layers.length || order.some((id) => !p.layers.some((x) => x.id === id))) throw new Error("layer order must contain every layer exactly once"); p.layers = order.map((id) => p.layers.find((x) => x.id === id)!); }); }

export interface ViewSpec { readonly id?: string; readonly name?: string; readonly visibleLayerIds?: readonly string[]; readonly activeLayerId?: string; readonly marked?: boolean; readonly layerTransforms?: Record<string, Matrix>; readonly transforms?: View["transforms"]; readonly transition?: Record<string, unknown>; }
export function addView(d: DocumentIR, pageId: string, s: ViewSpec = {}): View { return mutate(d, (c) => { const p = page(c, pageId); const visible = [...(s.visibleLayerIds ?? p.layers.map((x) => x.id))]; const x = { id: s.id ?? fresh("view", `${pageId}/${p.views.length}/${s.name ?? "view"}`, allIds(c)), ...(s.name === undefined ? {} : { name: s.name }), visibleLayerIds: visible, activeLayerId: s.activeLayerId ?? visible[0] ?? p.layers[0]!.id, marked: s.marked ?? false, ...(s.layerTransforms === undefined ? {} : { layerTransforms: clone(s.layerTransforms) }), ...(s.transforms === undefined ? {} : { transforms: clone(s.transforms) }), ...(s.transition === undefined ? {} : { transition: clone(s.transition) }) }; p.views.push(x); return x; }); }
export function updateView(d: DocumentIR, pageId: string, id: string, patch: Partial<Pick<View, "name" | "visibleLayerIds" | "activeLayerId" | "marked" | "layerTransforms" | "transforms" | "transition">>): View { mutate(d, (c) => Object.assign(view(page(c, pageId), id), clone(patch))); return view(page(d, pageId), id); }
export function deleteView(d: DocumentIR, pageId: string, id: string): void { mutate(d, (c) => { const p = page(c, pageId); view(p, id); if (p.views.length <= 1) throw new Error("a page must retain at least one view"); p.views = p.views.filter((x) => x.id !== id); }); }
export function reorderViews(d: DocumentIR, pageId: string, order: readonly string[]): void { mutate(d, (c) => { const p = page(c, pageId); if (new Set(order).size !== p.views.length || order.some((id) => !p.views.some((x) => x.id === id))) throw new Error("view order must contain every view exactly once"); p.views = order.map((id) => p.views.find((x) => x.id === id)!); }); }
export function setViewVisibility(d: DocumentIR, pageId: string, id: string, ids: readonly string[], activeLayerId?: string): View { return updateView(d, pageId, id, { visibleLayerIds: [...ids], ...(activeLayerId === undefined ? {} : { activeLayerId }) }); }
export function createCumulativeView(d: DocumentIR, pageId: string, id: string, ids: readonly string[], name?: string): View { const p = page(d, pageId); const source = view(p, id); return addView(d, pageId, { ...(name === undefined ? {} : { name }), visibleLayerIds: [...new Set([...source.visibleLayerIds, ...ids])], activeLayerId: source.activeLayerId, marked: source.marked }); }
export function createArbitraryView(d: DocumentIR, pageId: string, ids: readonly string[], activeLayerId?: string, name?: string): View { return addView(d, pageId, { ...(name === undefined ? {} : { name }), visibleLayerIds: [...ids], ...(activeLayerId === undefined ? {} : { activeLayerId }) }); }
export function markHandout(d: DocumentIR, predicate: (v: View, p: Page) => boolean = (v) => v.marked): readonly string[] { return mutate(d, (c) => { const out: string[] = []; c.pages.forEach((p) => p.views.forEach((v) => { v.marked = predicate(v, p); if (v.marked) out.push(v.id); })); return out; }); }

function uniqueDestinationName(d: DocumentIR, desired: string | undefined, reserved = new Set<string>()): string | undefined { if (desired === undefined) return undefined; const used = new Set([...d.pages.flatMap((p) => [p.name, ...p.views.map((v) => v.name)]), ...reserved].filter((x): x is string => x !== undefined)); if (!used.has(desired)) return desired; let n = 2; while (used.has(`${desired}-${n}`)) n += 1; return `${desired}-${n}`; }
function duplicateRemapped(d: DocumentIR, source: Page, index: number): Page { const used = allIds(d); const p = fresh("page", `${source.id}/duplicate/${index}`, used); const lm = new Map(source.layers.map((x) => [x.id, fresh("layer", `${source.id}/${x.id}/${index}`, used)])); const vm = new Map(source.views.map((x) => [x.id, fresh("view", `${source.id}/${x.id}/${index}`, used)])); const om = new Map(source.objects.map((x, i) => { const freshId = freshObject(`${source.id}/${x.id}/${index}/${i}`, used, x.custom ?? "template"); return [x.id, freshId] as const; })); const ref = (r: { kind: string; id: string }) => ({ ...r, id: r.kind === "layer" ? lm.get(r.id) ?? r.id : r.kind === "view" ? vm.get(r.id) ?? r.id : r.kind === "object" ? om.get(r.id)?.id ?? r.id : r.kind === "page" && r.id === source.id ? p : r.id }); return { ...clone(source), id: p, ...(source.name === undefined ? {} : { name: uniqueDestinationName(d, source.name)! }), layers: source.layers.map((x) => ({ ...clone(x), id: lm.get(x.id)! })), views: source.views.map((x) => ({ ...clone(x), id: vm.get(x.id)!, ...(x.name === undefined ? {} : { name: uniqueDestinationName(d, x.name)! }), visibleLayerIds: x.visibleLayerIds.map((id) => lm.get(id) ?? id), activeLayerId: lm.get(x.activeLayerId)!, ...(x.layerTransforms === undefined ? {} : { layerTransforms: Object.fromEntries(Object.entries(x.layerTransforms).map(([id, m]) => [lm.get(id) ?? id, m])) }), ...(x.transforms === undefined ? {} : { transforms: x.transforms.map((transform) => ({ ...transform, layerId: lm.get(transform.layerId) ?? transform.layerId })) }) })), objects: source.objects.map((x) => ({ ...clone(x), id: om.get(x.id)!.id, custom: om.get(x.id)!.custom, layerId: lm.get(x.layerId)!, ...(x.references === undefined ? {} : { references: x.references.map(ref) }), zOrder: x.zOrder })) }; }
export function duplicatePage(d: DocumentIR, pageId: string, index = d.pages.length): Page { return mutate(d, (c) => { const x = duplicateRemapped(c, page(c, pageId), index); c.pages.splice(Math.max(0, Math.min(index, c.pages.length)), 0, x); return x; }); }
export function duplicateLayer(d: DocumentIR, pageId: string, id: string, index?: number): Layer { return mutate(d, (c) => { const p = page(c, pageId); const source = layer(p, id); const names = new Set(p.layers.map((candidate) => candidate.name)); let name = `${source.name}-copy`; let suffix = 2; while (names.has(name)) name = `${source.name}-copy-${suffix++}`; const x = { ...clone(source), id: fresh("layer", `${pageId}/${id}/copy/${index ?? p.layers.length}`, allIds(c)), name }; p.layers.splice(index ?? p.layers.length, 0, x); p.views.forEach((v) => { if (v.visibleLayerIds.includes(id)) v.visibleLayerIds.push(x.id); }); return x; }); }
export function duplicateView(d: DocumentIR, pageId: string, id: string, index?: number): View { return mutate(d, (c) => { const p = page(c, pageId); const source = view(p, id); const desired = source.name === undefined ? undefined : `${source.name}-copy`; const x = { ...clone(source), id: fresh("view", `${pageId}/${id}/copy/${index ?? p.views.length}`, allIds(c)), ...(desired === undefined ? {} : { name: uniqueDestinationName(c, desired)! }) }; p.views.splice(index ?? p.views.length, 0, x); return x; }); }

export interface PageTemplate { readonly pageId?: string; readonly layers: readonly Layer[]; readonly views: readonly View[]; readonly objects: readonly IpeObject[]; }
export interface ComposeSlideOptions extends Omit<PageSpec, "layers" | "views"> { readonly preset?: SlidePreset; readonly layers?: readonly LayerSpec[]; readonly views?: readonly ViewSpec[]; readonly template?: PageTemplate; }
function sameLayout(actual: IpeLayoutDefinition, preset: SlidePresetDefinition): boolean { return actual.paper[0] === preset.paper[0] && actual.paper[1] === preset.paper[1] && actual.origin[0] === preset.origin[0] && actual.origin[1] === preset.origin[1] && actual.frame[0] === preset.frame[0] && actual.frame[1] === preset.frame[1]; }
export function composeSlide(d: DocumentIR, options: ComposeSlideOptions = {}): Page {
  const preset = SLIDE_PRESETS[options.preset ?? "standard"];
  if (!sameLayout(resolveIpeLayout(d), preset)) throw new Error(`slide preset '${preset.name}' is incompatible with the document's global layout`);
  const work = clone(d);
  const used = allIds(work);
  const template = options.template;
  const sourceLayers = template?.layers ?? options.layers ?? [{ name: "content" }];
  const layers = sourceLayers.map((source, index) => ({
    ...clone(source),
    id: template
      ? fresh("layer", `slide/${work.pages.length}/${index}/${source.id}`, used)
      : source.id && !used.has(source.id) ? source.id : fresh("layer", `slide/${work.pages.length}/${index}/${source.name}`, used),
  })) as Layer[];
  const layerMap = new Map((template?.layers ?? []).map((source, index) => [source.id, layers[index]!.id]));
  const reservedNames = new Set<string>();
  const sourceViews = template?.views ?? options.views ?? [{ name: "normal" }];
  const views = sourceViews.map((source, index) => {
    const name = uniqueDestinationName(work, source.name, reservedNames);
    if (name !== undefined) reservedNames.add(name);
    const visible = source.visibleLayerIds ?? layers.map((layer) => layer.id);
    return {
      ...clone(source),
      id: template
        ? fresh("view", `slide/${work.pages.length}/${index}/${source.id}`, used)
        : source.id && !used.has(source.id) ? source.id : fresh("view", `slide/${work.pages.length}/${index}/${source.name ?? "view"}`, used),
      ...(name === undefined ? {} : { name }),
      visibleLayerIds: visible.map((id) => layerMap.get(id) ?? id),
      activeLayerId: layerMap.get(source.activeLayerId ?? "") ?? source.activeLayerId ?? layers[0]!.id,
      ...(source.layerTransforms === undefined ? {} : { layerTransforms: Object.fromEntries(Object.entries(source.layerTransforms).map(([id, matrix]) => [layerMap.get(id) ?? id, matrix])) }),
      ...(source.transforms === undefined ? {} : { transforms: source.transforms.map((transform) => ({ ...transform, layerId: layerMap.get(transform.layerId) ?? transform.layerId })) }),
    };
  }) as View[];
  const viewMap = new Map((template?.views ?? []).map((source, index) => [source.id, views[index]!.id]));
  const objectMap = new Map((template?.objects ?? []).map((source, index) => [source.id, freshObject(`slide/${work.pages.length}/object/${index}/${source.id}`, used)]));
  const remapReference = (reference: { kind: string; id: string }) => ({
    ...reference,
    id: reference.kind === "object" ? objectMap.get(reference.id)?.id ?? reference.id
      : reference.kind === "layer" ? layerMap.get(reference.id) ?? reference.id
      : reference.kind === "view" ? viewMap.get(reference.id) ?? reference.id
      : reference.kind === "page" && template?.pageId === reference.id ? "__new_page__"
      : reference.id,
  });
  const objects = (template?.objects ?? []).map((source) => ({
    ...clone(source),
    id: objectMap.get(source.id)!.id,
    custom: objectMap.get(source.id)!.custom,
    layerId: layerMap.get(source.layerId) ?? source.layerId,
    ...(source.references === undefined ? {} : { references: source.references.map(remapReference) }),
  }));
  const pageName = uniqueDestinationName(work, options.name, reservedNames);
  const { preset: _preset, layers: _layers, views: _views, template: _template, ...fields } = options;
  void _preset; void _layers; void _views; void _template;
  const result = createPage(work, { ...fields, ...(pageName === undefined ? {} : { name: pageName }), layers, views });
  result.objects.push(...objects.map((object, index) => ({
    ...object,
    zOrder: index,
    ...(object.references === undefined ? {} : { references: object.references.map((reference) => reference.id === "__new_page__" ? { ...reference, id: result.id } : reference) }),
  })));
  commit(d, work);
  return page(d, result.id);
}
export interface PdfPageMapping { readonly pdfPage: number; readonly pageId: string; readonly viewId: string; }
export function mapPdfPages(d: DocumentIR): readonly PdfPageMapping[] { let n = 1; return d.pages.flatMap((p) => p.views.map((v) => ({ pdfPage: n++, pageId: p.id, viewId: v.id }))); }
export function estimatePdfExpansion(d: DocumentIR): { readonly pages: number; readonly views: number; readonly pdfPages: number; readonly mapping: readonly PdfPageMapping[] } { const mapping = mapPdfPages(d); return { pages: d.pages.length, views: mapping.length, pdfPages: mapping.length, mapping }; }
export const compose_slide = composeSlide;
