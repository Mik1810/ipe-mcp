# Operational prompt for roadmap execution

Recommended usage: start the main task with **`gpt-5.6-sol`** and paste the prompt below. Replace `TARGET=NEXT` only when a specific milestone is required, for example `TARGET=M1`.

## Prompt to copy

```text
Work in /home/mik/github/ipe-mcp as the primary gpt-5.6-sol orchestrator.

TARGET=NEXT

Objective: complete exactly one roadmap milestone, either TARGET or the first incomplete milestone when TARGET=NEXT, including code, tests, review, documentation, commit, and push to origin/main. Do not start the next milestone.

Normative sources, in this order:
1. /home/mik/github/ipe-mcp/ROADMAP.md — scope, decisions, gates, and Definition of Done.
2. /home/mik/github/ipe-mcp/report-source.md — technical evidence and Ipe incompatibilities.
3. /home/mik/github/ipe-mcp/SETUP-WSL.md — verified local environment.
4. Code and tests in the repository.

Do not copy these files into the context or messages: read only the sections needed for the milestone. If a choice is already approved in the roadmap decision register, apply it without requesting confirmation again.

Team and delegation:
- You, gpt-5.6-sol, own the plan, architecture, integration, final decisions, and Git.
- Delegate concrete, independent subtasks with explicit `fork_turns="none"` calls and the model and reasoning specified below. Each task packet must remain under 500 words and include: objective, file/line references, file allowlist, constraints, tests, and result format.
- Implementation or mechanical research: gpt-5.6-luna, reasoning medium.
- Adversarial review: gpt-5.6-terra, reasoning high, read-only.
- Independent testing: gpt-5.6-luna, reasoning medium, read-only; output/test artifacts only in temporary storage.
- Writing agents must have disjoint file sets. Reviewers and testers are strictly forbidden from modifying the working tree.
- Verify the assigned role/model from the delegation result. If Terra high or Luna medium is unavailable, declare the corresponding gate unsatisfied; do not silently substitute another model.
- At most three subagents may be active, and only when genuine parallel work exists. Do not delegate reading AGENTS.md or mandatory skills: you must read them yourself. Each subagent response must remain under 20 lines unless a reproducible error requires more context.

Mandatory workflow:
1. Preflight: verify cwd, any AGENTS.md files, git status, main branch, origin/main, toolchain, and required dependencies. Run `git fetch origin`. Files in scope must be clean; preserve unrelated changes. If main is only behind and the tree is clean, use `git pull --ff-only`; if it has diverged, stop. Do not reset, clean, force-push, or rewrite history. Record the base SHA of origin/main.
2. Select the milestone and translate its gate into a short checklist. Use a plan with exactly one in-progress step.
3. Inspect the code with rg/rg --files. Before and after every subtask, record `git status --short` and `git diff --name-only`; accept changes only within the task allowlist. If an out-of-allowlist change appears, stop integration and investigate ownership without automatically reverting it. The orchestrator personally reviews every diff.
4. Implement the smallest complete solution that satisfies the gate: no next-milestone features, opportunistic refactors, or unrequested 7.3.x compatibility.
5. Run focused tests during development.
6. Once the implementation is stable, stage only allowlisted files and freeze the candidate by recording the file list and digest of `git diff --cached --binary`. Do not modify it during review. Start in parallel:
   a) an adversarial Terra reviewer, read-only, looking for Ipe semantic errors, regressions, security issues, races, round-trip loss, and deviations from the roadmap;
   b) an independent Luna tester, read-only, running focused tests, the complete gate, and edge cases.
7. Reviewer format: only actionable findings `[P0-P3] file:line — evidence — correction`; if there are none, `NO FINDINGS` plus verifiable residual risks.
8. Tester format: commands run, PASS/FAIL, minimal reproducible error, and coverage gaps. Do not accept “it seems to work.”
9. Triage every finding yourself: fix P0–P2; fix P3 when in scope, otherwise document it. After any correction, rebuild the candidate, rerun affected tests, and ask the same reviewer to re-check the delta.
10. Update the roadmap/documentation only with status actually demonstrated. Do not declare complete anything that is merely planned or unverified.
11. If all gates pass, verify that the index and working tree contain only the expected files. Fetch again and require origin/main to remain at the base SHA; if it advanced, do not merge/rebase automatically: reconcile in a new cycle and rerun the gates. Create one atomic commit and use `git push origin HEAD:main`. Pushing to main is authorized; force-push is forbidden. Missing credentials or branch protection are blockers to report, not bypass.

Technical discipline:
- Stable target: Ipe 7.2.30 and XML format 70218; master/7.3.x is only a compatibility lane.
- Layer, z-order, and view remain separate concepts.
- Hybrid backend: deterministic XML plus ipescript/Ipelib.
- Minimal pdfLaTeX; no sudo or distribution expansion unless required by the milestone.
- Every write is atomic/revision-safe; no secrets, heavy generated output, or temporary files in the commit.
- Apply the roadmap security guardrails to LaTeX, XML, paths, and subprocesses.

Token efficiency and communication:
- Do not repeat the roadmap, complete diffs, or complete logs. Report only decisions, anomalies, and results.
- Use rg and focused excerpts before opening complete documents; use file/line references and limit logs to diagnostic fragments.
- Do not poll frequently: use long waits for subagents.
- At most four user updates: start, implementation ready, review/test result, and delivery.
- Do not ask for confirmation for reversible local operations already in scope. Stop only for a real blocker, a choice not covered by the roadmap, missing credentials, or a destructive/unauthorized action.

Concise final delivery:
- milestone and result;
- main files changed;
- tests/gates and outcome;
- adversarial findings resolved or residual risks;
- commit hash and confirmation of push to origin/main;
- next milestone, without starting it.
```

## Why it is structured this way

- One milestone at a time prevents stale context and decisions from being carried across the entire roadmap.
- `fork_turns="none"` avoids duplicating the whole conversation into subagents.
- Implementation, review, and testing are separate roles: the author does not certify the result alone.
- A push to `main` occurs only after gates and independent checks.
- The orchestrator retains high-impact decisions; lighter models receive bounded tasks and strictly compressed outputs.
