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
    v                               v
GATE_READY                    FRESH CORRECTOR
                                    |
                                    | batch all accepted fixes
                                    | targeted verification
                                    v
                              stage intended candidate
                                    |
                                    | freeze C1
                                    v
                           FRESH FINDING VERIFIER
                           verifies only F
                                    |
                         +----------+----------+
                         | PASS                | unresolved F
                         v                     v
                     GATE_READY          bounded correction
                                              |
                                              +-> verify only unresolved F

GATE_READY
    |
    v
FRESH FINAL GATE
    |
    +---- PASS -> CLOSE ISSUE / DONE
    |
    +---- FAIL -> bounded correction for concrete failed check
                 -> freeze new candidate -> fresh final gate
```

## Mandatory invariants

1. One atomic role/task per worker.
2. Every worker gets an explicit non-empty payload.
3. No source-changing worker runs concurrently with reviewer/verifier/gate on the same candidate.
4. Read-only roles operate on a frozen staged candidate digest.
5. No unstaged tracked changes are allowed at freeze/review/verifier/gate boundaries.
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

## Exceptional second general review

Only when explicitly justified by material scope/redesign change or explicit redundant-review request. Record the reason before spawning it.
