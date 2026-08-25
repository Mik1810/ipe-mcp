import { describe, expect, it } from "vitest";

import type { DocumentIR, IpeObject } from "../../src/domain/ir.js";
import { validateDocument } from "../../src/domain/validate.js";
import { applyObjectOperations } from "../../src/objects/crud.js";
import {
  buildFittedImageObject,
  buildGroupObject,
  buildImageObject,
  buildPathObject,
  buildSymbolObject,
  buildTextObject,
} from "../../src/objects/builders.js";
import { createObjectIdentity, element } from "../../src/objects/common.js";
import { buildCompiledObject } from "../../src/objects/builders.js";

const layerId = "layer-main";
const target = { x: 10, y: 20, width: 100, height: 50 };

function identity(index: number) {
  return createObjectIdentity(`00000000-0000-5000-8000-${String(index).padStart(12, "0")}`);
}

function asset(width = "2", height = "1") {
  return {
    id: "asset-000000000000000000000001",
    kind: "bitmap",
    mediaType: "image/png",
    xml: { type: "element" as const, name: "bitmap", attributes: { id: "7", width, height } },
  };
}

function pageDocument(objects: IpeObject[] = []): DocumentIR {
  return {
    schemaVersion: 1,
    format: 70218,
    pages: [{ id: "page-main", layers: [{ id: layerId, name: "Layer 1" }], views: [], objects }],
  };
}

function path(index: number, x = 0): IpeObject {
  return buildPathObject({ layerId, identity: identity(index), path: { kind: "segment", from: { x, y: 0 }, to: { x: x + 1, y: 1 } } });
}

describe("M4 object builders and CRUD", () => {
  it("builds the five object kinds with persistent identity", () => {
    const image = buildImageObject({ layerId, identity: identity(3), asset: asset(), rect: { x: 0, y: 0, width: 2, height: 1 } });
    const objects = [
      path(1),
      buildTextObject({ layerId, identity: identity(2), text: "hello", position: { x: 1, y: 2 } }),
      image,
      buildGroupObject({ layerId, identity: identity(4), children: [path(5), buildTextObject({ layerId, identity: identity(6), text: "nested", position: { x: 0, y: 0 } })] }),
      buildSymbolObject({ layerId, identity: identity(7), name: "mark", position: { x: 3, y: 4 } }),
    ];
    expect(objects.map((object) => object.xml?.name)).toEqual(["path", "text", "image", "group", "use"]);
    for (const object of objects) {
      expect(object.id).toMatch(/^object-[0-9a-f]{24}$/u);
      expect(object.custom).toMatch(/^ipe-mcp:/u);
    }
    expect(image.references).toEqual([{ kind: "asset", id: asset().id }]);
  });

  it("enforces parameterized symbol use attributes", () => {
    expect(() => buildSymbolObject({ layerId, name: "mark/stroke(s)", stroke: "black" })).not.toThrow();
    expect(() => buildSymbolObject({ layerId, name: "mark/stroke(s)", fill: "black" })).toThrow(/fill parameter/);
    expect(() => buildSymbolObject({ layerId, name: "mark/fill(f)", fill: "black" })).not.toThrow();
    expect(() => buildSymbolObject({ layerId, name: "mark/fill(f)", stroke: "black" })).toThrow(/stroke parameter/);
    expect(() => buildSymbolObject({ layerId, name: "mark/size(sx)", size: 12 })).not.toThrow();
    expect(() => buildSymbolObject({ layerId, name: "mark/size(s)", size: 12 })).toThrow(/size parameter/);
    expect(() => buildSymbolObject({ layerId, name: "mark/plain", stroke: "black" })).toThrow(/stroke parameter/);
    expect(() => buildSymbolObject({ layerId, name: "mark/invalid(xs)", size: 12 })).toThrow(/unsupported parameter suffix/);
  });

  it("resolves the true builtin arrow symbol during domain validation", () => {
    const doc = pageDocument([buildSymbolObject({ layerId, identity: identity(8), name: "arrow/normal(spx)" })]);
    const diagnostics = validateDocument(doc).diagnostics;
    expect(diagnostics.some((diagnostic) => diagnostic.code === "REF_UNRESOLVED" && diagnostic.message.includes("arrow/normal(spx)"))).toBe(false);
  });

  it("applies z-order CRUD operations and preserves replacement identity", () => {
    const [first, second] = [path(10), path(11, 2)];
    const doc = pageDocument([first, second]);
    const inserted = path(12, 4);
    const insertedResult = applyObjectOperations(doc, "page-main", [{ op: "insert", object: inserted, position: { kind: "back" } }]);
    expect(insertedResult.objectIdsBackToFront).toEqual([inserted.id, first.id, second.id]);
    expect(doc.pages[0]!.objects.map((object) => object.zOrder)).toEqual([0, 1, 2]);

    const replacement = buildTextObject({ layerId, identity: identity(13), text: "replacement", position: { x: 9, y: 9 } });
    applyObjectOperations(doc, "page-main", [{ op: "replace", objectId: first.id, replacement }]);
    expect(doc.pages[0]!.objects[1]).toMatchObject({ id: first.id, custom: first.custom, zOrder: 1, xml: { name: "text" } });
    const freeReplacement = path(14, 8);
    applyObjectOperations(doc, "page-main", [{ op: "replace", objectId: second.id, replacement: freeReplacement, preserveIdentity: false }]);
    expect(doc.pages[0]!.objects[2]!.id).toBe(freeReplacement.id);
    applyObjectOperations(doc, "page-main", [{ op: "move", objectId: inserted.id, position: { kind: "front" } }, { op: "layer", objectId: inserted.id, layerId }]);
    expect(doc.pages[0]!.objects.at(-1)!.id).toBe(inserted.id);
  });

  it("duplicates with fresh identity and rolls back a failed batch atomically", () => {
    const original = path(20);
    const doc = pageDocument([original]);
    const duplicate = applyObjectOperations(doc, "page-main", [{ op: "duplicate", objectId: original.id }]);
    expect(duplicate.objectIdsBackToFront).toHaveLength(2);
    expect(duplicate.objectIdsBackToFront[1]).not.toBe(original.id);
    const before = structuredClone(doc.pages[0]!.objects);
    expect(() => applyObjectOperations(doc, "page-main", [
      { op: "insert", object: path(21), position: { kind: "front" } },
      { op: "layer", objectId: original.id, layerId: "missing-layer" },
    ])).toThrow(/does not exist/);
    expect(doc.pages[0]!.objects).toEqual(before);
    expect(() => applyObjectOperations(doc, "page-main", [{ op: "duplicate", objectId: original.id, identity: identity(20) }])).toThrow(/duplicate object ID/);
    expect(doc.pages[0]!.objects).toEqual(before);
  });

  it("enforces contiguous same-layer grouping and reversible ungrouping", () => {
    const first = path(30);
    const second = buildTextObject({ layerId, identity: identity(31), text: "two", position: { x: 2, y: 2 } });
    const third = path(32, 3);
    const doc = pageDocument([first, second, third]);
    const grouped = applyObjectOperations(doc, "page-main", [{ op: "group", objectIds: [first.id, second.id] }]);
    const group = doc.pages[0]!.objects[0]!;
    expect(group.xml?.name).toBe("group");
    expect(group.xml?.children).toHaveLength(2);
    expect(grouped.objectIdsBackToFront).toEqual([group.id, third.id]);
    const carrier = group.xml!.children![0] as { attributes?: Record<string, string>; children?: Array<{ attributes?: Record<string, string> }> };
    expect(carrier.attributes).toMatchObject({ custom: `ipe-mcp:nested-id:${first.id}` });
    expect(carrier.children?.[0]?.attributes).toMatchObject({ custom: first.custom, "x-ipe-mcp-id": first.id });
    applyObjectOperations(doc, "page-main", [{ op: "ungroup", objectId: group.id }]);
    expect(doc.pages[0]!.objects.map((object) => object.id)).toEqual([first.id, second.id, third.id]);
    expect(() => applyObjectOperations(pageDocument([first, third, second]), "page-main", [{ op: "group", objectIds: [first.id, second.id] }])).toThrow(/contiguous/);
    const clipped = pageDocument([first, second]);
    applyObjectOperations(clipped, "page-main", [{ op: "group", objectIds: [first.id, second.id], clip: { kind: "rectangle", x: 0, y: 0, width: 1, height: 1 } }]);
    expect(() => applyObjectOperations(clipped, "page-main", [{ op: "ungroup", objectId: clipped.pages[0]!.objects[0]!.id }])).toThrow(/clip/);

    const image = buildImageObject({ layerId, identity: identity(33), asset: asset(), rect: { x: 0, y: 0, width: 2, height: 1 } });
    const symbol = buildSymbolObject({ layerId, identity: identity(34), name: "mark/test" });
    const referenced = pageDocument([image, symbol]);
    referenced.assets = [asset()];
    applyObjectOperations(referenced, "page-main", [{ op: "group", objectIds: [image.id, symbol.id] }]);
    applyObjectOperations(referenced, "page-main", [{ op: "ungroup", objectId: referenced.pages[0]!.objects[0]!.id }]);
    expect(referenced.pages[0]!.objects[0]).toMatchObject({ assetId: asset().id, references: [{ kind: "asset", id: asset().id }] });
    expect(referenced.pages[0]!.objects[1]).toMatchObject({ symbolId: "mark/test", references: [{ kind: "symbol", id: "mark/test" }] });
  });

  it("rejects grouping when a selected child has an external object reference atomically", () => {
    const first = path(300);
    const second = path(301, 2);
    first.references = [{ kind: "object", id: second.id }];
    const document = pageDocument([first, second]);
    const before = structuredClone(document.pages[0]!.objects);
    expect(() => applyObjectOperations(document, "page-main", [{ op: "group", objectIds: [first.id, second.id] }])).toThrow(/per-child references cannot be preserved/);
    expect(document.pages[0]!.objects).toEqual(before);
  });

  it("requires typed group children to belong to the requested layer", () => {
    const otherLayer = buildPathObject({
      layerId: "layer-other",
      identity: identity(35),
      path: { kind: "segment", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
    });
    expect(() => buildGroupObject({ layerId, children: [path(36), otherLayer] })).toThrow(/group.*layer/);
  });

  it("rejects ungrouping an externally referenced group and preserves batch atomicity", () => {
    const first = path(48);
    const second = path(49, 2);
    const group = buildGroupObject({ layerId, identity: identity(50), children: [first, second] });
    const referrer = path(51, 4);
    referrer.references = [{ kind: "object", id: group.id }];
    const document = pageDocument([group, referrer]);
    const before = structuredClone(document.pages[0]!.objects);

    expect(() => applyObjectOperations(document, "page-main", [{ op: "ungroup", objectId: group.id }])).toThrow(/still referenced/);
    expect(document.pages[0]!.objects).toEqual(before);
    expect(() => applyObjectOperations(document, "page-main", [
      { op: "ungroup", objectId: group.id },
      { op: "delete", objectId: referrer.id },
    ])).toThrow(/still referenced/);
    expect(document.pages[0]!.objects).toEqual(before);

    const ordered = pageDocument([buildGroupObject({ layerId, identity: identity(52), children: [path(53), path(54, 2)] }), path(55, 4)]);
    const orderedGroup = ordered.pages[0]!.objects[0]!;
    const orderedReferrer = ordered.pages[0]!.objects[1]!;
    orderedReferrer.references = [{ kind: "object", id: orderedGroup.id }];
    expect(() => applyObjectOperations(ordered, "page-main", [
      { op: "delete", objectId: orderedReferrer.id },
      { op: "ungroup", objectId: orderedGroup.id },
    ])).not.toThrow();
    expect(ordered.pages[0]!.objects.map((object) => object.id)).toHaveLength(2);
  });

  it("represents fitted cover images as clipped groups", () => {
    const fitted = buildFittedImageObject({ layerId, identity: identity(40), asset: asset("1", "2"), target, fit: "cover" });
    expect(fitted.xml?.name).toBe("group");
    expect(fitted.xml?.attributes?.clip).toBe("10 20 m 110 20 l 110 70 l 10 70 l h");
    const wrapper = fitted.xml?.children?.[0] as { name: string; children?: Array<{ name: string; attributes?: Record<string, string> }> };
    expect(wrapper.name).toBe("group");
    const child = wrapper.children?.[0]!;
    expect(child.name).toBe("image");
    expect(child.attributes?.rect).toBe("10 -55 110 145");
    expect(fitted.references).toEqual([{ kind: "asset", id: asset().id }]);
  });

  it("requires closed-only clips and rejects opacity on use objects", () => {
    expect(() => buildGroupObject({
      layerId,
      children: [path(41), path(42, 2)],
      clip: { kind: "segment", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
    })).toThrow(/closed/);
    expect(() => buildCompiledObject(element("use", { name: "mark/test", opacity: "half" }), { layerId })).toThrow(/opacity/);
    expect(() => buildCompiledObject(element("use", { name: "mark/test", "stroke-opacity": "half" }), { layerId })).toThrow(/opacity/);
  });

  it("registers group decoration symbols as references and rejects missing inserts", () => {
    const decorated = buildGroupObject({ layerId, children: [path(56), path(57, 2)], decoration: "mark/decor" });
    expect(decorated.references).toEqual([{ kind: "symbol", id: "mark/decor" }]);
    const document = pageDocument();
    expect(() => applyObjectOperations(document, "page-main", [{ op: "insert", object: decorated }])).toThrow(/symbol reference 'mark\/decor'/);
    document.stylesheets = [{ id: "style-main", xml: element("ipestyle", {}, [element("symbol", { name: "mark/decor" })]) }];
    expect(() => applyObjectOperations(document, "page-main", [{ op: "insert", object: decorated }])).not.toThrow();
  });

  it("derives and validates references in raw nested image/use XML", () => {
    const raw = buildGroupObject({
      layerId,
      children: [
        element("image", { bitmap: "7", rect: "0 0 2 1" }),
        element("use", { name: "mark/raw" }),
      ],
    });
    expect(raw.references).toEqual([{ kind: "symbol", id: "mark/raw" }]);

    const valid = pageDocument();
    valid.assets = [asset()];
    valid.stylesheets = [{ id: "style-raw", xml: element("ipestyle", {}, [element("symbol", { name: "mark/raw" })]) }];
    expect(() => applyObjectOperations(valid, "page-main", [{ op: "insert", object: raw }])).not.toThrow();
    expect(new Set(valid.pages[0]!.objects[0]!.references?.map((reference) => `${reference.kind}:${reference.id}`))).toEqual(new Set(["asset:asset-000000000000000000000001", "symbol:mark/raw"]));

    const missingAsset = pageDocument();
    missingAsset.stylesheets = valid.stylesheets;
    expect(() => applyObjectOperations(missingAsset, "page-main", [{ op: "insert", object: raw }])).toThrow(/nested image bitmap '7'/);

    const missingSymbol = pageDocument();
    missingSymbol.assets = [asset()];
    expect(() => applyObjectOperations(missingSymbol, "page-main", [{ op: "insert", object: raw }])).toThrow(/symbol reference 'mark\/raw'/);

    expect(() => buildGroupObject({ layerId, children: [element("future-object", {})] })).toThrow(/unsupported object tag 'future-object'/);
    const invalidBitmap = buildGroupObject({ layerId, children: [element("image", { bitmap: "999", rect: "0 0 2 1" })] });
    const imported = pageDocument([invalidBitmap]);
    imported.assets = [asset()];
    expect(validateDocument(imported).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OBJECT_XML_UNSUPPORTED", message: expect.stringContaining("bitmap '999'") }),
    ]));
  });

  it("rejects lossy raw object content and validates the final candidate atomically", () => {
    expect(() => buildGroupObject({ layerId, children: [element("path", { layer: "wrong" }, [{ type: "text", text: "0 0 m" }])] })).toThrow(/nested object cannot carry layer/);
    expect(() => buildGroupObject({ layerId, children: [element("path", { future: "drop-me" }, [{ type: "text", text: "0 0 m" }])] })).toThrow(/unsupported attribute/);
    expect(() => buildGroupObject({ layerId, children: [element("group", {}, [{ type: "text", text: "significant" }])] })).toThrow(/significant/);

    const document = pageDocument([path(70)]);
    const before = structuredClone(document.pages[0]!.objects);
    const customless = path(71);
    delete customless.custom;
    expect(() => applyObjectOperations(document, "page-main", [{ op: "insert", object: customless }])).toThrow(/custom identity/);
    expect(document.pages[0]!.objects).toEqual(before);
    const singular = path(72);
    singular.matrix = [0, 0, 0, 0, 0, 0] as const;
    expect(() => applyObjectOperations(document, "page-main", [{ op: "insert", object: singular }])).toThrow(/matrix/);
    expect(document.pages[0]!.objects).toEqual(before);
  });

  it("rejects ungrouping unknown group attributes while consuming managed metadata", () => {
    const unknown = buildGroupObject({ layerId, children: [path(58), path(59, 2)] });
    unknown.xml!.attributes!.future = "cannot-drop";
    const rejected = pageDocument([unknown]);
    const before = structuredClone(rejected.pages[0]!.objects);
    expect(() => applyObjectOperations(rejected, "page-main", [{ op: "ungroup", objectId: unknown.id }])).toThrow(/attribute 'future'.*cannot be preserved/);
    expect(rejected.pages[0]!.objects).toEqual(before);

    const safe = buildGroupObject({ layerId, children: [path(60), path(61, 2)], matrix: [1, 0, 0, 1, 3, 4] });
    safe.xml!.attributes = { layer: "Layer 1", matrix: "1 0 0 1 3 4", custom: safe.custom!, "x-ipe-mcp-id": safe.id };
    const accepted = pageDocument([safe]);
    expect(() => applyObjectOperations(accepted, "page-main", [{ op: "ungroup", objectId: safe.id }])).not.toThrow();

    const significantText = buildGroupObject({ layerId, children: [path(62), path(63, 2)] });
    significantText.xml!.children!.push({ type: "text", text: "must-preserve" });
    const textDocument = pageDocument([significantText]);
    const beforeText = structuredClone(textDocument.pages[0]!.objects);
    expect(() => applyObjectOperations(textDocument, "page-main", [{ op: "ungroup", objectId: significantText.id }])).toThrow(/non-element.*preserved/);
    expect(textDocument.pages[0]!.objects).toEqual(beforeText);

    const comment = buildGroupObject({ layerId, children: [path(64), path(65, 2)] });
    comment.xml!.children!.push({ type: "comment", text: "must-preserve" });
    expect(() => applyObjectOperations(pageDocument([comment]), "page-main", [{ op: "ungroup", objectId: comment.id }])).toThrow(/non-element.*preserved/);
  });

  it("rejects replace references that would dangle after identity is changed", () => {
    const original = path(43);
    const replacement = buildTextObject({ layerId, identity: identity(44), text: "bad", position: { x: 0, y: 0 } });
    replacement.references = [{ kind: "object", id: original.id }];
    const doc = pageDocument([original]);
    expect(() => applyObjectOperations(doc, "page-main", [{ op: "replace", objectId: original.id, replacement, preserveIdentity: false }])).toThrow(/object reference/);
    expect(doc.pages[0]!.objects).toEqual([original]);

    const unresolvedInsert = path(45);
    unresolvedInsert.references = [{ kind: "object", id: "object-ffffffffffffffffffffffff" }];
    expect(() => applyObjectOperations(doc, "page-main", [{ op: "insert", object: unresolvedInsert }])).toThrow(/does not resolve/);
    expect(doc.pages[0]!.objects).toEqual([original]);

    const referrer = path(46);
    referrer.references = [{ kind: "object", id: original.id }];
    const referenced = pageDocument([original, referrer]);
    const freeReplacement = path(47, 4);
    expect(() => applyObjectOperations(referenced, "page-main", [{ op: "replace", objectId: original.id, replacement: freeReplacement, preserveIdentity: false }])).toThrow(/still referenced/);
    expect(referenced.pages[0]!.objects.map((object) => object.id)).toEqual([original.id, referrer.id]);
  });
});
