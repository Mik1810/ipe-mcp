import type { DocumentIR } from "../domain/ir.js";
import type {
  AnimationDiagnostic,
  AnimationResult,
  ExpansionLimits,
  HandoutPolicy,
} from "./spec.js";
import {
  clone,
  commit,
  newLayer,
  newView,
  pageById,
  preflight,
  preserveLegacyVisibility,
  setHandout,
  usedIds,
  visibleBase,
} from "./state.js";

export type RevealTarget =
  | { readonly kind: "layer"; readonly id: string }
  | { readonly kind: "object"; readonly id: string };
export interface RevealOptions {
  readonly groups: readonly (readonly RevealTarget[])[];
  readonly cumulative?: boolean;
  readonly initialState?: "hidden" | "visible";
  readonly finalState?: "hidden" | "visible";
  readonly objectLayers?: "create" | "reuse";
  readonly sourceViewId?: string;
  readonly name?: string;
  readonly handout?: HandoutPolicy;
  readonly limits?: ExpansionLimits;
}
export function buildReveal(
  document: DocumentIR,
  pageId: string,
  options: RevealOptions,
): AnimationResult {
  if (
    options.groups.length === 0 ||
    options.groups.some((group) => group.length === 0)
  )
    throw new Error("reveal requires non-empty ordered groups");
  const targetCount = options.groups.reduce(
    (sum, group) => sum + group.length,
    0,
  );
  const estimate = preflight(
    document,
    options.groups.length + 2,
    0,
    options.limits,
  );
  const candidate = clone(document);
  const page = pageById(candidate, pageId);
  const used = usedIds(candidate);
  const base = visibleBase(page, options.sourceViewId);
  const legacyViews = [...page.views];
  const seen = new Set<string>();
  const groupLayers: string[][] = [];
  const createdLayers: string[] = [];
  const diagnostics: AnimationDiagnostic[] = [];
  for (const [groupIndex, group] of options.groups.entries()) {
    const layers: string[] = [];
    for (const target of group) {
      if (seen.has(`${target.kind}:${target.id}`))
        throw new Error(`reveal target '${target.id}' appears more than once`);
      seen.add(`${target.kind}:${target.id}`);
      if (target.kind === "layer") {
        if (!page.layers.some((layer) => layer.id === target.id))
          throw new Error(`layer '${target.id}' does not exist`);
        layers.push(target.id);
        continue;
      }
      const object = page.objects.find(
        (candidate) => candidate.id === target.id,
      );
      if (!object) throw new Error(`object '${target.id}' does not exist`);
      if ((options.objectLayers ?? "create") === "create") {
        const previousLayerId = object.layerId;
        const layerId = newLayer(
          page,
          used,
          `${pageId}/reveal/${groupIndex}/${target.id}`,
          `${options.name ?? "reveal"}-${groupIndex + 1}`,
        );
        object.layerId = layerId;
        preserveLegacyVisibility(legacyViews, previousLayerId, layerId);
        layers.push(layerId);
        createdLayers.push(layerId);
      } else {
        layers.push(object.layerId);
        diagnostics.push({
          code: "REVEAL_REUSED_OBJECT_LAYER",
          severity: "warning",
          message: `Object '${target.id}' shares reveal visibility with every object on its reused layer.`,
        });
      }
    }
    groupLayers.push([...new Set(layers)]);
  }
  const controlled = new Set(groupLayers.flat());
  const always = base.visible.filter((id) => !controlled.has(id));
  const initialVisible =
    options.initialState === "visible" ? groupLayers.flat() : [];
  const states: string[][] = [[...always, ...initialVisible]];
  let accumulated = [...initialVisible];
  for (const group of groupLayers) {
    accumulated =
      options.cumulative === false
        ? [...group]
        : [...new Set([...accumulated, ...group])];
    states.push([...always, ...accumulated]);
  }
  const finalLayers = options.finalState === "hidden" ? [] : groupLayers.flat();
  states.push([...always, ...finalLayers]);
  if (states.some((state) => state.length === 0)) {
    const neutral = newLayer(
      page,
      used,
      `${pageId}/reveal/neutral`,
      `${options.name ?? "reveal"}-neutral`,
    );
    createdLayers.push(neutral);
    states.forEach((state) => {
      if (state.length === 0) state.push(neutral);
    });
  }
  const views = states.map((layers, index) =>
    newView(
      page,
      used,
      `${pageId}/reveal/view/${index}`,
      layers,
      layers.includes(base.active) ? base.active : layers[0]!,
      `${options.name ?? "reveal"}-${index}`,
    ),
  );
  setHandout(views, options.handout ?? "final");
  commit(document, candidate);
  return {
    viewIds: views.map((view) => view.id),
    layerIds: createdLayers,
    objectIds: [],
    estimate,
    diagnostics: [
      ...diagnostics,
      {
        code: "DISCRETE_STATIC_STATES",
        severity: "info",
        message: `${targetCount} reveal targets compile to independently renderable views.`,
      },
    ],
  };
}
