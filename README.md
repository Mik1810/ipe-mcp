# ipe-mcp

`ipe-mcp` is a local-first, host-agnostic MCP server in development for creating,
editing, validating, and rendering editable [Ipe](https://ipe.otfried.org/)
documents and presentations through AI agents.

Licensed under the MIT License (Copyright (c) 2026 Michael Piccirilli); see
[`LICENSE`](./LICENSE).

The project combines a versioned semantic document model with deterministic Ipe
XML and native Ipe validation. Its baseline is Ipe 7.2.30 and XML format
`70218`. The initial target environment is Ubuntu 26.04 on WSL.

> [!IMPORTANT]
> This repository is pre-MVP. Milestones M0–M8 are complete, covering the
> compatibility contracts, conformance lab, semantic IR, transactional
> persistence, layout, object authoring, slide composition, and the controlled
> native validation/render/export adapter, plus the stdio MCP server and host
> integration. Packaging and the release candidate remain M9 work.

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
| [M9](https://github.com/Mik1810/ipe-mcp/issues/6) | Hardening and MVP release candidate | Planned |
| [M10](https://github.com/Mik1810/ipe-mcp/issues/7) | Post-MVP extensions and distribution | Future |

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

The normal API will expose typed document operations rather than arbitrary XML.
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

The package remains private/unpublished, but M8 provides the local `ipe-mcp`
stdio executable after `npm run build`. See [host integration](./docs/guides/m8-host-integration.md).

## Verification

Run the milestone gates from the repository root:

```bash
bash scripts/gates/check-m0.sh
bash scripts/gates/check-m1.sh
bash scripts/gates/check-m2.sh
bash scripts/gates/check-m3.sh
bash scripts/gates/check-m8.sh
```

The gates build on one another and cover structural checks, native Ipe
round-trips, semantic fixed points, persistence, numerical behavior, and layout
fixtures. M1 also supports an optional source-build lane:

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

- [ROADMAP.md](./ROADMAP.md): architecture, milestones, gates, and future work;
- [docs/adr](./docs/adr): accepted architecture decisions;
- [docs/conformance-m1.md](./docs/reference/conformance-m1.md): native conformance lab;
- [docs/milestones/core-m2.md](./docs/milestones/core-m2.md): IR, XML, identity, and persistence;
- [docs/milestones/core-m3.md](./docs/milestones/core-m3.md): coordinates and layout;
- [docs/milestones/core-m7.md](./docs/milestones/core-m7.md): bounded discrete animation and handout policies;
- [docs/milestones/core-m8.md](./docs/milestones/core-m8.md): MCP stdio contracts, resources, and verification;
- [docs/m8-host-integration.md](./docs/guides/m8-host-integration.md): Codex, Inspector, VS Code, and independent-host operation;
- [docs/m8-agentic-harness-audit.md](./docs/guides/m8-agentic-harness-audit.md): itemized Issue #8 dispositions;
- [docs/guides/m9-agent-manual.md](./docs/guides/m9-agent-manual.md): the complete agent operational
  manual, examples, and troubleshooting;
- [docs/guides/support-policy.md](./docs/guides/support-policy.md): support policy and
  supported/degraded/warn/reject mode matrix;
- [docs/milestones/core-m9-sbom.md](./docs/milestones/core-m9-sbom.md): SBOM, license inventory, and the
  GPL subprocess boundary for the local release candidate;
- [docs/viewer-effects-m7.md](./docs/reference/viewer-effects-m7.md): conservative M7 viewer/effect matrix;
- [report-source.md](./report-source.md): source dossier and traceability;
- [ORCHESTRATOR_PROMPT.md](./ORCHESTRATOR_PROMPT.md): milestone execution and
  review protocol.

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
