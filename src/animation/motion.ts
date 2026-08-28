import type { DocumentIR, IpeObject, View } from "../domain/ir.js";
import { translationMatrix } from "../layout/matrix.js";
import { matrixText } from "../objects/common.js";
import { VIEWER_MATRIX } from "./spec.js";
import type {
  AnimationBox,
  AnimationDiagnostic,
  AnimationResult,
  AnimationViewer,
  BboxPolicy,
  ExpansionLimits,
  HandoutPolicy,
  Pose,
  SemanticEasing,
} from "./spec.js";
import {
  assertBox,
  clone,
  commit,
  easing,
  freshObject,
  materializeBbox,
  newLayer,
  newView,
  pageById,
  preflight,
  preserveLegacyVisibility,
  renumber,
  setHandout,
  translated,
  usedIds,
  visibleBase,
} from "./state.js";

export interface MotionOptions {
  readonly objectIds: readonly string[];
  readonly from: Pose;
  readonly to: Pose;
  readonly steps: number;
  readonly easing?: SemanticEasing;
  readonly strategy?: "duplicate" | "layer-transform";
  readonly sourceViewId?: string;
  readonly name?: string;
  readonly handout?: HandoutPolicy;
  readonly bbox?: BboxPolicy;
  readonly viewer?: AnimationViewer;
  readonly staticFallback?: boolean;
  readonly limits?: ExpansionLimits;
  readonly clip?: AnimationBox;
}
function cloneVariant(
  source: IpeObject,
  layerId: string,
  pose: Pose,
  used: Set<string>,
  seed: string,
  clip?: AnimationBox,
): IpeObject {
  const identity = freshObject(seed, used);
  const result = clone(source);
  result.id = identity.id;
  result.custom = identity.custom;
  result.layerId = layerId;
  if (clip === undefined) result.matrix = translated(source.matrix, pose);
  else {
    const child = clone(source.xml!);
    const attributes = (child.attributes ??= {});
    delete attributes.layer;
    delete attributes["x-ipe-mcp-id"];
    attributes.matrix = matrixText(translated(source.matrix, pose));
    delete result.matrix;
    result.xml = {
      type: "element",
      name: "group",
      attributes: {
        custom: identity.custom,
        "x-ipe-mcp-id": identity.id,
        clip: `${clip.x} ${clip.y} m ${clip.x + clip.width} ${clip.y} l ${clip.x + clip.width} ${clip.y + clip.height} l ${clip.x} ${clip.y + clip.height} l h`,
      },
      children: [child],
    };
  }
  return result;
}
export function buildMotion(
  document: DocumentIR,
  pageId: string,
  options: MotionOptions,
): AnimationResult {
  if (!Number.isSafeInteger(options.steps) || options.steps < 2)
    throw new Error("motion steps must be a safe integer of at least 2");
  if (
    options.objectIds.length === 0 ||
    new Set(options.objectIds).size !== options.objectIds.length
  )
    throw new Error("motion requires unique target object IDs");
  if (
    ![options.from.x, options.from.y, options.to.x, options.to.y].every(
      Number.isFinite,
    )
  )
    throw new Error("motion poses must be finite");
  if (options.clip) assertBox(options.clip, "clip");
  if (options.bbox?.kind === "explicit")
    assertBox(options.bbox.box, "explicit bbox");
  const strategy = options.strategy ?? "duplicate";
  const copies =
    strategy === "duplicate" ? options.steps * options.objectIds.length : 0;
  const estimate = preflight(document, options.steps, copies, options.limits);
  const candidate = clone(document);
  const page = pageById(candidate, pageId);
  const used = usedIds(candidate);
  const base = visibleBase(page, options.sourceViewId);
  const legacyViews = [...page.views];
  const originalObjects = [...page.objects];
  const requested = new Set(options.objectIds);
  for (const id of requested)
    if (!page.objects.some((candidate) => candidate.id === id))
      throw new Error(`object '${id}' does not exist`);
  const sources = page.objects.filter((object) => requested.has(object.id));
  const diagnostics: AnimationDiagnostic[] = [];
  const layers: string[] = [];
  const views: View[] = [];
  const objects: IpeObject[] = [];
  const poses: Pose[] = [];
  if (strategy === "layer-transform") {
    const targetLayers = [...new Set(sources.map((object) => object.layerId))];
    if (
      targetLayers.some((id) =>
        page.objects.some(
          (object) =>
            object.layerId === id && !options.objectIds.includes(object.id),
        ),
      )
    )
      diagnostics.push({
        code: "LAYER_TRANSFORM_SHARED_LAYER",
        severity: "warning",
        message:
          "Layer transforms also move non-target objects on a shared layer; use duplicate variants for object-local motion.",
      });
    diagnostics.push({
      code: "LAYER_TRANSFORM_EXPERIMENTAL",
      severity: "warning",
      message:
        "Layer transforms are opt-in; links, hit testing, and viewer bbox behavior may degrade. Static views remain the fallback.",
    });
    if (options.staticFallback === false)
      throw new Error(
        "layer-transform motion requires the static fallback to remain enabled",
      );
    for (let index = 0; index < options.steps; index += 1) {
      const t = easing(options.easing ?? "linear", index / (options.steps - 1));
      const pose = {
        x: options.from.x + (options.to.x - options.from.x) * t,
        y: options.from.y + (options.to.y - options.from.y) * t,
      };
      poses.push(pose);
      const view = newView(
        page,
        used,
        `${pageId}/motion/view/${index}`,
        base.visible,
        base.active,
        `${options.name ?? "motion"}-${index}`,
      );
      view.layerTransforms = Object.fromEntries(
        targetLayers.map((id) => [id, translationMatrix(pose.x, pose.y)]),
      );
      views.push(view);
    }
  } else {
    const sourceLayers = new Set(sources.map((object) => object.layerId));
    const always = base.visible.filter(
      (id) =>
        !sourceLayers.has(id) ||
        page.objects.some(
          (object) =>
            object.layerId === id && !options.objectIds.includes(object.id),
        ),
    );
    const variantsBySource = new Map(
      sources.map((source) => [source.id, [] as IpeObject[]]),
    );
    for (let index = 0; index < options.steps; index += 1) {
      const layerId = newLayer(
        page,
        used,
        `${pageId}/motion/layer/${index}`,
        `${options.name ?? "motion"}-${index}`,
      );
      layers.push(layerId);
      const t = easing(options.easing ?? "linear", index / (options.steps - 1));
      const pose = {
        x: options.from.x + (options.to.x - options.from.x) * t,
        y: options.from.y + (options.to.y - options.from.y) * t,
      };
      poses.push(pose);
      for (const source of sources) {
        const variant = cloneVariant(
          source,
          layerId,
          pose,
          used,
          `${pageId}/${source.id}/motion/${index}`,
          options.clip,
        );
        objects.push(variant);
        variantsBySource.get(source.id)!.push(variant);
      }
      const visible = [...always, layerId];
      views.push(
        newView(
          page,
          used,
          `${pageId}/motion/view/${index}`,
          visible,
          layerId,
          `${options.name ?? "motion"}-${index}`,
        ),
      );
    }
    const compatibilityLayers = new Map<string, string>();
    for (const source of sources) {
      const previousLayerId = source.layerId;
      let compatibilityLayerId = compatibilityLayers.get(previousLayerId);
      if (!compatibilityLayerId) {
        compatibilityLayerId = newLayer(
          page,
          used,
          `${pageId}/motion/legacy/${previousLayerId}`,
          `${options.name ?? "motion"}-legacy`,
        );
        compatibilityLayers.set(previousLayerId, compatibilityLayerId);
        preserveLegacyVisibility(
          legacyViews,
          previousLayerId,
          compatibilityLayerId,
        );
      }
      source.layerId = compatibilityLayerId;
    }
    page.objects = originalObjects.flatMap((object) =>
      requested.has(object.id)
        ? [object, ...variantsBySource.get(object.id)!]
        : [object],
    );
  }
  materializeBbox(candidate, page, used, views, poses, options.bbox);
  renumber(page);
  if (options.bbox?.kind === "per-view")
    diagnostics.push({
      code: "VIEWBBOX_PER_VIEW",
      severity: "info",
      message:
        "Each static state retains its own rendered content bounds; fixed-paper previews remain recommended for comparison.",
    });
  if (options.bbox?.kind === "explicit")
    diagnostics.push({
      code: "VIEWBBOX_EXPLICIT",
      severity: "info",
      message: `The caller-declared viewport is ${options.bbox.box.x},${options.bbox.box.y},${options.bbox.box.width},${options.bbox.box.height}.`,
    });
  const profile =
    options.viewer === undefined ? undefined : VIEWER_MATRIX[options.viewer];
  if (profile && profile.transitions !== "verified")
    diagnostics.push({
      code: "VIEWER_STATIC_FALLBACK",
      severity: "warning",
      message: `${options.viewer}: ${profile.notes}`,
    });
  setHandout(views, options.handout ?? "final");
  commit(document, candidate);
  return {
    viewIds: views.map((view) => view.id),
    layerIds: layers,
    objectIds: objects.map((object) => object.id),
    estimate,
    diagnostics,
  };
}

export interface PanelScrollOptions extends Omit<
  MotionOptions,
  "objectIds" | "from" | "to" | "clip"
> {
  readonly objectId: string;
  readonly axis: "x" | "y";
  readonly from: number;
  readonly to: number;
  readonly clip: AnimationBox;
}
export function buildPanelScroll(
  document: DocumentIR,
  pageId: string,
  options: PanelScrollOptions,
): AnimationResult {
  const from =
    options.axis === "x"
      ? { x: options.from, y: 0 }
      : { x: 0, y: options.from };
  const to =
    options.axis === "x" ? { x: options.to, y: 0 } : { x: 0, y: options.to };
  return buildMotion(document, pageId, {
    ...options,
    objectIds: [options.objectId],
    from,
    to,
    strategy: "duplicate",
    bbox: options.bbox ?? { kind: "fixed" },
  });
}
export interface CameraPanOptions extends Omit<MotionOptions, "objectIds"> {
  readonly objectIds?: readonly string[];
  readonly includeReservedLayers?: boolean;
}
export function buildCameraPan(
  document: DocumentIR,
  pageId: string,
  options: CameraPanOptions,
): AnimationResult {
  const page = pageById(document, pageId);
  const fixed = new Set(["BACKGROUND", "BBOX", "VIEWBBOX"]);
  const objectIds =
    options.objectIds ??
    page.objects
      .filter(
        (object) =>
          options.includeReservedLayers === true ||
          !fixed.has(
            page.layers.find((layer) => layer.id === object.layerId)?.name ??
              "",
          ),
      )
      .map((object) => object.id);
  return buildMotion(document, pageId, {
    ...options,
    objectIds,
    bbox: options.bbox ?? { kind: "fixed" },
    name: options.name ?? "camera-pan",
  });
}
