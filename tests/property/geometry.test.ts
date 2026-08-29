import { describe, expect, it } from "vitest";

import {
  anchorInSpace,
  anchorPoint,
  applyMatrix,
  boxFromAnchor,
  convertPoint,
  transformBoxEnvelope,
  type Anchor,
  type CoordinateSpace,
  type PageCoordinateSystem,
  type Point,
} from "../../src/layout/index.js";
import { PINNED_SEEDS, XorShift32, fail, iterations, randomBox, randomMatrix, randomPoint } from "./rng.js";

const SEED = PINNED_SEEDS.geometry;
const CASES = iterations();

const approx = (a: number, b: number, tolerance = 1e-8): boolean => Math.abs(a - b) <= tolerance;
const equalPoints = (a: Point, b: Point, tolerance = 1e-8): boolean => approx(a.x, b.x, tolerance) && approx(a.y, b.y, tolerance);
const equalBoxes = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  approx(a.x, b.x) && approx(a.y, b.y) && approx(a.width, b.width) && approx(a.height, b.height);

const system: PageCoordinateSystem = {
  paper: { x: -32, y: -9, width: 320, height: 180 },
  frame: { x: 14, y: 7, width: 288, height: 162 },
};

function anchors(): Anchor[] {
  return ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];
}

function sane(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

describe("property: geometry round-trips", () => {
  it("round-trips anchor<->box for every anchor on random boxes", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const box = randomBox(random, 500);
      for (const anchor of anchors()) {
        const point = anchorPoint(box, anchor);
        const rebuilt = boxFromAnchor(point, { width: box.width, height: box.height }, anchor);
        if (!equalBoxes(rebuilt, box)) {
          fail(SEED, index, `anchor ${anchor} box round-trip diverged`);
        }
      }
    }
  });

  it("preserves anchor positions when converting between coordinate spaces", () => {
    const random = new XorShift32(SEED);
    const ipeSpaces: CoordinateSpace[] = [{ kind: "ipe" }, { kind: "frame" }, { kind: "paper" }, { kind: "normalized", relativeTo: "frame" }, { kind: "normalized", relativeTo: "paper" }];
    for (let index = 0; index < CASES; index += 1) {
      const box = randomBox(random, 300);
      const anchor = random.pick(anchors());
      const from = random.pick(ipeSpaces);
      const to = random.pick(ipeSpaces);
      const point = anchorInSpace(box, anchor, from, to, system);
      if (!sane(point)) fail(SEED, index, `anchor ${anchor} produced non-finite coordinate`);
      const back = convertPoint(point, to, from, system);
      if (!equalPoints(back, anchorPoint(box, anchor))) fail(SEED, index, `anchor ${anchor} did not round-trip through ${from.kind}->${to.kind}`);
    }
  });

  it("round-trips point conversion across every supported space pair", () => {
    const random = new XorShift32(SEED);
    const names: CoordinateSpace[] = [
      { kind: "ipe" }, { kind: "frame" }, { kind: "paper" },
      { kind: "normalized", relativeTo: "frame" }, { kind: "normalized", relativeTo: "paper" },
      { kind: "object-local", phase: "model", objectMatrix: [1, 0, 0, 1, 20, 30] },
      { kind: "object-local", phase: "rendered", objectMatrix: [1, 0, 0, 1, 20, 30], viewLayerMatrix: [2, 0, 0, 2, 0, 0] },
    ];
    for (let index = 0; index < CASES; index += 1) {
      const point = randomPoint(random, 400);
      const from = random.pick(names);
      const to = random.pick(names);
      const target = convertPoint(point, from, to, system);
      if (!sane(target)) fail(SEED, index, `conversion ${from.kind}->${to.kind} produced non-finite output`);
      const roundTrip = convertPoint(target, to, from, system);
      if (!equalPoints(roundTrip, point)) fail(SEED, index, `conversion ${from.kind}->${to.kind} did not round-trip`);
    }
  });

  it("keeps transformBoxEnvelope conservative for every random matrix/box pair", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const matrix = randomMatrix(random);
      const box = randomBox(random, 200);
      const envelope = transformBoxEnvelope(matrix, box);
      const corners: Point[] = [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x, y: box.y + box.height },
        { x: box.x + box.width, y: box.y + box.height },
      ];
      for (const corner of corners) {
        const transformed = applyMatrix(matrix, corner);
        const inside = transformed.x >= envelope.x - 1e-6 && transformed.x <= envelope.x + envelope.width + 1e-6
          && transformed.y >= envelope.y - 1e-6 && transformed.y <= envelope.y + envelope.height + 1e-6;
        if (!inside) fail(SEED, index, "envelope does not contain a transformed corner");
      }
    }
  });

  it("uses only finite geometry inputs inside the declared domain", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const box = randomBox(random, 900);
      expect(Number.isFinite(box.x + box.y + box.width + box.height), `seed=${SEED} case=${index}`).toBe(true);
    }
  });
});
