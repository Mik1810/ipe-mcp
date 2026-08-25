import type { Matrix } from "../domain/ir.js";
import { MATRIX_SINGULAR_RELATIVE_TOLERANCE, assertDomainNumber } from "../domain/numeric.js";
import { assertBox, assertFiniteNumber, type Box, type Point } from "./geometry.js";

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

export interface SemanticTransform {
  readonly translation?: Point;
  readonly rotationDegrees?: number;
  readonly scale?: number | Point;
  readonly shear?: Point;
  readonly origin?: Point;
}

export function assertMatrix(matrix: Matrix): void {
  if (!Array.isArray(matrix) || matrix.length !== 6) throw new Error("matrix must contain exactly six components");
  for (let index = 0; index < 6; index += 1) assertDomainNumber(matrix[index]!, `matrix[${index}]`);
}

export function matrixDeterminant(matrix: Matrix): number {
  assertMatrix(matrix);
  return matrix[0] * matrix[3] - matrix[1] * matrix[2];
}

export function assertInvertibleMatrix(matrix: Matrix): void {
  assertMatrix(matrix);
  const [a, b, c, d] = matrix;
  const norm = Math.max(Math.abs(a) + Math.abs(c), Math.abs(b) + Math.abs(d));
  if (norm === 0 || Math.abs(a * d - b * c) <= MATRIX_SINGULAR_RELATIVE_TOLERANCE * norm * norm) {
    throw new Error("matrix linear part is singular or numerically degenerate");
  }
}

export function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  assertInvertibleMatrix(left);
  assertInvertibleMatrix(right);
  const [a, b, c, d, s, t] = left;
  const [e, f, g, h, u, v] = right;
  const result: Matrix = [
    a * e + c * f,
    b * e + d * f,
    a * g + c * h,
    b * g + d * h,
    a * u + c * v + s,
    b * u + d * v + t,
  ];
  assertInvertibleMatrix(result);
  return result;
}

export function applyMatrix(matrix: Matrix, point: Point): Point {
  assertInvertibleMatrix(matrix);
  assertFiniteNumber(point.x, "point.x");
  assertFiniteNumber(point.y, "point.y");
  const [a, b, c, d, s, t] = matrix;
  const result = { x: a * point.x + c * point.y + s, y: b * point.x + d * point.y + t };
  assertFiniteNumber(result.x, "transformed point.x");
  assertFiniteNumber(result.y, "transformed point.y");
  return result;
}

export function inverseMatrix(matrix: Matrix): Matrix {
  assertInvertibleMatrix(matrix);
  const [a, b, c, d, s, t] = matrix;
  const determinant = a * d - b * c;
  const result: Matrix = [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * t - d * s) / determinant,
    (b * s - a * t) / determinant,
  ];
  assertInvertibleMatrix(result);
  return result;
}

/** Apply the inverse without requiring its coefficients themselves to fit the persisted matrix domain. */
export function applyInverseMatrix(matrix: Matrix, point: Point): Point {
  assertInvertibleMatrix(matrix);
  assertFiniteNumber(point.x, "point.x");
  assertFiniteNumber(point.y, "point.y");
  const [a, b, c, d, s, t] = matrix;
  const determinant = a * d - b * c;
  const translatedX = point.x - s;
  const translatedY = point.y - t;
  const result = {
    x: (d * translatedX - c * translatedY) / determinant,
    y: (-b * translatedX + a * translatedY) / determinant,
  };
  assertFiniteNumber(result.x, "inverse-transformed point.x");
  assertFiniteNumber(result.y, "inverse-transformed point.y");
  return result;
}

export function translationMatrix(x: number, y: number): Matrix {
  assertFiniteNumber(x, "translation.x");
  assertFiniteNumber(y, "translation.y");
  return [1, 0, 0, 1, x, y];
}

export function scaleMatrix(x: number, y = x): Matrix {
  const matrix: Matrix = [x, 0, 0, y, 0, 0];
  assertInvertibleMatrix(matrix);
  return matrix;
}

export function rotationMatrix(degrees: number): Matrix {
  assertFiniteNumber(degrees, "rotationDegrees");
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [cosine, sine, -sine, cosine, 0, 0];
}

export function shearMatrix(x: number, y = 0): Matrix {
  const matrix: Matrix = [1, y, x, 1, 0, 0];
  assertInvertibleMatrix(matrix);
  return matrix;
}

export function aroundOrigin(matrix: Matrix, origin: Point): Matrix {
  return multiplyMatrices(
    translationMatrix(origin.x, origin.y),
    multiplyMatrices(matrix, translationMatrix(-origin.x, -origin.y)),
  );
}

/** Compose as translate * origin * rotate * shear * scale * -origin. */
export function composeTransform(transform: SemanticTransform): Matrix {
  const translation = transform.translation ?? { x: 0, y: 0 };
  const origin = transform.origin ?? { x: 0, y: 0 };
  const scale = typeof transform.scale === "number"
    ? { x: transform.scale, y: transform.scale }
    : transform.scale ?? { x: 1, y: 1 };
  const shear = transform.shear ?? { x: 0, y: 0 };
  const linear = multiplyMatrices(
    rotationMatrix(transform.rotationDegrees ?? 0),
    multiplyMatrices(shearMatrix(shear.x, shear.y), scaleMatrix(scale.x, scale.y)),
  );
  return multiplyMatrices(
    translationMatrix(translation.x, translation.y),
    aroundOrigin(linear, origin),
  );
}

/** Canonical Ipe application order: viewLayerMatrix * objectMatrix * localPoint. */
export function composeViewObject(viewLayerMatrix: Matrix, objectMatrix: Matrix): Matrix {
  return multiplyMatrices(viewLayerMatrix, objectMatrix);
}

/** Pre-transform in Ipe/page coordinates: next = transform * object. */
export function preTransformObject(objectMatrix: Matrix, transform: Matrix): Matrix {
  return multiplyMatrices(transform, objectMatrix);
}

/** Post-transform in object-local coordinates: next = object * transform. */
export function postTransformLocal(objectMatrix: Matrix, transform: Matrix): Matrix {
  return multiplyMatrices(objectMatrix, transform);
}

export function transformBoxEnvelope(matrix: Matrix, box: Box): Box {
  assertBox(box);
  const corners = [
    applyMatrix(matrix, { x: box.x, y: box.y }),
    applyMatrix(matrix, { x: box.x + box.width, y: box.y }),
    applyMatrix(matrix, { x: box.x, y: box.y + box.height }),
    applyMatrix(matrix, { x: box.x + box.width, y: box.y + box.height }),
  ];
  const left = Math.min(...corners.map((point) => point.x));
  const bottom = Math.min(...corners.map((point) => point.y));
  const right = Math.max(...corners.map((point) => point.x));
  const top = Math.max(...corners.map((point) => point.y));
  const result = { x: left, y: bottom, width: right - left, height: top - bottom };
  assertBox(result, "transformed box envelope");
  return result;
}
