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
python3 - "$ROOT" "$M9_REAL_TMP/evidence.json" <<'PY' || fail "real-document review audit"
import hashlib, json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
fixtures = root / "fixtures/conformance/m9/real"
manifest = json.loads((fixtures / "manifest.json").read_text())
evidence = json.loads((fixtures / "evidence.json").read_text())
live = json.loads(pathlib.Path(sys.argv[2]).read_text())
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

# The archive records one run; compare behavioral evidence, not its capture
# date, generated identities, output hashes, or diagnostic prose.
assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", live["capturedAt"]), "missing live capture date"
for key in ["scenario", "milestone", "subissue", "contract", "reviewSums", "originalsUnchanged", "stderrProtocolSafe"]:
    assert live[key] == evidence[key], f"real-document run changed {key}"
assert [(c["id"], c["name"]) for c in live["cases"]] == [(c["id"], c["name"]) for c in evidence["cases"]], "case coverage changed"

def check_native(recorded, actual, label, success="ok"):
    if actual.get(success) is True:
        return True
    assert recorded.get(success) is not True, f"{label} regressed from pass"
    assert actual.get(success) is False and actual["code"].startswith("NATIVE_") and actual["code"] == recorded["code"], f"{label} classification changed"
    if success == "ok":
        assert actual.get("classified") is True, f"{label} failure not classified"
    return False

for recorded, actual in zip(evidence["cases"], live["cases"]):
    case = actual["id"]
    before, after = recorded["phases"], actual["phases"]
    if case == "REAL-004":
        rejection = after["reject"]
        assert rejection["ok"] is True and rejection["code"] == before["reject"]["code"], "raw 70216 classification changed"
        assert "Only Ipe XML format 70218 is supported" in rejection.get("summary", "") + rejection.get("message", ""), "raw 70216 format diagnostic missing"
        continue
    assert actual["originalSha256"] == recorded["originalSha256"], f"{case} original hash changed"
    assert actual["derived"]["rootVersion"] == "70218", f"{case} derived format changed"
    if case == "REAL-003":
        assert actual["derived"]["sha256"] == actual["originalSha256"], "vendored native fixture was modified"
    for item in [actual["derived"], after["saveCopy"]]:
        assert item["bytes"] > 0 and re.fullmatch(r"[0-9a-f]{64}", item["sha256"]), f"{case} artifact evidence missing"
    for phase in ["open", "inspect", "reopen"]:
        assert after[phase] == before[phase], f"{case} {phase} changed"
    for phase, keys in [("edit", ["ok", "op", "revision"]), ("saveCopy", ["ok", "revision"])]:
        assert all(after[phase][key] == before[phase][key] for key in keys), f"{case} {phase} changed"

    if check_native(before["validate"], after["validate"], f"{case} validate"):
        assert isinstance(after["validate"]["diagnosticCount"], int) and after["validate"]["diagnosticCount"] > 0
    if check_native(before["pdf"], after["pdf"], f"{case} pdf"):
        assert after["pdf"]["resources"] > 0 and after["pdf"]["bytes"] > 0 and after["pdf"]["header"].startswith("%PDF-")
    if check_native(before["png"], after["png"], f"{case} png"):
        assert after["png"]["resources"] > 0 and all(after["png"]["first"][key] > 0 for key in ["width", "height"])

    previous_pages = before["renderPerPage"]["pages"]
    rendered = after["renderPerPage"]
    assert len(rendered["pages"]) == len(previous_pages) == after["inspect"]["pageCount"], f"{case} render coverage changed"
    assert len({page["pageId"] for page in rendered["pages"]}) == len(previous_pages), f"{case} duplicate render evidence"
    passed = sum(check_native(old, new, f"{case} render page {i}", "pass") for i, (old, new) in enumerate(zip(previous_pages, rendered["pages"]), 1))
    assert rendered["pass"] == passed and rendered["classified"] == len(previous_pages) - passed, f"{case} inconsistent render totals"

# documentation of provenance, findings, and policy
for token in ["REAL-001", "REAL-002", "REAL-003", "REAL-004", "GPL-3+", "MIT", "Oleg Soloviev", "70216", "mode_translate", "mathpazo", "real, licensed Ipe documents", "not retained", "license", "retained-file policy", "findings"]:
    assert token in doc, f"milestone doc missing {token}"
for token in ["NATIVE_TEX_ERROR", "NATIVE_EXPORT_ERROR", "NATIVE_RENDER_ERROR", "Only Ipe XML format 70218 is supported"]:
    assert token in doc, f"milestone doc missing classification {token}"
PY

echo "M9 REAL PASS: licensed real-document review with provenance, exercise record, classifications, and unchanged originals"
