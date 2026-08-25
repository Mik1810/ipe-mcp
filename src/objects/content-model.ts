import { isXmlElement, type XmlElement, type XmlNode } from "../domain/xml-node.js";
import { assertValidXml10String } from "../domain/xml-chars.js";
import { assertDomainNumber } from "../domain/numeric.js";
import { assertInvertibleMatrix } from "../layout/matrix.js";

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

const PATH_OPERATORS = new Set(["m", "l", "c", "q", "a", "C", "L", "h", "e", "u", "s", "*"]);
const PATH_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/**
 * Validate the stack-based path language used by Ipe's `<path>` payloads.
 *
 * The XML adapter deliberately keeps object payloads opaque, but passing an
 * arbitrary string through here is unsafe: Ipe accepts malformed path text
 * and silently writes an empty/canonical path.  Fixed-arity operators are
 * checked exactly where native Ipe requires it; spline operators consume an
 * even number of coordinates and have the minimum point count required by
 * Ipe.  `m` starts a subpath, while `e`/`u` append closed subpaths and may
 * terminate a valid open curve.  `h` closes the current curve.
 */
export function assertIpePathPayload(payload: string, path = "path"): void {
  assertValidXml10String(payload);
  const text = payload.replace(/^[\x00-\x20]+|[\x00-\x20]+$/gu, "");
  if (text === "") return;
  // Ipe's Lex class treats only bytes <= 0x20 as whitespace.  JavaScript's
  // Unicode-aware trim/split would incorrectly accept NBSP and other Unicode
  // separators, so tokenize on the native ASCII surface explicitly.
  const tokens = text.split(/[\x00-\x20]+/u);
  let operands: number[] = [];
  let open = false;
  let hasCurve = false;
  let marker: number | undefined;

  const requireMatrix = (operator: string): void => {
    try {
      const matrix = operands.slice(0, 6) as [number, number, number, number, number, number];
      assertInvertibleMatrix(matrix);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${path} operator '${operator}' has an invalid matrix: ${message}`);
    }
  };

  const requireOperands = (operator: string, count: number): void => {
    if (operands.length !== count) {
      throw new Error(`${path} operator '${operator}' requires ${count} numeric operands, got ${operands.length}`);
    }
  };
  const requireOpen = (operator: string): void => {
    if (!open) throw new Error(`${path} operator '${operator}' must follow a move operator`);
  };
  for (const token of tokens) {
    if (PATH_NUMBER.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error(`${path} has a non-finite numeric operand '${token}'`);
      try {
        assertDomainNumber(value, `${path} numeric operand`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${path} has an invalid numeric operand '${token}': ${message}`);
      }
      operands.push(value);
      continue;
    }
    if (!PATH_OPERATORS.has(token)) {
      throw new Error(`${path} has unknown operator or invalid token '${token}'`);
    }

    switch (token) {
      case "m":
        if (marker !== undefined) throw new Error(`${path} operator 'L' '*' marker must be followed by 'L'`);
        requireOperands(token, 2);
        if (open && !hasCurve) throw new Error(`${path} operator 'm' starts a new subpath before the current curve is complete`);
        operands = [];
        open = true;
        hasCurve = false;
        marker = undefined;
        break;
      case "l":
        if (marker !== undefined) throw new Error(`${path} operator 'L' '*' marker must be followed by 'L'`);
        requireOpen(token);
        requireOperands(token, 2);
        operands = [];
        hasCurve = true;
        break;
      case "q":
      case "c":
      case "s":
      case "L":
        if (marker !== undefined && token !== "L") throw new Error(`${path} operator 'L' '*' marker must be followed by 'L'`);
        requireOpen(token);
        if (operands.length < 2 || operands.length % 2 !== 0) {
          throw new Error(`${path} operator '${token}' requires one or more coordinate pairs`);
        }
        if (token === "L" && marker !== undefined && (marker < 4 || marker % 2 !== 0 || (marker / 2) % 3 !== 2)) {
          throw new Error(`${path} operator 'L' has an invalid '*' marker position`);
        }
        operands = [];
        marker = undefined;
        hasCurve = true;
        break;
      case "a":
        if (marker !== undefined) throw new Error(`${path} operator 'L' '*' marker must be followed by 'L'`);
        requireOpen(token);
        requireOperands(token, 8);
        requireMatrix(token);
        operands = [];
        hasCurve = true;
        break;
      case "h":
        if (marker !== undefined) throw new Error(`${path} operator 'L' '*' marker must be followed by 'L'`);
        requireOpen(token);
        if (!hasCurve) throw new Error(`${path} operator 'h' cannot close an empty subpath`);
        requireOperands(token, 0);
        operands = [];
        open = false;
        marker = undefined;
        break;
      case "e":
        if (marker !== undefined) throw new Error(`${path} operator 'L' '*' marker must be followed by 'L'`);
        if (open && !hasCurve) throw new Error(`${path} operator 'e' cannot abandon an empty subpath`);
        requireOperands(token, 6);
        requireMatrix(token);
        operands = [];
        open = false;
        marker = undefined;
        break;
      case "u":
        if (marker !== undefined) throw new Error(`${path} operator 'L' '*' marker must be followed by 'L'`);
        if (open && !hasCurve) throw new Error(`${path} operator 'u' cannot abandon an empty subpath`);
        if (operands.length < 6 || operands.length % 2 !== 0) {
          throw new Error(`${path} operator 'u' requires at least three coordinate pairs`);
        }
        operands = [];
        open = false;
        marker = undefined;
        break;
      case "C":
        if (marker !== undefined) throw new Error(`${path} operator 'L' '*' marker must be followed by 'L'`);
        requireOpen(token);
        // Cardinal splines have one or more coordinate pairs followed by one
        // tension value.  Native Ipe permits a single pair after the current
        // point, so the smallest valid sequence has three operands.
        if (operands.length < 3 || operands.length % 2 !== 1) {
          throw new Error(`${path} operator 'C' requires coordinate pairs followed by one tension`);
        }
        operands = [];
        marker = undefined;
        hasCurve = true;
        break;
      case "*":
        requireOpen(token);
        if (marker !== undefined) throw new Error(`${path} operator 'L' has more than one '*' marker`);
        marker = operands.length;
        break;
    }
  }
  // Native Ipe accepts one trailing move and drops it during construction;
  // retain that compatibility for existing canonical fixtures.  Empty
  // subpaths before another command are rejected at the command boundary.
  if (marker !== undefined) throw new Error(`${path} operator 'L' '*' marker must be followed by 'L'`);
  if (operands.length > 0) throw new Error(`${path} has ${operands.length} trailing numeric operands without an operator`);
}

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
    assertIpePathPayload(children.filter((child): child is Extract<XmlNode, { type: "text" }> => child.type === "text").map((child) => child.text).join(""), path);
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
