import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { IpeMcpService } from "../../src/mcp/service.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function serviceFixture() {
  const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m8-")); roots.push(root);
  return { root, state: join(root, ".state"), service: await IpeMcpService.create([root], join(root, ".state")) };
}

describe("M8 service transactions and recovery", () => {
  it("rejects stale and invalid-ID batches without partial writes", async () => {
    const { service } = await serviceFixture();
    const created = await service.createDocument("16:9", "Atomic");
    const page = (created.outline.pages as Array<{ id: string; layers: Array<{ id: string }> }>)[0]!;
    await expect(service.apply(created.documentId, 0, [
      { op: "add_rectangle", pageId: page.id, layerId: page.layers[0]!.id, x: 10, y: 10, width: 40, height: 20 },
      { op: "delete_object", pageId: page.id, objectId: "object-000000000000000000000000" },
    ], "DELETE")).rejects.toThrow();
    expect(service.inspect(created.documentId).revision).toBe(0);

    const applied = await service.apply(created.documentId, 0, [{ op: "add_rectangle", pageId: page.id, layerId: page.layers[0]!.id, x: 10, y: 10, width: 40, height: 20, stroke: "0" }]);
    expect(service.documentResource(created.documentId, "source").text).toContain('stroke="0"');
    await expect(service.apply(created.documentId, 0, [{ op: "set_metadata", title: "stale" }])).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(service.inspect(created.documentId).revision).toBe(applied.revision);
  });

  it("replaces typed object content by exact ID without changing identity", async () => {
    const { service } = await serviceFixture();
    const created = await service.createDocument("standard");
    const page = (created.outline.pages as Array<{ id: string; layers: Array<{ id: string }> }>)[0]!;
    const added = await service.apply(created.documentId, 0, [{ op: "add_rectangle", pageId: page.id, layerId: page.layers[0]!.id, x: 1, y: 2, width: 3, height: 4 }]);
    const objectId = added.createdIds.find((id) => id.startsWith("object-"))!;
    const replaced = await service.apply(created.documentId, 1, [{ op: "replace_object", pageId: page.id, objectId, replacement: { kind: "path", path: { kind: "circle", center: { x: 25, y: 30 }, radius: 8, style: { fill: "0.2" } } } }]);
    const objects = (replaced.outline.pages as Array<{ objects: Array<{ id: string; layerId: string }> }>)[0]!.objects;
    expect(objects).toEqual([{ id: objectId, layerId: page.layers[0]!.id, zOrder: 0, type: "path" }]);
    expect(replaced.createdIds).toEqual([]);
    expect(replaced.deletedIds).toEqual([]);
    expect(service.documentResource(created.documentId, "source").text).toContain('fill="0.2"');
  });

  it("requires confirmation and returns deleted-state evidence", async () => {
    const { service } = await serviceFixture();
    const created = await service.createDocument("standard");
    const page = (created.outline.pages as Array<{ id: string; layers: Array<{ id: string }> }>)[0]!;
    const added = await service.apply(created.documentId, 0, [{ op: "add_rectangle", pageId: page.id, layerId: page.layers[0]!.id, x: 1, y: 2, width: 3, height: 4 }]);
    const objectId = added.createdIds.find((id) => id.startsWith("object-"))!;
    await expect(service.apply(created.documentId, 1, [{ op: "delete_object", pageId: page.id, objectId }])).rejects.toThrow(/confirmation/iu);
    const removed = await service.apply(created.documentId, 1, [{ op: "delete_object", pageId: page.id, objectId }], "DELETE");
    expect(removed.deletedIds).toContain(objectId);
  });

  it("returns complete changed-only previous values coalesced against final batch state", async () => {
    const { service } = await serviceFixture();
    const created = await service.createDocument("standard", "original");
    const initialPage = (created.outline.pages as Array<{ id: string; layers: Array<{ id: string }>; views: Array<{ id: string }> }>)[0]!;
    const withLayer = await service.apply(created.documentId, 0, [{ op: "add_layer", pageId: initialPage.id, name: "extra" }]);
    const page = (withLayer.outline.pages as Array<{ id: string; layers: Array<{ id: string; name: string }>; views: Array<{ id: string }> }>)[0]!;
    const contentLayer = page.layers.find((item) => item.name === "content")!;
    const extraLayer = page.layers.find((item) => item.name === "extra")!;
    const updated = await service.apply(created.documentId, 1, [
      { op: "set_metadata", title: "changed", author: "Ada" },
      { op: "update_page", pageId: page.id, patch: { name: "page-name", title: "page-title", section: "section", subsection: "subsection", notes: "notes", marked: true } },
      { op: "update_layer", pageId: page.id, layerId: contentLayer.id, name: "primary", edit: true, snap: "always" },
      { op: "update_view", pageId: page.id, viewId: page.views[0]!.id, visibleLayerIds: [contentLayer.id, extraLayer.id], activeLayerId: extraLayer.id, marked: true },
    ]);
    expect(updated.previousValues).toEqual([
      { op: "set_metadata", value: { title: "original", author: null } },
      { op: "update_page", id: page.id, value: { name: null, title: null, section: null, subsection: null, notes: null, marked: null } },
      { op: "update_layer", id: contentLayer.id, value: { name: "content", edit: null, snap: null } },
      { op: "update_view", id: page.views[0]!.id, value: { visibleLayerIds: [contentLayer.id], activeLayerId: contentLayer.id, marked: false } },
    ]);

    const unchanged = await service.apply(created.documentId, 2, [
      { op: "set_metadata", title: "changed", author: "Ada" },
      { op: "update_page", pageId: page.id, patch: { section: "temporary" } },
      { op: "update_page", pageId: page.id, patch: { section: "section", subsection: "subsection" } },
      { op: "update_layer", pageId: page.id, layerId: contentLayer.id, name: "primary", edit: true, snap: "always" },
      { op: "update_view", pageId: page.id, viewId: page.views[0]!.id, visibleLayerIds: [contentLayer.id, extraLayer.id], activeLayerId: extraLayer.id, marked: true },
    ]);
    expect(unchanged.previousValues).toEqual([]);

    const withTemporaryPage = await service.apply(created.documentId, 3, [{ op: "add_page", name: "temporary" }]);
    const temporaryPageId = (withTemporaryPage.outline.pages as Array<{ id: string; name?: string }>).find((item) => item.name === "temporary")!.id;
    const removedTarget = await service.apply(created.documentId, 4, [
      { op: "update_page", pageId: temporaryPageId, patch: { title: "not retained" } },
      { op: "delete_page", pageId: temporaryPageId },
    ], "DELETE");
    expect(removedTarget.deletedIds).toContain(temporaryPageId);
    expect(removedTarget.previousValues).toEqual([]);
  });

  it("keeps snapshot IDs usable after restart and supports undo/restore", async () => {
    const { root, state, service } = await serviceFixture();
    const created = await service.createDocument("standard", "before");
    const snapshot = await service.history(created.documentId, "snapshot", 0);
    await service.apply(created.documentId, 0, [{ op: "set_metadata", title: "after" }]);
    const undone = await service.history(created.documentId, "undo", 1);
    expect(undone.revision).toBe(2);

    const restarted = await IpeMcpService.create([root], state);
    expect(await restarted.recover()).toContainEqual({ documentId: created.documentId, revision: 2 });
    const listed = await restarted.history(created.documentId, "list");
    expect(listed.snapshots).toContainEqual({ snapshotId: snapshot.snapshotId });
    const restored = await restarted.history(created.documentId, "restore", 2, snapshot.snapshotId as string);
    expect(restored.revision).toBe(3);
    expect(restarted.inspect(created.documentId).revision).toBe(3);
  });

  it("facades paths, assets, symbols, grouping, transforms, layout, and reorder atomically", async () => {
    const { service } = await serviceFixture();
    const created = await service.createDocument("16:9");
    const page = (created.outline.pages as Array<{ id: string; layers: Array<{ id: string }> }>)[0]!;
    const png = new PNG({ width: 1, height: 1 }); png.data.set([20, 40, 60, 255]);
    const authored = await service.apply(created.documentId, 0, [
      { op: "add_stylesheet", name: "agent-styles", definitions: [{ kind: "color", name: "agentblue", value: [0.1, 0.2, 0.8] }, { kind: "symbol", name: "mark/agent", path: { kind: "circle", center: { x: 0, y: 0 }, radius: 2, style: { fill: "agentblue" } } }] },
      { op: "add_path", pageId: page.id, layerId: page.layers[0]!.id, path: { kind: "polygon", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 20 }], style: { fill: "agentblue", stroke: "0" } } },
      { op: "add_symbol_use", pageId: page.id, layerId: page.layers[0]!.id, name: "mark/agent", position: { x: 30, y: 30 } },
      { op: "add_image", pageId: page.id, layerId: page.layers[0]!.id, mediaType: "image/png", dataBase64: PNG.sync.write(png).toString("base64"), target: { x: 40, y: 40, width: 10, height: 10 }, fit: "contain" },
    ]);
    expect(authored.createdIds.some((id) => id.startsWith("style-"))).toBe(true);
    expect(authored.createdIds.some((id) => id.startsWith("asset-"))).toBe(true);
    const objectIds = authored.createdIds.filter((id) => id.startsWith("object-"));
    expect(objectIds).toHaveLength(3);
    const grouped = await service.apply(created.documentId, 1, [{ op: "group_objects", pageId: page.id, objectIds: objectIds.slice(0, 2) }]);
    const groupId = grouped.createdIds.find((id) => id.startsWith("object-"))!;
    await service.apply(created.documentId, 2, [
      { op: "transform_object", pageId: page.id, objectId: groupId, matrix: [1, 0, 0, 1, 5, 6], space: "page" },
      { op: "layout_objects", pageId: page.id, layout: { primitive: "row", container: { x: 0, y: 0, width: 100, height: 20 }, items: [{ objectId: groupId, source: { x: 0, y: 0, width: 20, height: 20 } }, { objectId: objectIds[2]!, source: { x: 40, y: 40, width: 10, height: 10 } }], gap: 5 } },
    ]);
    expect((await service.apply(created.documentId, 3, [{ op: "ungroup_object", pageId: page.id, objectId: groupId }])).revision).toBe(4);
    const addedPage = await service.apply(created.documentId, 4, [{ op: "add_page", name: "second" }]);
    const pages = (addedPage.outline.pages as Array<{ id: string }>).map((item) => item.id);
    const reordered = await service.apply(created.documentId, 5, [{ op: "reorder_pages", pageIds: [...pages].reverse() }]);
    expect((reordered.outline.pages as Array<{ id: string }>).map((item) => item.id)).toEqual([...pages].reverse());
  });

  it("exposes panel scroll, camera pan, and transitions through the M7 facade", async () => {
    const { service } = await serviceFixture();
    const created = await service.createDocument("16:9");
    const page = (created.outline.pages as Array<{ id: string; layers: Array<{ id: string }> }>)[0]!;
    const added = await service.apply(created.documentId, 0, [{ op: "add_rectangle", pageId: page.id, layerId: page.layers[0]!.id, x: 0, y: 0, width: 20, height: 10 }]);
    const objectId = added.createdIds.find((id) => id.startsWith("object-"))!;
    const scrolled = await service.buildViews(created.documentId, 1, { kind: "panel_scroll", pageId: page.id, objectId, axis: "x", from: 0, to: 10, clip: { x: 0, y: 0, width: 20, height: 10 }, steps: 2 });
    expect(scrolled.viewIds).toHaveLength(2);
    const transitioned = await service.buildViews(created.documentId, 2, { kind: "transition", pageId: page.id, viewIds: [scrolled.viewIds[0]!], effect: "fade" });
    expect(transitioned.viewIds).toEqual([scrolled.viewIds[0]]);

    const second = await service.createDocument("16:9");
    const secondPage = (second.outline.pages as Array<{ id: string; layers: Array<{ id: string }> }>)[0]!;
    const secondAdded = await service.apply(second.documentId, 0, [{ op: "add_rectangle", pageId: secondPage.id, layerId: secondPage.layers[0]!.id, x: 0, y: 0, width: 20, height: 10 }]);
    const panned = await service.buildViews(second.documentId, 1, { kind: "camera_pan", pageId: secondPage.id, objectIds: [secondAdded.createdIds.find((id) => id.startsWith("object-"))!], from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, steps: 2 });
    expect(panned.viewIds).toHaveLength(2);
  });

  it("rejects an over-limit document shape and rolls back without a revision bump", async () => {
    const { service } = await serviceFixture();
    const created = await service.createDocument("standard");
    const page = (created.outline.pages as Array<{ id: string; layers: Array<{ id: string }> }>)[0]!;
    expect(page.layers.length).toBe(1);
    const addLayer = (index: number) => ({ op: "add_layer", pageId: page.id, name: `layer-${index}` }) as const;
    const capped = await service.apply(created.documentId, 0, Array.from({ length: 254 }, (_, index) => addLayer(index)));
    expect(capped.revision).toBe(1);
    const boundary = await service.apply(created.documentId, 1, [addLayer(254)]);
    expect(boundary.revision).toBe(2);
    let caught: unknown;
    try {
      await service.apply(created.documentId, 2, [addLayer(255)]);
    } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "LIMIT_EXCEEDED", dimension: "layers" });
    expect(service.inspect(created.documentId).revision).toBe(2);
  });
});
