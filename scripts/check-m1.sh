#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FIXTURES="$ROOT/fixtures/conformance/m1"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { echo "M1 FAIL: $*" >&2; exit 1; }
pass() { echo "M1 PASS: $*"; }
skip() { echo "M1 SKIP: $*"; }

[[ -x "$ROOT/scripts/check-m0.sh" ]] || fail "check-m0.sh missing or not executable"
bash "$ROOT/scripts/check-m0.sh"

for binary in ipetoipe iperender ipescript; do
  command -v "$binary" >/dev/null 2>&1 || fail "$binary not found"
done
ipe_version=$(dpkg-query -W -f='${Version}' ipe 2>/dev/null) || fail "ipe package not installed"
[[ "$ipe_version" == 7.2.30* ]] || fail "expected ipe 7.2.30, got $ipe_version"
echo "M1 INFO: installed ipe $ipe_version"

[[ -f "$FIXTURES/manifest.json" ]] || fail "M1 manifest missing"
python3 - "$FIXTURES/manifest.json" "$FIXTURES" <<'PY'
import json
import pathlib
import sys

manifest_path = pathlib.Path(sys.argv[1])
fixture_dir = pathlib.Path(sys.argv[2])
manifest = json.loads(manifest_path.read_text())
entries = manifest.get("fixtures")
if manifest.get("format_version") != "70218":
    raise SystemExit("M1 manifest format is not 70218")
if not isinstance(entries, list) or len(entries) != 5:
    raise SystemExit("M1 manifest must contain five fixtures")
names = [entry.get("file") for entry in entries]
if any(not isinstance(name, str) or not name.endswith(".ipe") for name in names):
    raise SystemExit("M1 manifest contains an invalid file name")
if len(set(names)) != len(names):
    raise SystemExit("M1 manifest contains duplicate files")
actual = sorted(path.name for path in fixture_dir.glob("*.ipe"))
if sorted(names) != actual:
    raise SystemExit(f"M1 manifest/file mismatch: manifest={sorted(names)}, files={actual}")
for entry in entries:
    if not entry.get("purpose") or not entry.get("features") or not entry.get("invariants"):
        raise SystemExit(f"M1 manifest entry incomplete: {entry.get('file')}")
PY
pass "manifest exactly matches five M1 fixtures"

for fixture in "$FIXTURES"/*.ipe; do
  base=$(basename "$fixture")
  grep -Eq '<ipe[[:space:]]+version="70218"' "$fixture" || fail "source root version: $base"
  ipetoipe -xml "$fixture" "$TMP_ROOT/rt-$base" >/dev/null 2>&1 || fail "ipetoipe XML round-trip: $base"
  grep -Eq '<ipe[[:space:]]+version="70218"' "$TMP_ROOT/rt-$base" || fail "round-trip root version: $base"
  iperender -svg "$fixture" "$TMP_ROOT/render-$base.svg" >/dev/null 2>&1 || fail "iperender SVG: $base"
done
python3 - "$TMP_ROOT/render-z-order-copy.ipe.svg" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
paths = root.findall("{http://www.w3.org/2000/svg}path")
fills = [path.get("fill") for path in paths]
expected = ["rgb(20%, 50%, 90%)", "rgb(90%, 70%, 10%)", "rgb(80%, 10%, 20%)", "rgb(90%, 70%, 10%)"]
if fills != expected:
    raise SystemExit(f"rendered z-order mismatch: expected={expected}, actual={fills}")
PY
iperender -svg -view 1 "$FIXTURES/effects-0-27.ipe" "$TMP_ROOT/render-effects-view-1.svg" >/dev/null 2>&1 || fail "iperender effects view 1"
iperender -svg -view 28 "$FIXTURES/effects-0-27.ipe" "$TMP_ROOT/render-effects-view-28.svg" >/dev/null 2>&1 || fail "iperender effects view 28"
iperender -svg -view 1 "$FIXTURES/bbox-viewbbox-group-transform.ipe" "$TMP_ROOT/render-bbox-view-1.svg" >/dev/null 2>&1 || fail "iperender bbox view 1"
iperender -svg -view 2 "$FIXTURES/bbox-viewbbox-group-transform.ipe" "$TMP_ROOT/render-bbox-view-2.svg" >/dev/null 2>&1 || fail "iperender bbox view 2"
python3 - "$TMP_ROOT/render-bbox-view-1.svg" "$TMP_ROOT/render-bbox-view-2.svg" <<'PY'
import sys
import xml.etree.ElementTree as ET

def linked_shape(path):
    root = ET.parse(path).getroot()
    matches = [
        element.get("d")
        for element in root.findall("{http://www.w3.org/2000/svg}path")
        if element.get("fill") == "rgb(90%, 50%, 50%)"
    ]
    if len(matches) != 1:
        raise SystemExit(f"expected one linked red shape in {path}, got {len(matches)}")
    return matches[0]

view1 = linked_shape(sys.argv[1])
view2 = linked_shape(sys.argv[2])
if "M 75 45 L 185 45 L 185 125 L 75 125" not in view1:
    raise SystemExit(f"bbox view 1 translation mismatch: {view1}")
if view1 == view2 or "M 75.128906 81.46875" not in view2:
    raise SystemExit(f"bbox view 2 transform mismatch: {view2}")
PY
ipetoipe -pdf -nozip "$FIXTURES/effects-0-27.ipe" "$TMP_ROOT/effects.pdf" >/dev/null 2>&1 || fail "effects PDF export"
python3 "$ROOT/scripts/probe-m1-pdf.py" effects "$TMP_ROOT/effects.pdf" >/dev/null || fail "effects PDF matrix"
ipetoipe -pdf -nozip "$FIXTURES/bbox-viewbbox-group-transform.ipe" "$TMP_ROOT/bbox.pdf" >/dev/null 2>&1 || fail "bbox PDF export"
python3 "$ROOT/scripts/probe-m1-pdf.py" bbox "$TMP_ROOT/bbox.pdf" >/dev/null || fail "bbox/link PDF structure"
pass "ipetoipe XML, visual SVG order/transforms, effects PDF matrix, and bbox/link PDF"

export IPESCRIPTS="$ROOT/scripts/conformance"
capabilities=$(ipescript capabilities "$FIXTURES/metadata-custom-x.ipe") || fail "ipescript capability probe"
printf '%s\n' "$capabilities" | grep -Eq '^IPE_CAPABILITIES_FORMAT=1$' || fail "capability format"
printf '%s\n' "$capabilities" | grep -Eq '^IPE_RUNTIME_VERSION=.*7\.2\.30' || fail "Lua runtime is not 7.2.30"
printf '%s\n' "$capabilities" | grep -Eq '^IPE_CAPABILITY_DOCUMENT_LOAD=PASS$' || fail "Lua document load capability"
for capability in DOCUMENT_SAVE PAGE_OBJECTS PAGE_INSERT PAGE_BBOX PAGE_LAYERS PAGE_VIEWS PAGE_LAYER_MATRICES OBJECT_CLONE OBJECT_GET_CUSTOM OBJECT_SET_CUSTOM OBJECT_MATRIX OBJECT_SET_MATRIX; do
  printf '%s\n' "$capabilities" | grep -Eq "^IPE_CAPABILITY_${capability}=PASS$" || fail "Lua capability ${capability}"
done
pass "ipescript capabilities and 7.2.30 runtime"

GOLDEN="$FIXTURES/golden-results.json"
[[ -f "$GOLDEN" ]] || fail "golden-results.json missing"
for fixture in "$FIXTURES"/*.ipe; do
  base=$(basename "$fixture")
  native_args=()
  native_path=""
  case "$base" in
    metadata-custom-x.ipe) native_path="$TMP_ROOT/native-$base"; native_args=("$native_path" "ipe-mcp:99999999-9999-4999-8999-999999999999") ;;
    z-order-copy.ipe) native_path="$TMP_ROOT/native-$base"; native_args=("$native_path" "ipe-mcp:88888888-8888-4888-8888-888888888888") ;;
    bbox-viewbbox-group-transform.ipe) native_path="$TMP_ROOT/native-$base"; native_args=("$native_path" "ipe-mcp:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") ;;
  esac
  if ((${#native_args[@]})); then
    ipescript native-roundtrip-copy "$fixture" "${native_args[@]}" >"$TMP_ROOT/native-$base.log" 2>&1 || fail "native round-trip copy: $base"
    python3 - "$TMP_ROOT/native-$base.log" "${native_args[1]}" <<'PY'
import pathlib
import sys

values = {}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if line.startswith("IPE_ROUNDTRIP_") and "=" in line:
        key, value = line.split("=", 1)
        values[key] = value
required = {
    "IPE_ROUNDTRIP_CUSTOM_BEFORE",
    "IPE_ROUNDTRIP_CUSTOM_AFTER",
    "IPE_ROUNDTRIP_SOURCE_LAYER",
    "IPE_ROUNDTRIP_CLONE_LAYER",
    "IPE_ROUNDTRIP_SOURCE_BBOX",
    "IPE_ROUNDTRIP_CLONE_BBOX",
    "IPE_ROUNDTRIP_SOURCE_MATRIX",
    "IPE_ROUNDTRIP_CLONE_MATRIX",
    "IPE_ROUNDTRIP_CLONE_ID",
    "IPE_ROUNDTRIP_CLONE_PAYLOAD_MATCH",
}
missing = sorted(required - values.keys())
if missing:
    raise SystemExit(f"native copy summary missing: {missing}")
if int(values["IPE_ROUNDTRIP_CUSTOM_AFTER"]) != int(values["IPE_ROUNDTRIP_CUSTOM_BEFORE"]) + 1:
    raise SystemExit("native copy custom count did not increase by one")
if values["IPE_ROUNDTRIP_CLONE_ID"] != sys.argv[2]:
    raise SystemExit("native copy ID mismatch")
if values["IPE_ROUNDTRIP_CLONE_PAYLOAD_MATCH"] != "PASS":
    raise SystemExit("native copy payload mismatch")
for source_key, clone_key in (
    ("IPE_ROUNDTRIP_SOURCE_LAYER", "IPE_ROUNDTRIP_CLONE_LAYER"),
    ("IPE_ROUNDTRIP_SOURCE_BBOX", "IPE_ROUNDTRIP_CLONE_BBOX"),
    ("IPE_ROUNDTRIP_SOURCE_MATRIX", "IPE_ROUNDTRIP_CLONE_MATRIX"),
):
    if values[source_key] != values[clone_key]:
        raise SystemExit(f"native copy mismatch: {source_key} != {clone_key}")
PY
    python3 "$ROOT/scripts/probe-m1.py" "$fixture" "$TMP_ROOT/rt-$base" --native-copy "$native_path" >"$TMP_ROOT/probe-$base.json" || fail "M1 probe: $base"
  else
    python3 "$ROOT/scripts/probe-m1.py" "$fixture" "$TMP_ROOT/rt-$base" >"$TMP_ROOT/probe-$base.json" || fail "M1 probe: $base"
  fi
done
python3 - "$GOLDEN" "$TMP_ROOT" <<'PY'
import json
import pathlib
import sys

golden_path = pathlib.Path(sys.argv[1])
run_dir = pathlib.Path(sys.argv[2])
golden = json.loads(golden_path.read_text())
expected = golden.get("fixtures")
actual = {}
for path in sorted(run_dir.glob("probe-*.ipe.json")):
    name = path.name.removeprefix("probe-")
    actual[name[:-5]] = json.loads(path.read_text())
if golden.get("format") != 1 or golden.get("baseline") != "70218":
    raise SystemExit("invalid M1 golden header")
if expected != actual:
    missing = sorted(set(expected or {}) - set(actual))
    extra = sorted(set(actual) - set(expected or {}))
    different = sorted(name for name in set(expected or {}) & set(actual) if expected[name] != actual[name])
    raise SystemExit(f"golden mismatch: missing={missing}, extra={extra}, different={different}")
PY
pass "probe output matches committed golden"

if [[ -z "${IPE_M1_SOURCE_BIN_DIR:-}" ]]; then
  skip "source lane (set IPE_M1_SOURCE_BIN_DIR to an existing 7.2.30 bin directory)"
else
  source_bin=$IPE_M1_SOURCE_BIN_DIR
  [[ -d "$source_bin" ]] || fail "IPE_M1_SOURCE_BIN_DIR is not a directory"
  for binary in ipetoipe iperender ipescript; do
    [[ -x "$source_bin/$binary" ]] || fail "source lane binary missing: $source_bin/$binary"
  done
  source_caps=$(IPESCRIPTS="$ROOT/scripts/conformance" "$source_bin/ipescript" capabilities "$FIXTURES/metadata-custom-x.ipe") || fail "source lane capability probe"
  printf '%s\n' "$source_caps" | grep -Eq '^IPE_RUNTIME_VERSION=.*7\.2\.30' || fail "source lane is not Ipe 7.2.30"
  for fixture in "$FIXTURES"/*.ipe; do
    base=$(basename "$fixture")
    "$source_bin/ipetoipe" -xml "$fixture" "$TMP_ROOT/source-$base" >/dev/null 2>&1 || fail "source lane ipetoipe: $base"
    "$source_bin/iperender" -svg "$fixture" "$TMP_ROOT/source-render-$base.svg" >/dev/null 2>&1 || fail "source lane iperender: $base"
  done
  pass "optional source lane uses existing 7.2.30 binaries (no build/download)"
fi
