import { describe, expect, it } from "vitest";

import { ipeDocumentCodec } from "../../src/core/ipe-document-codec.js";
import { validateDocument } from "../../src/domain/validate.js";
import { applyObjectOperations, buildCompiledObject, element } from "../../src/objects/index.js";
import { assertIpePathPayload } from "../../src/objects/content-model.js";

const identity = "ipe-mcp:00000000-0000-5000-8000-000000000001";
const objectId = "object-000000000000000000000001";

function pathPayload(text: string) {
  return element("path", {}, [{ type: "text", text }]);
}

function documentWithPath(text: string) {
  const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"/></page></ipe>');
  const page = document.pages[0]!;
  page.objects = [{ id: objectId, custom: identity, layerId: page.layers[0]!.id, zOrder: 0, xml: pathPayload(text) }];
  return document;
}

describe("raw Ipe path payload grammar", () => {
  it("rejects prose, unknown operators, bad arity, and invalid subpath state", () => {
    for (const payload of [
      "this is not an Ipe path",
      "0 0 m 1 1 z",
      "0 m",
      "0 0 m 1 l",
      "1 1 l",
      "0 0 m h",
      "0 0 m 1 1 m",
      "0 0 m 1 1 l 0 0 0 0 0 0 a",
      "0 0 m 1 1",
    ]) {
      expect(() => buildCompiledObject(pathPayload(payload), { layerId: "layer-main" })).toThrow(/path|operator|token|operands|move|trailing/u);
    }
  });

  it("accepts the supported current and historical operator corpus", () => {
    expect(() => assertIpePathPayload(
      "0 0 m 1 1 l 2 2 3 3 c 1 1 2 2 q 1 0 0 1 5 5 6 6 a "
      + "1 0 0 1 5 5 e 0 0 1 1 2 2 u "
      + "0 0 m 1 1 2 2 s 3 3 0.5 C 5 5 6 6 L h "
      + "0 0 m 1 1 2 2 * 3 3 4 4 L",
    )).not.toThrow();
  });

  it("accepts open curves terminated by e/u and rejects empty or degenerate curves", () => {
    expect(() => assertIpePathPayload("0 0 m 1 1 l 1 0 0 1 5 5 e")).not.toThrow();
    expect(() => assertIpePathPayload("0 0 m 1 1 l 0 0 1 1 2 2 u")).not.toThrow();
    expect(() => assertIpePathPayload("0 0 m 1 1 l 2 2 m 3 3 l")).not.toThrow();
    for (const payload of ["0 0 m h", "0 0 m 1 1 m", "0 0 m 1 1 * 2 2 L", "0 0 m 1 0 0 1 2 2 e", "0 0 m 1 0 0 1 2 2 3 3 u", "1 0 0 0 0 0 e", "0 0 m 1 0 0 0 0 0 1 1 a"]) {
      expect(() => assertIpePathPayload(payload)).toThrow(/empty|subpath|matrix|marker/u);
    }
  });

  it("uses ASCII path whitespace and stable XML character diagnostics", () => {
    expect(() => assertIpePathPayload("0\u00a00 m")).toThrow(/unknown operator|invalid token/u);
    expect(() => assertIpePathPayload("\u00a00 0 m")).toThrow(/unknown operator|invalid token/u);
    expect(() => assertIpePathPayload("0 0 m\u00001 1 l")).toThrow("XML 1.0-invalid");
  });

  it("rejects malformed paths through domain validation and serialization", () => {
    const document = documentWithPath("0 0 m 1 1 z");
    const validation = validateDocument(document);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((error) => error.code === "OBJECT_XML_UNSUPPORTED" && error.message.includes("unknown operator"))).toBe(true);
    expect(() => ipeDocumentCodec.serialize(document)).toThrow(/unknown operator/u);
  });

  it("rejects an invalid insertion before mutating the caller document", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"/></page></ipe>');
    const page = document.pages[0]!;
    const malformed = {
      id: objectId,
      custom: identity,
      layerId: page.layers[0]!.id,
      zOrder: 0,
      xml: pathPayload("0 0 m 1 1 z"),
    };
    expect(() => applyObjectOperations(document, page.id, [{ op: "insert", object: malformed }])).toThrow(/unknown operator/u);
    expect(page.objects).toEqual([]);
  });
});
