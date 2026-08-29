# MVP Release Notes, Migration, and Rollback

This is the milestone-frozen M9 release-candidate record for version `0.1.0`.

This document covers the M9 release candidate (`ipe-mcp` v0.1.0, contract
`ipe-mcp/1`): what is delivered, its security limits, compatibility and known
limits, what is deferred to M10, how to migrate an existing installation, and
how to roll back. It is the release companion of
[`support-policy.md`](../guides/support-policy.md) (the support contract) and
[`core-m9-limits.md`](../milestones/core-m9-limits.md) (the single stated
limits table). There is **no automatic migration of user data**: nothing in
this candidate rewrites a source document, moves files, or migrates state
unless you explicitly run the documented recovery/restore actions.

## 1. What is delivered (release notes)

### 1.1 Behavior

- MCP stdio server, contract `ipe-mcp/1` (protocol-only stdout; diagnostics in
  stderr, redacted), name `ipe-mcp`, version `0.1.0`.
- Thirteen tools: `ipe_orientation`, `ipe_get_capabilities`,
  `ipe_create_document`, `ipe_open_document`, `ipe_inspect`,
  `ipe_apply_operations`, `ipe_compose_slide`, `ipe_build_views`,
  `ipe_validate`, `ipe_render_preview`, `ipe_save_document`,
  `ipe_export_document`, `ipe_history`.
- Ipe documents as XML (format `70218`), full round trip, working-copy
  semantics: the source is never mutated before an explicit save.
- Composition: 16:9 slides, coordinates/anchor/layout, text, images, groups,
  symbols, geometric paths, layers plus independent z-order, pages/views
  CRUD + reorder.
- Reveals and discrete scrolling (`ipe_build_views`) with fallback semantics;
  layer transforms only with explicit BBOX (warn otherwise, copies by
  default).
- Validation chain: XML → Ipelib → styles → LaTeX (minimal pdfLaTeX profile)
  → PDF → preview raster; every `verify`-level claim is backed by a concrete
  check, never by a skip.
- Atomic save/export; snapshots, undo/restore/recover through `ipe_history`
  with `confirmation: "RESTORE"`.
- Resources: document summaries/diagnostics, previews and artifacts behind
  `resource_link`; binary bytes only on explicit read; artifacts are
  connection-local.
- Three runtime modes with distinct semantics: `structural-only` (no native),
  `full-7.2.30` (recommended), `nightly-7.3.x` (probes only; never a write
  target without consent).
- Hosts exercised: MCP stdio (portable scenario), Codex, MCP Inspector 2.4.0,
  VS Code / SDK client (`@modelcontextprotocol/client`).

### 1.2 Security limits (summary, enforced before allocation)

Full table: [`core-m9-limits.md`](../milestones/core-m9-limits.md); the same
values are served to clients by `ipe_orientation` (`limits`) and
`ipe_get_capabilities`.

| Surface | Ceiling |
|---|---|
| Document shape | 512 pages, 256 layers/page, 512 views/page, 100k objects, 10k assets |
| XML parse | 16 MiB source, depth 128, 500k nodes, 10k attributes |
| Native jobs | 30 s timeout, 2 GiB memory, 256 KiB output, 64 MiB files |
| Assets | PNG/JPEG; 64 MiB input, 100M pixels, 512 MiB decoder memory |
| Animation | 64 views, 512 copies, 1000 PDF pages |
| MCP contract | 64 ops/batch, 500 inspect objects, 1000 path points, 8k LaTeX chars, 12M base64 chars |

Rejects fail before work: unsafe XML/paths, over-limit documents, unknown
bundle version, stale revisions without recovery. Errors are classified
(`LIMIT_EXCEEDED`, `REVISION_CONFLICT`, `SOURCE_CHANGED`,
`NATIVE_*_ERROR`, ...) and documented in the agent manual.

### 1.3 Compatibility

| Item | Supported version |
|---|---|
| Platform | Ubuntu 26.04 LTS on WSL2 |
| Node.js | ≥ 20 (verified 24.x) |
| Ipe | 7.2.30 (`7.2.30-1build2`, Ubuntu package); XML 70218 |
| TeX | texlive-latex-base (pdflatex) |
| Validators | poppler-utils, mupdf-tools |
| Isolation | bubblewrap 0.11.1 + prlimit |
| Lua (Ipelib) | lua5.4 |

Anything else (IPython-owned Node, pip-managed or source-built Ipe,
macOS/Windows, non-WSL Linux) is **not a supported target** for this
candidate; the M1 source-build lane (`IPE_M1_SOURCE_BIN_DIR`) is explicit,
optional, and never a supported install path.

### 1.4 Known limits

- Viewer-dependent effects (transitions, motion) are best-effort per the
  conservative viewer/effect matrix; verify on a concrete viewer.
- `structural-only` mode cannot check native style/TeX/PDF/render.
- Layer transforms without explicit BBOX warn and stay copies.
- Composed multi-layer pages: native load needs the composition sidecar for
  page name/marked identity and exact multi-view PDF mapping.
- SVG/PDF import is limited (no arbitrary LaTeX preamble; only the minimal
  allowlisted packages `amsmath`, `amssymb`, `mathtools`, `xcolor`).
- No continuous animation, no live edit of a running Ipe GUI, no remote or HTTP server,
  no bundle/marketplace distribution.

### 1.5 Deferred to M10

Distribution strategy and packaging (npm bundle/helper, marketplace/plugin
template), authenticated Streamable HTTP, the live bridge with open Ipe and
bidirectional synchronization, support/CI for non-WSL Linux/macOS/Windows,
container/devcontainer, provider-neutral agent harness, more faithful SVG/PDF
import, dedicated web presenter with real interpolation, continuous video
(after a Manim/license/fidelity spike), and adoption of a 7.3.x release as a
stable target (only after a stable release and migration tests).

## 2. Migration guidance

### 2.1 Configuration

| Variable | Default | Meaning |
|---|---|---|
| `IPE_MCP_WORKSPACE_ROOT` | `process.cwd()` | workspace root (hosted `resources` rooted here) |
| `IPE_MCP_STATE_ROOT` | `<workspace>/.ipe-mcp-state` | session manifest + snapshots |
| `IPE_MCP_NATIVE_TIMEOUT_MS` | 30 000 | native job timeout; valid 1..300000 ms |
| `IPE_M1_SOURCE_BIN_DIR` | — | optional dev lane (source-built Ipe); not supported |

Transport is stdio only: Codex uses `.codex/config.toml`, VS Code
`.vscode/mcp.json`, SDK hosts use `@modelcontextprotocol/client` directly.

### 2.2 State, repository, and sidecar layout

- `.ipe-mcp-state/` keeps `session.json` (bid per document) plus per-session
  snapshots named `snapshot-s<N>-r<revision>-<hash16>.ipe`. It is
  gitignored; delete it and history is gone. Back it up to preserve history.
- Artifacts and previews are connection-local and regenerated after restart.
- The optional sidecar follows the strict v1 schema (`schemaVersion: 1`,
  `documentId`, `sourceHash`, `revision`, `objectMetadata`,
  `layoutConstraints`). The `.ipe` never depends on the sidecar; deleting it
  loses only rich metadata and layout intent, never XML content.
- The only automatic data transform is the deterministic v0 → v1 sidecar
  migration (`migrateSidecar`), applied at sidecar load. All other changes are
  explicit: no automatic document rewrite, no automatic state migration, no
  automatic format conversion.

### 2.3 Contract and version changes

The M9 candidate keeps the `ipe-mcp/1` 13-tool contract. If you move between
candidate revisions, re-query `ipe_orientation` and `ipe_get_capabilities`
instead of relying on a saved `limits` snapshot: ceiling values, diagnostics
and `limits` are defined by the installed candidate. Batch/inspect ceilings
(64 ops, 500 inspect objects) are enforced centrally.

### 2.4 Clean rebuild

```text
git pull
npm ci
npm run build
npm test                         # full suite (>= 250 green)
bash scripts/gates/check-m9-notes.sh   # release-notes gate (includes M8 chain)
```

From a clean checkout the package manager is npm with lockfile v3; the
supported Ipe package is the Ubuntu 26.04 `7.2.30-1build2` (dpkg), verified
by `scripts/gates/check-m9-setup.sh`.

## 3. Rollback procedure

### 3.1 Roll back the server software

1. Stop the MCP server (the host session closes it; the process handles
   SIGINT/SIGTERM).
2. `git checkout <previous-revision>` (or `git revert` on the candidate
   commit) in the installation checkout.
3. `npm ci && npm run build`.
4. Restart the server; re-query capability/limit values, which may differ.

The source documents of the previous candidate remain untouched at every
step: this server only writes the workspace document the tool call saves.

### 3.2 Roll back a document edit

1. Keep the original: `ipe_open_document` works on a working copy; save with
   `ipe_save_document` to a new path (save-as) when you want to leave the
   original byte-identical.
2. Use `ipe_history` (snapshot/undo/restore/recover) with the current
   `revision`: `restore` requires `confirmation: "RESTORE"`, and every
   mutation is guarded against `REVISION_CONFLICT` (re-inspect and retry with
   the current revision) and `SOURCE_CHANGED` (reopen or save-as).
3. Snapshots live under `.ipe-mcp-state/`; restore a snapshot by its
   `snapshotId` (sequence `snapshot-s<N>...`). Never hand-edit `session.json`;
   a broken manifest is reconciled on restart.

### 3.3 Recover from a failed migration or rollback

- Uncommitted workspace changes: stop the server, copy affected `.ipe`
  sources elsewhere, then restore the git revision.
- History loss: `.ipe-mcp-state/` is revisioned with this repo; restoring the
  previous Git revision restores the annotated session manager behavior.
- If the working document diverged from the snapshot index, `ipe_history
  recover` reconciles on restart; if the divergence is structural
  (page/layer/view/object counts changed), the composition sidecar reports
  stale shape before any native write.

## 4. Not supported (for this candidate)

No data/schema migration is automatic beyond the documented v0 → v1 sidecar
load-time migration. There is no migration or rollback for: remote servers,
HTTP transport, non-WSL platforms, bundled/npm distribution, or a 7.3.x
stable target. Distribution remains an M10 decision (ADR-0004; see the
[`core-m9-sbom.md`](../milestones/core-m9-sbom.md) GPL boundary analysis).
