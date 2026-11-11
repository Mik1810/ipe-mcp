# Research presentation quality harness

The harness evaluates the deck specification produced by an assistant using
[the Ipe authoring skill](../../plugins/ipe-mcp/skills/ipe-authoring/SKILL.md).
The same version-1 specification drives the CLI and the real stdio MCP
server. The harness reuses the provider-neutral SDK transport, result parity
and artifact signature checks. The native exporter also checks each physical
PDF page against an independent render of its expected Ipe view.

## Reproduce the public run

Use the repository checkout on Linux or Ubuntu WSL with the tools in
[WSL setup](../../SETUP-WSL.md), Git, and Poppler's PDF text and raster tools.
Install repository dependencies with `npm ci` if needed.

```bash
npm run build
work=$(mktemp -d)
node scripts/harness/run-slide-quality.mjs --out "$work/positive"
node scripts/harness/run-slide-quality.mjs --negative --out "$work/negative"
# The negative run must exit 1 and identify both geometry defects on each route.
```

The [original brief and speaker script](../../fixtures/decks/odd-squares.md),
[version-1 deck spec](../../fixtures/decks/odd-squares.json), and
[view expectations](../../fixtures/decks/odd-squares.review.json) are
redistributable. Replay is deterministic with a fixed toolchain and requires
no model turn. The deck has three slides and six views. The negative variant
moves one heading over existing text on slide 1, view 2, and adds a shape
that crosses the paper edge on slide 3, view 1.
Expect `OVERLAP` and `OVERFLOW` on both routes. Depending on Poppler,
the collision may also produce `PDF_REVEAL_CONTENT` if it breaks extraction
of the rim heading. A native or infrastructure error
also exits 1, so verify the criteria and locations in `report.json`. An
input or setup error exits 2.

## Automatic evidence

- The CLI writes editable Ipe XML and a native PDF. The MCP route checks
  stdio identity and native capability, validates, saves with confirmation,
  reopens, retrieves ordered previews and exports a PDF. The resource checks
  compare media type, length, digest and file signature.
- The report checks saved layers, ordered physical PDF pages, independent text
  markers that should appear or remain hidden, and equality of the editable
  content and per-view PDF renders across the two routes. Generated object IDs
  are ignored when comparing editable XML.
- Geometry comes from Ipe's compiled text and path bounding boxes for objects
  actually visible in each view. A bounding box outside the paper is
  `overflow`. Intersecting boxes produce an `overlap candidate`. Both checks
  allow 1 bp of tolerance. Exact intentional pairs can be exempted per view
  with a reason, such as text on a panel or a shape layered over another
  shape. An unused exception is itself a finding.
- Each view has a PNG rendered from its physical PDF page. Geometry findings
  also have an SVG with the raster and highlighted region. A finding records
  the route, slide, view, criterion, evidence filename, and object indices or
  region when available. Failures before a view exists carry null locations
  or evidence as applicable.

The overlap check is conservative. Axis-aligned bounds can intersect even
when painted regions do not, and stroke padding approximates path bounds.
Check the raster for actual occlusion and for intentional emphasis, such as
a strike-through. Text markers test sequencing and basic extractability.
They do not validate equations, typography, reading order, or the script.

## Human review

Score each criterion as **meets**, **revise**, or **blocking**. Give a
slide/view and a screenshot or crop for any finding. For missing coverage,
name the expected content and the view where it belongs. A mathematically
incorrect or missing core claim, proof step, or prerequisite is blocking.
Accept the deck after any blocking findings are resolved and the automatic
run passes.

| Criterion | Review prompt |
| --- | --- |
| Coverage | Does the deck cover the brief's motivation, result, proof, and example at an appropriate depth? |
| Notation | Are symbols defined before use, consistently interpreted, and legible in both slide and spoken explanation? |
| Statements and proofs | Are hypotheses, quantifiers and conclusions explicit? Does each proof step follow, and are examples distinguished from arguments? |
| Narrative order | Does each slide prepare the next? Does the example clarify the claim, and does the conclusion return to the original question? |
| Typography | Is the heading/body/math hierarchy legible at presentation size, with consistent emphasis and enough contrast? |
| Layout | Do the reading order, alignment, whitespace and figure labels support the message? Are intentional overlaps legible and purposeful? |
| Shapes, colour, arrows, and drawings | Can the viewer identify what a shape groups or encodes, track the same object across views, and follow each arrow to its intended target? Use the change across views to interpret an intentional cross, fade, or highlight. |
| Discrete reveals and script | Compare consecutive renders with the speaker script. Check what changes at each click, what stays in place, and whether the narration mentions elements that are visible at the right moment. |

For authoring examples, see [visual style for research presentations](research-slide-style-rules.md).
For role-specific prompts and the optional persistent-heading check, see
[research slide style review](research-slide-style.md).

## Run a private evaluation locally

Create a directory outside Git for the paper, reference slides, notes,
speaker script, and authored version-1 specification. Keep the review JSON
there too. Its `views` array lists each expected state in slide/view order.
Use one-based `slide` and `view` numbers, `layers` for the expected
visible-layer set, and plain extracted-text `present` and optional `absent`
markers. `intentionalOverlaps` is an optional list of entries with `slide`,
`view`, `objects` (two increasing one-based object positions in the slide
specification), and `reason`. Review exceptions after changing object order.

```bash
umask 077
work="$HOME/ipe-local-review"
node scripts/harness/run-slide-quality.mjs \
  --spec "$work/deck.json" \
  --review "$work/deck.review.json" \
  --out "$work/run-01"
```

The output directory must be new with an existing parent outside Git.
The runner uses local subprocesses and an isolated stdio workspace. It does
not retain raw MCP calls or echo TeX diagnostics, text markers, or local
input paths. Open the generated files locally to review them. The bundle
contains the private deck, copied input and visual evidence. Keep it and
private review notes out of Git, issues, pull requests and public logs.
Publish only redistributable fixtures and findings sanitized for publication.

This replay covers version-1 specifications up to 24 views, subject to the
native runtime's own limits. Review larger decks in sections. Reference PDFs
and the speaker script are inputs to the reviewer. The runner evaluates the
Ipe deck generated from the specification.
