import { randomUUID } from "node:crypto";

import type { IpeObject, Matrix } from "../domain/ir.js";
import { objectIdFromCustom } from "../domain/identity.js";
import { assertDomainNumber } from "../domain/numeric.js";
import type { XmlElement } from "../domain/xml-node.js";

export const IPE_OBJECT_KINDS = ["path", "text", "image", "group", "use"] as const;
export type IpeObjectKind = typeof IPE_OBJECT_KINDS[number];

export interface ObjectIdentity {
  readonly id: string;
  readonly custom: string;
}

export function createObjectIdentity(uuid = randomUUID()): ObjectIdentity {
  const custom = `ipe-mcp:${uuid.toLowerCase()}`;
  return { id: objectIdFromCustom(custom), custom };
}

export function objectKind(object: IpeObject): IpeObjectKind {
  const name = object.xml?.name;
  if (!name || !(IPE_OBJECT_KINDS as readonly string[]).includes(name)) {
    throw new Error(`object '${object.id}' has no supported compiled payload`);
  }
  return name as IpeObjectKind;
}

export function element(name: string, attributes: Record<string, string> = {}, children: XmlElement["children"] = []): XmlElement {
  return { type: "element", name, attributes, children };
}

export function numberText(value: number, label = "number"): string {
  assertDomainNumber(value, label);
  return Object.is(value, -0) ? "0" : value.toString();
}

export function pointText(point: { readonly x: number; readonly y: number }): string {
  return `${numberText(point.x, "point.x")} ${numberText(point.y, "point.y")}`;
}

export function matrixText(matrix: Matrix): string {
  if (matrix.length !== 6) throw new Error("matrix must contain six components");
  return matrix.map((value, index) => numberText(value, `matrix[${index}]`)).join(" ");
}

export function cloneObject<T>(value: T): T {
  return structuredClone(value);
}
