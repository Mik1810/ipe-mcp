# Ipe MCP — Agent Operational Manual

This is the single operational manual for driving `ipe-mcp` through the
supported MVP workflow: create, open, inspect, edit, layout, validate, render,
save, export, and recover. It is written for an agent (or a human acting as
one) and it is the authoritative "how do I do this" reference; the
architecture-level contracts live in `docs/milestones/core-*.md`, and the field guide for
*authoring* an MCP server lives in `guide.md`.

Every example is exercised against the M9 candidate by
`node scripts/host/m9-agent-workflow.mjs` (see [Verification](#verification)).

## 1. Mental model

- A **working copy** is a private, recoverable session. Opening or creating a
  document does **not** modify the source file on disk until
  `ipe_save_document`.
- Every mutation is **revision-guarded**: it must carry the `expectedRevision`
  returned by the previous mutation (or `0` after create/open). A stale value
  is rejected with no write.
- Every entity has an **exact typed ID** (`page-…`, `layer-…`, `view-…`,
  `object-…`, `style-…`, `asset-…`). Names and indexes are not IDs; never
  derive an ID from them. Read IDs from tool results or `ipe_inspect`.
- Mutations are **atomic**: a batch of up to 64 operations either commits as
  one revision or rolls back entirely. Deleting requires confirmation.
- Binary outputs (`previews`, `artifacts`) are **resource links**, not inline
  blobs; read only what you need.
- Three modes exist ([`compatibility-modes.md`](../reference/compatibility-modes.md)):
  `structural-only` (no native Ipe), `full-7.2.30` (verified lane), and
  `nightly-7.3.x` (experimental). Always call `ipe_get_capabilities` before
  claiming native verification.

## 2. The supported workflow

Always follow this order:

1. `ipe_orientation` — workflow, invariants, limits, resource routes.
2. `ipe_get_capabilities` — confirm `full-7.2.30` before native work.
3. `ipe_create_document` or `ipe_open_document` — get a `documentId`.
4. `ipe_inspect` — read exact IDs and counts.
5. Mutate with `ipe_apply_operations` / `ipe_compose_slide` /
   `ipe_build_views` (each requires the current `expectedRevision`).
6. `ipe_validate` (structural, then full when native is available).
7. `ipe_render_preview` and/or `ipe_export_document` — read the resource links.
8. `ipe_save_document` (with confirmation) to persist to disk.
9. `ipe_history` for snapshot/undo/restore/recover.

### 2.1 Orient and inspect capabilities

```jsonc
// ipe_orientation {}
// returns contractVersion, workflow, invariants, resources, limits
// ipe_get_capabilities {}
// returns { capabilities: { mode, verified, ipeVersion, features, toolchain, validators } }
```

Only proceed to `full` validation/export when `mode === "full-7.2.30"` and
`verified === true`. In `structural-only` mode you may still author and
inspect structurally, but native style/TeX/PDF/render checks are unavailable.

### 2.2 Create or open a presentation

```jsonc
// ipe_create_document { preset: "16:9", title: "Quarterly review" }
// -> { documentId, revision: 0, outline: { pageCount: 1, pages: [{ id, layers: [{ id }], views: [{ id }], objects: [] }] } }
```

`documentId` is a UUID. The returned outline already carries the first page,
layer, and view IDs; reuse them verbatim.

To edit an existing document, pass an absolute `.ipe` path under
`IPE_MCP_WORKSPACE_ROOT`:

```jsonc
// ipe_open_document { path: "/workspace/decks/quarterly-review.ipe" }
// -> { documentId, revision: 0, outline: { pageCount, pages: [...] } }
```

Opening creates a private working copy and leaves the source byte-identical.
Treat the returned IDs as a new session: do not reuse IDs from another open or
create call, even when both sessions refer to the same source file.

### 2.3 Compose a semantic slide

```jsonc
// ipe_compose_slide {
//   documentId, expectedRevision: 0, preset: "16:9",
//   name: "opening", title: "Opening", notes: "Welcome",
//   layers: ["content", "annotations"]
// }
// -> { pageId, layerIds: [...], viewIds: [...] }
```

The returned `layerIds` map in order to `layers`. Populate objects onto those
exact layer IDs with `ipe_apply_operations`.

### 2.4 Insert and edit objects (exact IDs, batch atomic)

Coordinates are Ipe page coordinates (bp, y-up); 16:9 preset uses paper
`1280 720`, frame `1216 648`.

```jsonc
// ipe_apply_operations { documentId, expectedRevision, operations: [
//   { op: "add_rectangle", pageId, layerId, x: 40, y: 40, width: 200, height: 100, stroke: "black", fill: "0.2 0.5 0.9" },
//   { op: "add_text", pageId, layerId, text: "Hello $x^2$", position: { x: 40, y: 200 } },
//   { op: "add_path", pageId, layerId, path: { kind: "circle", center: { x: 300, y: 100 }, radius: 30, style: { stroke: "black" } } },
//   { op: "add_image", pageId, layerId, mediaType: "image/png", dataBase64: "<...>", target: { x: 500, y: 40, width: 20, height: 20 }, fit: "contain" },
//   { op: "add_layer", pageId, name: "annotations" }
// ] }
```

> `add_text` omits `size` (defaults to Ipe's `normal`); an explicit `size` must be
> an Ipe size name (`normal`, `large`, …), not a LaTeX size like `normalsize`.
> `add_symbol_use` takes the exact symbol name including its parameter suffix
> (e.g. `mark/disk(sx)`); the true builtin is resolved during validation.

Supported operations: `set_metadata`, `add_page`, `update_page`, `delete_page`,
`reorder_pages`, `add_layer`, `update_layer`, `delete_layer`, `reorder_layers`,
`add_view`, `update_view`, `delete_view`, `reorder_views`, `add_rectangle`,
`add_segment`, `add_path`, `add_text`, `add_image`, `add_symbol_use`,
`replace_object`, `duplicate_object`, `delete_object`, `move_object`,
`set_object_layer`, `transform_object`, `group_objects`, `ungroup_object`,
`add_stylesheet`, `layout_objects`.

- `delete_*`, `group_objects`, `ungroup_object` operate on exact IDs only.
- `transform_object` composes an affine `matrix`; `space: "page"` pre-multiplies
  (world) while `"local"` post-multiplies (object frame).
- `add_image` base64 is preflighted before allocation (decoded ≤ 9 Mi, pixels
  bounded); a hostile or over-budget payload is rejected before decode.
- `add_stylesheet` takes typed definitions (`color`, `pen`/`symbolsize`/
  `arrowsize`/`textsize`, `dashstyle`, `opacity`, `symbol`).

**Layers vs z-order.** Layers control visibility and editing semantics; they do
**not** partition draw order. Object ordering is a single global `zOrder` per
page. Use `move_object` (with `position`) and the `position`/`positionInZOrder`
argument to control stacking; use `set_object_layer` to change membership
without changing z-order.

### 2.5 Layout objects

`layout_objects` applies row, column, grid, or stack placement as one atomic
operation. Supply exact object IDs and the current measured bounds of each
object in `source`; the server uses those caller-supplied boxes to derive the
transforms and does not infer rendered bounds.

```jsonc
// ipe_apply_operations { documentId, expectedRevision, operations: [{
//   op: "layout_objects", pageId,
//   layout: {
//     primitive: "row",
//     container: { x: 40, y: 300, width: 500, height: 100 },
//     items: [
//       { objectId: rectangleId, source: { x: 40, y: 40, width: 200, height: 100 } },
//       { objectId: circleId, source: { x: 270, y: 70, width: 60, height: 60 } }
//     ],
//     gap: 20, mainAlign: "center", crossAlign: "center"
//   }
// }] }
```

For `grid`, also provide `columns` and optional `rowGap`/`columnGap`; for
`stack`, use `horizontalAlign` and `verticalAlign`. A bad ID, invalid source
box, or impossible layout rejects the whole batch without advancing revision.

### 2.6 Views, reveals, and scrolling

```jsonc
// ipe_build_views { documentId, expectedRevision, build: { kind: "reveal", pageId, groups: [
//   [{ kind: "layer", id: layerIdA }],
//   [{ kind: "object", id: objectId1 }]
// ], cumulative: true } }
// -> { viewIds: [...], diagnostics: [...] }
```

`ipe_build_views` accepts `reveal`, `motion`, `panel_scroll`, `camera_pan`, and
`transition`. All are discrete (bounded steps, never continuous animation):

- `motion` moves distinct objects over `steps` (2–32) discrete static views.
- `panel_scroll` clips one object and scrolls on one axis.
- `camera_pan` translates selected (or non-reserved-layer) objects.
- `transition` assigns a PDF transition effect to existing views; effects are
  best-effort per viewer ([`viewer-effects-m7.md`](../reference/viewer-effects-m7.md)).

### 2.7 Validate

```jsonc
// ipe_validate { documentId, level: "structural" }   // process-free
// ipe_validate { documentId, level: "full" }         // native style/LaTeX/PDF/render
```

`structural` is always available. `full` requires `full-7.2.30` and runs the
bounded native pipeline; it reports `ok`, `diagnosticCount`, and `capabilityMode`.

### 2.8 Render and export (resource links only)

```jsonc
// ipe_render_preview { documentId }        // PNG per view (omit page/view for all)
// ipe_export_document { documentId, format: "pdf" }  // deterministic PDF
// ipe_export_document { documentId, format: "png" }  // one fixed-paper PNG per view
```

Both return `resources: [{ uri, mediaType, bytes, sha256, metadata }]`. Read
the `uri` (`ipe://previews/{id}` or `ipe://artifacts/{id}`) only when needed.

### 2.9 Save, snapshot, undo, restore, recover

```jsonc
// ipe_history { documentId, action: "snapshot", expectedRevision }
// -> { snapshotId }
// ipe_save_document { documentId, expectedRevision, targetPath, confirmation: "SAVE" }
// -> { revision, sourceHash, snapshotCreated }
// ipe_history { documentId, action: "undo", expectedRevision, confirmation: "UNDO" }
// ipe_history { documentId, action: "restore", expectedRevision, snapshotId, confirmation: "RESTORE" }
// ipe_history { action: "recover" }   // scan private state root after a restart
// -> { recovered: [{ documentId, revision }] }
```

- `save` rechecks the source hash under a filesystem lock; a changed source is
  a `SOURCE_CHANGED` conflict, never overwritten.
- Snapshots are private, opaque UUIDs; `list` and `recover` persist across
  restart. Artifacts are connection-local and must be regenerated.
- Confirmations: `SAVE`, `DELETE`, `UNDO`, `RESTORE`.

For a real restart recovery, stop the original MCP host/server process, start a
new one with the same `IPE_MCP_STATE_ROOT` and `IPE_MCP_WORKSPACE_ROOT`, then
call `ipe_history { action: "recover" }`. Match the returned `documentId` and
revision before continuing, call `ipe_inspect` to refresh exact IDs, and
regenerate any preview/export resources because their URIs belonged to the old
connection.

## 3. Limits and budgets

The enforced contract is [`core-m9-limits.md`](../milestones/core-m9-limits.md). Highlights
an agent must respect:

- 64 operations per `ipe_apply_operations` batch; ≤ 3 hints per result.
- `ipe_inspect` returns ≤ 500 object identities (default 100) with a
  `truncated` flag.
- Document shape caps at mutation time: 512 pages, 256 layers/page,
  512 views/page, 100k objects, 10k assets. Exceeding one fails with
  `LIMIT_EXCEEDED` and rolls back.
- LaTeX fragments ≤ 8000 chars; only `amsmath`, `amssymb`, `mathtools`,
  `xcolor` in preambles; shell escape is disabled and writes are confined.
- Native operations carry a total deadline and subprocess/output/file caps;
  a run-away is classified, never unbounded.

## 4. Troubleshooting

| Error / symptom | Meaning | Action |
|---|---|---|
| `REVISION_CONFLICT` | `expectedRevision` is stale | Call `ipe_inspect`, retry with the current revision. |
| `IDENTIFIER_NOT_FOUND` | a name/index was used as an ID | `ipe_inspect`, copy the exact current ID. |
| `CONFIRMATION_REQUIRED` | destructive op needs a token | Obtain user intent, resend with the documented token (`SAVE`/`DELETE`/`UNDO`/`RESTORE`). |
| `PATH_OUTSIDE_WORKSPACE` | target escapes the configured root | Use a path under `IPE_MCP_WORKSPACE_ROOT`; no `..`, no symlink escape. |
| `SOURCE_CHANGED` | the file changed outside the session | Re-open as a new session, or save to a different approved path. |
| `STRUCTURAL_VALIDATION_FAILED` | invariants violated | Read the reported diagnostic; correct the candidate; the batch was rolled back. |
| `LIMIT_EXCEEDED` | document shape cap hit | Reduce pages/layers/views/objects/assets below the stated limit. |
| `NATIVE_UNAVAILABLE` / `NATIVE_CRASH` | Ipe toolchain missing or broken | `ipe_get_capabilities`; verify `SETUP-WSL.md`; run `scripts/gates/check-m9-setup.sh`. |
| `NATIVE_TEX_ERROR` | LaTeX failed or non-allowlisted package | Keep preambles to allowlisted packages; simplify text; avoid shell/input. |
| `NATIVE_STYLE_ERROR` / `NATIVE_RENDER_ERROR` / `NATIVE_EXPORT_ERROR` | native style/render/export failed | `ipe_get_capabilities`, inspect `diagnostics`, reduce complexity. |
| `NATIVE_TIMEOUT` | bounded deadline reached | Reduce page/view complexity, retry; raise `IPE_MCP_NATIVE_TIMEOUT_MS` (1–300000) only when safe. |
| `NATIVE_RESOURCE_LIMIT` | subprocess/output/file cap reached | Reduce document size or artifact count. |
| `NATIVE_LOAD_ERROR` ("view/layer mapping") | composed multi-layer page reloaded differently | Prefer single-layer composition or layer-based reveals; this is a documented native nuance, not data loss. |
| `capabilities.mode === "structural-only"` | native Ipe not verified | Only claim structural results; install Ipe 7.2.30 (see `SETUP-WSL.md`). |
| renders "degraded" | viewer-dependent effect not universal | Report static correctness; do not claim universal transitions. |

### Host and environment notes

- Do not type into the stdio process; stdin/stdout carry MCP frames, logs go
  to stderr.
- Configure `IPE_MCP_WORKSPACE_ROOT` and `IPE_MCP_STATE_ROOT`; on a restart,
  `ipe_history { action: "recover" }` reloads durable sessions.
- Codex/Inspector/VS Code setup and the independent SDK host are covered in
  [`m8-host-integration.md`](./m8-host-integration.md).

## 5. Verification

The complete workflow above is exercised end to end against the current
candidate by:

```bash
node scripts/host/m9-agent-workflow.mjs /tmp/ipe-m9-manual
```

It drives orientation, capabilities, 16:9 create, compose, object authoring,
reveals, structural + full validation, render, confirmed save, undo, restore,
export, and recover, and prints a `PASS`/`FAIL` line per section. The dedicated
gate is:

```bash
bash scripts/gates/check-m9-manual.sh
```
