#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
fail() { echo "MCP HARNESS POLICY FAIL: $*" >&2; exit 1; }

python3 - "$ROOT" <<'PY' || fail "durable policy/schema audit"
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
policy = (root / ".agents/MCP_HARNESS_COMPLIANCE.md").read_text(encoding="utf-8")
agents = (root / "AGENTS.md").read_text(encoding="utf-8")
workflow = (root / ".agents/WORKFLOW.md").read_text(encoding="utf-8")
task = (root / "scripts/agent/new-task-payload.sh").read_text(encoding="utf-8")
handoff = (root / "scripts/agent/new-handoff.sh").read_text(encoding="utf-8")
audit = (root / "docs/audits/agentic-harness-audit.md").read_text(encoding="utf-8")
check_m9 = (root / "scripts/check-m9.sh").read_text(encoding="utf-8")

areas = [
    "model-facing-contract",
    "orientation-and-dynamic-behavior",
    "result-quality-and-recovery",
    "permissions-and-write-safety",
    "transport-integration-and-privacy",
    "code-architecture-and-verification",
]
rows = [line for line in policy.splitlines() if re.match(r"^\| `[^`]+` \|", line)]
assert [row.split("`")[1] for row in rows] == areas, "canonical area table drift"
for area in areas:
    assert policy.count(f"`{area}`") == 1, f"area is missing or duplicated: {area}"

for text, name in [(agents, "AGENTS.md"), (workflow, "WORKFLOW.md")]:
    assert "MCP_HARNESS_COMPLIANCE.md" in text, f"{name} does not route to the policy"
    for token in ["applicable_areas", "evidence_required", "not_applicable_reason", "self-review"]:
        assert token in text, f"{name} missing {token} obligation"
for text, name, fields in [
    (task, "task payload", ["applicable_areas", "evidence_required", "not_applicable_reason"]),
    (handoff, "review/handoff", ["applicable_areas", "evidence", "findings", "not_applicable_reason"]),
]:
    assert "mcp_harness_compliance:" in text, f"{name} missing compliance block"
    for field in fields:
        assert re.search(rf"^  {field}:", text, re.MULTILINE), f"{name} missing {field}"

assert "check-mcp-harness-policy.sh" in check_m9, "M9 gate does not retain the policy check"
assert audit.count("| PASS |") == 24 and audit.count("| NOT APPLICABLE |") == 7
assert "DEFERRED M9: 0" in audit
PY

echo "MCP HARNESS POLICY PASS [code-architecture-and-verification]: touch triggers, payload schema, bounded self-review, gate evidence, and inherited 31-row audit"
