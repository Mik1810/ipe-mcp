#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/gates/m9-common.sh"
fail() { echo "M9 LIMITS FAIL: $*" >&2; exit 1; }

m9_require_m8 "$ROOT" || fail "M8 gate"
(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && npm test -- --run tests/limits tests/mcp/contracts.test.ts) || fail "boundary and public-contract tests"

python3 - "$ROOT" <<'PY' || fail "single-source limit audit"
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
doc = (root / "docs/milestones/core-m9-limits.md").read_text(encoding="utf-8")
source = (root / "src/limits.ts").read_text(encoding="utf-8")
orientation = (root / "src/mcp/service.ts").read_text(encoding="utf-8")
for heading in ["Document shape", "XML parse", "Native", "LaTeX", "Assets", "Animation", "Persistence", "Resource store", "MCP contract", "Layout sidecar", "Enforcement points"]:
    assert heading in doc, f"limits contract missing {heading}"
for symbol in ["DOCUMENT_SHAPE_LIMITS", "XML_PARSE_DEFAULT_LIMITS", "NATIVE_PROCESS_LIMITS", "NATIVE_OPERATION_LIMITS", "BITMAP_DEFAULT_LIMITS", "ANIMATION_DEFAULT_LIMITS", "PERSISTENCE_LIMITS", "RESOURCE_STORE_LIMITS", "MCP_LIMITS", "MODEL_TEXT_CAPS", "LAYOUT_CAPS"]:
    assert symbol in source, f"central limits table missing {symbol}"
server = (root / "src/mcp/server.ts").read_text(encoding="utf-8")
assert "limits:" in server and "MCP_LIMITS" in server and "DOCUMENT_SHAPE_LIMITS" in server, "orientation does not expose central limits"
PY

echo "M9 LIMITS PASS: central limits, boundary-plus-one enforcement, rollback, and public orientation contract"
