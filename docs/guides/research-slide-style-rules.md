# Visual style for research presentations

A research slide should make its current job visible. A definition needs a
clear boundary around the statement and its assumptions. A worked example
needs a way to follow the same object through several representations. A
proof needs the claim, the current inference and the conclusion in an order
the audience can follow. The examples below are generic patterns for
authoring and reviewing Ipe presentations.

## Keep an anchor during a reveal

Keep a persistent title, baseline, grid or diagram in place while new content
appears. In a worked example, start with the instance, reveal the choice,
then show the updated state on the same geometry. In a proof, keep the
claim visible while introducing the steps that establish it. A section
opener or a deliberate layout reset can use a different anchor.

A title declared persistent can be checked by the harness. Review the
other anchors visually across successive views. When an anchor moves,
check what the audience needs to find again and whether the move has a
clear purpose. See [heading checks and review procedure](research-slide-style.md).

## Use shape and position to show structure

- **Panels.** Give a definition, theorem or key observation a light
  background when the audience will need to find it again. Keep the
  derivation or explanation outside the panel. Gray can distinguish a
  code sample from prose. A separate panel can identify a reusable
  technique when it needs to stand out from the running example.
- **Boundaries and braces.** Use an enclosing contour to show which
  objects belong to a group or set. A brace alongside consecutive lines
  of pseudocode can attach a cost to the whole block. Check where the
  boundary starts and ends.
- **Shapes that carry data.** Bars on a common axis can encode duration,
  while edges can encode connectivity. Keep scales and spacing consistent
  across the views where those properties carry meaning. Place labels
  close to the data they identify.

## Make the function of colour readable

Reuse a colour when the same object appears in multiple places. If a path
in an original tree becomes a single edge in a compressed tree, repeat
its colour and preserve enough structure to trace the correspondence.

Use shape, position or text alongside colour when it indicates a change
of state. A border can select a cell, a cross can reject a branch, and
fading can retain an inactive option for comparison. The same red can
serve all three purposes. Check that the mark's target is clear and that
any label the audience still needs remains legible. In monochrome diagrams,
position, repeated patterns and distinct contours can provide the same
kind of correspondence.

## Give arrows a clear source, destination and meaning

A directed edge can carry a message between actors, point from a note to a
term, connect an earlier representation to a later one, or trace a path
through an example. Place each endpoint close enough to identify its
referent. Keep labels beside their own arrows and check crossings for
ambiguous paths. A plain connector can associate a note with an item when
direction plays no role.

Check the arrowheads against the action described in the text. For example,
a dynamic-programming table can show the resulting path in forward order
while the algorithm reconstructs it backwards. A caption can specify
which direction the displayed arrows represent.

## Build the figure around the reasoning

Give the viewer a stable representation to follow. Keep actors in their
places while message arrows appear. Keep the tree or array fixed while
nodes, paths or cells are highlighted. When a transformation changes the
representation itself, put the before and after states in comparable
positions and preserve visible correspondences where possible. Treat icons
as labels for roles or objects the audience needs to recognize.

## Review the rendered sequence

1. Identify the slide's job and the object or statement that anchors it.
2. Compare consecutive views. Record which elements appeared, disappeared,
   moved or changed colour. Check whether a reveal introduces a new step
   or clarifies a correspondence.
3. Follow every consequential arrow and annotation to its target. Read
   formulas, subscripts and dense code at presentation size.
4. Review overlaps in context. A cross over a rejected alternative can
   be intentional. Verify that the audience can still identify the
   alternative and the surviving choice. Record the pair and the reason
   if the harness needs an exception.

The heading anchor has an automatic check. Arrow semantics, colour
assignments, legibility and the usefulness of drawings are review
judgements. See the [style review rubric](research-slide-style.md#review-by-role)
and [slide-quality harness](slide-quality-harness.md).

## Evidence and scope

The reference corpus has 45 decks and 5,028 physical PDF pages. All pages
were rendered. The review followed 285 pages across five complete decks
in PDF order and opened selected details individually. For persistent
headings, measured displacement was 0 PDF points across 56 calibration
and 78 holdout transitions. The grouping was inferred for flattened decks.

A separate stratified sample added 1,005 pages from the other 40 decks,
with 714 ISNS pages and 291 LPAA pages. These were reviewed as contact
sheet thumbnails, with seven individual raster inspections and 72
illustrative observations. The sample expands the examples of the visual
patterns above. Estimating their prevalence or checking reveal order and
fine legibility requires further review.

At this checkpoint, 3,738 pages remain unviewed. A further 1,005 pages have
thumbnail review and remain outside the sequential review. Reference
PDFs, renders and page-level evidence are kept in a private local workspace.
