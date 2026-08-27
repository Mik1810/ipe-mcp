import { describe, expect, it } from "vitest";

import { buildCameraPan, buildMotion, buildPanelScroll, buildReveal, estimateAnimationExpansion, IPE_EFFECT_ID, IPE_EFFECTS, ipeDocumentCodec, serializeXml, setTransition, validateDocument, VIEWER_MATRIX } from "../../src/index.js";

const source = () => ipeDocumentCodec.parse(`<?xml version="1.0"?><ipe version="70218"><ipestyle><layout paper="320 180" origin="0 0" frame="320 180"/></ipestyle><page><layer name="base"/><layer name="detail"/><view layers="base detail" active="base"/><path layer="base" custom="ipe-mcp:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" stroke="black">20 20 m 80 20 l 80 60 l 20 60 l h</path><path layer="detail" custom="ipe-mcp:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" fill="blue">100 20 m 140 20 l 140 60 l 100 60 l h</path></page></ipe>`);
const interleavedSource = () => ipeDocumentCodec.parse(`<?xml version="1.0"?><ipe version="70218"><ipestyle><layout paper="320 180" origin="0 0" frame="320 180"/></ipestyle><page><layer name="shared"/><layer name="other"/><view layers="shared other" active="shared"/><path layer="shared" custom="ipe-mcp:11111111-1111-4111-8111-111111111111" fill="red">0 0 m 20 0 l 20 20 l h</path><path layer="shared" custom="ipe-mcp:22222222-2222-4222-8222-222222222222" fill="green">5 5 m 25 5 l 25 25 l h</path><path layer="other" custom="ipe-mcp:33333333-3333-4333-8333-333333333333" fill="blue">10 10 m 30 10 l 30 30 l h</path></page></ipe>`);
const visibleObjectIds = (document: ReturnType<typeof source>, viewId: string) => { const page = document.pages[0]!; const view = page.views.find((candidate) => candidate.id === viewId)!; return page.objects.filter((object) => view.visibleLayerIds.includes(object.layerId)).map((object) => object.id); };

describe("M7 discrete animation facade", () => {
  it("builds ordered/simultaneous cumulative and non-cumulative reveals atomically", () => {
    const document = source(); const page = document.pages[0]!; const first = page.objects[0]!; const second = page.objects[1]!; const legacyViewId = page.views[0]!.id; const legacyObjects = visibleObjectIds(document, legacyViewId);
    const result = buildReveal(document, page.id, { groups: [[{ kind: "object", id: first.id }, { kind: "object", id: second.id }]], initialState: "hidden", finalState: "visible", handout: "initial-and-final" });
    expect(result.viewIds).toHaveLength(3); expect(result.layerIds).toHaveLength(2); expect(page.views).not.toBe(document.pages[0]!.views); expect(document.pages[0]!.views.slice(-3).map((view) => view.marked)).toEqual([true, false, true]); expect(visibleObjectIds(document, legacyViewId)).toEqual(legacyObjects); expect(validateDocument(document).ok).toBe(true);
    const alternate = source(); const alternatePage = alternate.pages[0]!;
    buildReveal(alternate, alternatePage.id, { groups: [[{ kind: "layer", id: alternatePage.layers[0]!.id }], [{ kind: "layer", id: alternatePage.layers[1]!.id }]], cumulative: false, initialState: "visible", finalState: "hidden", objectLayers: "reuse" });
    expect(alternate.pages[0]!.views.slice(-4).map((view) => view.visibleLayerIds.length)).toEqual([2, 1, 1, 1]);
  });

  it("uses object variants by default and makes layer transforms explicit with fallback diagnostics", () => {
    const document = source(); const page = document.pages[0]!; const target = page.objects[0]!; const legacyViewId = page.views[0]!.id; const legacyObjects = visibleObjectIds(document, legacyViewId);
    const result = buildMotion(document, page.id, { objectIds: [target.id], from: { x: 0, y: 0 }, to: { x: 60, y: 20 }, steps: 4, easing: "ease-in-out", viewer: "browser" });
    expect(result.objectIds).toHaveLength(4); expect(result.layerIds).toHaveLength(4); expect(result.diagnostics.map((item) => item.code)).toContain("VIEWER_STATIC_FALLBACK"); expect(document.pages[0]!.objects.map((object) => object.id)).toContain(target.id); expect(visibleObjectIds(document, legacyViewId)).toEqual(legacyObjects); expect(validateDocument(document).ok).toBe(true);
    const transformed = source(); const transformedPage = transformed.pages[0]!;
    const optIn = buildMotion(transformed, transformedPage.id, { objectIds: [transformedPage.objects[0]!.id], from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, steps: 2, strategy: "layer-transform", staticFallback: true });
    expect(optIn.objectIds).toHaveLength(0); expect(optIn.diagnostics.map((item) => item.code)).toContain("LAYER_TRANSFORM_EXPERIMENTAL"); expect(transformed.pages[0]!.views.at(-1)!.layerTransforms).toBeDefined();
    const before = structuredClone(transformed); expect(() => buildMotion(transformed, transformedPage.id, { objectIds: [transformedPage.objects[0]!.id], from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, steps: 2, strategy: "layer-transform", staticFallback: false })).toThrow(/fallback/u); expect(transformed).toEqual(before);
  });

  it("keeps variants in original global z-order independent of caller target order", () => {
    const document = interleavedSource(); const page = document.pages[0]!; const first = page.objects[0]!; const last = page.objects[2]!;
    const result = buildMotion(document, page.id, { objectIds: [last.id, first.id], from: { x: 0, y: 0 }, to: { x: 20, y: 0 }, steps: 2 });
    for (const viewId of result.viewIds) { const view = document.pages[0]!.views.find((candidate) => candidate.id === viewId)!; expect(document.pages[0]!.objects.filter((object) => view.visibleLayerIds.includes(object.layerId)).map((object) => object.xml!.attributes!.fill)).toEqual(["red", "green", "blue"]); }
  });

  it("materializes fixed, per-view, and explicit reserved bbox geometry", () => {
    const fixed = source(); const fixedPage = fixed.pages[0]!; const fixedResult = buildMotion(fixed, fixedPage.id, { objectIds: [fixedPage.objects[0]!.id], from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, steps: 2, bbox: { kind: "fixed" } });
    const fixedLayer = fixed.pages[0]!.layers.find((layer) => layer.name === "BBOX")!; expect(fixedLayer.intentional).toBe(true); expect(fixed.pages[0]!.objects.find((object) => object.layerId === fixedLayer.id)!.xml!.children![0]).toMatchObject({ type: "text", text: "0 0 m 320 0 l 320 180 l 0 180 l h" }); expect(fixedResult.viewIds.every((id) => fixed.pages[0]!.views.find((view) => view.id === id)!.visibleLayerIds.includes(fixedLayer.id))).toBe(true);
    const perView = source(); const perViewPage = perView.pages[0]!; const perViewResult = buildMotion(perView, perViewPage.id, { objectIds: [perViewPage.objects[0]!.id], from: { x: 0, y: 0 }, to: { x: 30, y: 10 }, steps: 2, bbox: { kind: "per-view" } }); const viewBbox = perView.pages[0]!.layers.find((layer) => layer.name === "VIEWBBOX")!; expect(perViewResult.viewIds.map((id) => perView.pages[0]!.views.find((view) => view.id === id)!.layerTransforms?.[viewBbox.id])).toEqual([[1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 30, 10]]);
    const explicit = source(); const explicitPage = explicit.pages[0]!; buildMotion(explicit, explicitPage.id, { objectIds: [explicitPage.objects[0]!.id], from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, steps: 2, bbox: { kind: "explicit", box: { x: 5, y: 7, width: 101, height: 53 } } }); const explicitLayer = explicit.pages[0]!.layers.find((layer) => layer.name === "BBOX")!; expect(serializeXml(explicit)).toContain('<path layer="BBOX" custom='); expect(explicit.pages[0]!.objects.find((object) => object.layerId === explicitLayer.id)!.xml!.children![0]).toMatchObject({ type: "text", text: "5 7 m 106 7 l 106 60 l 5 60 l h" });
  });

  it("keeps panel clips fixed and supports whole-composition camera panning", () => {
    const panel = source(); const panelPage = panel.pages[0]!;
    const scroll = buildPanelScroll(panel, panelPage.id, { objectId: panelPage.objects[0]!.id, axis: "y", from: 0, to: -80, steps: 3, clip: { x: 10, y: 10, width: 100, height: 70 }, bbox: { kind: "explicit", box: { x: 0, y: 0, width: 320, height: 180 } } });
    const variants = panel.pages[0]!.objects.filter((object) => scroll.objectIds.includes(object.id)); expect(new Set(variants.map((object) => object.xml!.attributes!.clip)).size).toBe(1); expect(variants.map((object) => object.xml!.children![0]!.type === "element" ? object.xml!.children![0]!.attributes!.matrix : "")).toEqual(["1 0 0 1 0 0", "1 0 0 1 0 -40", "1 0 0 1 0 -80"]);
    const camera = source(); const cameraPage = camera.pages[0]!; const pan = buildCameraPan(camera, cameraPage.id, { from: { x: 0, y: 0 }, to: { x: -100, y: 0 }, steps: 3 }); expect(pan.objectIds).toHaveLength(6); expect(camera.pages[0]!.views.slice(-3)).toHaveLength(3);
  });

  it("preflights views, copies and PDF pages before mutation", () => {
    const document = source(); expect(estimateAnimationExpansion(document, 4, 8)).toEqual({ generatedViews: 4, generatedCopies: 8, resultingPdfPages: 5 }); const before = structuredClone(document);
    expect(() => buildMotion(document, document.pages[0]!.id, { objectIds: [document.pages[0]!.objects[0]!.id], from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, steps: 5, limits: { maxGeneratedViews: 4 } })).toThrow(/limit/u); expect(document).toEqual(before);
    expect(() => buildMotion(document, document.pages[0]!.id, { objectIds: [document.pages[0]!.objects[0]!.id], from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, steps: 5, limits: { maxGeneratedCopies: 4 } })).toThrow(/copies/u);
  });

  it("maps the complete typed 7.2.30 effect vocabulary and never overclaims viewers", () => {
    expect(IPE_EFFECTS).toHaveLength(28); expect(Object.values(IPE_EFFECT_ID)).toEqual([...Array(28).keys()]); const document = source(); const page = document.pages[0]!; const motion = buildMotion(document, page.id, { objectIds: [page.objects[0]!.id], from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, steps: 2 });
    const warnings = setTransition(document, page.id, [motion.viewIds[0]!], { effect: "fade", duration: 2, transition: 1, viewer: "ipe-presenter" }); expect(warnings[0]?.code).toBe("VIEWER_EFFECT_UNVERIFIED"); expect(VIEWER_MATRIX["ipe-presenter"].transitions).toBe("ignored"); expect(VIEWER_MATRIX.acrobat.transitions).toBe("untested");
    const firstView = document.pages[0]!.views.find((view) => view.id === motion.viewIds[0])!; const secondView = document.pages[0]!.views.find((view) => view.id === motion.viewIds[1])!; const firstEffect = firstView.transition!.effect as string; setTransition(document, page.id, [secondView.id], { effect: "fade", duration: 3, transition: 2 }); const secondEffect = document.pages[0]!.views.find((view) => view.id === secondView.id)!.transition!.effect as string; expect(secondEffect).not.toBe(firstEffect); expect(document.pages[0]!.views.find((view) => view.id === firstView.id)!.transition!.effect).toBe(firstEffect);
    const xml = serializeXml(document); expect(xml).toContain('effect="27"'); expect(xml).toContain(`effect="${secondEffect}"`); expect((xml.match(/<effect /gu) ?? [])).toHaveLength(2); const parsed = ipeDocumentCodec.parse(xml); expect(parsed.pages[0]!.views.find((view) => view.id === firstView.id)!.transition).toEqual({ effect: firstEffect }); expect(parsed.pages[0]!.views.find((view) => view.id === secondView.id)!.transition).toEqual({ effect: secondEffect });
  });
});
