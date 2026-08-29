#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
M9_DOD_TMP=$(mktemp -d)
trap 'rm -rf "$M9_DOD_TMP"' EXIT
fail() { echo "M9 DOD FAIL: $*" >&2; exit 1; }
CANDIDATE_SOURCE=5dbaca8a76665ba47ebcbc4305bbf68ed6434e10
CANDIDATE_TREE=$(cd "$ROOT" && git rev-parse "$CANDIDATE_SOURCE^{tree}") || fail "resolve frozen candidate tree"
(cd "$ROOT" && git merge-base --is-ancestor "$CANDIDATE_SOURCE" HEAD) || fail "frozen candidate source is not an ancestor of HEAD"

(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && npm test -- --run \
  tests/persistence/session-manager.test.ts \
  tests/persistence/atomic.test.ts \
  tests/composition/m5.test.ts \
  tests/layout/geometry-matrix.test.ts \
  tests/layout/layout.test.ts \
  tests/layout/golden.test.ts \
  tests/mcp/service.test.ts \
  tests/objects/roundtrip.test.ts \
  tests/objects/path.test.ts \
  tests/objects/crud-builders.test.ts \
  tests/animation/m7.test.ts \
  tests/ipe/xml.test.ts \
  tests/native/adapter.test.ts \
  --no-file-parallelism --maxWorkers=1 --testTimeout=30000) || fail "current-candidate focused tests"

(cd "$ROOT" && node scripts/host/m9-agent-workflow.mjs "$M9_DOD_TMP/m9-workflow") >"$M9_DOD_TMP/m9-workflow.json" || fail "M9 official-SDK workflow"
(cd "$ROOT" && node scripts/host/m8-sdk-host.mjs "$M9_DOD_TMP/m8-sdk-host") >"$M9_DOD_TMP/m8-sdk-host.json" || fail "independent official-SDK host"

for fixture in reveal motion panel-scroll camera-pan; do
  views=$(python3 - "$ROOT/fixtures/conformance/m7/manifest.json" "$fixture" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
key = {"panel-scroll": "panelScroll", "camera-pan": "cameraPan"}.get(sys.argv[2], sys.argv[2])
print(manifest["fixtures"][key]["views"])
PY
  )
  for ((view=1; view<=views; view++)); do
    iperender -svg -nocrop -page 1 -view "$view" "$ROOT/fixtures/conformance/m7/corpus/$fixture.ipe" "$M9_DOD_TMP/$fixture-view-$view.svg" >/dev/null 2>&1 || fail "render $fixture view $view"
  done
done
for fixture in panel-scroll camera-pan; do
  for view in 1 2 3; do
    rendered="$M9_DOD_TMP/$fixture-view-$view.png"
    golden="$ROOT/fixtures/conformance/m7/golden/$fixture-view-$view.png"
    iperender -png -nocrop -page 1 -view "$view" "$ROOT/fixtures/conformance/m7/corpus/$fixture.ipe" "$rendered" >/dev/null 2>&1 || fail "visual render $fixture view $view"
    cmp "$rendered" "$golden" >/dev/null || fail "visual golden $fixture view $view"
  done
  [[ "$(sha256sum "$M9_DOD_TMP/$fixture-view-"*.png | awk '{print $1}' | sort -u | wc -l)" == 3 ]] || fail "$fixture views are not visually distinct"
done

python3 - "$ROOT" "$M9_DOD_TMP" "$CANDIDATE_SOURCE" "$CANDIDATE_TREE" <<'PY' || fail "evidence matrix audit"
import hashlib
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
temporary = pathlib.Path(sys.argv[2])
source_revision = sys.argv[3]
candidate_tree = sys.argv[4]
doc_path = root / "docs/milestones/core-m9-dod.md"
doc = doc_path.read_text(encoding="utf-8")
current = "4090c820c72b866a1f7c242693075a6bc52e94d2"
old = "b35d7c398613542d8aa3fc4160c5b799dd6936c7"

assert source_revision == "5dbaca8a76665ba47ebcbc4305bbf68ed6434e10"
assert source_revision in doc, "matrix lacks immutable candidate source revision"
assert candidate_tree == current, f"documented candidate {current} != source-revision tree {candidate_tree}"
rows = [line for line in doc.splitlines() if re.match(r"^\| DOD-\d{2} \|", line)]
assert len(rows) == 10, f"expected ten DoD rows, found {len(rows)}"
assert [re.match(r"^\| (DOD-\d{2}) \|", row).group(1) for row in rows] == [f"DOD-{index:02d}" for index in range(1, 11)]
for row in rows:
    assert current in row, f"row lacks current candidate identity: {row[:24]}"
    assert "CURRENT:" in row, f"row maps only to documentation/history: {row[:24]}"
    assert "| PASS" in row, f"row is not passing: {row[:24]}"
assert "HISTORICAL ONLY" in rows[-1] and old in rows[-1]
assert "were not rerun" in rows[-1] and "not claimed as current-candidate evidence" in rows[-1]

references = sorted(set(re.findall(r"`(?:(?:node|bash) )?((?:tests|scripts|fixtures)/[^` ]+\.(?:ts|mjs|sh|json))(?: ABSOLUTE_TEMP_DIR)?`", doc)))
assert references, "matrix has no machine-readable evidence references"
for reference in references:
    path = root / reference
    assert path.is_file(), f"referenced evidence file is missing: {reference}"
    if reference.endswith(".sh"):
        assert path.stat().st_mode & 0o111, f"referenced gate is not executable: {reference}"

def final_json(name):
    lines = (temporary / name).read_text(encoding="utf-8").splitlines()
    candidates = [json.loads(line) for line in lines if line.strip().startswith("{")]
    assert candidates, f"{name} has no bounded JSON evidence line"
    return candidates[-1]

m9 = final_json("m9-workflow.json")
assert m9["manual"] == "m9-agent-manual-v1"
assert m9["sections"] >= 18 and m9["resourcesRead"] == 3 and m9["stderrProtocolSafe"] is True
for field in ["open", "layout", "staleRollback", "undoRestore", "fullValidation", "save", "recover"]:
    assert m9[field] == "PASS", f"M9 workflow failed {field}"

m8 = final_json("m8-sdk-host.json")
assert m8["host"] == "official-typescript-sdk" and m8["protocol"] == "stdio" and m8["scenario"] == "portable-m8-v1"
assert m8["resourcesRead"] == 3 and m8["stderrProtocolSafe"] is True
for field in ["staleRollback", "undoRestore", "fullValidation"]:
    assert m8[field] == "PASS", f"independent host failed {field}"

historical = json.loads((root / "fixtures/conformance/m8/host-evidence.json").read_text(encoding="utf-8"))
inspector = next(host for host in historical["hosts"] if host["host"] == "mcp-inspector")
codex = next(host for host in historical["hosts"] if host["host"] == "codex-cli")
assert inspector["candidateDigest"] == old and inspector["result"] == codex["result"] == "PASS"
assert old != current

signature = {
    "walkthrough.ipe": b"<?xml",
    "walkthrough-preview.png": bytes([137, 80, 78, 71, 13, 10, 26, 10]),
    "walkthrough.pdf": b"%PDF-",
    "walkthrough.png": bytes([137, 80, 78, 71, 13, 10, 26, 10]),
    "portable-scenario.ipe": b"<?xml",
    "portable-scenario-preview.png": bytes([137, 80, 78, 71, 13, 10, 26, 10]),
    "portable-scenario.pdf": b"%PDF-",
    "portable-scenario.png": bytes([137, 80, 78, 71, 13, 10, 26, 10]),
}
hashes = {}
for directory in [temporary / "m9-workflow", temporary / "m8-sdk-host"]:
    for path in sorted(directory.iterdir()):
        if path.name == ".state":
            continue
        data = path.read_bytes()
        assert path.name in signature, f"unexpected generated artifact: {path.name}"
        assert len(data) > 0 and data.startswith(signature[path.name]), f"invalid artifact: {path.name}"
        digest = hashlib.sha256(data).hexdigest()
        assert re.fullmatch(r"[0-9a-f]{64}", digest)
        hashes[f"{directory.name}/{path.name}"] = {"bytes": len(data), "sha256": digest}
assert len(hashes) == 8
assert m8["artifacts"]["ipeBytes"] == hashes["m8-sdk-host/portable-scenario.ipe"]["bytes"]
assert m8["artifacts"]["pdfBytes"] == hashes["m8-sdk-host/portable-scenario.pdf"]["bytes"]
assert m8["artifacts"]["pngBytes"] == hashes["m8-sdk-host/portable-scenario.png"]["bytes"]

retained = doc + (root / "scripts/gates/check-m9-dod.sh").read_text(encoding="utf-8")
for forbidden in ["/" + "home/", "/" + "mnt/", "Bearer" + " ", "token" + "=", "password" + "=", "PRIVATE" + " KEY"]:
    assert forbidden not in retained, f"private path or secret marker retained: {forbidden}"
assert doc_path.stat().st_size < 32 * 1024
assert (root / "scripts/gates/check-m9-dod.sh").stat().st_size < 32 * 1024
PY

echo "M9 DOD PASS: ten current-candidate workflows, two official-SDK stdio runs, bounded artifact hashes, historical host provenance, and private cleanup"
