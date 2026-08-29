#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
M9_CANDIDATE_GATE_TMP=$(mktemp -d)
trap 'rm -rf "$M9_CANDIDATE_GATE_TMP"' EXIT
fail() { echo "M9 CANDIDATE FAIL: $*" >&2; exit 1; }

(cd "$ROOT" && node scripts/tools/m9-release-candidate.mjs "$M9_CANDIDATE_GATE_TMP/records") || fail "candidate reproduction"

python3 - "$M9_CANDIDATE_GATE_TMP/records" <<'PY' || fail "manifest/evidence audit"
import json, pathlib, re, sys

records = pathlib.Path(sys.argv[1])
assert sorted(item.name for item in records.iterdir()) == ["evidence.json", "manifest.json"]
manifest = json.loads((records / "manifest.json").read_text())
evidence = json.loads((records / "evidence.json").read_text())

assert manifest["schemaVersion"] == evidence["schemaVersion"] == 1
assert manifest["milestone"] == evidence["milestone"] == "M9"
assert manifest["subissue"] == evidence["subissue"] == 21
candidate = manifest["candidate"]
assert candidate["identity"] == "git-staged-tree-sha1"
assert re.fullmatch(r"[0-9a-f]{40}", candidate["tree"])
assert re.fullmatch(r"[0-9a-f]{40}", candidate["sourceRevision"])
assert candidate["tree"] == evidence["candidateTree"]
assert candidate["trackedWorktreeMatchesIndex"] is True
assert candidate["untrackedNonIgnoredFiles"] == 0

assert manifest["baseline"] == {"platform": "Ubuntu 26.04 WSL", "ipe": "7.2.30", "xmlFormat": 70218, "node": ">=20"}
assert manifest["dependencyLock"]["lockfileVersion"] == 3
assert re.fullmatch(r"[0-9a-f]{64}", manifest["dependencyLock"]["sha256"])
assert manifest["toolchain"]["packages"]["ipe"].startswith("7.2.30")

required = {"frozen-tree-extract", "clean-install", "build", "stable-suite", "agent-workflow", "bounded-artifacts", "cleanup"}
assert {item["id"] for item in manifest["checks"]} == required
assert {item["id"] for item in evidence["checks"]} == required
assert all(item["result"] == "PASS" for item in evidence["checks"])
assert evidence["result"] == "PASS"
assert evidence["cleanup"] == {"temporaryRoot": "PASS", "retainedRecordsOnly": True}

artifacts = manifest["artifacts"]
assert artifacts == evidence["artifacts"] and len(artifacts) == 4
assert {item["name"] for item in artifacts} == {"walkthrough.ipe", "walkthrough-preview.png", "walkthrough.pdf", "walkthrough.png"}
assert all(item["bytes"] > 0 and re.fullmatch(r"[0-9a-f]{64}", item["sha256"]) for item in artifacts)

serialized = (records / "manifest.json").read_text() + (records / "evidence.json").read_text()
for forbidden in ["/home/", "/mnt/", "/tmp/", "node_modules/", "Bearer ", "token=", "password"]:
    assert forbidden not in serialized, f"private or implicit state retained: {forbidden}"
assert manifest["retention"]["retained"] == ["manifest.json", "evidence.json"]
PY

echo "M9 CANDIDATE PASS: staged-tree identity, clean frozen checkout, reproducible records, bounded hashes, and complete cleanup"
