import { describe, expect, it } from "vitest";

import type { DocumentIR, IpeObject } from "../../src/domain/ir.js";
import { documentSchema } from "../../src/domain/schema.js";
import { validateDocument } from "../../src/domain/validate.js";
import { objectIdFromCustom } from "../../src/domain/identity.js";

const xml = { name: "path", attributes: { stroke: "black" }, children: [{ type: "text" as const, text: "0 0 m" }] };
const layerId = "layer-000000000000000000000001";

function documentWith(objects: IpeObject[] = [{ id: "o1", layerId: "layer-1", zOrder: 0, xml }]): DocumentIR {
  return {
    schemaVersion: 1 as const,
    format: 70218 as const,
    metadata: { title: "test" },
    preamble: "\\usepackage{amsmath}",
    stylesheets: [],
    assets: [],
    extensions: { "x-test": { name: "x-test", children: [] } },
    pages: [{
      id: "page-000000000000000000000001",
      name: "intro",
      layers: [{ id: layerId, name: "base" }],
      views: [{ id: "view-000000000000000000000001", name: "normal", visibleLayerIds: [layerId], activeLayerId: layerId, marked: false, attributeMaps: [], layerTransforms: {} }],
      objects: objects.map((object, index) => {
        const custom = object.custom ?? `ipe-mcp:00000000-0000-5000-8000-${String(index).padStart(12, "0")}`;
        return { ...object, id: objectIdFromCustom(custom), custom, layerId: object.layerId === "layer-1" ? layerId : object.layerId };
      }),
    }],
  };
}

describe("M2 domain IR", () => {
  it("accepts versioned 70218 IR and preserves XML nodes", () => {
    const input = documentWith();
    expect(documentSchema.safeParse(input).success).toBe(true);
    expect(validateDocument(input).ok).toBe(true);
    expect(input.pages[0]?.objects[0]?.xml?.children?.[0]).toEqual({ type: "text", text: "0 0 m" });
  });

  it("reports a global z-order mismatch instead of throwing", () => {
    const result = validateDocument(documentWith([
      { id: "o1", layerId: "layer-1", zOrder: 1, xml },
      { id: "o2", layerId: "layer-1", zOrder: 0, xml },
    ]));
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.code === "Z_ORDER_MISMATCH" && item.path.includes("objects[0]"))).toBe(true);
  });

  it("checks active/visible layers, transforms, and reserved names", () => {
    const input = documentWith();
    input.pages[0]!.layers[0]!.name = "BBOX";
    input.pages[0]!.views[0]!.activeLayerId = "missing";
    input.pages[0]!.views[0]!.layerTransforms = { missing: [1, 0, 0, 1, 0, 0] };
    const result = validateDocument(input);
    expect(result.errors.map((item) => item.code)).toEqual(expect.arrayContaining(["LAYER_RESERVED_NAME", "ACTIVE_LAYER_MISSING", "TRANSFORM_LAYER_UNRESOLVED"]));
  });

  it("returns source omissions as warning diagnostics", () => {
    const input = documentWith();
    input.source = { omissions: [{ path: "page[0]/view", reason: "native default was omitted" }] };
    const result = validateDocument(input);
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toMatchObject({ code: "SOURCE_OMISSION", severity: "warning" });
  });

  it("rejects non-string metadata instead of silently dropping it", () => {
    const input: unknown = { ...documentWith(), metadata: { title: "valid", unsafe: { nested: true } } };
    expect(validateDocument(input).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_INVALID", path: "$.metadata.unsafe" }),
    ]));
  });

  it("rejects singular and numerically degenerate matrices", () => {
    for (const matrix of [[0, 0, 0, 0, 0, 0], [1, 1, 1, 1 + 1e-14, 0, 0]] as const) {
      const input = documentWith([{ id: "o1", layerId: "layer-1", zOrder: 0, matrix, xml }]);
      expect(validateDocument(input).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_INVALID", path: "$.pages[0].objects[0].matrix" }),
      ]));
    }
  });

  it("rejects XML 1.0-invalid strings structurally", () => {
    const input = documentWith();
    input.pages[0]!.title = "bad\0title";
    expect(validateDocument(input).errors).toContainEqual(expect.objectContaining({
      code: "SCHEMA_INVALID",
      path: "$.pages[0].title",
    }));
  });

  it("rejects a newly constructed object without persistent custom identity", () => {
    const input = documentWith();
    delete input.pages[0]!.objects[0]!.custom;
    expect(validateDocument(input).errors).toContainEqual(expect.objectContaining({
      code: "OBJECT_CUSTOM_REQUIRED",
      path: "$.pages[0].objects[0].custom",
    }));
  });

  it("treats a canonical object ID as independent from editable custom metadata", () => {
    const input = documentWith();
    input.pages[0]!.objects[0]!.id = "object-000000000000000000000001";
    input.pages[0]!.objects[0]!.custom = "editable-metadata";
    expect(validateDocument(input).errors).toEqual([]);
  });
});
