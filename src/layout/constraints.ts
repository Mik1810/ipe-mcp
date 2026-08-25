import { z } from "zod";

import { MAX_DOMAIN_MAGNITUDE } from "../domain/numeric.js";
import type { SidecarV1 } from "../persistence/sidecar.js";
import { type Box, type BoundsResult, assertBox, assertFiniteNumber } from "./geometry.js";
import type { Placement } from "./layout.js";

export const LAYOUT_SIDECAR_KEY = "ipe-mcp.layout.v1";

const id = z.string().min(1).max(256);
const finite = z.number().finite().min(-MAX_DOMAIN_MAGNITUDE).max(MAX_DOMAIN_MAGNITUDE);
const boxKind = z.enum(["logical", "geometric", "visual"]);
const anchor = z.enum([
  "top-left", "top", "top-right", "left", "center", "right",
  "bottom-left", "bottom", "bottom-right", "baseline-left", "auto",
]);

const common = { id, subjectId: id, referenceId: id };
export const layoutConstraintV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("right-of"), gap: finite.nonnegative().default(0) }),
  z.strictObject({ ...common, kind: z.literal("below"), gap: finite.nonnegative().default(0) }),
  z.strictObject({ ...common, kind: z.literal("same-width") }),
  z.strictObject({ ...common, kind: z.literal("align-baseline") }),
]);

const endpointSchema = z.strictObject({
  objectId: id,
  anchor,
  boxKind,
  offset: z.strictObject({ x: finite, y: finite }).optional(),
}).refine((endpoint) => endpoint.anchor !== "baseline-left" || endpoint.boxKind === "logical", {
  message: "baseline-left connector anchors require logical bounds",
  path: ["boxKind"],
});
const connectorSchema = z.strictObject({
  id,
  from: endpointSchema,
  to: endpointSchema,
  routing: z.enum(["straight", "orthogonal"]),
  tieBreak: z.enum(["horizontal-first", "vertical-first"]).optional(),
}).refine((intent) => intent.from.objectId !== intent.to.objectId, "connector endpoints must reference distinct objects");

export const layoutSidecarV1Schema = z.strictObject({
  constraints: z.array(layoutConstraintV1Schema).max(10_000),
  connectors: z.array(connectorSchema).max(10_000),
  lastApplied: z.strictObject({
    revision: z.number().int().nonnegative(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  }).optional(),
}).superRefine((layout, context) => {
  for (const [field, entries] of [["constraints", layout.constraints], ["connectors", layout.connectors]] as const) {
    const ids = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (ids.has(entry.id)) context.addIssue({ code: "custom", message: `duplicate ${field} ID '${entry.id}'`, path: [field, index, "id"] });
      ids.add(entry.id);
    }
  }
});

export type LayoutConstraintV1 = z.infer<typeof layoutConstraintV1Schema>;
export type LayoutSidecarV1 = z.infer<typeof layoutSidecarV1Schema>;

export function readLayoutSidecar(sidecar: SidecarV1): LayoutSidecarV1 | undefined {
  const value = sidecar.layoutConstraints[LAYOUT_SIDECAR_KEY];
  return value === undefined ? undefined : layoutSidecarV1Schema.parse(value) as LayoutSidecarV1;
}

export function withLayoutSidecar(sidecar: SidecarV1, layout: LayoutSidecarV1): SidecarV1 {
  const validated = layoutSidecarV1Schema.parse(layout);
  return { ...sidecar, layoutConstraints: { ...sidecar.layoutConstraints, [LAYOUT_SIDECAR_KEY]: validated } };
}

export function assertLayoutSidecarFresh(
  layout: LayoutSidecarV1,
  revision: number,
  sourceHash: string,
  inputFingerprint: string,
): void {
  if (!layout.lastApplied) return;
  if (layout.lastApplied.revision !== revision
    || layout.lastApplied.sourceHash !== sourceHash
    || layout.lastApplied.inputFingerprint !== inputFingerprint) {
    throw new Error("layout sidecar is stale for the current revision, source hash or input fingerprint");
  }
}

interface KnownBounds {
  box: Box;
  baselineFromBottom?: number;
}

function knownBounds(results: ReadonlyMap<string, BoundsResult>, objectId: string): KnownBounds {
  const result = results.get(objectId);
  if (!result) throw new Error(`constraint object '${objectId}' is missing`);
  if (result.status === "deferred") throw new Error(`constraint object '${objectId}' bounds are deferred: ${result.reason}`);
  assertBox(result.boxes.logical, `constraint object '${objectId}' logical bounds`);
  if (result.baselineFromBottom !== undefined) {
    assertFiniteNumber(result.baselineFromBottom, `constraint object '${objectId}' baseline`);
    if (result.baselineFromBottom < 0 || result.baselineFromBottom > result.boxes.logical.height) {
      throw new Error(`constraint object '${objectId}' baseline lies outside logical bounds`);
    }
  }
  return result.baselineFromBottom === undefined
    ? { box: { ...result.boxes.logical } }
    : { box: { ...result.boxes.logical }, baselineFromBottom: result.baselineFromBottom };
}

/** Resolve the deliberately small, one-way M3 constraint language as one atomic plan. */
export function resolveLayoutConstraints(
  constraints: readonly LayoutConstraintV1[],
  results: ReadonlyMap<string, BoundsResult>,
): Placement[] {
  if (constraints.length > 10_000) throw new Error("layout constraint limit of 10000 exceeded");
  const parsed = constraints.map((constraint) => layoutConstraintV1Schema.parse(constraint));
  const state = new Map<string, KnownBounds>();
  for (const constraint of parsed) {
    if (!state.has(constraint.subjectId)) state.set(constraint.subjectId, knownBounds(results, constraint.subjectId));
    if (!state.has(constraint.referenceId)) state.set(constraint.referenceId, knownBounds(results, constraint.referenceId));
    if (constraint.subjectId === constraint.referenceId) throw new Error(`constraint '${constraint.id}' cannot reference itself`);
  }

  const writers = new Set<string>();
  const constraintIds = new Set<string>();
  for (const constraint of parsed) {
    if (constraintIds.has(constraint.id)) throw new Error(`duplicate constraint ID '${constraint.id}'`);
    constraintIds.add(constraint.id);
    const axis = constraint.kind === "same-width" ? "width" : constraint.kind === "right-of" ? "x" : "y";
    const key = `${constraint.subjectId}:${axis}`;
    if (writers.has(key)) throw new Error(`multiple constraints write '${key}'`);
    writers.add(key);
  }

  type BoxProperty = "x" | "y" | "width" | "height";
  const writtenProperty = (constraint: LayoutConstraintV1): BoxProperty => constraint.kind === "right-of"
    ? "x" : constraint.kind === "same-width" ? "width" : "y";
  const referenceProperties = (constraint: LayoutConstraintV1): readonly BoxProperty[] => constraint.kind === "right-of"
    ? ["x", "width"] : constraint.kind === "same-width" ? ["width"] : ["y", "height"];
  const bySubject = new Map<string, number[]>();
  for (const [index, constraint] of parsed.entries()) {
    const entries = bySubject.get(constraint.subjectId) ?? [];
    entries.push(index);
    bySubject.set(constraint.subjectId, entries);
  }
  const indegree = Array.from({ length: parsed.length }, () => 0);
  const dependents = Array.from({ length: parsed.length }, () => [] as number[]);
  for (const [index, constraint] of parsed.entries()) {
    for (const dependency of bySubject.get(constraint.referenceId) ?? []) {
      if (!referenceProperties(constraint).includes(writtenProperty(parsed[dependency]!))) continue;
      indegree[index]! += 1;
      dependents[dependency]!.push(index);
    }
  }
  const ready: number[] = [];
  for (const [index, degree] of indegree.entries()) if (degree === 0) ready.push(index);
  let cursor = 0;
  while (cursor < ready.length) {
    const index = ready[cursor++]!;
    const constraint = parsed[index]!;
    const subject = state.get(constraint.subjectId)!;
    const reference = state.get(constraint.referenceId)!;
    switch (constraint.kind) {
      case "right-of":
        assertFiniteNumber(constraint.gap, "constraint gap");
        subject.box = { ...subject.box, x: reference.box.x + reference.box.width + constraint.gap };
        break;
      case "below":
        assertFiniteNumber(constraint.gap, "constraint gap");
        subject.box = { ...subject.box, y: reference.box.y - constraint.gap - subject.box.height };
        break;
      case "same-width":
        subject.box = { ...subject.box, width: reference.box.width };
        break;
      case "align-baseline":
        if (subject.baselineFromBottom === undefined || reference.baselineFromBottom === undefined) {
          throw new Error(`constraint '${constraint.id}' requires known baselines`);
        }
        subject.box = {
          ...subject.box,
          y: reference.box.y + reference.baselineFromBottom - subject.baselineFromBottom,
        };
        break;
    }
    assertBox(subject.box, `constraint '${constraint.id}' result`);
    for (const dependent of dependents[index]!) {
      indegree[dependent]! -= 1;
      if (indegree[dependent] === 0) ready.push(dependent);
    }
  }
  if (ready.length !== parsed.length) throw new Error("layout constraints contain a dependency cycle");
  return [...state].map(([objectId, value]) => ({ id: objectId, box: value.box }));
}
