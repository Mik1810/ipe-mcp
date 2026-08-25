import { describe, expect, it } from "vitest";

import type { DocumentIR } from "../../src/domain/ir.js";
import { buildTextObject } from "../../src/objects/builders.js";
import { createObjectIdentity, element } from "../../src/objects/common.js";
import { buildStylesheet, checkStyleStructural, compileStyleDefinition, StyleRegistry } from "../../src/objects/styles.js";
import { resolveTextTwoPass, textBounds, textMeasurementRequest } from "../../src/objects/text.js";

function document(): DocumentIR {
  return { schemaVersion: 1, format: 70218, pages: [] };
}

describe("M4 style registry and text measurement", () => {
  it("applies last-sheet-wins cascade by style kind and supports typed definitions", () => {
    const first = buildStylesheet("style-000000000000000000000001", "first", [
      { kind: "color", name: "brand", value: [1, 0, 0] },
      { kind: "textstyle", name: "caption", type: "label", begin: "\\textbf{", end: "}" },
      { kind: "pathstyle", cap: "1", join: "2", fillrule: "eofill" },
    ]);
    const second = buildStylesheet("style-000000000000000000000002", "second", [
      { kind: "color", name: "brand", value: [0, 0, 1] },
      { kind: "opacity", name: "half", value: 0.5 },
      { kind: "gradient", name: "fade", type: "axial", coords: [0, 0, 10, 0], stops: [{ offset: 0, color: [1, 0, 0] }, { offset: 1, color: [0, 0, 1] }] },
    ]);
    const doc = document();
    doc.stylesheets = [first, second];
    const registry = new StyleRegistry(doc);
    expect(registry.require("color", "brand").source).toBe(second.id);
    expect(registry.require("labelstyle", "caption").source).toBe(first.id);
    expect(registry.require("pathstyle", "normal").source).toBe(first.id);
    expect(registry.require("gradient", "fade").xml?.children).toHaveLength(2);
    expect(() => compileStyleDefinition({ kind: "color", name: "1bad", value: 0 })).toThrow(/start/);
    expect(() => compileStyleDefinition({ kind: "dashstyle", name: "broken", value: "not-a-dash" })).toThrow(/dash/);
    const symbolPath = { type: "element" as const, name: "path", attributes: {}, children: [] };
    expect(() => compileStyleDefinition({ kind: "symbol", name: "mark/x(sx)", xform: true, object: symbolPath })).toThrow(/parameterized/);
    expect(() => compileStyleDefinition({ kind: "symbol", name: "mark/plain", xform: true, transformations: "rigid", object: symbolPath })).toThrow(/translations/);
    expect(compileStyleDefinition({ kind: "symbol", name: "mark/plain", xform: true, object: symbolPath }).attributes).toMatchObject({ xform: "yes", transformations: "translations" });
    expect(() => buildStylesheet("style-000000000000000000000005", "text-pair", [
      { kind: "textstyle", name: "same", type: "label", begin: "", end: "" },
      { kind: "textstyle", name: "same", type: "minipage", begin: "", end: "" },
    ])).not.toThrow();
    expect(() => buildStylesheet("style-000000000000000000000006", "text-duplicate", [
      { kind: "textstyle", name: "same", type: "label", begin: "", end: "" },
      { kind: "textstyle", name: "same", type: "label", begin: "", end: "" },
    ])).toThrow(/duplicate/);
  });

  it("checks nested object styles, arrow shape/size, conflicts and symbol cycles", () => {
    const doc = document();
    doc.stylesheets = [buildStylesheet("style-000000000000000000000001", "custom", [
      { kind: "color", name: "brand", value: [0.2, 0.4, 0.6] },
      { kind: "arrowsize", name: "smallish", value: 4 },
      { kind: "symbol", name: "arrow/triangle(spx)", object: { type: "element", name: "path", attributes: { fill: "sym-stroke" }, children: [{ type: "text", text: "0 0 m -1 1 l -1 -1 l h" }] } },
    ])];
    doc.pages = [{
      id: "page-000000000000000000000001",
      layers: [{ id: "layer-000000000000000000000001", name: "a" }],
      views: [],
      objects: [{
        id: "object-000000000000000000000001", custom: "ipe-mcp:test", layerId: "layer-000000000000000000000001", zOrder: 0,
        xml: { type: "element", name: "group", attributes: {}, children: [{ type: "element", name: "path", attributes: { stroke: "brand", arrow: "triangle/smallish" }, children: [{ type: "text", text: "0 0 m 1 1 l" }] }] },
      }],
    }];
    expect(checkStyleStructural(doc)).toEqual([]);
    doc.pages[0]!.objects[0]!.xml!.children![0] = { type: "element", name: "path", attributes: { stroke: "missing" }, children: [] };
    expect(checkStyleStructural(doc)).toMatchObject([{ code: "STYLE_UNDEFINED" }]);

    const duplicate = structuredClone(doc.stylesheets[0]!);
    duplicate.xml!.children!.push(structuredClone(duplicate.xml!.children![0]!));
    doc.stylesheets = [duplicate];
    expect(checkStyleStructural(doc).some((diagnostic) => diagnostic.code === "STYLE_CONFLICT")).toBe(true);

    const cycle = buildStylesheet("style-000000000000000000000002", "cycle", [
      { kind: "symbol", name: "cycle/a", object: { type: "element", name: "use", attributes: { name: "cycle/b" }, children: [] } },
      { kind: "symbol", name: "cycle/b", object: { type: "element", name: "use", attributes: { name: "cycle/a" }, children: [] } },
    ]);
    doc.stylesheets = [cycle];
    expect(checkStyleStructural(doc).some((diagnostic) => diagnostic.code === "SYMBOL_CYCLE")).toBe(true);

    const unsupported = { id: "style-000000000000000000000007", name: "unsupported", xml: { type: "element" as const, name: "ipestyle", attributes: {}, children: [{ type: "element" as const, name: "symbol", attributes: { name: "mark/unsupported" }, children: [{ type: "element" as const, name: "path", attributes: {}, children: [{ type: "element" as const, name: "future-object", attributes: {}, children: [] }] }] }] } };
    doc.stylesheets = [unsupported];
    expect(checkStyleStructural(doc)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OBJECT_UNSUPPORTED" })]));
  });

  it("uses an explicitly empty stylesheets array instead of falling back to the alias", () => {
    const doc = document();
    doc.stylesheets = [];
    doc.styles = [buildStylesheet("style-000000000000000000000008", "alias", [{ kind: "color", name: "alias-color", value: 0.2 }])];
    expect(() => new StyleRegistry(doc).require("color", "alias-color")).toThrow(/undefined/);
  });

  it("scopes symbol pseudo-values and still checks symbol-body styles", () => {
    const pseudoSheet = buildStylesheet("style-000000000000000000000003", "symbols", [
      { kind: "symbol", name: "mark/pseudo", object: { type: "element", name: "path", attributes: { fill: "sym-stroke", stroke: "sym-fill" }, children: [] } },
    ]);
    const layerId = "layer-000000000000000000000003";
    const base = (xml: { type: "element"; name: string; attributes: Record<string, string>; children: [] }) => ({
      id: "object-000000000000000000000003", custom: "ipe-mcp:test-style-scope", layerId, zOrder: 0, xml,
    });
    const doc = document();
    doc.stylesheets = [pseudoSheet];
    doc.pages = [{ id: "page-000000000000000000000003", layers: [{ id: layerId, name: "a" }], views: [], objects: [
      base({ type: "element", name: "path", attributes: { fill: "sym-stroke" }, children: [] }),
    ] }];
    expect(checkStyleStructural(doc).some((diagnostic) => diagnostic.path.endsWith(".fill") && diagnostic.message.includes("sym-stroke"))).toBe(true);

    doc.stylesheets = [buildStylesheet("style-000000000000000000000004", "undefined-symbol", [
      { kind: "symbol", name: "mark/undefined", object: { type: "element", name: "path", attributes: { fill: "missing-inside-symbol" }, children: [] } },
    ])];
    doc.pages[0]!.objects[0] = base({ type: "element", name: "use", attributes: { name: "mark/undefined" }, children: [] });
    const diagnostics = checkStyleStructural(doc);
    expect(diagnostics.some((diagnostic) => diagnostic.message.includes("missing-inside-symbol"))).toBe(true);

    doc.stylesheets = [pseudoSheet];
    doc.pages[0]!.objects[0] = base({ type: "element", name: "use", attributes: { name: "mark/pseudo" }, children: [] });
    expect(checkStyleStructural(doc)).toEqual([]);
  });

  it("treats only arrow/normal(spx) as the implicit symbol builtin", () => {
    const layerId = "layer-000000000000000000000005";
    const doc = document();
    doc.pages = [{
      id: "page-000000000000000000000005",
      layers: [{ id: layerId, name: "a" }],
      views: [],
      objects: [
        { id: "object-000000000000000000000005", custom: "ipe-mcp:style-builtin", layerId, zOrder: 0, xml: { type: "element", name: "use", attributes: { name: "arrow/normal(spx)" }, children: [] } },
        { id: "object-000000000000000000000006", custom: "ipe-mcp:style-builtin-unknown", layerId, zOrder: 1, xml: { type: "element", name: "use", attributes: { name: "arrow/arc(spx)" }, children: [] } },
      ],
    }];
    const diagnostics = checkStyleStructural(doc);
    expect(diagnostics.some((diagnostic) => diagnostic.message.includes("arrow/arc(spx)"))).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.message.includes("arrow/normal(spx)"))).toBe(false);
  });

  it("checks only winning symbol definitions and resolves symbol bitmap bodies", () => {
    const invalid = { type: "element" as const, name: "symbol", attributes: { name: "mark/winner" }, children: [element("future-object")] };
    const valid = { type: "element" as const, name: "symbol", attributes: { name: "mark/winner" }, children: [element("path", {}, [{ type: "text", text: "0 0 m 1 1 l" }])] };
    const doc = document();
    doc.stylesheets = [
      { id: "style-000000000000000000000009", xml: element("ipestyle", {}, [invalid]) },
      { id: "style-00000000000000000000000a", xml: element("ipestyle", {}, [valid]) },
    ];
    expect(checkStyleStructural(doc).some((diagnostic) => diagnostic.code === "OBJECT_UNSUPPORTED")).toBe(false);

    doc.stylesheets = [{ id: "style-00000000000000000000000b", xml: element("ipestyle", {}, [
      { type: "element", name: "symbol", attributes: { name: "mark/image" }, children: [element("image", { bitmap: "missing" })] },
    ]) }];
    expect(checkStyleStructural(doc)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OBJECT_UNSUPPORTED", message: expect.stringContaining("bitmap 'missing'") })]));
    doc.assets = [{ id: "asset-000000000000000000000001", xml: element("bitmap", { id: "7", width: "1", height: "1" }) }];
    doc.stylesheets = [{ id: "style-00000000000000000000000c", xml: element("ipestyle", {}, [
      { type: "element", name: "symbol", attributes: { name: "mark/image" }, children: [element("image", { bitmap: "7" })] },
    ]) }];
    expect(checkStyleStructural(doc).some((diagnostic) => diagnostic.code === "OBJECT_UNSUPPORTED")).toBe(false);
  });

  it("diagnoses ignored parameters on imported and raw use elements", () => {
    const layerId = "layer-000000000000000000000007";
    const doc = document();
    doc.pages = [{
      id: "page-000000000000000000000007",
      layers: [{ id: layerId, name: "a" }],
      views: [],
      objects: [{
        id: "object-000000000000000000000007", custom: "ipe-mcp:raw-use", layerId, zOrder: 0,
        xml: { type: "element", name: "use", attributes: { name: "mark/plain", stroke: "black" }, children: [] },
      }, {
        id: "object-000000000000000000000008", custom: "ipe-mcp:bad-suffix", layerId, zOrder: 1,
        xml: { type: "element", name: "use", attributes: { name: "mark/invalid(xs)", size: "normal" }, children: [] },
      }],
    }];
    const diagnostics = checkStyleStructural(doc);
    expect(diagnostics.some((diagnostic) => diagnostic.message.includes("does not accept stroke parameter"))).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.message.includes("unsupported parameter suffix"))).toBe(true);
  });

  it("converges in two passes, computes baseline bounds, and is atomic on divergence", async () => {
    const doc = document();
    doc.preamble = "\\usepackage{amsmath}";
    const object = buildTextObject({
      layerId: "layer-000000000000000000000001",
      identity: createObjectIdentity("00000000-0000-5000-8000-000000000001"),
      text: "$x^2$", position: { x: 10, y: 20 }, horizontalAlign: "center", verticalAlign: "baseline",
    });
    const request = textMeasurementRequest(doc, object);
    expect(request).toMatchObject({ mode: "label", source: "$x^2$", preamble: doc.preamble });
    const metrics = await resolveTextTwoPass(doc, object, { measure: () => ({ width: 8, height: 6, depth: 2 }) });
    expect(metrics).toEqual({ width: 8, height: 6, depth: 2 });
    expect(textBounds(object)).toEqual({
      status: "known",
      boxes: {
        logical: { x: 6, y: 18, width: 8, height: 8 },
        geometric: { x: 6, y: 18, width: 8, height: 8 },
        visual: { x: 6, y: 18, width: 8, height: 8 },
      },
      baselineFromBottom: 2,
    });

    const divergent = buildTextObject({ layerId: object.layerId, text: "x", position: { x: 0, y: 0 } });
    const before = structuredClone(divergent);
    let pass = 0;
    await expect(resolveTextTwoPass(doc, divergent, { measure: () => (++pass === 1 ? { width: 1, height: 1, depth: 0 } : { width: 2, height: 1, depth: 0 }) })).rejects.toThrow(/converge/);
    expect(divergent).toEqual(before);
  });
});
