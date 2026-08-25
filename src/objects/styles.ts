import { stylesheetList, type DocumentIR, type Stylesheet } from "../domain/ir.js";
import { MAX_DOMAIN_MAGNITUDE, assertDomainNumber } from "../domain/numeric.js";
import { isXmlElement, type XmlElement } from "../domain/xml-node.js";
import { cloneObject, element, matrixText, numberText } from "./common.js";
import { walkNestedObjectXml } from "./references.js";
import { assertObjectContent } from "./content-model.js";

export type StyleKind =
  | "color" | "pen" | "dashstyle" | "opacity" | "textsize" | "textstyle" | "labelstyle"
  | "symbolsize" | "arrowsize" | "symbol" | "gradient" | "tiling" | "pathstyle";

export interface StyleEntry {
  readonly kind: StyleKind;
  readonly name: string;
  readonly source: "builtin" | string;
  readonly xml?: XmlElement;
}

const BUILTIN: Readonly<Record<StyleKind, readonly string[]>> = {
  color: ["black", "white"],
  pen: ["normal"],
  dashstyle: ["normal"],
  opacity: ["opaque"],
  textsize: ["normal"],
  textstyle: ["normal"],
  labelstyle: ["normal", "math"],
  symbolsize: ["normal"],
  arrowsize: ["normal"],
  symbol: ["arrow/normal(spx)"],
  gradient: [],
  tiling: [],
  pathstyle: ["normal"],
};

const STYLE_ELEMENTS = new Set<StyleKind>([
  "color", "pen", "dashstyle", "opacity", "textsize", "textstyle", "labelstyle",
  "symbolsize", "arrowsize", "symbol", "gradient", "tiling", "pathstyle",
]);

function styles(document: DocumentIR): readonly Stylesheet[] {
  return stylesheetList(document);
}

export class StyleRegistry {
  readonly #entries = new Map<string, StyleEntry>();

  constructor(document: DocumentIR) {
    for (const [kind, names] of Object.entries(BUILTIN) as Array<[StyleKind, readonly string[]]>) {
      for (const name of names) this.#entries.set(`${kind}:${name}`, { kind, name, source: "builtin" });
    }
    for (const sheet of styles(document)) {
      for (const child of sheet.xml?.children ?? []) {
        if (!isXmlElement(child) || !STYLE_ELEMENTS.has(child.name as StyleKind)) continue;
        const kind = child.name === "textstyle" && child.attributes?.type === "label" ? "labelstyle" : child.name as StyleKind;
        const name = kind === "pathstyle" ? "normal" : child.attributes?.name;
        if (name !== undefined) this.#entries.set(`${kind}:${name}`, { kind, name, source: sheet.id, xml: child });
      }
    }
  }

  resolve(kind: StyleKind, name: string): StyleEntry | undefined {
    return this.#entries.get(`${kind}:${name}`);
  }

  require(kind: StyleKind, name: string): StyleEntry {
    const entry = this.resolve(kind, name);
    if (!entry) throw new Error(`undefined ${kind} style '${name}'`);
    return entry;
  }
}

export interface StyleDiagnostic {
  readonly code: "STYLE_UNDEFINED" | "STYLE_CONFLICT" | "SYMBOL_CYCLE" | "OBJECT_UNSUPPORTED";
  readonly path: string;
  readonly message: string;
}

function numeric(value: string): boolean {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= MAX_DOMAIN_MAGNITUDE;
}

function absoluteColor(value: string): boolean {
  const parts = value.trim().split(/\s+/u);
  return (parts.length === 1 || parts.length === 3) && parts.every((part) => numeric(part) && Number(part) >= 0 && Number(part) <= 1);
}

function symbolParameters(name: string): ReadonlySet<string> | undefined {
  const match = name.match(/\(([^()]*)\)$/u);
  if (!match) return new Set();
  const suffix = match[1]!;
  if (!/^s?f?p?x?$/u.test(suffix)) return undefined;
  return new Set(suffix.split(""));
}

function check(registry: StyleRegistry, diagnostics: StyleDiagnostic[], kind: StyleKind, value: string | undefined, path: string, absolute?: (value: string) => boolean, symbolContext = false): void {
  const pseudo = kind === "color" ? (value === "sym-stroke" || value === "sym-fill") : kind === "pen" && value === "sym-pen";
  if (value === undefined || absolute?.(value) || (symbolContext && pseudo)) return;
  if (!registry.resolve(kind, value)) diagnostics.push({ code: "STYLE_UNDEFINED", path, message: `undefined ${kind} '${value}'` });
}

function walkElements(elementValue: XmlElement, visit: (element: XmlElement, path: string) => void, path: string): void {
  visit(elementValue, path);
  for (const [index, child] of (elementValue.children ?? []).entries()) {
    if (isXmlElement(child)) walkElements(child, visit, `${path}.children[${index}]`);
  }
}

function checkElementStyles(registry: StyleRegistry, diagnostics: StyleDiagnostic[], xml: XmlElement, path: string, symbolContext: boolean): void {
  const attr = xml.attributes ?? {};
  if (xml.name === "path") {
    check(registry, diagnostics, "color", attr.stroke, `${path}.stroke`, absoluteColor, symbolContext);
    check(registry, diagnostics, "color", attr.fill, `${path}.fill`, absoluteColor, symbolContext);
    check(registry, diagnostics, "pen", attr.pen, `${path}.pen`, numeric, symbolContext);
    check(registry, diagnostics, "dashstyle", attr.dash, `${path}.dash`, (value) => value.startsWith("["), symbolContext);
    check(registry, diagnostics, "opacity", attr.opacity, `${path}.opacity`, undefined, symbolContext);
    check(registry, diagnostics, "opacity", attr["stroke-opacity"], `${path}.stroke-opacity`, undefined, symbolContext);
    check(registry, diagnostics, "gradient", attr.gradient, `${path}.gradient`, undefined, symbolContext);
    check(registry, diagnostics, "tiling", attr.tiling, `${path}.tiling`, undefined, symbolContext);
    for (const [name, arrow] of [["arrow", attr.arrow], ["rarrow", attr.rarrow]] as const) {
      if (!arrow) continue;
      const slash = arrow.lastIndexOf("/");
      const shape = slash < 0 ? arrow : arrow.slice(0, slash);
      const size = slash < 0 ? "normal" : arrow.slice(slash + 1);
      check(registry, diagnostics, "symbol", `arrow/${shape}(spx)`, `${path}.${name}`, undefined, symbolContext);
      check(registry, diagnostics, "arrowsize", size, `${path}.${name}`, numeric, symbolContext);
    }
  } else if (xml.name === "text") {
    check(registry, diagnostics, "color", attr.stroke, `${path}.stroke`, absoluteColor, symbolContext);
    check(registry, diagnostics, "textsize", attr.size, `${path}.size`, numeric, symbolContext);
    check(registry, diagnostics, attr.type === "minipage" ? "textstyle" : "labelstyle", attr.style, `${path}.style`, undefined, symbolContext);
    check(registry, diagnostics, "opacity", attr.opacity, `${path}.opacity`, undefined, symbolContext);
  } else if (xml.name === "use") {
    if (attr.opacity !== undefined || attr["stroke-opacity"] !== undefined) {
      diagnostics.push({ code: "STYLE_UNDEFINED", path: `${path}.opacity`, message: "Ipe use objects do not support opacity" });
    }
    check(registry, diagnostics, "symbol", attr.name, `${path}.name`, undefined, symbolContext);
    const parameters = attr.name === undefined ? undefined : symbolParameters(attr.name);
    if (attr.name !== undefined && parameters === undefined) {
      diagnostics.push({ code: "STYLE_UNDEFINED", path: `${path}.name`, message: `symbol '${attr.name}' has an unsupported parameter suffix` });
    }
    for (const [name, parameter] of [["stroke", "s"], ["fill", "f"], ["pen", "p"], ["size", "x"]] as const) {
      if (attr[name] !== undefined && parameters !== undefined && !parameters.has(parameter)) {
        diagnostics.push({ code: "STYLE_UNDEFINED", path: `${path}.${name}`, message: `symbol '${attr.name}' does not accept ${name} parameter` });
      }
    }
    check(registry, diagnostics, "color", attr.stroke, `${path}.stroke`, absoluteColor, symbolContext);
    check(registry, diagnostics, "color", attr.fill, `${path}.fill`, absoluteColor, symbolContext);
    check(registry, diagnostics, "pen", attr.pen, `${path}.pen`, numeric, symbolContext);
    check(registry, diagnostics, "symbolsize", attr.size, `${path}.size`, numeric, symbolContext);
  } else if (xml.name === "image") {
    check(registry, diagnostics, "opacity", attr.opacity, `${path}.opacity`, undefined, symbolContext);
  } else if (xml.name === "group") {
    check(registry, diagnostics, "symbol", attr.decoration, `${path}.decoration`, undefined, symbolContext);
  }
}

export function checkStyleStructural(document: DocumentIR): StyleDiagnostic[] {
  const registry = new StyleRegistry(document);
  const diagnostics: StyleDiagnostic[] = [];
  for (const [pageIndex, page] of document.pages.entries()) {
    for (const [objectIndex, object] of page.objects.entries()) {
      if (!object.xml) continue;
      walkElements(object.xml, (xml, path) => checkElementStyles(registry, diagnostics, xml, path, false), `pages[${pageIndex}].objects[${objectIndex}].xml`);
    }
  }

  const symbolGraph = new Map<string, Set<string>>();
  const effectiveSymbols = new Map<string, { readonly sheet: Stylesheet; readonly xml: XmlElement }>();
  for (const sheet of styles(document)) {
    const defined = new Set<string>();
    for (const child of sheet.xml?.children ?? []) {
      if (!isXmlElement(child)) continue;
      if (child.name === "symbol") {
        if (child.attributes?.name !== undefined) effectiveSymbols.set(child.attributes.name, { sheet, xml: child });
      }
      const kind = child.name === "textstyle" && child.attributes?.type === "label" ? "labelstyle" : child.name;
      const name = kind === "pathstyle" ? "normal" : child.attributes?.name;
      if (STYLE_ELEMENTS.has(kind as StyleKind) && name !== undefined) {
        const key = `${kind}:${name}`;
        if (defined.has(key)) diagnostics.push({ code: "STYLE_CONFLICT", path: `stylesheet:${sheet.id}`, message: `duplicate style definition '${key}'` });
        defined.add(key);
      }
    }
  }
  for (const { sheet, xml: child } of effectiveSymbols.values()) {
    walkElements(child, (xml, path) => checkElementStyles(registry, diagnostics, xml, path.replace("symbol", `stylesheet:${sheet.id}.symbol`), true), `symbol`);
    const bodies = (child.children ?? []).filter(isXmlElement);
    for (const [bodyIndex, body] of bodies.entries()) {
      try {
        walkNestedObjectXml(body, document);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push({ code: "OBJECT_UNSUPPORTED", path: `stylesheet:${sheet.id}.symbol.children[${bodyIndex}]`, message });
      }
    }
    const refs = new Set<string>();
    walkElements(child, (xml) => { if (xml.name === "use" && xml.attributes?.name) refs.add(xml.attributes.name); }, "symbol");
    if (child.attributes?.name) symbolGraph.set(child.attributes.name, refs);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitSymbol = (name: string): void => {
    if (visiting.has(name)) {
      diagnostics.push({ code: "SYMBOL_CYCLE", path: `symbol:${name}`, message: `symbol cycle includes '${name}'` });
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const target of symbolGraph.get(name) ?? []) if (symbolGraph.has(target)) visitSymbol(target);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of symbolGraph.keys()) visitSymbol(name);
  return diagnostics;
}

export type StyleDefinition =
  | { readonly kind: "color"; readonly name: string; readonly value: readonly [number, number, number] | number }
  | { readonly kind: "pen" | "symbolsize" | "arrowsize" | "textsize"; readonly name: string; readonly value: string | number }
  | { readonly kind: "dashstyle"; readonly name: string; readonly value: string }
  | { readonly kind: "opacity"; readonly name: string; readonly value: number }
  | { readonly kind: "textstyle"; readonly name: string; readonly begin: string; readonly end: string; readonly type?: "label" | "minipage" }
  | { readonly kind: "pathstyle"; readonly cap?: "0" | "1" | "2"; readonly join?: "0" | "1" | "2"; readonly fillrule?: "wind" | "eofill" }
  | { readonly kind: "tiling"; readonly name: string; readonly angle: number; readonly width: number; readonly step: number }
  | { readonly kind: "gradient"; readonly name: string; readonly type: "axial" | "radial"; readonly coords: readonly number[]; readonly extend?: boolean; readonly matrix?: import("../domain/ir.js").Matrix; readonly stops: readonly { readonly offset: number; readonly color: readonly [number, number, number] }[] }
  | { readonly kind: "symbol"; readonly name: string; readonly object: XmlElement; readonly transformations?: "rigid" | "translations"; readonly xform?: boolean; readonly snap?: readonly PointLike[] };

interface PointLike { readonly x: number; readonly y: number }

function colorValue(value: readonly [number, number, number] | number): string {
  const values = typeof value === "number" ? [value] : value;
  for (const component of values) {
    assertDomainNumber(component, "color component");
    if (component < 0 || component > 1) throw new Error("color components must be between 0 and 1");
  }
  return values.map((component) => numberText(component)).join(" ");
}

export function compileStyleDefinition(definition: StyleDefinition): XmlElement {
  const name = definition.kind === "pathstyle" ? "normal" : definition.name;
  if (!name || !/^[A-Za-z]/u.test(name)) throw new Error("style name must start with an ASCII letter");
  switch (definition.kind) {
    case "color": return element("color", { name: definition.name, value: colorValue(definition.value) });
    case "pen": case "symbolsize": case "arrowsize": {
      const value = typeof definition.value === "number" ? definition.value : Number(definition.value);
      assertDomainNumber(value, `${definition.kind} value`);
      if (!(value > 0)) throw new Error(`${definition.kind} value must be positive`);
      return element(definition.kind, { name: definition.name, value: numberText(value) });
    }
    case "textsize":
      return element(definition.kind, { name: definition.name, value: typeof definition.value === "number" ? numberText(definition.value) : definition.value });
    case "dashstyle":
      if (!/^\[(?:\s*\d+(?:\.\d+)?)+\s*\]\s+\d+(?:\.\d+)?$/u.test(definition.value)) throw new Error("dashstyle value must use Ipe/PDF dash syntax");
      return element("dashstyle", { name: definition.name, value: definition.value });
    case "opacity":
      if (definition.value < 0.001 || definition.value > 1) throw new Error("opacity must be between 0.001 and 1");
      return element("opacity", { name: definition.name, value: numberText(definition.value) });
    case "textstyle":
      return element("textstyle", {
        name: definition.name,
        begin: definition.begin,
        end: definition.end,
        ...(definition.type === undefined || definition.type === "minipage" ? {} : { type: definition.type }),
      });
    case "pathstyle":
      return element("pathstyle", {
        ...(definition.cap === undefined ? {} : { cap: definition.cap }),
        ...(definition.join === undefined ? {} : { join: definition.join }),
        ...(definition.fillrule === undefined ? {} : { fillrule: definition.fillrule }),
      });
    case "tiling":
      if (definition.angle < -90 || definition.angle > 90 || definition.width <= 0 || definition.step <= 0) throw new Error("invalid tiling parameters");
      return element("tiling", { name: definition.name, angle: numberText(definition.angle), width: numberText(definition.width), step: numberText(definition.step) });
    case "gradient": {
      const expected = definition.type === "axial" ? 4 : 6;
      if (definition.coords.length !== expected || definition.stops.length < 2) throw new Error("invalid gradient coordinates or stops");
      let prior = -1;
      const stops = definition.stops.map((stop) => {
        if (stop.offset < 0 || stop.offset > 1 || stop.offset < prior) throw new Error("gradient stops must be ordered in [0,1]");
        prior = stop.offset;
        return element("stop", { offset: numberText(stop.offset), color: colorValue(stop.color) });
      });
      return element("gradient", {
        name: definition.name,
        type: definition.type,
        coords: definition.coords.map((value) => numberText(value)).join(" "),
        ...(definition.extend === undefined ? {} : { extend: definition.extend ? "yes" : "no" }),
        ...(definition.matrix === undefined ? {} : { matrix: matrixText(definition.matrix) }),
      }, stops);
    }
    case "symbol": {
      // Symbols are object payloads too: validate their entire subtree using
      // the same five-tag walker as groups and imported XML.
      assertObjectContent(definition.object);
      walkNestedObjectXml(definition.object);
      const parameters = symbolParameters(definition.name);
      if (parameters === undefined) throw new Error(`symbol '${definition.name}' has unsupported parameter suffix`);
      if (definition.xform && /\([^()]*\)$/u.test(definition.name)) throw new Error("xform is not supported on parameterized symbols");
      if (definition.xform && definition.transformations !== undefined && definition.transformations !== "translations") {
        throw new Error("xform requires translations transformations");
      }
      const attributes: Record<string, string> = { name: definition.name };
      if (definition.xform) attributes.transformations = "translations";
      else if (definition.transformations !== undefined) attributes.transformations = definition.transformations;
      if (definition.xform) attributes.xform = "yes";
      if (definition.snap) attributes.snap = definition.snap.flatMap((point) => [numberText(point.x), numberText(point.y)]).join(" ");
      return element("symbol", attributes, [cloneObject(definition.object)]);
    }
  }
}

export function buildStylesheet(id: string, name: string, definitions: readonly StyleDefinition[]): Stylesheet {
  const keys = new Set<string>();
  const children = definitions.map((definition) => {
    const kind = definition.kind === "textstyle"
      ? definition.type === "label" ? "labelstyle" : "textstyle"
      : definition.kind;
    const key = `${kind}:${definition.kind === "pathstyle" ? "normal" : definition.name}`;
    if (keys.has(key)) throw new Error(`duplicate style definition '${key}'`);
    keys.add(key);
    return compileStyleDefinition(definition);
  });
  return { id, name, xml: element("ipestyle", { name }, children) };
}
