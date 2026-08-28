# Compact Handoff Format

Use compact handoffs between roles. Prefer 500-1500 tokens and usually less.

```yaml
kind: agent-handoff
milestone: M#
issue: "#123"
role_completed: implementer|reviewer|corrector|finding-verifier|integration-verifier|gate
base_revision: <sha>
candidate_digest: <git-index-tree-sha-or-null>

objective: >-
  <one short sentence>

acceptance_status:
  - criterion: <criterion>
    status: pending|pass|fail

review_findings:
  - id: R1
    severity: BLOCKER|MAJOR|MINOR|DEFERRED
    status: open|fixed|verified|deferred
    summary: <short>

verification:
  passed: []
  failed: []

integration_evidence:
  candidate_digest: null
  deterministic_interface: null
  browser_smoke: null
  summary: []

changed_paths: []
deferred_backlog: []
blockers: []
next_role: reviewer|corrector|finding-verifier|integration-verifier|gate|done
```

Do not include raw successful logs, old transcripts, or historical discussion.
