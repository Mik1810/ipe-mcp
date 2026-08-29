import { createHash } from "node:crypto";

import type {
  DocumentIR,
  IpeObject,
  Matrix,
  Page,
  View,
} from "../domain/ir.js";
import { objectIdFromCustom } from "../domain/identity.js";
import { validateDocument } from "../domain/validate.js";
import { resolvePageCoordinateSystem } from "../layout/ipe-layout.js";
import {
  IDENTITY_MATRIX,
  multiplyMatrices,
  translationMatrix,
} from "../layout/matrix.js";
import { ANIMATION_DEFAULT_LIMITS } from "../limits.js";
import type {
  AnimationBox,
  BboxPolicy,
  ExpansionEstimate,
  ExpansionLimits,
  HandoutPolicy,
  Pose,
  SemanticEasing,
} from "./spec.js";

const DEFAULT_LIMITS = ANIMATION_DEFAULT_LIMITS;
export const clone = <T>(value: T): T => structuredClone(value);
const digest = (kind: "layer" | "view", seed: string, salt: number) =>
  `${kind}-${createHash("sha256").update(`ipe-mcp/m7/${kind}/${seed}/${salt}`).digest("hex").slice(0, 24)}`;
export const usedIds = (document: DocumentIR) =>
  new Set(
    document.pages.flatMap((page) => [
      page.id,
      ...page.layers.map((item) => item.id),
      ...page.views.map((item) => item.id),
      ...page.objects.map((item) => item.id),
    ]),
  );
function freshEntity(
  kind: "layer" | "view",
  seed: string,
  used: Set<string>,
): string {
  let salt = 0;
  let id = digest(kind, seed, salt);
  while (used.has(id)) id = digest(kind, seed, ++salt);
  used.add(id);
  return id;
}
export function freshObject(
  seed: string,
  used: Set<string>,
): { id: string; custom: string } {
  let salt = 0;
  let custom = `ipe-mcp:m7:${createHash("sha256").update(`${seed}/${salt}`).digest("hex")}`;
  let id = objectIdFromCustom(custom);
  while (used.has(id)) {
    custom = `ipe-mcp:m7:${createHash("sha256").update(`${seed}/${++salt}`).digest("hex")}`;
    id = objectIdFromCustom(custom);
  }
  used.add(id);
  return { id, custom };
}
export function pageById(document: DocumentIR, pageId: string): Page {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`page '${pageId}' does not exist`);
  return page;
}
function uniqueLayerName(page: Page, desired: string): string {
  const names = new Set(page.layers.map((layer) => layer.name));
  if (!names.has(desired)) return desired;
  let suffix = 2;
  while (names.has(`${desired}-${suffix}`)) suffix += 1;
  return `${desired}-${suffix}`;
}
function countPdfPages(document: DocumentIR): number {
  return document.pages.reduce(
    (sum, page) => sum + Math.max(1, page.views.length),
    0,
  );
}
export function assertBox(box: AnimationBox, label: string): void {
  if (
    ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
    box.width <= 0 ||
    box.height <= 0
  )
    throw new Error(`${label} must be a finite positive rectangle`);
}
export function preflight(
  document: DocumentIR,
  generatedViews: number,
  generatedCopies: number,
  limits: ExpansionLimits = {},
): ExpansionEstimate {
  if (
    !Number.isSafeInteger(generatedViews) ||
    generatedViews < 1 ||
    !Number.isSafeInteger(generatedCopies) ||
    generatedCopies < 0
  )
    throw new Error(
      "animation expansion counts must be non-negative safe integers",
    );
  const estimate = {
    generatedViews,
    generatedCopies,
    resultingPdfPages: countPdfPages(document) + generatedViews,
  };
  const effective = { ...DEFAULT_LIMITS, ...limits } as Required<ExpansionLimits>;
  for (const value of Object.values(effective))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("animation limits must be positive safe integers");
  if (estimate.generatedViews > effective.maxGeneratedViews)
    throw new Error(
      `animation would generate ${estimate.generatedViews} views (limit ${effective.maxGeneratedViews})`,
    );
  if (estimate.generatedCopies > effective.maxGeneratedCopies)
    throw new Error(
      `animation would generate ${estimate.generatedCopies} copies (limit ${effective.maxGeneratedCopies})`,
    );
  if (estimate.resultingPdfPages > effective.maxPdfPages)
    throw new Error(
      `animation would expand the PDF to ${estimate.resultingPdfPages} pages (limit ${effective.maxPdfPages})`,
    );
  return estimate;
}
export function estimateAnimationExpansion(
  document: DocumentIR,
  generatedViews: number,
  generatedCopies: number,
): ExpansionEstimate {
  return preflight(document, generatedViews, generatedCopies, {
    maxGeneratedViews: Number.MAX_SAFE_INTEGER,
    maxGeneratedCopies: Number.MAX_SAFE_INTEGER,
    maxPdfPages: Number.MAX_SAFE_INTEGER,
  });
}
export function commit(document: DocumentIR, candidate: DocumentIR): void {
  const result = validateDocument(candidate);
  if (!result.ok)
    throw new Error(
      result.errors.map((item) => `${item.code}: ${item.message}`).join("; "),
    );
  for (const key of Object.keys(document) as (keyof DocumentIR)[])
    delete document[key];
  Object.assign(document, candidate);
}
export function setHandout(views: View[], policy: HandoutPolicy): void {
  views.forEach((view, index) => {
    view.marked =
      policy === "all" ||
      (policy === "final" && index === views.length - 1) ||
      (policy === "initial-and-final" &&
        (index === 0 || index === views.length - 1));
  });
}
export function easing(kind: SemanticEasing, t: number): number {
  if (kind === "ease-in") return t * t;
  if (kind === "ease-out") return 1 - (1 - t) ** 2;
  if (kind === "ease-in-out")
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  return t;
}
export function translated(matrix: Matrix | undefined, pose: Pose): Matrix {
  return multiplyMatrices(
    translationMatrix(pose.x, pose.y),
    matrix ?? IDENTITY_MATRIX,
  );
}
export function renumber(page: Page): void {
  page.objects.forEach((object, index) => {
    object.zOrder = index;
  });
}
export function visibleBase(
  page: Page,
  sourceViewId?: string,
): { visible: string[]; active: string } {
  const source =
    sourceViewId === undefined
      ? page.views.at(-1)
      : page.views.find((view) => view.id === sourceViewId);
  if (!source) throw new Error(`source view '${sourceViewId}' does not exist`);
  return { visible: [...source.visibleLayerIds], active: source.activeLayerId };
}
export function newLayer(
  page: Page,
  used: Set<string>,
  seed: string,
  desired: string,
  intentional = false,
): string {
  const id = freshEntity("layer", seed, used);
  page.layers.push({
    id,
    name: uniqueLayerName(page, desired),
    ...(intentional ? { intentional: true } : {}),
  });
  return id;
}
export function newView(
  page: Page,
  used: Set<string>,
  seed: string,
  visibleLayerIds: readonly string[],
  activeLayerId: string,
  name: string,
): View {
  const view: View = {
    id: freshEntity("view", seed, used),
    name,
    visibleLayerIds: [...new Set(visibleLayerIds)],
    activeLayerId,
    marked: false,
  };
  page.views.push(view);
  return view;
}
export function preserveLegacyVisibility(
  views: readonly View[],
  previousLayerId: string,
  compatibilityLayerId: string,
): void {
  for (const view of views)
    if (view.visibleLayerIds.includes(previousLayerId))
      view.visibleLayerIds = [...view.visibleLayerIds, compatibilityLayerId];
}
function rectangleObject(
  layerId: string,
  box: AnimationBox,
  used: Set<string>,
  seed: string,
): IpeObject {
  const identity = freshObject(seed, used);
  const x2 = box.x + box.width;
  const y2 = box.y + box.height;
  return {
    id: identity.id,
    custom: identity.custom,
    layerId,
    zOrder: 0,
    xml: {
      type: "element",
      name: "path",
      attributes: {},
      children: [
        {
          type: "text",
          text: `${box.x} ${box.y} m ${x2} ${box.y} l ${x2} ${y2} l ${box.x} ${y2} l h`,
        },
      ],
    },
  };
}
export function materializeBbox(
  document: DocumentIR,
  page: Page,
  used: Set<string>,
  views: readonly View[],
  poses: readonly Pose[],
  policy: BboxPolicy | undefined,
): void {
  if (policy === undefined) return;
  const layerName = policy.kind === "per-view" ? "VIEWBBOX" : "BBOX";
  let layer = page.layers.find((candidate) => candidate.name === layerName);
  if (!layer) {
    const id = newLayer(
      page,
      used,
      `${page.id}/bbox/${layerName}`,
      layerName,
      true,
    );
    layer = page.layers.find((candidate) => candidate.id === id)!;
  }
  layer.intentional = true;
  const existingGeometry = page.objects.some(
    (object) => object.layerId === layer!.id,
  );
  if (!existingGeometry) {
    const frame = resolvePageCoordinateSystem(document).frame;
    const box = policy.kind === "explicit" ? policy.box : frame;
    page.objects.push(
      rectangleObject(
        layer.id,
        box,
        used,
        `${page.id}/bbox/${layerName}/geometry`,
      ),
    );
  }
  for (const [index, view] of views.entries()) {
    if (!view.visibleLayerIds.includes(layer.id))
      view.visibleLayerIds.push(layer.id);
    if (policy.kind === "per-view")
      view.layerTransforms = {
        ...(view.layerTransforms ?? {}),
        [layer.id]: translationMatrix(poses[index]!.x, poses[index]!.y),
      };
  }
}
