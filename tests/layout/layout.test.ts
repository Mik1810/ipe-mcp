import { describe, expect, it } from "vitest";

import {
  alignBoxes,
  distributeBoxes,
  fitBox,
  layoutColumn,
  layoutGrid,
  layoutRow,
  layoutStack,
  transformForPlacement,
} from "../../src/layout/index.js";

describe("M3 deterministic layout primitives", () => {
  const container = { x: 0, y: 0, width: 100, height: 80 };

  it("lays rows left-to-right and columns top-to-bottom while coordinates stay y-up", () => {
    const items = [
      { id: "a", size: { width: 10, height: 20 } },
      { id: "b", size: { width: 20, height: 10 } },
    ];
    expect(layoutRow({ container, items, gap: 5, padding: 10 })).toEqual([
      { id: "a", box: { x: 10, y: 50, width: 10, height: 20 } },
      { id: "b", box: { x: 25, y: 60, width: 20, height: 10 } },
    ]);
    expect(layoutColumn({ container, items, gap: 5, padding: 10 })).toEqual([
      { id: "a", box: { x: 10, y: 50, width: 10, height: 20 } },
      { id: "b", box: { x: 10, y: 35, width: 20, height: 10 } },
    ]);
  });

  it("handles margin, stretch, space-between, grid and stack deterministically", () => {
    expect(layoutRow({
      container,
      items: [{ id: "a", size: { width: 10, height: 10 }, margin: { left: 5 } }, { id: "b", size: { width: 10, height: 10 } }],
      padding: 10,
      mainAlign: "space-between",
      crossAlign: "stretch",
    })).toEqual([
      { id: "a", box: { x: 15, y: 10, width: 10, height: 60 } },
      { id: "b", box: { x: 80, y: 10, width: 10, height: 60 } },
    ]);
    expect(layoutGrid({
      container,
      columns: 2,
      padding: 10,
      columnGap: 10,
      rowGap: 10,
      items: Array.from({ length: 4 }, (_, index) => ({ id: String(index), size: { width: 10, height: 10 } })),
    }).map((placement) => placement.box)).toEqual([
      { x: 22.5, y: 52.5, width: 10, height: 10 }, { x: 67.5, y: 52.5, width: 10, height: 10 },
      { x: 22.5, y: 17.5, width: 10, height: 10 }, { x: 67.5, y: 17.5, width: 10, height: 10 },
    ]);
    expect(layoutStack({ container, padding: 10, anchor: "top-right", items: [{ id: "a", size: { width: 20, height: 10 } }] }))
      .toEqual([{ id: "a", box: { x: 70, y: 60, width: 20, height: 10 } }]);
  });

  it("aligns, distributes, contains, covers and stretches", () => {
    const placements = [
      { id: "a", box: { x: 10, y: 20, width: 10, height: 10 } },
      { id: "b", box: { x: 50, y: 40, width: 20, height: 20 } },
    ];
    expect(alignBoxes(placements, "center-y", 30).map((item) => item.box.y)).toEqual([25, 20]);
    expect(distributeBoxes([...placements, { id: "c", box: { x: 80, y: 0, width: 10, height: 10 } }], "x", 0, 100)
      .map((item) => item.box.x)).toEqual([0, 40, 90]);
    expect(fitBox({ x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 100 }, "contain").box)
      .toEqual({ x: 0, y: 25, width: 100, height: 50 });
    expect(fitBox({ x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 100 }, "cover").box)
      .toEqual({ x: -50, y: 0, width: 200, height: 100 });
    expect(fitBox({ x: 10, y: 10, width: 100, height: 50 }, { x: 0, y: 0, width: 40, height: 80 }, "stretch").scale)
      .toEqual({ x: 0.4, y: 1.6 });
  });

  it("rejects overflow and conflicting constraints rather than silently clamping", () => {
    expect(() => layoutRow({ container, gap: -1, items: [] })).toThrow(/non-negative/u);
    expect(() => layoutRow({ container, items: [{ id: "a", size: { width: 101, height: 1 } }] })).toThrow(/exceed/u);
    expect(() => layoutRow({ container, items: [{ id: "a", size: { width: 10, height: 10 }, minSize: { width: 20 }, maxSize: { width: 15 } }] }))
      .toThrow(/minimum/u);
    expect(() => layoutRow({ container, items: [{ id: "a", size: { width: 10, height: 10 }, minSize: { width: 20, height: 20 }, maxSize: { width: 20, height: 20 }, aspectRatio: 2 }] }))
      .toThrow(/aspect ratio/u);
    expect(() => layoutGrid({ container, columns: 2, columnGap: 101, items: [{ id: "a", size: { width: 1, height: 1 } }] }))
      .toThrow(/gaps/u);
    expect(() => layoutStack({ container, items: [{ id: "a", size: { width: 200, height: 160 } }] })).toThrow(/exceeds/u);
    expect(() => alignBoxes([{ id: "a", box: { x: 0, y: 0, width: 1, height: 1 } }], "left", Number.NaN)).toThrow(/finite/u);
  });

  it("keeps max size and aspect authoritative under cross-axis stretch", () => {
    expect(layoutRow({
      container,
      crossAlign: "stretch",
      items: [{ id: "max", size: { width: 20, height: 10 }, maxSize: { height: 10 } }],
    })[0]!.box.height).toBe(10);
    expect(layoutRow({
      container,
      crossAlign: "stretch",
      items: [{ id: "aspect", size: { width: 20, height: 10 }, aspectRatio: 2 }],
    })[0]!.box).toEqual({ x: 0, y: 70, width: 20, height: 10 });
  });

  it("does not turn overflow-allow space-between into a negative overlapping gap", () => {
    const result = layoutRow({
      container: { x: 0, y: 0, width: 100, height: 20 }, overflow: "allow", mainAlign: "space-between", gap: 5,
      items: [{ id: "a", size: { width: 80, height: 10 } }, { id: "b", size: { width: 80, height: 10 } }],
    });
    expect(result.map((item) => item.box.x)).toEqual([0, 85]);
    expect(() => transformForPlacement(
      { x: -800_000_000, y: 0, width: 1, height: 1 },
      { x: 800_000_000, y: 0, width: 1, height: 1 },
    )).toThrow(/within/u);
  });
});
