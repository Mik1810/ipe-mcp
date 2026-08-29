# M9 MVP Definition of Done Evidence Matrix

Gate: `bash scripts/gates/check-m9-dod.sh`. This is the authoritative CURRENT
evidence matrix for ROADMAP.md section 12 and issue #22.

## Candidate identity and evidence policy

The candidate under evidence is Git staged-tree SHA-1
`17b5fb3cb883b5af06f619483c11a8f9d1a8c73a`, captured with `git write-tree`
at immutable source revision `ac854a747011f2e944619fefd3a3d0adf392ec98`.
Every CURRENT row below is exercised against that frozen candidate by the
gate. The matrix and gate are the attestation layer added after the frozen
tree: as documented in `docs/milestones/core-m9-candidate.md`, a Git tree
cannot embed its own digest without changing that digest. The gate therefore
resolves the recorded source revision's tree and requires it to equal the
recorded candidate identity; it does not misidentify the later attestation
commit as the candidate under test.

`CURRENT` means a command, test, SDK client run, or bounded artifact record
executed by the gate from this candidate. `HISTORICAL` means retained context
only and can never make a row pass. Generated `.ipe`, PDF, PNG, state, logs,
and dependency trees live under a private temporary root and are deleted; the
gate retains only bounded stdout JSON long enough to audit it.

## Evidence matrix

| DoD | Required workflow | Concrete evidence | Candidate | Result |
|---:|---|---|---|---|
| DOD-01 | Create or open without altering the original | CURRENT: `node scripts/host/m9-agent-workflow.mjs ABSOLUTE_TEMP_DIR` creates, saves, reopens, and byte-compares the source after open; `tests/persistence/session-manager.test.ts` covers working-copy isolation and source-change conflicts. | `17b5fb3cb883b5af06f619483c11a8f9d1a8c73a` | PASS |
| DOD-02 | Compose a 16:9 slide with coordinates, anchors, and layout | CURRENT: the M9 SDK workflow creates and composes with preset `16:9` and runs `layout_objects`; `tests/composition/m5.test.ts`, `tests/layout/geometry-matrix.test.ts`, `tests/layout/layout.test.ts`, and `tests/layout/golden.test.ts` cover exact layout, all anchors, coordinates, and golden geometry. | `17b5fb3cb883b5af06f619483c11a8f9d1a8c73a` | PASS |
| DOD-03 | Insert and modify text, images, groups, symbols, and all basic shapes | CURRENT: the M9 SDK workflow authors text, image, rectangle, and circle through MCP; `tests/mcp/service.test.ts`, `tests/objects/roundtrip.test.ts`, `tests/objects/path.test.ts`, and `bash scripts/gates/check-m4.sh` exercise groups, symbols, assets, modification, and the complete geometric primitive matrix. | `17b5fb3cb883b5af06f619483c11a8f9d1a8c73a` | PASS |
| DOD-04 | Control layers separately from global z-order | CURRENT: the M9 SDK workflow performs `set_object_layer` and `move_object` as distinct operations; `tests/composition/m5.test.ts` and `tests/objects/crud-builders.test.ts` verify independent layer membership and ordering. | `17b5fb3cb883b5af06f619483c11a8f9d1a8c73a` | PASS |
| DOD-05 | Create pages/views, reveals, and discrete scrolling with fallback | CURRENT: the M9 SDK workflow composes another page and builds a reveal; `tests/animation/m7.test.ts`, `tests/mcp/service.test.ts`, and `bash scripts/gates/check-m7.sh` exercise pages/views, reveal, `panel_scroll`, camera pan, bounded discrete steps, and static fallback. | `17b5fb3cb883b5af06f619483c11a8f9d1a8c73a` | PASS |
| DOD-06 | Validate XML, Ipelib, styles, LaTeX, PDF, and preview | CURRENT: the M9 SDK workflow requires structural and full validation; `tests/ipe/xml.test.ts`, `tests/native/adapter.test.ts`, and `bash scripts/gates/check-m6.sh` cover XML, native load/save/reload, `checkStyle`, LaTeX, PDF, and preview validation. | `17b5fb3cb883b5af06f619483c11a8f9d1a8c73a` | PASS |
| DOD-07 | Visually inspect every view | CURRENT: `bash scripts/gates/check-m9-dod.sh` renders every view of reveal, motion, `panel_scroll`, and camera-pan fixtures; for the scrolling/panning visual corpus it also byte-compares all per-view PNG goldens and requires distinct SHA-256 values. `bash scripts/gates/check-m7.sh` and `bash scripts/gates/check-m6.sh` are the underlying cumulative visual contracts. | `17b5fb3cb883b5af06f619483c11a8f9d1a8c73a` | PASS |
| DOD-08 | Atomically save `.ipe` and export PDF/PNG | CURRENT: both official-SDK host runs save XML 70218 and read PDF/PNG resources; their temporary artifact SHA-256 values are recomputed and audited by `bash scripts/gates/check-m9-dod.sh`; `tests/persistence/atomic.test.ts` covers interrupted atomic replacement. | `17b5fb3cb883b5af06f619483c11a8f9d1a8c73a` | PASS |
| DOD-09 | Undo a transaction or recover a previous snapshot | CURRENT: the M9 SDK workflow proves stale rollback, snapshot, undo/restore, then restart recovery; `tests/persistence/session-manager.test.ts` and `tests/mcp/service.test.ts` cover durable recovery and snapshot restoration. | `17b5fb3cb883b5af06f619483c11a8f9d1a8c73a` | PASS |
| DOD-10 | Run the workflow from Codex and another MCP host | CURRENT: `node scripts/host/m9-agent-workflow.mjs ABSOLUTE_TEMP_DIR` and `node scripts/host/m8-sdk-host.mjs ABSOLUTE_TEMP_DIR` are independent real-stdio clients built on `@modelcontextprotocol/client`; both run against the current build and emit audited JSON. HISTORICAL ONLY: `fixtures/conformance/m8/host-evidence.json` records Codex CLI 0.149.0-alpha.4.3 and MCP Inspector 2.4.0 against old candidate `b35d7c398613542d8aa3fc4160c5b799dd6936c7`; those unavailable clients were not rerun and are not claimed as current-candidate evidence. | `17b5fb3cb883b5af06f619483c11a8f9d1a8c73a` | PASS with explicit host provenance |

## Bounded current-run record

`check-m9-dod.sh` parses the final JSON line from each SDK client. For the M9
workflow it requires all named PASS fields, at least 18 sections, three
resource reads, full validation, restart recovery, and protocol-safe stderr.
For the independent portable host it requires the official TypeScript SDK,
stdio, stale rollback, undo/restore, full validation, three resource reads,
and protocol-safe stderr. It then verifies the generated Ipe/PDF/PNG
signatures, byte sizes, and freshly computed SHA-256 values before cleanup.

## Scope boundary

This evidence proves the local MVP on Ipe 7.2.30 / XML 70218. It does not
claim continuous animation, live GUI editing, universal PDF transitions, a
public server, a 7.3.x baseline, npm publication, packaging, or a GitHub
release. Issue #8 agentic-harness compliance is not affected: no MCP tool
description, host instruction, task payload, or harness contract changes.
