# Documentation Inventory and Disposition — 2026-08-29

This issue #25 audit covers every tracked Markdown file after the approved
changes and every JSON artifact that acts as documentation, configuration,
fixture metadata, or retained evidence. `guide.md` is ignored and untracked, so
it is outside the repository inventory and was left untouched. The dated
`repo-audit-2026-08-28.md` was explicitly deferred and left byte-identical.

Legend: **maintained** is living guidance; **frozen** is accepted milestone or
release history; **generated** is reproducible output; **evidence** is retained
verification rather than guidance; **deferred** is intentionally unresolved.

## Markdown inventory

| Path | Status / lifecycle | Objective and audience | Authoritative scope and current usage | Action |
|---|---|---|---|---|
| `.agents/MCP_HARNESS_COMPLIANCE.md` | Maintained | Touch-triggered MCP compliance policy for agents/reviewers | Authoritative process policy; consumed by workflow and policy gate | Keep; update audit link |
| `.agents/MCP_INSPECTOR.md` | Maintained | Bounded Inspector procedure for repository agents | Authoritative MCP Inspector workflow; linked from process guidance | Keep |
| `.agents/WORKFLOW.md` | Maintained | Finite mono-agent workflow for contributors/agents | Authoritative repository execution flow under `AGENTS.md` | Keep |
| `AGENTS.md` | Maintained | Repository operating rules for agents | Highest repository-local process authority | Keep |
| `README.md` | Maintained | Project entry point for developers/operators | Status, setup, primary navigation; links to detailed authority | Refresh status/navigation |
| `ROADMAP.md` | Maintained | Architecture, milestone history, DoD, and future scope | Authoritative roadmap and traceability register | Refresh completion status/links |
| `SETUP-WSL.md` | Maintained | Supported Ubuntu WSL/native-tool setup for operators | Authoritative setup procedure; consumed by M9 setup gate | Fix staged-tree description |
| `docs/README.md` | Maintained | Documentation entry map for all audiences | Navigation and lifecycle routing | Add |
| `docs/documentation-policy.md` | Maintained | Naming, authority, and lifecycle rules for maintainers | Authoritative documentation policy | Add |
| `docs/adr/0001-compatibility-baseline.md` | Frozen ADR | Compatibility baseline for implementers | Accepted decision; referenced by roadmap/contracts | Keep |
| `docs/adr/0002-domain-model-and-layout.md` | Frozen ADR | Domain/layout decisions for implementers | Accepted decision; referenced by roadmap/contracts | Keep |
| `docs/adr/0003-backend-persistence-and-identifiers.md` | Frozen ADR | Backend, persistence, and ID decisions | Accepted decision; referenced by milestone implementation | Keep |
| `docs/adr/0004-security-and-trust-boundaries.md` | Frozen ADR | Security and trust-boundary decisions | Accepted security authority; referenced by M9 SBOM/threat work | Keep |
| `docs/audits/agentic-harness-audit.md` | Evidence | Complete M8/Issue #8 disposition for reviewers | Baseline audit consumed by M8/M9 and policy gates | Rename from leading `m8-`; retain provenance |
| `docs/audits/documentation-inventory-2026-08-29.md` | Frozen audit | Issue #25 inventory for maintainers/reviewers | Evidence for naming/lifecycle decisions | Add |
| `docs/guides/agent-manual.md` | Maintained | Single operational workflow for agents and humans | Authoritative product operations; exercised by M9 manual gate | Rename from `m9-`; add startup, quick start, glossary, checklist |
| `docs/guides/host-integration.md` | Maintained | Configure supported MCP hosts | Authoritative host setup; linked from README/manual | Rename from `m8-`; retain qualification provenance |
| `docs/guides/support-policy.md` | Maintained | Support/degrade/warn/reject matrix for operators | Authoritative support scope; consumed by M9 support gate | Keep stable path; clarify living status |
| `docs/milestones/core-m2.md` | Frozen milestone | M2 IR/XML/persistence evidence for implementers | Accepted M2 contract/evidence | Keep |
| `docs/milestones/core-m3.md` | Frozen milestone | M3 coordinates/layout evidence | Accepted M3 contract/evidence | Keep |
| `docs/milestones/core-m4.md` | Frozen milestone | M4 object authoring evidence | Accepted M4 contract/evidence | Keep |
| `docs/milestones/core-m5.md` | Frozen milestone | M5 pages/layers/views evidence | Accepted M5 contract/evidence | Keep |
| `docs/milestones/core-m6.md` | Frozen milestone | M6 native validation/export evidence | Accepted M6 contract/evidence | Keep |
| `docs/milestones/core-m7.md` | Frozen milestone | M7 discrete animation evidence | Accepted M7 contract/evidence | Keep |
| `docs/milestones/core-m8.md` | Frozen milestone | M8 MCP/host evidence | Accepted M8 contract/evidence | Keep |
| `docs/milestones/core-m9-candidate.md` | Frozen milestone | Frozen candidate identity/procedure | M9 release-candidate evidence consumed by gates | Keep |
| `docs/milestones/core-m9-completion.md` | Frozen milestone | Requirement-by-requirement M9 completion | Authoritative M9 completion audit; consumed by cumulative gate | Keep; update renamed audit link |
| `docs/milestones/core-m9-dod.md` | Frozen milestone | Ten-item MVP DoD evidence | M9 acceptance evidence consumed by DoD gate | Keep |
| `docs/milestones/core-m9-hostile.md` | Frozen milestone | Hostile corpus inventory/results | M9 security evidence consumed by hostile gate | Keep |
| `docs/milestones/core-m9-limits.md` | Frozen milestone | Release limits and budgets | Normative M9 limit table mirrored by code/gates | Keep milestone name |
| `docs/milestones/core-m9-real.md` | Frozen milestone | Licensed real-document review | M9 evidence consumed by real-document gate | Keep |
| `docs/milestones/core-m9-sbom.md` | Frozen milestone | SBOM/license/GPL boundary analysis | M9 evidence consumed by SBOM gate | Keep; fix license/SBOM links |
| `docs/milestones/core-m9-testing.md` | Frozen milestone | Bounded fuzz/property test contract | M9 evidence consumed by fuzz gate | Keep |
| `docs/milestones/core-m9-threat-audit.md` | Frozen milestone | Eight threat dispositions | M9 evidence consumed by threat/completion gates | Keep |
| `docs/reference/compatibility-modes.md` | Maintained reference | Mode/capability matrix for users and implementers | Normative compatibility reference; linked by manual/README | Keep |
| `docs/reference/conformance-m1.md` | Frozen reference | Native conformance baseline/results | M1 verification reference | Keep milestone provenance |
| `docs/reference/viewer-effects-m1.md` | Frozen reference | Initial viewer/effect observations | Historical baseline used by later M7 matrix | Keep |
| `docs/reference/viewer-effects-m7.md` | Frozen reference | Conservative supported viewer/effect matrix | M7 normative evidence linked by manual/README | Keep milestone provenance |
| `docs/releases/release-notes.md` | Frozen release | M9 v0.1.0 delivery, migration, rollback for operators | Release record consumed by M9 notes gate | Move/rename from `guides/m9-`; retain M9 in content |
| `repo-audit-2026-08-28.md` | Deferred review | Dated pre-completion audit for maintainers | Not current authority; not linked as guidance | Leave byte-identical now; review separately |
| `report-source.md` | Frozen research | Source dossier/traceability for architecture reviewers | Supporting research cited by roadmap | Keep current root path |

`ORCHESTRATOR_PROMPT.md` was removed: its multi-role orchestration instructions
conflicted with the authoritative mono-agent `AGENTS.md`/`.agents/WORKFLOW.md`
and had no remaining valid operational role.

## Relevant JSON and machine-readable artifacts

| Path | Status / audience | Objective, authority, usage, and action |
|---|---|---|
| `.vscode/mcp.json` | Maintained config / VS Code users | Project-local stdio launch configuration; keep and verify as host setup |
| `docs/reference/sbom.json` | Generated / release reviewers | Deterministic CycloneDX inventory generated by `scripts/tools/sbom.mjs`, consumed by SBOM gate; rename from `m9-sbom.json` |
| `fixtures/conformance/manifest.json` | Maintained fixture index / test authors | Top-level conformance corpus routing; keep |
| `fixtures/conformance/m1/golden-results.json` | Frozen evidence / test authors | Expected M1 native observations; consumed by conformance tests; keep |
| `fixtures/conformance/m1/manifest.json` | Frozen fixture metadata | M1 case inventory consumed by gate/tests; keep |
| `fixtures/conformance/m2/manifest.json` | Frozen fixture metadata | M2 case inventory consumed by gate/tests; keep |
| `fixtures/conformance/m3/presentation-16x9-layout.json` | Frozen fixture specification | Expected 16:9 layout consumed by M3 tests; keep |
| `fixtures/conformance/m3/standard-layout.json` | Frozen fixture specification | Expected standard layout consumed by M3 tests; keep |
| `fixtures/conformance/m4/manifest.json` | Frozen fixture metadata | M4 case inventory consumed by gate/tests; keep |
| `fixtures/conformance/m5/manifest.json` | Frozen fixture metadata | M5 case inventory consumed by gate/tests; keep |
| `fixtures/conformance/m6/manifest.json` | Frozen fixture metadata | M6 native cases consumed by gate/tests; keep |
| `fixtures/conformance/m7/manifest.json` | Frozen fixture metadata | M7 corpus/golden routing consumed by gate/tests; keep |
| `fixtures/conformance/m8/host-evidence.json` | Evidence / reviewers | Retained real-host evidence consumed by M8 gate; keep |
| `fixtures/conformance/m8/manifest.json` | Frozen fixture metadata | M8 host/protocol case inventory consumed by gate/tests; keep |
| `fixtures/conformance/m9/hostile/manifest.json` | Frozen security fixture metadata | Hostile corpus inventory consumed by M9 hostile gate; keep |
| `fixtures/conformance/m9/real/evidence.json` | Evidence / reviewers | Retained real-document results consumed by M9 real gate; keep |
| `fixtures/conformance/m9/real/manifest.json` | Frozen fixture/provenance metadata | Licensed real-document ledger consumed by M9 real gate; keep |

## Findings and applied decisions

- Stable public names replace leading M8/M9 filenames; milestone provenance
  remains in headings, content, or evidence identifiers.
- `README.md` and `ROADMAP.md` previously described M9 as incomplete; both now
  reflect demonstrated M0–M9 completion and point to the cumulative gate.
- `SETUP-WSL.md` described `git archive HEAD`, while the gate freezes the staged
  tree; the wording now matches the executable behavior.
- The SBOM document's license link resolved inside `docs/`; it now targets the
  root `LICENSE` correctly.
- The operational manual previously pointed at an ignored local `guide.md` and
  assumed MCP payload routing. It now points only to tracked policy/audit docs
  and provides one shared human/agent quick-start path.
- No new documentation gate was added. Existing consumers were updated in
  place, and the cumulative M9 workflow remains the final executable authority.
