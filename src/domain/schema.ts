import { z } from "zod";
import { isValidXml10String } from "./xml-chars.js";
import { MATRIX_SINGULAR_RELATIVE_TOLERANCE, MAX_DOMAIN_MAGNITUDE } from "./numeric.js";
import { SCHEMA_CAPS as CAPS } from "../limits.js";

const finite = z.number().finite().min(-MAX_DOMAIN_MAGNITUDE).max(MAX_DOMAIN_MAGNITUDE);
const xmlString = (maximum: number) => z.string().max(maximum).refine(isValidXml10String, "contains XML 1.0-invalid characters");
const text = xmlString(CAPS.text);
const id = xmlString(CAPS.id).min(1);
export const matrixSchema = z.tuple([finite, finite, finite, finite, finite, finite]).refine(
  ([a, b, c, d]) => {
    const norm = Math.max(Math.abs(a) + Math.abs(c), Math.abs(b) + Math.abs(d));
    return norm > 0 && Math.abs(a * d - b * c) > MATRIX_SINGULAR_RELATIVE_TOLERANCE * norm * norm;
  },
  { message: "matrix linear part is singular or numerically degenerate" },
);

export const xmlAttributeSchema = z.object({
  name: z.string().min(1).max(CAPS.elementName),
  value: text,
});

export const xmlNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([xmlElementSchema, z.object({ type: z.literal("text"), text }), z.object({ type: z.literal("comment"), text })]),
);

export const xmlElementSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    type: z.literal("element").optional(),
    name: z.string().min(1).max(CAPS.elementName),
    attributes: z.record(z.string().max(CAPS.attributeName), text).optional(),
    attributeList: z.array(xmlAttributeSchema).max(CAPS.attributeList).optional(),
    children: z.array(xmlNodeSchema).max(CAPS.children).optional(),
  }),
);

export const sourceOmissionSchema = z.object({
  path: z.string().min(1).max(CAPS.elementName),
  reason: text,
  value: z.unknown().optional(),
});
export const sourceInfoSchema = z.object({
  omissions: z.array(sourceOmissionSchema).max(CAPS.omissions).optional(),
  origin: text.optional(),
  checksum: z.string().max(CAPS.checksum).optional(),
});

export const metadataSchema = z.record(z.string().max(CAPS.metadataKey), text);
export const stylesheetSchema = z.object({ id, name: text.optional(), xml: xmlElementSchema.optional() }).passthrough();
export const assetSchema = z.object({
  id,
  kind: text.optional(),
  mediaType: text.optional(),
  hash: z.string().max(512).optional(),
  data: z.string().max(CAPS.assetData).optional(),
  xml: xmlElementSchema.optional(),
}).passthrough();

export const layerSchema = z.object({
  id,
  name: xmlString(256).min(1),
  locked: z.boolean().optional(),
  edit: z.boolean().optional(),
  snap: z.enum(["never", "visible", "always"]).optional(),
  snapping: z.boolean().optional(),
  intentional: z.boolean().optional(),
}).passthrough();

export const attributeMapSchema = z.object({
  attribute: z.string().min(1).max(CAPS.metadataKey),
  values: z.record(text, text),
}).passthrough();
export const layerTransformSchema = z.object({ layerId: id, matrix: matrixSchema }).passthrough();
export const objectReferenceSchema = z.object({ kind: id, id, path: text.optional() });

export const viewSchema = z.object({
  id,
  name: xmlString(256).optional(),
  visibleLayerIds: z.array(id).max(CAPS.visibleLayerIds),
  activeLayerId: id,
  marked: z.boolean(),
  attributeMaps: z.array(attributeMapSchema).max(CAPS.attributeMaps).optional(),
  layerTransforms: z.record(id, matrixSchema).optional(),
  transforms: z.array(layerTransformSchema).max(CAPS.transforms).optional(),
  transition: z.record(z.string().max(CAPS.metadataKey), z.unknown()).optional(),
}).passthrough();

export const objectSchema = z.object({
  id,
  custom: xmlString(4096).optional(),
  layerId: id,
  zOrder: finite.int().min(0).max(CAPS.zOrder),
  matrix: matrixSchema.optional(),
  pin: text.optional(),
  transformationMode: text.optional(),
  xml: xmlElementSchema.optional(),
  references: z.array(objectReferenceSchema).max(CAPS.references).optional(),
  styleId: id.optional(),
  symbolId: id.optional(),
  assetId: id.optional(),
}).passthrough();

export const pageSchema = z.object({
  id,
  name: xmlString(256).optional(),
  title: text.optional(),
  section: text.optional(),
  subsection: text.optional(),
  notes: text.optional(),
  marked: z.boolean().optional(),
  layers: z.array(layerSchema).max(CAPS.layersPerPage),
  views: z.array(viewSchema).max(CAPS.viewsPerPage),
  objects: z.array(objectSchema).max(CAPS.objectsPerPage),
  source: sourceInfoSchema.optional(),
}).passthrough();

export const documentSchema = z.object({
  schemaVersion: z.literal(1),
  format: z.literal(70218),
  metadata: metadataSchema.optional(),
  preamble: xmlString(CAPS.preamble).optional(),
  stylesheets: z.array(stylesheetSchema).max(CAPS.stylesheets).optional(),
  styles: z.array(stylesheetSchema).max(CAPS.stylesheets).optional(),
  assets: z.array(assetSchema).max(CAPS.assets).optional(),
  extensions: z.record(z.string().max(CAPS.metadataKey), z.union([xmlNodeSchema, z.array(xmlNodeSchema).max(CAPS.references)])).optional(),
  pages: z.array(pageSchema).max(CAPS.pages),
  source: sourceInfoSchema.optional(),
});

export const DocumentSchema = documentSchema;
export const PageSchema = pageSchema;
export const LayerSchema = layerSchema;
export const ViewSchema = viewSchema;
export const ObjectSchema = objectSchema;
export const XmlElementSchema = xmlElementSchema;
export const MatrixSchema = matrixSchema;
