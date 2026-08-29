# M9 Release Limits Contract

Every limit the M9 release enforces is defined once in `src/limits.ts` and
imported by the module that enforces it.  No module hard-codes a limit value.
The same table is surfaced to clients through `ipe_orientation` (`limits`) and
documented here so a reviewer can cross-check enforcement points.

All values are positive safe integers.  A mutation that exceeds a
document-shape cap fails with `LIMIT_EXCEEDED` before any serialize, write, or
native process work, and the transaction is rolled back with a redacted error
and a corrective message.

## Document shape (enforced at mutation time)

Checked by `checkDocumentShapeLimits` in every `DocumentSessionManager.mutate`
before serialize (`src/limits.ts`, `src/persistence/session-manager.ts`).

| Limit | Value |
|---|---:|
| maxPages | 512 |
| maxLayersPerPage | 256 |
| maxViewsPerPage | 512 |
| maxObjectsPerDocument | 100,000 |
| maxAssetsPerDocument | 10,000 |

These caps are deliberately below the IR sanity ceilings in `SCHEMA_CAPS`
(schema.ts), which remain lossless upper bounds; the coherence test asserts
`schema caps >= document shape caps`.

## XML parse (src/ipe/xml/parser.ts)

| Limit | Value |
|---|---:|
| maxBytes | 16 MiB |
| maxDepth | 128 |
| maxNodes | 500,000 |
| maxAttributes | 10,000 |

## Schema/IR ceilings (src/domain/schema.ts)

Defined by `SCHEMA_CAPS`; values: text 1,000,000; id 256; element/attribute
name 4096; attributeList 10,000; children 100,000; omissions 10,000; assetData
100,000,000; metadataKey 256; checksum 512; visibleLayerIds/attributeMaps/
transforms 10,000; layersPerPage 10,000; viewsPerPage 10,000;
objectsPerPage 100,000,000; zOrder 100,000,000; pages 10,000; stylesheets
10,000; assets 100,000; preamble 10,000,000; references 100,000.

## Native (src/native/adapter.ts)

| Limit | Value |
|---|---:|
| ProcessLimits default | 30 s, 256 KiB output, 2 GiB address space, 256 procs, 64 MiB files |
| maxArtifactBytes | 64 MiB |
| maxPageViewStates | 512 |
| maxCumulativeArtifactBytes | 128 MiB |
| maxSubprocesses | 1024 |
| deadlineMs | 120,000 |
| maxDocumentObjects | 100,000 |
| maxDocumentXmlNodes | 200,000 |
| maxDocumentNestingDepth | 256 |
| maxDocumentSourceBytes | 16 MiB |

Raster validation (`src/native/artifact-validation.ts`): maxWidth/maxHeight
16,384; maxPixels 64 Mi; maxDecodedBytes 256 Mi.  SVG parser: 4 MiB source,
100,000 nodes, depth 256.  M6 artifact worker envelope: 4 MiB.
Subprocess accounting by operation stays in `src/native/process-accounting.ts`.

## LaTeX (src/native/adapter.ts)

Allowlisted packages (`LATEX_SAFE_PACKAGES`): amsmath, amssymb, mathtools,
xcolor.  Fragment length cap: 8,000 chars (MCP contract).

## Assets (src/objects/assets.ts, src/ipe/xml/project.ts)

| Limit | Value |
|---|---:|
| maxInputBytes | 64 MiB |
| maxPixels | 100,000,000 |
| maxDecoderMemoryMB | 512 |

## Animation (src/animation/state.ts)

| Limit | Value |
|---|---:|
| maxGeneratedViews | 64 |
| maxGeneratedCopies | 512 |
| maxPdfPages | 1000 |

## Persistence (session-manager, sidecar, atomic)

| Limit | Value |
|---|---:|
| maxSourceBytes | 16 MiB |
| maxSidecarBytes | 4 MiB |
| maxMetadataBytes (manifest/journal) | 64 KiB |
| lockWait / lockTimeout | 10 ms / 10,000 ms |

## Resource store (src/mcp/artifacts.ts)

| Limit | Value |
|---|---:|
| maxItemBytes | 16 MiB |
| maxTotalBytes | 64 MiB |

## MCP contract (src/mcp/contracts.ts, server.ts, service.ts)

Defined by `MCP_LIMITS`: operationsPerBatch 64; inspectObjectsDefault 100;
maxInspectObjects 500; sourceResourceBytes 128 KiB; maxHints 3; idListMax 128
(reorder_layers/group/views/transition/initial, layout items, style
definitions); reorderPagesMax 512; reorderViewsMax 256; stepsMax 32;
revealGroupsMax 32; motionObjectIdsMax 32; cameraObjectIdsMax 128;
transitionViewIdsMax 128; styleDefinitionsMax 128; layoutItemsMax 128;
gridColumnsMax 64; composeLayersMax 32; pathPointsMax 1000; pathChars 4096;
nameChars 120; titleChars 500; notesChars 4000; latexTextChars 8000;
imageBase64Chars 12,000,000 (≈ 9 Mi decoded); imageDecodedBytes 9,000,000;
diagnosticChars 300.

Public text ceilings (`MODEL_TEXT_CAPS`): hint/error code 80; hint/error
message and correction 500; summary 1000; url 2048.

## Layout sidecar (src/layout/constraints.ts)

Constraints and connectors: 10,000 each (`LAYOUT_CAPS`).

## Enforcement points

- XML: `parseXml` while parsing (before any allocation of the tree).
- Document shape: `DocumentSessionManager.mutate` before serialize.
- Native: `NativeIpeAdapter.#preflight/#preflightDocument/#processLimits`
  before a workspace or process is created.
- Assets: `addBitmapAsset`/PNG IHDR preflight and `project.ts` before decode.
- Animation: `preflight` before any duplicate/copy work.
- Resource store: `ArtifactStore.put` before buffering.
- MCP: zod schemas validate batch/id/text caps before a handler runs.

Boundary and boundary-plus-one tests live in `tests/limits/limits.test.ts`,
`tests/limits/session-guard.test.ts`, and the contract tests in
`tests/mcp/contracts.test.ts`.
