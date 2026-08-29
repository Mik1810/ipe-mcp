#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
FIXTURES="$ROOT/fixtures/conformance/m7"
M7_TMP=$(mktemp -d)
trap 'rm -rf "$M7_TMP"' EXIT
fail() { echo "M7 FAIL: $*" >&2; exit 1; }

bash "$ROOT/scripts/gates/check-m6.sh" || fail "M6 gate"
(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && npm test -- --run tests/animation) || fail "animation tests"

python3 - "$FIXTURES/manifest.json" "$FIXTURES" <<'PY' || fail "fixture manifest"
import hashlib, json, pathlib, struct, sys, xml.etree.ElementTree as ET
manifest = json.load(open(sys.argv[1], encoding="utf-8")); root = pathlib.Path(sys.argv[2])
assert manifest["milestone"] == "M7" and manifest["format"] == 70218
assert set(manifest["fixtures"]) == {"reveal", "motion", "panelScroll", "cameraPan"}
for fixture in manifest["fixtures"].values():
    xml = ET.parse(root / fixture["file"]).getroot(); assert xml.tag == "ipe" and xml.get("version") == "70218"
    views = xml.find("page").findall("view"); assert len(views) == fixture["views"]
    for golden in fixture.get("visualGoldens", []):
        name = pathlib.Path(fixture["file"]).stem + f"-view-{golden['view']}.png"; data = (root / "golden" / name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == golden["sha256"] and data[:8] == b"\x89PNG\r\n\x1a\n"
        assert struct.unpack(">II", data[16:24]) == (golden["width"], golden["height"])
assert len(manifest["fixtures"]["panelScroll"]["visualGoldens"]) == 3
assert len(manifest["fixtures"]["cameraPan"]["visualGoldens"]) == 3
PY

node --input-type=module - "$ROOT" "$M7_TMP" <<'NODE' || fail "effect 0-27 and bbox policy vocabulary"
import { writeFileSync } from "node:fs";
const root = process.argv[2];
const output = process.argv[3];
const { addView, buildMotion, IPE_EFFECTS, ipeDocumentCodec, serializeXml, setTransition, validateDocument, VIEWER_MATRIX } = await import(`${root}/dist/src/index.js`);
const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"/></page></ipe>');
const page = document.pages[0]; const views = [page.views[0]];
for (let index = 1; index < 28; index += 1) views.push(addView(document, page.id, { visibleLayerIds: [page.layers[0].id], activeLayerId: page.layers[0].id }));
for (const [index, effect] of IPE_EFFECTS.entries()) setTransition(document, page.id, [views[index].id], { effect, duration: 1, transition: 1 });
const xml = serializeXml(document); const ids = [...xml.matchAll(/<effect [^>]*effect="([0-9]+)"/g)].map((match) => Number(match[1])).sort((a, b) => a - b);
if (JSON.stringify(ids) !== JSON.stringify([...Array(28).keys()]) || !validateDocument(document).ok) throw new Error("effect mapping incomplete");
if (VIEWER_MATRIX["ipe-presenter"].transitions !== "ignored" || VIEWER_MATRIX.acrobat.transitions !== "untested" || VIEWER_MATRIX.browser.staticViews !== "degraded") throw new Error("viewer vocabulary overclaims support");
const bboxSource = '<ipe version="70218"><ipestyle><layout paper="320 180" origin="0 0" frame="320 180"/></ipestyle><page><layer name="content"/><view layers="content" active="content"/><path layer="content" custom="ipe-mcp:77777777-7777-4777-8777-777777777777">10 10 m 30 10 l 30 30 l h</path></page></ipe>';
for (const [name, bbox] of [["fixed", { kind: "fixed" }], ["per-view", { kind: "per-view" }], ["explicit", { kind: "explicit", box: { x: 5, y: 7, width: 101, height: 53 } }]]) {
  const candidate = ipeDocumentCodec.parse(bboxSource); const page = candidate.pages[0]; buildMotion(candidate, page.id, { objectIds: [page.objects[0].id], from: { x: 0, y: 0 }, to: { x: 30, y: 10 }, steps: 2, bbox }); writeFileSync(`${output}/bbox-${name}.ipe`, serializeXml(candidate));
}
NODE

for fixture in reveal motion panel-scroll camera-pan; do
  fixture_path="$FIXTURES/corpus/$fixture.ipe"
  ipetoipe -xml "$fixture_path" "$M7_TMP/native-$fixture.ipe" >/dev/null 2>"$M7_TMP/native-$fixture.stderr" || fail "native reload $fixture"
  views=$(python3 - "$FIXTURES/manifest.json" "$fixture" <<'PY'
import json, sys
m=json.load(open(sys.argv[1])); key={"panel-scroll":"panelScroll","camera-pan":"cameraPan"}.get(sys.argv[2],sys.argv[2]); print(m["fixtures"][key]["views"])
PY
)
  ipetoipe -pdf "$fixture_path" "$M7_TMP/$fixture.pdf" >/dev/null 2>"$M7_TMP/pdf-$fixture.stderr" || fail "PDF export $fixture"
  [[ "$(pdfinfo "$M7_TMP/$fixture.pdf" | awk -F: '/^Pages/{gsub(/ /,"",$2);print $2}')" == "$views" ]] || fail "PDF expansion $fixture"
  for ((view=1; view<=views; view++)); do iperender -svg -nocrop -page 1 -view "$view" "$fixture_path" "$M7_TMP/$fixture-$view.svg" >/dev/null 2>&1 || fail "static render $fixture view $view"; done
done

for mode in fixed per-view explicit; do
  input="$M7_TMP/bbox-$mode.ipe"; native="$M7_TMP/native-bbox-$mode.ipe"
  ipetoipe -xml "$input" "$native" >/dev/null 2>"$M7_TMP/native-bbox-$mode.stderr" || fail "native bbox reload $mode"
  for view in 2 3; do iperender -png -page 1 -view "$view" "$native" "$M7_TMP/bbox-$mode-$view.png" >/dev/null 2>&1 || fail "native bbox render $mode view $view"; done
  python3 - "$mode" "$input" "$native" <<'PY' || fail "native bbox semantics $mode"
import sys, xml.etree.ElementTree as ET
mode = sys.argv[1]; reserved = "VIEWBBOX" if mode == "per-view" else "BBOX"
for filename in sys.argv[2:]:
    page = ET.parse(filename).getroot().find("page")
    assert any(layer.get("name") == reserved for layer in page.findall("layer"))
    assert any(path.get("layer") == reserved and " m " in f" {' '.join((path.text or '').split())} " and " l " in f" {' '.join((path.text or '').split())} " for path in page.findall("path"))
    generated = page.findall("view")[-2:]
    assert all(reserved in view.get("layers", "").split() for view in generated)
    if mode == "per-view":
        matrices = [next((transform.get("matrix") for transform in view.findall("transform") if transform.get("layer") == reserved), "1 0 0 1 0 0") for view in generated]
        assert len(set(matrices)) == 2
PY
done

for fixture in panel-scroll camera-pan; do
  for view in 1 2 3; do
    iperender -png -nocrop -page 1 -view "$view" "$FIXTURES/corpus/$fixture.ipe" "$M7_TMP/$fixture-view-$view.png" >/dev/null 2>&1 || fail "visual render $fixture view $view"
    cmp "$M7_TMP/$fixture-view-$view.png" "$FIXTURES/golden/$fixture-view-$view.png" >/dev/null || fail "visual golden $fixture view $view"
  done
  [[ "$(sha256sum "$M7_TMP/$fixture-view-"*.png | awk '{print $1}' | sort -u | wc -l)" == 3 ]] || fail "$fixture views are not visually distinct"
done

ipetoipe -pdf -markedview "$FIXTURES/corpus/reveal.ipe" "$M7_TMP/handout.pdf" >/dev/null 2>"$M7_TMP/handout.stderr" || fail "marked animation handout"
[[ "$(pdfinfo "$M7_TMP/handout.pdf" | awk -F: '/^Pages/{gsub(/ /,"",$2);print $2}')" == 2 ]] || fail "handout page count"
pdftotext -f 1 -l 1 "$M7_TMP/handout.pdf" "$M7_TMP/handout-initial.txt"
pdftotext -f 2 -l 2 "$M7_TMP/handout.pdf" "$M7_TMP/handout-final.txt"
! grep -q "Ordered group" "$M7_TMP/handout-initial.txt" || fail "initial handout reveal leaked"
grep -q "Ordered group" "$M7_TMP/handout-final.txt" && grep -q "Readable final state" "$M7_TMP/handout-final.txt" || fail "final handout is incomplete"

grep -q '| IpePresenter 7.2.30 | verified | ignored |' "$ROOT/docs/reference/viewer-effects-m7.md" || fail "IpePresenter matrix"
for viewer in 'Adobe Acrobat' 'Okular' 'Evince' 'pdfpc'; do grep -q "| $viewer | untested | untested |" "$ROOT/docs/reference/viewer-effects-m7.md" || fail "$viewer matrix"; done
grep -q '| Browser PDF viewers | degraded | ignored |' "$ROOT/docs/reference/viewer-effects-m7.md" || fail "browser matrix"

echo "M7 PASS: M6, bounded reveal/motion/scroll/camera facade, native 0-27 effects, native fixed/per-view/explicit bbox geometry, static fixtures, per-view goldens, viewer matrix, and readable marked handout"
