# Efficient Milestone Workflow

Use this lifecycle for each milestone or issue.

```text
MAIN / IMPLEMENTER
    |
    | implement complete atomic task
    | targeted tests
    v
candidate diff
    |
    v
FRESH REVIEWER (read-only)
    |
    | complete diff review
    | all findings in one batch
    v
review report
    |
    v
MAIN / IMPLEMENTER
    |
    | batch ALL accepted fixes
    | targeted tests
    v
final candidate
    |
    v
FRESH GATE (read-only)
    |
    | final checks once
    v
PASS / FAIL
```

## Mandatory invariants

1. No worker crosses a milestone boundary.
2. Reviewer and gate are fresh workers.
3. Reviewer is read-only.
4. Gate is read-only.
5. Findings are batched.
6. Fixes are batched.
7. Full verification is not run after every micro-fix.
8. Review starts from the diff, not from a repository-wide scan.
9. Cross-worker state is passed through compact handoffs.
10. A completed worker terminates instead of waiting for future tasks.

## Recommended model allocation

Use the cheapest model/reasoning level that reliably satisfies the role:

- routine implementation: normal/high reasoning;
- targeted testing/gate: normal reasoning unless failures are complex;
- semantic review: high reasoning;
- architecture/security/concurrency audit: strongest model/high reasoning;
- exceptional final audit only: maximum reasoning.

Do not spend maximum reasoning on mechanical test execution or trivial repository inspection.
