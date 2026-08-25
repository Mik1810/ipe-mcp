#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FIXTURES="$ROOT/fixtures/conformance/m4"
GOLDEN="$FIXTURES/golden/m4-object-primitive-matrix.ipe"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { echo "M4 FAIL: $*" >&2; exit 1; }
pass() { echo "M4 PASS: $*"; }
run_native_clean() {
  local label=$1
  shift
  local stderr="$TMP_ROOT/$label.stderr"
  "$@" >"$TMP_ROOT/$label.stdout" 2>"$stderr" || return 1
  # ipetoipe emits a harmless page/view summary on stderr. Native warnings
  # and diagnostics are not harmless and must fail the acceptance lane.
  if [[ -s "$stderr" ]] && grep -Eiq '(^|[^[:alpha:]])(warning|error|failed|invalid|undefined)([^[:alpha:]]|$)' "$stderr"; then
    cat "$stderr" >&2
    return 1
  fi
}

[[ -x "$ROOT/scripts/check-m3.sh" ]] || fail "check-m3.sh missing or not executable"
bash "$ROOT/scripts/check-m3.sh" || fail "M0-M3 gates"

(cd "$ROOT" && npm run build) || fail "TypeScript build"
(cd "$ROOT" && npm test) || fail "unit and integration tests"
pass "M0-M3 gates, TypeScript build, and tests"

# Keep the object-layer safety invariants executable in the milestone gate as
# well as in unit tests. These probes intentionally exercise the public build,
# validation, and CRUD entry points with inputs that must fail closed.
node --input-type=module - "$ROOT" <<'NODE' || fail "M4 object validation negative probes"
const root = process.argv[2];
const { applyObjectOperations, buildGroupObject, buildPathObject, buildStylesheet, checkStyleStructural, createObjectIdentity, element, validateDocument } = await import(`${root}/dist/src/index.js`);

function expectFailure(label, callback, fragment) {
  try {
    callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(fragment)) return;
    throw new Error(`${label} failed with an unexpected diagnostic: ${message}`);
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

const identity = (index) => createObjectIdentity(`00000000-0000-5000-8000-${String(index).padStart(12, "0")}`);
const path = (layerId, index) => buildPathObject({
  layerId,
  identity: identity(index),
  path: { kind: "segment", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
});
const main = path("layer-main", 1);
const other = path("layer-other", 2);
expectFailure("cross-layer grouping", () => buildGroupObject({ layerId: "layer-main", children: [main, other] }), "group's layer");
expectFailure("unsupported raw object tag", () => buildGroupObject({ layerId: "layer-main", children: [element("future-object")] }), "unsupported object tag");
const referenced = path("layer-main", 5);
referenced.references = [{ kind: "object", id: main.id }];
expectFailure("object-reference grouping", () => buildGroupObject({ layerId: "layer-main", children: [referenced, main] }), "per-child references cannot be preserved");
expectFailure("unsupported symbol object tag", () => buildStylesheet("style-000000000000000000000009", "bad", [{ kind: "symbol", name: "mark/bad", object: element("future-object") }]), "unsupported object tag");
const structuralBad = { schemaVersion: 1, format: 70218, stylesheets: [{ id: "style-000000000000000000000009", xml: element("ipestyle", {}, [element("symbol", { name: "mark/bad" }, [element("future-object")])]) }], pages: [] };
if (!checkStyleStructural(structuralBad).some(({ code }) => code === "OBJECT_UNSUPPORTED")) throw new Error("structural symbol walker missed unsupported object");

const invalidBitmap = buildGroupObject({ layerId: "layer-main", children: [element("image", { bitmap: "999" })] });
const document = {
  schemaVersion: 1,
  format: 70218,
  assets: [{ id: "asset-000000000000000000000001", xml: element("bitmap", { id: "7" }) }],
  pages: [{ id: "page-main", layers: [{ id: "layer-main", name: "main" }], views: [], objects: [invalidBitmap] }],
};
if (!validateDocument(document).errors.some(({ message }) => message.includes("bitmap '999'"))) {
  throw new Error("unresolved nested bitmap unexpectedly passed domain validation");
}

const significantText = buildGroupObject({ layerId: "layer-main", children: [path("layer-main", 3), path("layer-main", 4)] });
significantText.xml.children.push({ type: "text", text: "must-preserve" });
const ungroupDocument = {
  schemaVersion: 1,
  format: 70218,
  pages: [{ id: "page-main", layers: [{ id: "layer-main", name: "main" }], views: [], objects: [significantText] }],
};
expectFailure("significant group text", () => applyObjectOperations(ungroupDocument, "page-main", [{ op: "ungroup", objectId: significantText.id }]), "non-element");
console.log("M4 object validation negative probes: PASS");
NODE
pass "object layer, raw-tag, bitmap-reference, and ungroup capability negatives"

for binary in ipetoipe iperender ipescript pdfinfo pdftotext; do
  command -v "$binary" >/dev/null 2>&1 || fail "$binary not found"
done
ipe_version=$(dpkg-query -W -f='${Version}' ipe 2>/dev/null) || fail "ipe package not installed"
[[ "$ipe_version" == 7.2.30* ]] || fail "expected Ipe 7.2.30, got $ipe_version"
echo "M4 INFO: installed ipe $ipe_version"

[[ -f "$FIXTURES/manifest.json" ]] || fail "M4 manifest missing"
[[ -f "$GOLDEN" ]] || fail "M4 golden fixture missing"

# The manifest is executable conformance data: this checks typed semantics and
# XML payloads, rather than accepting a fixture merely because it has objects.
python3 - "$FIXTURES/manifest.json" "$GOLDEN" <<'PY' || fail "M4 fixture semantic coverage"
import json
import re
import sys
import xml.etree.ElementTree as ET

manifest = json.loads(open(sys.argv[1], encoding="utf-8").read())
if manifest.get("format_version") != "70218" or len(manifest.get("fixtures", [])) != 1:
    raise SystemExit("invalid M4 manifest header")
entry = manifest["fixtures"][0]
root = ET.parse(sys.argv[2]).getroot()
if root.tag != "ipe" or root.get("version") != "70218":
    raise SystemExit("fixture root is not Ipe XML 70218")
pages = root.findall("page")
if len(pages) != 2:
    raise SystemExit(f"expected two pages, found {len(pages)}")

counts = {name: 0 for name in ("path", "text", "image", "group", "use")}
for page in pages:
    for child in page:
        if child.tag in counts:
            counts[child.tag] += 1
            if child.get("x-ipe-mcp-id") is None:
                raise SystemExit(f"top-level {child.tag} lacks persistent identity")
if counts != entry["object_counts"]:
    raise SystemExit(f"object counts differ: expected {entry['object_counts']}, actual {counts}")

def operators(path):
    # Operators are the semantic payload. Ignore numbers and XML text prose.
    return re.findall(r"(?<![A-Za-z])(?:m|l|c|h|e|a|s|u|C|L)(?![A-Za-z])", " ".join(path.itertext()))

for expected in entry["path_sequences"]:
    page = pages[expected["page"] - 1]
    paths = page.findall("path")
    path = paths[expected["object"] - 1] if expected["object"] <= len(paths) else None
    if path is None:
        raise SystemExit(f"missing {expected['kind']} path at page/object {expected['page']}/{expected['object']}")
    actual = operators(path)
    if actual != expected["operators"]:
        raise SystemExit(f"{expected['kind']} operator class differs: expected {expected['operators']}, actual {actual}")

texts = [text for page in pages for text in page.findall("text")]
if {text.get("type") for text in texts} != {"label", "minipage"}:
    raise SystemExit("label and minipage text coverage missing")
if not any("\\frac" in "".join(text.itertext()) for text in texts if text.get("type") == "label"):
    raise SystemExit("complex label TeX payload missing")
if not any(text.get("width") == "180" and text.get("halign") == "center" for text in texts if text.get("type") == "minipage"):
    raise SystemExit("minipage width/alignment semantics missing")

styles = {child.tag: child for sheet in root.findall("ipestyle") for child in sheet}
for tag, name in (("gradient", "sunset"), ("tiling", "hatch"), ("symbol", "mark/ipe-mcp(sx)")):
    if not any(node.get("name") == name for node in root.findall("ipestyle/" + tag)):
        raise SystemExit(f"style definition missing: {tag}/{name}")
paths = [path for page in pages for path in page.findall("path")]
if not any(path.get("arrow") == "normal/compact" for path in paths):
    raise SystemExit("arrow style missing")
if not any(path.get("fillrule") == "eofill" for path in paths):
    raise SystemExit("even-odd fill rule missing")
if not any(path.get("gradient") == "sunset" for path in paths):
    raise SystemExit("gradient use missing")
if not any(path.get("tiling") == "hatch" for path in paths):
    raise SystemExit("tiling use missing")
if not any(group.get("clip") for page in pages for group in page.findall("group")):
    raise SystemExit("structured clip missing")

bitmaps = root.findall("bitmap")
if not any(bitmap.get("Filter") == "FlateDecode" and bitmap.get("ColorSpace") == "DeviceRGBAlpha" and bitmap.get("alphaLength") for bitmap in bitmaps):
    raise SystemExit("PNG alpha bitmap missing")
if not any(bitmap.get("Filter") == "DCTDecode" and bitmap.get("ColorSpace") == "DeviceRGB" for bitmap in bitmaps):
    raise SystemExit("JPEG DCT bitmap missing")
print("fixture semantic coverage: PASS")
PY
pass "five object tags, all PathSpec kinds, label/minipage, styles, clip, and bitmap semantics"

# Exercise the current compiler independently of the committed golden. All
# generated files stay below TMP_ROOT and are removed on exit.
node "$ROOT/dist/src/cli/probe-m4.js" "$TMP_ROOT/generated.ipe" || fail "M4 typed compiler probe"
python3 - "$TMP_ROOT/generated.ipe" "$FIXTURES/manifest.json" <<'PY' || fail "generated compiler semantics"
import sys
import json
import xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
manifest = json.loads(open(sys.argv[2], encoding="utf-8").read())
if root.get("version") != "70218" or len(root.findall("page")) != 2:
    raise SystemExit("generated probe is not a two-page 70218 document")
if not root.findall(".//text[@type='label']") or not root.findall(".//text[@type='minipage']"):
    raise SystemExit("generated probe omitted label/minipage")
payload = " ".join(" ".join(path.itertext()) for path in root.findall(".//path"))
for operator in ("m", "l", "c", "a", "e", "h", "s", "u", "C", "L"):
    if (" " + operator + " ") not in (" " + payload + " "):
        raise SystemExit(f"generated probe omitted raw/primitive operator {operator}")
expected = manifest["fixtures"][0]["object_counts"]
actual = {name: sum(1 for page in root.findall("page") for node in page if node.tag == name) for name in expected}
if actual != expected:
    raise SystemExit(f"generated object counts differ from compiler contract: {actual}")
if any(node.get("x-ipe-mcp-id") is None for page in root.findall("page") for node in page if node.tag in expected):
    raise SystemExit("generated object omitted persistent identity")
print("generated compiler semantics: PASS")
PY
pass "typed compiler probe covers structured raw operators and both text forms"

GENERATED_CANONICAL="$TMP_ROOT/generated-canonical.ipe"
GENERATED_FIXED="$TMP_ROOT/generated-fixed.ipe"
node "$ROOT/dist/src/cli/canonicalize.js" "$TMP_ROOT/generated.ipe" "$GENERATED_CANONICAL" || fail "M4 generated canonicalization"
node "$ROOT/dist/src/cli/canonicalize.js" "$GENERATED_CANONICAL" "$GENERATED_FIXED" || fail "M4 generated canonical fixed point"
CANONICAL="$GENERATED_CANONICAL"
FIXED="$GENERATED_FIXED"
NATIVE="$TMP_ROOT/generated-native.ipe"
cmp -s "$CANONICAL" "$FIXED" || fail "M4 canonical round-trip is not a fixed point"
grep -Eq '<ipe[[:space:]]+version="70218"' "$CANONICAL" || fail "canonical root version"
run_native_clean native-reload ipetoipe -xml "$CANONICAL" "$NATIVE" || fail "native Ipe 7.2.30 reload (stderr warning or failure)"
grep -Eq '<ipe[[:space:]]+version="70218"' "$NATIVE" || fail "native root version"
node "$ROOT/scripts/probe-m4-roundtrip.mjs" "$NATIVE" || fail "native references or nested identities"

# Native identity negative/positive probe: x-ipe-mcp-id is not a persistence
# contract because Ipe strips it. The reserved custom envelope must retain an
# explicitly assigned ID even when editable custom metadata differs.
MANUAL_ID_SOURCE="$TMP_ROOT/manual-id-source.ipe"
MANUAL_ID_NATIVE="$TMP_ROOT/manual-id-native.ipe"
node --input-type=module - "$ROOT" "$MANUAL_ID_SOURCE" <<'NODE' || fail "manual identity probe generation"
import { writeFileSync } from "node:fs";
const root = process.argv[2];
const target = process.argv[3];
const { ipeDocumentCodec } = await import(`${root}/dist/src/core/ipe-document-codec.js`);
const document = ipeDocumentCodec.parse('<ipe version="70218"><page><layer name="a"/><view layers="a" active="a"/></page></ipe>');
const page = document.pages[0];
page.objects = [{ id: "object-000000000000000000000099", custom: "edited-by-user", layerId: page.layers[0].id, zOrder: 0, xml: { type: "element", name: "path", attributes: {}, children: [{ type: "text", text: "0 0 m 1 1 l" }] } }];
writeFileSync(target, ipeDocumentCodec.serialize(document));
NODE
run_native_clean manual-id ipetoipe -xml "$MANUAL_ID_SOURCE" "$MANUAL_ID_NATIVE" || fail "native manual identity reload"
node --input-type=module - "$ROOT" "$MANUAL_ID_NATIVE" <<'NODE' || fail "native manual identity preservation"
import { readFileSync } from "node:fs";
const root = process.argv[2];
const source = process.argv[3];
const { ipeDocumentCodec } = await import(`${root}/dist/src/core/ipe-document-codec.js`);
const object = ipeDocumentCodec.parse(readFileSync(source)).pages[0].objects[0];
if (object.id !== "object-000000000000000000000099" || object.custom !== "edited-by-user") throw new Error(`manual ID/custom drifted: ${object.id}/${object.custom}`);
console.log("native manual identity preservation: PASS");
NODE
python3 - "$CANONICAL" "$NATIVE" <<'PY' || fail "native semantic identity/reference preservation"
import sys
import re
import xml.etree.ElementTree as ET

source = ET.parse(sys.argv[1]).getroot()
native = ET.parse(sys.argv[2]).getroot()

def objects(root):
    return [child for page in root.findall("page") for child in page if child.tag in {"path", "text", "image", "group", "use"}]

def identity_values(root):
    values = []
    for page in root.findall("page"):
        for child in page:
            if child.tag in {"path", "text", "image", "group", "use"}:
                values.extend(node.get("custom") for node in child.iter() if node.get("custom"))
    return values

source_objects = objects(source)
native_objects = objects(native)
if [node.tag for node in source_objects] != [node.tag for node in native_objects]:
    raise SystemExit("native object type/order changed")

def normalized_text(node):
    return " ".join("".join(node.itertext()).split())

def path_tokens(node):
    return re.findall(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z*]+", normalized_text(node))

def path_geometry_signature(node):
    tokens = path_tokens(node)
    numeric = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
    operators = tuple(token for token in tokens if not re.fullmatch(numeric, token))
    # Ipe's native writer may expand L/C splines to cubic segments. Keep a
    # compact, non-constant fingerprint of the source point and operator
    # classes; the rendered pixel comparison below checks full geometry.
    if any(operator in operators for operator in ("L", "C", "*")):
        classes = tuple(sorted(set(operator for operator in operators if operator in {"m", "l", "c", "h", "e", "a", "s", "u", "L", "C"})))
        first = tuple(round(float(token), 2) for token in tokens if re.fullmatch(numeric, token))[:2]
        return ("native-spline", classes, first)
    values = []
    for token in tokens:
        if re.fullmatch(numeric, token):
            values.append(round(float(token), 2))
        else:
            values.append(token)
    return tuple(values)

def payload_signature(node):
    """Compare geometry/style payloads while ignoring native-managed identities."""
    if node.tag == "path":
        keys = ("matrix", "pos", "pin", "transformations", "stroke", "fill", "pen", "dash", "cap", "join", "fillrule", "arrow", "rarrow", "opacity", "stroke-opacity", "tiling", "gradient")
        attrs = tuple(sorted((key, node.get(key)) for key in keys if node.get(key) is not None))
        return (node.tag, attrs, path_geometry_signature(node))
    if node.tag == "text":
        # Native Ipe materializes math labels as style="math"; the text
        # payload and label type are compared separately below.
        keys = ("matrix", "pos", "pin", "transformations", "type", "width", "size", "stroke", "fill", "halign", "valign", "opacity")
        attrs = tuple(sorted((key, node.get(key)) for key in keys if node.get(key) is not None))
        text = normalized_text(node)
        if node.get("type") == "label" and len(text) >= 2 and text[0] == "$" and text[-1] == "$":
            text = text[1:-1]
        return (node.tag, attrs, text)
    if node.tag == "image":
        # Bitmap IDs are native-local and may be renumbered; the semantic
        # bitmap/ref comparison below checks that the target content is the
        # same.
        keys = ("matrix", "pos", "pin", "transformations", "rect", "opacity")
        return (node.tag, tuple(sorted((key, node.get(key)) for key in keys if node.get(key) is not None)))
    if node.tag == "use":
        keys = ("matrix", "pos", "pin", "transformations", "name", "stroke", "fill", "pen", "size")
        return (node.tag, tuple(sorted((key, node.get(key)) for key in keys if node.get(key) is not None)))
    if node.tag == "group":
        keys = ("matrix", "pin", "transformations", "clip", "url", "decoration")
        children = tuple(payload_signature(child) for child in node if child.tag in {"path", "text", "image", "group", "use"})
        attrs = tuple(sorted((key, " ".join(node.get(key).split()) if key == "clip" else node.get(key)) for key in keys if node.get(key) is not None))
        return (node.tag, attrs, children)
    return (node.tag, normalized_text(node))

source_payloads = [payload_signature(node) for node in source_objects]
native_payloads = [payload_signature(node) for node in native_objects]
if source_payloads != native_payloads:
    raise SystemExit("native reload changed object geometry, clip, styles, or symbol payload")
if not any(node.tag == "group" and node.get("clip") for node in source_objects):
    raise SystemExit("canonical fixture has no clip payload to compare")
if not any(node.tag == "use" and node.get("name") for node in source_objects):
    raise SystemExit("canonical fixture has no symbol payload to compare")

# Oracle negative self-test: a geometry mutation must be visible to the
# payload comparison, guarding against a future check that only inspects IDs.
mutated = ET.fromstring(ET.tostring(source, encoding="unicode"))
mutated_path = mutated.find(".//page/path")
original_path = source.find(".//page/path")
if mutated_path is None or original_path is None or not normalized_text(mutated_path):
    raise SystemExit("canonical fixture has no path payload for comparator self-test")
mutated_path.text = normalized_text(mutated_path).replace("40 40", "41 40", 1)
if payload_signature(mutated_path) == payload_signature(original_path):
    raise SystemExit("geometry comparator negative self-test did not detect mutation")
if identity_values(source) != identity_values(native):
    raise SystemExit("native reload changed persistent custom identities")

def text_payload(node):
    text = "".join(node.itertext())
    # Ipe's native XML writer strips the delimiter pair around math labels
    # and records the `math` text style instead. Compare the TeX payload,
    # which is the stable semantic content, not that presentation wrapper.
    if node.get("type") == "label" and len(text) >= 2 and text[0] == "$" and text[-1] == "$":
        return text[1:-1]
    return text
source_text = [text_payload(node) for node in source_objects if node.tag == "text"]
native_text = [text_payload(node) for node in native_objects if node.tag == "text"]
if source_text != native_text:
    raise SystemExit("native reload changed label/minipage text payload")

def bitmap_semantics(root):
    return {node.get("id"): tuple(node.get(key) for key in ("width", "height", "Filter", "ColorSpace", "length", "alphaLength")) for node in root.findall("bitmap")}
source_bitmaps = bitmap_semantics(source)
native_bitmaps = bitmap_semantics(native)
source_images = [node for page in source.findall("page") for node in page.iter("image")]
native_images = [node for page in native.findall("page") for node in page.iter("image")]
source_refs = [source_bitmaps[node.get("bitmap")] for node in source_images]
native_refs = [native_bitmaps[node.get("bitmap")] for node in native_images]
if source_refs != native_refs:
    raise SystemExit("native reload changed image asset references or bitmap semantics")

for root_path, native_path in zip(
    [node for node in source_objects if node.tag == "path"],
    [node for node in native_objects if node.tag == "path"],
):
    for attribute in ("stroke", "fill", "arrow", "rarrow", "fillrule", "gradient", "tiling", "opacity", "stroke-opacity"):
        if root_path.get(attribute) != native_path.get(attribute):
            raise SystemExit(f"native reload changed path style attribute {attribute}")
print("native semantic identity/reference/payload preservation: PASS")
PY
pass "canonical fixed point, native 7.2.30 reload, references, identities, and payload geometry"

export IPESCRIPTS="$ROOT/scripts/conformance"
IPESCRIPTS="$ROOT/scripts/conformance" ipescript check-style "$CANONICAL" || fail "native Document:checkStyle()"
IPESCRIPTS="$ROOT/scripts/conformance" ipescript check-style "$NATIVE" || fail "native checkStyle after reload"
pass "native Document:checkStyle() is clean before and after reload"

# Keep the style gate meaningful: ipescript must fail and report a genuinely
# undefined style, rather than succeeding after Lua's error() is swallowed.
INVALID_STYLE="$TMP_ROOT/invalid-style.ipe"
python3 - "$CANONICAL" "$INVALID_STYLE" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
needle = 'stroke="black"'
if needle not in source:
    raise SystemExit("golden has no stroke to mutate")
pathlib.Path(sys.argv[2]).write_text(source.replace(needle, 'stroke="m4-undefined-color"', 1), encoding="utf-8")
PY
if IPESCRIPTS="$ROOT/scripts/conformance" ipescript check-style "$INVALID_STYLE" >"$TMP_ROOT/invalid-style.out" 2>"$TMP_ROOT/invalid-style.err"; then
  fail "native checkStyle negative probe unexpectedly passed"
fi
grep -Eiq 'undefined|m4-undefined-color' "$TMP_ROOT/invalid-style.err" || fail "native checkStyle negative probe omitted diagnostic"
pass "native checkStyle rejects undefined styles with a diagnostic"

MUTATED_C="$TMP_ROOT/mutated-cardinal.ipe"
MUTATED_L="$TMP_ROOT/mutated-clothoid.ipe"
python3 - "$CANONICAL" "$MUTATED_C" "$MUTATED_L" <<'PY' || fail "geometry mutation fixtures"
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
paths = re.findall(r"(<path\b[^>]*>)([^<]*)(</path>)", source)
if not any(re.search(r"(?:^|\s)C(?:\s|$)", body) for _, body, _ in paths):
    raise SystemExit("canonical fixture has no C path for mutation self-test")
if not any(re.search(r"(?:^|\s)L(?:\s|$)", body) for _, body, _ in paths):
    raise SystemExit("canonical fixture has no L path for mutation self-test")

def mutate(operator, output):
    changed = False
    def replace(match):
        nonlocal changed
        prefix, body, suffix = match.groups()
        if changed or not re.search(rf"(?:^|\s){operator}(?:\s|$)", body):
            return match.group(0)
        number = re.match(r"(\s*)([-+]?(?:\d+(?:\.\d*)?|\.\d+))(\s+)", body)
        if number is None:
            raise SystemExit(f"{operator} path has no numeric geometry")
        value = float(number.group(2)) + 9
        changed = True
        rendered = str(int(value)) if value.is_integer() else str(value)
        return prefix + number.group(1) + rendered + number.group(3) + body[number.end():] + suffix
    result = re.sub(r"(<path\b[^>]*>)([^<]*)(</path>)", replace, source)
    if not changed:
        raise SystemExit(f"failed to mutate {operator} geometry")
    pathlib.Path(output).write_text(result, encoding="utf-8")

mutate("C", sys.argv[2])
mutate("L", sys.argv[3])
PY

run_native_clean pdf-export ipetoipe -pdf -nozip "$CANONICAL" "$TMP_ROOT/m4.pdf" || fail "PDF export (stderr warning or failure)"
pdfinfo "$TMP_ROOT/m4.pdf" | grep -Eq '^Pages:[[:space:]]+2$' || fail "PDF page count"
pdftotext "$TMP_ROOT/m4.pdf" "$TMP_ROOT/m4.txt" >/dev/null 2>&1 || fail "PDF text extraction"
grep -Fq 'M4 minipage' "$TMP_ROOT/m4.txt" || fail "PDF lost minipage text"
for page in 1 2; do
  run_native_clean "svg-render-canonical-$page" iperender -svg -page "$page" "$CANONICAL" "$TMP_ROOT/m4-page-$page.svg" || fail "canonical SVG render page $page (stderr warning or failure)"
  run_native_clean "png-render-canonical-$page" iperender -png -transparent -page "$page" "$CANONICAL" "$TMP_ROOT/m4-page-$page.png" || fail "canonical PNG render page $page (stderr warning or failure)"
  run_native_clean "svg-render-native-$page" iperender -svg -page "$page" "$NATIVE" "$TMP_ROOT/m4-native-page-$page.svg" || fail "native SVG render page $page (stderr warning or failure)"
  run_native_clean "png-render-native-$page" iperender -png -transparent -page "$page" "$NATIVE" "$TMP_ROOT/m4-native-page-$page.png" || fail "native PNG render page $page (stderr warning or failure)"
done
run_native_clean png-render-mutated-c iperender -png -transparent -page 1 "$MUTATED_C" "$TMP_ROOT/m4-mutated-c-page-1.png" || fail "C geometry negative render (stderr warning or failure)"
run_native_clean png-render-mutated-l iperender -png -transparent -page 1 "$MUTATED_L" "$TMP_ROOT/m4-mutated-l-page-1.png" || fail "L geometry negative render (stderr warning or failure)"
python3 - "$TMP_ROOT/m4-page-1.svg" "$TMP_ROOT/m4-page-2.svg" "$TMP_ROOT/m4-page-1.png" "$TMP_ROOT/m4-page-2.png" "$TMP_ROOT/m4-native-page-1.svg" "$TMP_ROOT/m4-native-page-2.svg" "$TMP_ROOT/m4-native-page-1.png" "$TMP_ROOT/m4-native-page-2.png" <<'PY' || fail "render output validation"
import pathlib
import sys
import xml.etree.ElementTree as ET

for index, svg_arg, png_arg, native_svg_arg, native_png_arg, path_min, image_min in ((1, 1, 3, 5, 7, 30, 2), (2, 2, 4, 6, 8, 20, 1)):
    svg_path = pathlib.Path(sys.argv[svg_arg])
    root = ET.parse(svg_path).getroot()
    tags = [node.tag.rsplit("}", 1)[-1] for node in root.iter()]
    if "svg" not in tags or tags.count("path") < path_min or tags.count("image") < image_min or tags.count("clipPath") < 1:
        raise SystemExit(f"page {index} SVG lacks expected rendered geometry/assets")
    native_root = ET.parse(sys.argv[native_svg_arg]).getroot()
    native_tags = [node.tag.rsplit("}", 1)[-1] for node in native_root.iter()]
    if "svg" not in native_tags or native_tags.count("path") < path_min or native_tags.count("image") < image_min or native_tags.count("clipPath") < 1:
        raise SystemExit(f"page {index} native SVG lacks expected rendered geometry/assets")
    png_path = pathlib.Path(sys.argv[png_arg])
    png = png_path.read_bytes()
    if png[:8] != b"\x89PNG\r\n\x1a\n" or len(png) < 1000:
        raise SystemExit(f"page {index} PNG is empty or invalid")
    native_png = pathlib.Path(sys.argv[native_png_arg]).read_bytes()
    if native_png[:8] != b"\x89PNG\r\n\x1a\n" or len(native_png) < 1000:
        raise SystemExit(f"page {index} native PNG is empty or invalid")
print("render outputs: PASS (both pages, SVG geometry/assets and PNG signatures)")
PY
node --input-type=module - "$TMP_ROOT/m4-page-1.png" "$TMP_ROOT/m4-page-2.png" "$TMP_ROOT/m4-native-page-1.png" "$TMP_ROOT/m4-native-page-2.png" "$TMP_ROOT/m4-mutated-c-page-1.png" "$TMP_ROOT/m4-mutated-l-page-1.png" <<'NODE' || fail "PNG pixel validation"
import fs from "node:fs";
import crypto from "node:crypto";
import { PNG } from "pngjs";

const paths = process.argv.slice(2);
const decoded = paths.map((path) => PNG.sync.read(fs.readFileSync(path)));
if (decoded.length !== 6 || decoded.some(({ width, height }) => width <= 0 || height <= 0)) {
  throw new Error("PNG dimensions are invalid");
}
function summary(image) {
  let pixels = 0;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  const colors = new Set();
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3];
      if (!alpha) continue;
      pixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      colors.add(`${image.data[offset]},${image.data[offset + 1]},${image.data[offset + 2]}`);
    }
  }
  if (pixels < 100 || maxX - minX < 10 || maxY - minY < 10 || colors.size < 3) {
    throw new Error(`PNG has insufficient rendered pixels (${pixels}), bounds, or color diversity (${colors.size})`);
  }
  return { width: image.width, height: image.height, pixels, minX, minY, maxX, maxY, colors: colors.size, hash: crypto.createHash("sha256").update(image.data).digest("hex") };
}
function mismatch(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error("PNG dimensions differ during visual comparison");
  let pixels = 0;
  let maxDelta = 0;
  for (let offset = 0; offset < a.data.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(a.data[offset + channel] - b.data[offset + channel]);
      maxDelta = Math.max(maxDelta, delta);
      if (delta > 1) changed = true;
    }
    if (changed) pixels += 1;
  }
  return { pixels, maxDelta, tolerance: Math.max(4, Math.floor(a.width * a.height * 0.0001)) };
}
function assertEquivalent(a, b, label) {
  const difference = mismatch(a, b);
  if (difference.pixels > difference.tolerance) {
    throw new Error(`${label} visual mismatch: ${difference.pixels} pixels (tolerance ${difference.tolerance}, max channel delta ${difference.maxDelta})`);
  }
  if (a.hash !== b.hash) {
    console.log(`${label} PNG hashes differ within pixel tolerance (${a.hash} != ${b.hash})`);
  }
}
function assertChanged(a, b, label) {
  const difference = mismatch(a, b);
  if (difference.pixels <= difference.tolerance) {
    throw new Error(`${label} negative visual mutation was not detected (${difference.pixels} pixels, tolerance ${difference.tolerance})`);
  }
}
const canonical = decoded.slice(0, 2).map(summary);
const native = decoded.slice(2).map(summary);
const mutated = decoded.slice(4).map(summary);
if (canonical[0].hash === canonical[1].hash) throw new Error("canonical page PNG outputs are unexpectedly identical");
for (let index = 0; index < 2; index += 1) {
  const a = canonical[index];
  const b = native[index];
  for (const key of ["width", "height", "pixels", "minX", "minY", "maxX", "maxY", "colors"]) {
    if (a[key] !== b[key]) throw new Error(`page ${index + 1} canonical/native PNG semantic mismatch at ${key}: ${a[key]} != ${b[key]}`);
  }
  assertEquivalent(decoded[index], decoded[index + 2], `page ${index + 1} canonical/native`);
}
assertChanged(decoded[0], decoded[4], "C geometry");
assertChanged(decoded[0], decoded[5], "L geometry");
console.log("PNG pixels: PASS (canonical/native visual equivalence, page distinction, and C/L negative mutations)");
NODE
pass "PDF (2 pages with text), and canonical/native every-page SVG/PNG render verified"

pass "M4 gate complete"
