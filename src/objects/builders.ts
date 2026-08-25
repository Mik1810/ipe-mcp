import type { Asset, IpeObject, ObjectReference } from "../domain/ir.js";
import { assertBox, type Box, type Point } from "../layout/geometry.js";
import type { XmlElement } from "../domain/xml-node.js";
import type { FitMode } from "../layout/layout.js";
import { cloneObject, createObjectIdentity, element, matrixText, numberText, pointText, type ObjectIdentity } from "./common.js";
import { imagePlacement } from "./assets.js";
import { compilePath, compilePathResult, type PathSpec } from "./path.js";
import { walkNestedObjectXml } from "./references.js";
import { assertObjectContent } from "./content-model.js";

export interface CommonObjectOptions {
  readonly layerId: string;
  readonly identity?: ObjectIdentity;
  readonly matrix?: IpeObject["matrix"];
  readonly pin?: "yes" | "h" | "v";
  readonly transformationMode?: "affine" | "rigid" | "translations";
  readonly url?: string;
}

export function buildCompiledObject(xml: XmlElement, options: CommonObjectOptions): IpeObject {
  assertObjectContent(xml);
  const identity = options.identity ?? createObjectIdentity();
  if (!options.layerId) throw new Error("layerId is required");
  if (xml.name === "use" && (xml.attributes?.opacity !== undefined || xml.attributes?.["stroke-opacity"] !== undefined)) {
    throw new Error("Ipe use objects do not support opacity");
  }
  if (options.url !== undefined) (xml.attributes ??= {}).url = options.url;
  return {
    id: identity.id,
    custom: identity.custom,
    layerId: options.layerId,
    zOrder: 0,
    ...(options.matrix === undefined ? {} : { matrix: options.matrix }),
    ...(options.pin === undefined ? {} : { pin: options.pin }),
    ...(options.transformationMode === undefined ? {} : { transformationMode: options.transformationMode }),
    xml,
  };
}

export interface PathObjectOptions extends CommonObjectOptions {
  readonly path: PathSpec;
}

export function buildPathObject(options: PathObjectOptions): IpeObject {
  return buildCompiledObject(compilePath(options.path), options);
}

export interface TextObjectOptions extends CommonObjectOptions {
  readonly text: string;
  readonly position: Point;
  readonly type?: "label" | "minipage";
  readonly width?: number;
  readonly height?: number;
  readonly depth?: number;
  readonly stroke?: string;
  readonly size?: string | number;
  readonly style?: string;
  readonly horizontalAlign?: "left" | "center" | "right";
  readonly verticalAlign?: "top" | "bottom" | "center" | "baseline";
  readonly opacity?: string;
}

export function buildTextObject(options: TextObjectOptions): IpeObject {
  const type = options.type ?? "label";
  if (type === "minipage" && options.width === undefined) throw new Error("minipage text requires width");
  const attributes: Record<string, string> = {
    type,
    pos: pointText(options.position),
    valign: options.verticalAlign ?? (type === "label" ? "baseline" : "top"),
  };
  const optional: Array<[string, string | number | undefined]> = [
    ["width", options.width], ["height", options.height], ["depth", options.depth],
    ["stroke", options.stroke], ["size", options.size], ["style", options.style],
    ["halign", options.horizontalAlign], ["opacity", options.opacity],
  ];
  for (const [name, value] of optional) if (value !== undefined) attributes[name] = typeof value === "number" ? numberText(value, `text.${name}`) : value;
  return buildCompiledObject(element("text", attributes, [{ type: "text", text: options.text }]), options);
}

export interface ImageObjectOptions extends CommonObjectOptions {
  readonly asset: Asset;
  readonly rect: Box;
  readonly opacity?: string;
}

export function buildImageObject(options: ImageObjectOptions): IpeObject {
  assertBox(options.rect, "image rect");
  const bitmap = options.asset.xml?.attributes?.id;
  if (options.asset.xml?.name !== "bitmap" || bitmap === undefined || !/^\d+$/u.test(bitmap)) {
    throw new Error(`asset '${options.asset.id}' is not a compiled Ipe bitmap`);
  }
  const attributes: Record<string, string> = {
    bitmap,
    rect: [options.rect.x, options.rect.y, options.rect.x + options.rect.width, options.rect.y + options.rect.height]
      .map((value) => numberText(value, "image rect coordinate")).join(" "),
  };
  if (options.opacity !== undefined) attributes.opacity = options.opacity;
  const object = buildCompiledObject(element("image", attributes), options);
  object.references = [{ kind: "asset", id: options.asset.id }];
  object.assetId = options.asset.id;
  return object;
}

export interface FittedImageObjectOptions extends CommonObjectOptions {
  readonly asset: Asset;
  readonly target: Box;
  readonly fit?: FitMode;
  readonly opacity?: string;
}

/** Cover is represented as a clipped group so Ipe itself enforces the crop. */
export function buildFittedImageObject(options: FittedImageObjectOptions): IpeObject {
  const placement = imagePlacement(options.asset, options.target, options.fit ?? "contain");
  if (!placement.clip) return buildImageObject({ ...options, rect: placement.image });
  const image = buildImageObject({ layerId: options.layerId, asset: options.asset, rect: placement.image, ...(options.opacity === undefined ? {} : { opacity: options.opacity }) });
  return buildGroupObject({ ...options, children: [image], clip: { kind: "rectangle", ...placement.clip } });
}

export interface SymbolObjectOptions extends CommonObjectOptions {
  readonly name: string;
  readonly position?: Point;
  readonly stroke?: string;
  readonly fill?: string;
  readonly pen?: string | number;
  readonly size?: string | number;
}

function symbolParameters(name: string): ReadonlySet<string> {
  const match = name.match(/\(([^()]*)\)$/u);
  if (!match) return new Set();
  const suffix = match[1]!;
  if (!/^s?f?p?x?$/u.test(suffix)) throw new Error(`symbol '${name}' has unsupported parameter suffix`);
  return new Set(suffix.split(""));
}

export function buildSymbolObject(options: SymbolObjectOptions): IpeObject {
  if (!options.name) throw new Error("symbol name is required");
  const parameters = symbolParameters(options.name);
  for (const [field, parameter, value] of [["stroke", "s", options.stroke], ["fill", "f", options.fill], ["pen", "p", options.pen], ["size", "x", options.size]] as const) {
    if (value !== undefined && !parameters.has(parameter)) {
      throw new Error(`symbol '${options.name}' does not accept ${field} parameter`);
    }
  }
  const attributes: Record<string, string> = { name: options.name };
  if (options.position) attributes.pos = pointText(options.position);
  for (const [name, value] of [["stroke", options.stroke], ["fill", options.fill], ["pen", options.pen], ["size", options.size]] as const) {
    if (value !== undefined) attributes[name] = typeof value === "number" ? numberText(value, `symbol.${name}`) : value;
  }
  const object = buildCompiledObject(element("use", attributes), options);
  object.references = [{ kind: "symbol", id: options.name }];
  object.symbolId = options.name;
  return object;
}

export interface GroupObjectOptions extends CommonObjectOptions {
  readonly children: readonly IpeObject[] | readonly XmlElement[];
  readonly clip?: PathSpec;
  readonly decoration?: string;
}

function pathPayload(path: PathSpec, purpose: string): string {
  const compiled = compilePathResult(path);
  if (compiled.subpaths.length === 0 || compiled.subpaths.some((subpath) => !subpath.closed)) {
    throw new Error(`${purpose} path must contain only closed subpaths`);
  }
  const xml = compiled.xml;
  if (Object.keys(xml.attributes ?? {}).length > 0) throw new Error(`${purpose} path cannot carry paint or arrow styles`);
  return (xml.children ?? []).map((child) => child.type === "text" ? child.text : "").join("");
}

export function nestedElement(object: IpeObject): XmlElement {
  if (!object.xml) throw new Error(`object '${object.id}' has no compiled payload`);
  const xml = cloneObject(object.xml);
  const attributes = (xml.attributes ??= {});
  delete attributes.layer;
  if (object.custom === undefined) throw new Error(`nested object '${object.id}' has no persistent custom identity`);
  attributes.custom = object.custom;
  attributes["x-ipe-mcp-id"] = object.id;
  if (object.matrix === undefined) delete attributes.matrix;
  else attributes.matrix = matrixText(object.matrix);
  if (object.pin === undefined) delete attributes.pin;
  else attributes.pin = object.pin;
  if (object.transformationMode === undefined) delete attributes.transformations;
  else attributes.transformations = object.transformationMode;
  assertObjectContent(xml, { nested: true });
  return element("group", { custom: `ipe-mcp:nested-id:${object.id}` }, [xml]);
}

export function buildGroupObject(options: GroupObjectOptions): IpeObject {
  if (options.children.length === 0) throw new Error("group requires at least one child");
  const typedChildren = options.children.every((child) => "layerId" in child);
  const rawChildren = options.children.every((child) => !("layerId" in child));
  if (!typedChildren && !rawChildren) throw new Error("group children must be all compiled objects or all raw XML elements");
  if (typedChildren && (options.children as readonly IpeObject[]).some((child) => child.layerId !== options.layerId)) {
    throw new Error("group children must use the group's layer");
  }
  if (typedChildren && (options.children as readonly IpeObject[]).some((child) => (child.references ?? []).some((reference) => reference.kind === "object"))) {
    throw new Error("cannot group objects with object references: per-child references cannot be preserved");
  }
  const children = options.children.map((child) => "layerId" in child ? nestedElement(child as IpeObject) : cloneObject(child as XmlElement));
  const attributes: Record<string, string> = {};
  if (options.clip !== undefined) attributes.clip = pathPayload(options.clip, "clip");
  if (options.decoration !== undefined) attributes.decoration = options.decoration;
  const object = buildCompiledObject(element("group", attributes, children), options);
  assertObjectContent(object.xml!);
  // Validate the entire nested subtree, including typed children whose
  // identities have just been wrapped in carriers.
  const discoveredReferences = walkNestedObjectXml(object.xml!);
  const references: ObjectReference[] = typedChildren
    ? (options.children as readonly IpeObject[]).flatMap((child) => child.references ?? []).map(cloneObject)
    : discoveredReferences.filter((reference) => reference.kind === "symbol");
  if (options.decoration !== undefined) references.push({ kind: "symbol", id: options.decoration });
  if (references.length > 0) object.references = references;
  return object;
}
