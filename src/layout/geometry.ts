import { assertDomainNumber, numericallyEqual } from "../domain/numeric.js";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Box extends Point, Size {}

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export type InsetsInput = number | Partial<Insets>;

export type Anchor =
  | "top-left" | "top" | "top-right"
  | "left" | "center" | "right"
  | "bottom-left" | "bottom" | "bottom-right"
  | "baseline-left";

export interface ObjectBoxes {
  readonly logical: Box;
  readonly geometric: Box;
  readonly visual: Box;
}

export type BoundsResult =
  | { readonly status: "known"; readonly boxes: ObjectBoxes; readonly baselineFromBottom?: number }
  | { readonly status: "deferred"; readonly reason: "latex" | "native" | "view-dependent" | "unsupported" };

export function assertFiniteNumber(value: number, label: string): void {
  assertDomainNumber(value, label);
}

export function assertSize(size: Size, label = "size"): void {
  assertFiniteNumber(size.width, `${label}.width`);
  assertFiniteNumber(size.height, `${label}.height`);
  if (size.width < 0 || size.height < 0) throw new Error(`${label} dimensions must be non-negative`);
}

export function assertBox(box: Box, label = "box"): void {
  assertFiniteNumber(box.x, `${label}.x`);
  assertFiniteNumber(box.y, `${label}.y`);
  assertSize(box, label);
}

export function insets(value: InsetsInput = 0): Insets {
  if (typeof value === "number") {
    assertFiniteNumber(value, "insets");
    return { top: value, right: value, bottom: value, left: value };
  }
  const result = {
    top: value.top ?? 0,
    right: value.right ?? 0,
    bottom: value.bottom ?? 0,
    left: value.left ?? 0,
  };
  for (const [name, amount] of Object.entries(result)) assertFiniteNumber(amount, `insets.${name}`);
  return result;
}

export function insetBox(box: Box, value: InsetsInput): Box {
  assertBox(box);
  const amount = insets(value);
  const width = box.width - amount.left - amount.right;
  const height = box.height - amount.bottom - amount.top;
  if (width < 0 || height < 0) throw new Error("insets exceed box dimensions");
  const result = { x: box.x + amount.left, y: box.y + amount.bottom, width, height };
  assertBox(result, "inset box");
  return result;
}

export function inflateBox(box: Box, value: InsetsInput): Box {
  assertBox(box);
  const amount = insets(value);
  const result = {
    x: box.x - amount.left,
    y: box.y - amount.bottom,
    width: box.width + amount.left + amount.right,
    height: box.height + amount.bottom + amount.top,
  };
  assertBox(result, "inflated box");
  return result;
}

export function anchorPoint(box: Box, anchor: Anchor, baselineFromBottom?: number): Point {
  assertBox(box);
  if (baselineFromBottom !== undefined) assertFiniteNumber(baselineFromBottom, "baselineFromBottom");
  if (baselineFromBottom !== undefined && (baselineFromBottom < 0 || baselineFromBottom > box.height)) {
    throw new Error("baselineFromBottom must lie within the box");
  }
  let result: Point;
  switch (anchor) {
    case "top-left": result = { x: box.x, y: box.y + box.height }; break;
    case "top": result = { x: box.x + box.width / 2, y: box.y + box.height }; break;
    case "top-right": result = { x: box.x + box.width, y: box.y + box.height }; break;
    case "left": result = { x: box.x, y: box.y + box.height / 2 }; break;
    case "center": result = { x: box.x + box.width / 2, y: box.y + box.height / 2 }; break;
    case "right": result = { x: box.x + box.width, y: box.y + box.height / 2 }; break;
    case "bottom-left": result = { x: box.x, y: box.y }; break;
    case "bottom": result = { x: box.x + box.width / 2, y: box.y }; break;
    case "bottom-right": result = { x: box.x + box.width, y: box.y }; break;
    case "baseline-left": {
      if (baselineFromBottom === undefined) throw new Error("baseline-left requires a known baseline");
      result = { x: box.x, y: box.y + baselineFromBottom };
      break;
    }
  }
  assertFiniteNumber(result.x, "anchor.x");
  assertFiniteNumber(result.y, "anchor.y");
  return result;
}

export function boxFromAnchor(position: Point, size: Size, anchor: Anchor, baselineFromBottom?: number): Box {
  assertFiniteNumber(position.x, "position.x");
  assertFiniteNumber(position.y, "position.y");
  assertSize(size);
  const zero = anchorPoint({ x: 0, y: 0, ...size }, anchor, baselineFromBottom);
  const result = { x: position.x - zero.x, y: position.y - zero.y, ...size };
  assertBox(result, "anchored box");
  return result;
}

export function unionBoxes(boxes: readonly Box[]): Box {
  if (boxes.length === 0) throw new Error("cannot union an empty box list");
  for (const box of boxes) assertBox(box);
  const left = Math.min(...boxes.map((box) => box.x));
  const bottom = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const top = Math.max(...boxes.map((box) => box.y + box.height));
  const result = { x: left, y: bottom, width: right - left, height: top - bottom };
  assertBox(result, "box union");
  return result;
}

export function visualBox(geometric: Box, strokeWidth: number): Box {
  assertFiniteNumber(strokeWidth, "strokeWidth");
  if (strokeWidth < 0) throw new Error("strokeWidth must be non-negative");
  return inflateBox(geometric, strokeWidth / 2);
}

export function almostEqual(a: number, b: number): boolean {
  assertFiniteNumber(a, "a");
  assertFiniteNumber(b, "b");
  return numericallyEqual(a, b);
}

export function pointAlmostEqual(a: Point, b: Point): boolean {
  return almostEqual(a.x, b.x) && almostEqual(a.y, b.y);
}
