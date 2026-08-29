# Agent Operating Rules

These rules apply to repository work.

## Primary objective

Complete the requested task correctly with one agent, bounded context, and as few model/tool round trips as practical.

The same agent owns the task end-to-end: inspection, implementation, self-review, correction, verification, and final report.

## 1. Mono-agent rule

- Do not spawn, delegate to, or coordinate subagents for repository work.
- Do not split one task into implementer/reviewer/corrector/verifier/gate roles.
- Perform review and verification as bounded phases of the same task.
- Do not create worker handoffs, candidate digests, role payloads, or milestone state files unless the user explicitly asks for them.

## 2. Source of truth

Use, in order:

1. the user's request and acceptance criteria;
2. the referenced GitHub issue/milestone, when applicable;
3. repository documentation and ADRs;
4. the current Git state and relevant code/tests.

Do not reconstruct history that is already represented by Git or repository documentation.

## 3. Default workflow

Use the finite workflow described in `.agents/WORKFLOW.md`:

```text
INSPECT
  -> PLAN
  -> IMPLEMENT
  -> TARGETED VERIFY
  -> ONE SELF-REVIEW
  -> CORRECT IF NEEDED
  -> FINAL VERIFY
  -> REPORT
```

Do not add extra phases merely to increase confidence after the acceptance criteria are satisfied.

## 3.1 MCP agentic-harness compliance

Apply [`.agents/MCP_HARNESS_COMPLIANCE.md`](.agents/MCP_HARNESS_COMPLIANCE.md)
whenever changed paths or behavior touch the MCP server, model-facing contract,
host integration, permissions/write safety, transport/privacy, or their gates.

- During planning, record `mcp_harness_compliance.applicable_areas`,
  `evidence_required`, and either proportional evidence needs or a concrete
  `not_applicable_reason`.
- During the one self-review, reclassify against the actual diff and record
  evidence/findings for every applicable area.
- During final verification and reporting, name the applicable areas and the
  concrete checks that passed. Run the complete six-area audit only for a
  cross-cutting MCP milestone or an explicit audit request.
- Do not create task, review, handoff, or gate state files solely to satisfy
  this rule. If the user explicitly requests such an artifact, it must carry
  the policy's structured schema.

## 4. Inspection and tool efficiency

Start with one compact inspection bundle when possible:

- `git status --short --branch`;
- relevant issue/acceptance criteria;
- changed paths or `git diff --stat` when work already exists;
- targeted `rg` searches;
- only the relevant ranges of relevant files.

Rules:

- Batch independent read-only commands into one tool call when safe.
- Prefer `rg`, scoped `sed`, and path-scoped diffs over whole-repository dumps.
- Do not reread unchanged files without a concrete reason.
- Do not repeat `git status`, `git diff`, build, or test commands without new information.
- Stop exploring once enough evidence exists to implement safely.

Normal target: roughly 8-15 tool calls for a normal issue. Exceed this only when the task genuinely requires it.

## 5. Tool-output hygiene

Tool output becomes model context.

- Keep output small by default.
- Prefer summaries, quiet reporters, `--stat`, changed-file lists, and focused failure excerpts.
- Never dump generated artifacts, lockfiles, minified files, large snapshots, or full successful logs unless required.
- Do not request a full diff until you know which paths/hunks matter.
- Use `scripts/agent/agent-context.sh` for a compact Git snapshot.

## 6. Implementation

Before editing, understand the coherent change set.

Preferred sequence:

1. inspect enough context;
2. plan related edits;
3. apply one coherent patch batch;
4. run targeted verification;
5. apply one correction batch if evidence requires it.

Target at most 2-3 meaningful patch rounds. Do not patch after every tiny observation when related edits can be batched.

Stay within the requested scope. Record unrelated hardening ideas for later instead of expanding the issue.

## 7. Testing

During implementation:

- run the smallest tests that exercise the changed behavior;
- do not run the full suite after every micro-change;
- collect diagnostics from a failure in one bounded bundle before editing again.

Before completion:

- run the repository's required build/typecheck/lint/test commands once;
- run milestone/integration checks only when relevant to the acceptance criteria.

If final verification fails:

```text
FAIL
  -> collect one diagnostic bundle
  -> make one coherent correction
  -> rerun the affected check
  -> rerun final verification if needed
```

Avoid blind retry loops.

## 8. Self-review

Perform one bounded self-review after implementation and targeted tests.

Review:

- the relevant diff;
- the acceptance criteria;
- correctness and error paths introduced by the change;
- tests for the changed behavior;
- obvious regressions in directly affected code.

Classify discoveries as:

- `BLOCKING`: must fix before completion;
- `FOLLOW-UP`: valid but outside the current task.

Do not restart a repository-wide architectural/security review unless the task explicitly asks for one.

After fixing blocking findings, verify those fixes directly. Do not perform another general review by default.

## 9. Git discipline

- Preserve unrelated user changes.
- Do not reset, clean, or discard work that you did not create.
- Do not stage files solely to create a review snapshot.
- Use commits/worktrees only when the task or repository process requires them.
- Before reporting completion, inspect the final changed-file list and relevant diff.

## 10. Integration and browser/UI verification

Use the lowest-cost interface that verifies the contract.

- Prefer unit/integration tests, CLI, protocol APIs, or machine-readable harnesses.
- Use browser/UI automation only for behavior that specifically requires the graphical client.
- For MCP work, prefer MCP Inspector CLI for deterministic protocol verification.
- A normal browser smoke should cover only the smallest client-specific path.
- Diagnose a failed preflight before replaying a long integration scenario.

Keep `.agents/MCP_INSPECTOR.md` as the detailed MCP-specific procedure when applicable.

## 11. Context discipline

Keep the active context focused on the current task.

- Do not paste large logs or entire files when a range or summary is sufficient.
- At major phase boundaries, mentally compress prior exploration into: requirements, decisions, changed paths, remaining checks.
- If context becomes very large and substantial work remains, finish the current safe checkpoint and return a concise handoff for a fresh user-started run.
- Never spawn a subagent as a context-reset mechanism.

## 12. Completion criteria

Stop when all of the following hold:

- requested acceptance criteria are satisfied;
- blocking self-review findings are resolved;
- relevant targeted tests pass;
- required final verification passes, or a concrete blocker is reported;
- the final diff contains no unintended changes.

The final report should be concise: what changed, verification performed, and any genuine follow-up/blocker.
