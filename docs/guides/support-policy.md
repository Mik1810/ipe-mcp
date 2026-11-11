# Support Policy and Mode Matrix

This living policy describes the supported local MVP baseline established by
M9; future releases must update it when the support surface changes.

This is the support contract for the local MVP release candidate. It states
what the candidate **supports**, what it **degrades** (still works with
documented loss), what it **warns** about, and what it **rejects**. The three
runtime modes are defined normatively in
[`compatibility-modes.md`](../reference/compatibility-modes.md); viewer and
effect wording is defined in
[`viewer-effects-m7.md`](../reference/viewer-effects-m7.md). This document
does not add support outside its declared matrix.

## Distribution Status

The M9 source-checkout candidate remains the historical `0.1.0` baseline.
ADR-0005 approves a thin npm helper, and the repository now builds the local
`1.0.0-rc.1` tarball candidate. No package has been published. The packaged
lane is supported only for a tarball that passes `check-m10-package.sh`; a
successful `npm install` alone is not verification.

The approved package contains only the JavaScript stdio server and essential
metadata/documentation. Users or system administrators remain responsible for
installing Node.js and the native packages below. Package installation must not
install native programs, change global MCP configuration, migrate documents or
state, start HTTP, or enable telemetry. See
[`ADR-0005`](../adr/0005-distribution-versioning-and-native-dependencies.md)
and the approved
[`versioning policy`](./versioning-and-releases.md). Installation instructions
are in [`package-installation.md`](./package-installation.md).

## Modes

| Mode | Runtime | Supported | Degraded | Warn | Reject |
|---|---|---|---|---|---|
| `structural-only` | no Ipe installed | create/open, author, structural validate, save, history, structural resources | no native style/TeX/PDF/render | `STRUCTURAL_ONLY_UNVERIFIED_NATIVE`; `get_capabilities` diagnostics | nothing native; never claims verification |
| `full-7.2.30` | Ipe 7.2.30 package | everything in the MVP | viewer-dependent effects best-effort; layer transforms need explicit BBOX | classified native errors and viewer compatibility warnings | format ≠ 70218, unsafe XML/paths/images, over-limit documents |
| `nightly-7.3.x` | 7.3.x package | probes only; does not rewrite a stable file without consent | separate divergence lane; never claims full-7.2.30 | `NIGHTLY_DIVERGENCE` | used as a stable write target without consent |

The platform lanes below define the scope of native support. Marketplace
publication and HTTP are outside this MVP matrix.

## Platform and runtime expectations

| Item | Supported | Provenance |
|---|---|---|
| Platform | Ubuntu 26.04 LTS on WSL2 (`microsoft-standard-WSL2`) | `SETUP-WSL.md`, `check-m9-setup.sh` |
| Native Linux CI | Ubuntu 26.04 LTS amd64, headless GitHub-hosted VM | [ADR-0011](../adr/0011-native-linux-qualification.md), [qualification run](https://github.com/Mik1810/ipe-mcp/actions/runs/43049327279) |
| Node.js | ≥ 20 (verified 24.x) | `package.json` engines, setup gate |
| npm | lockfile v3; `npm ci` + build | setup gate snapshot |
| Ipe | `7.2.30-1build2` (Ubuntu package) | dpkg + capability probe |
| TeX | `texlive-latex-base` (pdflatex) | package ownership probe |
| Renderers/validators | `poppler-utils` (pdfinfo/pdftoppm), `mupdf-tools` (mutool) | provenance in `check-m9-setup.sh` |
| Isolation | `bubblewrap` 0.11.1 + `prlimit` | attested in `process.ts` |
| Lua (Ipelib) | `lua5.4` | package inventory (SBOM) |

The native Linux lane covers the source checkout and a clean install of the
tarball built from the qualified revision. The run used GitHub runner image
`20261101.186.1`, Linux `7.0.0-1019-azure`, Ubuntu Ipe `7.2.30-1build2`,
Bubblewrap `0.11.1-1ubuntu0.3` and Node.js 24. Install the Ubuntu packages
`ipe`, `lua5.4`, `texlive-latex-base`, `texlive-latex-recommended`,
`poppler-utils`, `mupdf-tools`, `bubblewrap` and `util-linux` for this
lane. Ipe's colour fixtures exercise `xcolor` from
`texlive-latex-recommended`.

The run verified load, save, reopen, render and export for the supported
70218 fixtures and the portable SDK stdio scenario. The licensed document
corpus retains the same classified limits as the WSL baseline. Desktop
integration, macOS, Windows outside WSL, and other Linux releases and
architectures require separate qualification. The optional M1 source-build
lane (`IPE_M1_SOURCE_BIN_DIR`) remains an experimental check.

## Document expectations

| Item | Supported | Degraded | Warn / Reject |
|---|---|---|---|
| XML format | 70218 (Ipe 7.2.30) | — | wrong version, entity/doctype, namespaces → reject |
| Pages/layers/views | full CRUD + reorder; up to 512/256/512 | — | over-limit mutation → `LIMIT_EXCEEDED`, rolled back |
| Objects | paths (all M4 kinds), text, image, group/use, symbols | layer-transform semantics without explicit BBOX → warn | raw XML input, dangling references → reject |
| Assets | PNG/JPEG bounded decode, dedup | — | over-budget pixels/bytes → reject before allocation |
| Anonymous/imported content | round-trip lossless for supported surfaces | unknown root extensions reported as diagnostics | unsupported object XML reported and preserved |

## Host and transport expectations

| Host | Supported | Evidence |
|---|---|---|
| MCP stdio | `ipe-mcp/1` contract, text/structured parity | `check-m8` portable scenario |
| Codex | project config `.codex/config.toml`, real stdio | host integration docs |
| MCP Inspector | 2.4.0 real launcher/remote-session | host integration docs |
| VS Code / SDK host | `.vscode/mcp.json`, `@modelcontextprotocol/client` | host integration docs |
| Other MCP hosts | host-neutral contract, protocol-only stdout | design; no per-host token |
| Local npm tarball | `1.0.0-rc.1`, exact allowlisted artifact | `check-m10-package.sh` clean install and provider-neutral stdio/native scenario |

Resources: documents (summary/source/diagnostics) bounded, previews and
artifacts behind `resource_link`, binary bytes only on explicit read. Artifacts
are connection-local; regenerate after restart.

## Failure semantics

- **Rejected before work**: unsafe or over-budget input, stale revision,
  missing confirmation, path escapes, identifiers that do not exist.
- **Degraded, still usable**: `structural-only` (no native), viewer-dependent
  effects (`ignored`/`untested`/`degraded` per viewer matrix), layer transforms
  without BBOX (`warn`).
- **Recoverable**: `NATIVE_TIMEOUT`, `NATIVE_RESOURCE_LIMIT`, `NATIVE_*_ERROR`
  are classified; retry after reducing complexity is appropriate.
- **Not recoverable by retry**: `REVISION_CONFLICT` (inspect and retry with the
  current revision), `SOURCE_CHANGED` (reopen or save-as), `LIMIT_EXCEEDED`
  (reduce the document), `NATIVE_LOAD_ERROR` view/layer mapping on composed
  multi-layer pages (restructure the composition).

## When "verified" may be claimed

`verified` is only the lane's own word: `structural verified` for
structural-only, `full-7.2.30 verified` for the full lane after every level and
a confirmed 70218 root before/after the round trip, `nightly verified` only
for a passed 7.3.x corpus. It is never emitted for a skipped, simulated or
missing check, and never for a viewer-dependent behavior or for a 7.3.x API as
an MVP commitment.

## Terminology

- **Supported**: exercised, pinned, and part of the MVP promise.
- **Degraded**: works statically but with documented loss.
- **Warn**: classified diagnostic; user/agent should adjust before proceeding.
- **Reject**: fails safely with no write; to be fixed, not retried blindly.

This policy is technical and operational, not a legal or market-positioning
statement. ADR-0005 records the owner's accepted license boundary. Registry
publication remains blocked by a separate explicit owner authorization; the M9
SBOM boundary analysis remains the historical inventory and the package gate
generates and audits the current candidate
[`package-sbom.json`](../reference/package-sbom.json).
