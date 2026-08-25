#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

fail() { echo "M3 FAIL: $*" >&2; exit 1; }
pass() { echo "M3 PASS: $*"; }

[[ -x "$ROOT/scripts/check-m2.sh" ]] || fail "check-m2.sh missing or not executable"
bash "$ROOT/scripts/check-m2.sh"

for token in \
  'Coordinates are always y-up' \
  'viewLayerMatrix * objectMatrix' \
  '1e-12*n²' \
  'ipe-mcp.layout.v1' \
  'paper="1280 720" origin="32 0" frame="1216 648"'; do
  grep -Fq "$token" "$ROOT/docs/core-m3.md" || fail "M3 contract token missing: $token"
done
pass "coordinate, composition, tolerance, sidecar and 16:9 contracts documented"

mapfile -t fixtures < <(find "$ROOT/fixtures/conformance/m3" -maxdepth 1 -type f -name '*-layout.json' -print | sort)
[[ ${#fixtures[@]} -eq 2 ]] || fail "expected exactly two M3 layout fixtures, found ${#fixtures[@]}"
python3 - "${fixtures[@]}" <<'PY' || fail "M3 fixture structure"
import json
import sys

names = []
for path in sys.argv[1:]:
    data = json.load(open(path, encoding="utf-8"))
    names.append(data["name"])
    if not data["sentinels"] or not data["expected"]:
        raise SystemExit(f"missing sentinels or expected placements: {path}")
    ys = [item["box"]["y"] for item in data["expected"]]
    if max(ys) == min(ys):
        raise SystemExit(f"fixture cannot detect y inversion: {path}")
if names != ["presentation-16x9", "standard"]:
    raise SystemExit(f"unexpected fixture names/order: {names}")
PY
pass "standard and presentation 16:9 fixture structure"

(cd "$ROOT" && npx vitest run tests/layout) || fail "M3 focused tests"
pass "seeded affine properties, coordinate golden, layout, sidecar, plan and connector tests"
