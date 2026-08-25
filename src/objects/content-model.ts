import { isXmlElement, type XmlElement, type XmlNode } from "../domain/xml-node.js";

/** Object XML is intentionally a small, lossless subset of Ipe's content model. */
const OBJECT_TAGS = new Set(["path", "text", "image", "group", "use"]);
const COMMON = new Set(["layer", "matrix", "pin", "transformations", "custom", "x-ipe-mcp-id", "url"]);
const ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  path: new Set([...COMMON, "pos", "stroke", "fill", "pen", "dash", "cap", "join", "fillrule", "arrow", "rarrow", "opacity", "stroke-opacity", "tiling", "gradient"]),
  text: new Set([...COMMON, "pos", "type", "width", "height", "depth", "stroke", "fill", "size", "style", "halign", "valign", "opacity"]),
  image: new Set([...COMMON, "bitmap", "rect", "opacity"]),
  group: new Set([...COMMON, "clip", "decoration"]),
  use: new Set([...COMMON, "name", "pos", "stroke", "fill", "pen", "size"]),
};

const significantText = (node: XmlNode): boolean => node.type === "text" && node.text.trim() !== "";

function assertAttributes(xml: XmlElement, path: string): void {
  if (xml.attributeList !== undefined) throw new Error(`${path} attributeList cannot be preserved`);
  const attributes = xml.attributes ?? {};
  const allowed = ATTRIBUTES[xml.name];
  for (const name of Object.keys(attributes)) {
    // Namespaced extension attributes are retained by the lossless XML
    // adapter and therefore remain forward-compatible.  Unqualified unknown
    // attributes would be dropped or misinterpreted by an object builder.
    if (!allowed?.has(name) && !name.startsWith("x-")) throw new Error(`${path} has unsupported attribute '${name}'`);
    if (typeof attributes[name] !== "string") throw new Error(`${path}.${name} must be a string`);
  }
}

function assertPayload(xml: XmlElement, path: string, nested: boolean): void {
  const children = xml.children ?? [];
  if (xml.name === "path") {
    if (children.some(isXmlElement) || children.some((child) => child.type === "comment")) throw new Error(`${path} path payload may contain text only`);
  } else if (xml.name === "text") {
    if (children.some(isXmlElement) || children.some((child) => child.type === "comment")) throw new Error(`${path} text payload may contain text only`);
  } else if (xml.name === "group") {
    if (children.some((child) => child.type === "comment") || children.some(significantText)) throw new Error(`${path} group has significant non-object content`);
  } else if (children.some((child) => child.type === "comment") || children.some(significantText)) {
    throw new Error(`${path} ${xml.name} cannot contain text content`);
  }
  if (nested && xml.attributes?.layer !== undefined) throw new Error(`${path} nested object cannot carry layer`);
}

/** Throw unless an object subtree can be serialized without dropping semantics. */
export function assertObjectContent(xml: XmlElement, options: { readonly nested?: boolean } = {}): void {
  if (!OBJECT_TAGS.has(xml.name)) throw new Error(`unsupported object tag '${xml.name}'`);
  const walk = (node: XmlElement, path: string, nested: boolean): void => {
    if (!OBJECT_TAGS.has(node.name)) throw new Error(`unsupported object tag '${node.name}' at ${path}`);
    assertAttributes(node, path);
    assertPayload(node, path, nested);
    for (const [index, child] of (node.children ?? []).entries()) {
      if (isXmlElement(child)) {
        if (node.name !== "group") throw new Error(`${path}.children[${index}] has an unsupported nested element`);
        walk(child, `${path}.children[${index}]`, true);
      }
    }
  };
  walk(xml, "xml", options.nested ?? false);
}
