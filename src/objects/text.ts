import { createHash } from "node:crypto";

import type { DocumentIR, IpeObject } from "../domain/ir.js";
import { assertDomainNumber, numericallyEqual } from "../domain/numeric.js";
import { isXmlElement } from "../domain/xml-node.js";
import type { BoundsResult, Box } from "../layout/geometry.js";
import { cloneObject, numberText } from "./common.js";

export interface TextMetrics {
  readonly width: number;
  /** Height above the baseline. */
  readonly height: number;
  /** Depth below the baseline. */
  readonly depth: number;
}

export interface TextMeasurementRequest {
  readonly objectId: string;
  readonly mode: "label" | "minipage";
  readonly source: string;
  readonly preamble: string;
  readonly width?: number;
  readonly style?: string;
  readonly size?: string;
  readonly fingerprint: string;
}

export interface TextMeasurementProvider {
  measure(request: TextMeasurementRequest): TextMetrics | Promise<TextMetrics>;
}

function attributes(object: IpeObject): Record<string, string> {
  if (object.xml?.name !== "text") throw new Error(`object '${object.id}' is not text`);
  return object.xml.attributes ??= {};
}

function textSource(object: IpeObject): string {
  return (object.xml?.children ?? []).map((child) => child.type === "text" ? child.text : isXmlElement(child) ? "" : "").join("");
}

function optionalNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const result = Number(value);
  assertDomainNumber(result, label);
  if (result < 0) throw new Error(`${label} must be non-negative`);
  return result;
}

export function textMeasurementRequest(document: DocumentIR, object: IpeObject): TextMeasurementRequest {
  const attr = attributes(object);
  const mode = attr.type === "minipage" ? "minipage" : "label";
  const source = textSource(object);
  const width = mode === "minipage" ? optionalNumber(attr.width, "text width") : undefined;
  if (mode === "minipage" && width === undefined) throw new Error("minipage text requires width");
  const payload = JSON.stringify({
    source,
    preamble: document.preamble ?? "",
    mode,
    width,
    style: attr.style ?? "normal",
    size: attr.size ?? "normal",
    styles: (document.stylesheets ?? document.styles ?? []).map((style) => style.xml),
  });
  const fingerprint = createHash("sha256").update(payload).digest("hex");
  return {
    objectId: object.id,
    mode,
    source,
    preamble: document.preamble ?? "",
    ...(width === undefined ? {} : { width }),
    ...(attr.style === undefined ? {} : { style: attr.style }),
    ...(attr.size === undefined ? {} : { size: attr.size }),
    fingerprint,
  };
}

export function applyTextMetrics(object: IpeObject, metrics: TextMetrics, fingerprint?: string): void {
  for (const [name, value] of Object.entries(metrics)) {
    assertDomainNumber(value, `text metrics.${name}`);
    if (value < 0) throw new Error(`text metrics.${name} must be non-negative`);
  }
  const attr = attributes(object);
  attr.width = numberText(metrics.width, "text metrics.width");
  attr.height = numberText(metrics.height, "text metrics.height");
  attr.depth = numberText(metrics.depth, "text metrics.depth");
  if (fingerprint !== undefined) attr["x-ipe-mcp-measurement"] = fingerprint;
}

function equalMetrics(left: TextMetrics, right: TextMetrics): boolean {
  return numericallyEqual(left.width, right.width)
    && numericallyEqual(left.height, right.height)
    && numericallyEqual(left.depth, right.depth);
}

/** Provider injection keeps untrusted LaTeX execution outside M4; M6 supplies the sandboxed provider. */
export async function resolveTextTwoPass(
  document: DocumentIR,
  object: IpeObject,
  provider: TextMeasurementProvider,
): Promise<TextMetrics> {
  const request = textMeasurementRequest(document, object);
  const first = await provider.measure(request);
  const probe = cloneObject(object);
  applyTextMetrics(probe, first, request.fingerprint);
  const secondRequest = textMeasurementRequest(document, probe);
  const second = await provider.measure(secondRequest);
  if (!equalMetrics(first, second)) throw new Error(`text measurement did not converge within two passes for '${object.id}'`);
  applyTextMetrics(object, second, secondRequest.fingerprint);
  return second;
}

export function textBounds(object: IpeObject): BoundsResult {
  const attr = attributes(object);
  const [x, y] = (attr.pos ?? "").trim().split(/\s+/u).map(Number);
  assertDomainNumber(x!, "text position.x");
  assertDomainNumber(y!, "text position.y");
  const width = optionalNumber(attr.width, "text width");
  const height = optionalNumber(attr.height, "text height");
  const depth = optionalNumber(attr.depth, "text depth");
  if (width === undefined || height === undefined || depth === undefined) return { status: "deferred", reason: "latex" };
  const totalHeight = height + depth;
  assertDomainNumber(totalHeight, "text total height");
  const horizontal = attr.halign ?? "left";
  const vertical = attr.valign ?? (attr.type === "minipage" ? "top" : "bottom");
  const left = horizontal === "center" ? x! - width / 2 : horizontal === "right" ? x! - width : x!;
  const bottom = vertical === "top" ? y! - totalHeight : vertical === "center" ? y! - totalHeight / 2 : vertical === "baseline" ? y! - depth : y!;
  const box: Box = { x: left, y: bottom, width, height: totalHeight };
  return { status: "known", boxes: { logical: box, geometric: box, visual: box }, baselineFromBottom: depth };
}
