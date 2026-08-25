import type { Matrix } from "../domain/ir.js";
import { anchorPoint, assertBox, assertFiniteNumber, type Anchor, type Box, type Point } from "./geometry.js";
import { applyInverseMatrix, applyMatrix, composeViewObject } from "./matrix.js";

export interface PageCoordinateSystem {
  readonly paper: Box;
  readonly frame: Box;
}

export type CoordinateSpace =
  | { readonly kind: "frame" }
  | { readonly kind: "paper" }
  | { readonly kind: "normalized"; readonly relativeTo: "frame" | "paper" }
  | { readonly kind: "ipe" }
  | { readonly kind: "object-local"; readonly phase: "model"; readonly objectId?: string; readonly objectMatrix: Matrix }
  | { readonly kind: "object-local"; readonly phase: "rendered"; readonly objectId?: string; readonly objectMatrix: Matrix; readonly viewLayerMatrix: Matrix };

function assertSystem(system: PageCoordinateSystem): void {
  assertBox(system.paper, "paper");
  assertBox(system.frame, "frame");
}

function checkedPoint(point: Point, label = "point"): Point {
  assertFiniteNumber(point.x, `${label}.x`);
  assertFiniteNumber(point.y, `${label}.y`);
  return point;
}

function referenceBox(system: PageCoordinateSystem, target: "frame" | "paper"): Box {
  assertBox(system.paper, "paper");
  assertBox(system.frame, "frame");
  return target === "frame" ? system.frame : system.paper;
}

export function toIpePoint(point: Point, space: CoordinateSpace, system: PageCoordinateSystem): Point {
  assertSystem(system);
  checkedPoint(point);
  switch (space.kind) {
    case "ipe": return { ...point };
    case "frame": return checkedPoint({ x: system.frame.x + point.x, y: system.frame.y + point.y }, "Ipe point");
    case "paper": return checkedPoint({ x: system.paper.x + point.x, y: system.paper.y + point.y }, "Ipe point");
    case "normalized": {
      const box = referenceBox(system, space.relativeTo);
      return checkedPoint({ x: box.x + point.x * box.width, y: box.y + point.y * box.height }, "Ipe point");
    }
    case "object-local": return applyMatrix(
      space.phase === "rendered" ? composeViewObject(space.viewLayerMatrix, space.objectMatrix) : space.objectMatrix,
      point,
    );
  }
}

export function fromIpePoint(point: Point, space: CoordinateSpace, system: PageCoordinateSystem): Point {
  assertSystem(system);
  checkedPoint(point);
  switch (space.kind) {
    case "ipe": return { ...point };
    case "frame": return checkedPoint({ x: point.x - system.frame.x, y: point.y - system.frame.y }, "frame point");
    case "paper": return checkedPoint({ x: point.x - system.paper.x, y: point.y - system.paper.y }, "paper point");
    case "normalized": {
      const box = referenceBox(system, space.relativeTo);
      if (box.width === 0 || box.height === 0) throw new Error("cannot normalize against a zero-size box");
      return checkedPoint({ x: (point.x - box.x) / box.width, y: (point.y - box.y) / box.height }, "normalized point");
    }
    case "object-local": {
      const matrix = space.phase === "rendered" ? composeViewObject(space.viewLayerMatrix, space.objectMatrix) : space.objectMatrix;
      return applyInverseMatrix(matrix, point);
    }
  }
}

export function convertPoint(point: Point, from: CoordinateSpace, to: CoordinateSpace, system: PageCoordinateSystem): Point {
  return fromIpePoint(toIpePoint(point, from, system), to, system);
}

export function anchorInSpace(box: Box, anchor: Anchor, from: CoordinateSpace, to: CoordinateSpace, system: PageCoordinateSystem): Point {
  return convertPoint(anchorPoint(box, anchor), from, to, system);
}
