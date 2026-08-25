import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import type { DocumentIR } from "../../src/domain/ir.js";
import { addBitmapAsset, imagePlacement } from "../../src/objects/assets.js";

function document(): DocumentIR {
  return { schemaVersion: 1, format: 70218, pages: [] };
}

function png(width: number, height: number, pixels: readonly number[]): Uint8Array {
  const value = new PNG({ width, height });
  value.data.set(pixels);
  return PNG.sync.write(value);
}

function jpeg(components = 3): Uint8Array {
  const body = components === 1
    ? [8, 0, 1, 0, 2, 1, 1, 17, 0]
    : [8, 0, 1, 0, 2, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0];
  const length = body.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, length >> 8, length & 0xff, ...body, 0xff, 0xda, 0xff, 0xd9]);
}

function realJpeg(): Uint8Array {
  const fixture = readFileSync(new URL("../../fixtures/conformance/m4/golden/m4-object-primitive-matrix.ipe", import.meta.url), "utf8");
  const match = fixture.match(/<bitmap id="2"[^>]*>([^<]+)<\/bitmap>/u);
  if (!match) throw new Error("golden JPEG fixture is missing");
  return Uint8Array.from(Buffer.from(match[1]!, "base64"));
}

function jpegWithOrientation(orientation: number): Uint8Array {
  const exif = [
    0x45, 0x78, 0x69, 0x66, 0, 0, // Exif header
    0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, // big-endian TIFF + IFD offset
    0, 1, // one IFD entry
    1, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, // Orientation SHORT
    0, 0, 0, 0, // next IFD
  ];
  const length = exif.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...exif, ...realJpeg().subarray(2)]);
}

describe("bitmap assets", () => {
  it("normalizes RGB and RGBA PNGs and deduplicates canonical input", () => {
    const rgb = png(2, 1, [255, 0, 0, 255, 0, 255, 0, 255]);
    const rgba = png(2, 1, [255, 0, 0, 255, 0, 255, 0, 128]);
    const doc = document();
    const opaque = addBitmapAsset(doc, rgb, "image/png");
    const duplicate = addBitmapAsset(doc, rgb, "image/png");
    const transparent = addBitmapAsset(doc, rgba, "image/png");

    expect(opaque.created).toBe(true);
    expect(opaque.info).toMatchObject({ width: 2, height: 1, mediaType: "image/png", hasAlpha: false });
    expect(opaque.asset.xml?.attributes).toMatchObject({ ColorSpace: "DeviceRGB", Filter: "FlateDecode", width: "2", height: "1" });
    expect(opaque.asset.xml?.attributes?.alphaLength).toBeUndefined();
    expect(duplicate).toMatchObject({ created: false, asset: opaque.asset, info: opaque.info });
    expect(doc.assets).toHaveLength(2);
    expect(transparent.info.hasAlpha).toBe(true);
    expect(transparent.asset.xml?.attributes?.ColorSpace).toBe("DeviceRGBAlpha");
    expect(Number(transparent.asset.xml?.attributes?.alphaLength)).toBeGreaterThan(0);
    expect(Buffer.from(transparent.asset.data!, "base64").length).toBeGreaterThan(deflateSync(Buffer.from([255, 0, 0, 0, 255, 0])).length);
  });

  it("passes through supported JPEG bytes and rejects non-upright Exif orientation", () => {
    const data = realJpeg();
    const doc = document();
    const result = addBitmapAsset(doc, data, "image/jpeg");
    expect(result.info).toMatchObject({ width: 2, height: 2, mediaType: "image/jpeg", hasAlpha: false });
    expect(result.asset.data).toBe(Buffer.from(data).toString("base64"));
    expect(result.asset.xml?.attributes).toMatchObject({ Filter: "DCTDecode", ColorSpace: "DeviceRGB", length: String(data.length) });
    expect(() => addBitmapAsset(document(), jpegWithOrientation(6), "image/jpeg")).toThrow(/orientation/);
    expect(() => addBitmapAsset(document(), jpeg(1), "image/jpeg")).toThrow(/entropy|truncated/);
    const corrupt = realJpeg();
    corrupt[corrupt.length - 3] = 0xff;
    expect(() => addBitmapAsset(document(), corrupt, "image/jpeg")).toThrow(/invalid|unsupported/);
    expect(() => addBitmapAsset(document(), data, "image/jpeg", { maxPixels: 3 })).toThrow(/pixel limit/);
    expect(() => addBitmapAsset(document(), data, "image/jpeg", { maxDecoderMemoryMB: 0 })).toThrow(/invalid/);
  });

  it("enforces input and pixel bounds, validates malformed media, and computes fit placement", () => {
    const data = png(2, 2, new Array(16).fill(255));
    expect(() => addBitmapAsset(document(), new Uint8Array(), "image/png")).toThrow(/empty/);
    expect(() => addBitmapAsset(document(), data, "image/png", { maxInputBytes: data.length - 1 })).toThrow(/byte limit/);
    expect(() => addBitmapAsset(document(), data, "image/png", { maxPixels: 3 })).toThrow(/pixel limit/);
    expect(() => addBitmapAsset(document(), Uint8Array.from([1, 2, 3]), "image/png")).toThrow(/invalid/);
    const asset = addBitmapAsset(document(), png(1, 2, [255, 0, 0, 255, 0, 0, 255, 255]), "image/png").asset;
    const target = { x: 10, y: 20, width: 100, height: 50 };
    expect(imagePlacement(asset, target, "stretch")).toEqual({ image: target });
    expect(imagePlacement(asset, target, "contain")).toEqual({ image: { x: 47.5, y: 20, width: 25, height: 50 } });
    expect(imagePlacement(asset, target, "cover")).toEqual({ image: { x: 10, y: -55, width: 100, height: 200 }, clip: target });
  });

  it("rejects hostile PNG IHDR dimensions before decoder allocation", () => {
    const hostile = new Uint8Array(24);
    hostile.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(hostile.buffer);
    view.setUint32(8, 13, false);
    hostile.set([0x49, 0x48, 0x44, 0x52], 12);
    view.setUint32(16, 0xffff_ffff, false);
    view.setUint32(20, 1, false);
    expect(() => addBitmapAsset(document(), hostile, "image/png")).toThrow(/pixel limit/);
  });
});
