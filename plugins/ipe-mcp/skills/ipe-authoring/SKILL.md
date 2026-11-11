---
name: ipe-authoring
description: Create, edit, and visually review Ipe drawings and research slide decks, including diagrams and progressive reveals. Use Ipe MCP to validate and export PDF or PNG, or use the local deck CLI to generate a new deck.
---

## MCP workflow

Start with `ipe_orientation` and `ipe_get_capabilities`. Use the detected capability mode to decide whether native validation and export are available.

Create or open the document and inspect its current revision, page, layer, and view IDs. Use the IDs returned by Ipe MCP and pass the current revision with every mutation. For presentations, compose pages and add views for progressive reveals. Preview the relevant views when native rendering is available.

Use structural validation before saving. For PDF or PNG, validate and export through Ipe MCP, then retrieve the requested resource. Save to the agreed path inside the configured workspace. Honor the server's explicit confirmations for save, delete, undo, and restore. If validation fails, use its diagnostics to correct the document or explain the limitation.

## Research slide authoring and review

Apply these principles when composing slides through MCP or the local CLI.

- Identify the slide's role. Group a statement and its assumptions, show
  how objects correspond in a worked example, and keep the claim visible
  while revealing the steps of a proof.
- Keep a useful reference in place between views, such as the title,
  baseline, grid, or diagram. Change it when the explanation calls for a
  different representation or a new section.
- Give shapes a role, such as a panel around a statement or a brace
  that groups pseudocode. Reuse colours to help the audience track the
  same object. When colour signals a state change, use a border, cross,
  label, or position to clarify the state. Give arrows clear endpoints
  and a direction that matches the action they depict.
- When previews are available, compare the views before and after each
  relevant reveal. Check what appeared, disappeared, moved, or changed
  colour. Follow annotations to their targets and read formulas and code
  at presentation size. A cross over a rejected option can be intentional
  if its target and the surviving choice are clear.

Declare a persistent heading in `stableHeadings` when using the slide-quality
harness to check its position. Review visual meaning and legibility in the
renders. In a source checkout, see the
[style principles](../../../../docs/guides/research-slide-style-rules.md)
and [review rubric](../../../../docs/guides/research-slide-style.md).

## Local deck specification

When asked to author a new deck with the local CLI, first outline the slides
in order and identify each mathematical label, its position, and the click
at which it should appear. Preserve notation and hypotheses from the source.
Keep private inputs and specifications derived from them in the local document
workspace.

Write one JSON object with `version: 1`, `preset: "16:9"` or `"standard"`,
an optional `title`, and an ordered `slides` array. Give each slide a list
of layer names in `layers`, ordered arrays of visible layer names in `views`,
and back-to-front `objects`. The first name in each view is the active
layer. Repeat earlier layers in successive views for cumulative reveals.

Use typed `add_text`, `add_rectangle`, `add_segment`, or `add_path` objects
with a `layer` name in place of MCP page and layer IDs. Use native paths for
diagrams and LaTeX-backed text for mathematical labels. For example, an
`add_text` object on the `content` layer can use `Count: $x^2$` as its
`text` and `{"x": 80, "y": 600}` as its `position`. Keep a short
slide/view outline to check the generated output against. See the
[local deck format](../../../../docs/guides/package-installation.md#local-deck-command)
and the [original lattice-path fixture](../../../../fixtures/decks/lattice-paths.json).

Run `ipe-mcp-cli <spec.json> --out <deck.ipe>`. Add `--pdf <deck.pdf>` for
native validation and PDF export, then verify that the PDF follows the outline
with one page per view.
