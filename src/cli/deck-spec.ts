import { z } from "zod";

import { DOCUMENT_SHAPE_LIMITS, MCP_LIMITS } from "../limits.js";
import { operationSchema, type PublicOperation } from "../mcp/contracts.js";
import type { IpeMcpService } from "../mcp/service.js";

const layerName = z.string().regex(/^\S+$/u).max(MCP_LIMITS.nameChars);
const view = z.array(layerName).min(1).max(MCP_LIMITS.composeLayersMax);
const object = z.looseObject({
  op: z.enum(["add_text", "add_rectangle", "add_segment", "add_path"]),
  layer: layerName,
  pageId: z.never().optional(),
  layerId: z.never().optional(),
});

export const deckSpecSchema = z.strictObject({
  version: z.literal(1),
  preset: z.enum(["standard", "16:9"]),
  title: z.string().max(MCP_LIMITS.titleChars).optional(),
  slides: z.array(z.strictObject({
    title: z.string().max(MCP_LIMITS.titleChars).optional(),
    layers: z.array(layerName).min(1).max(MCP_LIMITS.composeLayersMax),
    views: z.array(view).min(1).max(DOCUMENT_SHAPE_LIMITS.maxViewsPerPage),
    objects: z.array(object).min(1).max(MCP_LIMITS.operationsPerBatch),
  })).min(1).max(DOCUMENT_SHAPE_LIMITS.maxPages),
});

type DeckSpec = z.infer<typeof deckSpecSchema>;
type DeckAuthor = Pick<IpeMcpService, "createDocument" | "compose" | "apply">;

function slideOperations(slide: DeckSpec["slides"][number], page: Awaited<ReturnType<DeckAuthor["compose"]>>): PublicOperation[] {
  const layers = new Map(slide.layers.map((name, index) => [name, page.layerIds[index]!]));
  const layerId = (name: string): string => {
    const id = layers.get(name);
    if (id === undefined) throw new Error('Unknown layer "' + name + '". Declare it in this slide’s layers.');
    return id;
  };
  const { pageId } = page;
  const views = slide.views.map((names, index): PublicOperation => {
    const visible = new Set(names.map(layerId));
    if (visible.size !== names.length) throw new Error("Each view must list its visible layers once.");
    // Ipe writes the visibility set in page layer order, independently of the active layer.
    const visibleLayerIds = page.layerIds.filter((id) => visible.has(id));
    const fields = { pageId, visibleLayerIds, activeLayerId: layerId(names[0]!) };
    return index === 0 ? { op: "update_view", viewId: page.viewIds[0]!, ...fields } : { op: "add_view", ...fields };
  });
  const objects = slide.objects.map(({ layer, ...fields }, index) => {
    const parsed = operationSchema.safeParse({ ...fields, pageId, layerId: layerId(layer) });
    if (!parsed.success) throw new Error("Object " + (index + 1) + " has unsupported or invalid fields:\n" + z.prettifyError(parsed.error));
    return parsed.data;
  });
  return [...views, ...objects];
}

/** Resolve slide-local names and replay the same operations used by MCP clients. */
export async function authorDeck(author: DeckAuthor, spec: DeckSpec) {
  const { documentId, outline, revision: initialRevision } = await author.createDocument(spec.preset, spec.title);
  let revision = initialRevision;
  for (const [index, slide] of spec.slides.entries()) {
    try {
      if (new Set(slide.layers).size !== slide.layers.length) throw new Error("Declare each layer only once.");
      const page = await author.compose(documentId, revision, { preset: spec.preset, title: slide.title, layers: slide.layers });
      revision = page.revision;
      if (index === 0) {
        const seedPageId = outline.pages[0]!.id;
        ({ revision } = await author.apply(documentId, revision, [{ op: "delete_page", pageId: seedPageId }], "DELETE"));
      }
      const operations = slideOperations(slide, page);
      for (let start = 0; start < operations.length; start += MCP_LIMITS.operationsPerBatch) {
        ({ revision } = await author.apply(documentId, revision, operations.slice(start, start + MCP_LIMITS.operationsPerBatch)));
      }
    } catch (error) {
      throw new Error("Slide " + (index + 1) + ": " + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
  }
  return { documentId, revision };
}
