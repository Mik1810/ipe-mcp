#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { echo "M2 FAIL: $*" >&2; exit 1; }
pass() { echo "M2 PASS: $*"; }

[[ -x "$ROOT/scripts/check-m1.sh" ]] || fail "check-m1.sh missing or not executable"
bash "$ROOT/scripts/check-m1.sh"

command -v node >/dev/null 2>&1 || fail "node not found"
command -v npm >/dev/null 2>&1 || fail "npm not found"
command -v ipetoipe >/dev/null 2>&1 || fail "ipetoipe not found"

(cd "$ROOT" && npm run build) || fail "TypeScript build"
(cd "$ROOT" && npm test) || fail "unit and integration tests"
pass "TypeScript build and tests"

mapfile -t fixtures < <(find "$ROOT/fixtures/conformance" -maxdepth 2 -type f -name '*.ipe' -print | sort)
[[ ${#fixtures[@]} -eq 12 ]] || fail "expected 12 M0/M1/M2 corpus files, found ${#fixtures[@]}"

for fixture in "${fixtures[@]}"; do
  relative=${fixture#"$ROOT/fixtures/conformance/"}
  safe_name=${relative//\//__}
  canonical="$TMP_ROOT/canonical-$safe_name"
  fixed="$TMP_ROOT/fixed-$safe_name"
  native="$TMP_ROOT/native-$safe_name"
  node "$ROOT/dist/src/cli/canonicalize.js" "$fixture" "$canonical" || fail "canonicalize $relative"
  node "$ROOT/dist/src/cli/canonicalize.js" "$canonical" "$fixed" || fail "fixed-point canonicalize $relative"
  cmp -s "$canonical" "$fixed" || fail "canonical fixed point $relative"
  grep -Eq '<ipe[[:space:]]+version="70218"' "$canonical" || fail "70218 root $relative"
  python3 "$ROOT/scripts/probe-m1.py" "$fixture" "$canonical" >"$TMP_ROOT/semantic-$safe_name.json" || fail "semantic probe $relative"
  python3 - "$TMP_ROOT/semantic-$safe_name.json" <<'PY' || fail "semantic equality $relative"
import json
import re
import sys

result = json.load(open(sys.argv[1], encoding="utf-8"))
checks = result["checks"]
unequal = {name for name, value in checks.items() if isinstance(value, dict) and value.get("equal") is False}
source_custom = checks["custom"]["source"]
roundtrip_custom = checks["custom"]["roundtrip"]
source_index = 0
generated = []
for value in roundtrip_custom:
    if source_index < len(source_custom) and value == source_custom[source_index]:
        source_index += 1
    else:
        generated.append(value)
generated_custom_ok = (
    source_index == len(source_custom)
    and len(generated) == len(set(generated))
    and all(re.fullmatch(r"ipe-mcp:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}", value) for value in generated)
)
if generated_custom_ok:
    unequal -= {"custom", "order_custom"}
    pages_before = checks["layer_view_active_marked"]["source"]
    pages_after = checks["layer_view_active_marked"]["roundtrip"]
    for page in pages_before:
        for obj in page["objects"]:
            obj["custom"] = None
    for page in pages_after:
        for obj in page["objects"]:
            obj["custom"] = None
    if pages_before == pages_after:
        unequal.discard("layer_view_active_marked")
unknown_before = checks["unknown_x"]["source"]
unknown_after = checks["unknown_x"]["roundtrip"]
source_index = 0
generated_identity_attributes = []
for attribute in unknown_after["attributes"]:
    if source_index < len(unknown_before["attributes"]) and attribute == unknown_before["attributes"][source_index]:
        source_index += 1
    else:
        generated_identity_attributes.append(attribute)
generated_identity_ok = (
    source_index == len(unknown_before["attributes"])
    and unknown_before["elements"] == unknown_after["elements"]
    and len({attribute["value"] for attribute in generated_identity_attributes}) == len(generated_identity_attributes)
    and all(
        attribute["name"] == "x-ipe-mcp-id"
        and re.fullmatch(r"(?:page|layer|view|style|asset|object)-[0-9a-f]{24}", attribute["value"])
        for attribute in generated_identity_attributes
    )
)
if generated_identity_ok:
    unequal.discard("unknown_x")
if checks.get("default_materialized"):
    unequal -= {"layer_view_active_marked", "view_transform"}
if unequal:
    raise SystemExit(f"semantic checks differ: {sorted(unequal)}")
PY
  ipetoipe -xml "$canonical" "$native" >/dev/null 2>&1 || fail "native reload $relative"
done
pass "12-file semantic comparison, XML fixed point and native 7.2.30 reload"

python3 - "$TMP_ROOT/canonical-m2__implicit-layer-view-defaults.ipe" <<'PY' || fail "implicit layer/view defaults"
import sys
import xml.etree.ElementTree as ET

page = ET.parse(sys.argv[1]).getroot().find("page")
if page is None:
    raise SystemExit("page missing")
view = page.find("view")
objects = [child for child in page if child.tag in {"path", "text", "image", "group", "use"}]
if view is None or view.get("layers") != "a b" or view.get("active") != "a":
    raise SystemExit("implicit view does not expose all layers with first active")
if [obj.get("layer") for obj in objects] != ["a", "b", "b"]:
    raise SystemExit("implicit object layer inheritance mismatch")
PY
pass "native implicit layer/view defaults materialized exactly"

node "$ROOT/dist/src/cli/canonicalize.js" \
  "$ROOT/fixtures/conformance/m1/metadata-custom-x.ipe" \
  "$TMP_ROOT/metadata.ipe"
for token in \
  'x-ipe-mcp probe="element-retention"' \
  'x-origin="manual"' \
  'custom="ipe-mcp:11111111-1111-4111-8111-111111111111"' \
  '20 20 m 220 20 l 220 160 l 20 160 l h'; do
  grep -Fq "$token" "$TMP_ROOT/metadata.ipe" || fail "supported payload lost: $token"
done
pass "custom IDs, extensions, attributes, geometry and text payload retained"

if node "$ROOT/dist/src/cli/canonicalize.js" \
  "$ROOT/fixtures/conformance/m1/golden-results.json" "$TMP_ROOT/not-ipe" >/dev/null 2>&1; then
  fail "non-Ipe input accepted"
fi
python3 - "$TMP_ROOT/invalid-utf8.ipe" <<'PY'
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_bytes(b'<ipe version="70218">\xff</ipe>')
PY
if node "$ROOT/dist/src/cli/canonicalize.js" "$TMP_ROOT/invalid-utf8.ipe" "$TMP_ROOT/not-utf8" >/dev/null 2>&1; then
  fail "invalid UTF-8 accepted by CLI"
fi
pass "non-Ipe and invalid UTF-8 input rejected"
