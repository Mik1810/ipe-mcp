#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/gates/m9-common.sh"
M9_REAL_TMP=$(mktemp -d)
trap 'rm -rf "$M9_REAL_TMP"' EXIT
fail() { echo "M9 REAL FAIL: $*" >&2; exit 1; }

m9_require_m8 "$ROOT" || fail "M8 gate"
(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && node scripts/conformance/m9-real-runner.mjs "$M9_REAL_TMP/run" "$M9_REAL_TMP/evidence.json") || fail "real-document review run"
cmp "$M9_REAL_TMP/evidence.json" "$ROOT/fixtures/conformance/m9/real/evidence.json" || fail "real-document evidence drift"

python3 - "$ROOT" <<'PY' || fail "real-document review audit"
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
fixtures = root / "fixtures/conformance/m9/real"
manifest = json.loads((fixtures / "manifest.json").read_text())
evidence = json.loads((fixtures / "evidence.json").read_text())
doc = (root / "docs/milestones/core-m9-real.md").read_text()

assert evidence["scenario"] == "m9-real-v1" and evidence["milestone"] == "M9" and evidence["subissue"] == 20 and evidence["contract"] == "ipe-mcp/1"
assert manifest["milestone"] == "M9" and manifest["subissue"] == 20

# retention policy: the only artifacts retained are the documented MIT fixture, its license, manifest, and evidence
retained = sorted(item.name for item in fixtures.iterdir())
assert retained == ["LICENSE.TUD-slides", "TUD-slides-template.ipe", "evidence.json", "manifest.json"], f"unexpected retained files {retained}"
assert hashlib.sha256((fixtures / "TUD-slides-template.ipe").read_bytes()).hexdigest() == next(entry["originalSha256"] for entry in manifest["cases"] if entry["id"] == "REAL-003")

for entry in manifest["cases"][:3]:
    c = next((item for item in evidence["cases"] if item["id"] == entry["id"]), None)
    assert c is not None, f"missing evidence for {entry['id']}"
    p = c["phases"]
    # provenance fidelity: the accessed original matched the recorded hash and stayed untouched
    assert c["originalSha256"] == entry["originalSha256"], f"{entry['id']} original hash mismatch"
    assert c["derived"]["rootVersion"] == "70218", f"{entry['id']} derivation did not yield 70218"

    # IR-level phases must pass on every real document
    for phase in ["open", "inspect", "edit", "saveCopy", "reopen"]:
        assert p[phase]["ok"] is True, f"{entry['id']} failed {phase}: {p.get(phase)}"
    assert p["inspect"]["pageCount"] == entry["observedShape"]["pages"], f"{entry['id']} page count mismatch"
    assert p["inspect"]["views"] == entry["observedShape"]["views"], f"{entry['id']} view count mismatch"
    assert p["inspect"]["layers"] == entry["observedShape"]["layers"], f"{entry['id']} layer count mismatch"

    # native phases were exercised: PASS or a recorded classified candidate response
    for phase in ["validate", "pdf", "png"]:
        recorded = p[phase]
        pass_or_classified = recorded.get("ok") is True or recorded.get("classified") is True
        assert pass_or_classified, f"{entry['id']} native phase {phase} neither passed nor classified: {recorded}"
    # every view was attempted: one entry per page, each pass or classified record
    pages = p["renderPerPage"]["pages"]
    assert len(pages) == entry["observedShape"]["pages"], f"{entry['id']} render pages {len(pages)} != {entry['observedShape']['pages']}"
    assert all(item.get("pass") is True or item.get("code") for item in pages), f"{entry['id']} render page without result"

    # recorded classifications must carry the candidate code that a user would observe
    for phase in ["validate", "pdf", "png"]:
        if p[phase].get("classified") is True:
            assert p[phase].get("code", "").startswith("NATIVE_"), f"{entry['id']} {phase} classified without native code"

rejects = [c for c in evidence["cases"] if c["id"] == "REAL-004"]
assert len(rejects) == 2 and all(c["phases"]["reject"]["ok"] for c in rejects), "raw 70216 rejects not classified"
assert all("70218" in c["phases"]["reject"]["summary"] or "Only Ipe XML format 70218" in c["phases"]["reject"].get("message", "") for c in rejects)

originals = evidence["originalsUnchanged"]
assert len(originals) == 2 and all(item["unchanged"] for item in originals), "package originals changed"
assert evidence["stderrProtocolSafe"] is True

# documentation of provenance, findings, and policy
for token in ["REAL-001", "REAL-002", "REAL-003", "REAL-004", "GPL-3+", "MIT", "Oleg Soloviev", "70216", "mode_translate", "mathpazo", "real, licensed Ipe documents", "not retained", "license", "retained-file policy", "findings"]:
    assert token in doc, f"milestone doc missing {token}"
for token in ["NATIVE_TEX_ERROR", "NATIVE_EXPORT_ERROR", "NATIVE_RENDER_ERROR", "Only Ipe XML format 70218 is supported"]:
    assert token in doc, f"milestone doc missing classification {token}"
PY

echo "M9 REAL PASS: licensed real-document review with provenance, exercise record, classifications, and unchanged originals"
