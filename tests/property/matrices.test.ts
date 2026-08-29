import { describe, expect, it } from "vitest";

import type { Matrix } from "../../src/domain/ir.js";
import {
  applyMatrix,
  assertInvertibleMatrix,
  inverseMatrix,
  multiplyMatrices,
  pointAlmostEqual,
  rotationMatrix,
  scaleMatrix,
  translationMatrix,
} from "../../src/layout/index.js";
import { PINNED_SEEDS, XorShift32, fail, iterations, randomMatrix } from "./rng.js";

const SEED = PINNED_SEEDS.matrices;
const CASES = iterations();

const approx = (a: number, b: number, tolerance = 1e-9): boolean => Math.abs(a - b) <= tolerance;

function matrixAlmostEqual(left: Matrix, right: Matrix): boolean {
  return left.every((value, index) => approx(value, right[index]!));
}

describe("property: affine matrix algebra", () => {
  it("round-trips inverse and preserves association order for seeded matrices", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const left = randomMatrix(random);
      const right = randomMatrix(random);
      const point = { x: random.between(-100, 100), y: random.between(-100, 100) };
      const transformed = applyMatrix(left, point);
      if (!pointAlmostEqual(applyMatrix(inverseMatrix(left), transformed), point)) {
        fail(SEED, index, "inverse(apply(m, p)) != p");
      }
      if (!pointAlmostEqual(applyMatrix(multiplyMatrices(left, right), point), applyMatrix(left, applyMatrix(right, point)))) {
        fail(SEED, index, "composition is not left-associative");
      }
    }
  });

  it("keeps matrices invertible and finite under identity, rotation and scale products", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const a = multiplyMatrices(randomMatrix(random), randomMatrix(random));
      expect(() => assertInvertibleMatrix(a), `seed=${SEED} case=${index}`).not.toThrow();
      expect(a.every((value) => Number.isFinite(value)), `seed=${SEED} case=${index}`).toBe(true);
    }
    expect(matrixAlmostEqual(multiplyMatrices(rotationMatrix(0), scaleMatrix(1)), [1, 0, 0, 1, 0, 0])).toBe(true);
    expect(matrixAlmostEqual(multiplyMatrices(translationMatrix(5, -5), translationMatrix(-5, 5)), [1, 0, 0, 1, 0, 0])).toBe(true);
  });

  it("never inverts degenerate or non-finite matrices and throws a stable message", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const singular: Matrix = [random.between(-5, 5), random.between(-5, 5), 0, 0, 0, 0];
      expect(() => assertInvertibleMatrix(singular), `seed=${SEED} case=${index}`).toThrow(/degenerate/u);
      const nonFinite = [random.between(-5, 5), Number.NaN, 0, 1, 0, 0];
      expect(() => assertInvertibleMatrix(nonFinite as unknown as Matrix), `seed=${SEED} case=${index}`).toThrow(/finite/u);
    }
  });

  it("preserves the determinant across multiplication up to tolerance", () => {
    const determinant = (matrix: Matrix): number => matrix[0]! * matrix[3]! - matrix[1]! * matrix[2]!;
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const left = randomMatrix(random);
      const right = randomMatrix(random);
      const expected = determinant(left) * determinant(right);
      const actual = determinant(multiplyMatrices(left, right));
      if (Math.abs(actual - expected) > 1e-9 * Math.max(1, Math.abs(expected))) fail(SEED, index, "det(A*B) != det(A)*det(B)");
    }
  });

  it("either returns a finite point or throws the stable domain message", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const matrix = randomMatrix(random);
      const point = { x: random.between(-900_000_000, 900_000_000), y: random.between(-900_000_000, 900_000_000) };
      let result: { x: number; y: number } | undefined;
      let message: string | undefined;
      try { result = applyMatrix(matrix, point); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      if (result !== undefined) {
        if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) fail(SEED, index, "application returned a non-finite point");
      } else if (message === undefined || !/must be (?:within|finite)/u.test(message)) {
        fail(SEED, index, `unexpected application failure: ${message}`);
      }
    }
  });

  it("stays deterministic: the sequence is exactly reproducible", () => {
    const first = new XorShift32(SEED);
    const second = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const a = randomMatrix(first);
      const b = randomMatrix(second);
      if (!matrixAlmostEqual(a, b)) fail(SEED, index, "same seed produced different matrices");
    }
  });
});
