#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
fail() { echo "M9 SUPPORT FAIL: $*" >&2; exit 1; }

bash "$ROOT/scripts/gates/check-m8.sh" || fail "M8 gate"
(cd "$ROOT" && npm run build) || fail "build"

python3 - "$ROOT/docs/guides/support-policy.md" "$ROOT/docs/reference/compatibility-modes.md" "$ROOT/docs/reference/viewer-effects-m7.md" <<'PY' || fail "support policy audit"
import pathlib, sys
policy = pathlib.Path(sys.argv[1]).read_text()
modes = pathlib.Path(sys.argv[2]).read_text()
viewer = pathlib.Path(sys.argv[3]).read_text()

# mode terminology present without promoting 7.3.x as an MVP target
for mode in ["structural-only", "full-7.2.30", "nightly-7.3.x"]:
    assert mode in policy, f"mode {mode} missing"
assert "Supports no macOS/Windows/non-WSL target" in policy and "never claims full-7.2.30" in policy

# platform / Node / Ipe / TeX / renderer / exporter / viewer / resource / host expectations
for token in ["Ubuntu 26.04", "Node.js", "Ipe", "TeX", "poppler-utils", "mupdf-tools", "viewer-effects-m7.md", "resource_link", "Codex", "MCP Inspector"]:
    assert token in policy, f"expectations missing {token}"

# each mode says what it supports/degrades/verifies (concrete statements)
assert "This document" in policy and "does not add support" in policy
for phrase in ["Supported", "Degraded", "Warn", "Reject"]:
    assert phrase in policy, f"semantic column {phrase} missing"

# viewer/transition conservatism stays bounded
assert "viewer-dependent effects" in policy and "never for a viewer-dependent" in policy

# boundaries
for boundary in ["no macOS", "no HTTP", "not a legal"]:
    assert boundary in policy, f"boundary {boundary} missing"
PY

echo "M9 SUPPORT PASS: complete support policy with mode/expectation/failure semantics matrices, viewer conservatism, and explicit boundaries"
