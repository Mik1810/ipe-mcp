# Convergent Milestone Workflow

Use this finite lifecycle for each milestone/issue.

```text
ORCHESTRATOR
    |
    v
FRESH IMPLEMENTER
    |
    | coherent patch batches + targeted tests
    v
stage intended candidate
    |
    | freeze C0
    v
ONE FRESH GENERAL REVIEWER
    |
    | finite findings set F
    +-------------------------------+
    | no blocking findings          | accepted BLOCKER/MAJOR findings
    |                               v
    |                         FRESH CORRECTOR
    |                               |
    |                               | batch accepted fixes
    |                               | targeted verification
    |                               v
    |                         stage intended candidate
    |                               |
    |                               | freeze C1
    |                               v
    |                      FRESH FINDING VERIFIER
    |                      verifies only F
    |                               |
    |                    +----------+----------+
    |                    | PASS                | unresolved F
    |                    |                     v
    |                    |               bounded correction
    |                    |                     |
    |                    |                     +-> verify only unresolved F
    +--------------------+
                         |
                         v
          INTEGRATION_REQUIRED?
              |               |
             yes              no
              |               |
              v               |
     FRESH INTEGRATION        |
        VERIFIER              |
              |               |
              | CLI/protocol-first deterministic workflow
              | minimal browser/UI smoke only when required
              | mandatory cheap preflight
              v               |
          integration PASS    |
              |               |
              +-------+-------+
                      |
                      v
                  GATE_READY
                      |
                      v
              FRESH FINAL GATE
                      |
              +-------+-------+
              |               |
             PASS            FAIL
              |               |
              v               v
        CLOSE / DONE   bounded correction for
                       concrete failed check
                       -> freeze -> fresh gate
```

## Mandatory invariants

1. One atomic role/task per worker.
2. Every worker gets an explicit non-empty payload.
3. No source-changing worker runs concurrently with reviewer/finding-verifier/integration-verifier/gate on the same candidate.
4. Read-only roles operate on a frozen staged candidate digest.
5. No unstaged tracked changes are allowed at freeze/review/finding-verifier/integration-verifier/gate boundaries.
6. At most one general review per milestone by default.
7. Review findings are returned as one finite set.
8. Corrections batch all accepted blocking findings.
9. After correction, a finding verifier checks only that finite set.
10. New non-critical/out-of-scope observations during verification are deferred, not used to reopen review.
11. Final gate checks acceptance; it is not another adversarial review.
12. Gate failure produces a bounded correction task, not a new general review.
13. Related fixes target <= 3 patch rounds.
14. Failed checks trigger one diagnostic bundle before correction.
15. Cross-worker state is compact and repository-local.
16. Complete deterministic integration workflows use CLI/protocol/test harness where available.
17. Browser automation is limited to client-specific smoke; target <= 10 rounds, <= 15 unless UI behavior is itself in scope.
18. Long integration scenarios require a cheap environment/capability preflight first.
19. Failed long integration scenarios are not blindly replayed; preflight must pass before one bounded retry.
20. Workers above the context handoff threshold do not begin a new phase.

## Exceptional second general review

Only when explicitly justified by material scope/redesign change or explicit redundant-review request. Record the reason before spawning it.
