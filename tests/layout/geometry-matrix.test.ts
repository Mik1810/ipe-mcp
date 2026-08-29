import { describe, expect, it } from "vitest";

import type { Matrix } from "../../src/domain/ir.js";
import { parseIpeXml, projectIpeXml } from "../../src/ipe/xml/index.js";
import {
  anchorPoint,
  applyMatrix,
  applyInverseMatrix,
  assertInvertibleMatrix,
  boxFromAnchor,
  composeViewObject,
  convertPoint,
  inverseMatrix,
  multiplyMatrices,
  pointAlmostEqual,
  postTransformLocal,
  preTransformObject,
  rotationMatrix,
  resolveIpeLayout,
  resolvePageCoordinateSystem,
  scaleMatrix,
  transformBoxEnvelope,
  translationMatrix,
  type Anchor,
  type CoordinateSpace,
  type PageCoordinateSystem,
  type Point,
} from "../../src/layout/index.js";
import { PINNED_SEEDS, XorShift32, randomMatrix } from "../property/rng.js";

const SEED = PINNED_SEEDS.matrices;

describe("M3 geometry and affine algebra", () => {
  it("implements every y-up anchor and requires an explicit baseline", () => {
    const box = { x: 10, y: 20, width: 30, height: 40 };
    const expected: Record<Exclude<Anchor, "baseline-left">, Point> = {
      "top-left": { x: 10, y: 60 }, top: { x: 25, y: 60 }, "top-right": { x: 40, y: 60 },
      left: { x: 10, y: 40 }, center: { x: 25, y: 40 }, right: { x: 40, y: 40 },
      "bottom-left": { x: 10, y: 20 }, bottom: { x: 25, y: 20 }, "bottom-right": { x: 40, y: 20 },
    };
    for (const [anchor, point] of Object.entries(expected)) {
      expect(anchorPoint(box, anchor as Anchor)).toEqual(point);
      expect(boxFromAnchor(point, { width: 30, height: 40 }, anchor as Anchor)).toEqual(box);
    }
    expect(anchorPoint(box, "baseline-left", 7)).toEqual({ x: 10, y: 27 });
    expect(() => anchorPoint(box, "baseline-left")).toThrow(/known baseline/u);
    expect(() => anchorPoint(box, "baseline-left", 41)).toThrow(/within/u);
  });

  it("round-trips seeded, well-conditioned matrices and preserves multiplication order", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < 1_024; index += 1) {
      const left = randomMatrix(random);
      const right = randomMatrix(random);
      const point = { x: random.between(-100, 100), y: random.between(-100, 100) };
      const transformed = applyMatrix(left, point);
      expect(pointAlmostEqual(applyMatrix(inverseMatrix(left), transformed), point), `seed=${SEED} case=${index}`).toBe(true);
      expect(pointAlmostEqual(applyMatrix(multiplyMatrices(left, right), point), applyMatrix(left, applyMatrix(right, point)))).toBe(true);
    }
  });

  it("checks associativity by application and distinguishes page/local/view composition", () => {
    const a = translationMatrix(13, -7);
    const b = rotationMatrix(30);
    const c = scaleMatrix(2, 3);
    const point = { x: 11, y: 5 };
    expect(pointAlmostEqual(
      applyMatrix(multiplyMatrices(multiplyMatrices(a, b), c), point),
      applyMatrix(multiplyMatrices(a, multiplyMatrices(b, c)), point),
    )).toBe(true);
    expect(preTransformObject(b, a)).toEqual(multiplyMatrices(a, b));
    expect(postTransformLocal(b, a)).toEqual(multiplyMatrices(b, a));
    expect(composeViewObject(a, b)).toEqual(multiplyMatrices(a, b));
  });

  it("enforces the singular threshold, finite domain and transformed output range", () => {
    expect(() => assertInvertibleMatrix([1, 0, 0, 1e-12, 0, 0])).toThrow(/degenerate/u);
    expect(() => assertInvertibleMatrix([1, 0, 0, 0.9999e-12, 0, 0])).toThrow(/degenerate/u);
    expect(() => assertInvertibleMatrix([1, 0, 0, 1.0001e-12, 0, 0])).not.toThrow();
    expect(() => assertInvertibleMatrix([Number.NaN, 0, 0, 1, 0, 0])).toThrow(/finite/u);
    expect(() => assertInvertibleMatrix([] as unknown as Matrix)).toThrow(/six/u);
    expect(() => assertInvertibleMatrix([1, 0, 0, 1, , 0] as unknown as Matrix)).toThrow(/finite/u);
    expect(() => assertInvertibleMatrix(new Array(6) as unknown as Matrix)).toThrow(/finite/u);
    expect(() => translationMatrix(1_000_000_001, 0)).toThrow(/within/u);
    expect(() => applyMatrix(scaleMatrix(2), { x: 600_000_000, y: 0 })).toThrow(/within/u);
    const tinyScalePoint = applyInverseMatrix(scaleMatrix(1e-10), { x: 0.01, y: -0.01 });
    expect(tinyScalePoint.x).toBeCloseTo(100_000_000, 6);
    expect(tinyScalePoint.y).toBeCloseTo(-100_000_000, 6);
  });

  it("computes the four-corner envelope", () => {
    const envelope = transformBoxEnvelope(rotationMatrix(90), { x: 0, y: 0, width: 20, height: 10 });
    expect(envelope.x).toBeCloseTo(-10, 12);
    expect(envelope.y).toBeCloseTo(0, 12);
    expect(envelope.width).toBeCloseTo(10, 12);
    expect(envelope.height).toBeCloseTo(20, 12);
    expect(() => transformBoxEnvelope(rotationMatrix(45), { x: -500_000_000, y: -500_000_000, width: 1_000_000_000, height: 1_000_000_000 }))
      .toThrow(/within/u);
  });
});

describe("M3 coordinate spaces", () => {
  const system: PageCoordinateSystem = {
    paper: { x: -32, y: -9, width: 320, height: 180 },
    frame: { x: 0, y: 0, width: 288, height: 162 },
  };
  const spaces: CoordinateSpace[] = [
    { kind: "ipe" }, { kind: "frame" }, { kind: "paper" },
    { kind: "normalized", relativeTo: "frame" }, { kind: "normalized", relativeTo: "paper" },
    { kind: "object-local", phase: "model", objectMatrix: translationMatrix(20, 30) },
    { kind: "object-local", phase: "rendered", objectMatrix: translationMatrix(20, 30), viewLayerMatrix: scaleMatrix(2) },
  ];

  it("round-trips every supported variant without an implicit y flip", () => {
    const points: Record<string, Point> = {
      ipe: { x: 17, y: 93 }, frame: { x: 17, y: 93 }, paper: { x: 49, y: 102 },
      normalized: { x: 0.125, y: 0.875 }, "object-local": { x: 17, y: 13 },
    };
    for (const space of spaces) {
      const point = points[space.kind]!;
      expect(pointAlmostEqual(convertPoint(convertPoint(point, space, { kind: "ipe" }, system), { kind: "ipe" }, space, system), point)).toBe(true);
    }
    expect(convertPoint({ x: 0.125, y: 0.875 }, { kind: "normalized", relativeTo: "frame" }, { kind: "ipe" }, system))
      .toEqual({ x: 36, y: 141.75 });
  });

  it("uses the last effective Ipe stylesheet layout and its explicit origin", () => {
    const ir = projectIpeXml(parseIpeXml(`<?xml version="1.0"?>
      <ipe version="70218">
        <ipestyle name="first"><layout paper="100 80" origin="0 0" frame="100 80"/></ipestyle>
        <ipestyle name="second"><layout paper="320 180" origin="16 9" frame="288 162"/></ipestyle>
        <page><layer name="a"/></page>
      </ipe>`));
    expect(resolveIpeLayout(ir)).toEqual({ paper: [320, 180], origin: [16, 9], frame: [288, 162] });
    expect(resolvePageCoordinateSystem(ir)).toEqual({
      paper: { x: -16, y: -9, width: 320, height: 180 },
      frame: { x: 0, y: 0, width: 288, height: 162 },
    });
  });

  it("uses Ipe's built-in standard A4 layout when no stylesheet overrides it", () => {
    const ir = projectIpeXml(parseIpeXml('<ipe version="70218"><page><layer name="a"/></page></ipe>'));
    expect(resolveIpeLayout(ir)).toEqual({ paper: [595, 842], origin: [0, 0], frame: [595, 842] });
  });
});
