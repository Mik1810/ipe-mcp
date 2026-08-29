import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { DocumentIR, IpeObject, Layer, Page, View, Stylesheet, Asset, Matrix } from "../../domain/ir.js";
import type { XmlElement as DomainXmlElement, XmlNode } from "../../domain/xml-node.js";
import type { XmlDocument, XmlElement } from "./parser.js";
import { objectIdFromCustom, parsePersistentObjectCustom } from "../../domain/identity.js";
import { validateJpegPayload } from "../../objects/assets.js";
import { BITMAP_DEFAULT_LIMITS } from "../../limits.js";

/** The lossless source is attached out-of-band for the serializer adapter. */
export type ProjectedDocument = DocumentIR & { readonly xml: XmlDocument };
export type IpeXmlIr = ProjectedDocument;
export type IpeXmlLayer = Layer;
export type IpeXmlObject = IpeObject;
export type IpeXmlPage = Page;
export type IpeXmlView = View;

const OBJECT_TAGS = new Set(["path", "text", "image", "group", "use"]);
const RESERVED_ROOT = new Set(["info", "preamble", "bitmap", "ipestyle", "stylesheet", "page"]);
const RESERVED_LAYERS = new Set(["BBOX", "VIEWBBOX", "BACKGROUND", "GRID", "NOPDF"]);
const ID_ATTRIBUTE = "x-ipe-mcp-id";
const asDomainXml = (value: XmlElement): DomainXmlElement => ({
  type: "element",
  name: value.name,
  attributes: { ...value.attributes },
  children: value.children.map((child) => typeof child === "string" ? { type: "text" as const, text: child } : asDomainXml(child)),
});
const asDomainNode = (value: XmlElement): XmlNode => asDomainXml(value);

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
function stableUuid(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  digest[12] = "5";
  digest[16] = "8";
  const hex = digest.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function textOf(element: XmlElement): string {
  return element.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
}
function children(element: XmlElement, name?: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement => typeof child !== "string" && (name === undefined || child.name === name));
}
function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "yes" || value === "true" || value === "1";
}
function parseMatrix(value: string | undefined, context: string): Matrix | undefined {
  if (value === undefined) return undefined;
  const values = value.trim().split(/\s+/).map(Number);
  if (values.length !== 6 || values.some((item) => !Number.isFinite(item))) {
    throw new Error(`Invalid matrix at ${context}: expected six finite numbers`);
  }
  return values as unknown as Matrix;
}
function canonicalElementFingerprint(source: XmlElement, omittedAttributes: ReadonlySet<string> = new Set()): unknown {
  const normalizedChildren: unknown[] = [];
  for (const child of source.children) {
    if (typeof child === "string") {
      if (child.length === 0) continue;
      const previous = normalizedChildren.at(-1);
      if (typeof previous === "string") normalizedChildren[normalizedChildren.length - 1] = previous + child;
      else normalizedChildren.push(child);
    } else {
      normalizedChildren.push(canonicalElementFingerprint(child));
    }
  }
  return {
    name: source.name,
    attributes: Object.entries(source.attributes)
      .filter(([name]) => !omittedAttributes.has(name))
      .sort(([a], [b]) => a.localeCompare(b)),
    children: normalizedChildren,
  };
}

const MAX_BITMAP_PIXELS = BITMAP_DEFAULT_LIMITS.maxPixels;

function bitmapPayload(source: XmlElement): Buffer | undefined {
  const text = textOf(source).replace(/\s+/gu, "");
  if (text.length === 0) return undefined;
  if (source.attributes.encoding === "base64") {
    if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) return undefined;
    const payload = Buffer.from(text, "base64");
    // Buffer's base64 decoder is intentionally permissive; reject strings it
    // did not round-trip so malformed bitmap data cannot become an identity.
    return payload.toString("base64") === text ? payload : undefined;
  }
  // Ipe's historical default is hexadecimal when encoding is omitted.
  if (source.attributes.encoding !== undefined && source.attributes.encoding !== "hex") return undefined;
  if (text.length % 2 !== 0 || !/^[A-Fa-f0-9]+$/u.test(text)) return undefined;
  const payload = Buffer.from(text, "hex");
  return payload.toString("hex") === text.toLowerCase() ? payload : undefined;
}

function semanticBitmap(source: XmlElement): { readonly hash: string; readonly mediaType: "image/png" | "image/jpeg"; readonly data: string } | undefined {
  const payload = bitmapPayload(source);
  if (!payload) return undefined;
  const width = Number(source.attributes.width);
  const height = Number(source.attributes.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_BITMAP_PIXELS) return undefined;
  const filter = source.attributes.Filter;
  if (filter === "DCTDecode") {
    const declaredLength = Number(source.attributes.length);
    if (!Number.isSafeInteger(declaredLength) || declaredLength !== payload.length
      || payload.length < 4 || payload[0] !== 0xff || payload[1] !== 0xd8 || payload.at(-2) !== 0xff || payload.at(-1) !== 0xd9) return undefined;
    let decoded: ReturnType<typeof validateJpegPayload>;
    try {
      decoded = validateJpegPayload(payload, { maxPixels: MAX_BITMAP_PIXELS });
    } catch {
      return undefined;
    }
    const declaredComponents = source.attributes.ColorSpace === "DeviceGray" ? 1
      : source.attributes.ColorSpace === "DeviceRGB" ? 3 : undefined;
    if (width !== decoded.width || height !== decoded.height || declaredComponents !== decoded.components) return undefined;
    const hash = createHash("sha256").update("jpeg-dct-v1\0").update(payload).digest("hex");
    return { hash, mediaType: "image/jpeg", data: payload.toString("base64") };
  }
  if (filter !== "FlateDecode") return undefined;
  const colorLength = Number(source.attributes.length);
  const alphaLength = source.attributes.alphaLength === undefined ? 0 : Number(source.attributes.alphaLength);
  if (!Number.isSafeInteger(colorLength) || colorLength <= 0 || !Number.isSafeInteger(alphaLength) || alphaLength < 0
    || colorLength + alphaLength !== payload.length) return undefined;
  const colors = payload.subarray(0, colorLength);
  const alpha = alphaLength > 0 ? payload.subarray(colorLength) : undefined;
  const colorSpace = source.attributes.ColorSpace;
  const channels = colorSpace === "DeviceGray" || colorSpace === "DeviceGrayAlpha" ? 1
    : colorSpace === "DeviceRGB" || colorSpace === "DeviceRGBAlpha" ? 3 : undefined;
  if (channels === undefined) return undefined;
  const alphaDeclared = colorSpace === "DeviceGrayAlpha" || colorSpace === "DeviceRGBAlpha";
  // ColorSpace and alphaLength are one semantic declaration.  A contradictory
  // pair must not be decoded into an apparently valid hash: doing so would
  // deduplicate payloads whose native rendering differs.
  if (alphaDeclared !== (alphaLength > 0) || (alphaDeclared && alphaLength <= 0) || (!alphaDeclared && alphaLength !== 0)) return undefined;
  try {
    const pixels = width * height;
    const color = inflateSync(colors, { maxOutputLength: pixels * channels });
    if (color.length !== pixels * channels) return undefined;
    let rgba: Buffer;
    if (alpha) {
      const decodedAlpha = inflateSync(alpha, { maxOutputLength: pixels });
      if (decodedAlpha.length !== pixels) return undefined;
      rgba = Buffer.allocUnsafe(pixels * 4);
      for (let p = 0, c = 0; p < pixels; p += 1) {
        const sourceOffset = p * channels;
        const red = color[sourceOffset]!;
        rgba[c++] = red;
        rgba[c++] = channels === 1 ? red : color[sourceOffset + 1]!;
        rgba[c++] = channels === 1 ? red : color[sourceOffset + 2]!;
        rgba[c++] = decodedAlpha[p]!;
      }
    } else {
      rgba = Buffer.allocUnsafe(pixels * 4);
      for (let p = 0, c = 0; p < pixels; p += 1) {
        const sourceOffset = p * channels;
        const red = color[sourceOffset]!;
        rgba[c++] = red;
        rgba[c++] = channels === 1 ? red : color[sourceOffset + 1]!;
        rgba[c++] = channels === 1 ? red : color[sourceOffset + 2]!;
        rgba[c++] = 255;
      }
    }
    const hash = createHash("sha256").update("png-rgba-v1\0").update(String(width)).update("x").update(String(height)).update("\0").update(rgba).digest("hex");
    return { hash, mediaType: "image/png", data: payload.toString("base64") };
  } catch {
    return undefined;
  }
}

function projectAsset(source: XmlElement, index: number): Asset {
  const semantic = semanticBitmap(source);
  if (!semantic) {
    return { id: source.attributes[ID_ATTRIBUTE] ?? stableId("asset", `${index}/${JSON.stringify(canonicalElementFingerprint(source))}`), kind: "bitmap", xml: asDomainXml(source) };
  }
  return {
    // Managed bitmap identity is derived from decoded content. Native Ipe
    // drops x-ipe-mcp-id on bitmap elements, so accepting an arbitrary
    // syntactically valid ID here would make save/reload unstable.
    id: `asset-${semantic.hash.slice(0, 24)}`,
    kind: "bitmap", mediaType: semantic.mediaType, hash: semantic.hash, data: semantic.data, xml: asDomainXml(source),
  };
}

function rewriteBitmapReferences(source: XmlElement, assetIds: ReadonlyMap<string, string>, canonicalNativeIds: ReadonlyMap<string, string>): XmlElement {
  const attributes = { ...source.attributes };
  const assetId = source.name === "image" && attributes.bitmap !== undefined ? assetIds.get(attributes.bitmap) : undefined;
  if (assetId !== undefined) {
    const nativeId = canonicalNativeIds.get(assetId);
    if (nativeId !== undefined) attributes.bitmap = nativeId;
  }
  return {
    type: "element",
    name: source.name,
    attributes,
    children: source.children.map((child) => typeof child === "string" ? child : rewriteBitmapReferences(child, assetIds, canonicalNativeIds)),
  };
}
function layer(name: string, generatedId: string, source?: XmlElement): Layer {
  const edit = source?.attributes.edit === undefined ? undefined : bool(source.attributes.edit, true);
  const rawSnap = source?.attributes.snap;
  const snap = rawSnap === "never" || rawSnap === "visible" || rawSnap === "always" ? rawSnap : undefined;
  return {
    id: source?.attributes[ID_ATTRIBUTE] ?? generatedId,
    name,
    ...(edit === undefined ? {} : { edit }),
    ...(snap === undefined ? {} : { snap }),
    ...(RESERVED_LAYERS.has(name) ? { intentional: true } : {}),
    ...(source ? { xml: asDomainXml(source), attributes: source.attributes } : {}),
  };
}
function projectObject(
  source: XmlElement,
  layerName: string,
  layerId: string,
  pageIndex: number,
  objectIndex: number,
  customCounts: ReadonlyMap<string, number>,
  idOccurrences: Map<string, number>,
  assetIds: ReadonlyMap<string, string>,
  canonicalNativeIds: ReadonlyMap<string, string>,
): IpeObject {
  const sourceCustom = source.attributes.custom;
  const customCarrier = sourceCustom === undefined ? undefined : parsePersistentObjectCustom(sourceCustom);
  const editableCustom = customCarrier?.custom ?? sourceCustom;
  const matrix = parseMatrix(source.attributes.matrix, `page[${pageIndex}].object[${objectIndex}]`);
  const contentFingerprint = `${layerName}/${JSON.stringify({
    xml: canonicalElementFingerprint(source, new Set(["layer", "matrix"])),
    matrix: matrix ?? null,
  })}`;
  const custom = editableCustom ?? `ipe-mcp:${stableUuid(`${pageIndex}/${objectIndex}/${contentFingerprint}`)}`;
  const idSeed = editableCustom !== undefined && (customCounts.get(sourceCustom!) ?? 0) > 1
    ? `${editableCustom}/${contentFingerprint}`
    : custom;
  const occurrence = (idOccurrences.get(idSeed) ?? 0) + 1;
  idOccurrences.set(idSeed, occurrence);
  const duplicateCustom = editableCustom !== undefined && (customCounts.get(sourceCustom!) ?? 0) > 1;
  const generatedId = duplicateCustom
    ? stableId("object", `${idSeed}/${occurrence}`)
    : objectIdFromCustom(custom);
  const references: NonNullable<IpeObject["references"]> = [];
  const collectReferences = (xml: XmlElement): void => {
    if (xml.name === "image" && xml.attributes.bitmap !== undefined) {
      const assetId = assetIds.get(xml.attributes.bitmap);
      if (assetId !== undefined) references.push({ kind: "asset", id: assetId });
    } else if (xml.name === "use" && xml.attributes.name !== undefined) {
      references.push({ kind: "symbol", id: xml.attributes.name });
    } else if (xml.name === "group" && xml.attributes.decoration !== undefined) {
      references.push({ kind: "symbol", id: xml.attributes.decoration });
    }
    for (const child of children(xml)) collectReferences(child);
  };
  collectReferences(source);
  const normalizedSource = rewriteBitmapReferences(source, assetIds, canonicalNativeIds);
  return {
    id: source.attributes[ID_ATTRIBUTE] ?? customCarrier?.id ?? generatedId,
    custom,
    layerId, zOrder: objectIndex,
    ...(matrix ? { matrix } : {}),
    ...(source.attributes.pin === undefined ? {} : { pin: source.attributes.pin }),
    ...(source.attributes.transformations === undefined ? {} : { transformationMode: source.attributes.transformations }),
    ...(references.length === 0 ? {} : { references }),
    ...(source.name === "image" && references[0]?.kind === "asset" ? { assetId: references[0].id } : {}),
    ...(source.name === "use" && references[0]?.kind === "symbol" ? { symbolId: references[0].id } : {}),
    xml: asDomainXml(normalizedSource), type: normalizedSource.name, attributes: normalizedSource.attributes, children: normalizedSource.children,
  };
}

/** Project a safe 70218 XML tree into the versioned domain IR. */
export function projectXml(document: XmlDocument): ProjectedDocument {
  if (document.root.name !== "ipe" || document.root.attributes.version !== "70218") throw new Error("Only Ipe XML format 70218 can be projected");
  const rootChildren = document.root.children.filter((child): child is XmlElement => typeof child !== "string");
  const stylesheets: Stylesheet[] = rootChildren.filter((child) => child.name === "ipestyle" || child.name === "stylesheet").map((xml, index) => ({ id: xml.attributes[ID_ATTRIBUTE] ?? stableId("style", `${index}/${JSON.stringify(canonicalElementFingerprint(xml))}`), ...(xml.attributes.name === undefined ? {} : { name: xml.attributes.name }), xml: asDomainXml(xml) }));
  const assets: Asset[] = [];
  const assetIds = new Map<string, string>();
  const canonicalNativeIds = new Map<string, string>();
  const assetsByHash = new Map<string, Asset>();
  for (const [index, xml] of rootChildren.filter((child) => child.name === "bitmap").entries()) {
    const projected = projectAsset(xml, index);
    const canonical = projected.hash === undefined ? undefined : assetsByHash.get(projected.hash);
    const asset = canonical ?? projected;
    if (!canonical) {
      assets.push(asset);
      if (asset.hash !== undefined) assetsByHash.set(asset.hash, asset);
    }
    const nativeId = xml.attributes.id;
    if (nativeId !== undefined) assetIds.set(nativeId, asset.id);
    const canonicalNativeId = asset.xml?.attributes?.id;
    if (canonicalNativeId !== undefined) canonicalNativeIds.set(asset.id, canonicalNativeId);
  }
  const customCounts = new Map<string, number>();
  for (const page of rootChildren.filter((child) => child.name === "page")) {
    for (const object of children(page).filter((child) => OBJECT_TAGS.has(child.name))) {
      const custom = object.attributes.custom;
      if (custom !== undefined) customCounts.set(custom, (customCounts.get(custom) ?? 0) + 1);
    }
  }
  const idOccurrences = new Map<string, number>();
  const info = rootChildren.find((child) => child.name === "info");
  const preamble = rootChildren.find((child) => child.name === "preamble");
  const pages: Page[] = [];
  for (const [pageIndex, pageXml] of rootChildren.filter((child) => child.name === "page").entries()) {
    const layers: Layer[] = [];
    for (const [layerIndex, child] of children(pageXml, "layer").entries()) {
      const name = child.attributes.name;
      if (name !== undefined && !layers.some((item) => item.name === name)) {
        layers.push(layer(name, stableId("layer", `${pageIndex}/${layerIndex}/${name}`), child));
      }
    }
    if (layers.length === 0) layers.push(layer("alpha", stableId("layer", `${pageIndex}/0/alpha`)));
    const defaultLayer = layers[0]?.name ?? "alpha";
    const layerIds = new Map(layers.map((item) => [item.name, item.id]));
    const views: View[] = [];
    for (const [viewIndex, viewXml] of children(pageXml, "view").entries()) {
      const names = (viewXml.attributes.layers ?? layers.map((item) => item.name).join(" ")).split(/\s+/).filter(Boolean);
      const active = viewXml.attributes.active ?? names[0] ?? layers[0]?.name ?? "alpha";
      const transforms: Record<string, Matrix> = {};
      for (const [transformIndex, transform] of children(viewXml, "transform").entries()) {
        const name = transform.attributes.layer;
        if (name === undefined || transform.attributes.matrix === undefined) {
          throw new Error(`Invalid transform at page[${pageIndex}].view[${viewIndex}].transform[${transformIndex}]`);
        }
        const matrix = parseMatrix(transform.attributes.matrix, `page[${pageIndex}].view[${viewIndex}].transform[${transformIndex}]`);
        const id = layerIds.get(name);
        if (matrix !== undefined && id !== undefined) transforms[id] = matrix;
      }
      const attributeMaps = children(viewXml, "map").map((map, mapIndex) => {
        const attribute = map.attributes.kind;
        const from = map.attributes.from;
        const to = map.attributes.to;
        if (attribute === undefined || from === undefined || to === undefined) {
          throw new Error(`Invalid attribute map at page[${pageIndex}].view[${viewIndex}].map[${mapIndex}]`);
        }
        return { attribute, values: { [from]: to } };
      });
      const activeLayerId = layerIds.get(active) ?? layers[0]!.id;
      const visibleLayerIds = names.map((name) => layerIds.get(name)).filter((id): id is string => id !== undefined);
      views.push({ id: viewXml.attributes[ID_ATTRIBUTE] ?? stableId("view", `${pageIndex}/${viewIndex}`), ...(viewXml.attributes.name === undefined ? {} : { name: viewXml.attributes.name }), visibleLayerIds: visibleLayerIds.length > 0 ? visibleLayerIds : [activeLayerId], activeLayerId, marked: bool(viewXml.attributes.marked, false), ...(attributeMaps.length > 0 ? { attributeMaps } : {}), ...(Object.keys(transforms).length > 0 ? { layerTransforms: transforms } : {}), ...(viewXml.attributes.effect === undefined ? {} : { transition: { effect: viewXml.attributes.effect } }), xml: asDomainXml(viewXml) });
    }
    if (views.length === 0) { views.push({ id: stableId("view", `${pageIndex}/0`), visibleLayerIds: layers.map((item) => item.id), activeLayerId: layerIds.get(defaultLayer) ?? layers[0]!.id, marked: false }); }
    const objects: IpeObject[] = [];
    let objectLayer = defaultLayer;
    for (const child of pageXml.children) {
      if (typeof child === "string") continue;
      if (child.name === "layer") continue;
      if (OBJECT_TAGS.has(child.name)) {
        const requestedLayer = child.attributes.layer;
        const objectLayerName = requestedLayer !== undefined && layers.some((item) => item.name === requestedLayer)
          ? requestedLayer
          : objectLayer;
        objects.push(projectObject(child, objectLayerName, layerIds.get(objectLayerName) ?? layers[0]!.id, pageIndex, objects.length, customCounts, idOccurrences, assetIds, canonicalNativeIds));
        objectLayer = objectLayerName;
      }
    }
    const note = children(pageXml, "notes").map(textOf).join("");
    pages.push({ id: pageXml.attributes[ID_ATTRIBUTE] ?? stableId("page", `${pageIndex}`), ...(pageXml.attributes["x-ipe-mcp-name"] === undefined ? {} : { name: pageXml.attributes["x-ipe-mcp-name"] }), ...(pageXml.attributes.title === undefined ? {} : { title: pageXml.attributes.title }), ...(pageXml.attributes.section === undefined ? {} : { section: pageXml.attributes.section }), ...(pageXml.attributes.subsection === undefined ? {} : { subsection: pageXml.attributes.subsection }), ...(pageXml.attributes.marked === undefined ? {} : { marked: pageXml.attributes.marked !== "no" }), ...(note ? { notes: note } : {}), layers, views, objects, xml: asDomainXml(pageXml) });
  }
  if (pages.length === 0) throw new Error("Ipe document must contain at least one page");
  const metadata = info ? Object.fromEntries(Object.entries(info.attributes)) : undefined;
  const extensions: Record<string, XmlNode | XmlNode[]> = {};
  for (const xml of rootChildren.filter((child) => !RESERVED_ROOT.has(child.name))) { const node = asDomainNode(xml); const previous = extensions[xml.name]; extensions[xml.name] = previous === undefined ? node : Array.isArray(previous) ? [...previous, node] : [previous, node]; }
  const result: ProjectedDocument = { schemaVersion: 1, format: 70218, ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}), ...(preamble ? { preamble: textOf(preamble) } : {}), ...(stylesheets.length > 0 ? { stylesheets, styles: stylesheets } : {}), ...(assets.length > 0 ? { assets } : {}), ...(Object.keys(extensions).length > 0 ? { extensions } : {}), pages, xml: document };
  return result;
}

export const projectIpeXml = projectXml;
export function unprojectXml(value: ProjectedDocument | DocumentIR | XmlDocument): XmlDocument { if ("root" in value) return value; if ("xml" in value) return value.xml; throw new Error("IR does not carry a lossless XML source"); }
export const unprojectIpe = unprojectXml;
