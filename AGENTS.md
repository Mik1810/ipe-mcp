# Agent Operating Rules

These rules apply to every agent working in this repository.

## Primary objective

Produce correct changes while minimizing unnecessary model context, repeated repository reads, repeated test execution, and model/tool round trips.

## 1. Atomic worker lifetime

- A sub-agent owns exactly one atomic task.
- Do not reuse a sub-agent across milestones, issues, or unrelated follow-up tasks.
- Do not carry a reviewer from one milestone into the next.
- If a substantial new task appears, stop and hand it off to a fresh agent.
- At most one small follow-up is allowed after the original task. Anything larger requires a fresh worker.

## 2. Diff-first inspection

For review, verification, and follow-up work:

1. Identify the base commit or base branch.
2. Inspect `git status` and `git diff --stat` first.
3. Inspect `git diff <base>...HEAD` before opening unrelated files.
4. Read unchanged files only when the diff references a dependency or the specification requires it.
5. Never start by recursively reading the whole repository unless explicitly required.

Prefer work proportional to the change set rather than work proportional to repository size.

## 3. Tool-call efficiency

- Batch independent shell commands into one tool call whenever possible.
- Do not execute a sequence of trivial commands one at a time if they can be combined safely.
- Avoid rereading a file unless it changed or the previous read was insufficient.
- Avoid repeated `git status`, `git diff`, or equivalent checks without a reason.
- Stop exploring once enough evidence exists to complete the assigned task.

### Default tool budget

- Small task: target <= 8 tool calls.
- Normal review/gate: target <= 12 tool calls.
- Complex task: target <= 20 tool calls.

These are budgets, not correctness limits. Exceed them only when necessary and explain why in the final report.

## 4. Testing policy

During implementation:

- Run the smallest relevant targeted tests after a local change.
- Do not run the entire test suite after every micro-fix.
- Batch independent fixes before a full verification run.

During final gate:

- Run the complete required verification suite once after the final candidate is ready.
- Re-run only the failing or affected checks after a fix, then perform one final complete gate if the fix can affect global correctness.

## 5. Review policy

Reviewers are read-only.

A reviewer must:

- inspect the full relevant diff before reporting;
- collect all independent findings before returning;
- classify findings as `BLOCKER`, `MAJOR`, or `MINOR`;
- provide file/line evidence where possible;
- avoid implementing fixes;
- avoid interactive `finding -> fix -> finding -> fix` loops.

Return all findings in one batch.

## 6. Gate policy

Gate agents are read-only except for non-source temporary test artifacts when unavoidable.

A gate agent verifies, in this order:

1. final diff sanity;
2. targeted checks if needed;
3. type/lint/static checks;
4. unit/integration tests required by the repository;
5. build/package verification;
6. unresolved review findings.

Return only `PASS` or `FAIL` plus concise evidence and exact failing commands/checks.

## 7. Context discipline

- Do not depend on long conversational history when repository artifacts can carry the state.
- Persist cross-agent state in concise files or structured handoffs.
- Keep handoffs focused on current goal, base/head revisions, constraints, unresolved findings, and verification commands.
- Do not copy full prior conversations into a new agent.
- Do not include old milestone history unless it directly constrains the current task.

### Context thresholds

If context usage is observable, use these operating thresholds:

- < 80k tokens: normal operation.
- 80k-120k: finish the current atomic task; do not accept a new substantial task.
- > 120k: create a concise handoff and use a fresh worker.
- > 160k: do not continue exploratory work; hand off immediately.

If context usage is not observable, use task boundaries as the reset mechanism.

## 8. Handoff size

A handoff should normally fit in roughly 500-1500 tokens.

Include only:

- task/milestone;
- base revision and current HEAD;
- goal;
- relevant constraints/ADRs/spec sections;
- changed paths;
- unresolved findings;
- targeted verification commands;
- known caveats.

Do not include raw logs unless a specific failure requires them.

## 9. Role separation

Use separate workers for separate roles:

- Implementer: writes code and runs targeted checks.
- Reviewer: semantic/correctness review; read-only.
- Gate: final verification; read-only.

Do not assign multiple agents to repeat the same full-repository review unless independent redundancy is explicitly required.

## 10. Stop conditions

An agent must stop when:

- the assigned atomic task is complete;
- enough evidence exists for the requested conclusion;
- the task has changed materially;
- a follow-up would require substantial new repository exploration;
- the worker should be replaced by a fresh role-specific agent.

Do not continue work merely to increase confidence after the acceptance criteria are already satisfied.
