import { describe, expect, it } from "vitest";

import { compilePath, compilePathResult, type PathSpec } from "../../src/objects/path.js";

const text = (spec: PathSpec): string => (compilePath(spec).children?.[0] as { type: "text"; text: string }).text;

describe("typed Ipe 70218 paths", () => {
  it("compiles deterministic primitives and metadata", () => {
    expect(text({ kind: "segment", from: { x: 0, y: 0 }, to: { x: 10, y: 5 } })).toBe("0 0 m 10 5 l");
    expect(text({ kind: "rectangle", x: 1, y: 2, width: 3, height: 4 })).toBe("1 2 m 4 2 l 4 6 l 1 6 l h");
    expect(text({ kind: "circle", center: { x: 2, y: 3 }, radius: 4 })).toBe("4 0 0 4 2 3 e");
    expect(compilePathResult({ kind: "polygon", points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }] }).subpaths[0]).toMatchObject({ closed: true, commandCount: 4 });
  });

  it("compiles arcs, quadratic conversion, splines and structured raw commands", () => {
    expect(text({ kind: "arc", center: { x: 0, y: 0 }, rx: 2, ry: 1, startAngleDegrees: 0, endAngleDegrees: 90, direction: "ccw" })).toBe("2 0 m 2 0 0 1 0 0 0 1 a");
    expect(text({ kind: "arc", center: { x: 0, y: 0 }, rx: 2, ry: 1, startAngleDegrees: 0, endAngleDegrees: 90, direction: "cw" })).toBe("2 0 m 2 0 0 -1 0 0 0 1 a");
    expect(text({ kind: "quadratic", from: { x: 0, y: 0 }, control: { x: 3, y: 3 }, to: { x: 6, y: 0 } })).toBe("0 0 m 2 2 4 2 6 0 c");
    expect(text({ kind: "uniform", points: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 0 }] })).toBe("0 0 m 1 2 3 0 c");
    expect(text({ kind: "catmull-rom", points: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 0 }] })).toBe("0 0 m 1 2 3 0 0.5 C");
    expect(text({ kind: "uniform", closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] })).toBe("0 0 1 0 1 1 u");
    expect(text({ kind: "clothoid", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBe("0 0 m 1 1 L");
    expect(text({ kind: "raw", subpaths: [{ commands: [{ op: "m", point: { x: 1, y: 2 } }, { op: "l", point: { x: 3, y: 4 } }] }] })).toBe("1 2 m 3 4 l");
  });

  it("covers the remaining typed shapes and style attributes", () => {
    const shapes: PathSpec[] = [
      { kind: "rounded-rectangle", x: 0, y: 0, width: 4, height: 3, radius: 1 },
      { kind: "ellipse", center: { x: 1, y: 2 }, rx: 3, ry: 2, rotationDegrees: 15 },
      { kind: "cubic", from: { x: 0, y: 0 }, control1: { x: 1, y: 0 }, control2: { x: 2, y: 1 }, to: { x: 3, y: 1 } },
      { kind: "cardinal", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }] },
      { kind: "compound", subpaths: [{ kind: "segment", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }, { kind: "circle", center: { x: 3, y: 3 }, radius: 1 }] },
    ];
    for (const shape of shapes) expect(compilePathResult(shape).xml.name).toBe("path");
    expect(compilePath({ kind: "segment", from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, style: { stroke: "black", opacity: "half", strokeOpacity: "opaque", farrow: true } }).attributes).toEqual({ stroke: "black", opacity: "half", "stroke-opacity": "opaque", arrow: "normal/normal" });
  });

  it("enforces numeric, geometric, style and arrow invariants", () => {
    expect(() => compilePath({ kind: "segment", from: { x: 0, y: 0 }, to: { x: 0, y: 0 } })).toThrow(/differ/);
    expect(() => compilePath({ kind: "circle", center: { x: 0, y: 0 }, radius: 0 })).toThrow(/positive/);
    expect(() => compilePath({ kind: "arc", center: { x: 0, y: 0 }, rx: 1, ry: 1, startAngleDegrees: 0, endAngleDegrees: 360, direction: "ccw" })).toThrow(/less than 360/);
    expect(text({ kind: "cardinal", points: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 0 }], tension: 2 })).toContain("2 C");
    expect(() => compilePath({ kind: "point", point: { x: 1_000_000_001, y: 0 } })).toThrow(/±1000000000/);
    expect(() => compilePath({ kind: "polygon", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] })).toThrow(/degenerate/);
    expect(() => compilePath({ kind: "rectangle", x: 0, y: 0, width: 1, height: 1, style: { fill: "red", gradient: "g", tiling: "t" } })).toThrow(/mutually/);
    expect(() => compilePath({ kind: "rectangle", x: 0, y: 0, width: 1, height: 1, style: { fill: "bad\0fill" } })).toThrow();
    expect(() => compilePath({ kind: "segment", from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, style: { farrow: true } })).not.toThrow();
    expect(() => compilePath({ kind: "rectangle", x: 0, y: 0, width: 1, height: 1, style: { farrow: true } })).toThrow(/arrows/);
    expect(() => compilePath({ kind: "point", point: { x: 0, y: 0 }, style: { farrow: true } })).toThrow(/arrows/);
    expect(() => compilePath({ kind: "raw", subpaths: [{ commands: [{ op: "l", point: { x: 1, y: 1 } }] }] })).toThrow(/start with move or/);
    expect(() => compilePath({ kind: "raw", subpaths: [{ commands: [{ op: "m", point: { x: 0, y: 0 } }, { op: "h" }, { op: "l", point: { x: 1, y: 1 } }] }] })).toThrow(/final/);
  });

  it("rejects styles on compound children instead of silently dropping them", () => {
    expect(() => compilePath({
      kind: "compound",
      subpaths: [{ kind: "segment", from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, style: { stroke: "red" } }],
    })).toThrow(/compound subpaths cannot carry styles/);
    expect(compilePath({
      kind: "compound",
      style: { stroke: "red" },
      subpaths: [{ kind: "segment", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }],
    }).attributes).toEqual({ stroke: "red" });
  });

  it("rejects malformed raw commands and unsafe absolute styles at runtime", () => {
    expect(() => compilePath({ kind: "raw", subpaths: [{ commands: [{ op: "q" } as never] }] })).toThrow(/unknown command/);
    expect(() => compilePath({ kind: "raw", subpaths: [{ commands: [{ op: "m", point: { x: 0, y: 0 } }, { op: "h", extra: true } as never] }] })).toThrow(/invalid fields/);
    expect(() => compilePath({ kind: "segment", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, style: { pen: "-1" } })).toThrow(/non-negative/);
    expect(() => compilePath({ kind: "segment", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, style: { dash: "[] nope" } })).toThrow(/dash/);
  });
});
