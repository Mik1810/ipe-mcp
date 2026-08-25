import { describe, expect, it } from "vitest";
import { addLayer, addView, captureCompositionSidecar, composeSlide, createArbitraryView, createCumulativeView, createPage, deleteLayer, deletePage, deleteView, duplicateLayer, duplicatePage, duplicateView, estimatePdfExpansion, ipeDocumentCodec, markHandout, objectIdFromCustom, rehydrateCompositionSidecar, reorderLayers, reorderPages, reorderViews, serializeXml, updatePage, updateView, validateDocument } from "../../src/index.js";

describe("M5 page/view composition", () => {
  it("composes a non-destructive 16:9 page and maps every view", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><ipestyle name="slide"><layout paper="1280 720" origin="32 0" frame="1216 648"/></ipestyle><page><layer name="base"/><view layers="base" active="base" marked="no"/></page></ipe>');
    const before = document.pages[0]!.objects;
    const page = composeSlide(document, { preset: "16:9", name: "slide", title: "Title", notes: "Notes", layers: [{ name: "content" }, { name: "annotation" }] });
    createArbitraryView(document, page.id, [page.layers[0]!.id], page.layers[0]!.id, "partial");
    createCumulativeView(document, page.id, page.views[0]!.id, page.layers.map((layer) => layer.id), "cumulative");
    expect(document.pages[0]!.objects).toEqual(before);
    expect(estimatePdfExpansion(document).pdfPages).toBe(4);
    expect(markHandout(document, (view) => view.name === "cumulative")).toHaveLength(1);
    expect(ipeDocumentCodec.parse(ipeDocumentCodec.serialize(document)).pages.at(-1)).toMatchObject({ name: "slide", title: "Title", notes: "Notes" });
  });

  it("supports atomic CRUD, ordering, duplication and stable typed references", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><page x-ipe-mcp-name="one"><layer name="a"/><layer name="b"/><view layers="a b" active="a" name="show"/><view layers="a" active="a" name="show-copy"/></page><page x-ipe-mcp-name="two"><layer name="a"/><view layers="a" active="a"/></page></ipe>');
    const source = document.pages[0]!;
    const added = addLayer(document, source.id, { name: "c" });
    const addedView = addView(document, source.id, { name: "extra", visibleLayerIds: [source.layers[0]!.id], activeLayerId: source.layers[0]!.id });
    updatePage(document, source.id, { name: "renamed" });
    updateView(document, source.id, addedView.id, { name: "extra-renamed", marked: true });
    reorderLayers(document, source.id, [added.id, source.layers[1]!.id, source.layers[0]!.id]);
    reorderViews(document, source.id, [addedView.id, source.views[0]!.id, source.views[1]!.id]);
    const copiedView = duplicateView(document, source.id, source.views[0]!.id);
    expect(copiedView.name).toBe("show-copy-2");
    deleteView(document, source.id, copiedView.id);
    deleteLayer(document, source.id, added.id);
    const copy = duplicatePage(document, source.id);
    expect(copy.id).not.toBe(source.id);
    expect(new Set(copy.views.map((v) => v.id)).size).toBe(copy.views.length);
    expect(document.pages.map((p) => p.name)).toContain("renamed");
    const copiedLayer = duplicateLayer(document, source.id, source.layers[0]!.id);
    expect(copiedLayer.id).not.toBe(source.layers[0]!.id);
    expect(duplicateLayer(document, source.id, source.layers[0]!.id).name).toBe(`${source.layers[0]!.name}-copy-2`);
    const createdPage = createPage(document, { name: "created" });
    reorderPages(document, [createdPage.id, ...document.pages.filter((page) => page.id !== createdPage.id).map((page) => page.id)]);
    expect(document.pages[0]!.id).toBe(createdPage.id);
    deletePage(document, createdPage.id);
  });

  it("freshens repeatable templates and remaps transforms and typed references", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="base"/><view layers="base" active="base"/></page></ipe>');
    const custom = "ipe-mcp:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const template = {
      pageId: "page-aaaaaaaaaaaaaaaaaaaaaaaa",
      layers: [{ id: "layer-aaaaaaaaaaaaaaaaaaaaaaaa", name: "content" }],
      views: [
        { id: "view-aaaaaaaaaaaaaaaaaaaaaaaa", name: "template-view", visibleLayerIds: ["layer-aaaaaaaaaaaaaaaaaaaaaaaa"], activeLayerId: "layer-aaaaaaaaaaaaaaaaaaaaaaaa", marked: false, layerTransforms: { "layer-aaaaaaaaaaaaaaaaaaaaaaaa": [1, 0, 0, 1, 10, 0] as const } },
        { id: "view-bbbbbbbbbbbbbbbbbbbbbbbb", name: "template-view-array", visibleLayerIds: ["layer-aaaaaaaaaaaaaaaaaaaaaaaa"], activeLayerId: "layer-aaaaaaaaaaaaaaaaaaaaaaaa", marked: false, transforms: [{ layerId: "layer-aaaaaaaaaaaaaaaaaaaaaaaa", matrix: [1, 0, 0, 1, 20, 0] as const }] },
      ],
      objects: [{ id: objectIdFromCustom(custom), custom, layerId: "layer-aaaaaaaaaaaaaaaaaaaaaaaa", zOrder: 0, xml: { type: "element" as const, name: "path", attributes: {}, children: [{ type: "text" as const, text: "0 0 m 10 0 l" }] }, references: [{ kind: "page", id: "page-aaaaaaaaaaaaaaaaaaaaaaaa" }, { kind: "view", id: "view-aaaaaaaaaaaaaaaaaaaaaaaa" }, { kind: "layer", id: "layer-aaaaaaaaaaaaaaaaaaaaaaaa" }] }],
    };
    const first = composeSlide(document, { name: "templated", template });
    const second = composeSlide(document, { name: "templated", template });
    expect(second.name).toBe("templated-2");
    expect(second.layers[0]!.id).not.toBe(first.layers[0]!.id);
    expect(Object.keys(second.views[0]!.layerTransforms!)).toEqual([second.layers[0]!.id]);
    expect(second.views[1]!.transforms?.[0]!.layerId).toBe(second.layers[0]!.id);
    expect(second.objects[0]!.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "page", id: second.id }),
      expect.objectContaining({ kind: "view", id: second.views[0]!.id }),
      expect.objectContaining({ kind: "layer", id: second.layers[0]!.id }),
    ]));
    expect(validateDocument(document).ok).toBe(true);
  });

  it("requires intentional special layers and rehydrates native-stripped composition identity", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="base"/><view layers="base" active="base"/></page></ipe>');
    const before = structuredClone(document);
    expect(() => addLayer(document, document.pages[0]!.id, { name: "BBOX" })).toThrow(/intentional/u);
    expect(document).toEqual(before);
    const bbox = addLayer(document, document.pages[0]!.id, { name: "BBOX", intentional: true });
    deleteLayer(document, document.pages[0]!.id, bbox.id);
    updatePage(document, document.pages[0]!.id, { name: "durable-page" });
    const referenceCustom = "ipe-mcp:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    document.pages[0]!.objects.push({
      id: objectIdFromCustom(referenceCustom), custom: referenceCustom,
      layerId: document.pages[0]!.layers[0]!.id, zOrder: 0,
      xml: { type: "element", name: "path", attributes: {}, children: [{ type: "text", text: "0 0 m 1 1 l" }] },
      references: [{ kind: "page", id: document.pages[0]!.id }, { kind: "view", id: document.pages[0]!.views[0]!.id }],
    });
    const sidecar = captureCompositionSidecar(document);
    const stripped = serializeXml(document, { compositionSidecarAuthoritative: true })
      .replaceAll(/ x-ipe-mcp-id="[^"]+"/gu, "");
    const reparsed = ipeDocumentCodec.parse(stripped);
    const restored = rehydrateCompositionSidecar(reparsed, sidecar);
    expect(restored.pages[0]).toMatchObject({ id: document.pages[0]!.id, name: "durable-page" });
    expect(restored.pages[0]!.objects[0]!.references).toEqual(document.pages[0]!.objects[0]!.references);
    reparsed.pages[0]!.layers[0]!.name = "changed";
    expect(() => rehydrateCompositionSidecar(reparsed, sidecar)).toThrow(/stale/u);

    const transformed = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"><transform layer="a" matrix="1 0 0 1 1 0"/></view></page><page><layer name="a"/><view layers="a" active="a"><transform layer="a" matrix="1 0 0 1 9 0"/></view></page></ipe>');
    const transformedSidecar = captureCompositionSidecar(transformed);
    transformed.pages.reverse();
    expect(() => rehydrateCompositionSidecar(transformed, transformedSidecar)).toThrow(/stale/u);
  });

  it("rejects incompatible global layouts without mutation", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><ipestyle><layout paper="595 842" origin="0 0" frame="595 842"/></ipestyle><page><layer name="a"/><view layers="a" active="a"/></page></ipe>');
    const before = document.pages.length;
    expect(() => composeSlide(document, { preset: "16:9" })).toThrow(/incompatible/u);
    expect(document.pages.length).toBe(before);
  });
});
