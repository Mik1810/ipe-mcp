#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
fail() { echo "M9 NOTES FAIL: $*" >&2; exit 1; }

bash "$ROOT/scripts/gates/check-m8.sh" || fail "M8 gate"
(cd "$ROOT" && npm run build) || fail "build"

python3 - "$ROOT/docs/guides/m9-release-notes.md" <<'PY' || fail "release notes audit"
import pathlib, sys
notes = pathlib.Path(sys.argv[1]).read_text()

# shipping record: candidate identity, contract, full tool surface
for token in ["0.1.0", "ipe-mcp/1", "M10", "release candidate"]:
    assert token in notes, f"release record missing {token}"
for tool in ["ipe_orientation", "ipe_get_capabilities", "ipe_create_document", "ipe_open_document", "ipe_inspect", "ipe_apply_operations", "ipe_compose_slide", "ipe_build_views", "ipe_validate", "ipe_render_preview", "ipe_save_document", "ipe_export_document", "ipe_history"]:
    assert tool in notes, f"tool missing {tool}"
for topic in ["working-copy", "RESTORE", "resource_link", "structural-only", "full-7.2.30", "nightly-7.3.x"]:
    assert topic in notes, f"delivered behavior missing {topic}"

# security limits with reference to the single stated table, not ad-hoc numbers
for token in ["core-m9-limits.md", "512 pages", "100k objects", "16 MiB", "30 s", "2 GiB", "64 MiB input"]:
    assert token in notes, f"limit summary missing {token}"

# compatibility facts and explicit support boundaries
for token in ["Ubuntu 26.04", "Node.js", "7.2.30", "70218", "texlive-latex-base", "poppler-utils", "mupdf-tools", "bubblewrap 0.11.1", "Codex", "MCP Inspector", "VS Code", "not a supported target"]:
    assert token in notes, f"compatibility missing {token}"

# known limits and M10 deferrals named, not blurred
for token in ["Known limits", "no remote or HTTP server", "No continuous animation", "not a supported target", "Deferred to M10", "Streamable HTTP", "provider-neutral agent harness"]:
    assert token in notes, f"known limits/deferral missing {token}"

# migration: config/state/sidecar/contract/rebuild; nothing claimed automatic beyond supported
for token in ["IPE_MCP_WORKSPACE_ROOT", "IPE_MCP_STATE_ROOT", "IPE_MCP_NATIVE_TIMEOUT_MS", ".ipe-mcp-state", "session.json", "snapshot-s<N>", "schemaVersion: 1", "migrateSidecar", "no automatic", "npm ci", "ipe_get_capabilities"]:
    assert token in notes, f"migration guidance missing {token}"
assert "The only automatic data transform is the deterministic v0 \u2192 v1 sidecar" in notes

# rollback: source preservation, snapshots, state dir, previous git revision
for token in ["git checkout", "revert", "snapshotId", "confirmation", "REVISION_CONFLICT", "SOURCE_CHANGED", "Recover from a failed migration or rollback"]:
    assert token in notes, f"rollback procedure missing {token}"
PY

echo "M9 NOTES PASS: release notes, migration guidance, and rollback procedure audited"
