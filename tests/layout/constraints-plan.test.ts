import { describe, expect, it } from "vitest";

import type { DocumentIR } from "../../src/domain/ir.js";
import type { SidecarV1 } from "../../src/persistence/sidecar.js";
import {
  applyLayoutPlan,
  assertLayoutSidecarFresh,
  createLayoutPlan,
  readLayoutSidecar,
  resolveLayoutConstraints,
  resolveConnectorIntent,
  routeConnector,
  translationMatrix,
  withLayoutSidecar,
  type BoundsResult,
  type LayoutSidecarV1,
} from "../../src/layout/index.js";

const known = (x: number, y: number, width: number, height: number, baselineFromBottom?: number): BoundsResult => ({
  status: "known",
  boxes: {
    logical: { x, y, width, height }, geometric: { x, y, width, height }, visual: { x, y, width, height },
  },
  ...(baselineFromBottom === undefined ? {} : { baselineFromBottom }),
});

describe("M3 constraint sidecar", () => {
  const hashes = { sourceHash: "a".repeat(64), inputFingerprint: "b".repeat(64) };
  const layout: LayoutSidecarV1 = {
    constraints: [{ id: "c1", kind: "right-of", subjectId: "a", referenceId: "b", gap: 5 }],
    connectors: [{
      id: "edge", routing: "orthogonal", tieBreak: "vertical-first",
      from: { objectId: "a", anchor: "auto", boxKind: "visual" },
      to: { objectId: "b", anchor: "left", boxKind: "geometric" },
    }],
    lastApplied: { revision: 3, ...hashes },
  };
  const sidecar: SidecarV1 = {
    schemaVersion: 1, documentId: "doc", sourceHash: hashes.sourceHash, revision: 3,
    objectMetadata: {}, layoutConstraints: {},
  };

  it("round-trips its namespaced payload without narrowing unrelated keys", () => {
    const extended = { ...sidecar, layoutConstraints: { "other.writer": { keep: true } } };
    const stored = withLayoutSidecar(extended, layout);
    expect(stored.layoutConstraints["other.writer"]).toEqual({ keep: true });
    expect(readLayoutSidecar(stored)).toEqual(layout);
    expect(() => assertLayoutSidecarFresh(layout, 3, hashes.sourceHash, hashes.inputFingerprint)).not.toThrow();
    expect(() => assertLayoutSidecarFresh(layout, 4, hashes.sourceHash, hashes.inputFingerprint)).toThrow(/stale/u);
    expect(() => assertLayoutSidecarFresh(layout, 3, hashes.sourceHash, "c".repeat(64))).toThrow(/stale/u);
  });

  it("solves the one-way acyclic language and rejects partial/deferred plans", () => {
    const results = new Map<string, BoundsResult>([
      ["a", known(0, 0, 10, 10, 2)], ["b", known(20, 30, 30, 20, 5)], ["c", known(0, 0, 4, 4)],
    ]);
    const placements = resolveLayoutConstraints([
      { id: "width", kind: "same-width", subjectId: "a", referenceId: "b" },
      { id: "below", kind: "below", subjectId: "c", referenceId: "a", gap: 3 },
      { id: "base", kind: "align-baseline", subjectId: "a", referenceId: "b" },
    ], results);
    expect(placements.find((item) => item.id === "a")!.box).toEqual({ x: 0, y: 33, width: 30, height: 10 });
    expect(placements.find((item) => item.id === "c")!.box.y).toBe(26);
    expect(() => resolveLayoutConstraints([
      { id: "ab", kind: "right-of", subjectId: "a", referenceId: "b", gap: 0 },
      { id: "ba", kind: "right-of", subjectId: "b", referenceId: "a", gap: 0 },
    ], results)).toThrow(/cycle/u);
    expect(() => resolveLayoutConstraints(
      [{ id: "deferred", kind: "right-of", subjectId: "d", referenceId: "a", gap: 0 }],
      new Map([...results, ["d", { status: "deferred", reason: "latex" } as const]]),
    )).toThrow(/deferred/u);
  });

  it("resolves a reverse-ordered constraint chain without quadratic scanning", () => {
    const length = 1_000;
    const results = new Map<string, BoundsResult>();
    for (let index = 0; index <= length; index += 1) results.set(`n${index}`, known(0, 0, 1, 1));
    const constraints = Array.from({ length }, (_, index) => ({
      id: `c${index}`,
      kind: "right-of" as const,
      subjectId: `n${length - index}`,
      referenceId: `n${length - index - 1}`,
      gap: 1,
    }));
    const placements = resolveLayoutConstraints(constraints, results);
    expect(placements.find((item) => item.id === `n${length}`)!.box.x).toBe(length * 2);
    expect(() => resolveLayoutConstraints(Array.from({ length: 10_001 }, (_, index) => ({
      id: `limit-${index}`, kind: "right-of" as const, subjectId: `s-${index}`, referenceId: `r-${index}`, gap: 0,
    })), new Map())).toThrow(/limit/u);
  });

  it("does not report cycles when constraints only cross independent axes", () => {
    const placements = resolveLayoutConstraints([
      { id: "x", kind: "right-of", subjectId: "a", referenceId: "b", gap: 2 },
      { id: "y", kind: "below", subjectId: "b", referenceId: "a", gap: 3 },
    ], new Map([["a", known(0, 20, 10, 10)], ["b", known(20, 0, 5, 5)]]));
    expect(placements.find((item) => item.id === "a")!.box.x).toBe(27);
    expect(placements.find((item) => item.id === "b")!.box.y).toBe(12);
  });
});

describe("M3 layout plans and connector intent", () => {
  const document = (): DocumentIR => ({
    schemaVersion: 1, format: 70218,
    pages: [{
      id: "page", layers: [{ id: "layer", name: "layer" }],
      views: [{ id: "view", visibleLayerIds: ["layer"], activeLayerId: "layer", marked: false }],
      objects: [
        { id: "a", layerId: "layer", zOrder: 0 },
        { id: "b", layerId: "layer", zOrder: 1, matrix: [2, 0, 0, 2, 0, 0] },
      ],
    }],
  });

  it("applies page/local transforms in their declared order and validates atomically", () => {
    const draft = document();
    applyLayoutPlan(draft, createLayoutPlan("page", [
      { objectId: "a", matrix: translationMatrix(10, 5), space: "page" },
      { objectId: "b", matrix: translationMatrix(10, 5), space: "local" },
    ]));
    expect(draft.pages[0]!.objects[0]!.matrix).toEqual([1, 0, 0, 1, 10, 5]);
    expect(draft.pages[0]!.objects[1]!.matrix).toEqual([2, 0, 0, 2, 20, 10]);
    const unchanged = document();
    expect(() => applyLayoutPlan(unchanged, createLayoutPlan("page", [
      { objectId: "a", matrix: translationMatrix(1, 1), space: "page" },
      { objectId: "missing", matrix: translationMatrix(1, 1), space: "page" },
    ]))).toThrow(/does not exist/u);
    expect(unchanged.pages[0]!.objects[0]!.matrix).toBeUndefined();
    const literal = {
      pageId: "page", diagnostics: [],
      transforms: [
        { objectId: "a", matrix: translationMatrix(10, 0), space: "page" as const },
        { objectId: "a", matrix: translationMatrix(0, 20), space: "page" as const },
      ],
    };
    expect(() => applyLayoutPlan(unchanged, literal)).toThrow(/more than once/u);
    expect(unchanged.pages[0]!.objects[0]!.matrix).toBeUndefined();
  });

  it("routes explicit preliminary connectors and rejects ambiguous overlap", () => {
    const from = { x: 0, y: 0, width: 10, height: 10 };
    const to = { x: 30, y: 20, width: 10, height: 10 };
    expect(routeConnector(from, to, "straight").points).toEqual([{ x: 10, y: 5 }, { x: 30, y: 25 }]);
    expect(routeConnector(from, to, "orthogonal", undefined, "horizontal-first").points)
      .toEqual([{ x: 10, y: 5 }, { x: 30, y: 5 }, { x: 30, y: 25 }]);
    expect(() => routeConnector(from, from)).toThrow(/overlapping/u);
    expect(() => {
      // @ts-expect-error direct box routes cannot resolve a baseline measurement
      routeConnector(from, to, "straight", ["baseline-left", "left"]);
    }).toThrow(/known baseline/u);
  });

  it("resolves connector IDs, box kinds, one-sided auto anchors and offsets", () => {
    const bounds = new Map<string, BoundsResult>([
      ["a", { status: "known", boxes: {
        logical: { x: 0, y: 0, width: 20, height: 20 },
        geometric: { x: 2, y: 2, width: 10, height: 10 },
        visual: { x: 1, y: 1, width: 12, height: 12 },
      } }],
      ["b", known(5, 40, 10, 10)],
    ]);
    const route = resolveConnectorIntent({
      id: "edge", routing: "orthogonal", tieBreak: "vertical-first",
      from: { objectId: "a", anchor: "auto", boxKind: "geometric", offset: { x: 1, y: 2 } },
      to: { objectId: "b", anchor: "bottom", boxKind: "logical" },
    }, bounds);
    expect(route.fromAnchor).toBe("top");
    expect(route.toAnchor).toBe("bottom");
    expect(route.points).toEqual([{ x: 8, y: 14 }, { x: 8, y: 40 }, { x: 10, y: 40 }]);
    const baselineRoute = resolveConnectorIntent({
      id: "baseline", routing: "straight",
      from: { objectId: "a", anchor: "baseline-left", boxKind: "logical" },
      to: { objectId: "b", anchor: "left", boxKind: "logical" },
    }, new Map([["a", known(0, 0, 10, 10, 3)], ["b", known(20, 0, 10, 10)]]));
    expect(baselineRoute.points).toEqual([{ x: 0, y: 3 }, { x: 20, y: 5 }]);
  });
});
