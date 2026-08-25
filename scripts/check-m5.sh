#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FIXTURES="$ROOT/fixtures/conformance/m5"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail() { echo "M5 FAIL: $*" >&2; exit 1; }
bash "$ROOT/scripts/check-m4.sh" || fail "M4 gate"
(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && npm test -- --run tests/composition/m5.test.ts tests/ipe/xml.test.ts tests/domain/ir.test.ts) || fail "M5 tests"
python3 - "$FIXTURES/manifest.json" "$FIXTURES/golden/golden-standard.ipe" "$FIXTURES/golden/golden-16x9.ipe" <<'PY' || fail "manifest and 70218 goldens"
import json, sys, xml.etree.ElementTree as ET
m=json.load(open(sys.argv[1])); assert m["milestone"]=="M5" and m["format"]==70218
expected=[((595,842),(0,0),(595,842),2),((1280,720),(32,0),(1216,648),3)]
for path, (paper,origin,frame,nviews) in zip(sys.argv[2:], expected):
 r=ET.parse(path).getroot(); assert r.tag=="ipe" and r.get("version")=="70218"
 layouts=r.findall("ipestyle/layout"); assert layouts
 l=layouts[-1]; assert tuple(map(int,l.get("paper").split()))==paper and tuple(map(int,l.get("origin").split()))==origin and tuple(map(int,l.get("frame").split()))==frame and l.get("crop")=="yes"
 pages=r.findall("page"); assert pages and len(pages[0].findall("view"))==nviews
 layers=pages[0].findall("layer"); assert len(layers)>=4 and {x.get("name") for x in layers}>={"BBOX","VIEWBBOX"}
 assert pages[0].get("title") and pages[0].findtext("notes")
 objects=[x for x in pages[0] if x.tag in {"path","text"}]
 assert [x.get("layer") for x in objects]==["BBOX","VIEWBBOX","content","annotation"]
 assert all(" m " in f" {''.join(x.itertext())} " and " h " in f" {''.join(x.itertext())} " for x in objects[:2])
PY
for name in standard 16x9; do
  ipetoipe -xml "$FIXTURES/golden/golden-$name.ipe" "$TMP/$name.ipe" >/dev/null 2>"$TMP/$name.stderr" || fail "native reload $name"
  if [[ -s "$TMP/$name.stderr" ]] && grep -Eivq '^Document .* has [0-9]+ pages? \([0-9]+ views?\)$' "$TMP/$name.stderr"; then fail "native diagnostics $name"; fi
done
for name in standard 16x9; do
  iperender -svg -nocrop -page 1 "$FIXTURES/golden/golden-$name.ipe" "$TMP/$name.svg" >/dev/null 2>"$TMP/$name-render.stderr" || fail "bbox/crop render $name"
  grep -Eq 'viewBox="[^"]+"' "$TMP/$name.svg" || fail "missing SVG bbox $name"
done
ipetoipe -pdf "$FIXTURES/golden/golden-16x9.ipe" "$TMP/m5.pdf" >/dev/null 2>"$TMP/pdf.stderr" || fail "PDF export"
[[ "$(pdfinfo "$TMP/m5.pdf" | awk -F: '/^Pages/{gsub(/ /,"",$2);print $2}')" == 3 ]] || fail "PDF page count"
for page in 1 2 3; do pdftotext -f "$page" -l "$page" "$TMP/m5.pdf" "$TMP/page-$page.txt"; done
! grep -q 'M5-DETAIL-16X9' "$TMP/page-1.txt" || fail "annotation leaked into intro view"
grep -q 'M5-DETAIL-16X9' "$TMP/page-2.txt" || fail "annotation missing from detail view"
grep -q 'M5-DETAIL-16X9' "$TMP/page-3.txt" || fail "annotation missing from handout view"
node --input-type=module - "$ROOT" <<'NODE' || fail "exact page/view mapping"
const { ipeDocumentCodec, mapPdfPages } = await import(`${process.argv[2]}/dist/src/index.js`);
const d=ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"/><view layers="a" active="a"/></page><page><layer name="b"/><view layers="b" active="b"/></page></ipe>');
const m=mapPdfPages(d); if (m.length!==3 || m.map(x=>x.pdfPage).join(',')!=='1,2,3' || m[0].pageId!==d.pages[0].id || m[2].pageId!==d.pages[1].id) throw new Error('mapping is not exact');
NODE
node --input-type=module - "$ROOT" "$TMP" <<'NODE' || fail "composition sidecar capture"
import { writeFileSync } from "node:fs";
const [root, tmp] = process.argv.slice(2);
const { captureCompositionSidecar, ipeDocumentCodec, serializeXml } = await import(`${root}/dist/src/index.js`);
const source = await (await import("node:fs/promises")).readFile(`${root}/fixtures/conformance/m5/golden/golden-16x9.ipe`, "utf8");
const document = ipeDocumentCodec.parse(source);
writeFileSync(`${tmp}/composition-sidecar.json`, JSON.stringify(captureCompositionSidecar(document)));
writeFileSync(`${tmp}/sidecar-source.ipe`, serializeXml(document, { compositionSidecarAuthoritative: true }));
NODE
ipetoipe -xml "$TMP/sidecar-source.ipe" "$TMP/sidecar-native.ipe" >/dev/null 2>"$TMP/sidecar-native.stderr" || fail "sidecar native reload"
node --input-type=module - "$ROOT" "$TMP" <<'NODE' || fail "composition sidecar rehydrate"
import { readFileSync } from "node:fs";
const [root, tmp] = process.argv.slice(2);
const { ipeDocumentCodec, rehydrateCompositionSidecar, validateDocument } = await import(`${root}/dist/src/index.js`);
const native = ipeDocumentCodec.parse(readFileSync(`${tmp}/sidecar-native.ipe`, "utf8"));
if (native.pages[0].name !== undefined) throw new Error("native unexpectedly preserved the unsupported page-name attribute");
const restored = rehydrateCompositionSidecar(native, JSON.parse(readFileSync(`${tmp}/composition-sidecar.json`, "utf8")));
if (restored.pages[0].name !== "presentation-16x9" || !validateDocument(restored).ok) throw new Error("composition identity was not restored");
NODE
echo "M5 PASS: M4, manifest/goldens, bbox/crop/title/notes/native reload, and exact PDF mapping"
