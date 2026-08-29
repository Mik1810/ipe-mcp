# MCP Agentic-Harness Compliance

Issue #8 compliance is touch-triggered. A task applies this policy when its
changed paths or behavior affect one or more areas below; unrelated work must
record a concise not-applicable reason instead of rerunning the complete audit.

## Canonical areas and triggers

| Area | Trigger examples |
|---|---|
| `model-facing-contract` | Server instructions, tool names/descriptions, input fields, public result shapes, text/structured parity |
| `orientation-and-dynamic-behavior` | Orientation, capabilities, indexes/counts, routing, truncation, stale-client or state-aware guidance |
| `result-quality-and-recovery` | Hints, identifiers/lookups, public mappers, corrective errors, sanitization, recovery guidance |
| `permissions-and-write-safety` | Tool registration, annotations, confirmations, destructive actions, write evidence, session permissions |
| `transport-integration-and-privacy` | stdio/HTTP/auth, progress, timeouts, restart/session behavior, hosts, telemetry and secret redaction |
| `code-architecture-and-verification` | MCP/domain boundaries, facades, behavioral vocabulary, host scenarios, repository workflow or MCP gates |

When uncertain, include the area. A change may name multiple areas. The full
six-area audit is required only for a cross-cutting MCP milestone or an
explicit audit request; otherwise verify the smallest applicable surface.

## Required evidence schema

Planning or an explicitly requested task payload records:

```yaml
mcp_harness_compliance:
  applicable_areas: []
  evidence_required: []
  not_applicable_reason: null
```

Self-review, a handoff when explicitly requested, and final gate/report record:

```yaml
mcp_harness_compliance:
  applicable_areas: []
  evidence: []
  findings: []
  not_applicable_reason: null
```

Exactly one branch is used: non-empty `applicable_areas` with proportional
evidence, or an empty list with a non-empty `not_applicable_reason`. Applicable
evidence names the concrete test, command, audit row, or rationale for each
area. A finding includes its owner and target; blocking findings are corrected
before completion.

## Workflow obligations

1. **Task/plan:** classify touched areas before implementation and state the
   evidence required. Do not create a payload file solely for this rule; when
   the user explicitly requests one, use the schema above.
2. **Self-review:** recheck the actual changed paths, record applicable area
   results or findings, and do not expand into the other areas without a
   trigger.
3. **Gate/report:** run the proportional checks and explicitly report the
   applicable areas and evidence. A gate that directly exercises MCP behavior
   names its applicable areas in its retained or reported evidence.

The section-by-section baseline remains
`docs/guides/m8-agentic-harness-audit.md`. The policy gate is
`bash scripts/gates/check-mcp-harness-policy.sh`.
