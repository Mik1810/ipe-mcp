import { createHash } from "node:crypto";

import type { DocumentIR } from "../domain/ir.js";
import type { XmlElement } from "../domain/xml-node.js";
import { IPE_EFFECT_ID, VIEWER_MATRIX } from "./spec.js";
import type { AnimationDiagnostic, AnimationViewer, IpeEffect } from "./spec.js";
import { clone, commit, pageById } from "./state.js";

export interface TransitionOptions {
  readonly effect: IpeEffect;
  readonly duration?: number;
  readonly transition?: number;
  readonly viewer?: AnimationViewer;
}
export function setTransition(
  document: DocumentIR,
  pageId: string,
  viewIds: readonly string[],
  options: TransitionOptions,
): readonly AnimationDiagnostic[] {
  if (viewIds.length === 0)
    throw new Error("setTransition requires at least one view");
  const duration = options.duration ?? 1;
  const transition = options.transition ?? 1;
  if (
    !Number.isFinite(duration) ||
    duration < 0 ||
    !Number.isSafeInteger(transition) ||
    transition < 0
  )
    throw new Error(
      "effect duration must be finite and non-negative and transition must be a non-negative integer",
    );
  const candidate = clone(document);
  const page = pageById(candidate, pageId);
  const effectId = IPE_EFFECT_ID[options.effect];
  const configuration = `${effectId}/${duration}/${transition}`;
  const effectName = `ipe-mcp-m7-${effectId}-${options.effect}-${createHash("sha256").update(configuration).digest("hex").slice(0, 12)}`;
  const styles = candidate.stylesheets ?? candidate.styles ?? [];
  let sheet = styles.find((style) => style.name === "ipe-mcp-m7-effects");
  if (!sheet) {
    sheet = {
      id: `style-${createHash("sha256").update("ipe-mcp/m7/effects").digest("hex").slice(0, 24)}`,
      name: "ipe-mcp-m7-effects",
      xml: {
        type: "element",
        name: "ipestyle",
        attributes: { name: "ipe-mcp-m7-effects" },
        children: [],
      },
    };
    if (candidate.stylesheets !== undefined || candidate.styles === undefined)
      candidate.stylesheets = [...styles, sheet];
    else candidate.styles = [...styles, sheet];
  }
  const children = (sheet.xml!.children ??= []);
  const existing = children.find(
    (child): child is XmlElement =>
      child.type === "element" &&
      child.name === "effect" &&
      child.attributes?.name === effectName,
  );
  const attributes = {
    name: effectName,
    duration: String(duration),
    transition: String(transition),
    effect: String(effectId),
  };
  if (!existing)
    children.push({
      type: "element",
      name: "effect",
      attributes,
      children: [],
    });
  for (const viewId of viewIds) {
    const view = page.views.find((candidate) => candidate.id === viewId);
    if (!view) throw new Error(`view '${viewId}' does not exist`);
    view.transition = { effect: effectName };
  }
  commit(document, candidate);
  const profile =
    options.viewer === undefined ? undefined : VIEWER_MATRIX[options.viewer];
  return profile && profile.transitions !== "verified"
    ? [
        {
          code: "VIEWER_EFFECT_UNVERIFIED",
          severity: "warning",
          message: `${options.viewer} transition status is '${profile.transitions}': ${profile.notes}`,
        },
      ]
    : [];
}
