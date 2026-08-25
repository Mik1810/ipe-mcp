# Compact Handoff Template

Use this template when moving work to a fresh agent.

```yaml
kind: agent-handoff
milestone: "<M# or task id>"
role_completed: "<implementer|reviewer|gate>"
base_revision: "<sha/branch>"
head_revision: "<sha>"

goal: >-
  <one short paragraph>

relevant_constraints:
  - "<requirement / ADR / invariant>"

changed_paths:
  - "<path>"

findings:
  blockers: []
  majors: []
  minors: []

verification:
  passed:
    - "<command/check>"
  failed: []
  recommended_next:
    - "<targeted command/check>"

caveats:
  - "<only if relevant>"

next_role: "<reviewer|implementer|gate|done>"
```

## Rules

- Prefer 500-1500 tokens total.
- Never paste complete prior conversations.
- Never paste large successful test logs.
- Include only failures that matter to the next worker.
- Reference files/commits instead of reproducing their entire contents.
