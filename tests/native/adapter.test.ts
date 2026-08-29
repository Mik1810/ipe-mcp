import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { ipeDocumentCodec } from "../../src/core/ipe-document-codec.js";
import type { XmlElement } from "../../src/ipe/xml/parser.js";
import { NativeIpeAdapter } from "../../src/native/adapter.js";
import { DEFAULT_RASTER_LIMITS, validateSvg } from "../../src/native/artifact-validation.js";
import { classifyNativeRelease, type NativeCapabilities } from "../../src/native/capabilities.js";
import { DocumentSessionManager } from "../../src/persistence/session-manager.js";
import { NATIVE_SUBPROCESS_COUNTS } from "../../src/native/process-accounting.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));
const nativeAvailable = await Promise.all(["/usr/bin/ipescript", "/usr/bin/ipetoipe", "/usr/bin/iperender", "/usr/bin/pdflatex"].map((path) => access(path).then(() => true, () => false))).then((values) => values.every(Boolean));

async function fixture(name: string) {
  return ipeDocumentCodec.parse(await readFile(resolve(`fixtures/conformance/m6/${name}`)));
}

describe("native Ipe adapter", () => {
  it("classifies only coherent 7.2 baseline and genuine 7.3 nightly releases", () => {
    const toolchain = (version: string): NonNullable<NativeCapabilities["toolchain"]> => ({
      ipescript: { path: "/usr/bin/ipescript", package: "ipe", packageVersion: version },
      ipetoipe: { path: "/usr/bin/ipetoipe", package: "ipe", packageVersion: version },
      iperender: { path: "/usr/bin/iperender", package: "ipe", packageVersion: version },
      pdflatex: { path: "/usr/bin/pdflatex", package: "texlive-latex-base", packageVersion: "2025.1" },
    });
    expect(classifyNativeRelease("7.2.30", toolchain("7.2.30-1build2"))).toBe("full-7.2.30");
    expect(classifyNativeRelease("7.3.2", toolchain("1:7.3.2-1"))).toBe("nightly");
    expect(() => classifyNativeRelease("7.3.2", toolchain("7.3.1-1"))).toThrow(/does not match/u);
    const base = toolchain("7.3.2-1");
    const mixed = { ...base, iperender: { ...base.iperender, packageVersion: "7.3.1-1" } };
    expect(() => classifyNativeRelease("7.3.2", mixed)).toThrow(/mixed/u);
    expect(() => classifyNativeRelease("7.4.0", toolchain("7.4.0-1"))).toThrow(/unknown|unsupported/u);
  });
  it("degrades explicitly and rejects unsafe preambles before execution", async () => {
    const adapter = await NativeIpeAdapter.create({ executables: { ipescript: "/missing/ipescript", ipetoipe: "/missing/ipetoipe", iperender: "/missing/iperender", pdflatex: "/missing/pdflatex" } });
    await expect(adapter.capabilities()).resolves.toMatchObject({ mode: "structural-only", verified: false, xmlVersion: 70218 });
    const document = await fixture("full.xml");
    document.preamble = "\\input{/etc/passwd}";
    await expect(adapter.runLatex(document)).rejects.toMatchObject({ code: "NATIVE_TEX_ERROR" });
  });

  it("all public document operations reject unsafe preambles before creating a workspace or launching an executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-preamble-")); cleanup.push(root);
    const marker = join(root, "launched");
    const fake = join(root, "native-tool");
    await writeFile(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o700 });
    const temporaryRoot = join(root, "temporary");
    const adapter = await NativeIpeAdapter.create({ executables: { ipescript: fake, ipetoipe: fake, iperender: fake, pdflatex: fake }, temporaryRoot });
    const document = await fixture("full.xml");
    document.preamble = "\\input{/etc/passwd}";
    const operations = [
      () => adapter.reload(document),
      () => adapter.checkStyle(document),
      () => adapter.exportPdf(document),
      () => adapter.renderViews(document, "png"),
      () => adapter.runLatex(document),
      () => adapter.validateFull(document),
    ];
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: "NATIVE_TEX_ERROR" });
    await expect(access(marker)).rejects.toBeDefined();
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it("rejects injected loss of typed view maps and effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-view-loss-")); cleanup.push(root);
    const document = await fixture("full.xml");
    for (const expression of ['s| effect="m6-fade"||g', 's|<map kind="color" from="black" to="accent"/>||g']) {
      const helper = join(root, `helper-${Math.random().toString(16).slice(2)}`);
      await writeFile(helper, `#!/bin/sh\n/usr/bin/sed '${expression}' "$3" > "$4"\nprintf 'IPE_M6_PROTOCOL=ipe-mcp-native/1\\nIPE_M6_RESULT=PASS\\n'\n`, { mode: 0o700 });
      const adapter = await NativeIpeAdapter.create({ executables: { ipescript: helper }, temporaryRoot: join(root, `tmp-${Math.random().toString(16).slice(2)}`) });
      await expect(adapter.reload(document)).rejects.toMatchObject({ code: "NATIVE_LOAD_ERROR", message: expect.stringContaining("view/layer mapping") });
    }
  });

  it("rejects nested custom loss while treating only the managed object carrier specially", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-nested-custom-")); cleanup.push(root);
    const source = (await readFile(resolve("fixtures/conformance/m6/full.xml"), "utf8")).replace('<path stroke="black">45 55 m', '<path stroke="black" custom="nested-required">45 55 m');
    const document = ipeDocumentCodec.parse(source);
    const helper = join(root, "helper");
    await writeFile(helper, "#!/bin/sh\nsed 's/ custom=\"nested-required\"//' \"$3\" > \"$4\"\nprintf 'IPE_M6_PROTOCOL=ipe-mcp-native/1\\nIPE_M6_RESULT=PASS\\n'\n", { mode: 0o700 });
    const adapter = await NativeIpeAdapter.create({ executables: { ipescript: helper }, temporaryRoot: join(root, "temporary") });
    await expect(adapter.reload(document)).rejects.toMatchObject({ code: "NATIVE_LOAD_ERROR", message: expect.stringContaining("object semantics") });
  });

  it("requires exact helper protocol success before emitting OK diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-helper-protocol-")); cleanup.push(root);
    const document = await fixture("full.xml");
    for (const output of ["", "IPE_M6_RESULT=PASS\\n", "IPE_M6_PROTOCOL=wrong/1\\nIPE_M6_RESULT=PASS\\n"] as const) {
      const helper = join(root, `helper-${Math.random().toString(16).slice(2)}`);
      await writeFile(helper, `#!/bin/sh\nif [ \"$2\" != \"check-style\" ]; then cp \"$3\" \"$4\"; fi\nprintf ${JSON.stringify(output)}\n`, { mode: 0o700 });
      const adapter = await NativeIpeAdapter.create({ executables: { ipescript: helper }, temporaryRoot: join(root, `temporary-${Math.random().toString(16).slice(2)}`) });
      await expect(adapter.reload(document)).rejects.toMatchObject({ code: "NATIVE_LOAD_ERROR" });
      await expect(adapter.checkStyle(document)).rejects.toMatchObject({ code: "NATIVE_STYLE_ERROR" });
      await expect(adapter.runLatex(document)).rejects.toMatchObject({ code: "NATIVE_TEX_ERROR" });
    }
  });

  it.skipIf(!nativeAvailable)("rejects a mixed toolchain whose configured executable only fakes success", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-fake-")); cleanup.push(root);
    const fake = join(root, "fake-ipetoipe");
    await writeFile(fake, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const adapter = await NativeIpeAdapter.create({ executables: { ipetoipe: fake }, temporaryRoot: root });
    await expect(adapter.capabilities()).resolves.toMatchObject({ mode: "structural-only", verified: false, features: { pdf: false } });
  });

  it.skipIf(!nativeAvailable)("refuses wrappers, mixed packages, and unowned copies as verified toolchains", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-provenance-")); cleanup.push(root);
    const wrapper = join(root, "ipetoipe");
    await writeFile(wrapper, "#!/bin/sh\nexec /usr/bin/ipetoipe \"$@\"\n", { mode: 0o700 });
    const copied = join(root, "copied-ipetoipe");
    await copyFile("/usr/bin/ipetoipe", copied); await chmod(copied, 0o700);
    for (const executable of [wrapper, "/usr/bin/true", copied]) {
      const adapter = await NativeIpeAdapter.create({ executables: { ipetoipe: executable }, temporaryRoot: root });
      const capabilities = await adapter.capabilities();
      expect(capabilities).toMatchObject({ mode: "structural-only", verified: false });
      expect(capabilities.diagnostics.join(" ")).toContain("provenance");
    }
  });

  it.skipIf(!nativeAvailable)("validates, exports, and renders every page/view with deterministic metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-test-")); cleanup.push(root);
    const adapter = await NativeIpeAdapter.create({ temporaryRoot: root });
    await expect(adapter.capabilities()).resolves.toMatchObject({ mode: "full-7.2.30", verified: true, ipeVersion: "7.2.30", toolchain: {
      ipescript: { package: "ipe", packageVersion: expect.stringMatching(/^7\.2\.30(?:-|$)/u) },
      ipetoipe: { package: "ipe", packageVersion: expect.stringMatching(/^7\.2\.30(?:-|$)/u) },
      iperender: { package: "ipe", packageVersion: expect.stringMatching(/^7\.2\.30(?:-|$)/u) },
      pdflatex: { package: expect.stringMatching(/^texlive-/u) },
    }, validators: {
      pdfinfo: { package: "poppler-utils" },
      pdftoppm: { package: "poppler-utils" },
      mutool: { package: "mupdf-tools" },
    } });
    const document = await fixture("full.xml");
    expect(document.assets).toHaveLength(1);
    expect(document.pages[0]!.objects.map((object) => object.xml?.name)).toEqual(expect.arrayContaining(["image", "group", "use"]));
    const transformed = structuredClone(document);
    const view = transformed.pages[0]!.views[1]!;
    view.transforms = Object.entries(view.layerTransforms!).map(([layerId, matrix]) => ({ layerId, matrix }));
    delete view.layerTransforms;
    await expect(adapter.reload(transformed)).resolves.toMatchObject({ diagnostics: expect.arrayContaining([expect.objectContaining({ code: "NATIVE_RELOAD_OK" })]) });
    const report = await adapter.validateFull(document);
    expect(report.pdf.metadata.mapping.map(({ pageId, viewId }) => [pageId, viewId])).toEqual(document.pages.flatMap((page) => page.views.map((view) => [page.id, view.id])));
    expect(report.previews).toHaveLength(2);
    expect(report.previews.every((preview) => preview.metadata.bytes > 0 && preview.diagnostics.some(({ code }) => code === "VISUAL_NON_EMPTY"))).toBe(true);
    expect(report.previews.map(({ metadata }) => [metadata.width, metadata.height])).toEqual([[320, 180], [320, 180]]);
    const svg = await adapter.renderViews(document, "svg");
    expect(svg).toHaveLength(2);
    expect(svg.map(({ metadata }) => [metadata.width, metadata.height])).toEqual([[320, 180], [320, 180]]);
    const changedLayout = structuredClone(document);
    const layout = changedLayout.stylesheets![0]!.xml!.children!.find((child) => child.type === "element" && child.name === "layout");
    if (layout?.type !== "element") throw new Error("fixture layout missing");
    layout.attributes = { ...layout.attributes, paper: "321 180", frame: "321 180" };
    const changed = await adapter.renderViews(changedLayout);
    expect(changed.map(({ metadata }) => [metadata.width, metadata.height])).toEqual([[321, 180], [321, 180]]);
    expect(changed.map(({ metadata }) => metadata.sha256)).not.toEqual(report.previews.map(({ metadata }) => metadata.sha256));
    expect(await readdir(root)).toEqual([]);
  }, 15_000);

  it.skipIf(!nativeAvailable)("accepts Ipe's explicit numeric default stroke on newly authored objects", async () => {
    const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="content"/><view layers="content" active="content"/><path layer="content" custom="ipe-mcp:00000000-0000-4000-8000-000000000001">0 0 m 10 0 l</path><text layer="content" custom="ipe-mcp:00000000-0000-4000-8000-000000000002" pos="2 3" type="label" valign="baseline">M8</text></page></ipe>');
    await expect((await NativeIpeAdapter.create()).reload(document)).resolves.toMatchObject({ diagnostics: expect.arrayContaining([expect.objectContaining({ code: "NATIVE_RELOAD_OK" })]) });
  });

  it.skipIf(!nativeAvailable)("rejects loss of root extension semantics", async () => {
    const document = await fixture("full.xml");
    document.extensions = { "x-ipe-mcp-conformance": { type: "element", name: "x-ipe-mcp-conformance", attributes: { probe: "required" }, children: [] } };
    await expect((await NativeIpeAdapter.create()).reload(document)).rejects.toMatchObject({ code: "NATIVE_LOAD_ERROR", message: "native reload changed root extension semantics" });
  });

  it("preflights page/view and subprocess bounds without launching renderers", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-preflight-")); cleanup.push(root);
    const marker = join(root, "launched");
    const fake = join(root, "iperender");
    await writeFile(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
    const document = await fixture("full.xml");
    const stateBound = await NativeIpeAdapter.create({ executables: { iperender: fake }, temporaryRoot: join(root, "states"), operationLimits: { maxPageViewStates: 1 } });
    await expect(stateBound.renderViews(document)).rejects.toMatchObject({ code: "NATIVE_RESOURCE_LIMIT" });
    const processBound = await NativeIpeAdapter.create({ executables: { iperender: fake }, temporaryRoot: join(root, "processes"), operationLimits: { maxSubprocesses: 1 } });
    await expect(processBound.renderViews(document)).rejects.toMatchObject({ code: "NATIVE_RESOURCE_LIMIT" });
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("preflights the complete capability probe before creating its workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-capability-preflight-")); cleanup.push(root);
    const adapter = await NativeIpeAdapter.create({ temporaryRoot: root, operationLimits: { maxSubprocesses: NATIVE_SUBPROCESS_COUNTS.capabilities - 1 } });
    await expect(adapter.capabilities()).rejects.toMatchObject({ code: "NATIVE_RESOURCE_LIMIT" });
    expect(await readdir(root)).toEqual([]);
  });

  it("preflights exact export, render, and full-validation subprocess boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-exact-preflight-")); cleanup.push(root);
    const marker = join(root, "launched"); const fake = join(root, "tool");
    await writeFile(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o700 });
    const document = await fixture("full.xml"); const states = document.pages.reduce((sum, page) => sum + page.views.length, 0);
    const cases = [
      [NATIVE_SUBPROCESS_COUNTS.exportPdf(states), (adapter: NativeIpeAdapter) => adapter.exportPdf(document)],
      [NATIVE_SUBPROCESS_COUNTS.renderViews(states), (adapter: NativeIpeAdapter) => adapter.renderViews(document)],
      [NATIVE_SUBPROCESS_COUNTS.validateFull(states), (adapter: NativeIpeAdapter) => adapter.validateFull(document)],
    ] as const;
    for (const [required, operation] of cases) {
      const adapter = await NativeIpeAdapter.create({ executables: { ipescript: fake, ipetoipe: fake, iperender: fake, pdflatex: fake }, temporaryRoot: join(root, `tmp-${required}`), operationLimits: { maxSubprocesses: required - 1 } });
      await expect(operation(adapter)).rejects.toMatchObject({ code: "NATIVE_RESOURCE_LIMIT", message: expect.stringContaining(`requires ${required}`) });
    }
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("rejects validateFull document depth limits before launching capability probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-full-depth-preflight-")); cleanup.push(root);
    const marker = join(root, "launched"); const fake = join(root, "tool");
    await writeFile(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o700 });
    const document = await fixture("full.xml");
    let nested: XmlElement = { type: "element", name: "leaf", attributes: {}, children: [] };
    for (let depth = 0; depth < 40; depth += 1) nested = { type: "element", name: "nested", attributes: {}, children: [nested] };
    document.xml.root.children.push(nested);
    const adapter = await NativeIpeAdapter.create({
      executables: { ipescript: fake, ipetoipe: fake, iperender: fake, pdflatex: fake },
      temporaryRoot: join(root, "temporary"),
      operationLimits: { maxDocumentNestingDepth: 32 },
    });
    await expect(adapter.validateFull(document)).rejects.toMatchObject({ code: "NATIVE_RESOURCE_LIMIT" });
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("bounds cumulative artifacts and the overall operation deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-operation-")); cleanup.push(root);
    const copy = join(root, "ipescript-copy");
    await writeFile(copy, "#!/bin/sh\ncp \"$3\" \"$4\"\nprintf 'IPE_M6_PROTOCOL=ipe-mcp-native/1\\nIPE_M6_RESULT=PASS\\n'\n", { mode: 0o700 });
    const document = await fixture("full.xml");
    const artifactBound = await NativeIpeAdapter.create({ executables: { ipescript: copy }, temporaryRoot: join(root, "artifacts"), operationLimits: { maxCumulativeArtifactBytes: 32 } });
    await expect(artifactBound.reload(document)).rejects.toMatchObject({ code: "NATIVE_RESOURCE_LIMIT" });
    const hanging = join(root, "ipescript-hang");
    await writeFile(hanging, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o700 });
    const deadlineBound = await NativeIpeAdapter.create({ executables: { ipescript: hanging }, temporaryRoot: join(root, "deadline"), limits: { timeoutMs: 2_000 }, operationLimits: { deadlineMs: 25 } });
    await expect(deadlineBound.reload(document)).rejects.toMatchObject({ code: "NATIVE_TIMEOUT" });
  });

  it.skipIf(!nativeAvailable)("classifies style and TeX errors", async () => {
    const adapter = await NativeIpeAdapter.create();
    await expect(adapter.checkStyle(await fixture("style-error.xml"))).rejects.toMatchObject({ code: "NATIVE_STYLE_ERROR" });
    await expect(adapter.runLatex(await fixture("tex-error.xml"))).rejects.toMatchObject({ code: "NATIVE_TEX_ERROR" });
  });

  it("does not change a session revision or snapshots when native validation times out", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-session-")); cleanup.push(workspace);
    const source = join(workspace, "document.ipe");
    await writeFile(source, await readFile(resolve("fixtures/conformance/m6/full.xml")));
    const manager = await DocumentSessionManager.create({ workspaceRoots: [workspace], stateRoot: join(workspace, "state") }, ipeDocumentCodec);
    const opened = await manager.open(source);
    const hanging = join(workspace, "hanging-ipescript");
    await writeFile(hanging, "#!/bin/sh\nwhile :; do :; done\n");
    await chmod(hanging, 0o700);
    const temporaryRoot = join(workspace, "native-temp");
    const adapter = await NativeIpeAdapter.create({ executables: { ipescript: hanging }, temporaryRoot, limits: { timeoutMs: 25 } });
    await expect(adapter.runLatex(opened.document)).rejects.toMatchObject({ code: "NATIVE_TIMEOUT" });
    expect(await readdir(temporaryRoot)).toEqual([]);
    expect(manager.inspect(opened.documentId)).toMatchObject({ revision: 0, document: opened.document });
    expect(await manager.snapshots(opened.documentId)).toEqual([]);
  });

  it("rejects symlink artifacts instead of following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-symlink-")); cleanup.push(root);
    const external = join(root, "external.pdf");
    await writeFile(external, "%PDF-1.4\n");
    const fake = join(root, "symlink-ipetoipe");
    await writeFile(fake, "#!/bin/sh\nln -s \"$1\" \"$4\"\n", { mode: 0o700 });
    const adapter = await NativeIpeAdapter.create({ executables: { ipetoipe: fake }, temporaryRoot: join(root, "temp") });
    const document = await fixture("full.xml");
    await expect(adapter.exportPdf(document)).rejects.toMatchObject({ code: "NATIVE_EXPORT_ERROR" });
  });

  it("rejects non-regular streaming artifacts without blocking past the deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-stream-artifact-")); cleanup.push(root);
    const fake = join(root, "fifo-iperender");
    await writeFile(fake, "#!/bin/sh\n/usr/bin/mkfifo \"$8\"\n", { mode: 0o700 });
    const adapter = await NativeIpeAdapter.create({ executables: { iperender: fake }, temporaryRoot: join(root, "temporary"), operationLimits: { deadlineMs: 2_000 } });
    const started = Date.now();
    await expect(adapter.renderViews(await fixture("full.xml"), "png")).rejects.toMatchObject({ code: "NATIVE_RENDER_ERROR" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("rejects a fake PDF envelope that cannot be natively round-tripped", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-fake-pdf-")); cleanup.push(root);
    const marker = join(root, "xml-round-trip-attempted");
    const fake = join(root, "ipetoipe");
    await writeFile(fake, `#!/bin/sh
if [ "$1" = "-pdf" ]; then
  printf '%%PDF-1.4\n1 0 obj << /Type /Page >> endobj\nxref\n0 1\n0000000000 65535 f \ntrailer << /Size 1 >>\nstartxref\n0\n%%%%EOF\n' > "$4"
else
  touch ${JSON.stringify(marker)}
fi
`, { mode: 0o700 });
    const adapter = await NativeIpeAdapter.create({ executables: { ipetoipe: fake }, temporaryRoot: join(root, "temporary") });
    await expect(adapter.exportPdf(await fixture("full.xml"))).rejects.toMatchObject({ code: "NATIVE_EXPORT_ERROR" });
    await expect(access(marker)).rejects.toBeDefined();
  });

  it.skipIf(!nativeAvailable)("rejects fake physical PDF page trees and swapped page/view association", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-pdf-physical-")); cleanup.push(root);
    for (const mode of ["truncate", "swap"] as const) {
      const fake = join(root, `ipetoipe-${mode}`);
      await writeFile(fake, `#!/bin/sh
if [ "$1" != "-pdf" ]; then exec /usr/bin/ipetoipe "$@"; fi
/usr/bin/ipetoipe "$@" || exit $?
mv "$4" "$4.original"
/usr/bin/pdfseparate -f 1 -l 2 "$4.original" "$4.page-%d.pdf" || exit $?
${mode === "truncate" ? 'mv "$4.page-1.pdf" "$4"' : '/usr/bin/pdfunite "$4.page-2.pdf" "$4.page-1.pdf" "$4"'}
`, { mode: 0o700 });
      const adapter = await NativeIpeAdapter.create({ executables: { ipetoipe: fake }, temporaryRoot: join(root, mode) });
      await expect(adapter.exportPdf(await fixture("full.xml"))).rejects.toMatchObject({ code: "NATIVE_EXPORT_ERROR" });
    }
  });

  it("rejects oversized PNG headers before allocating decoded pixels", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-png-bomb-")); cleanup.push(root);
    const artifact = join(root, "oversized.png");
    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(100_000, 16); png.writeUInt32BE(100_000, 20);
    png[24] = 8; png[25] = 6;
    await writeFile(artifact, png);
    const fake = join(root, "iperender");
    await writeFile(fake, `#!/bin/sh
cp ${JSON.stringify(artifact)} "$8"
`, { mode: 0o700 });
    const adapter = await NativeIpeAdapter.create({ executables: { iperender: fake }, temporaryRoot: join(root, "temporary"), rasterLimits: { maxWidth: 4096, maxHeight: 4096, maxPixels: 16_000_000, maxDecodedBytes: 64_000_000 } });
    await expect(adapter.renderViews(await fixture("full.xml"), "png")).rejects.toMatchObject({ code: "NATIVE_RESOURCE_LIMIT" });
  });

  it("rejects illegal PNG encodings and legal compressed expansion before decode", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-png-ihdr-")); cleanup.push(root);
    const sourcePng = new PNG({ width: 64, height: 64 });
    sourcePng.data.fill(0);
    const legalExpansion = PNG.sync.write(sourcePng);
    const cases = [
      legalExpansion,
      Buffer.from(legalExpansion),
      Buffer.from(legalExpansion),
      Buffer.from(legalExpansion),
    ];
    cases[1]![28] = 1;
    cases[2]![26] = 1;
    cases[3]![24] = 4; // RGBA permits only 8 or 16-bit samples.
    for (const [index, png] of cases.entries()) {
      const artifact = join(root, `hostile-${index}.png`); await writeFile(artifact, png);
      const fake = join(root, `iperender-${index}`); await writeFile(fake, `#!/bin/sh\ncp ${JSON.stringify(artifact)} "$8"\n`, { mode: 0o700 });
      const adapter = await NativeIpeAdapter.create({ executables: { iperender: fake }, temporaryRoot: join(root, `temporary-${index}`), ...(index === 0 ? { rasterLimits: { maxDecodedBytes: 1024 } } : {}) });
      await expect(adapter.renderViews(await fixture("full.xml"), "png")).rejects.toMatchObject({ code: index === 0 ? "NATIVE_RESOURCE_LIMIT" : "NATIVE_RENDER_ERROR" });
    }
  });

  it("rejects zero-sized, hidden, transparent, and display-none SVG geometry", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-invisible-svg-")); cleanup.push(root);
    const cases = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="0" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><g visibility="hidden"><rect width="10" height="10"/></g></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" opacity="0"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill-opacity="0"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" style="display:none"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M 1 1 L 9 9" fill="none" stroke="none"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="bogus" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10 20"><rect width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 0 10"><rect width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 -1"><rect width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 NaN 10"><rect width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="file:///etc/passwd"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="https://example.invalid/a.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="../secret.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="#missing"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="data:image/png;base64,AAAA"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs><filter id="f"/></defs><rect width="10" height="10" filter="url(file:///etc/passwd)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>@import url(https://example.invalid/a.css)</style><rect width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M 1 1 INVALID"/></svg>',
    ];
    for (const [index, source] of cases.entries()) {
      const artifact = join(root, `invisible-${index}.svg`); await writeFile(artifact, source);
      const fake = join(root, `iperender-${index}`);
      await writeFile(fake, `#!/bin/sh
cp ${JSON.stringify(artifact)} "$8"
`, { mode: 0o700 });
      const adapter = await NativeIpeAdapter.create({ executables: { iperender: fake }, temporaryRoot: join(root, `temporary-${index}`) });
      await expect(adapter.renderViews(await fixture("full.xml"), "svg")).rejects.toMatchObject({ code: "NATIVE_RENDER_ERROR" });
    }
  });

  it("requires a strict viewBox and rejects malformed explicit SVG dimensions in-process", () => {
    const cases = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="bad" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    ];
    for (const source of cases) expect(() => validateSvg(Buffer.from(source), DEFAULT_RASTER_LIMITS, "NATIVE_RENDER_ERROR")).toThrow();
    expect(validateSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-5 -5 10 10"><rect width="10" height="10"/></svg>'), DEFAULT_RASTER_LIMITS, "NATIVE_RENDER_ERROR")).toEqual({ width: 10, height: 10 });
  });

  it.skipIf(!nativeAvailable)("uses the configured pdflatex directory for helper and converter LaTeX calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-pdflatex-path-")); cleanup.push(root);
    const bin = join(root, "controlled-bin"); await mkdir(bin);
    const marker = join(root, "configured-pdflatex-used");
    const pdflatex = join(bin, "pdflatex");
    await writeFile(pdflatex, `#!/bin/sh
printf x >> ${JSON.stringify(marker)}
exec /usr/bin/pdflatex "$@"
`, { mode: 0o700 });
    const adapter = await NativeIpeAdapter.create({ executables: { pdflatex }, temporaryRoot: join(root, "temporary") });
    const document = await fixture("full.xml");
    await adapter.runLatex(document);
    await adapter.exportPdf(document);
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("returns and validates one immutable render snapshot during pathname replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-render-snapshot-")); cleanup.push(root);
    const original = new PNG({ width: 16, height: 16 }); original.data.fill(255); original.data[0] = 0;
    const replacement = new PNG({ width: 16, height: 16 }); replacement.data.fill(255); replacement.data[4] = 0;
    const originalPath = join(root, "original.png"); const replacementPath = join(root, "replacement.png");
    await writeFile(originalPath, PNG.sync.write(original)); await writeFile(replacementPath, PNG.sync.write(replacement));
    const fake = join(root, "iperender");
    await writeFile(fake, `#!/bin/sh\ncp ${JSON.stringify(originalPath)} "$8"\n`, { mode: 0o700 });
    const temporaryRoot = join(root, "temporary");
    const adapter = await NativeIpeAdapter.create({ executables: { iperender: fake }, temporaryRoot });
    let stopped = false;
    const replacer = (async () => {
      while (!stopped) {
        const directories = await readdir(temporaryRoot).catch(() => []);
        for (const directory of directories) {
          const output = join(temporaryRoot, directory, "page-1-view-1.png");
          if (await access(output).then(() => true, () => false)) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
            const next = `${output}.replacement`;
            await copyFile(replacementPath, next).catch(() => undefined);
            await rename(next, output).catch(() => undefined);
            return;
          }
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      }
    })();
    try {
      const [artifact] = await adapter.renderViews(await fixture("full.xml"), "png");
      expect(Buffer.from(artifact!.data)).toEqual(await readFile(originalPath));
    } finally { stopped = true; await replacer; }
  });

  it("bounds document objects, XML nodes, and source bytes before serialization or launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-document-bounds-")); cleanup.push(root);
    const marker = join(root, "launched"); const fake = join(root, "ipescript");
    await writeFile(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
    const document = await fixture("full.xml");
    for (const operationLimits of [{ maxDocumentObjects: 1 }, { maxDocumentXmlNodes: 1 }, { maxDocumentSourceBytes: 128 }]) {
      const adapter = await NativeIpeAdapter.create({ executables: { ipescript: fake }, temporaryRoot: join(root, Math.random().toString(16).slice(2)), operationLimits });
      await expect(adapter.reload(document)).rejects.toMatchObject({ code: "NATIVE_RESOURCE_LIMIT" });
    }
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("charges shared XML subtrees for every serialized occurrence before launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-shared-tree-")); cleanup.push(root);
    const marker = join(root, "launched"); const fake = join(root, "ipescript");
    await writeFile(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
    const document = await fixture("full.xml");
    const shared = { type: "element" as const, name: "m6-extension", attributes: { value: "shared" }, children: [{ type: "element" as const, name: "child", attributes: {}, children: ["payload"] }] };
    document.xml.root.children.push(...Array.from({ length: 100 }, () => shared));
    const adapter = await NativeIpeAdapter.create({ executables: { ipescript: fake }, temporaryRoot: join(root, "temporary"), operationLimits: { maxDocumentXmlNodes: 500 } });
    await expect(adapter.reload(document)).rejects.toMatchObject({ code: "NATIVE_RESOURCE_LIMIT" });
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("rejects deeply nested document graphs before recursive serialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-depth-bound-")); cleanup.push(root);
    const marker = join(root, "launched"); const fake = join(root, "ipescript");
    await writeFile(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
    const document = await fixture("full.xml");
    let nested: XmlElement = { type: "element", name: "leaf", attributes: {}, children: [] };
    for (let depth = 0; depth < 40; depth += 1) nested = { type: "element", name: "nested", attributes: {}, children: [nested] };
    document.xml.root.children.push(nested);
    const adapter = await NativeIpeAdapter.create({ executables: { ipescript: fake }, temporaryRoot: join(root, "temporary"), operationLimits: { maxDocumentNestingDepth: 32 } });
    await expect(adapter.reload(document)).rejects.toMatchObject({ code: "NATIVE_RESOURCE_LIMIT" });
    await expect(access(marker)).rejects.toBeDefined();
  });
});
