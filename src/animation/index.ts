import { createHash } from "node:crypto";

import type { DocumentIR, IpeObject, Matrix, Page, View } from "../domain/ir.js";
import { objectIdFromCustom } from "../domain/identity.js";
import { validateDocument } from "../domain/validate.js";
import type { XmlElement } from "../domain/xml-node.js";
import { resolvePageCoordinateSystem } from "../layout/ipe-layout.js";
import { IDENTITY_MATRIX, multiplyMatrices, translationMatrix } from "../layout/matrix.js";
import { matrixText } from "../objects/common.js";

export const IPE_EFFECTS = [
  "normal", "split-horizontal-in", "split-horizontal-out", "split-vertical-in", "split-vertical-out",
  "blinds-horizontal", "blinds-vertical", "box-in", "box-out", "wipe-left-right", "wipe-bottom-top",
  "wipe-right-left", "wipe-top-bottom", "dissolve", "glitter-left-right", "glitter-top-bottom",
  "glitter-diagonal", "fly-in-left-right", "fly-out-left-right", "fly-in-top-bottom", "fly-out-top-bottom",
  "push-left-right", "push-top-bottom", "cover-left-right", "cover-left-bottom", "uncover-left-right",
  "uncover-top-bottom", "fade",
] as const;
export type IpeEffect = typeof IPE_EFFECTS[number];
export const IPE_EFFECT_ID: Readonly<Record<IpeEffect, number>> = Object.freeze(Object.fromEntries(IPE_EFFECTS.map((name, id) => [name, id])) as Record<IpeEffect, number>);

export type AnimationViewer = "ipe-presenter" | "acrobat" | "okular" | "evince" | "pdfpc" | "browser";
export type ViewerCapability = "verified" | "degraded" | "ignored" | "untested";
export interface ViewerProfile { readonly staticViews: ViewerCapability; readonly transitions: ViewerCapability; readonly notes: string; }
export const VIEWER_MATRIX: Readonly<Record<AnimationViewer, ViewerProfile>> = Object.freeze({
  "ipe-presenter": { staticViews: "verified", transitions: "ignored", notes: "IpePresenter 7.2.30 navigates static views but does not interpret PDF transition effects." },
  acrobat: { staticViews: "untested", transitions: "untested", notes: "No Acrobat version/platform was available for M7 verification." },
  okular: { staticViews: "untested", transitions: "untested", notes: "Published conservatively until a pinned Okular runtime is exercised." },
  evince: { staticViews: "untested", transitions: "untested", notes: "Published conservatively until a pinned Evince runtime is exercised." },
  pdfpc: { staticViews: "untested", transitions: "untested", notes: "Presenter behavior was not exercised by the automated M7 lane." },
  browser: { staticViews: "degraded", transitions: "ignored", notes: "Browsers expose PDF pages as static states; transition playback is not claimed." },
});

export interface AnimationDiagnostic { readonly code: string; readonly severity: "info" | "warning"; readonly message: string; }
export interface ExpansionLimits { readonly maxGeneratedViews?: number; readonly maxGeneratedCopies?: number; readonly maxPdfPages?: number; }
export interface ExpansionEstimate { readonly generatedViews: number; readonly generatedCopies: number; readonly resultingPdfPages: number; }
export interface AnimationResult { readonly viewIds: readonly string[]; readonly layerIds: readonly string[]; readonly objectIds: readonly string[]; readonly estimate: ExpansionEstimate; readonly diagnostics: readonly AnimationDiagnostic[]; }
export type HandoutPolicy = "none" | "final" | "initial-and-final" | "all";
export type BboxPolicy = { readonly kind: "fixed" } | { readonly kind: "per-view" } | { readonly kind: "explicit"; readonly box: AnimationBox };
export interface AnimationBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export interface Pose { readonly x: number; readonly y: number; }
export type SemanticEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";

const DEFAULT_LIMITS = { maxGeneratedViews: 64, maxGeneratedCopies: 512, maxPdfPages: 1000 } as const;
const clone = <T>(value: T): T => structuredClone(value);
const digest = (kind: "layer" | "view", seed: string, salt: number) => `${kind}-${createHash("sha256").update(`ipe-mcp/m7/${kind}/${seed}/${salt}`).digest("hex").slice(0, 24)}`;
const usedIds = (document: DocumentIR) => new Set(document.pages.flatMap((page) => [page.id, ...page.layers.map((item) => item.id), ...page.views.map((item) => item.id), ...page.objects.map((item) => item.id)]));
function freshEntity(kind: "layer" | "view", seed: string, used: Set<string>): string { let salt = 0; let id = digest(kind, seed, salt); while (used.has(id)) id = digest(kind, seed, ++salt); used.add(id); return id; }
function freshObject(seed: string, used: Set<string>): { id: string; custom: string } { let salt = 0; let custom = `ipe-mcp:m7:${createHash("sha256").update(`${seed}/${salt}`).digest("hex")}`; let id = objectIdFromCustom(custom); while (used.has(id)) { custom = `ipe-mcp:m7:${createHash("sha256").update(`${seed}/${++salt}`).digest("hex")}`; id = objectIdFromCustom(custom); } used.add(id); return { id, custom }; }
function pageById(document: DocumentIR, pageId: string): Page { const page = document.pages.find((candidate) => candidate.id === pageId); if (!page) throw new Error(`page '${pageId}' does not exist`); return page; }
function uniqueLayerName(page: Page, desired: string): string { const names = new Set(page.layers.map((layer) => layer.name)); if (!names.has(desired)) return desired; let suffix = 2; while (names.has(`${desired}-${suffix}`)) suffix += 1; return `${desired}-${suffix}`; }
function countPdfPages(document: DocumentIR): number { return document.pages.reduce((sum, page) => sum + Math.max(1, page.views.length), 0); }
function assertBox(box: AnimationBox, label: string): void { if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) throw new Error(`${label} must be a finite positive rectangle`); }
function preflight(document: DocumentIR, generatedViews: number, generatedCopies: number, limits: ExpansionLimits = {}): ExpansionEstimate {
  if (!Number.isSafeInteger(generatedViews) || generatedViews < 1 || !Number.isSafeInteger(generatedCopies) || generatedCopies < 0) throw new Error("animation expansion counts must be non-negative safe integers");
  const estimate = { generatedViews, generatedCopies, resultingPdfPages: countPdfPages(document) + generatedViews };
  const effective = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(effective)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  if (estimate.generatedViews > effective.maxGeneratedViews) throw new Error(`animation would generate ${estimate.generatedViews} views (limit ${effective.maxGeneratedViews})`);
  if (estimate.generatedCopies > effective.maxGeneratedCopies) throw new Error(`animation would generate ${estimate.generatedCopies} copies (limit ${effective.maxGeneratedCopies})`);
  if (estimate.resultingPdfPages > effective.maxPdfPages) throw new Error(`animation would expand the PDF to ${estimate.resultingPdfPages} pages (limit ${effective.maxPdfPages})`);
  return estimate;
}
export function estimateAnimationExpansion(document: DocumentIR, generatedViews: number, generatedCopies: number): ExpansionEstimate { return preflight(document, generatedViews, generatedCopies, { maxGeneratedViews: Number.MAX_SAFE_INTEGER, maxGeneratedCopies: Number.MAX_SAFE_INTEGER, maxPdfPages: Number.MAX_SAFE_INTEGER }); }
function commit(document: DocumentIR, candidate: DocumentIR): void { const result = validateDocument(candidate); if (!result.ok) throw new Error(result.errors.map((item) => `${item.code}: ${item.message}`).join("; ")); for (const key of Object.keys(document) as (keyof DocumentIR)[]) delete document[key]; Object.assign(document, candidate); }
function setHandout(views: View[], policy: HandoutPolicy): void { views.forEach((view, index) => { view.marked = policy === "all" || (policy === "final" && index === views.length - 1) || (policy === "initial-and-final" && (index === 0 || index === views.length - 1)); }); }
function easing(kind: SemanticEasing, t: number): number { if (kind === "ease-in") return t * t; if (kind === "ease-out") return 1 - (1 - t) ** 2; if (kind === "ease-in-out") return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2; return t; }
function translated(matrix: Matrix | undefined, pose: Pose): Matrix { return multiplyMatrices(translationMatrix(pose.x, pose.y), matrix ?? IDENTITY_MATRIX); }
function renumber(page: Page): void { page.objects.forEach((object, index) => { object.zOrder = index; }); }
function visibleBase(page: Page, sourceViewId?: string): { visible: string[]; active: string } { const source = sourceViewId === undefined ? page.views.at(-1) : page.views.find((view) => view.id === sourceViewId); if (!source) throw new Error(`source view '${sourceViewId}' does not exist`); return { visible: [...source.visibleLayerIds], active: source.activeLayerId }; }
function newLayer(page: Page, used: Set<string>, seed: string, desired: string, intentional = false): string { const id = freshEntity("layer", seed, used); page.layers.push({ id, name: uniqueLayerName(page, desired), ...(intentional ? { intentional: true } : {}) }); return id; }
function newView(page: Page, used: Set<string>, seed: string, visibleLayerIds: readonly string[], activeLayerId: string, name: string): View { const view: View = { id: freshEntity("view", seed, used), name, visibleLayerIds: [...new Set(visibleLayerIds)], activeLayerId, marked: false }; page.views.push(view); return view; }
function preserveLegacyVisibility(views: readonly View[], previousLayerId: string, compatibilityLayerId: string): void {
  for (const view of views) if (view.visibleLayerIds.includes(previousLayerId)) view.visibleLayerIds = [...view.visibleLayerIds, compatibilityLayerId];
}
function rectangleObject(layerId: string, box: AnimationBox, used: Set<string>, seed: string): IpeObject {
  const identity = freshObject(seed, used); const x2 = box.x + box.width; const y2 = box.y + box.height;
  return { id: identity.id, custom: identity.custom, layerId, zOrder: 0, xml: { type: "element", name: "path", attributes: {}, children: [{ type: "text", text: `${box.x} ${box.y} m ${x2} ${box.y} l ${x2} ${y2} l ${box.x} ${y2} l h` }] } };
}
function materializeBbox(document: DocumentIR, page: Page, used: Set<string>, views: readonly View[], poses: readonly Pose[], policy: BboxPolicy | undefined): void {
  if (policy === undefined) return;
  const layerName = policy.kind === "per-view" ? "VIEWBBOX" : "BBOX";
  let layer = page.layers.find((candidate) => candidate.name === layerName);
  if (!layer) { const id = newLayer(page, used, `${page.id}/bbox/${layerName}`, layerName, true); layer = page.layers.find((candidate) => candidate.id === id)!; }
  layer.intentional = true;
  const existingGeometry = page.objects.some((object) => object.layerId === layer!.id);
  if (!existingGeometry) {
    const frame = resolvePageCoordinateSystem(document).frame;
    const box = policy.kind === "explicit" ? policy.box : frame;
    page.objects.push(rectangleObject(layer.id, box, used, `${page.id}/bbox/${layerName}/geometry`));
  }
  for (const [index, view] of views.entries()) {
    if (!view.visibleLayerIds.includes(layer.id)) view.visibleLayerIds.push(layer.id);
    if (policy.kind === "per-view") view.layerTransforms = { ...(view.layerTransforms ?? {}), [layer.id]: translationMatrix(poses[index]!.x, poses[index]!.y) };
  }
}

export type RevealTarget = { readonly kind: "layer"; readonly id: string } | { readonly kind: "object"; readonly id: string };
export interface RevealOptions { readonly groups: readonly (readonly RevealTarget[])[]; readonly cumulative?: boolean; readonly initialState?: "hidden" | "visible"; readonly finalState?: "hidden" | "visible"; readonly objectLayers?: "create" | "reuse"; readonly sourceViewId?: string; readonly name?: string; readonly handout?: HandoutPolicy; readonly limits?: ExpansionLimits; }
export function buildReveal(document: DocumentIR, pageId: string, options: RevealOptions): AnimationResult {
  if (options.groups.length === 0 || options.groups.some((group) => group.length === 0)) throw new Error("reveal requires non-empty ordered groups");
  const targetCount = options.groups.reduce((sum, group) => sum + group.length, 0);
  const estimate = preflight(document, options.groups.length + 2, 0, options.limits);
  const candidate = clone(document); const page = pageById(candidate, pageId); const used = usedIds(candidate); const base = visibleBase(page, options.sourceViewId); const legacyViews = [...page.views];
  const seen = new Set<string>(); const groupLayers: string[][] = []; const createdLayers: string[] = []; const diagnostics: AnimationDiagnostic[] = [];
  for (const [groupIndex, group] of options.groups.entries()) {
    const layers: string[] = [];
    for (const target of group) {
      if (seen.has(`${target.kind}:${target.id}`)) throw new Error(`reveal target '${target.id}' appears more than once`); seen.add(`${target.kind}:${target.id}`);
      if (target.kind === "layer") { if (!page.layers.some((layer) => layer.id === target.id)) throw new Error(`layer '${target.id}' does not exist`); layers.push(target.id); continue; }
      const object = page.objects.find((candidate) => candidate.id === target.id); if (!object) throw new Error(`object '${target.id}' does not exist`);
      if ((options.objectLayers ?? "create") === "create") { const previousLayerId = object.layerId; const layerId = newLayer(page, used, `${pageId}/reveal/${groupIndex}/${target.id}`, `${options.name ?? "reveal"}-${groupIndex + 1}`); object.layerId = layerId; preserveLegacyVisibility(legacyViews, previousLayerId, layerId); layers.push(layerId); createdLayers.push(layerId); }
      else { layers.push(object.layerId); diagnostics.push({ code: "REVEAL_REUSED_OBJECT_LAYER", severity: "warning", message: `Object '${target.id}' shares reveal visibility with every object on its reused layer.` }); }
    }
    groupLayers.push([...new Set(layers)]);
  }
  const controlled = new Set(groupLayers.flat()); const always = base.visible.filter((id) => !controlled.has(id)); const initialVisible = options.initialState === "visible" ? groupLayers.flat() : [];
  const states: string[][] = [[...always, ...initialVisible]]; let accumulated = [...initialVisible];
  for (const group of groupLayers) { accumulated = options.cumulative === false ? [...group] : [...new Set([...accumulated, ...group])]; states.push([...always, ...accumulated]); }
  const finalLayers = options.finalState === "hidden" ? [] : groupLayers.flat(); states.push([...always, ...finalLayers]);
  if (states.some((state) => state.length === 0)) { const neutral = newLayer(page, used, `${pageId}/reveal/neutral`, `${options.name ?? "reveal"}-neutral`); createdLayers.push(neutral); states.forEach((state) => { if (state.length === 0) state.push(neutral); }); }
  const views = states.map((layers, index) => newView(page, used, `${pageId}/reveal/view/${index}`, layers, layers.includes(base.active) ? base.active : layers[0]!, `${options.name ?? "reveal"}-${index}`));
  setHandout(views, options.handout ?? "final"); commit(document, candidate);
  return { viewIds: views.map((view) => view.id), layerIds: createdLayers, objectIds: [], estimate, diagnostics: [...diagnostics, { code: "DISCRETE_STATIC_STATES", severity: "info", message: `${targetCount} reveal targets compile to independently renderable views.` }] };
}

export interface MotionOptions { readonly objectIds: readonly string[]; readonly from: Pose; readonly to: Pose; readonly steps: number; readonly easing?: SemanticEasing; readonly strategy?: "duplicate" | "layer-transform"; readonly sourceViewId?: string; readonly name?: string; readonly handout?: HandoutPolicy; readonly bbox?: BboxPolicy; readonly viewer?: AnimationViewer; readonly staticFallback?: boolean; readonly limits?: ExpansionLimits; readonly clip?: AnimationBox; }
function cloneVariant(source: IpeObject, layerId: string, pose: Pose, used: Set<string>, seed: string, clip?: AnimationBox): IpeObject {
  const identity = freshObject(seed, used); const result = clone(source); result.id = identity.id; result.custom = identity.custom; result.layerId = layerId;
  if (clip === undefined) result.matrix = translated(source.matrix, pose);
  else {
    const child = clone(source.xml!); const attributes = (child.attributes ??= {}); delete attributes.layer; delete attributes["x-ipe-mcp-id"]; attributes.matrix = matrixText(translated(source.matrix, pose));
    delete result.matrix; result.xml = { type: "element", name: "group", attributes: { custom: identity.custom, "x-ipe-mcp-id": identity.id, clip: `${clip.x} ${clip.y} m ${clip.x + clip.width} ${clip.y} l ${clip.x + clip.width} ${clip.y + clip.height} l ${clip.x} ${clip.y + clip.height} l h` }, children: [child] };
  }
  return result;
}
export function buildMotion(document: DocumentIR, pageId: string, options: MotionOptions): AnimationResult {
  if (!Number.isSafeInteger(options.steps) || options.steps < 2) throw new Error("motion steps must be a safe integer of at least 2");
  if (options.objectIds.length === 0 || new Set(options.objectIds).size !== options.objectIds.length) throw new Error("motion requires unique target object IDs");
  if (![options.from.x, options.from.y, options.to.x, options.to.y].every(Number.isFinite)) throw new Error("motion poses must be finite");
  if (options.clip) assertBox(options.clip, "clip"); if (options.bbox?.kind === "explicit") assertBox(options.bbox.box, "explicit bbox");
  const strategy = options.strategy ?? "duplicate"; const copies = strategy === "duplicate" ? options.steps * options.objectIds.length : 0;
  const estimate = preflight(document, options.steps, copies, options.limits); const candidate = clone(document); const page = pageById(candidate, pageId); const used = usedIds(candidate); const base = visibleBase(page, options.sourceViewId); const legacyViews = [...page.views]; const originalObjects = [...page.objects];
  const requested = new Set(options.objectIds); for (const id of requested) if (!page.objects.some((candidate) => candidate.id === id)) throw new Error(`object '${id}' does not exist`);
  const sources = page.objects.filter((object) => requested.has(object.id));
  const diagnostics: AnimationDiagnostic[] = []; const layers: string[] = []; const views: View[] = []; const objects: IpeObject[] = []; const poses: Pose[] = [];
  if (strategy === "layer-transform") {
    const targetLayers = [...new Set(sources.map((object) => object.layerId))];
    if (targetLayers.some((id) => page.objects.some((object) => object.layerId === id && !options.objectIds.includes(object.id)))) diagnostics.push({ code: "LAYER_TRANSFORM_SHARED_LAYER", severity: "warning", message: "Layer transforms also move non-target objects on a shared layer; use duplicate variants for object-local motion." });
    diagnostics.push({ code: "LAYER_TRANSFORM_EXPERIMENTAL", severity: "warning", message: "Layer transforms are opt-in; links, hit testing, and viewer bbox behavior may degrade. Static views remain the fallback." });
    if (options.staticFallback === false) throw new Error("layer-transform motion requires the static fallback to remain enabled");
    for (let index = 0; index < options.steps; index += 1) { const t = easing(options.easing ?? "linear", index / (options.steps - 1)); const pose = { x: options.from.x + (options.to.x - options.from.x) * t, y: options.from.y + (options.to.y - options.from.y) * t }; poses.push(pose); const view = newView(page, used, `${pageId}/motion/view/${index}`, base.visible, base.active, `${options.name ?? "motion"}-${index}`); view.layerTransforms = Object.fromEntries(targetLayers.map((id) => [id, translationMatrix(pose.x, pose.y)])); views.push(view); }
  } else {
    const sourceLayers = new Set(sources.map((object) => object.layerId)); const always = base.visible.filter((id) => !sourceLayers.has(id) || page.objects.some((object) => object.layerId === id && !options.objectIds.includes(object.id)));
    const variantsBySource = new Map(sources.map((source) => [source.id, [] as IpeObject[]]));
    for (let index = 0; index < options.steps; index += 1) { const layerId = newLayer(page, used, `${pageId}/motion/layer/${index}`, `${options.name ?? "motion"}-${index}`); layers.push(layerId); const t = easing(options.easing ?? "linear", index / (options.steps - 1)); const pose = { x: options.from.x + (options.to.x - options.from.x) * t, y: options.from.y + (options.to.y - options.from.y) * t }; poses.push(pose); for (const source of sources) { const variant = cloneVariant(source, layerId, pose, used, `${pageId}/${source.id}/motion/${index}`, options.clip); objects.push(variant); variantsBySource.get(source.id)!.push(variant); } const visible = [...always, layerId]; views.push(newView(page, used, `${pageId}/motion/view/${index}`, visible, layerId, `${options.name ?? "motion"}-${index}`)); }
    const compatibilityLayers = new Map<string, string>();
    for (const source of sources) { const previousLayerId = source.layerId; let compatibilityLayerId = compatibilityLayers.get(previousLayerId); if (!compatibilityLayerId) { compatibilityLayerId = newLayer(page, used, `${pageId}/motion/legacy/${previousLayerId}`, `${options.name ?? "motion"}-legacy`); compatibilityLayers.set(previousLayerId, compatibilityLayerId); preserveLegacyVisibility(legacyViews, previousLayerId, compatibilityLayerId); } source.layerId = compatibilityLayerId; }
    page.objects = originalObjects.flatMap((object) => requested.has(object.id) ? [object, ...variantsBySource.get(object.id)!] : [object]);
  }
  materializeBbox(candidate, page, used, views, poses, options.bbox); renumber(page);
  if (options.bbox?.kind === "per-view") diagnostics.push({ code: "VIEWBBOX_PER_VIEW", severity: "info", message: "Each static state retains its own rendered content bounds; fixed-paper previews remain recommended for comparison." });
  if (options.bbox?.kind === "explicit") diagnostics.push({ code: "VIEWBBOX_EXPLICIT", severity: "info", message: `The caller-declared viewport is ${options.bbox.box.x},${options.bbox.box.y},${options.bbox.box.width},${options.bbox.box.height}.` });
  const profile = options.viewer === undefined ? undefined : VIEWER_MATRIX[options.viewer]; if (profile && profile.transitions !== "verified") diagnostics.push({ code: "VIEWER_STATIC_FALLBACK", severity: "warning", message: `${options.viewer}: ${profile.notes}` });
  setHandout(views, options.handout ?? "final"); commit(document, candidate);
  return { viewIds: views.map((view) => view.id), layerIds: layers, objectIds: objects.map((object) => object.id), estimate, diagnostics };
}

export interface PanelScrollOptions extends Omit<MotionOptions, "objectIds" | "from" | "to" | "clip"> { readonly objectId: string; readonly axis: "x" | "y"; readonly from: number; readonly to: number; readonly clip: AnimationBox; }
export function buildPanelScroll(document: DocumentIR, pageId: string, options: PanelScrollOptions): AnimationResult { const from = options.axis === "x" ? { x: options.from, y: 0 } : { x: 0, y: options.from }; const to = options.axis === "x" ? { x: options.to, y: 0 } : { x: 0, y: options.to }; return buildMotion(document, pageId, { ...options, objectIds: [options.objectId], from, to, strategy: "duplicate", bbox: options.bbox ?? { kind: "fixed" } }); }
export interface CameraPanOptions extends Omit<MotionOptions, "objectIds"> { readonly objectIds?: readonly string[]; readonly includeReservedLayers?: boolean; }
export function buildCameraPan(document: DocumentIR, pageId: string, options: CameraPanOptions): AnimationResult { const page = pageById(document, pageId); const fixed = new Set(["BACKGROUND", "BBOX", "VIEWBBOX"]); const objectIds = options.objectIds ?? page.objects.filter((object) => options.includeReservedLayers === true || !fixed.has(page.layers.find((layer) => layer.id === object.layerId)?.name ?? "")).map((object) => object.id); return buildMotion(document, pageId, { ...options, objectIds, bbox: options.bbox ?? { kind: "fixed" }, name: options.name ?? "camera-pan" }); }

export interface TransitionOptions { readonly effect: IpeEffect; readonly duration?: number; readonly transition?: number; readonly viewer?: AnimationViewer; }
export function setTransition(document: DocumentIR, pageId: string, viewIds: readonly string[], options: TransitionOptions): readonly AnimationDiagnostic[] {
  if (viewIds.length === 0) throw new Error("setTransition requires at least one view"); const duration = options.duration ?? 1; const transition = options.transition ?? 1;
  if (!Number.isFinite(duration) || duration < 0 || !Number.isSafeInteger(transition) || transition < 0) throw new Error("effect duration must be finite and non-negative and transition must be a non-negative integer");
  const candidate = clone(document); const page = pageById(candidate, pageId); const effectId = IPE_EFFECT_ID[options.effect]; const configuration = `${effectId}/${duration}/${transition}`; const effectName = `ipe-mcp-m7-${effectId}-${options.effect}-${createHash("sha256").update(configuration).digest("hex").slice(0, 12)}`;
  const styles = candidate.stylesheets ?? candidate.styles ?? []; let sheet = styles.find((style) => style.name === "ipe-mcp-m7-effects");
  if (!sheet) { sheet = { id: `style-${createHash("sha256").update("ipe-mcp/m7/effects").digest("hex").slice(0, 24)}`, name: "ipe-mcp-m7-effects", xml: { type: "element", name: "ipestyle", attributes: { name: "ipe-mcp-m7-effects" }, children: [] } }; if (candidate.stylesheets !== undefined || candidate.styles === undefined) candidate.stylesheets = [...styles, sheet]; else candidate.styles = [...styles, sheet]; }
  const children = (sheet.xml!.children ??= []); const existing = children.find((child): child is XmlElement => child.type === "element" && child.name === "effect" && child.attributes?.name === effectName);
  const attributes = { name: effectName, duration: String(duration), transition: String(transition), effect: String(effectId) }; if (!existing) children.push({ type: "element", name: "effect", attributes, children: [] });
  for (const viewId of viewIds) { const view = page.views.find((candidate) => candidate.id === viewId); if (!view) throw new Error(`view '${viewId}' does not exist`); view.transition = { effect: effectName }; }
  commit(document, candidate); const profile = options.viewer === undefined ? undefined : VIEWER_MATRIX[options.viewer]; return profile && profile.transitions !== "verified" ? [{ code: "VIEWER_EFFECT_UNVERIFIED", severity: "warning", message: `${options.viewer} transition status is '${profile.transitions}': ${profile.notes}` }] : [];
}
