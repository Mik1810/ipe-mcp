import { SaxesParser } from "saxes";
import { isValidXml10String } from "../../domain/xml-chars.js";
import { XML_PARSE_DEFAULT_LIMITS } from "../../limits.js";

/** A lossless, namespace-free XML node used at the Ipe format boundary. */
export interface XmlElement {
  type: "element";
  name: string;
  attributes: Record<string, string>;
  children: XmlChild[];
}

export type XmlChild = XmlElement | string;

export interface XmlDocument {
  type: "document";
  root: XmlElement;
  readonly xmlDeclaration?: Readonly<Record<string, string>>;
  readonly doctype?: string;
}

export interface XmlParseLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxAttributes?: number;
}

export class XmlParseError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "XmlParseError";
  }
}

const DEFAULT_LIMITS: Required<XmlParseLimits> = XML_PARSE_DEFAULT_LIMITS;

const BUILTIN_ENTITY = /&(?:amp|lt|gt|quot|apos);/g;
const DOCTYPE = /^ipe\s+SYSTEM\s+"ipe\.dtd"$/;

function checkXmlSurface(source: string): void {
  // Saxes deliberately does not fetch external entities.  Reject all entity
  // declarations/references before handing input to it; the five predefined
  // XML entities are the only references accepted by the Ipe boundary.
  if (/<!ENTITY\b/i.test(source) || /<!DOCTYPE[^>]*\[/is.test(source)) {
    throw new XmlParseError("ENTITY declarations and internal subsets are not allowed");
  }
  const withoutBuiltins = source.replace(BUILTIN_ENTITY, "");
  if (/&[A-Za-z_][\w.-]*;/i.test(withoutBuiltins)) {
    throw new XmlParseError("Named XML entities are not allowed");
  }
  if (/<(?:[A-Za-z_][\w.-]*:|[^>]*\sxmlns(?::|\s*=))/i.test(source)) {
    throw new XmlParseError("XML namespaces are not supported");
  }
}

function nameIsSafe(name: string): void {
  if (name.includes(":")) throw new XmlParseError("XML namespaces are not supported");
}

/** Parse Ipe XML without resolving DTDs, entities or namespaces. */
export function parseXml(input: string | Uint8Array, limits: XmlParseLimits = {}): XmlDocument {
  const opts = { ...DEFAULT_LIMITS, ...limits };
  let source: string;
  try {
    source = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch (error) {
    throw new XmlParseError("XML input is not valid UTF-8", { cause: error });
  }
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > opts.maxBytes) throw new XmlParseError(`XML exceeds byte limit (${opts.maxBytes})`);
  // Saxes reports control characters inconsistently across versions.  Keep
  // the XML 1.0 boundary diagnostic stable before handing the source to it.
  if (!isValidXml10String(source)) throw new XmlParseError("XML 1.0-invalid character");
  checkXmlSurface(source);

  const parser = new SaxesParser({ xmlns: false, fragment: false, position: true });
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let nodes = 0;
  let attributes = 0;
  let doctype: string | undefined;
  let declaration: Record<string, string> | undefined;
  let parseError: Error | undefined;

  const fail = (message: string, cause?: unknown): never => {
    throw new XmlParseError(message, { cause });
  };
  const append = (child: XmlChild): void => {
    const parent = stack.at(-1);
    if (!parent) {
      if (typeof child === "string" && child.trim() === "") return;
      fail("XML content outside the document root");
    }
    // XmlElement is intentionally mutable only while parsing.  It is frozen
    // at the end, so downstream code gets a stable lossless tree.
    (parent as unknown as { children: XmlChild[] }).children.push(child);
  };

  parser.on("xmldecl", (decl) => {
    declaration = {};
    if (decl.version !== undefined) declaration.version = decl.version;
    if (decl.encoding !== undefined) declaration.encoding = decl.encoding;
    if (decl.standalone !== undefined) declaration.standalone = decl.standalone;
  });
  parser.on("doctype", (value) => {
    if (doctype !== undefined || !DOCTYPE.test(value.trim())) fail("Only <!DOCTYPE ipe SYSTEM \"ipe.dtd\"> is allowed");
    doctype = value.trim();
  });
  parser.on("opentag", (tag) => {
    nameIsSafe(tag.name);
    const attrs: Record<string, string> = {};
    for (const [name, value] of Object.entries(tag.attributes)) {
      nameIsSafe(name);
      if (name.startsWith("xmlns")) fail("XML namespaces are not supported");
      if (Object.hasOwn(attrs, name)) fail(`Duplicate XML attribute: ${name}`);
      attrs[name] = value;
    }
    attributes += Object.keys(attrs).length;
    if (attributes > opts.maxAttributes) fail("XML attribute limit exceeded");
    if (stack.length + 1 > opts.maxDepth) fail("XML depth limit exceeded");
    nodes += 1;
    if (nodes > opts.maxNodes) fail("XML node limit exceeded");
    const element = { type: "element" as const, name: tag.name, attributes: attrs, children: [] as XmlChild[] };
    if (root) append(element);
    else root = element;
    stack.push(element);
  });
  parser.on("text", (text) => {
    if (text.length > 0) append(text);
  });
  parser.on("cdata", (text) => append(text));
  parser.on("comment", () => {
    // Comments have no Ipe semantics and are intentionally not retained.
  });
  parser.on("processinginstruction", ({ target }) => {
    if (target.toLowerCase() !== "xml") fail(`Processing instructions are not allowed: ${target}`);
  });
  parser.on("closetag", () => {
    if (!stack.pop()) fail("Unexpected closing tag");
  });
  parser.on("error", (error) => {
    parseError = error;
  });
  try {
    parser.write(source).close();
  } catch (error) {
    if (error instanceof XmlParseError) throw error;
    throw new XmlParseError("Malformed XML", { cause: error });
  }
  if (parseError) throw new XmlParseError("Malformed XML", { cause: parseError });
  if (stack.length !== 0 || !root) throw new XmlParseError("XML document has no complete root element");
  if (declaration?.encoding !== undefined && declaration.encoding.toLowerCase() !== "utf-8") {
    throw new XmlParseError("Only UTF-8 XML input is supported");
  }
  return { type: "document", root, ...(declaration ? { xmlDeclaration: declaration } : {}), ...(doctype ? { doctype } : {}) };
}

/** Parse and enforce the Ipe 70218 document root. */
export function parseIpeXml(input: string | Uint8Array, limits?: XmlParseLimits): XmlDocument {
  const document = parseXml(input, limits);
  if (document.root.name !== "ipe") throw new XmlParseError("Ipe XML root must be <ipe>");
  if (document.root.attributes.version !== "70218") throw new XmlParseError("Only Ipe XML format 70218 is supported");
  return document;
}

export const parseIpe = parseIpeXml;
