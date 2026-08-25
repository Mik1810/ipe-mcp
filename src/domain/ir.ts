import type { XmlElement, XmlNode } from "./xml-node.js";

export const IR_SCHEMA_VERSION = 1 as const;
export const IPE_FORMAT_VERSION = 70218 as const;

export type Matrix = readonly [number, number, number, number, number, number];

export interface SourceOmission {
  path: string;
  reason: string;
  value?: unknown;
}

export interface SourceInfo {
  omissions?: SourceOmission[];
  origin?: string;
  checksum?: string;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  [key: string]: string | undefined;
}

export interface Stylesheet {
  id: string;
  name?: string;
  xml?: XmlElement;
  [key: string]: unknown;
}

export interface Asset {
  id: string;
  kind?: string;
  mediaType?: string;
  hash?: string;
  data?: string;
  xml?: XmlElement;
  [key: string]: unknown;
}

export interface Layer {
  id: string;
  name: string;
  locked?: boolean;
  edit?: boolean;
  snap?: "never" | "visible" | "always";
  /** Compatibility alias: false maps to never, true maps to visible. */
  snapping?: boolean;
  /** Required to use Ipe's reserved BBOX/BACKGROUND/etc. layer names. */
  intentional?: boolean;
  [key: string]: unknown;
}

export interface AttributeMap {
  attribute: string;
  values: Record<string, string>;
  [key: string]: unknown;
}

export interface LayerTransform {
  layerId: string;
  matrix: Matrix;
  [key: string]: unknown;
}

export interface View {
  id: string;
  name?: string;
  visibleLayerIds: string[];
  activeLayerId: string;
  marked: boolean;
  attributeMaps?: AttributeMap[];
  /** Object form is the canonical IR representation. */
  layerTransforms?: Record<string, Matrix>;
  /** Array form is accepted for adapters which preserve source order. */
  transforms?: LayerTransform[];
  transition?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ObjectReference {
  kind: "style" | "symbol" | "asset" | "layer" | "object" | "page" | "view" | string;
  id: string;
  path?: string;
}

export interface IpeObject {
  id: string;
  custom?: string;
  layerId: string;
  zOrder: number;
  matrix?: Matrix;
  pin?: string;
  transformationMode?: string;
  xml?: XmlElement;
  references?: ObjectReference[];
  /** Common typed-reference fields, retained for adapters and validation. */
  styleId?: string;
  symbolId?: string;
  assetId?: string;
  [key: string]: unknown;
}

export interface Page {
  id: string;
  name?: string;
  title?: string;
  section?: string;
  subsection?: string;
  notes?: string;
  marked?: boolean;
  layers: Layer[];
  views: View[];
  /** A single global back-to-front sequence, never grouped by layer. */
  objects: IpeObject[];
  source?: SourceInfo;
  [key: string]: unknown;
}

export interface DocumentIR {
  schemaVersion: typeof IR_SCHEMA_VERSION;
  format: typeof IPE_FORMAT_VERSION;
  metadata?: DocumentMetadata;
  preamble?: string;
  stylesheets?: Stylesheet[];
  /** Alias retained for callers that use the shorter domain term. */
  styles?: Stylesheet[];
  assets?: Asset[];
  extensions?: Record<string, XmlNode | XmlNode[]>;
  pages: Page[];
  source?: SourceInfo;
}

/** Canonical stylesheet precedence: an explicitly supplied array wins even when empty. */
export function stylesheetList(document: DocumentIR): readonly Stylesheet[] {
  return document.stylesheets ?? document.styles ?? [];
}

export type Document = DocumentIR;
