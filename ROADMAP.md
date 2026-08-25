# Proposed Roadmap — MCP Server for Ipe

Status: **implementation in progress; M0–M5 completed as of 2026-08-25**.
Baseline: **stable Ipe 7.2.30**, file format `70218`.
Goal: enable Codex and other MCP agents to create, modify, verify, and render Ipe presentations without exposing them to the complexity of the XML format.

## 1. Expected Outcome

The product will be a local, host-agnostic MCP server offering two usage levels:

1. **Semantic composition**: “create a slide, arrange a title and three panels, add a diagram, build four reveals”. This is the normal path for agents.
2. **Precise control**: coordinates in Ipe points, matrices, structured paths, layers, views, and styles. This is for scientific diagrams, corrections, and round-trips.

The server will produce editable `.ipe` files, PDFs, and raster previews. Every mutation will be atomic, revisioned, validated, and recoverable. Static correctness of every view is a requirement; viewer-dependent animated effects will be explicitly declared as such.

## 2. Proposed Architectural Decisions

These are the decisions approved to start the work. The decision register is collected at the end.

| Decision | Proposal | Rationale |
|---|---|---|
| Version | Stable 7.2.30; smoke 7.2.29; nightly 7.3.1/master | Last verifiable release, without designing against unreleased code |
| Server language | TypeScript ESM, Node 20+, official MCP SDK v2, Zod v4 | Strong tool contracts, simple distribution, direct MCP support |
| MVP transport | stdio | Compatible with Codex and other hosts, minimal security surface |
| Model | Own, versioned semantic IR | Separates intent, layout, and Ipe format |
| Ipe backend | Hybrid: deterministic XML serializer + official `ipescript`/Ipelib helpers for import, sensitive mutations, canonicalization, and validation | Avoids fragile FFI without blindly reimplementing the Ipe runtime |
| State | Working-copy sessions with revision counter | Prevents overwrites and conflicts between agents |
| Layout | Frame-relative by default; paper/normalized/bp available | Natural for slides without sacrificing precision |
| Animation | Discrete views; robust copies/variants by default | The actually portable Ipe/PDF model |
| Identity | `custom="ipe-mcp:<uuid>"` + optional sidecar | Stable IDs without relying on indices or names |
| Compatibility | Strict contract and explicit serialization | DTD, manual, and parser diverge on some defaults |
| LaTeX MVP | pdfLaTeX and a minimal initial set | Reduces surface area, dependencies, and variability in the first phase |
| MVP platform | Ubuntu 26.04 on WSL, Ipe 7.2.30 from Ubuntu repositories | Matches the current environment and exact baseline |
| Distribution | Deferred to a post-MVP decision | Validate the core and local workflows first |

Direct use of C++ Ipelib remains a future alternative if tests show that `ipescript` does not cover required operations. `ipepython` is not proposed as a foundation: it is a bridge not aligned with the release and has documented iterator and packaging limitations.

## 3. Conceptual Model to Implement

```text
Document
├── metadata, preamble, stylesheets, assets
└── Page[]
    ├── title, section, subsection, notes
    ├── Layer[]                 visibility/editability/snapping
    ├── View[]                  presentation state
    │   ├── visibleLayerIds[]
    │   ├── activeLayerId
    │   ├── attributeMaps[]
    │   ├── layerTransforms{}
    │   └── transition?
    └── Object[]                single back-to-front sequence
        ├── layerId             membership, not z-order
        ├── zOrder              position in the sequence
        ├── matrix, pin, transformationMode
        └── Path | Text | Image | Group | SymbolReference
```

Mandatory constraints:

- at least one page, layer, and view;
- explicit layer on every top-level object;
- unique layer names with no whitespace;
- existing, unlocked, and normally visible active layer;
- every reference to a style, symbol, asset, layer, and object must resolve;
- first object = furthest back, last = furthest forward; append puts an object in front;
- `marked` and `active` always serialized explicitly;
- page/view names used as unique destinations;
- special Ipe names reserved and usable only through dedicated APIs.

## 4. Positions and Layout

### 4.1 Coordinate Spaces

The API must accept explicitly:

- `frame`: origin at the frame's bottom left; default;
- `paper`: origin at the paper's bottom left;
- `normalized`: `(0,0)`–`(1,1)` relative to frame or paper;
- `ipe`: exact bp points with y-up axis;
- `object-local`: local coordinates before the object's matrix.

The core converts everything to bp. The API will not implicitly invert y unless the selected space declares it. An optional UI helper may offer top-left coordinates, but must serialize them as an explicit, tested transformation.

### 4.2 Anchors and Boxes

Every object will expose:

- anchor: `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right`, `baseline-left` for text;
- logical, geometric, and visual boxes including stroke;
- position, size, rotation, scale, and transform origin;
- declarative padding and margins.

The layout will distinguish:

- **known measurements**: shapes and images with explicit dimensions;
- **deferred measurements**: LaTeX text;
- **view-dependent measurements**: transformed or selectively visible objects.

### 4.3 Layout Primitives

The semantic layer will offer:

- `place`, `move`, `resize`, `rotate`, `transform`;
- `align`, `distribute`, `center`, `fit`, `contain`, `cover`;
- `row`, `column`, `grid`, `stack` containers;
- gap, padding, min/max size, and aspect ratio;
- anchors between objects: `below`, `rightOf`, `sameWidth`, `alignBaseline`;
- frame/paper guides and safe area;
- connector that recalculates endpoints when boxes change.

No persistent parametric CAD system will be promised: Ipe saves coordinates, not constraints. The sidecar may preserve layout intent for future recomposition, while the `.ipe` remains self-contained and editable.

### 4.4 Matrices

Canonical representation `[a b c d s t]`:

```text
x' = a*x + c*y + s
y' = b*x + d*y + t
```

Composition order: `viewLayerMatrix * objectMatrix * localPoint`. The server must:

- provide semantic constructors for translate/rotate/scale/shear;
- pre-multiply consistently with `Page::transform`;
- reject NaN, infinity, and singular/nearly singular matrices;
- interpolate motion through semantic components, not element by element, to avoid unexpected shear and degeneracy;
- test composition, inversion, and round-trip with property-based testing.

## 5. Pages, Layers, and Views

### 5.1 Pages

Planned operations:

- create, duplicate, move, and delete a page;
- set title, section, subsection, notes, and marked state;
- choose layout/style and dimensions;
- clone a page while preserving or regenerating IDs;
- inspect count and mapping from Ipe pages to PDF pages produced by views.

Native notes are per-page and are replicated across all views. Per-view notes, if requested, will be MCP metadata with an explicit aggregation policy for IpePresenter.

### 5.2 Layers

Planned operations:

- add/rename/remove/reorder metadata;
- lock/unlock (`edit`) and snapping policy;
- move objects between layers without changing their z-order;
- show/hide in one or more views;
- dedicated layer for an independently animated object;
- intentional operations for `BBOX`, `VIEWBBOX`, `BACKGROUND`, `GRID`, `NOPDF`.

The layer-list order will never be used as drawing order. The server will expose `moveForward`, `moveBackward`, `bringToFront`, `sendToBack`, and insertion relative to an object ID separately.

### 5.3 Views

Planned operations:

- create from a previous view or a list of layers;
- cumulative and non-cumulative visibility;
- explicit active layer;
- marked for handouts;
- symbolic maps for color, pen, dash, opacity, symbol size, arrow size, and symbol;
- per-layer matrix with compatibility warning;
- PDF transition and integer durations for target 7.2.30;
- unique name and stable lookup through MCP ID.

Every modification will show the resulting PDF page count, making the cost of overlays explicit.

## 6. Objects and Geometric Shapes

### 6.1 Common Operations

All objects will support:

- insert, replace, duplicate, delete, group, ungroup;
- independent layer and z-order;
- matrix, pin, and transformation mode (`affine`, `rigid`, `translations`);
- style patch, link, custom ID, and sidecar metadata;
- bbox, hit region, and diagnostics;
- mutations through replace/transform or explicit bbox-cache invalidation in the native backend.

### 6.2 Geometric IR

Public primitives:

- point, segment, polyline, polygon;
- rectangle and rounded rectangle;
- circle and ellipse, including rotated ellipses;
- circular/elliptical arc through center, radii, rotation, and angles;
- quadratic/cubic Bézier;
- uniform spline, closed spline, cardinal/Catmull–Rom, clothoid/Spiro;
- compound path with holes;
- straight/orthogonal/curved connector with arrows;
- raw structured path as an advanced escape hatch, never an unvalidated postfix string in normal use.

The compiler must preserve open/closed state, fill rule, orientation, arrows, and degeneracies. Arrows are allowed only on a single open subpath; gradients/tiling require fill; an undefined symbol is an error or configurable warning.

### 6.3 Style

Planned support:

- stroke/fill, pen, dash, cap, join, winding/even-odd;
- arrow and reverse arrow;
- symbolic opacity and stroke opacity;
- axial/radial gradients;
- native linear tiling;
- pathstyle, textstyle, size, and symbols;
- stylesheet import, merge, and precedence;
- `checkStyle()` as a gate before save/export.

Absolute values will be normalized; symbolic values must exist in the cascade. Controversial DTD defaults will not be relied upon.

### 6.4 Text

Distinct APIs:

- `label`: short text/formula and baseline alignment;
- `textBox`: compiled as a minipage with width;
- `title`, `subtitle`, `body`, `caption`, `code` as style presets, not new Ipe types.

Pipeline:

1. validate/apply policy to the LaTeX fragment;
2. provisional layout;
3. compilation in a sandbox;
4. update width/height/depth;
5. resolve dependent alignments and connectors;
6. bounded second pass and explicit non-convergence error.

### 6.5 Images, Groups, and Symbols

- PNG and JPEG guaranteed; other formats explicitly converted by installable adapters.
- Bitmap deduplication by hash; policy for color profiles and alpha.
- Aspect ratio `contain|cover|stretch`; crop through a group with clip.
- SVG/PDF imported through official tools/converters and then validated, not disguised as raster images.
- Group with clip/link/decoration and internal back-to-front order.
- Symbol reference (`use`) with permitted parameters, snap points, and XForm only when compatible.

## 7. Animation, Reveal, and Scrolling

### 7.1 Honest Contract

Ipe has no continuous timeline. The server will distinguish four products:

1. **Native reveal**: layer visibility across views.
2. **Discrete motion**: intermediate states generated between views.
3. **PDF transition**: whole-page effect, viewer-dependent.
4. **Continuous video**: optional future pipeline, not part of the native `.ipe`.

No tool will call a view sequence “fluid”. The preview must be able to show every static state even when the viewer does not support transitions.

### 7.2 High-Level Operations

`buildReveal`:

- target object/layer IDs;
- order or simultaneous groups;
- cumulative/non-cumulative;
- initial and final state;
- layer creation/reuse;
- marking for handout.

`buildScroll` / `buildMotion`:

- target and x/y axis or path;
- initial and final offset/pose;
- number of steps with configurable limit;
- semantic easing;
- clipping region;
- `duplicate` strategy (default) or `layer-transform` (opt-in);
- bbox policy (`fixed`, `per-view`, `explicit`);
- target viewer and static fallback.

`setTransition`:

- typed enum of the 28 effects;
- page duration and integer transition values for 7.2.30;
- warning when the declared viewer does not support them;
- push/cover/uncover presets only for the entire slide.

### 7.3 Limits and Guardrails

- Default maximum number of views generated per operation; estimate before expansion.
- No attempt to simulate 30/60 fps in PDF.
- Dedicated layer when an object must move independently.
- Explicit `BBOX` when transformations could leave the original box.
- Fixed clip or duplication for scrollable panels; transforming the group would also move the clip.
- Automatic title and Background do not follow a camera pan: they must be materialized as objects if they need to move.
- Links, hit testing, and bbox on transformed layers generate compatibility diagnostics.

### 7.4 Viewer Compatibility Matrix

At least verify on:

| Viewer | Static views | Notes | `/Trans` | `/Dur` | Status |
|---|---:|---:|---:|---:|---|
| Ipe editor | yes | editing | n/a | n/a | automated/manual fixture |
| IpePresenter | yes | yes | not interpreted by the source | not interpreted | runtime test |
| Adobe Acrobat | yes | n/a | measure effect | measure | manual test |
| Okular/Evince | yes | n/a | measure | measure | manual test |
| pdfpc | yes | presenter | measure | measure | manual test |
| Browser PDF | yes | variable | unreliable | unreliable | manual test |

## 8. Server Architecture

### 8.1 Modules

```text
MCP adapter
├── tool schemas and resources
├── session/document manager
└── job/diagnostic facade
Domain core
├── versioned IR
├── coordinate/layout engine
├── geometry compiler
├── style and asset registry
├── page/layer/view compiler
└── animation expander
Ipe adapters
├── canonical XML parser/serializer
├── ipescript/Ipelib helper
├── LaTeX sandbox
├── export/render CLI
└── compatibility probes
Persistence
├── atomic working copies
├── history/snapshots
├── sidecar metadata
└── artifact/resource store
```

The domain core will not depend on MCP transport. `createServer()` will build the same server for stdio and, in the future, Streamable HTTP.

### 8.2 Sessions and Concurrency

- `open` creates a working copy; the original does not change until explicit `save`.
- Every mutating response returns `documentId`, `revision`, created IDs, and diagnostics.
- Every mutation accepts `expectedRevision`; a conflict is not overwritten.
- Atomic batches: either all operations pass or none is applied.
- Detection of an out-of-session source-file hash change.
- Write to temporary + rename; recoverable backup/snapshot.
- Undo/redo for semantic transactions, not individual XML writes.

### 8.3 Proposed Tool Surface

A small surface reduces incorrect model choices. Details live in typed unions.

| Tool | Mutation | Purpose |
|---|---:|---|
| `ipe_get_capabilities` | no | Versions, backend, TeX, converters, limits, and viewer profile |
| `ipe_create_document` | yes | New document from layout/style/template |
| `ipe_open_document` | no on source | Session/working copy and initial diagnostics |
| `ipe_inspect` | no | Outline, page/view, objects, styles, bbox, and IDs |
| `ipe_apply_operations` | yes | Typed batch of document/layout/geometry mutations |
| `ipe_compose_slide` | yes | High-level semantic composition |
| `ipe_build_views` | yes | Reveal, discrete motion, scrolling, and transitions |
| `ipe_validate` | no | Structural/native/latex/render levels |
| `ipe_render_preview` | no | Page/view PNG and visual diagnostics |
| `ipe_save_document` | yes on file | Atomic working-copy commit |
| `ipe_export_document` | yes on artifact | PDF, marked-view PDF, PNG/SVG where supported |
| `ipe_history` | yes/no | Revision list, undo, redo, snapshot |

`ipe_apply_operations` will not accept arbitrary XML in the normal path. Operations will be a discriminated union: document/page/layer/view/object/layout/style/asset. The raw escape hatch will be experimental, disabled by default, and still parse/round-trip validated.

### 8.4 Resources and Output

Proposed resources:

- `ipe://documents/{id}/summary`
- `ipe://documents/{id}/source`
- `ipe://documents/{id}/pages/{pageId}/views/{viewId}/preview`
- `ipe://documents/{id}/diagnostics`
- `ipe://styles/{styleId}`
- `ipe://artifacts/{artifactId}`

Requested previews return a compact PNG as a content image and a resource link to the complete artifact. `structuredContent` contains revision, dimensions, page/view mapping, IDs, and warnings. Large bitmaps/PDFs are not dumped into the model context.

### 8.5 Codex and Other Host Integration

- Project configuration in `.codex/config.toml` and concise server instructions for Codex.
- stdio with stdout reserved for the protocol and logs on stderr.
- Smoke test with Codex app/CLI, MCP Inspector, and at least one second host.
- Contracts independent of Codex-specific directives or skills.
- Streamable HTTP only after the MVP, with localhost, Origin validation, and authentication.

## 9. Validation, Security, and Degraded Modes

### 9.1 Validation Levels

| Level | Checks | Available without Ipe |
|---|---|---:|
| Schema | input/output, enum, limits, finite numbers | yes |
| IR | references, uniqueness, layer/view, z-order, styles | yes |
| XML | well-formed, canonical serializer, no XXE | yes |
| Consultative DTD | known differences excluded/versioned | optional |
| Native | load → save → reload with Ipelib | no |
| Style | `checkStyle()` | no |
| LaTeX | compilation and text metrics | no |
| Export | PDF and view/page mapping | no |
| Render | PNG, bbox, crop, clip, blank/overflow | no |

Modes:

- **structural-only**: generate/inspect but clearly mark the absence of native validation;
- **full 7.2.30**: supported release path;
- **nightly 7.3.x**: experimental compatibility, never used to rewrite a stable file without consent.

### 9.2 Security

- Allowlisted workspace root; path canonicalization and symlink verification.
- No remote URL/media by default; separate download with allowlist, size, and MIME checks.
- Limits on files, assets, pixels, objects, pages, views, and group depth.
- XML parser with DTD/external entities disabled during normal parsing.
- LaTeX in an isolated temp directory, without shell escape, network, writes outside temp, or uncontrolled `TEXINPUTS`; bounded timeout, RAM, processes, and output.
- Free preamble classified as an advanced capability and subject to policy.
- No shell tool or arbitrary command.
- Logs without complete LaTeX content, sensitive files, or binary data; redacted diagnostics.
- Future HTTP: localhost bind, Origin validation, auth, and DNS rebinding protection.

## 10. Test Strategy

### Unit and Property Tests

- matrices: composition, inverse, decomposition/interpolation;
- frame/paper/normalized conversion and anchors;
- path and arc parser/serializer;
- fill rule, orientation, arrows, and compound path;
- style cascade and per-view mapping;
- invariant generator for pages/layers/views;
- text-layout convergence.

### Golden Fixtures

- all five object types;
- every geometric primitive, including degenerate cases;
- overlapping z-order and group nesting;
- clip, link, BBOX/VIEWBBOX/crop;
- PNG/JPEG/alpha and deduplication;
- label/minipage/formulas/Unicode with declared engines;
- cumulative and arbitrary overlays;
- layer map and transform;
- marked handout and replicated notes;
- 28 PDF effects as structural fixtures.

### Round-Trip and Integration

- IR → XML → Ipelib → XML → Ipelib; semantic comparison, not byte-for-byte;
- import/edit/save of hand-created documents;
- `custom` and unknown metadata without loss;
- LaTeX → PDF → PNG of all selected views;
- view count = expected PDF pages;
- MCP Inspector and contract tests for errors/structured output;
- Codex host and another client smoke test;
- CI 7.2.30 from source, 7.2.29 binary where available, master nightly allowed-failure.

### Visual Verification

“The file opens” is not enough. Gates will include:

- non-empty render;
- objects within safe area or declared overflow;
- text not truncated;
- consistent bbox/crop across views;
- clip and link in the expected region;
- perceptual comparison with tolerance and human review of golden changes.

## 11. Milestone Execution Plan

Each milestone ends with a review gate; work does not proceed on an unaccepted structural decision.

### M0 — Contracts and ADRs

**Status: completed on 2026-08-24.** Gate demonstrated by `bash scripts/check-m0.sh` on Ipe `7.2.30-1build2`, with adversarial review and independent tests completed.

Deliverables:

- `docs/adr/0001-compatibility-baseline.md`: Ipe 7.2.30, format 70218, and 7.3.x lane;
- `docs/adr/0002-domain-model-and-layout.md`: IR, coordinates, matrices, z-order, and page/layer/view;
- `docs/adr/0003-backend-persistence-and-identifiers.md`: hybrid backend, transactions, `custom`, and sidecar;
- `docs/adr/0004-security-and-trust-boundaries.md`: canonical sections `TM-XML`, `TM-TEX`, `TM-FS`, `TM-ASSET`, `TM-PROC`, `TM-CONCURRENCY`, `TM-METADATA`, and `TM-HTTP`;
- `docs/compatibility-modes.md`: structural-only/full/nightly matrix with capability, failure mode, and diagnostic labels;
- `fixtures/conformance/manifest.json` and at least six manual `.ipe` seeds: minimal, positions/matrices, layers/views, geometry/z-order, custom metadata, text/minipage;
- `scripts/check-m0.sh`: reproducible ADR/manifest smoke test, installed version, and round-trip of every seed with `ipetoipe -xml`, using temporary output.

Gate:

- all ADRs have `Accepted` status; distribution is recorded as an approved deferral, not as a missing decision;
- the threat model contains all eight canonical IDs: XML/parser, LaTeX, filesystem/path, asset/network, native subprocess/CLI, concurrency/atomicity, metadata/sidecar, and future HTTP; every risk is linked to a future mitigation/gate;
- the matrix defines exactly what may be declared “verified” in the three modes;
- the manifest inventories the purpose, features, and invariants of every seed, without generated assets or unnecessary binaries;
- `bash scripts/check-m0.sh` verifies the eight IDs, requires `dpkg-query -W -f='${Version}' ipe` to begin with `7.2.30`, shows the detected version, and confirms root `version="70218"` before and after the round-trip;
- no ADR or seed depends on 7.3.x APIs; any 7.3.x notes are marked future/nightly.

M0/M1 boundary: M0 seeds fix the minimum cases and invariants, but do not claim to resolve native divergences. M1 implements probes, golden fixtures, and empirical decisions and may extend the corpus without retroactively changing approved contracts.

### M1 — Ipe Conformance Lab

**Status: completed on 2026-08-25.** Stable gate demonstrated by `bash scripts/check-m1.sh` on Ipe `7.2.30-1build2`, with golden fixtures, Sol adversarial review, and Luna independent tests; the source-build lane remains optional and reproducible through explicitly supplied 7.2.30 binaries.

Deliverables:

- reproducible environment with Ubuntu Ipe/`ipescript` 7.2.30 package and capability probes; source build retained as an optional CI check;
- automatic probes for DTD/runtime divergences;
- experiments with `custom`, `x-*`, z-order, bbox, links, and layer transforms;
- comparison of direct serializer versus Lua helper;
- initial viewer effects matrix.

Gate:

- ID strategy survives load/save/copy;
- visual order and controversial defaults covered by golden fixtures;
- definitive decision on which mutations require `ipescript`.

### M2 — IR, XML, and Transactional Persistence

**Status: completed on 2026-08-25.** Stable gate demonstrated by `bash scripts/check-m2.sh` on Ipe `7.2.30-1build2`: 62 tests, semantic/fixed-point/native-reload comparison of the 12 fixtures, Sol adversarial review with no P0–P2 findings, and Luna independent tests. The M1 source-build lane remains optional and was not run because `IPE_M1_SOURCE_BIN_DIR` is not configured.

Deliverables:

- versioned IR and Zod schema;
- canonical XML parser/serializer;
- document/session manager, revision, and atomic save;
- optional sidecar and schema migrations;
- structural validator.

Gate:

- semantic corpus round-trip without supported loss;
- revision conflicts and recovery tested;
- originals never mutated before save.

### M3 — Coordinates and Layout

**Status: completed on 2026-08-25.** Stable gate demonstrated by `bash scripts/check-m3.sh` on Ipe `7.2.30-1build2`: 85 total tests, 46 focused M3 tests, standard and 16:9 presentation fixtures, Sol adversarial review with no P0–P2 findings, and Luna independent tests. The M1 source-build lane remains optional and was not run because `IPE_M1_SOURCE_BIN_DIR` is not configured.

Deliverables:

- four coordinate spaces;
- anchor, box, matrix, and transform origin;
- row/column/grid/stack, align/distribute/fit;
- constraint sidecar and preliminary connectors;
- numerical property tests.

Gate:

- fixtures for standard layout and 16:9 presentation;
- no y inversion or composition error in golden fixtures;
- approved numerical-tolerance policy.

### M4 — Objects, Geometry, Text, Assets, and Styles

**Status: completed on 2026-08-25.** Stable gate demonstrated by
`bash scripts/check-m4.sh` on Ipe `7.2.30-1build2`: 137 total tests, exact
typed-primitive and object coverage, canonical and native round-trips, clean
`Document:checkStyle()`, semantic asset/reference preservation, complex LaTeX,
and two-page PDF/SVG/PNG rendering. The candidate also passed Luna independent
tests; final release evidence is recorded on the milestone issue.

Deliverables:

- CRUD and z-order for the five types;
- complete compiler for geometric primitives;
- style registry/cascade;
- PNG/JPEG, deduplication, and clipping;
- two-pass LaTeX text;
- symbol/reference and group.

Gate:

- golden fixtures for every type and primitive;
- clean `checkStyle()`;
- arrows/fill/clip/gradients and complex text natively validated.

### M5 — Pages, Layers, Views, and Slide Composition

**Status: completed on 2026-08-25.** The issue #2 gate is executable through
`bash scripts/check-m5.sh`: page/layer/view CRUD, duplication and reference
remapping, non-destructive layout-compatible templates, special-layer fixtures,
native composition-sidecar recovery, and exact multi-view PDF mapping all pass
on Ipe `7.2.30-1build2` while retaining every M0–M4 gate.

Deliverables:

- complete page/layer/view API;
- notes, section/subsection, title, and handout;
- `compose_slide` with non-destructive templates/presets;
- intentionally managed special layers;
- Ipe page/view → PDF page mapping.

Gate:

- layers and z-order remain independent in every operation;
- cumulative and arbitrary views produce the expected PDF;
- bbox/crop/title/notes pass the fixtures.

### M6 — Native Adapter, Rendering, and Export

Deliverables:

- `ipescript`, `runLatex`, `checkStyle`, and export helpers;
- LaTeX sandbox;
- per-view PNG preview and visual diagnostics;
- capability detection and structural/full/nightly modes.

Gate:

- a full document passes all validation levels;
- TeX timeouts/errors do not corrupt the session;
- reproducible CI output.

### M7 — Reveal, Motion, and Scrolling

Deliverables:

- reveal builder;
- motion/scroll with copies and opt-in layer transform;
- bbox/clip policy and expansion limits;
- effects enum and viewer warnings;
- animation handout.

Gate:

- every view is statically correct;
- tests for scrollable panel and camera pan;
- IpePresenter is not declared compatible with effects it ignores;
- published viewer matrix.

### M8 — MCP stdio Server

Deliverables:

- tool surface, resources, structured output, and error taxonomy;
- server instructions and Codex configuration;
- MCP Inspector, Codex, and second host;
- preview/resource links without saturating context.

Gate:

- end-to-end scenario from prompt to `.ipe`/PDF/PNG;
- distinguishable and revision-safe mutating tools;
- protocol-only stdout and safe logs.

### M9 — Hardening and Release

Deliverables:

- limits, fuzz/property tests, and hostile corpus;
- reproducible local procedure on Ubuntu 26.04 WSL;
- verification of the Ubuntu Ipe 7.2.30 package and required capabilities;
- agent manual, examples, and troubleshooting;
- SBOM, licenses, and support policy.

Gate:

- stable suite green on Ubuntu 26.04 WSL;
- clean and repeatable local installation;
- no open critical threat-model finding;
- release candidate reviewed with real decks.

### M10 — Post-MVP Extensions

- authenticated Streamable HTTP;
- live bridge with open Ipe and bidirectional synchronization;
- distribution strategy, npm packaging, and installable bundle/helper;
- support and CI for non-WSL Linux, macOS, and Windows;
- container/devcontainer if still useful after local validation;
- Codex marketplace/plugin template;
- provider-neutral agent harness for repeatable create/edit/validate/export
  scenarios, regression evaluation, and end-to-end artifact inspection;
- thin host adapters and capability discovery for Codex and other MCP-capable
  agents, keeping shared scenarios, expected outcomes, and diagnostics independent
  of vendor-specific prompts, skills, or UI directives;
- more faithful SVG/PDF import;
- dedicated web presenter with real interpolation;
- continuous video, only after a Manim/licenses/fidelity spike;
- adoption of 7.3.x only after a stable release and migration tests.

#### Future Agent Harness

The post-MVP harness should exercise the system from an agent's request through
the produced `.ipe`, PDF, preview, diagnostics, and mutation history. Scenarios
should be declarative and replayable, with deterministic fixtures, capability
requirements, bounded execution, machine-readable results, and retained artifacts
for adversarial or human review.

The harness should define a small adapter contract rather than encode Codex
behavior in the scenarios. A Codex adapter may be the first implementation, but
other MCP-capable agents and hosts should be able to provide prompts, tool-call
transcripts, approvals, and resource retrieval through the same contract. Vendor
extensions may add richer checks without changing the portable baseline.

Future acceptance criteria:

- the same core scenario suite runs through Codex and at least one independent
  agent or MCP host;
- results distinguish agent-planning failures, protocol failures, server
  diagnostics, native Ipe failures, and artifact-quality failures;
- conformance is based on semantic and visual outcomes, not exact prose or an
  exact tool-call sequence;
- secrets, local paths, model-specific reasoning, and proprietary transcript
  fields are excluded or redacted from portable result bundles;
- adding an agent requires an adapter and capability declaration, not a fork of
  the scenario corpus.

## 12. MVP Definition of Done

The MVP is complete only when an agent can:

1. create or open an Ipe document without altering the original;
2. compose a 16:9 slide using coordinates/anchor/layout;
3. insert and modify text, images, groups, symbols, and all basic geometric shapes;
4. control layers and z-order separately;
5. create pages and views, reveals, and discrete scrolling with robust fallback;
6. validate XML, Ipelib, styles, LaTeX, PDF, and preview;
7. visually inspect every view;
8. atomically save `.ipe` and export PDF/PNG;
9. undo a transaction or recover the previous snapshot;
10. run the same workflow from Codex and at least one other MCP host.

The following are not part of the MVP: live editing of the Ipe GUI, continuous animation in `.ipe`, universal guarantee of PDF transitions, public remote server, arbitrary LaTeX preamble without sandboxing, support based on unreleased 7.3.x.

## 13. Main Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Manual/DTD/runtime diverge | formally valid but semantically incorrect file | strict contract, explicit values, Ipelib conformance suite |
| Upstream 7.2.30 is source-only and distro packages may diverge | non-uniform installation/version outside the initial environment | pin and capability probe of Ubuntu 26.04 package; distribution strategy deferred |
| Untrusted LaTeX | read/write or DoS | sandbox and package/preamble policy |
| Experimental layer transform | incorrect bbox/links/editing | default copies, warning, and explicit BBOX |
| Too many views | huge PDF and slowness | estimate, limits, and handout |
| Complex-file round-trip | loss of unknown features | working copy, semantic diff, native canonicalization, backup |
| Viewer differences | animation not reproduced | static correctness and viewer matrix |
| Metadata IDs lost | objects cannot be updated | tested `custom` + sidecar/fingerprint |
| Text changes layout after TeX | overlap/truncation | bounded two passes and diagnostics |
| FFI/native ABI | fragile distribution | `ipescript` subprocess; C++ only if necessary |
| Ipe GPLv3 license | distribution constraints | legal/license review before bundling; subprocess boundary |

## 14. Approved Decision Register

| # | Decision | Outcome 2026-08-24 |
|---:|---|---|
| 1 | MVP scope | Create + edit + render/export |
| 2 | Backend | Deterministic XML + `ipescript` hybrid; C++ Ipelib remains future fallback |
| 3 | Ipe dependency | Structural-only mode allowed; Ipe 7.2.30 required for “verified” output |
| 4 | Layout | `frame`/y-up default; explicit top-left helper |
| 5 | Animation | Default copies/variants; opt-in layer transform |
| 6 | Scrolling | Both internal panels and whole-composition pan included |
| 7 | LaTeX | Minimal pdfLaTeX profile in MVP |
| 8 | Metadata | `custom` IDs + optional sidecar approved |
| 9 | Distribution | Decision deferred until after local MVP validation |
| 10 | Initial platform | Ubuntu 26.04 WSL; other platforms post-MVP |

## 15. Sources and Traceability

The detailed dossier, including contradictions, limitations, and experimental gaps, is in [`report-source.md`](./report-source.md). The primary normative sources are the [Ipe 7.2.30 release](https://github.com/otfried/ipe/releases/tag/v7.2.30), the [official manual](https://ipe.otfried.org/ipe-manual.pdf), the [tag sources](https://github.com/otfried/ipe/tree/v7.2.30), the [stable MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25), and the [Codex MCP documentation](https://developers.openai.com/codex/mcp).
