#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/gates/m9-common.sh"
M9_MANUAL_TMP=$(mktemp -d)
trap 'rm -rf "$M9_MANUAL_TMP"' EXIT
fail() { echo "M9 MANUAL FAIL: $*" >&2; exit 1; }

m9_require_m8 "$ROOT" || fail "M8 gate"
(cd "$ROOT" && npm run build) || fail "build"

# Every example in docs/guides/m9-agent-manual.md is exercised against the candidate.
(cd "$ROOT" && node scripts/host/m9-agent-workflow.mjs "$M9_MANUAL_TMP/manual") > "$M9_MANUAL_TMP/evidence.json" || fail "agent workflow exercise"

python3 - "$M9_MANUAL_TMP/evidence.json" "$ROOT/docs/guides/m9-agent-manual.md" <<'PY' || fail "manual evidence audit"
import json, pathlib, sys
evidence = json.loads([line for line in open(sys.argv[1]) if line.strip().startswith('{')][-1])
manual = pathlib.Path(sys.argv[2]).read_text()
assert evidence["manual"] == "m9-agent-manual-v1"
assert evidence["open"] == evidence["layout"] == evidence["staleRollback"] == evidence["undoRestore"] == evidence["fullValidation"] == evidence["save"] == evidence["recover"] == "PASS"
assert evidence["sections"] >= 18 and evidence["resourcesRead"] == 3 and evidence["stderrProtocolSafe"] is True
for token in ["ipe_orientation", "ipe_get_capabilities", "ipe_create_document", "ipe_open_document", "ipe_inspect", "ipe_apply_operations", "layout_objects", "ipe_compose_slide", "ipe_build_views", "ipe_validate", "ipe_render_preview", "ipe_save_document", "ipe_export_document", "ipe_history"]:
    assert token in manual, f"manual missing {token}"
for topic in ["16:9", "z-order", "revision", "confirmation", "REVISION_CONFLICT", "NATIVE_TIMEOUT", "structural-only", "recover"]:
    assert topic in manual, f"manual missing topic {topic}"
PY

echo "M9 MANUAL PASS: complete agent manual + end-to-end workflow exercise (create/open/inspect/edit/layout/validate/render/save/export/history/recover)"
