#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
FIXTURES="$ROOT/fixtures/conformance"
TMPDIR_M0=$(mktemp -d)
trap 'rm -rf "$TMPDIR_M0"' EXIT

fail() { echo "M0 FAIL: $*" >&2; exit 1; }
pass() { echo "M0 PASS: $*"; }

[[ -f "$ROOT/docs/adr/0001-compatibility-baseline.md" ]] || fail "ADR 0001 missing"
[[ -f "$ROOT/docs/adr/0002-domain-model-and-layout.md" ]] || fail "ADR 0002 missing"
[[ -f "$ROOT/docs/adr/0003-backend-persistence-and-identifiers.md" ]] || fail "ADR 0003 missing"
[[ -f "$ROOT/docs/adr/0004-security-and-trust-boundaries.md" ]] || fail "ADR 0004 missing"
[[ -f "$ROOT/docs/reference/compatibility-modes.md" ]] || fail "compatibility matrix missing"
for adr in "$ROOT"/docs/adr/000{1,2,3,4}-*.md; do
  grep -Eiq '^-?[[:space:]]*(status|stato):[[:space:]]*(\*\*)?accepted(\*\*)?[[:space:]]*$' "$adr" || fail "ADR not Accepted: $(basename "$adr")"
done
grep -Eq 'structural-only' "$ROOT/docs/reference/compatibility-modes.md" || fail "structural-only mode missing"
grep -Eq 'full' "$ROOT/docs/reference/compatibility-modes.md" || fail "full mode missing"
grep -Eq 'nightly' "$ROOT/docs/reference/compatibility-modes.md" || fail "nightly mode missing"
for id in TM-XML TM-TEX TM-FS TM-ASSET TM-PROC TM-CONCURRENCY TM-METADATA TM-HTTP; do
  grep -Eq "$id" "$ROOT/docs/adr/0004-security-and-trust-boundaries.md" || fail "threat ID missing: $id"
done
threat_ids=$(grep -Eo 'TM-[A-Z]+' "$ROOT/docs/adr/0004-security-and-trust-boundaries.md" | sort -u)
expected_threat_ids=$(printf '%s\n' TM-ASSET TM-CONCURRENCY TM-FS TM-HTTP TM-METADATA TM-PROC TM-TEX TM-XML)
[[ "$threat_ids" == "$expected_threat_ids" ]] || fail "threat model contains non-canonical IDs"
pass "ADR, compatibility matrix, and eight threat IDs"

[[ -f "$FIXTURES/manifest.json" ]] || fail "manifest missing"
python3 - "$FIXTURES/manifest.json" "$FIXTURES" <<'PY'
import json, pathlib, sys
manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
seeds = manifest.get("seeds", [])
if len(seeds) < 6: raise SystemExit("manifest has fewer than six seeds")
manifest_files = {item.get("file", "") for item in seeds}
fixture_files = {path.name for path in pathlib.Path(sys.argv[2]).glob("*.ipe")}
if manifest_files != fixture_files:
    raise SystemExit(f"manifest/file mismatch: manifest={sorted(manifest_files)}, fixtures={sorted(fixture_files)}")
for item in seeds:
    name = item.get("file", "")
    if not name.endswith(".ipe") or not (pathlib.Path(sys.argv[2]) / name).is_file():
        raise SystemExit(f"manifest seed missing: {name}")
    if not item.get("purpose") or not item.get("features") or not item.get("invariants"):
        raise SystemExit(f"manifest entry incomplete: {name}")
if manifest.get("format_version") != "70218": raise SystemExit("manifest format is not 70218")
PY
pass "manifest contains six complete 70218 seed entries"

ipe_version=$(dpkg-query -W -f='${Version}' ipe 2>/dev/null) || fail "ipe package not installed"
[[ "$ipe_version" == 7.2.30* ]] || fail "expected ipe 7.2.30, got $ipe_version"
echo "M0 INFO: installed ipe $ipe_version"

python3 - "$FIXTURES" <<'PY'
import pathlib, re, sys, xml.etree.ElementTree as ET
root = pathlib.Path(sys.argv[1])
for path in sorted(root.glob("*.ipe")):
    raw = path.read_text()
    if not re.search(r'<ipe\s+version="70218"', raw): raise SystemExit(f"{path.name}: root before is not 70218")
    tree = ET.parse(path); doc = tree.getroot()
    for page in doc.findall("page"):
        if not page.findall("layer") or not page.findall("view"): raise SystemExit(f"{path.name}: missing layer/view")
        for obj in page:
            if obj.tag in {"path", "text", "image", "group", "use"} and "layer" not in obj.attrib:
                raise SystemExit(f"{path.name}: top-level {obj.tag} lacks layer")
        for view in page.findall("view"):
            if "active" not in view.attrib or "marked" not in view.attrib: raise SystemExit(f"{path.name}: view flags incomplete")
PY
for seed in "$FIXTURES"/*.ipe; do
  out="$TMPDIR_M0/$(basename "$seed")"
  ipetoipe -xml "$seed" "$out" >/dev/null 2>&1 || fail "round-trip failed: $(basename "$seed")"
  grep -Eq '<ipe[[:space:]]+version="70218"' "$out" || fail "root after is not 70218: $(basename "$seed")"
  pass "round-trip $(basename "$seed") root 70218 before/after"
done
pass "M0 smoke complete"
