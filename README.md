# ipe-mcp

`ipe-mcp` is a local-first, host-agnostic MCP server for creating,
editing, validating, and rendering editable [Ipe](https://ipe.otfried.org/)
documents and presentations through AI agents.

Licensed under the MIT License (Copyright (c) 2026 Michael Piccirilli); see
[`LICENSE`](./LICENSE).

The project combines a versioned semantic document model with deterministic Ipe
XML and native Ipe validation. Its baseline is Ipe 7.2.30 and XML format
`70218`. The initial target environment is Ubuntu 26.04 on WSL.

> [!IMPORTANT]
> The local MVP and milestones M0–M9 are complete. They cover contracts,
> conformance, semantic authoring, transactional persistence, layout, native
> validation/render/export, the stdio MCP server, host integration, hardening,
> and the audited release candidate. M10 has approved and implemented a thin
> local npm package candidate; registry publication and the other post-MVP
> extensions remain separate future actions.

## Goals

- Give agents semantic operations for pages, layers, views, objects, styles,
  layout, reveals, and export without requiring them to manipulate raw XML.
- Preserve editability and supported Ipe content across parse, mutation, save,
  native reload, and recovery.
- Keep layers, drawing order, and presentation views as separate concepts.
- Make every mutation revision-safe, atomic, validated, and recoverable.
- Support Codex and other MCP hosts through host-neutral contracts.
- Produce `.ipe`, PDF, and raster preview artifacts with explicit validation
  and compatibility diagnostics.

## Current Status

| Milestone | Scope | Status |
|---|---|---|
| M0 | Contracts, ADRs, and compatibility baseline | Complete |
| M1 | Ipe conformance laboratory | Complete |
| M2 | Semantic IR, XML, and transactional persistence | Complete |
| M3 | Coordinates and layout | Complete |
| [M4](https://github.com/Mik1810/ipe-mcp/issues/1) | Objects, geometry, text, assets, and styles | Complete |
| [M5](https://github.com/Mik1810/ipe-mcp/issues/2) | Pages, layers, views, and slide composition | Complete |
| [M6](https://github.com/Mik1810/ipe-mcp/issues/3) | Native validation, rendering, and export | Complete ([details](./docs/milestones/core-m6.md)) |
| [M7](https://github.com/Mik1810/ipe-mcp/issues/4) | Reveal, motion, scrolling, and viewer matrix | Complete ([details](./docs/milestones/core-m7.md), [matrix](./docs/reference/viewer-effects-m7.md)) |
| [M8](https://github.com/Mik1810/ipe-mcp/issues/5) | MCP stdio server and host integration | Complete ([details](./docs/milestones/core-m8.md)) |
| [M9](https://github.com/Mik1810/ipe-mcp/issues/6) | Hardening and MVP release candidate | Complete ([audit](./docs/milestones/core-m9-completion.md)) |
| [M10](https://github.com/Mik1810/ipe-mcp/issues/7) | Post-MVP extensions and distribution | In progress ([distribution ADR](./docs/adr/0005-distribution-versioning-and-native-dependencies.md)) |

See the [roadmap](./ROADMAP.md) for the complete scope, gates, risks, and design
decisions.

## Architecture

The implementation is organized around a few strict boundaries:

```text
Agent or MCP host
        |
        v
Semantic operations and layout
        |
        v
Versioned document IR
        |
        +--> transactional session and sidecar
        |
        v
Deterministic Ipe XML codec
        |
        v
Ipe 7.2.30 native validation, rendering, and export
```

The normal API exposes typed document operations rather than arbitrary XML.
Native Ipe tools remain the authority for behaviors that cannot be validated
structurally, including style resolution, LaTeX, rendering, and export.

Key source areas:

- `src/domain`: semantic IR, schemas, validation, and stable identities;
- `src/ipe/xml`: deterministic parser, projector, and serializer;
- `src/persistence`: bounded reads, atomic writes, sessions, snapshots, and
  sidecars;
- `src/layout`: coordinate spaces, matrices, anchors, constraints, layout, and
  connectors;
- `fixtures/conformance`: documents and golden data used against native Ipe.

## Requirements

- Node.js 20 or later;
- npm;
- Ipe 7.2.30 for the supported full-validation path;
- pdfLaTeX for text compilation and native rendering workflows.

The verified environment uses Ubuntu's `ipe 7.2.30-1build2` package on Ubuntu
26.04 WSL. Follow [SETUP-WSL.md](./SETUP-WSL.md) for installation and native-tool
verification.

## Development Setup

```bash
git clone https://github.com/Mik1810/ipe-mcp.git
cd ipe-mcp
npm ci
npm run build
npm test
```

The package metadata is `1.0.0-rc.1` and can produce a gated local tarball, but
nothing has been published to npm or released on GitHub. Run
`npm run check:m10:package` for the clean tarball install and native stdio
smoke. See [package installation](./docs/guides/package-installation.md) and
[host integration](./docs/guides/host-integration.md).

## Verification

For the current M10 package candidate, run the stable tests, the cumulative
M8 behavior gate, and the package gate:

```bash
npm test
npm run check:m8
npm run check:m10:package
```

The M9 completion gate and `docs/reference/sbom.json` are frozen evidence for
the `0.1.0` candidate. `scripts/check-m9.sh` intentionally audits that frozen
product boundary and is not the current M10 product-surface gate. Individual
M9 component gates remain useful where their historical inputs are explicit;
the package gate generates and checks `docs/reference/package-sbom.json` for
the current version. M1 also supports an optional source-build lane:

```bash
IPE_M1_SOURCE_BIN_DIR=/path/to/ipe/build/bin bash scripts/gates/check-m1.sh
```

Without that variable, the verified Ubuntu package is used and the optional
source lane is reported as skipped.

## Compatibility Modes

The design distinguishes three explicit modes:

- **structural-only**: parse, inspect, and generate with structural diagnostics,
  without claiming native verification;
- **full 7.2.30**: the supported release path with native validation;
- **nightly 7.3.x**: experimental compatibility, never used to rewrite a stable
  document without consent.

See [docs/compatibility-modes.md](./docs/reference/compatibility-modes.md) for the precise
capability and failure matrix.

## Documentation

- [docs/README.md](./docs/README.md): documentation map and lifecycle;
- [ROADMAP.md](./ROADMAP.md): architecture, milestones, gates, and future work;
- [docs/adr](./docs/adr): accepted architecture decisions;
- [docs/conformance-m1.md](./docs/reference/conformance-m1.md): native conformance lab;
- [docs/milestones/core-m2.md](./docs/milestones/core-m2.md): IR, XML, identity, and persistence;
- [docs/milestones/core-m3.md](./docs/milestones/core-m3.md): coordinates and layout;
- [docs/milestones/core-m7.md](./docs/milestones/core-m7.md): bounded discrete animation and handout policies;
- [docs/milestones/core-m8.md](./docs/milestones/core-m8.md): MCP stdio contracts, resources, and verification;
- [docs/guides/host-integration.md](./docs/guides/host-integration.md): Codex, Inspector, VS Code, and independent-host operation;
- [docs/guides/package-installation.md](./docs/guides/package-installation.md): thin npm candidate contents, native prerequisites, installation, and rollback;
- [docs/reference/package-sbom.json](./docs/reference/package-sbom.json): deterministic CycloneDX inventory for the current npm candidate;
- [docs/audits/agentic-harness-audit.md](./docs/audits/agentic-harness-audit.md): itemized Issue #8 dispositions;
- [docs/guides/agent-manual.md](./docs/guides/agent-manual.md): the complete agent operational
  manual, examples, and troubleshooting;
- [docs/guides/support-policy.md](./docs/guides/support-policy.md): support policy and
  supported/degraded/warn/reject mode matrix;
- [docs/releases/release-notes.md](./docs/releases/release-notes.md): M9 release notes,
  migration guidance, and rollback procedure;
- [docs/milestones/core-m9-sbom.md](./docs/milestones/core-m9-sbom.md): SBOM, license inventory, and the
  GPL subprocess boundary for the local release candidate;
- [docs/milestones/core-m9-real.md](./docs/milestones/core-m9-real.md): licensed real-document
  review with provenance ledger and findings;
- [docs/viewer-effects-m7.md](./docs/reference/viewer-effects-m7.md): conservative M7 viewer/effect matrix;
- [report-source.md](./report-source.md): source dossier and traceability.

## Project Principles

- Never mutate the original document before an explicit save.
- Treat every top-level object layer and every serialization-sensitive default
  explicitly.
- Validate semantically and with native Ipe; a file merely opening is not a
  sufficient gate.
- Preserve unknown supported content whenever possible and report any degraded
  behavior.
- Keep protocol contracts independent of Codex-specific prompts, skills, or UI
  directives.
