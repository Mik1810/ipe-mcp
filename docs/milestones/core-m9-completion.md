# M9 Cumulative Gate and Completion Audit

Gate: `bash scripts/check-m9.sh`. This is the authoritative requirement map
for issue #24. A row is complete only when that command reaches its final PASS
line on the frozen tree; prose or historical results cannot substitute for a
current command result.

## Requirement-by-requirement audit

| ID | Requirement | Current executable evidence | Required result |
|---|---|---|---|
| M9-01 | Keep M0-M8 green | `bash scripts/gates/check-m8.sh`, whose chain reaches `check-m0.sh` | PASS |
| M9-02 | Enforce and publish release limits | `bash scripts/gates/check-m9-limits.sh` | PASS |
| M9-03 | Run bounded seeded fuzz/property suites | `bash scripts/gates/check-m9-fuzz.sh` | PASS |
| M9-04 | Exercise the hostile corpus | `bash scripts/gates/check-m9-hostile.sh` | PASS |
| M9-05 | Prove clean setup and full capabilities | `bash scripts/gates/check-m9-setup.sh` | PASS |
| M9-06 | Audit deterministic SBOM and licenses | `bash scripts/gates/check-m9-sbom.sh` | PASS |
| M9-07 | Audit the support policy and mode matrix | `bash scripts/gates/check-m9-support.sh` | PASS |
| M9-08 | Audit release notes, migration, and rollback | `bash scripts/gates/check-m9-notes.sh` | PASS |
| M9-09 | Exercise licensed real documents | `bash scripts/gates/check-m9-real.sh` | PASS or exact documented native classification |
| M9-10 | Exercise the agent manual workflow | `bash scripts/gates/check-m9-manual.sh` | PASS |
| M9-11 | Demonstrate all ten MVP DoD items | `bash scripts/gates/check-m9-dod.sh` | ten CURRENT PASS rows |
| M9-12 | Disposition all eight threat IDs | `bash scripts/gates/check-m9-threat-audit.sh` | seven PASS and one proved NOT APPLICABLE |
| M9-13 | Validate Issue #8 agentic-harness evidence schema | final audit in `bash scripts/check-m9.sh` over `docs/guides/m8-agentic-harness-audit.md` | 31 complete rows: 24 PASS, 7 NOT APPLICABLE, zero deferred |
| M9-14 | Reproduce the local release candidate | `bash scripts/gates/check-m9-candidate.sh` | clean install, stable suite, workflow, artifacts, cleanup PASS |
| M9-15 | Use one fresh read-only final gate environment | outer launcher in `bash scripts/check-m9.sh` | exact tree, fresh worktree, all tracked files non-writable, one inner complete run |
| M9-16 | Update completion only from evidence | final PASS tree is reported by the command and then recorded on GitHub | no pre-gate completion claim |
| M9-17 | Preserve the M9 boundary | static completion audit and component gates | no M10 implementation, packaging, HTTP, or live bridge |

## Issue #8 evidence schema

The inherited audit is machine-checked as a structured six-section matrix:
`Model-facing contract`, `Orientation and dynamic behavior`, `Result quality
and recovery`, `Permissions and write safety`, `Transport, integration, and
privacy`, and `Code architecture and verification`. Every evidence row must
have exactly three non-empty fields: item, result, and evidence/rationale.
Result is restricted to `PASS` or `NOT APPLICABLE`; the disposition must be
exactly 24 PASS, 7 NOT APPLICABLE, and `DEFERRED M9: 0`. This is the Issue #8
agentic-harness evidence schema required by #24; the cumulative gate validates
the schema and retains the M8 audit rather than inventing a second harness.

## Frozen final-gate protocol

The outer invocation resolves the candidate with `git write-tree`, rejects
unstaged tracked or non-ignored untracked files, creates a new detached Git
worktree, resets that worktree and its private index to the exact tree, and
makes every tracked candidate file non-writable. It then launches one inner
`scripts/check-m9.sh` process. The inner process proves its tree and read-only
permissions, installs the locked dependencies into ignored `node_modules`,
and then executes the complete gate. Build output, dependencies,
state, and artifacts are ignored/generated data; they remain writable and are
removed with the isolated worktree.

The complete gate is not a general review. If it fails, the run stops. Any
candidate correction is made only in the owning checkout, then the changed
tree receives a new fresh invocation. The read-only gate worktree is never
patched in place. The final PASS line reports the demonstrated tree identity;
issue #24 and parent #6 may be closed only after that evidence exists.

## Boundary

This gate completes M9 only. It does not start M10, publish a package, create
a GitHub release, implement HTTP/OAuth, add a live Ipe bridge, or broaden the
supported platform matrix.
