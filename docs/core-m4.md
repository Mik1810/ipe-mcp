# M4 object-authoring core

M4 is the typed object and style layer above the M0–M3 document, XML, persistence, and layout contracts. It compiles the five native object types (`path`, `text`, `image`, `group`, and `use`) into Ipe XML 70218 while preserving persistent identities and explicit asset/symbol references.

## Conformance corpus

`fixtures/conformance/m4/manifest.json` is executable golden data. Its path matrix names every public `PathSpec` kind: point, segment, polyline, polygon, rectangle, rounded rectangle, circle, ellipse, arc, quadratic and cubic Bézier, open and closed uniform splines, cardinal and Catmull–Rom splines, clothoids, compound paths, and structured raw paths. Typed open uniform splines lower to Ipe's current `c` operator; the raw case separately preserves historical `s` coverage alongside the supported `m`, `l`, `c`, `a`, `C`, `L`, `h`, `e`, and `u` operators. The golden also contains label and minipage text, symbol and group references, clipping, arrows, fill rules, gradients, tiling, PNG alpha, and JPEG DCT assets.

The gate checks the operator sequence for each primitive, not only object or token counts. It checks the semantic payload before native normalization and compares identities, object order, text payloads, style attributes, and bitmap reference semantics after native reload. Native Ipe may reorder stylesheet definitions, renumber bitmap IDs, or expand some curve forms; these are accepted only when the semantic checks still pass.

Raw XML `path` payloads are validated at the shared object-content boundary before a builder, domain validation, serializer, or mutation can accept them. Non-empty payloads use ASCII whitespace only (bytes `<= 0x20`), finite project-domain numeric operands, and the Ipe 70218 operators `m`, `l`, `c`, `q`, `a`, `C`, `L`, `h`, `e`, `u`, or historical `s`. Native arity/state is mirrored: `l` and `a` consume exactly one segment/arc record; `c`, `q`, `s`, and `L` consume one or more coordinate pairs; `C` consumes one or more pairs plus one tension; and `e`/`u` may terminate an already-open curve. Arc/ellipse matrices use the same non-singular relative tolerance as document matrices. Empty payloads and native's single trailing `m` compatibility form remain supported, while `m h`, consecutive moves, abandoned empty subpaths before another command, invalid `L *` marker positions, prose, unknown operators, malformed/truncated commands, Unicode whitespace, XML-invalid controls, and trailing operands are rejected before native Ipe can abort or silently canonicalize them.

## Gate command

Run from the repository root:

```bash
bash scripts/check-m4.sh
```

The gate runs `check-m3.sh`, which includes the M0, M1, and M2 gates, then runs the TypeScript build and the complete Vitest suite. It validates the committed golden as corpus data, generates an independent compiler probe below a temporary directory, checks its exact top-level object manifest and identities, canonicalizes the generated output twice for a fixed-point check, reloads that generated output through Ipe 7.2.30, and runs `Document:checkStyle()` before and after reload. PDF text/page structure plus SVG and PNG output for every generated page are verified. Temporary outputs are removed when the command exits and no gate artifact is written into the repository.

The full lane requires the installed Ipe package and its `ipetoipe`, `iperender`, and `ipescript` helpers. The gate requires Ipe 7.2.30 and XML writer version 70218; a structural-only environment is not an M4 pass. `pdflatex` is invoked by Ipe's renderer for the complex text fixture, subject to the host's existing local TeX installation.

## Boundaries

M4 owns typed object builders, atomic object operations, z-order, style definitions and cascade checks, bitmap validation/deduplication and placement, structured clipping, symbol/group references, and bounded text builders. PNG IHDR dimensions and JPEG SOF dimensions are preflighted before decoding; JPEG entropy is validated with the pinned pure-JS decoder under the effective pixel limit and a 512 MiB default decoder-memory limit (`BitmapLimits.maxDecoderMemoryMB` can lower it). Top-level `x-ipe-mcp-id` is advisory because native Ipe may remove it; when an object ID is independent from editable `custom`, the serializer carries the ID in the reserved native-preserved `custom="ipe-mcp:object-id:<object-id>|<custom>"` envelope. Grouping fails closed when per-child object references cannot be preserved. LaTeX sandboxing and complete `runLatex` orchestration are M6 concerns. Page/layer/view APIs and slide composition are M5 concerns. Distribution, npm packaging, remote execution, and Ipe 7.3.x APIs are outside this milestone.

Native reload is an acceptance probe, not a replacement serializer: the deterministic server XML remains the persisted representation. Features that native Ipe normalizes are compared semantically and are not silently promoted to lossless byte preservation.
