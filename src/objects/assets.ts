import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import { PNG } from "pngjs";
import { decode as decodeJpeg } from "jpeg-js";

import type { Asset, DocumentIR } from "../domain/ir.js";
import { assertPersistentEntityId } from "../domain/identity.js";
import { assertBox, type Box } from "../layout/geometry.js";
import { fitBox, type FitMode } from "../layout/layout.js";
import { element } from "./common.js";

export interface BitmapLimits {
  readonly maxInputBytes?: number;
  readonly maxPixels?: number;
  readonly maxDecoderMemoryMB?: number;
}

export interface BitmapInfo {
  readonly width: number;
  readonly height: number;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly hasAlpha: boolean;
  readonly canonicalHash: string;
}

export interface BitmapAssetResult {
  readonly asset: Asset;
  readonly created: boolean;
  readonly info: BitmapInfo;
}

const DEFAULT_MAX_INPUT = 64 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 100_000_000;
const DEFAULT_MAX_DECODER_MEMORY_MB = 512;

function bounded(data: Uint8Array, limits: BitmapLimits): void {
  if (data.byteLength === 0) throw new Error("bitmap input is empty");
  if (data.byteLength > (limits.maxInputBytes ?? DEFAULT_MAX_INPUT)) throw new Error("bitmap input exceeds byte limit");
}

function assertPixels(width: number, height: number, limits: BitmapLimits): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error("bitmap dimensions are invalid");
  if (width * height > (limits.maxPixels ?? DEFAULT_MAX_PIXELS)) throw new Error("bitmap exceeds pixel limit");
}

/**
 * Check the PNG header before handing the payload to pngjs.  pngjs allocates
 * its pixel buffer from IHDR, so checking only after decode leaves a hostile
 * (but tiny) PNG able to request an enormous allocation.
 */
function preflightPngDimensions(data: Uint8Array, limits: BitmapLimits): void {
  if (data.byteLength < 24
    || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47
    || data[4] !== 0x0d || data[5] !== 0x0a || data[6] !== 0x1a || data[7] !== 0x0a) {
    throw new Error("invalid or unsupported PNG signature");
  }
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8, false);
  const type = String.fromCharCode(data[12]!, data[13]!, data[14]!, data[15]!);
  if (length !== 13 || type !== "IHDR") throw new Error("invalid PNG IHDR");
  const view = new DataView(data.buffer, data.byteOffset + 16, data.byteLength - 16);
  const width = view.getUint32(0, false);
  const height = view.getUint32(4, false);
  assertPixels(width, height, limits);
}

interface EncodedBitmap {
  info: BitmapInfo;
  attributes: Record<string, string>;
  payload: Uint8Array;
}

export interface ValidatedJpeg {
  readonly width: number;
  readonly height: number;
  readonly components: 1 | 3;
}

function pngBitmap(data: Uint8Array, limits: BitmapLimits): EncodedBitmap {
  preflightPngDimensions(data, limits);
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(Buffer.from(data), { checkCRC: true });
  } catch (error) {
    throw new Error("invalid or unsupported PNG", { cause: error });
  }
  assertPixels(decoded.width, decoded.height, limits);
  const pixels = decoded.width * decoded.height;
  if (decoded.data.length !== pixels * 4) throw new Error("PNG decoder returned an unexpected pixel buffer");
  const rgb = Buffer.allocUnsafe(pixels * 3);
  const alpha = Buffer.allocUnsafe(pixels);
  let hasAlpha = false;
  for (let source = 0, color = 0, opacity = 0; source < decoded.data.length; source += 4) {
    rgb[color++] = decoded.data[source]!;
    rgb[color++] = decoded.data[source + 1]!;
    rgb[color++] = decoded.data[source + 2]!;
    alpha[opacity++] = decoded.data[source + 3]!;
    if (decoded.data[source + 3] !== 255) hasAlpha = true;
  }
  const compressedColor = deflateSync(rgb, { level: 9 });
  const compressedAlpha = hasAlpha ? deflateSync(alpha, { level: 9 }) : Buffer.alloc(0);
  const payload = Buffer.concat([compressedColor, compressedAlpha]);
  const canonicalHash = createHash("sha256")
    .update("png-rgba-v1\0").update(String(decoded.width)).update("x").update(String(decoded.height)).update("\0").update(decoded.data)
    .digest("hex");
  return {
    info: { width: decoded.width, height: decoded.height, mediaType: "image/png", hasAlpha, canonicalHash },
    attributes: {
      width: String(decoded.width), height: String(decoded.height), ColorSpace: hasAlpha ? "DeviceRGBAlpha" : "DeviceRGB",
      Filter: "FlateDecode", encoding: "base64", length: String(compressedColor.length),
      ...(hasAlpha ? { alphaLength: String(compressedAlpha.length) } : {}),
    },
    payload,
  };
}

function exifOrientation(segment: Uint8Array): number | undefined {
  if (segment.length < 14 || new TextDecoder("ascii").decode(segment.subarray(0, 6)) !== "Exif\0\0") return undefined;
  const view = new DataView(segment.buffer, segment.byteOffset + 6, segment.byteLength - 6);
  const little = view.getUint16(0, false) === 0x4949;
  if (!little && view.getUint16(0, false) !== 0x4d4d) return undefined;
  const get16 = (offset: number): number => view.getUint16(offset, little);
  const get32 = (offset: number): number => view.getUint32(offset, little);
  const ifd = get32(4);
  if (ifd + 2 > view.byteLength) return undefined;
  const count = get16(ifd);
  for (let index = 0; index < count; index += 1) {
    const offset = ifd + 2 + index * 12;
    if (offset + 12 > view.byteLength) return undefined;
    if (get16(offset) === 0x0112) return get16(offset + 8);
  }
  return undefined;
}

export function validateJpegPayload(data: Uint8Array, limits: BitmapLimits = {}): ValidatedJpeg {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) {
    throw new Error("invalid JPEG markers");
  }
  let offset = 2;
  let width: number | undefined;
  let height: number | undefined;
  let components: number | undefined;
  let sawScan = false;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) throw new Error("invalid JPEG marker stream");
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset++]!;
    if (marker === 0xd9) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = (data[offset]! << 8) | data[offset + 1]!;
    if (length < 2 || offset + length > data.length) throw new Error("truncated JPEG segment");
    const body = data.subarray(offset + 2, offset + length);
    if (marker === 0xe1) {
      const orientation = exifOrientation(body);
      if (orientation !== undefined && orientation !== 1) throw new Error("JPEG Exif orientation other than 1 is unsupported");
    }
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (body.length < 6 || body[0] !== 8) throw new Error("only 8-bit JPEG is supported");
      height = (body[1]! << 8) | body[2]!;
      width = (body[3]! << 8) | body[4]!;
      components = body[5]!;
    }
    offset += length;
    if (marker === 0xda) { sawScan = true; break; }
  }
  if (!sawScan || width === undefined || height === undefined || (components !== 1 && components !== 3)) {
    throw new Error("JPEG must be grayscale or RGB with a supported SOF marker");
  }
  assertPixels(width, height, limits);
  try {
    // Dimensions are preflighted above, before jpeg-js can allocate its RGBA
    // output. The decoder validates baseline and progressive entropy scans,
    // including truncated/corrupt payloads, instead of trusting SOF/SOS
    // headers alone.
    const maxPixels = limits.maxPixels ?? DEFAULT_MAX_PIXELS;
    const maxMemoryUsageInMB = limits.maxDecoderMemoryMB ?? DEFAULT_MAX_DECODER_MEMORY_MB;
    if (!Number.isFinite(maxMemoryUsageInMB) || maxMemoryUsageInMB <= 0) throw new Error("JPEG decoder memory limit is invalid");
    const decoded = decodeJpeg(Buffer.from(data), {
      useTArray: true,
      maxResolutionInMP: maxPixels / 1_000_000,
      maxMemoryUsageInMB,
    });
    if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) {
      throw new Error("JPEG decoder dimensions differ from SOF");
    }
  } catch (error) {
    throw new Error("invalid or unsupported JPEG", { cause: error });
  }
  return { width, height, components };
}

function jpegBitmap(data: Uint8Array, limits: BitmapLimits): EncodedBitmap {
  const { width, height, components } = validateJpegPayload(data, limits);
  const canonicalHash = createHash("sha256").update("jpeg-dct-v1\0").update(data).digest("hex");
  return {
    info: { width, height, mediaType: "image/jpeg", hasAlpha: false, canonicalHash },
    attributes: {
      width: String(width), height: String(height), ColorSpace: components === 1 ? "DeviceGray" : "DeviceRGB",
      Filter: "DCTDecode", encoding: "base64", length: String(data.length),
    },
    payload: data,
  };
}

function nextNativeBitmapId(assets: readonly Asset[]): string {
  const values = assets.map((asset) => Number(asset.xml?.attributes?.id)).filter((value) => Number.isSafeInteger(value) && value > 0);
  const next = Math.max(0, ...values) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("native bitmap ID space exhausted");
  return String(next);
}

export function addBitmapAsset(
  document: DocumentIR,
  data: Uint8Array,
  mediaType: "image/png" | "image/jpeg",
  limits: BitmapLimits = {},
): BitmapAssetResult {
  bounded(data, limits);
  const encoded = mediaType === "image/png" ? pngBitmap(data, limits) : jpegBitmap(data, limits);
  const existing = (document.assets ?? []).find((asset) => asset.hash === encoded.info.canonicalHash);
  if (existing) return { asset: existing, created: false, info: encoded.info };
  const id = `asset-${encoded.info.canonicalHash.slice(0, 24)}`;
  assertPersistentEntityId("asset", id);
  const nativeId = nextNativeBitmapId(document.assets ?? []);
  const asset: Asset = {
    id,
    kind: "bitmap",
    mediaType,
    hash: encoded.info.canonicalHash,
    data: Buffer.from(encoded.payload).toString("base64"),
    xml: element("bitmap", { id: nativeId, ...encoded.attributes }, [{ type: "text", text: Buffer.from(encoded.payload).toString("base64") }]),
  };
  document.assets = [...(document.assets ?? []), asset];
  return { asset, created: true, info: encoded.info };
}

export function bitmapDimensions(asset: Asset): { width: number; height: number } {
  if (asset.xml?.name !== "bitmap") throw new Error(`asset '${asset.id}' is not a bitmap`);
  const width = Number(asset.xml.attributes?.width);
  const height = Number(asset.xml.attributes?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error(`asset '${asset.id}' has invalid dimensions`);
  return { width, height };
}

export function imagePlacement(asset: Asset, target: Box, mode: FitMode): { image: Box; clip?: Box } {
  assertBox(target, "image target");
  const size = bitmapDimensions(asset);
  if (mode === "stretch") return { image: target };
  const image = fitBox({ x: 0, y: 0, ...size }, target, mode).box;
  return mode === "cover" ? { image, clip: target } : { image };
}
