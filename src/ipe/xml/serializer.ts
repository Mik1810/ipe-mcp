import type { XmlChild, XmlDocument, XmlElement } from "./parser.js";
import { stylesheetList, type DocumentIR, type IpeObject, type Matrix, type Page, type View } from "../../domain/ir.js";
import type { XmlElement as DomainXmlElement, XmlNode as DomainXmlNode } from "../../domain/xml-node.js";
import { assertValidXml10String } from "../../domain/xml-chars.js";
import { assertPersistentEntityId, persistentObjectCustom } from "../../domain/identity.js";
import { assertObjectContent } from "../../objects/content-model.js";

export interface XmlSerializeOptions {
  readonly includeDeclaration?: boolean;
  readonly includeDoctype?: boolean;
  readonly indent?: string | false;
  /** Page names are carried by the composition sidecar for native round-trips. */
  readonly compositionSidecarAuthoritative?: boolean;
}

const KNOWN_ATTRIBUTE_ORDER: Record<string, readonly string[]> = {
  ipe: ["version", "creator"],
  info: ["title", "author", "subject", "keywords", "created", "modified"],
  ipestyle: ["name", "x-ipe-mcp-id"],
  stylesheet: ["name", "x-ipe-mcp-id"],
  bitmap: ["id", "width", "height", "ColorSpace", "Filter", "encoding", "length", "alphaLength", "x-ipe-mcp-id"],
  layout: ["paper", "origin", "frame", "crop"],
  page: ["title", "section", "subsection", "marked", "x-ipe-mcp-name", "x-ipe-mcp-id"],
  layer: ["name", "edit", "snap", "x-ipe-mcp-id"],
  view: ["layers", "active", "marked", "name", "effect", "x-ipe-mcp-id"],
  transform: ["layer", "matrix"],
  effect: ["name", "duration", "transition", "effect"],
  path: ["layer", "matrix", "pos", "pin", "stroke", "fill", "pen", "dash", "cap", "join", "fillrule", "arrow", "rarrow", "opacity", "stroke-opacity", "tiling", "gradient", "custom", "url"],
  text: ["layer", "matrix", "pos", "type", "width", "height", "size", "stroke", "fill", "opacity", "custom", "url"],
  image: ["layer", "matrix", "bitmap", "rect", "opacity", "custom", "url"],
  group: ["layer", "matrix", "clip", "url", "custom"],
  use: ["layer", "name", "pos", "matrix", "pin", "stroke", "fill", "pen", "size", "custom", "url"],
};

function escapeText(value: string): string {
  assertValidXml10String(value);
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("\t", "&#9;");
}

function validateName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) || name.includes(":")) throw new Error(`Invalid XML name: ${name}`);
}

function orderedAttributes(element: XmlElement): readonly [string, string][] {
  const preferred = KNOWN_ATTRIBUTE_ORDER[element.name] ?? [];
  const rank = new Map(preferred.map((name, index) => [name, index]));
  return Object.entries(element.attributes).sort(([a], [b]) => {
    const ar = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const br = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ar - br || a.localeCompare(b);
  });
}

function orderedRootChildren(children: readonly XmlChild[]): readonly XmlChild[] {
  const priority = (child: XmlChild): number => {
    if (typeof child === "string") return 99;
    switch (child.name) {
      case "info": return 0;
      case "preamble": return 1;
      case "bitmap": return 2;
      case "ipestyle":
      case "stylesheet": return 3;
      case "page": return 10;
      default: return 5;
    }
  };
  // Preserve document-order ties.  Unknown extension nodes remain in the
  // canonical root slot instead of being silently dropped.
  return children.map((child, index) => ({ child, index })).sort((a, b) => priority(a.child) - priority(b.child) || a.index - b.index).map(({ child }) => child);
}

function writeElement(element: XmlElement, level: number, indent: string | false, root: boolean): string {
  validateName(element.name);
  const pad = indent === false ? "" : indent.repeat(level);
  const attrs = orderedAttributes(element).map(([name, value]) => {
    validateName(name);
    return ` ${name}="${escapeAttribute(value)}"`;
  }).join("");
  const children = root ? orderedRootChildren(element.children) : element.children;
  const meaningful = children;
  if (meaningful.length === 0) return `${pad}<${element.name}${attrs}/>`;
  if (indent === false || meaningful.some((child) => typeof child === "string")) {
    return `${pad}<${element.name}${attrs}>${meaningful.map((child) => writeChild(child, level + 1, indent)).join("")}</${element.name}>`;
  }
  const body = meaningful.map((child) => `\n${writeChild(child, level + 1, indent)}`).join("") + `\n${pad}`;
  return `${pad}<${element.name}${attrs}>${body}</${element.name}>`;
}

function writeChild(child: XmlChild, level: number, indent: string | false): string {
  return typeof child === "string" ? escapeText(child) : writeElement(child, level, indent, false);
}

function cloneElement(value: XmlElement): XmlElement {
  return { type: "element", name: value.name, attributes: { ...value.attributes }, children: value.children.map((child) => typeof child === "string" ? child : cloneElement(child)) };
}

const OBJECT_TAGS = new Set(["path", "text", "image", "group", "use"]);

function fromDomainNode(node: DomainXmlNode): XmlChild {
  if (node.type === "text") return node.text;
  if (node.type === "comment") throw new Error("XML comments are outside the supported semantic IR");
  return fromDomainElement(node);
}

function fromDomainElement(element: DomainXmlElement): XmlElement {
  return {
    type: "element",
    name: element.name,
    attributes: { ...(element.attributes ?? {}) },
    children: (element.children ?? []).map(fromDomainNode),
  };
}

function matrixText(matrix: Matrix): string {
  return matrix.map((value) => Object.is(value, -0) ? "0" : String(value)).join(" ");
}

function setOptionalAttribute(attributes: Record<string, string>, name: string, value: string | undefined): void {
  if (value === undefined) delete attributes[name];
  else attributes[name] = value;
}

function layerName(id: string, names: ReadonlyMap<string, string>): string {
  const name = names.get(id);
  if (name === undefined) throw new Error(`Layer ID '${id}' does not resolve`);
  return name;
}

function viewElement(view: View, names: ReadonlyMap<string, string>): XmlElement {
  assertPersistentEntityId("view", view.id);
  const source = view.xml as DomainXmlElement | undefined;
  const element = source === undefined
    ? { type: "element" as const, name: "view", attributes: {}, children: [] }
    : fromDomainElement(source);
  element.name = "view";
  element.attributes["x-ipe-mcp-id"] = view.id;
  element.attributes.layers = view.visibleLayerIds.map((id) => layerName(id, names)).join(" ");
  element.attributes.active = layerName(view.activeLayerId, names);
  element.attributes.marked = view.marked ? "yes" : "no";
  setOptionalAttribute(element.attributes, "name", view.name);
  const retained = element.children.filter((child) => typeof child === "string" || child.name !== "transform");
  const canonicalTransforms = view.layerTransforms ?? Object.fromEntries(
    (view.transforms ?? []).map((transform) => [transform.layerId, transform.matrix]),
  );
  const transforms = Object.entries(canonicalTransforms).sort(([a], [b]) => a.localeCompare(b)).map(([id, matrix]) => ({
    type: "element" as const,
    name: "transform",
    attributes: { layer: layerName(id, names), matrix: matrixText(matrix) },
    children: [] as XmlChild[],
  }));
  element.children = [...retained, ...transforms];
  return element;
}

function objectElement(object: IpeObject, names: ReadonlyMap<string, string>): XmlElement {
  if (object.xml === undefined) {
    throw new Error(`Object '${object.id}' cannot be serialized until its XML payload is compiled`);
  }
  assertObjectContent(object.xml);
  const element = fromDomainElement(object.xml);
  if (!OBJECT_TAGS.has(element.name)) throw new Error(`Unsupported Ipe object element: ${element.name}`);
  if (object.custom === undefined) throw new Error(`Object '${object.id}' requires persistent custom identity`);
  assertPersistentEntityId("object", object.id);
  element.attributes.layer = layerName(object.layerId, names);
  element.attributes.custom = persistentObjectCustom(object.id, object.custom);
  element.attributes["x-ipe-mcp-id"] = object.id;
  setOptionalAttribute(element.attributes, "matrix", object.matrix === undefined ? undefined : matrixText(object.matrix));
  setOptionalAttribute(element.attributes, "pin", object.pin);
  setOptionalAttribute(element.attributes, "transformations", object.transformationMode);
  return element;
}

function pageElement(irPage: Page, compositionSidecarAuthoritative = false): XmlElement {
  assertPersistentEntityId("page", irPage.id);
  const pageSource = irPage.xml as DomainXmlElement | undefined;
  const page = pageSource === undefined
    ? { type: "element" as const, name: "page", attributes: {}, children: [] as XmlChild[] }
    : fromDomainElement(pageSource);
  page.name = "page";
  page.attributes["x-ipe-mcp-id"] = irPage.id;
  setOptionalAttribute(page.attributes, "x-ipe-mcp-name", compositionSidecarAuthoritative ? undefined : irPage.name);
  setOptionalAttribute(page.attributes, "title", irPage.title);
  setOptionalAttribute(page.attributes, "section", irPage.section);
  setOptionalAttribute(page.attributes, "subsection", irPage.subsection);
  setOptionalAttribute(page.attributes, "marked", irPage.marked === undefined ? undefined : irPage.marked ? "yes" : "no");

  const layers = irPage.layers.map((layer) => {
    assertPersistentEntityId("layer", layer.id);
    const source = layer.xml as DomainXmlElement | undefined;
    const element = source === undefined
      ? { type: "element" as const, name: "layer", attributes: {}, children: [] as XmlChild[] }
      : fromDomainElement(source);
    element.name = "layer";
    element.attributes.name = layer.name;
    element.attributes["x-ipe-mcp-id"] = layer.id;
    const edit = layer.edit ?? (layer.locked === undefined ? undefined : !layer.locked);
    setOptionalAttribute(element.attributes, "edit", edit === undefined ? undefined : edit ? "yes" : "no");
    const snap = layer.snap ?? (layer.snapping === undefined ? undefined : layer.snapping ? "visible" : "never");
    setOptionalAttribute(element.attributes, "snap", snap);
    return element;
  });
  if (layers.length === 0) {
    layers.push({ type: "element", name: "layer", attributes: { name: "alpha" }, children: [] });
  }
  const names = new Map(irPage.layers.map((layer) => [layer.id, layer.name]));
  const views = irPage.views.map((view) => viewElement(view, names));
  if (views.length === 0) {
    const first = layers[0]?.attributes.name ?? "alpha";
    views.push({ type: "element", name: "view", attributes: { layers: first, active: first, marked: "no" }, children: [] });
  }
  const notes = irPage.notes === undefined
    ? []
    : [{ type: "element" as const, name: "notes", attributes: {}, children: [irPage.notes] as XmlChild[] }];
  const retained = page.children.filter((child) =>
    typeof child !== "string" && child.name !== "layer" && child.name !== "view" && child.name !== "notes" && !OBJECT_TAGS.has(child.name),
  );
  page.children = [...notes, ...layers, ...views, ...retained, ...irPage.objects.map((object) => objectElement(object, names))];
  return page;
}

function normalizeIr(value: DocumentIR & { readonly xml?: XmlDocument }, compositionSidecarAuthoritative = false): XmlDocument {
  if (value.xml === undefined) throw new Error("IR serializer requires a lossless XML source");
  const root = cloneElement(value.xml.root);
  root.attributes.version = "70218";
  if (value.pages.length === 0) throw new Error("Ipe document must contain at least one page");
  const persistentIds = new Set<string>();
  const registerId = (kind: "page" | "layer" | "view" | "style" | "asset" | "object", id: string): void => {
    assertPersistentEntityId(kind, id);
    if (persistentIds.has(id)) throw new Error(`Duplicate persistent entity ID: ${id}`);
    persistentIds.add(id);
  };
  for (const page of value.pages) {
    registerId("page", page.id);
    for (const layer of page.layers) registerId("layer", layer.id);
    for (const view of page.views) registerId("view", view.id);
    for (const object of page.objects) registerId("object", object.id);
  }
  const styles = stylesheetList(value);
  const styleElements = styles.map((style) => {
    registerId("style", style.id);
    if (style.xml === undefined) throw new Error(`Stylesheet '${style.id}' requires XML payload`);
    const element = fromDomainElement(style.xml);
    if (element.name !== "ipestyle" && element.name !== "stylesheet") throw new Error(`Invalid stylesheet payload: ${element.name}`);
    element.attributes["x-ipe-mcp-id"] = style.id;
    setOptionalAttribute(element.attributes, "name", style.name);
    return element;
  });
  const assetElements = (value.assets ?? []).map((asset) => {
    registerId("asset", asset.id);
    if (asset.xml === undefined) throw new Error(`Asset '${asset.id}' requires XML payload`);
    const element = fromDomainElement(asset.xml);
    if (element.name !== "bitmap") throw new Error(`Invalid asset payload: ${element.name}`);
    element.attributes["x-ipe-mcp-id"] = asset.id;
    return element;
  });
  root.children = [
    ...root.children.filter((child) => typeof child === "string" || (child.name !== "ipestyle" && child.name !== "stylesheet" && child.name !== "bitmap")),
    ...assetElements,
    ...styleElements,
  ];
  const pages = value.pages.map((page) => pageElement(page, compositionSidecarAuthoritative));
  const nonPages = root.children.filter((child) => typeof child === "string" || child.name !== "page");
  root.children = [...nonPages, ...pages];

  const infoIndex = root.children.findIndex((child) => typeof child !== "string" && child.name === "info");
  if (value.metadata === undefined) {
    if (infoIndex >= 0) root.children.splice(infoIndex, 1);
  } else {
    const existing = infoIndex >= 0 ? root.children[infoIndex] : undefined;
    const info: XmlElement = typeof existing !== "string" && existing !== undefined
      ? cloneElement(existing)
      : { type: "element", name: "info", attributes: {}, children: [] };
    info.attributes = Object.fromEntries(
      Object.entries(value.metadata).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    if (infoIndex >= 0) root.children[infoIndex] = info;
    else root.children.unshift(info);
  }

  const preambleIndex = root.children.findIndex((child) => typeof child !== "string" && child.name === "preamble");
  if (value.preamble === undefined) {
    if (preambleIndex >= 0) root.children.splice(preambleIndex, 1);
  } else {
    const preamble: XmlElement = { type: "element", name: "preamble", attributes: {}, children: [value.preamble] };
    if (preambleIndex >= 0) root.children[preambleIndex] = preamble;
    else root.children.unshift(preamble);
  }
  return { ...value.xml, root };
}

export function serializeXml(document: XmlDocument | XmlElement | DocumentIR & { readonly xml?: XmlDocument }, options: XmlSerializeOptions = {}): string {
  if ("schemaVersion" in document) document = normalizeIr(document, options.compositionSidecarAuthoritative);
  const indent = options.indent === undefined ? false : options.indent;
  const root = "root" in document ? document.root : document;
  const includeDeclaration = options.includeDeclaration ?? true;
  const includeDoctype = options.includeDoctype ?? root.name === "ipe";
  const head: string[] = [];
  if (includeDeclaration) head.push('<?xml version="1.0"?>');
  if (includeDoctype) head.push('<!DOCTYPE ipe SYSTEM "ipe.dtd">');
  head.push(writeElement(root, 0, indent, true));
  return head.join(indent === false ? "\n" : "\n") + (indent === false ? "" : "\n");
}

export const serializeIpeXml = serializeXml;
export const serializeIpe = serializeXml;
