import { describe, expect, it } from "vitest";

import { checkDocumentShapeLimits, DOCUMENT_SHAPE_LIMITS, LimitsExceededError, MCP_LIMITS, SCHEMA_CAPS, type LimitDimension } from "../../src/limits.js";
import { failure } from "../../src/mcp/errors.js";
import { documentSchema } from "../../src/domain/schema.js";
import type { DocumentIR, IpeObject } from "../../src/domain/ir.js";

function documentWith(pages: number, layers: number, views: number, objects: number, assets: number): DocumentIR {
  const pagesList = Array.from({ length: pages }, (_, pageIndex) => {
    const layerIds = Array.from({ length: layers }, (_, layerIndex) => `layer-${pageIndex}-${layerIndex}`);
    return {
      id: `page-${pageIndex}`,
      layers: layerIds.map((id, layerIndex) => ({ id, name: `layer${layerIndex}`, ...(layerIndex === 0 ? { edit: false } : {}) })),
      views: Array.from({ length: views }, (_, viewIndex) => ({
        id: `view-${pageIndex}-${viewIndex}`,
        name: `view${viewIndex}`,
        visibleLayerIds: [layerIds[0]!],
        activeLayerId: layerIds[0]!,
        marked: false,
      })),
      objects: Array.from({ length: objects }, (_, objectIndex) => {
        const object: IpeObject = {
          id: `object-${pageIndex}-${objectIndex}`,
          custom: `ipe-mcp:object-${pageIndex}-${objectIndex}`,
          layerId: layerIds[objectIndex % layers]!,
          zOrder: objectIndex,
          xml: { type: "element", name: "path", attributes: {}, children: [] },
        };
        return object;
      }),
    };
  });
  return {
    schemaVersion: 1,
    format: 70218,
    pages: pagesList,
    ...(assets === 0 ? {} : { assets: Array.from({ length: assets }, (_, index) => ({ id: `asset-${index}`, hash: "x", data: `id=${index}` })) }),
  };
}

describe("document shape limits", () => {
  it("accepts every dimension exactly at its boundary", () => {
    expect(() => checkDocumentShapeLimits(documentWith(DOCUMENT_SHAPE_LIMITS.maxPages, 1, 1, 0, 0))).not.toThrow();
    expect(() => checkDocumentShapeLimits(documentWith(1, DOCUMENT_SHAPE_LIMITS.maxLayersPerPage, 1, 0, 0))).not.toThrow();
    expect(() => checkDocumentShapeLimits(documentWith(1, 1, DOCUMENT_SHAPE_LIMITS.maxViewsPerPage, 0, 0))).not.toThrow();
    expect(() => checkDocumentShapeLimits(documentWith(1, 1, 1, DOCUMENT_SHAPE_LIMITS.maxObjectsPerDocument, 0))).not.toThrow();
    expect(() => checkDocumentShapeLimits(documentWith(1, 1, 1, 0, DOCUMENT_SHAPE_LIMITS.maxAssetsPerDocument))).not.toThrow();
  });

  it("rejects every dimension one past its boundary with the specific dimension", () => {
    const cases: Array<[Parameters<typeof documentWith>, { dimension: LimitDimension }]> = [
      [[DOCUMENT_SHAPE_LIMITS.maxPages + 1, 1, 1, 0, 0], { dimension: "pages" }],
      [[1, DOCUMENT_SHAPE_LIMITS.maxLayersPerPage + 1, 1, 0, 0], { dimension: "layers" }],
      [[1, 1, DOCUMENT_SHAPE_LIMITS.maxViewsPerPage + 1, 0, 0], { dimension: "views" }],
      [[1, 1, 1, DOCUMENT_SHAPE_LIMITS.maxObjectsPerDocument + 1, 0], { dimension: "objects" }],
      [[1, 1, 1, 0, DOCUMENT_SHAPE_LIMITS.maxAssetsPerDocument + 1], { dimension: "assets" }],
    ];
    for (const [args, expected] of cases) {
      let caught: unknown;
      try { checkDocumentShapeLimits(documentWith(...args)); } catch (error) { caught = error; }
      expect(caught, `dimension ${expected.dimension} was not rejected`).toBeInstanceOf(LimitsExceededError);
      const error = caught as LimitsExceededError;
      expect(error.dimension).toBe(expected.dimension);
      expect(error.code).toBe("LIMIT_EXCEEDED");
      expect(error.actual).toBeGreaterThan(error.limit);
    }
  });

  it("counts objects across pages against the document cap", () => {
    const perPage = 60_000;
    let caught: unknown;
    try { checkDocumentShapeLimits(documentWith(2, 1, 1, perPage, 0)); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(LimitsExceededError);
    expect((caught as LimitsExceededError).dimension).toBe("objects");
  });
});

describe("limit failure redaction", () => {
  it("exposes only the dimension, limit and actual count", () => {
    const result = failure("apply_operations", new LimitsExceededError("pages", 513, 512));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("LIMIT_EXCEEDED");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.message).toContain("512");
    expect(result.error?.message).not.toContain("/tmp");
    expect(result.error?.message).not.toContain("/home");
    expect(JSON.stringify(result)).not.toMatch(/[/]$/u);
  });
});

describe("limit coherence", () => {
  it("keeps IR schema caps above the enforced document-shape caps", () => {
    expect(SCHEMA_CAPS.pages).toBeGreaterThanOrEqual(DOCUMENT_SHAPE_LIMITS.maxPages);
    expect(SCHEMA_CAPS.layersPerPage).toBeGreaterThanOrEqual(DOCUMENT_SHAPE_LIMITS.maxLayersPerPage);
    expect(SCHEMA_CAPS.viewsPerPage).toBeGreaterThanOrEqual(DOCUMENT_SHAPE_LIMITS.maxViewsPerPage);
    expect(SCHEMA_CAPS.objectsPerPage).toBeGreaterThanOrEqual(DOCUMENT_SHAPE_LIMITS.maxObjectsPerDocument);
    expect(SCHEMA_CAPS.assets).toBeGreaterThanOrEqual(DOCUMENT_SHAPE_LIMITS.maxAssetsPerDocument);
  });

  it("keeps all central limits positive safe integers", () => {
    const collectors = [MCP_LIMITS, SCHEMA_CAPS, DOCUMENT_SHAPE_LIMITS];
    for (const group of collectors) {
      for (const [name, value] of Object.entries(group)) {
        expect(Number.isSafeInteger(value) && value > 0, `${group === MCP_LIMITS ? "MCP" : group === SCHEMA_CAPS ? "SCHEMA" : "DOCUMENT"}.${name}`).toBe(true);
      }
    }
  });

  it("keeps asset payload strings under the schema text ceiling", () => {
    const schema = documentSchema.parse(documentWith(1, 1, 1, 0, 3));
    expect(schema.assets?.length).toBe(3);
  });

  it("matches the source-resource and image caps that go outside the mutation path", () => {
    expect(MCP_LIMITS.sourceResourceBytes).toBe(128 * 1024);
    expect(MCP_LIMITS.imageBase64Chars).toBeGreaterThanOrEqual(MCP_LIMITS.imageDecodedBytes * 4 / 3);
    expect(MCP_LIMITS.imageDecodedBytes).toBe(9_000_000);
  });
});
