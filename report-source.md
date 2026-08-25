# Ipe MCP — technical source dossier

Status: preliminary roadmap study, no implementation.
Verification date: 2026-08-24.

This document preserves the evidence motivating the roadmap. Product conclusions and execution phases are in `ROADMAP.md`.

## 1. Baseline and compatibility

| Topic | Evidence | Resulting decision | Confidence |
|---|---|---|---|
| Stable release | GitHub marks [`v7.2.30`](https://github.com/otfried/ipe/releases/tag/v7.2.30) as the latest release; it is a source-only mini-release. | Normative and test baseline: Ipe 7.2.30. | High |
| Public binaries | The upstream page still mostly exposes 7.2.29 binaries; Ubuntu 26.04 instead provides package `7.2.30-1build2`, verified in the project's WSL environment. | Ubuntu 26.04/WSL is the MVP platform; 7.2.29 smoke tests are for external compatibility only. | High |
| Future development | The `master` branch identifies itself as 7.3.1 but is not a stable release. | Separate nightly/allowed-failure compatibility; no 7.3.x API in the MVP. | High |
| XML version | In 7.2.30 `IPELIB_VERSION` is 70230, but `FILE_FORMAT` is 70218 and the writer uses the latter. | The generated root must have `version="70218"`; never derive it from the release. | High |
| Open format | The [format manual](https://github.com/otfried/ipe/blob/v7.2.30/manual/90_file_format.rst) explicitly states that external applications can create Ipe XML. | Direct XML generation is a supported strategy. | High |

## 2. Coordinates, pages, and transformations

- Native units are PostScript/PDF points (`bp`), i.e. 1/72 inch. The x-axis grows to the right and the y-axis upward. Source: [snapping and units](https://github.com/otfried/ipe/blob/v7.2.30/manual/40_snapping.rst).
- `<layout paper="W H" origin="ox oy" frame="Fw Fh">` distinguishes paper and frame. `origin` is the lower-left corner of the frame in the paper coordinate system; the frame is a guide, not a clipping path. Source: [layout in the format](https://github.com/otfried/ipe/blob/v7.2.30/manual/90_file_format.rst).
- An XML matrix `[a b c d s t]` applies `x' = a·x + c·y + s`, `y' = b·x + d·y + t`. `lhs * rhs` applies `rhs` first; the visual composition is therefore, conceptually, `matrixViewLayer * matrixObject * puntoLocale`. Sources: [format](https://github.com/otfried/ipe/blob/v7.2.30/manual/90_file_format.rst), [Ipelib geometry](https://github.com/otfried/ipe/blob/v7.2.30/src/include/ipegeo.h).
- Non-finite or singular matrices are not sufficiently prohibited by the format; native inversion assumes a non-zero determinant. The server must reject them and define a tested tolerance.
- The PDF `MediaBox` corresponds to the paper; `CropBox` is optional and depends on `crop` and the calculated bounding box. Source: [PDF writer](https://github.com/otfried/ipe/blob/v7.2.30/src/ipelib/ipepdfwriter.cpp).

API consequence: the default space will be `frame`, while `paper`, normalized coordinates, and exact Ipe points will also be supported. Every conversion ends in bp with a y-up axis.

## 3. Document, pages, layers, views, and visual order

### XML document

- Canonical root order: `info?`, `preamble?`, bitmaps and stylesheets, then pages. Sources: [DTD](https://github.com/otfried/ipe/blob/v7.2.30/doc/ipe.dtd), [format](https://github.com/otfried/ipe/blob/v7.2.30/manual/90_file_format.rst).
- Stylesheets cascade: the last included stylesheet has highest priority; the built-in standard style is at the base.
- The Ipe parser is not a generic XML parser: no namespaces, some empty forms require canonical serialization, and unknown attributes may be lost after saving in Ipe.
- DTD and runtime do not always coincide. Observed examples: the DTD requires at least one page but the parser may accept zero; `active` is formally mandatory but may be inferred; the DTD default for `view marked` is not applied by the custom parser.

Decision: layered validation — safe XML, consultative DTD, stricter semantic invariants, load/round-trip with Ipelib, LaTeX, export, and render. No single level is sufficient.

### Pages and layers

- A page contains metadata, notes, layers, views, and a global object sequence. Every top-level object belongs to a layer.
- **The layer does not determine z-order.** Stacking derives from the global object sequence; layer order and visual order are orthogonal. The renderer traverses the sequence in ascending order: the first object is farther back, the last farther forward; appending therefore brings an object to the front. Sources: [concepts](https://github.com/otfried/ipe/blob/v7.2.30/manual/20_concepts.rst), [Page](https://github.com/otfried/ipe/blob/v7.2.30/src/ipelib/ipepage.cpp), [canvas](https://github.com/otfried/ipe/blob/v7.2.30/src/ipecanvas/ipecanvas.cpp), [Front/Back actions](https://github.com/otfried/ipe/blob/v7.2.30/src/ipe/lua/actions.lua).
- If layers/views are missing, Ipe synthesizes them, but the behavior has edge cases involving locked layers and the active layer. The generator must always produce at least one explicit layer and one explicit view.
- An object's `layer` attribute may be inherited statefully. To remove ambiguity, every generated top-level object will have an explicit layer.
- Layer names must be unique, contain no spaces, and resolve for every reference.
- Reserved names with special semantics: `BBOX`, `VIEWBBOX`, `NOPDF`, `BACKGROUND`, `GRID`, plus the internal `EDIT-GROUP*` family. The server exposes them only through intentional operations.

### View

- A view contains visible layers, the active layer, and optionally a name, marked state, effect, symbolic maps, and layer transformations. Each view produces a distinct PDF page. Source: [presentations](https://github.com/otfried/ipe/blob/v7.2.30/manual/70_presentations.rst).
- The active layer is used for editing and positioning new objects; it controls neither visibility nor z-order.
- Per-view maps may remap only supported symbolic values defined in the stylesheet.
- Per-view layer transformations are experimental. Hit testing, bounding boxes, and link annotations may remain at their original positions. They are therefore not the default robust mechanism for movement.
- Normally all views share the union bounding box. `BBOX` stabilizes it; `VIEWBBOX`, when visible, requests a view-specific bbox. Automatic titles, page numbers, and per-view transformations are not included in all bbox calculations.
- The generator will always serialize `active` and `marked` explicitly to avoid DTD/runtime differences.

### Presentation metadata

- The page title is drawn in every view through the style, outside the layers.
- Section and subsection feed PDF bookmarks and destinations; names must be unique when used as destinations.
- Notes are plain text per page and are shown by IpePresenter. Sources: [presentations](https://github.com/otfried/ipe/blob/v7.2.30/manual/70_presentations.rst), [PDF writer](https://github.com/otfried/ipe/blob/v7.2.30/src/ipelib/ipepdfwriter.cpp).

## 4. Objects, shapes, and styles

The five native types are `path`, `text`, `image`, `group`, and symbol reference (`use`). Main source: [objects](https://github.com/otfried/ipe/blob/v7.2.30/manual/30_objects.rst).

### Paths and geometry

The path language supports:

- segments and polylines (`m`, `l`);
- closing (`h`) and compound paths with holes;
- uniform/quadratic/cubic splines (`c`, including deprecated historical forms);
- ellipses as an affine image of the unit circle (`e`);
- elliptical arcs (`a`);
- cardinal splines (`C`);
- clothoid/spiro (`L`);
- closed uniform splines (`u`).

The high-level IR will not expose this grammar directly. It will offer segment, polyline, polygon, rectangle, rounded rectangle, circle, ellipse, arc, quadratic/cubic Bézier, uniform/cardinal spline, clothoid, compound path, and connector; a deterministic compiler will lower them to an Ipe path.

The following must be preserved: open/closed path state, orientation, winding/even-odd fill rule, cap/join, arrows, degeneracies, tolerances, and stroke bounding box.

### Text

- `label`: reference point and alignment; dimensions depend on the LaTeX pass.
- `minipage`: fixed width and development downward from the upper edge.
- Content is a LaTeX fragment; the preamble and packages affect metrics and output.

Consequence: accurate layout requires two bounded passes — provisional layout, LaTeX compilation/dimension update, dependency resolution, and at most one controlled rerun.

### Images, groups, and symbols

- Ipe stores JPEG as DCT; other raster formats may be embedded as compressed bitmaps. The image rectangle determines its placement.
- Assets must be deduplicated by hash; crop and masking compile into groups with clipping.
- Groups may nest objects and have clipping paths, decoration, and links. Active PDF annotations have constraints on top-level groups.
- Symbols reside in stylesheets and are instantiated with `use`; allowed parameters are encoded in the symbolic name/definition.
- Stroke, fill, pen, dash, cap, join, fill rule, arrows, opacity, gradients, and tiling are part of the style model. Source: [stylesheet](https://github.com/otfried/ipe/blob/v7.2.30/manual/60_stylesheets.rst).

### Persistent identity

The runtime parser supports a `custom` attribute, although it is not fully described by the DTD. The plan uses short XML-safe tokens `ipe-mcp:<uuid>` for objects created by the server, preserving existing custom values. Rich metadata and provenance will live in an optional `.ipe-mcp.json` sidecar; no exclusive reliance will be placed on `x-*` extensions without a round-trip experiment.

## 5. Animations, reveals, and scrolling

Ipe has no continuous timeline or temporal object interpolation. Native primitives are:

1. incremental reveals through cumulative layer visibility in views;
2. per-view remapping of symbolic attributes;
3. experimental discrete transformation of entire layers per view;
4. PDF transition between the current and next page/view.

The PDF effects available in runtime 7.2.30 number 28: Normal; Split H/V in/out; Blinds H/V; Box in/out; Wipe in four directions; Dissolve; Glitter; Fly in/out; Push; Cover; Uncover; Fade. Rendering depends on the viewer. IpePresenter navigates between PDF pages and does not guarantee interpolation of PDF effects.

### Scrolling strategies

| Strategy | Mechanism | Advantages | Limitations | Intended use |
|---|---|---|---|---|
| View + copies | Object/layer variants at discrete positions | Robust, controllable bbox and links | Larger file | MVP default |
| View + transform | Per-view matrix on the layer | Compact, natural for offsets | Experimental; inconsistent bbox/hit/link | Opt-in with warning |
| PDF transition | Push/wipe between views | Simple for an entire slide | Viewer-dependent, does not move individual objects | Decorative |
| External video | Continuous render through a dedicated pipeline | Real fluid motion | No longer a native Ipe presentation | Future module |

An internally scrollable region requires fixed clipping/masks or precomputed duplication: a transform applied to the group would also move its clip. The high-level operation must therefore declare axis, initial/final offset, step count or logical duration, easing, clipping region, strategy, and target viewer.

External reference, spike only: Anna Henriksson, *Animations in Ipe Presentations* (TU Wien, 2025), [PDF thesis](https://www.ac.tuwien.ac.at/bachthes/ba_thesis_ah-mn-2025-03-08.pdf), describes an Ipe → Manim → video pipeline. It is not a candidate dependency until code, license, and reproducibility are verified.

## 6. MCP choices and agent integration

- Protocol baseline: stable MCP specification [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25), not the subsequent release candidate.
- MVP transport: stdio. The [transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) requires stdout to contain only MCP messages; logs go to stderr.
- Official TypeScript SDK v2, ESM, Zod v4, Node 20+: [server guide](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server).
- Tool contracts with input/output schemas, `structuredContent`, readable errors, and links/resources for large artifacts: [tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- Codex shares MCP configuration across app, CLI, and extension and supports stdio and Streamable HTTP servers: [Codex MCP documentation](https://developers.openai.com/codex/mcp).

Decision: standalone, local-first, host-agnostic package; Codex adapter/plugin optional, not a core requirement.

## 7. Validation and security

Planned pipeline:

1. parameter schemas and finite numeric values;
2. IR invariants;
3. well-formed XML with external entities disabled;
4. consultative DTD check;
5. parse and round-trip with Ipelib/Ipe CLI;
6. stylesheet check;
7. LaTeX compilation;
8. PDF export;
9. PNG rendering of requested views;
10. structural and visual checks for blank pages, bbox, clips, overflow, and fonts.

Text and the LaTeX preamble are executable in a broad sense: compilation must take place in an isolated temporary directory, without shell escape, with time/memory/process limits, controlled `TEXINPUTS`, and an explicit package policy. No arbitrary command tool will be exposed.

Paths will be limited to authorized roots after symlink resolution. Changes will use working copies, optimistic revisions, atomic batches, temp+rename writes, and recoverable snapshots.

## 8. Gaps to close with conformance prototypes

| Gap | Required experiment | Closure criterion |
|---|---|---|
| ID/metadata round-trip | Save and reopen `custom` and `x-*` with Ipe 7.2.30 | ID strategy survives without loss of user data |
| Exact z-order | Overlapping fixture with XML order, front/back UI, and export | Semantics documented and golden-tested |
| Bbox and crop | `BBOX`/`VIEWBBOX` matrix, title, links, and transform | PDF/PNG consistent for every view |
| PDF effects | Viewer matrix: IpePresenter, Acrobat, Okular/Evince, pdfpc, browser | Support declared per effect/viewer |
| Two-pass text | Label/minipage with different fonts, formulas, and packages | Layout converges within a defined limit |
| Boundary matrices | Property tests for inverse/composition and determinant | Numerically justified, stable tolerance |
| 7.3.x | Nightly on `master` | Divergences reported without blocking stable |

## 9. Main primary sources

- [Ipe release 7.2.30](https://github.com/otfried/ipe/releases/tag/v7.2.30)
- [Official Ipe repository](https://github.com/otfried/ipe)
- [Official PDF manual](https://ipe.otfried.org/ipe-manual.pdf)
- [XML format 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/90_file_format.rst)
- [Presentations 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/70_presentations.rst)
- [Objects 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/30_objects.rst)
- [Concepts and layers 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/20_concepts.rst)
- [Snapping and coordinates 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/40_snapping.rst)
- [Stylesheet 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/60_stylesheets.rst)
- [Command-line programs 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/94_commandline_programs.rst)
- [DTD 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/doc/ipe.dtd)
- [Lua/Ipelib bindings](https://github.com/otfried/ipe/blob/v7.2.30/src/ipelua/bindings.txt)
- [IpePresenter](https://ipepresenter.otfried.org/)
- [MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Codex and MCP](https://developers.openai.com/codex/mcp)
