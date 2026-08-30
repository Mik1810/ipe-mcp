# ADR-0006 — Provider-Neutral Scenario Harness

- Status: **Accepted**
- Date: 2026-08-30
- Decision and implementation issue: [#28](https://github.com/Mik1810/ipe-mcp/issues/28)

## Context

M8 and the provisional M10 package gate exercise Ipe through the official MCP
SDK, but each host script owns a hard-coded sequence and a bespoke evidence
shape. That proves a particular integration while making it difficult to replay
the same intent through another agent or host. Exact prompts, prose, IDs, and
tool-call order are not portable conformance criteria.

The M10 harness must preserve the M0-M9 safety and native validation baseline,
support deterministic regression runs, and produce evidence suitable for
retention without exposing host-private data.

## Decision

The harness uses two versioned JSON contracts:

1. a **scenario** describes requirements, bounded execution, semantic task
   intent, explicit approval decisions, and semantic/visual assertions;
2. a **result bundle** records adapter identity, capability mode, sanitized
   transcript events, diagnostics, mutation history, artifacts, assertions,
   and one classified failure when the run fails.

Both contracts start at `schemaVersion: 1`. The executable strict schemas are
defined with Zod in `scripts/harness/schema.mjs`; generated JSON Schema files
are committed with the representative fixture. Cross-field rules, including
matching requested/asserted artifacts and granted write approvals, are enforced
by the executable schema because JSON Schema export cannot represent every Zod
refinement.

The portable scenario describes a `create-edit-validate-export` intent and its
desired document/artifact outcomes. It does not prescribe an exact MCP tool-call
sequence. An adapter translates that intent into host actions and returns only
the portable contract. Adding a host therefore requires an adapter and a
capability declaration, not a fork of the scenario corpus.

## Bounds

The runner owns hard global ceilings for total duration, individual tool-call
duration, steps, transcript entries, artifacts, and retained artifact bytes.
A scenario must declare every limit and may only choose values at or below the
global ceiling. A timeout aborts the adapter connection. Limit failures are
classified as `harness` failures and cannot be confused with product behavior.

## Failure Taxonomy

Runtime results distinguish:

- `agent-planning`: the agent cannot produce or follow a valid plan;
- `protocol`: MCP initialization, parity, transport, or resource retrieval;
- `server`: structured server diagnostics outside the native boundary;
- `native-ipe`: Ipe, TeX, render, or export failures;
- `artifact-quality`: produced semantic or visual evidence is invalid.

`harness` is reserved for invalid setup, bounds, schema, or result portability.
The official SDK stdio adapter has no planning phase, but the result contract
retains `agent-planning` for agent adapters without changing the schema.

## Privacy and Portability

Portable transcripts contain only a sequence number, event kind, public tool or
resource role, outcome, and bounded public error code. They never contain raw
arguments, prompts, resource URIs, local paths, environment values, model
reasoning, proprietary transcript fields, or credentials.

Diagnostics are bounded and structurally redacted. Artifacts are retained in a
caller-owned temporary directory, while the result records only kind, media
type, byte size, SHA-256, and allowlisted semantic observations. Local artifact
paths are excluded. Artifact hashes are evidence, not golden equality criteria;
semantic and visual observations determine conformance because server-owned IDs
may legitimately change binary bytes.

## Versioning

- Backward-compatible optional result or scenario vocabulary may be added
  without changing `schemaVersion` only when strict v1 readers already accept
  it; otherwise it requires a new schema version.
- Renaming/removing fields, changing meanings, relaxing privacy, changing
  approval semantics, or changing failure-stage meaning requires v2.
- Product SemVer, `ipe-mcp/1`, Ipe XML `70218`, native Ipe `7.2.30`, and harness
  schema v1 remain independent version axes.
- A future reader may dispatch by `schemaVersion`; there is no implicit
  migration or best-effort acceptance of an unknown version.

## Initial Adapter and Scenario

The first adapter uses the official TypeScript MCP SDK over stdio. It verifies
server identity, contract/capability discovery, text/structured parity, absence
of network listeners, bounded calls, and redacted stderr. The representative
scenario creates a 16:9 document, adds a rectangle, exercises stale-write
rejection plus undo/snapshot restore, validates natively, saves, renders a
preview, and exports PDF and PNG.

This adapter is a deterministic independent host, not evidence that a Codex or
another planning agent passes the same scenario. Those host adapters remain
separate M10 work and will reuse the scenario unchanged.

## Consequences

- The M10 packaging gate can replace its provisional bespoke smoke with this
  runner while executing the CLI installed from the clean tarball.
- Retained bundles are reviewable and bounded but intentionally omit host-private
  debugging detail; private adapter logs, if a host keeps them, are not portable
  evidence.
- New task kinds require an adapter capability and schema evolution review.

## MCP Harness Compliance

- `model-facing-contract`: strict scenario/result contracts and failure stages.
- `orientation-and-dynamic-behavior`: contract/capability requirements and
  state-aware stale-write recovery.
- `result-quality-and-recovery`: semantic/visual assertions, diagnostics,
  history, and artifacts.
- `transport-integration-and-privacy`: stdio, bounds, listener check, redaction,
  and portable-field allowlists.
- `code-architecture-and-verification`: scenarios, runner, and host adapters are
  separate modules with a reproducible gate.

## Approval Record

The owner approved the semantic scenario/adapter separation and implementation
direction in the issue #28 working session on 2026-08-30.
