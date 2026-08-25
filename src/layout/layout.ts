import {
  anchorPoint,
  assertBox,
  assertFiniteNumber,
  assertSize,
  boxFromAnchor,
  insetBox,
  insets,
  unionBoxes,
  type Anchor,
  type Box,
  type InsetsInput,
  type Point,
  type Size,
} from "./geometry.js";
import { scaleMatrix, translationMatrix, multiplyMatrices, type SemanticTransform } from "./matrix.js";
import type { Matrix } from "../domain/ir.js";
import { numericTolerance } from "../domain/numeric.js";

export interface LayoutItem {
  readonly id: string;
  readonly size: Size;
  readonly minSize?: Partial<Size>;
  readonly maxSize?: Partial<Size>;
  readonly aspectRatio?: number;
  readonly margin?: InsetsInput;
}

export interface Placement {
  readonly id: string;
  readonly box: Box;
}

function assertUniqueIds(items: readonly { readonly id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`${label} contains duplicate ID '${item.id}'`);
    ids.add(item.id);
  }
}

export type MainAlignment = "start" | "center" | "end" | "space-between";
export type CrossAlignment = "start" | "center" | "end" | "stretch";

export interface LinearLayoutOptions {
  readonly container: Box;
  readonly items: readonly LayoutItem[];
  readonly direction: "row" | "column";
  readonly gap?: number;
  readonly padding?: InsetsInput;
  readonly mainAlign?: MainAlignment;
  readonly crossAlign?: CrossAlignment;
  readonly overflow?: "error" | "allow";
}

function constrainedSize(item: LayoutItem): Size {
  assertSize(item.size, `item '${item.id}' size`);
  const minimum = { width: item.minSize?.width ?? 0, height: item.minSize?.height ?? 0 };
  if (item.maxSize?.width !== undefined) assertFiniteNumber(item.maxSize.width, `item '${item.id}' maxSize.width`);
  if (item.maxSize?.height !== undefined) assertFiniteNumber(item.maxSize.height, `item '${item.id}' maxSize.height`);
  const maximum = { width: item.maxSize?.width ?? Number.POSITIVE_INFINITY, height: item.maxSize?.height ?? Number.POSITIVE_INFINITY };
  for (const [name, value] of Object.entries(minimum)) {
    assertFiniteNumber(value, `item '${item.id}' minSize.${name}`);
    if (value < 0) throw new Error(`item '${item.id}' minSize.${name} must be non-negative`);
  }
  for (const [name, value] of Object.entries(maximum)) {
    if (value < 0) throw new Error(`item '${item.id}' maxSize.${name} must be non-negative`);
  }
  if (minimum.width > maximum.width || minimum.height > maximum.height) {
    throw new Error(`item '${item.id}' minimum size exceeds maximum size`);
  }
  let width = Math.max(minimum.width, Math.min(item.size.width, maximum.width));
  let height = Math.max(minimum.height, Math.min(item.size.height, maximum.height));
  if (item.aspectRatio !== undefined) {
    assertFiniteNumber(item.aspectRatio, `item '${item.id}' aspectRatio`);
    if (item.aspectRatio <= 0) throw new Error(`item '${item.id}' aspectRatio must be positive`);
    const feasibleWidthMin = Math.max(minimum.width, minimum.height * item.aspectRatio);
    const feasibleWidthMax = Math.min(maximum.width, maximum.height * item.aspectRatio);
    if (feasibleWidthMin > feasibleWidthMax) throw new Error(`item '${item.id}' aspect ratio conflicts with size constraints`);
    width = Math.max(feasibleWidthMin, Math.min(Math.min(width, height * item.aspectRatio), feasibleWidthMax));
    height = width / item.aspectRatio;
  }
  const result = { width, height };
  assertSize(result, `item '${item.id}' constrained size`);
  return result;
}

function stretchedCrossSize(item: LayoutItem, size: Size, available: number, direction: "row" | "column"): Size {
  if (item.aspectRatio !== undefined) return size;
  if (direction === "row") {
    const height = Math.max(item.minSize?.height ?? 0, Math.min(available, item.maxSize?.height ?? Number.POSITIVE_INFINITY));
    const result = { width: size.width, height };
    assertSize(result, `item '${item.id}' stretched size`);
    return result;
  }
  const width = Math.max(item.minSize?.width ?? 0, Math.min(available, item.maxSize?.width ?? Number.POSITIVE_INFINITY));
  const result = { width, height: size.height };
  assertSize(result, `item '${item.id}' stretched size`);
  return result;
}

function nonnegativeInsets(value: InsetsInput, label: string): ReturnType<typeof insets> {
  const result = insets(value);
  if (Object.values(result).some((amount) => amount < 0)) throw new Error(`${label} must be non-negative`);
  return result;
}

function assertGap(gap: number): void {
  assertFiniteNumber(gap, "gap");
  if (gap < 0) throw new Error("gap must be non-negative");
}

export function layoutLinear(options: LinearLayoutOptions): Placement[] {
  assertBox(options.container, "container");
  assertUniqueIds(options.items, "linear layout");
  const gap = options.gap ?? 0;
  assertGap(gap);
  const content = insetBox(options.container, nonnegativeInsets(options.padding ?? 0, "padding"));
  const itemData = options.items.map((item) => ({ item, size: constrainedSize(item), margin: nonnegativeInsets(item.margin ?? 0, `item '${item.id}' margin`) }));
  const mainSize = options.direction === "row" ? content.width : content.height;
  const outerSizes = itemData.map(({ size, margin }) => options.direction === "row"
    ? margin.left + size.width + margin.right
    : margin.top + size.height + margin.bottom);
  const itemTotal = outerSizes.reduce((sum, value) => sum + value, 0);
  const baseGaps = Math.max(0, itemData.length - 1) * gap;
  if ((options.overflow ?? "error") === "error" && itemTotal + baseGaps > mainSize + numericTolerance(mainSize)) {
    throw new Error("linear layout items exceed the container");
  }
  const free = mainSize - itemTotal - baseGaps;
  const mainAlign = options.mainAlign ?? "start";
  const actualGap = mainAlign === "space-between" && itemData.length > 1 && free >= 0
    ? gap + free / (itemData.length - 1)
    : gap;
  const offset = mainAlign === "center" ? free / 2 : mainAlign === "end" ? free : 0;
  const crossAlign = options.crossAlign ?? "start";
  const placements: Placement[] = [];
  let cursor = options.direction === "row" ? content.x + offset : content.y + content.height - offset;
  for (const { item, size: rawSize, margin } of itemData) {
    if (options.direction === "row") {
      const available = content.height - margin.top - margin.bottom;
      if (available < 0) throw new Error(`item '${item.id}' vertical margins exceed the container`);
      const size = crossAlign === "stretch" ? stretchedCrossSize(item, rawSize, available, "row") : rawSize;
      if ((options.overflow ?? "error") === "error" && size.height > available + numericTolerance(available)) throw new Error(`item '${item.id}' exceeds the row cross axis`);
      const y = crossAlign === "center"
        ? content.y + margin.bottom + (available - size.height) / 2
        : crossAlign === "end"
          ? content.y + margin.bottom
          : content.y + content.height - margin.top - size.height;
      const box = { x: cursor + margin.left, y, ...size };
      assertBox(box, `item '${item.id}' placement`);
      placements.push({ id: item.id, box });
      cursor += margin.left + size.width + margin.right + actualGap;
    } else {
      const available = content.width - margin.left - margin.right;
      if (available < 0) throw new Error(`item '${item.id}' horizontal margins exceed the container`);
      const size = crossAlign === "stretch" ? stretchedCrossSize(item, rawSize, available, "column") : rawSize;
      if ((options.overflow ?? "error") === "error" && size.width > available + numericTolerance(available)) throw new Error(`item '${item.id}' exceeds the column cross axis`);
      const x = crossAlign === "center"
        ? content.x + margin.left + (available - size.width) / 2
        : crossAlign === "end"
          ? content.x + content.width - margin.right - size.width
          : content.x + margin.left;
      cursor -= margin.top;
      const box = { x, y: cursor - size.height, ...size };
      assertBox(box, `item '${item.id}' placement`);
      placements.push({ id: item.id, box });
      cursor -= size.height + margin.bottom + actualGap;
    }
  }
  return placements;
}

export function layoutRow(options: Omit<LinearLayoutOptions, "direction">): Placement[] {
  return layoutLinear({ ...options, direction: "row" });
}

export function layoutColumn(options: Omit<LinearLayoutOptions, "direction">): Placement[] {
  return layoutLinear({ ...options, direction: "column" });
}

export interface GridLayoutOptions {
  readonly container: Box;
  readonly items: readonly LayoutItem[];
  readonly columns: number;
  readonly columnGap?: number;
  readonly rowGap?: number;
  readonly padding?: InsetsInput;
  readonly anchor?: Anchor;
}

export function layoutGrid(options: GridLayoutOptions): Placement[] {
  assertBox(options.container, "container");
  assertUniqueIds(options.items, "grid layout");
  if (!Number.isSafeInteger(options.columns) || options.columns < 1) throw new Error("columns must be a positive integer");
  const columnGap = options.columnGap ?? 0;
  const rowGap = options.rowGap ?? 0;
  assertGap(columnGap);
  assertGap(rowGap);
  const content = insetBox(options.container, nonnegativeInsets(options.padding ?? 0, "padding"));
  if (options.items.length === 0) return [];
  const rows = Math.ceil(options.items.length / options.columns);
  const cellWidth = (content.width - columnGap * (options.columns - 1)) / options.columns;
  const cellHeight = (content.height - rowGap * (rows - 1)) / rows;
  if (cellWidth < 0 || cellHeight < 0) throw new Error("grid gaps exceed the container");
  return options.items.map((item, index) => {
    const size = constrainedSize(item);
    const margin = nonnegativeInsets(item.margin ?? 0, `item '${item.id}' margin`);
    const column = index % options.columns;
    const row = Math.floor(index / options.columns);
    const cell: Box = {
      x: content.x + column * (cellWidth + columnGap),
      y: content.y + content.height - (row + 1) * cellHeight - row * rowGap,
      width: cellWidth,
      height: cellHeight,
    };
    const inner = insetBox(cell, margin);
    if (size.width > inner.width + numericTolerance(inner.width) || size.height > inner.height + numericTolerance(inner.height)) throw new Error(`item '${item.id}' exceeds its grid cell`);
    return { id: item.id, box: boxFromAnchor(anchorPoint(inner, options.anchor ?? "center"), size, options.anchor ?? "center") };
  });
}

export interface StackLayoutOptions {
  readonly container: Box;
  readonly items: readonly LayoutItem[];
  readonly padding?: InsetsInput;
  readonly anchor?: Anchor;
}

export function layoutStack(options: StackLayoutOptions): Placement[] {
  assertBox(options.container, "container");
  assertUniqueIds(options.items, "stack layout");
  const content = insetBox(options.container, nonnegativeInsets(options.padding ?? 0, "padding"));
  const anchor = options.anchor ?? "center";
  return options.items.map((item) => {
    const inner = insetBox(content, nonnegativeInsets(item.margin ?? 0, `item '${item.id}' margin`));
    const size = constrainedSize(item);
    if (size.width > inner.width + numericTolerance(inner.width) || size.height > inner.height + numericTolerance(inner.height)) {
      throw new Error(`item '${item.id}' exceeds the stack container`);
    }
    return { id: item.id, box: boxFromAnchor(anchorPoint(inner, anchor), size, anchor) };
  });
}

export type BoxAlignment = "left" | "center-x" | "right" | "bottom" | "center-y" | "top";

export function alignBoxes(placements: readonly Placement[], alignment: BoxAlignment, target?: number): Placement[] {
  if (target !== undefined) assertFiniteNumber(target, "alignment target");
  assertUniqueIds(placements, "alignment");
  if (placements.length === 0) return [];
  const bounds = unionBoxes(placements.map((placement) => placement.box));
  const coordinate = target ?? (
    alignment === "left" ? bounds.x
      : alignment === "center-x" ? bounds.x + bounds.width / 2
        : alignment === "right" ? bounds.x + bounds.width
          : alignment === "bottom" ? bounds.y
            : alignment === "center-y" ? bounds.y + bounds.height / 2
              : bounds.y + bounds.height
  );
  return placements.map(({ id, box }) => {
    const current = alignment === "left" ? box.x
      : alignment === "center-x" ? box.x + box.width / 2
        : alignment === "right" ? box.x + box.width
          : alignment === "bottom" ? box.y
            : alignment === "center-y" ? box.y + box.height / 2
              : box.y + box.height;
    const result = alignment.endsWith("x") || alignment === "left" || alignment === "right"
      ? { ...box, x: box.x + coordinate - current }
      : { ...box, y: box.y + coordinate - current };
    assertBox(result, `aligned box '${id}'`);
    return { id, box: result };
  });
}

export function distributeBoxes(placements: readonly Placement[], axis: "x" | "y", start?: number, end?: number): Placement[] {
  assertUniqueIds(placements, "distribution");
  for (const placement of placements) assertBox(placement.box, `distribution box '${placement.id}'`);
  if (start !== undefined) assertFiniteNumber(start, "distribution start");
  if (end !== undefined) assertFiniteNumber(end, "distribution end");
  if (placements.length < 2) return [...placements];
  const sorted = [...placements].sort((a, b) => axis === "x" ? a.box.x - b.box.x : a.box.y - b.box.y);
  const lower = start ?? (axis === "x" ? sorted[0]!.box.x : sorted[0]!.box.y);
  const last = sorted.at(-1)!;
  const upper = end ?? (axis === "x" ? last.box.x + last.box.width : last.box.y + last.box.height);
  const total = sorted.reduce((sum, item) => sum + (axis === "x" ? item.box.width : item.box.height), 0);
  const gap = (upper - lower - total) / (sorted.length - 1);
  if (gap < -numericTolerance(upper, lower, total)) throw new Error("distribution extent is smaller than the boxes");
  const placed = new Map<string, Box>();
  let cursor = lower;
  for (const item of sorted) {
    const box = axis === "x" ? { ...item.box, x: cursor } : { ...item.box, y: cursor };
    assertBox(box, `distributed box '${item.id}'`);
    placed.set(item.id, box);
    cursor += (axis === "x" ? item.box.width : item.box.height) + gap;
  }
  return placements.map((item) => ({ id: item.id, box: placed.get(item.id)! }));
}

export type FitMode = "contain" | "cover" | "stretch";

export interface FitResult {
  readonly box: Box;
  readonly matrix: Matrix;
  readonly scale: Point;
}

export function fitBox(source: Box, target: Box, mode: FitMode = "contain", anchor: Anchor = "center"): FitResult {
  assertBox(source, "source");
  assertBox(target, "target");
  if (source.width === 0 || source.height === 0) throw new Error("cannot fit a zero-size source box");
  const rawX = target.width / source.width;
  const rawY = target.height / source.height;
  const scale = mode === "stretch"
    ? { x: rawX, y: rawY }
    : { x: mode === "contain" ? Math.min(rawX, rawY) : Math.max(rawX, rawY), y: mode === "contain" ? Math.min(rawX, rawY) : Math.max(rawX, rawY) };
  const size = { width: source.width * scale.x, height: source.height * scale.y };
  const box = boxFromAnchor(anchorPoint(target, anchor), size, anchor);
  const matrix = multiplyMatrices(
    translationMatrix(box.x, box.y),
    multiplyMatrices(scaleMatrix(scale.x, scale.y), translationMatrix(-source.x, -source.y)),
  );
  return { box, matrix, scale };
}

export function transformForPlacement(source: Box, target: Box): SemanticTransform {
  assertBox(source, "source");
  assertBox(target, "target");
  if (source.width !== target.width || source.height !== target.height) throw new Error("placement-only transform cannot resize");
  const translation = { x: target.x - source.x, y: target.y - source.y };
  assertFiniteNumber(translation.x, "placement translation.x");
  assertFiniteNumber(translation.y, "placement translation.y");
  return { translation };
}
