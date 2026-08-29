# Mono-Agent Workflow

This is the default repository workflow. One agent owns every phase.

## 1. Inspect

Establish the minimum context needed to act:

```bash
scripts/agent/agent-context.sh
```

Then read only the issue, docs, code, and tests relevant to the requested change.

Do not perform a broad repository audit unless explicitly requested.

## 2. Plan

Before editing, state internally:

- acceptance criteria;
- files/components likely affected;
- intended behavior;
- smallest useful verification.

Prefer one coherent implementation plan over iterative probe/edit cycles.

## 3. Implement

Apply related edits in one batch where practical.

Do not create role-specific state, handoff, candidate-digest, or evidence files.

## 4. Targeted verification

Run the narrowest relevant tests/checks first.

On failure, gather one useful diagnostic bundle, fix the cause, and retest. Avoid command-by-command probing.

## 5. Self-review

Exactly one general self-review by default:

```bash
scripts/agent/agent-context.sh --diff
```

If the change is large, scope the diff to relevant paths:

```bash
scripts/agent/agent-context.sh --diff -- src tests
```

Check the diff against the acceptance criteria and directly affected behavior.

Fix all blocking findings together where possible. Record unrelated findings as follow-up work.

## 6. Final verification

Run the repository-required final checks once on the finished working tree.

For MCP/client integration, use the CLI/protocol path first. Use browser/UI automation only for client-specific evidence.

If final verification fails, make a bounded correction and rerun only what is necessary; do not restart the whole workflow.

## 7. Report and stop

Report:

- files/behavior changed;
- tests/checks run and their result;
- any unresolved blocker or clearly separated follow-up.

Do not continue reviewing after the task is accepted and verified.
