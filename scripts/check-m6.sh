#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
M6_TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$M6_TMP_ROOT"' EXIT
fail() { echo "M6 FAIL: $*" >&2; exit 1; }

bash "$ROOT/scripts/check-m5.sh" || fail "M5 gate"
(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && npm test -- --run tests/native) || fail "native adapter tests"

node --input-type=module - "$ROOT" "$M6_TMP_ROOT" <<'NODE' || fail "full native validation and reproducibility"
import { readFile } from "node:fs/promises";
const [root, temporaryRoot] = process.argv.slice(2);
const { ipeDocumentCodec, NativeIpeAdapter, NativeIpeError } = await import(`${root}/dist/src/index.js`);
const adapter = await NativeIpeAdapter.create({ temporaryRoot });
const capabilities = await adapter.capabilities();
if (capabilities.mode !== "full-7.2.30" || !capabilities.verified || capabilities.xmlVersion !== 70218) throw new Error(JSON.stringify(capabilities));
const load = async (name) => ipeDocumentCodec.parse(await readFile(`${root}/fixtures/conformance/m6/${name}`));
const document = await load("full.xml");
const manifest = JSON.parse(await readFile(`${root}/fixtures/conformance/m6/manifest.json`, "utf8"));
const report = await adapter.validateFull(document);
if (report.pdf.metadata.mapping.length !== 2 || report.previews.length !== 2 || report.previews.some((preview) => !preview.diagnostics.length)) throw new Error("incomplete PDF/view mapping or visual diagnostics");
const firstSvg = await adapter.renderViews(document, "svg");
const secondPdf = await adapter.exportPdf(document);
const secondPng = await adapter.renderViews(document, "png");
const secondSvg = await adapter.renderViews(document, "svg");
const hashes = (items) => items.map((item) => item.metadata.sha256).join(",");
if (report.pdf.metadata.sha256 !== secondPdf.metadata.sha256 || hashes(report.previews) !== hashes(secondPng) || hashes(firstSvg) !== hashes(secondSvg)) throw new Error("native artifacts are not byte-reproducible");
const actualGoldens = [...report.previews, ...firstSvg].map(({ metadata }) => ({ format: metadata.format, page: metadata.page, view: metadata.view, width: metadata.width, height: metadata.height, sha256: metadata.sha256 }));
if (JSON.stringify(actualGoldens) !== JSON.stringify(manifest.full.visualGoldens)) throw new Error(`visual golden mismatch: ${JSON.stringify(actualGoldens)}`);
const changedLayout = structuredClone(document);
const layout = changedLayout.stylesheets[0].xml.children.find((child) => child.type === "element" && child.name === "layout");
if (!layout) throw new Error("fixture layout missing");
layout.attributes = { ...layout.attributes, paper: "321 180", frame: "321 180" };
const changed = await adapter.renderViews(changedLayout, "png");
if (changed.some(({ metadata }) => metadata.width !== 321 || metadata.height !== 180) || hashes(changed) === hashes(report.previews)) throw new Error("layout regression matched the pinned full-page visuals");
for (const [name, method, code] of [["style-error.xml", "checkStyle", "NATIVE_STYLE_ERROR"], ["tex-error.xml", "runLatex", "NATIVE_TEX_ERROR"]]) {
  try { await adapter[method](await load(name)); throw new Error(`${name} unexpectedly passed`); }
  catch (error) { if (!(error instanceof NativeIpeError) || error.code !== code) throw error; }
}
NODE

[[ -z "$(find "$M6_TMP_ROOT" -mindepth 1 -print -quit)" ]] || fail "temporary workspace cleanup"
echo "M6 PASS: M5, controlled native adapter, Ipelib/style/LaTeX, deterministic PDF and every-view PNG/SVG, classified failures, and cleanup"
