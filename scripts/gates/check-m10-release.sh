#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
M10_RELEASE_TMP=$(mktemp -d)
trap 'rm -rf "$M10_RELEASE_TMP"' EXIT
fail() { echo "M10 RELEASE FAIL: $*" >&2; exit 1; }

(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && node scripts/release/release-candidate.mjs prepare "$M10_RELEASE_TMP/candidate") || fail "prepare candidate"
(cd "$ROOT" && node scripts/release/release-candidate.mjs verify "$M10_RELEASE_TMP/candidate") || fail "verify candidate"

python3 - "$ROOT" "$M10_RELEASE_TMP/candidate/release-manifest.json" <<'PY' || fail "workflow and release policy audit"
import json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads(pathlib.Path(sys.argv[2]).read_text())
workflow = (root / ".github/workflows/release-candidate.yml").read_text()
notes = (root / f"docs/releases/v{manifest['version']}.md").read_text()
guide = (root / "docs/guides/release-bootstrap.md").read_text()

assert manifest["package"] == "ipe-mcp" and manifest["version"] == "1.0.0-rc.1"
assert manifest["tag"] == "v1.0.0-rc.1" and manifest["distTag"] == "next"
assert manifest["publication"] == {"requiresExplicitOwnerApproval": True, "bootstrapCredentialRetained": False}
assert re.fullmatch(r"[0-9a-f]{40}", manifest["source"]["revision"])
assert re.fullmatch(r"[0-9a-f]{40}", manifest["source"]["tree"])
for key in ["sha1", "sha256", "sha512"]:
    assert re.fullmatch(r"[0-9a-f]+", manifest["tarball"][key])

required_workflow = [
    "workflow_dispatch:", "default: verify-only", "stage-publish", "finalize-release", "runs-on: ubuntu-26.04",
    "permissions:\n  contents: read", "environment: npm-release", "contents: write", "id-token: write",
    "persist-credentials: false", "npm run check:m10:package", "npm run check:m10:release", "npm stage publish", "--access public --tag next --provenance",
    "--verify-tag", "--prerelease", "cancel-in-progress: false", "npm audit signatures",
]
for token in required_workflow:
    assert token in workflow, f"release workflow missing {token}"
for forbidden in ["pull_request_target", "schedule:", "push:\n", "npm publish .", "run: npm publish", "--tag latest", "NODE_AUTH_TOKEN", "secrets.NPM_TOKEN", "bootstrap-publish"]:
    assert forbidden not in workflow, f"unsafe automatic publication trigger/command: {forbidden}"
stage_job = workflow.split("\n  stage:\n", 1)[1].split("\n  finalize:\n", 1)[0]
finalize_job = workflow.split("\n  finalize:\n", 1)[1]
assert "contents: read" in stage_job and "id-token: write" in stage_job and "contents: write" not in stage_job
assert "contents: write" in finalize_job and "id-token: write" not in finalize_job and "npm stage publish" not in finalize_job
for action, digest in {
    "actions/checkout": "d23441a48e516b6c34aea4fa41551a30e30af803",
    "actions/setup-node": "249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
    "actions/download-artifact": "018cc2cf5baa6db3ef3c5f8a56943fffe632ef53",
}.items():
    assert f"{action}@{digest}" in workflow, f"unpinned or missing action {action}"
release_script = (root / "scripts/release/release-candidate.mjs").read_text()
for token in ["refs/remotes/origin/main", "release workflow requires an annotated Git tag", "release artifact source does not match the checked-out revision"]:
    assert token in release_script, f"release source/ref guard missing {token}"
registry_script = (root / "scripts/release/verify-registry.mjs").read_text()
for token in ["versions", "stableVersions", "bootstrapLatest", "after a stable release exists"]:
    assert token in registry_script, f"registry bootstrap/latest guard missing {token}"
for token in ["ipe-mcp", "1.0.0-rc.1", "ipe-mcp/1", "Ubuntu 26.04 WSL2", "npm install", "rollback", "not published"]:
    assert token in notes, f"release notes missing {token}"
for token in ["verify-only", "npm-release", "v1.0.0-rc.1", "NPM_TOKEN", "2FA", "bypass-2FA", "stage publish", "delete", "revoke", "explicit owner authorization"]:
    assert token in guide, f"release bootstrap guide missing {token}"
PY

echo "M10 RELEASE MCP HARNESS: permissions-and-write-safety, transport-integration-and-privacy, code-architecture-and-verification"
echo "M10 RELEASE PASS: inert verify-only default, bounded candidate manifest, pinned Actions, isolated stage-only OIDC and finalize paths; no tag or publication"
