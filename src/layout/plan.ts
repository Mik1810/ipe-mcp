import type { DocumentIR, Matrix } from "../domain/ir.js";
import { IDENTITY_MATRIX, preTransformObject, postTransformLocal } from "./matrix.js";

export interface PlannedTransform {
  readonly objectId: string;
  readonly matrix: Matrix;
  /** Page transforms pre-multiply; local transforms post-multiply. */
  readonly space: "page" | "local";
}

export interface LayoutPlan {
  readonly pageId: string;
  readonly transforms: readonly PlannedTransform[];
  readonly diagnostics: readonly string[];
}

export function createLayoutPlan(pageId: string, transforms: readonly PlannedTransform[]): LayoutPlan {
  const seen = new Set<string>();
  for (const transform of transforms) {
    if (seen.has(transform.objectId)) throw new Error(`layout plan writes object '${transform.objectId}' more than once`);
    seen.add(transform.objectId);
  }
  return { pageId, transforms: [...transforms], diagnostics: [] };
}

/** Validate the complete plan before changing the draft, preserving batch atomicity. */
export function applyLayoutPlan(document: DocumentIR, plan: LayoutPlan): void {
  if (plan.diagnostics.length > 0) throw new Error(`layout plan has diagnostics: ${plan.diagnostics.join("; ")}`);
  const written = new Set<string>();
  for (const transform of plan.transforms) {
    if (written.has(transform.objectId)) throw new Error(`layout plan writes object '${transform.objectId}' more than once`);
    written.add(transform.objectId);
  }
  const page = document.pages.find((candidate) => candidate.id === plan.pageId);
  if (!page) throw new Error(`layout page '${plan.pageId}' does not exist`);
  const byId = new Map(page.objects.map((object) => [object.id, object]));
  const updates = plan.transforms.map((transform) => {
    const object = byId.get(transform.objectId);
    if (!object) throw new Error(`layout object '${transform.objectId}' does not exist on page '${plan.pageId}'`);
    const current = object.matrix ?? IDENTITY_MATRIX;
    const matrix = transform.space === "page"
      ? preTransformObject(current, transform.matrix)
      : postTransformLocal(current, transform.matrix);
    return { object, matrix };
  });
  for (const update of updates) update.object.matrix = update.matrix;
}
