# Research slide style review

Use this extension with the [slide-quality harness](slide-quality-harness.md).
Review the role and intent of each slide before choosing any style checks.
A title slide, a worked example and a proof each give the audience a different
task.

See [visual style for research presentations](research-slide-style-rules.md)
for authoring patterns and the scope of the evidence.

## Check a persistent heading

In the review JSON, add an optional `stableHeadings` array. Each entry
names a one-based logical `slide` with at least two views and the exact text of
its persistent, single-line heading. Specify text as extracted from the PDF.
Whitespace is collapsed. The heading must occur on exactly one extracted
line per view.

```json
{
  "stableHeadings": [
    {
      "slide": 1,
      "text": "Read the diagram",
      "intentionalMoves": [
        { "view": 3, "reason": "A deliberate change of the title anchor." }
      ]
    }
  ]
}
```

Compare the upper-left corner of the extracted line on consecutive views
of that slide. `HEADING_ANCHOR_SHIFT` means at least one axis moved by more than
1 PDF point (bp). The report records signed deltas with right and down
positive, the two physical PDF page numbers, the slide/view location and both
view PNGs. A declared move applies only to the transition entering that
view. A missing or ambiguous line produces `HEADING_ANCHOR_UNOBSERVABLE`
with the match count and its view PNG. Check the extraction or omit the
expectation and review the visual manually for multiline, outlined or
deliberately changing headings.

The observed displacement was 0 bp across 43 ISNS and 13 LPAA calibration
transitions labelled as same-slide reveals. An additional whole deck from
each course had 64 ISNS and 14 LPAA such transitions with 0 bp observed
displacement. These results come from four flattened decks with manually
inferred boundaries. The 1 bp tolerance allows small extraction or rendering
differences. The sample cannot establish a general visual threshold or
estimate sensitivity to real defects. Identical heading text can span
several logical slides, and a section opener may move its title between slides.

## Review by role

For each finding, give the logical slide and view, a PNG or crop, what
changed relative to the previous relevant view, and the consequence for the
audience. Use **meets**, **revise**, or **blocking**. Record the role and
reason when accepting an exception.

| Role or decision | Compare and decide |
| --- | --- |
| Opening or section break | Can the audience identify the new topic immediately? Compare other openers for hierarchy and pacing. A centred title and a nearly empty canvas can be appropriate here. |
| Definition or statement | Can the viewer locate the defined object, hypotheses and conclusion? Check the first occurrence of each symbol and follow it into the first example. |
| Worked example | Can the viewer trace each value from the data to its location in the figure or calculation? Compare before and after the reveal, including labels, colour and position. |
| Algorithm or code | Can the viewer find the current step, branches and inputs? Check indentation and reading order. Inspect the densest view at projection size, including small comments and formula subscripts. |
| Proof | Identify the claim, premise and inference in the visible order. Follow corresponding terms between equations. Check whether side notes or colour highlights help locate those terms and leave them readable. |
| Alignment and spacing | Compare slides with the same role. Check recurring left edges and gaps between blocks. Open both the sparsest and densest views to distinguish reserved space for later reveals from a layout defect. |
| Colour and overlap | Determine which element the mark refers to. A cross over a rejected option can be intentional when the option remains identifiable and the surviving choice is clear. Use the existing per-view `intentionalOverlaps` only for reviewed pairs. |
| Reveal and transition | Compare successive renders, then the script. Record additions, removals, colour changes, strikes and motion. Check which objects provide orientation and whether the audience can follow a replacement or reset. |

Typography, density, notation, formula legibility, colour semantics and
narrative order require visual review. Bounding boxes can find candidate
collisions, and text extraction can locate an anchor. Their output alone
cannot determine whether text or an equation can be read from the audience.

## Review shapes, colour and diagrams

Record the mark's role before scoring it. Compare the view where it first
appears with the previous view and the view where it is used or removed.

| Visual device | What to inspect |
| --- | --- |
| Panels, braces and outlines | Point to what the boundary groups. Check whether the heading, claim, code or cost can be located at a glance. Verify that the boundary includes the right objects and that the notation stays legible. |
| Data shapes and diagram structure | Identify which visual property encodes the data, such as interval length or gate connectivity. Check that the scale, labels and geometry agree. Recheck these anchors when new values appear. |
| Directed arrows | Trace the source and destination. Identify whether the arrow represents a transfer, a change of state or a reference. On a reveal, check which connection is added, replaced or removed. |
| Callouts and connectors | Trace the note to the exact term, item or line it explains. Check for ambiguous endpoints, crossings and detours that make the reference difficult to follow. |
| Colour for identity or state | Look for a stable reference across text and figure, then for deliberate changes such as a tint, outline, fade or cross. Use the shape, label and position to confirm whether the mark signals selection, rejection or a reference. |
| Drawings and icons | Identify the actor, object or relation that the drawing makes visible. Check when labels and links appear, whether the diagram is readable without guessing, and whether decorative detail competes with the current step. |

Palette, arrow direction and shape semantics are manual criteria. The overlap
check identifies candidate intersections. Review the actual rendered mark and
its target before allowing an intentional pair.

## Replay the original fixture

Run from the checkout with the native Ipe and Poppler dependencies installed.
The directory created by `mktemp` must be outside Git.

```bash
npm run build
work=$(mktemp -d)
cp fixtures/decks/reveal-heading.json "$work/spec.json"
cp fixtures/decks/reveal-heading.review.json "$work/review.json"
node scripts/harness/run-slide-quality.mjs \
  --spec "$work/spec.json" --review "$work/review.json" --out "$work/accepted"

node -e 'const r = require(process.argv[1]); r.stableHeadings[0].intentionalMoves = []; console.log(JSON.stringify(r))' \
  "$work/review.json" > "$work/defect.json"
node scripts/harness/run-slide-quality.mjs \
  --spec "$work/spec.json" --review "$work/defect.json" --out "$work/defect"
```

Both routes compare two transitions. The first stays in place and the
second moves by 184 bp horizontally. The accepted run permits the declared
move. The defect run should exit 1 with a single `HEADING_ANCHOR_SHIFT` on
each route, at slide 1 view 3, and evidence for views 2 and 3. The
automatic outcome and human review status are separate.
