# M5 pages, layers, views, and composition

M5 exposes typed page, layer, and view CRUD in `src/composition/index.ts`. Mutations are validated and committed atomically. A page owns layers, views, and one global object sequence; layer membership never changes object z-order.

Views make visibility and the active layer explicit. `createCumulativeView` and `createArbitraryView` are opt-in operations; no view matrix is generated implicitly. `markHandout` controls the explicit `marked` flag used by handout selection. Reserved layers still require `intentional: true`.

`composeSlide` creates a page without rewriting existing objects and records either the `standard` or `16:9` preset. The preset must match the document's effective global Ipe layout (paper, origin, and frame); incompatible layouts are rejected atomically. A `template` supplies complete layers, views, and objects; all copied IDs and object custom identities are regenerated, and typed references are remapped. `mapPdfPages` deterministically assigns one PDF page to each page/view pair, while `estimatePdfExpansion` reports the resulting expansion before export. Export, native adapters, previews, and reveal/motion remain M6/M7 concerns.

Page and view destination renames change only typed IR names. Internal links represented by `ObjectReference` remain valid because they target stable page/view IDs; arbitrary URL strings in opaque object XML are not rewritten and are an explicit adapter limitation.

Run `bash scripts/gates/check-m5.sh` for the build, focused M5 test, and full structural test suite.
