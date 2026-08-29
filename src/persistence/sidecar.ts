import { z } from "zod";
import { createHash } from "node:crypto";
import type { DocumentIR } from "../domain/ir.js";

import { atomicWriteFile, type AtomicWriteOptions } from "./atomic.js";
import { readFileBounded } from "./bounded-read.js";
import { PERSISTENCE_LIMITS } from "../limits.js";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const sidecarV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  documentId: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  revision: z.number().int().nonnegative(),
  objectMetadata: z.record(z.string().min(1), jsonValueSchema).default({}),
  layoutConstraints: z.record(z.string().min(1), jsonValueSchema).default({}),
});

export type SidecarV1 = z.infer<typeof sidecarV1Schema>;

/** Native Ipe drops these extension attributes; keep composition identity here. */
export const COMPOSITION_SIDECAR_KEY = "ipe-mcp.composition.v1";
const compositionEntitySchema = z.strictObject({ id: z.string().min(1), name: z.string().optional() });
export const compositionSidecarV1Schema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  pages: z.array(z.strictObject({
    id: z.string().min(1), name: z.string().optional(),
    layers: z.array(compositionEntitySchema), views: z.array(compositionEntitySchema),
    objects: z.array(z.strictObject({
      id: z.string().min(1), custom: z.string().optional(),
      references: z.array(z.strictObject({ kind: z.string().min(1), id: z.string().min(1), path: z.string().optional() })).optional(),
    })),
  })).min(1),
});
export type CompositionSidecarV1 = z.infer<typeof compositionSidecarV1Schema>;

function compositionFingerprint(document: DocumentIR): string {
  const shape = document.pages.map((page) => {
    const layerNames = new Map(page.layers.map((layer) => [layer.id, layer.name]));
    return {
      metadata: [page.title, page.section, page.subsection, page.notes, page.marked],
      layers: page.layers.map((layer) => [layer.name, layer.edit, layer.locked, layer.snap]),
      views: page.views.map((view) => ({
        name: view.name,
        visible: view.visibleLayerIds.map((id) => layerNames.get(id) ?? id),
        active: layerNames.get(view.activeLayerId) ?? view.activeLayerId,
        marked: view.marked,
        transforms: Object.entries(view.layerTransforms ?? Object.fromEntries((view.transforms ?? []).map((transform) => [transform.layerId, transform.matrix])))
          .map(([id, matrix]) => [layerNames.get(id) ?? id, matrix])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      })),
      objects: page.objects.map((object) => [object.xml?.name, object.custom, layerNames.get(object.layerId) ?? object.layerId, object.zOrder]),
    };
  });
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

export function captureCompositionSidecar(document: DocumentIR): CompositionSidecarV1 {
  return compositionSidecarV1Schema.parse({ fingerprint: compositionFingerprint(document), pages: document.pages.map((page) => ({
    id: page.id, ...(page.name === undefined ? {} : { name: page.name }),
    layers: page.layers.map(({ id, name }) => ({ id, name })), views: page.views.map(({ id, name }) => ({ id, ...(name === undefined ? {} : { name }) })),
    objects: page.objects.map(({ id, custom, references }) => ({ id, ...(custom === undefined ? {} : { custom }), ...(references === undefined ? {} : { references }) })),
  })) });
}

export function withCompositionSidecar(sidecar: SidecarV1, document: DocumentIR): SidecarV1 {
  const composition = captureCompositionSidecar(document);
  return { ...sidecar, layoutConstraints: { ...sidecar.layoutConstraints, [COMPOSITION_SIDECAR_KEY]: composition } };
}

export function readCompositionSidecar(sidecar: SidecarV1): CompositionSidecarV1 | undefined {
  const value = sidecar.layoutConstraints[COMPOSITION_SIDECAR_KEY];
  return value === undefined ? undefined : compositionSidecarV1Schema.parse(value);
}

/** Reapply identity after a native ipetoipe round-trip; reject shape drift. */
export function rehydrateCompositionSidecar(document: DocumentIR, composition: CompositionSidecarV1): DocumentIR {
  const checked = compositionSidecarV1Schema.parse(composition);
  if (checked.pages.length !== document.pages.length || compositionFingerprint(document) !== checked.fingerprint) throw new Error("composition sidecar is stale for the current page, layer, view or object counts");
  const result = structuredClone(document);
  const layers = new Map<string, string>();
  result.pages.forEach((page, pageIndex) => {
    const saved = checked.pages[pageIndex]!;
    if (page.layers.length !== saved.layers.length || page.views.length !== saved.views.length || page.objects.length !== saved.objects.length) throw new Error("composition sidecar shape mismatch");
    page.layers.forEach((layer, i) => layers.set(layer.id, saved.layers[i]!.id));
  });
  result.pages.forEach((page, pageIndex) => {
    const saved = checked.pages[pageIndex]!;
    page.id = saved.id; if (saved.name === undefined) delete page.name; else page.name = saved.name;
    page.layers.forEach((layer, i) => { layer.id = saved.layers[i]!.id; });
    page.views.forEach((view, i) => { view.id = saved.views[i]!.id; if (saved.views[i]!.name === undefined) delete view.name; else view.name = saved.views[i]!.name; view.visibleLayerIds = view.visibleLayerIds.map((id) => layers.get(id) ?? id); view.activeLayerId = layers.get(view.activeLayerId) ?? view.activeLayerId; if (view.layerTransforms !== undefined) view.layerTransforms = Object.fromEntries(Object.entries(view.layerTransforms).map(([id, matrix]) => [layers.get(id) ?? id, matrix])); if (view.transforms !== undefined) view.transforms = view.transforms.map((transform) => ({ ...transform, layerId: layers.get(transform.layerId) ?? transform.layerId })); });
    page.objects.forEach((object, i) => { const savedObject = saved.objects[i]!; object.id = savedObject.id; object.layerId = layers.get(object.layerId) ?? object.layerId; if (savedObject.custom === undefined) delete object.custom; else object.custom = savedObject.custom; if (savedObject.references === undefined) delete object.references; else object.references = savedObject.references.map((reference) => ({ kind: reference.kind, id: reference.id, ...(reference.path === undefined ? {} : { path: reference.path }) })); });
  });
  return result;
}

const legacyV0Schema = z.strictObject({
  version: z.literal(0),
  documentId: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  revision: z.number().int().nonnegative().default(0),
  metadata: z.record(z.string().min(1), jsonValueSchema).default({}),
});

export function migrateSidecar(input: unknown): SidecarV1 {
  const current = sidecarV1Schema.safeParse(input);
  if (current.success) return current.data;
  const legacy = legacyV0Schema.parse(input);
  return sidecarV1Schema.parse({
    schemaVersion: 1,
    documentId: legacy.documentId,
    sourceHash: legacy.sourceHash,
    revision: legacy.revision,
    objectMetadata: legacy.metadata,
    layoutConstraints: {},
  });
}

export async function readSidecar(path: string, maxBytes = PERSISTENCE_LIMITS.maxSidecarBytes): Promise<SidecarV1> {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFileBounded(path, maxBytes));
  return migrateSidecar(JSON.parse(source) as unknown);
}

export async function writeSidecar(
  path: string,
  sidecar: SidecarV1,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const validated = sidecarV1Schema.parse(sidecar);
  await atomicWriteFile(path, `${JSON.stringify(validated, null, 2)}\n`, options);
}
