import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { ipeDocumentCodec } from "../../src/core/ipe-document-codec.js";
import { buildGroupObject, buildImageObject, buildPathObject, buildSymbolObject, buildTextObject } from "../../src/objects/builders.js";
import { applyObjectOperations } from "../../src/objects/crud.js";
import { addBitmapAsset } from "../../src/objects/assets.js";
import { createObjectIdentity } from "../../src/objects/common.js";
import type { DocumentIR } from "../../src/domain/ir.js";

const nativeIpetoipe = spawnSync("ipetoipe", ["-help"], { stdio: "ignore" }).error === undefined;

describe("M4 object reference and nested identity round-trip", () => {
  it("rehydrates asset and symbol references after serialize/reload", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><bitmap id="1" width="1" height="1">ffffff</bitmap><ipestyle><symbol name="mark/test"><path fill="black">1 0 0 1 0 0 e</path></symbol></ipestyle><page><layer name="a"/><view layers="a" active="a"/></page></ipe>');
    const layerId = document.pages[0]!.layers[0]!.id;
    const asset = document.assets![0]!;
    document.pages[0]!.objects = [
      buildImageObject({ layerId, asset, rect: { x: 0, y: 0, width: 1, height: 1 } }),
      buildSymbolObject({ layerId, name: "mark/test", position: { x: 2, y: 2 } }),
    ];
    document.pages[0]!.objects.forEach((object, index) => { object.zOrder = index; });
    const reloaded = ipeDocumentCodec.parse(ipeDocumentCodec.serialize(document));
    expect(reloaded.pages[0]!.objects[0]).toMatchObject({ assetId: asset.id, references: [{ kind: "asset", id: asset.id }] });
    expect(reloaded.pages[0]!.objects[1]).toMatchObject({ symbolId: "mark/test", references: [{ kind: "symbol", id: "mark/test" }] });
  });

  it.skipIf(!nativeIpetoipe)("keeps a manual object ID when native Ipe drops x-ipe-mcp-id and custom is edited", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"/></page></ipe>');
    const page = document.pages[0]!;
    page.objects = [{
      id: "object-000000000000000000000099",
      custom: "edited-by-user",
      layerId: page.layers[0]!.id,
      zOrder: 0,
      xml: { type: "element", name: "path", attributes: {}, children: [{ type: "text", text: "0 0 m 1 1 l" }] },
    }];
    const temporary = mkdtempSync(`${tmpdir()}/ipe-mcp-m4-object-id-`);
    const source = `${temporary}/source.ipe`;
    const native = `${temporary}/native.ipe`;
    try {
      writeFileSync(source, ipeDocumentCodec.serialize(document));
      execFileSync("ipetoipe", ["-xml", source, native], { stdio: "ignore" });
      const reloaded = ipeDocumentCodec.parse(readFileSync(native));
      expect(reloaded.pages[0]!.objects[0]).toMatchObject({ id: page.objects[0]!.id, custom: "edited-by-user" });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("stores nested identity in a native-preserved carrier independent of custom metadata", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"/></page></ipe>');
    const layerId = document.pages[0]!.layers[0]!.id;
    const first = buildSymbolObject({ layerId, name: "mark/a" });
    const second = buildSymbolObject({ layerId, name: "mark/b" });
    first.custom = "legacy";
    second.custom = "legacy";
    const expected = [first.id, second.id];
    const group = buildGroupObject({ layerId, children: [first, second] });
    document.pages[0]!.objects = [group];
    const nativeLike = ipeDocumentCodec.serialize(document).replaceAll(/ x-ipe-mcp-id="[^"]+"/gu, "");
    const reloaded = ipeDocumentCodec.parse(nativeLike);
    applyObjectOperations(reloaded, reloaded.pages[0]!.id, [{ op: "ungroup", objectId: reloaded.pages[0]!.objects[0]!.id }]);
    expect(reloaded.pages[0]!.objects.map((object) => object.id)).toEqual(expected);
    expect(reloaded.pages[0]!.objects.map((object) => object.custom)).toEqual(["legacy", "legacy"]);
  });

  it("unwraps exactly one carrier level when an original group custom resembles the reserved marker", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"/></page></ipe>');
    const layerId = document.pages[0]!.layers[0]!.id;
    const leaf = buildSymbolObject({ layerId, name: "mark/leaf" });
    const original = buildGroupObject({ layerId, children: [leaf] });
    original.custom = `ipe-mcp:nested-id:${leaf.id}`;
    const parent = buildGroupObject({ layerId, children: [original] });
    document.pages[0]!.objects = [parent];
    applyObjectOperations(document, document.pages[0]!.id, [{ op: "ungroup", objectId: parent.id }]);
    expect(document.pages[0]!.objects).toHaveLength(1);
    expect(document.pages[0]!.objects[0]).toMatchObject({ id: original.id, xml: { name: "group" } });
  });

  it.skipIf(!nativeIpetoipe)("keeps duplicated nested identities through native canonicalization and ungroup", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"/></page></ipe>');
    const page = document.pages[0]!;
    const first = buildPathObject({ layerId: page.layers[0]!.id, identity: createObjectIdentity("00000000-0000-5000-8000-000000000011"), path: { kind: "segment", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } } });
    const second = buildTextObject({ layerId: page.layers[0]!.id, identity: createObjectIdentity("00000000-0000-5000-8000-000000000012"), text: "x", position: { x: 2, y: 3 } });
    const original = buildGroupObject({ layerId: page.layers[0]!.id, children: [first, second] });
    page.objects = [original];
    const duplicateIdentity = createObjectIdentity("00000000-0000-5000-8000-000000000013");
    applyObjectOperations(document, page.id, [{ op: "duplicate", objectId: original.id, identity: duplicateIdentity }]);
    const duplicateId = page.objects[1]!.id;
    applyObjectOperations(document, page.id, [{ op: "ungroup", objectId: original.id }, { op: "ungroup", objectId: duplicateId }]);
    const expected = page.objects.map((object) => ({ id: object.id, custom: object.custom, type: object.xml?.name }));

    const temporary = mkdtempSync(`${tmpdir()}/ipe-mcp-m4-`);
    const source = `${temporary}/source.ipe`;
    const native = `${temporary}/native.ipe`;
    try {
      writeFileSync(source, ipeDocumentCodec.serialize(document));
      execFileSync("ipetoipe", ["-xml", source, native], { stdio: "ignore" });
      const reloaded = ipeDocumentCodec.parse(readFileSync(native));
      expect(reloaded.pages[0]!.objects.map((object) => ({ id: object.id, custom: object.custom, type: object.xml?.name }))).toEqual(expected);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it.skipIf(!nativeIpetoipe)("normalizes semantic bitmap IDs and rewrites duplicate native references", () => {
    const seed: DocumentIR = { schemaVersion: 1, format: 70218, pages: [] };
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([255, 0, 0, 255]);
    const encoded = addBitmapAsset(seed, PNG.sync.write(png), "image/png");
    const bitmap = encoded.asset.xml!;
    const body = (bitmap.children?.[0] as { type: "text"; text: string }).text;
    const attributes = (id: string, managedId: string) => Object.entries({ ...bitmap.attributes, id, "x-ipe-mcp-id": managedId })
      .map(([name, value]) => `${name}="${value}"`).join(" ");
    const source = `<ipe version="70218"><bitmap ${attributes("1", "asset-not-the-content-hash-a")}>${body}</bitmap><bitmap ${attributes("2", "asset-not-the-content-hash-b")}>${body}</bitmap><page><layer name="a"/><view layers="a" active="a"/><image bitmap="1" rect="0 0 1 1" custom="ipe-mcp:11111111-1111-4111-8111-111111111111"/><image bitmap="2" rect="1 0 2 1" custom="ipe-mcp:22222222-2222-4222-8222-222222222222"/></page></ipe>`;
    const parsed = ipeDocumentCodec.parse(source);
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets![0]!.id).toBe(encoded.asset.id);
    expect(parsed.pages[0]!.objects.map((object) => object.assetId)).toEqual([encoded.asset.id, encoded.asset.id]);
    expect(parsed.pages[0]!.objects.map((object) => object.xml?.attributes?.bitmap)).toEqual(["1", "1"]);
    const canonical = ipeDocumentCodec.serialize(parsed);
    expect(canonical.match(/<bitmap\b/gu)).toHaveLength(1);
    expect(canonical).not.toContain('bitmap="2"');

    const temporary = mkdtempSync(`${tmpdir()}/ipe-mcp-m4-assets-`);
    const sourcePath = `${temporary}/source.ipe`;
    const nativePath = `${temporary}/native.ipe`;
    try {
      writeFileSync(sourcePath, canonical);
      execFileSync("ipetoipe", ["-xml", sourcePath, nativePath], { stdio: "ignore" });
      const native = ipeDocumentCodec.parse(readFileSync(nativePath));
      expect(native.assets).toHaveLength(1);
      expect(native.assets![0]!.id).toBe(encoded.asset.id);
      expect(native.pages[0]!.objects.map((object) => object.assetId)).toEqual([encoded.asset.id, encoded.asset.id]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it.skipIf(!nativeIpetoipe)("preserves semantic identity when native canonicalization converts hex JPEG payloads", () => {
    const fixture = readFileSync(new URL("../../fixtures/conformance/m4/golden/m4-object-primitive-matrix.ipe", import.meta.url), "utf8");
    const match = fixture.match(/<bitmap id="2"[^>]*>([^<]+)<\/bitmap>/u);
    if (!match) throw new Error("golden JPEG bitmap is missing");
    const bytes = Buffer.from(match[1]!, "base64");
    const hex = bytes.toString("hex");
    const source = `<ipe version="70218"><bitmap id="7" width="2" height="2" ColorSpace="DeviceRGB" Filter="DCTDecode" length="${bytes.length}" x-ipe-mcp-id="asset-hex-mismatch">${hex}</bitmap><page><layer name="a"/><view layers="a" active="a"/><image bitmap="7" rect="0 0 2 2" custom="ipe-mcp:33333333-3333-4333-8333-333333333333"/></page></ipe>`;
    const parsed = ipeDocumentCodec.parse(source);
    const semanticId = parsed.assets![0]!.id;
    expect(semanticId).toMatch(/^asset-[0-9a-f]{24}$/u);
    expect(parsed.pages[0]!.objects[0]!.assetId).toBe(semanticId);

    const temporary = mkdtempSync(`${tmpdir()}/ipe-mcp-m4-hex-jpeg-`);
    const sourcePath = `${temporary}/source.ipe`;
    const nativePath = `${temporary}/native.ipe`;
    try {
      writeFileSync(sourcePath, ipeDocumentCodec.serialize(parsed));
      execFileSync("ipetoipe", ["-xml", sourcePath, nativePath], { stdio: "ignore" });
      const native = ipeDocumentCodec.parse(readFileSync(nativePath));
      expect(native.assets![0]!.id).toBe(semanticId);
      expect(native.pages[0]!.objects[0]!.assetId).toBe(semanticId);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("does not semantically deduplicate fake or declaration-mismatched JPEG payloads", () => {
    const fixture = readFileSync(new URL("../../fixtures/conformance/m4/golden/m4-object-primitive-matrix.ipe", import.meta.url), "utf8");
    const match = fixture.match(/<bitmap id="2"[^>]*>([^<]+)<\/bitmap>/u);
    if (!match) throw new Error("golden JPEG bitmap is missing");
    const bytes = Buffer.from(match[1]!, "base64");
    const encoded = bytes.toString("base64");
    const fake = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const source = `<ipe version="70218"><bitmap id="1" width="2" height="2" ColorSpace="DeviceRGB" Filter="DCTDecode" encoding="base64" length="${bytes.length}">${encoded}</bitmap><bitmap id="2" width="9" height="9" ColorSpace="DeviceGray" Filter="DCTDecode" encoding="base64" length="${bytes.length}">${encoded}</bitmap><bitmap id="3" width="1" height="1" ColorSpace="DeviceRGB" Filter="DCTDecode" encoding="base64" length="4">${fake}</bitmap><page><layer name="a"/><view layers="a" active="a"/></page></ipe>`;
    const parsed = ipeDocumentCodec.parse(source);
    expect(parsed.assets).toHaveLength(3);
    expect(parsed.assets!.map((asset) => asset.hash)).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/u), undefined, undefined]);
  });

  it("normalizes DeviceGray and DeviceGrayAlpha Flate bitmaps to the RGBA semantic hash", () => {
    const gray = new PNG({ width: 2, height: 1 });
    gray.data.set([128, 128, 128, 255, 64, 64, 64, 127]);
    const expected = { schemaVersion: 1 as const, format: 70218 as const, pages: [] };
    const expectedAsset = addBitmapAsset(expected, PNG.sync.write(gray), "image/png").asset;
    const colors = deflateSync(Buffer.from([128, 64]));
    const alpha = deflateSync(Buffer.from([255, 127]));
    const source = `<ipe version="70218"><bitmap id="1" width="2" height="1" ColorSpace="DeviceGrayAlpha" Filter="FlateDecode" encoding="base64" length="${colors.length}" alphaLength="${alpha.length}">${Buffer.concat([colors, alpha]).toString("base64")}</bitmap><page><layer name="a"/><view layers="a" active="a"/><image bitmap="1" rect="0 0 2 1" custom="ipe-mcp:44444444-4444-4444-8444-444444444444"/></page></ipe>`;
    const parsed = ipeDocumentCodec.parse(source);
    expect(parsed.assets![0]!.id).toBe(expectedAsset.id);
    expect(parsed.pages[0]!.objects[0]!.assetId).toBe(expectedAsset.id);
  });

  it("does not semantically deduplicate contradictory Flate alpha declarations", () => {
    const colors = deflateSync(Buffer.from([255, 0, 0]));
    const alpha = deflateSync(Buffer.from([127]));
    const source = `<ipe version="70218"><bitmap id="1" width="1" height="1" ColorSpace="DeviceRGB" Filter="FlateDecode" encoding="base64" length="${colors.length}" alphaLength="${alpha.length}">${Buffer.concat([colors, alpha]).toString("base64")}</bitmap><bitmap id="2" width="1" height="1" ColorSpace="DeviceRGBAlpha" Filter="FlateDecode" encoding="base64" length="${colors.length}">${colors.toString("base64")}</bitmap><page><layer name="a"/><view layers="a" active="a"/></page></ipe>`;
    const parsed = ipeDocumentCodec.parse(source);
    expect(parsed.assets).toHaveLength(2);
    expect(parsed.assets!.map((asset) => asset.hash)).toEqual([undefined, undefined]);
  });

  it.skipIf(!nativeIpetoipe)("preserves generated grayscale PNG identity after native DeviceGray canonicalization", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"/></page></ipe>');
    const page = document.pages[0]!;
    const gray = new PNG({ width: 1, height: 1 });
    gray.data.set([127, 127, 127, 255]);
    const encoded = addBitmapAsset(document, PNG.sync.write(gray), "image/png");
    page.objects = [buildImageObject({ layerId: page.layers[0]!.id, asset: encoded.asset, rect: { x: 0, y: 0, width: 1, height: 1 } })];
    const temporary = mkdtempSync(`${tmpdir()}/ipe-mcp-m4-gray-`);
    const sourcePath = `${temporary}/source.ipe`;
    const nativePath = `${temporary}/native.ipe`;
    try {
      writeFileSync(sourcePath, ipeDocumentCodec.serialize(document));
      execFileSync("ipetoipe", ["-xml", sourcePath, nativePath], { stdio: "ignore" });
      const native = ipeDocumentCodec.parse(readFileSync(nativePath));
      expect(native.assets).toHaveLength(1);
      expect(native.assets![0]!.id).toBe(encoded.asset.id);
      expect(native.assets![0]!.xml?.attributes?.ColorSpace).toBe("DeviceGray");
      expect(native.pages[0]!.objects[0]!.assetId).toBe(encoded.asset.id);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
