# Agent Operating Rules

These rules apply to every agent working in this repository.

## Primary objective

Produce correct milestone-sized changes with bounded context, bounded tool/model round trips, and a workflow that **converges to closure**.

Correctness has priority over efficiency budgets. However, open-ended exploration, repeated general reviews, and repeated full-suite execution are not acceptable substitutes for a finite acceptance process.

## 1. Atomic worker lifetime

- A worker owns exactly one atomic role/task.
- Do not reuse a worker across milestones, issues, or role transitions.
- Do not carry an implementer into review, a reviewer into correction, or a verifier into a new review.
- At most one small clarification may be sent to a completed worker. Substantial follow-up requires a fresh worker.
- When the assigned task is complete, report and terminate.

## 2. Explicit non-empty task payload

Every fresh worker must receive an explicit compact payload. Do not spawn repository workers with an empty `Payload:` when the parent can state the task.

Include, when applicable:

- milestone / issue identifier;
- role;
- exact atomic goal;
- base revision;
- candidate digest for read-only roles;
- acceptance criteria;
- relevant docs / ADRs / threat-model requirements;
- expected/allowed paths;
- findings to address or verify;
- verification commands;
- explicit out-of-scope items.

Use `.agents/TASK_PAYLOAD.template.yaml`.

## 3. Repository-local source of truth

For repository work, authoritative context is:

1. explicit task payload;
2. referenced issue/milestone and acceptance criteria;
3. repository files/project documentation;
4. Git state/diff;
5. compact handoff from the immediately preceding role.

Do **not** inspect global Codex memories, unrelated conversation/session history, previous agent transcripts, or external scratch memories unless the task explicitly requires them.

Do not reconstruct history that is already encoded in Git, the issue, or the handoff.

## 4. Convergent milestone lifecycle

The default lifecycle is finite:

```text
IMPLEMENT
  -> freeze candidate C0
  -> ONE general REVIEW
  -> findings F
  -> batch CORRECTION of accepted blocking findings
  -> freeze candidate C1
  -> FINDING VERIFIER checks only F
  -> FINAL GATE
  -> CLOSE
```

### Hard convergence rules

- **At most one general semantic/adversarial review per milestone by default.**
- After that review, do **not** start another general review merely because fixes were applied.
- After correction, use a **finding verifier**, not another reviewer.
- The finding verifier verifies only the designated finite finding set.
- A newly noticed issue during finding verification blocks closure only when it is an immediate `BLOCKER`/P0/P1 regression directly introduced by the reviewed fixes.
- Other newly noticed issues are deferred to the hardening/backlog process and do not reopen the milestone.
- An additional general review requires explicit user/orchestrator justification outside the default workflow.

See `.agents/WORKFLOW.md`.

## 5. Scope bounded by the milestone

Review and verification are against the milestone's stated acceptance criteria, architecture constraints, and explicitly applicable threat model.

Do not silently expand a milestone into an unbounded hardening exercise.

If a valid concern is real but outside the milestone's acceptance scope:

- record it as deferred/backlog work;
- classify its impact;
- do not block closure unless it violates an acceptance criterion or is an immediate critical regression.

## 6. Phase barriers and no concurrent mutation

Source-changing workers and read-only workers must never overlap on the same candidate.

Before spawning reviewer, finding verifier, or final gate:

1. all source-changing workers for the phase must have terminated;
2. intended candidate changes must be staged;
3. there must be no unstaged tracked changes;
4. freeze the candidate with `scripts/freeze-candidate.sh`;
5. pass the resulting candidate digest to the read-only worker.

While a reviewer/verifier/gate is active:

- do not spawn a source-changing worker against the same worktree/candidate;
- do not modify or restage the candidate;
- if the candidate digest changes, the read-only worker must abort rather than review a moving target.

## 7. Candidate identity: staged digest is authoritative

Read-only roles review the **staged candidate**, not an ambiguous mixture of staged and unstaged content.

- Candidate digest = Git index tree digest (`git write-tree`).
- The worktree must match the index for tracked files before read-only work begins.
- Read-only roles must verify the expected digest before and after their task using `scripts/verify-candidate.sh`.
- Use `git diff --cached <base>` for candidate review when the candidate is staged but not committed.

Never knowingly review an old staged candidate while newer fixes remain unstaged.

## 8. Diff-first inspection

For review, verification, and follow-up work:

1. validate candidate identity;
2. inspect status, diff stat, changed paths, and relevant staged diff together;
3. open unchanged dependencies only when needed to validate a concrete requirement;
4. avoid repository-wide reads by default.

Prefer work proportional to the change set rather than repository size.

Use `scripts/agent-diff-context.sh <base> --cached` for staged candidates.

## 9. Tool-call efficiency

- Batch independent shell commands into one call when safe.
- Do not run predictable inspection commands one by one.
- Avoid rereading unchanged files without a concrete reason.
- Avoid repeated `git status`, `git diff`, or equivalent checks without new information.
- Stop once enough evidence exists for the assigned role.

### Default round-trip targets

- Small task: <= 8 tool calls.
- Normal implementation/correction: <= 15.
- Normal review/verifier/gate: <= 10-12.
- Complex atomic task: <= 20 with concrete justification.

These are targets, not correctness limits.

## 10. Tool-output hygiene

Tool output becomes model context. Keep it bounded.

- Prefer path-scoped diffs and searches.
- Prefer concise/quiet test reporters.
- Do not dump generated artifacts, lockfiles, minified files, snapshots, or full successful logs unless required.
- Show the smallest useful failure excerpt.
- Batch related diagnostics into one labeled command bundle.

## 11. Patch batching

Do not patch immediately after each discovered issue when related edits can be understood together.

Preferred sequence:

1. inspect enough context to understand the coherent change set;
2. plan all related edits;
3. apply one primary patch batch;
4. run targeted verification;
5. apply one correction batch if evidence requires it;
6. reserve a third patch round only for an exceptional final correction.

Target <= 3 patch rounds per atomic implementation/correction task.

## 12. Failure diagnostics

After a failed build/test/check:

```text
FAIL
  -> one diagnostic bundle
  -> reason over combined evidence
  -> one correction batch
  -> one focused retest
```

Do not enter probe-by-probe loops when the likely diagnostics can be collected together.

## 13. Testing policy

During implementation/correction:

- use the smallest relevant targeted tests after coherent change batches;
- do not run the full suite after every micro-fix;
- batch independent fixes before broad verification;
- normally perform at most one broad implementation-time verification before handoff.

During final gate:

- run the complete required verification suite once on the frozen final candidate;
- if it fails, return `FAIL` with evidence; do not mutate source;
- any correction creates a new candidate and requires a fresh gate after targeted confirmation.

## 14. General review policy

General reviewers are read-only and are used once per milestone by default.

A reviewer must:

- validate the candidate digest;
- inspect the full relevant staged diff before reporting;
- review against the milestone acceptance criteria and applicable constraints;
- collect all independent findings before returning;
- classify findings as `BLOCKER`, `MAJOR`, or `MINOR`;
- distinguish **in-scope blocking findings** from **deferred hardening/backlog observations**;
- avoid implementing fixes;
- return one findings batch and stop.

Do not run an interactive `finding -> fix -> finding -> fix` loop.

## 15. Finding verification policy

A finding verifier is not a general reviewer.

It receives a finite finding set from the designated general review and returns, for each finding:

- `FIXED`;
- `PARTIALLY_FIXED`;
- `NOT_FIXED`.

It must not restart broad architectural/security/adversarial exploration.

New observations are non-blocking backlog items unless they are immediate P0/P1 regressions directly introduced by the fixes being verified.

See `.agents/FINDING_VERIFIER.md`.

## 16. Gate policy

Gate workers are read-only.

A gate verifies the frozen final candidate and acceptance criteria. It does not search for a new unbounded set of design/security findings.

Return `PASS` or `FAIL` plus concise evidence and stop.

## 17. Context discipline

- Persist cross-agent state in compact structured payloads/handoffs.
- Do not copy transcripts or large logs into fresh workers.
- Do not include old milestone history unless it directly constrains the task.

If context usage is observable:

- < 80k: normal operation;
- 80k-120k: finish current atomic task; accept no substantial new task;
- > 120k: **mandatory handoff before any new substantial phase, browser workflow, broad test pass, or exploratory branch**; finish only the current safe checkpoint and stop.
- > 160k: **hard stop**. Do not continue exploration or implementation. Perform only the minimum actions needed to leave a coherent repository state and emit a compact handoff.

## 18. Handoff size

Handoffs should normally fit in roughly 500-1500 tokens and preferably less.

Include only state needed by the next role: milestone/issue, candidate/base, acceptance status, findings, changed paths, verification results, caveats, and next role.

## 19. Integration verification and UI/browser automation

Use the **lowest-cost interface that verifies the required contract**.

### CLI/protocol-first rule

When a target application exposes a CLI, protocol API, test harness, or machine-readable interface capable of verifying the same deterministic behavior:

1. verify the complete deterministic workflow through that interface;
2. use browser/UI automation only for behavior that specifically requires the graphical/web client;
3. do not reproduce a protocol/conformance suite through browser clicks merely because a web UI exists.

Browser/UI automation is a **last-mile integration verification tool**, not the default functional test mechanism.

### Browser smoke scope

A normal browser smoke should cover only the smallest client-specific path, for example:

```text
open/connect
  -> discovery visible
  -> one representative operation
  -> one representative resource/result
  -> clean completion/disconnect
```

Do not replay a long create/edit/undo/render/export/conformance scenario through the browser when CLI/protocol verification already covers it.

### Browser round-trip budget

- Target <= 10 browser automation rounds for a normal smoke.
- Hard target <= 15 unless the issue explicitly concerns web/UI behavior.
- Batch deterministic interactions when safe.
- Do not take a full DOM/accessibility snapshot after every click/fill.
- Snapshot only when state is unknown, a navigation boundary was crossed, or evidence is required.
- Once selectors/structure are known, reuse them rather than rediscovering the page repeatedly.

### Preflight before expensive integration workflows

Before a long external-client or UI scenario, prove the environment with the cheapest possible check:

1. executable/client version and required capabilities;
2. child-process environment/config propagation;
3. server startup and protocol connection;
4. workspace/temp-directory isolation;
5. one cheapest representative request;
6. expected logging/stdout/stderr boundary if applicable.

If preflight fails, **stop the scenario immediately**. Correct configuration/root cause before retrying. Do not execute 50-80% of a workflow and discover basic environment failure near the end.

### Retry policy

- Do not blindly replay a failed long integration scenario.
- Diagnose the root cause with one bounded bundle.
- Re-run the preflight first.
- After preflight passes, allow one bounded full retry on the same candidate.
- A second infrastructure/configuration failure should return `BLOCKED`/handoff with evidence rather than starting another full replay.

### MCP Inspector policy

For MCP milestones:

- Use **MCP Inspector CLI** for the complete deterministic MCP workflow whenever it can verify the required protocol behavior.
- Use Inspector web/TUI only for client-specific integration evidence that cannot be established by CLI alone.
- A web smoke should normally verify: connect, discovery, one representative tool call, one resource read/result, and clean completion.
- Do not execute the entire MCP conformance workflow via `agent-browser` unless the acceptance criterion explicitly concerns Inspector web UI behavior.
- Prefer one repository script that executes the Inspector CLI scenario and emits a compact PASS/FAIL summary over dozens of interactive model/browser turns.

See `.agents/INTEGRATION_VERIFIER.md` and `.agents/MCP_INSPECTOR.md`.

## 20. Role separation

Use distinct roles:

- **Orchestrator**: owns finite state machine and phase barriers.
- **Implementer/Corrector**: writes source and targeted tests.
- **General Reviewer**: one bounded semantic/adversarial review.
- **Finding Verifier**: verifies only the finite review finding set.
- **Integration Verifier**: executes bounded external-client/host evidence using CLI/protocol-first verification and minimal UI smoke.
- **Gate**: executes final acceptance verification.

See `.agents/ORCHESTRATOR.md`, `.agents/IMPLEMENTER.md`, `.agents/REVIEWER.md`, `.agents/FINDING_VERIFIER.md`, `.agents/INTEGRATION_VERIFIER.md`, and `.agents/GATE.md`.

## 21. Stop conditions

An agent must stop when:

- its assigned atomic task is complete;
- enough evidence exists for its role-specific conclusion;
- the candidate digest changes unexpectedly;
- the task changes materially;
- the role has reached its handoff boundary.

Do not continue merely to increase confidence after the finite acceptance process has been satisfied.
