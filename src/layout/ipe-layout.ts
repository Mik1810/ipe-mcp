import type { DocumentIR } from "../domain/ir.js";
import { assertDomainNumber } from "../domain/numeric.js";
import { isXmlElement, type XmlElement } from "../domain/xml-node.js";
import type { PageCoordinateSystem } from "./coordinates.js";

export interface IpeLayoutDefinition {
  readonly paper: readonly [number, number];
  readonly origin: readonly [number, number];
  readonly frame: readonly [number, number];
}

/** Ipe 7.2.30 built-in standard stylesheet fallback (A4 in bp). */
export const IPE_STANDARD_LAYOUT: IpeLayoutDefinition = {
  paper: [595, 842],
  origin: [0, 0],
  frame: [595, 842],
};

function attribute(element: XmlElement, name: string): string | undefined {
  return element.attributes?.[name] ?? element.attributeList?.find((item) => item.name === name)?.value;
}

function pair(value: string | undefined, label: string, positive: boolean): readonly [number, number] {
  const parts = value?.trim().split(/\s+/u).map(Number) ?? [];
  if (parts.length !== 2) throw new Error(`Ipe layout '${label}' must contain exactly two numbers`);
  assertDomainNumber(parts[0]!, `Ipe layout ${label}[0]`);
  assertDomainNumber(parts[1]!, `Ipe layout ${label}[1]`);
  if (positive && (parts[0]! <= 0 || parts[1]! <= 0)) throw new Error(`Ipe layout '${label}' must be positive`);
  return [parts[0]!, parts[1]!];
}

/** Resolve the last effective <layout> in stylesheet cascade order. */
export function resolveIpeLayout(document: DocumentIR): IpeLayoutDefinition {
  const stylesheets = document.stylesheets && document.stylesheets.length > 0
    ? document.stylesheets
    : document.styles ?? [];
  let effective: XmlElement | undefined;
  for (const stylesheet of stylesheets) {
    for (const child of stylesheet.xml?.children ?? []) {
      if (isXmlElement(child) && child.name === "layout") effective = child;
    }
  }
  if (!effective) return IPE_STANDARD_LAYOUT;
  return {
    paper: pair(attribute(effective, "paper"), "paper", true),
    origin: pair(attribute(effective, "origin"), "origin", false),
    frame: pair(attribute(effective, "frame"), "frame", true),
  };
}

/** Ipe coordinates have the frame origin at (0,0); paper lower-left is -origin. */
export function coordinateSystemFromIpeLayout(layout: IpeLayoutDefinition): PageCoordinateSystem {
  for (const [label, values, positive] of [
    ["paper", layout.paper, true], ["origin", layout.origin, false], ["frame", layout.frame, true],
  ] as const) {
    for (const [index, value] of values.entries()) assertDomainNumber(value, `Ipe layout ${label}[${index}]`);
    if (positive && (values[0] <= 0 || values[1] <= 0)) throw new Error(`Ipe layout '${label}' must be positive`);
  }
  return {
    paper: { x: -layout.origin[0], y: -layout.origin[1], width: layout.paper[0], height: layout.paper[1] },
    frame: { x: 0, y: 0, width: layout.frame[0], height: layout.frame[1] },
  };
}

export function resolvePageCoordinateSystem(document: DocumentIR): PageCoordinateSystem {
  return coordinateSystemFromIpeLayout(resolveIpeLayout(document));
}
