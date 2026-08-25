import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalizeIpe, ipeDocumentCodec } from "../../src/core/ipe-document-codec.js";
import { parseIpeXml, XmlParseError } from "../../src/ipe/xml/parser.js";

const fixtureRoot = resolve("fixtures/conformance");

async function corpus(): Promise<string[]> {
  const m0 = (await readdir(fixtureRoot)).filter((name) => name.endsWith(".ipe")).map((name) => resolve(fixtureRoot, name));
  const m1Root = resolve(fixtureRoot, "m1");
  const m1 = (await readdir(m1Root)).filter((name) => name.endsWith(".ipe")).map((name) => resolve(m1Root, name));
  const m2Root = resolve(fixtureRoot, "m2");
  const m2 = (await readdir(m2Root)).filter((name) => name.endsWith(".ipe")).map((name) => resolve(m2Root, name));
  return [...m0, ...m1, ...m2].sort();
}

describe("Ipe 70218 XML boundary", () => {
  it("canonically round-trips the complete M0/M1/M2 corpus to a fixed point", async () => {
    for (const path of await corpus()) {
      const source = await readFile(path, "utf8");
      const first = canonicalizeIpe(source);
      const second = canonicalizeIpe(first);
      expect(second, path).toBe(first);
      const result = ipeDocumentCodec.validate(ipeDocumentCodec.parse(first));
      expect(result.filter((item) => item.severity === "error"), path).toEqual([]);
    }
  });

  it("preserves payloads, unknown x-* data, custom IDs, views and transforms", async () => {
    const source = await readFile(resolve(fixtureRoot, "m1/metadata-custom-x.ipe"), "utf8");
    const output = canonicalizeIpe(source);
    expect(output).toContain('<x-ipe-mcp probe="element-retention"/>');
    expect(output).toContain('x-origin="manual"');
    expect(output).toContain('custom="ipe-mcp:11111111-1111-4111-8111-111111111111"');
    expect(output).toContain("20 20 m 220 20 l 220 160 l 20 160 l h");

    const bbox = canonicalizeIpe(await readFile(resolve(fixtureRoot, "m1/bbox-viewbbox-group-transform.ipe"), "utf8"));
    expect(bbox).toContain('<transform layer="content" matrix="1 0 0 1 20 0"/>');
    expect(bbox).toContain('url="https://example.invalid/m1/group"');
  });

  it("serializes supported IR edits instead of replaying stale source XML", async () => {
    const source = await readFile(resolve(fixtureRoot, "minimal.ipe"), "utf8");
    const document = ipeDocumentCodec.parse(source);
    document.metadata = { title: "edited & safe" };
    document.pages[0]!.title = "changed";
    document.pages[0]!.marked = false;
    document.pages[0]!.layers[0]!.edit = false;
    document.pages[0]!.layers[0]!.snap = "always";
    document.pages[0]!.views[0]!.marked = true;
    document.pages[0]!.objects[0]!.matrix = [1, 0, 0, 1, 12, 13];
    const output = ipeDocumentCodec.serialize(document);
    expect(output).toContain('<info title="edited &amp; safe"/>');
    expect(output).toMatch(/<page title="changed" marked="no" x-ipe-mcp-id="page-[a-f0-9]{24}">/u);
    expect(output).toMatch(/<layer name="base" edit="no" snap="always" x-ipe-mcp-id="layer-[a-f0-9]{24}"\/>/u);
    expect(output).toContain('marked="yes"');
    expect(output).toContain('matrix="1 0 0 1 12 13"');
    expect(ipeDocumentCodec.parse(output).pages[0]).toMatchObject({
      title: "changed",
      marked: false,
      layers: [{ edit: false, snap: "always" }],
    });
  });

  it("preserves whitespace-only text payloads exactly", () => {
    const source = '<ipe version="70218"><page><layer name="alpha"/><text layer="alpha">   </text></page></ipe>';
    const output = canonicalizeIpe(source);
    expect(output).toMatch(/<text\b[^>]*>   <\/text>/u);
    expect(canonicalizeIpe(output)).toBe(output);
  });

  it("keeps internal object IDs stable when canonical serialization reorders nested attributes", () => {
    const source = '<ipe version="70218"><page><layer name="alpha"/><group layer="alpha" matrix="1.0 0 0 1e0 -0 0"><path fill="white" stroke="black">0<![CDATA[ 0]]> m</path><path stroke="red"><![CDATA[]]></path></group></page></ipe>';
    const first = ipeDocumentCodec.parse(source);
    const firstId = first.pages[0]!.objects[0]!.id;
    expect(first.pages[0]!.objects[0]!.custom).toMatch(/^ipe-mcp:[0-9a-f-]{36}$/u);
    const second = ipeDocumentCodec.parse(ipeDocumentCodec.serialize(first));
    expect(second.pages[0]!.objects[0]!.id).toBe(firstId);
  });

  it("keeps generated object identities through z-order changes and reload", () => {
    const source = '<ipe version="70218"><page><layer name="alpha"/><path layer="alpha">0 0 m</path><path layer="alpha">1 1 m</path></page></ipe>';
    const document = ipeDocumentCodec.parse(source);
    const originalIds = document.pages[0]!.objects.map((object) => object.id);
    document.pages[0]!.objects.reverse();
    document.pages[0]!.objects.forEach((object, index) => { object.zOrder = index; });
    const reloaded = ipeDocumentCodec.parse(ipeDocumentCodec.serialize(document));
    expect(reloaded.pages[0]!.objects.map((object) => object.id)).toEqual(originalIds.reverse());
  });

  it("preserves duplicate existing custom metadata with unique internal IDs", () => {
    const source = '<ipe version="70218"><page><layer name="alpha"/><path layer="alpha" custom="legacy">0 0 m</path><path layer="alpha" custom="legacy">1 1 m</path></page></ipe>';
    const document = ipeDocumentCodec.parse(source);
    expect(document.pages[0]!.objects.map((object) => object.id)).toHaveLength(2);
    expect(new Set(document.pages[0]!.objects.map((object) => object.id)).size).toBe(2);
    const diagnostics = ipeDocumentCodec.validate(document);
    expect(diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "CUSTOM_DUPLICATE", severity: "warning" }));
    const ids = document.pages[0]!.objects.map((object) => object.id);
    document.pages[0]!.objects[0]!.xml!.children = [{ type: "text", text: "9 9 m" }];
    const output = ipeDocumentCodec.serialize(document);
    expect(output.match(/custom="ipe-mcp:object-id:object-[a-f0-9]{24}\|legacy"/gu)).toHaveLength(2);
    expect(output.match(/x-ipe-mcp-id="object-[a-f0-9]{24}"/gu)).toHaveLength(2);
    const reloaded = ipeDocumentCodec.parse(output);
    expect(reloaded.pages[0]!.objects.map((object) => object.id)).toEqual(ids);
    reloaded.pages[0]!.objects.splice(1, 1);
    reloaded.pages[0]!.objects[0]!.custom = "edited-legacy";
    expect(ipeDocumentCodec.validate(reloaded).filter((item) => item.severity === "error")).toEqual([]);
    expect(ipeDocumentCodec.parse(ipeDocumentCodec.serialize(reloaded)).pages[0]!.objects[0]).toMatchObject({
      id: ids[0],
      custom: "edited-legacy",
    });
  });

  it("removes persisted optional page and layer attributes when the IR resets them", () => {
    const source = '<ipe version="70218"><page marked="no"><layer name="alpha" edit="yes" snap="always"/><view layers="alpha" active="alpha"/></page></ipe>';
    const document = ipeDocumentCodec.parse(source);
    delete document.pages[0]!.marked;
    delete document.pages[0]!.layers[0]!.edit;
    delete document.pages[0]!.layers[0]!.snap;
    const output = ipeDocumentCodec.serialize(document);
    expect(output).not.toMatch(/<(?:page|layer)\b[^>]*\b(?:marked|edit|snap)=/u);
    expect(ipeDocumentCodec.parse(output).pages[0]).toMatchObject({ layers: [{}] });
    expect(ipeDocumentCodec.parse(output).pages[0]!.marked).toBeUndefined();
    expect(ipeDocumentCodec.parse(output).pages[0]!.layers[0]!.edit).toBeUndefined();
    expect(ipeDocumentCodec.parse(output).pages[0]!.layers[0]!.snap).toBeUndefined();
  });

  it("rejects XML 1.0-invalid characters before persistence", async () => {
    const document = ipeDocumentCodec.parse(await readFile(resolve(fixtureRoot, "minimal.ipe")));
    document.pages[0]!.objects[0]!.xml!.children = [{ type: "text", text: "valid\0invalid" }];
    expect(ipeDocumentCodec.validate(document)).toContainEqual(expect.objectContaining({
      code: "SCHEMA_INVALID",
      severity: "error",
    }));
    expect(() => ipeDocumentCodec.serialize(document)).toThrow("XML 1.0-invalid");
  });

  it("reports embedded XML 1.0-invalid controls consistently at parse time", () => {
    expect(() => parseIpeXml('<ipe version="70218"><page><path>0 0 m\u00001 1 l</path></page></ipe>')).toThrow("XML 1.0-invalid");
  });

  it("refuses to serialize a manually constructed object without persistent identity", async () => {
    const document = ipeDocumentCodec.parse(await readFile(resolve(fixtureRoot, "minimal.ipe")));
    document.pages[0]!.objects.push({
      id: "object-000000000000000000000001",
      layerId: document.pages[0]!.layers[0]!.id,
      zOrder: document.pages[0]!.objects.length,
      xml: { name: "path", children: [{ type: "text", text: "0 0 m" }] },
    });
    expect(ipeDocumentCodec.validate(document)).toContainEqual(expect.objectContaining({ code: "OBJECT_CUSTOM_REQUIRED" }));
    expect(() => ipeDocumentCodec.serialize(document)).toThrow("requires persistent custom identity");
  });

  it("persists a canonical manual object ID independently from custom metadata", async () => {
    const document = ipeDocumentCodec.parse(await readFile(resolve(fixtureRoot, "minimal.ipe")));
    document.pages[0]!.objects.push({
      id: "object-000000000000000000000001",
      custom: "ipe-mcp:11111111-1111-5111-8111-111111111111",
      layerId: document.pages[0]!.layers[0]!.id,
      zOrder: document.pages[0]!.objects.length,
      xml: { name: "path", children: [{ type: "text", text: "0 0 m" }] },
    });
    expect(ipeDocumentCodec.validate(document).filter((item) => item.severity === "error")).toEqual([]);
    const reloaded = ipeDocumentCodec.parse(ipeDocumentCodec.serialize(document));
    expect(reloaded.pages[0]!.objects.at(-1)).toMatchObject({
      id: "object-000000000000000000000001",
      custom: "ipe-mcp:11111111-1111-5111-8111-111111111111",
    });
  });

  it("rejects dangerous or unsupported XML surfaces and enforces limits", () => {
    const invalid = [
      '<!DOCTYPE ipe [<!ENTITY x "boom">]><ipe version="70218"><page>&x;</page></ipe>',
      '<!DOCTYPE ipe SYSTEM "https://example.invalid/evil.dtd"><ipe version="70218"/>',
      '<ipe xmlns="urn:ipe" version="70218"/>',
      '<?evil data?><ipe version="70218"/>',
      '<ipe version="70300"/>',
    ];
    for (const source of invalid) expect(() => parseIpeXml(source), source).toThrow(XmlParseError);
    expect(() => parseIpeXml('<ipe version="70218"><page><path/></page></ipe>', { maxDepth: 2 })).toThrow("depth limit");
    expect(() => parseIpeXml(new Uint8Array([0x3c, 0x69, 0x70, 0x65, 0xff]))).toThrow("valid UTF-8");
  });

  it("accepts safe numeric character references", () => {
    const document = parseIpeXml('<ipe version="70218"><page><text>&#65;&#x42;</text></page></ipe>');
    expect(document.root.children).toBeDefined();
  });

  it("materializes native implicit layer and view defaults without hiding objects", () => {
    const source = '<ipe version="70218"><page><layer name="a"/><layer name="b"/><path>0 0 m 1 1 l</path><path layer="b">2 2 m 3 3 l</path><path>4 4 m 5 5 l</path></page></ipe>';
    const document = ipeDocumentCodec.parse(source);
    const [a, b] = document.pages[0]!.layers.map((item) => item.id);
    expect(document.pages[0]).toMatchObject({
      views: [{ visibleLayerIds: [a, b], activeLayerId: a }],
      objects: [{ layerId: a }, { layerId: b }, { layerId: b }],
    });
    const output = ipeDocumentCodec.serialize(document);
    expect(output).toContain('<view layers="a b" active="a" marked="no" x-ipe-mcp-id=');
  });

  it("resolves layer names from IDs when a layer is renamed", async () => {
    const document = ipeDocumentCodec.parse(await readFile(resolve(fixtureRoot, "minimal.ipe")));
    const layerId = document.pages[0]!.layers[0]!.id;
    document.pages[0]!.layers[0]!.name = "renamed";
    const output = ipeDocumentCodec.serialize(document);
    expect(output).toContain('<layer name="renamed" x-ipe-mcp-id=');
    expect(output).toContain('<view layers="renamed" active="renamed" marked="no" x-ipe-mcp-id=');
    expect(output).toContain('<path layer="renamed"');
    expect(ipeDocumentCodec.parse(output).pages[0]!.layers[0]!.id).toBe(layerId);
  });

  it("keeps page and view IDs through reordering and reload", () => {
    const source = '<ipe version="70218"><page x-origin="A"><layer name="a"/><view layers="a" active="a" x-origin="first"/><view layers="a" active="a" x-origin="second"/><x-page marker="A"/></page><page x-origin="B"><layer name="b"/><view layers="b" active="b"/><x-page marker="B"/></page></ipe>';
    const document = ipeDocumentCodec.parse(source);
    const pageIds = document.pages.map((page) => page.id);
    const viewIds = document.pages[0]!.views.map((view) => view.id);
    document.pages[0]!.views.reverse();
    document.pages.reverse();
    const reloaded = ipeDocumentCodec.parse(ipeDocumentCodec.serialize(document));
    expect(reloaded.pages.map((page) => page.id)).toEqual(pageIds.reverse());
    expect(reloaded.pages[1]!.views.map((view) => view.id)).toEqual(viewIds.reverse());
    expect(reloaded.pages.map((page) => (page.xml as { attributes?: Record<string, string> }).attributes?.["x-origin"])).toEqual(["B", "A"]);
    expect(reloaded.pages[1]!.views.map((view) => (view.xml as { attributes?: Record<string, string> }).attributes?.["x-origin"])).toEqual(["second", "first"]);
  });

  it("keeps stylesheet and asset IDs through canonical attribute ordering", () => {
    const source = '<ipe version="70218"><bitmap id="1" width="1" height="1" length="0"/><bitmap id="2" width="2" height="2" length="0"/><ipestyle name="A"><layout frame="10 10" paper="10 10" origin="0 0"/></ipestyle><ipestyle name="B"><layout frame="20 20" paper="20 20" origin="0 0"/></ipestyle><page><layer name="a"/></page></ipe>';
    const document = ipeDocumentCodec.parse(source);
    const styleIds = document.stylesheets!.map((style) => style.id);
    const assetIds = document.assets!.map((asset) => asset.id);
    document.stylesheets!.reverse();
    document.assets!.reverse();
    const reloaded = ipeDocumentCodec.parse(ipeDocumentCodec.serialize(document));
    expect(reloaded.stylesheets!.map((style) => style.id)).toEqual(styleIds.reverse());
    expect(reloaded.stylesheets!.map((style) => style.name)).toEqual(["B", "A"]);
    expect(reloaded.assets!.map((asset) => asset.id)).toEqual(assetIds.reverse());
    expect(reloaded.assets!.map((asset) => (asset.xml as { attributes?: Record<string, string> }).attributes?.id)).toEqual(["2", "1"]);
  });

  it("rejects malformed and globally duplicated server-owned entity IDs", () => {
    const source = '<ipe version="70218"><page x-ipe-mcp-id="page-000000000000000000000001"><layer name="a" x-ipe-mcp-id="layer-000000000000000000000001"/><view layers="a" active="a" x-ipe-mcp-id="view-000000000000000000000001"/></page><page x-ipe-mcp-id="page-000000000000000000000001"><layer name="b" x-ipe-mcp-id="layer-000000000000000000000001"/><view layers="b" active="b" x-ipe-mcp-id="view-000000000000000000000001"/></page></ipe>';
    const document = ipeDocumentCodec.parse(source);
    expect(ipeDocumentCodec.validate(document).filter((item) => item.code === "ENTITY_ID_DUPLICATE")).toHaveLength(3);
    document.pages[0]!.id = "malformed";
    expect(ipeDocumentCodec.validate(document)).toContainEqual(expect.objectContaining({ code: "ENTITY_ID_INVALID" }));
    expect(() => ipeDocumentCodec.serialize(document)).toThrow(/Invalid persistent page ID|Duplicate persistent entity ID/u);
  });

  it("matches native fallback for an object that names an undeclared layer", () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><path layer="missing">0 0 m 1 1 l</path></page></ipe>');
    expect(document.pages[0]!.objects[0]!.layerId).toBe(document.pages[0]!.layers[0]!.id);
    expect(ipeDocumentCodec.serialize(document)).toContain('<path layer="a"');
  });

  it("rejects malformed object and view matrices instead of dropping them", () => {
    expect(() => ipeDocumentCodec.parse('<ipe version="70218"><page><path matrix="bogus">0 0 m</path></page></ipe>')).toThrow("Invalid matrix");
    expect(() => ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"><transform layer="a" matrix="1 2"/></view></page></ipe>')).toThrow("Invalid matrix");
  });
});
