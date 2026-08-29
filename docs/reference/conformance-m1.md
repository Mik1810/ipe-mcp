# M1 Conformance Lab

Baseline verified on 2026-08-25: Ubuntu 26.04/WSL, Ipe package `7.2.30-1build2`, Lua runtime `Ipe 7.2.30`, XML format `70218`.

The reproducible gate is:

```bash
bash scripts/gates/check-m1.sh
```

The gate runs M0, a capability probe, native load/save, copying through Lua Ipelib, PDF/SVG export, and comparison with a deterministic golden JSON. Outputs exist exclusively in a temporary directory. The optional source-build lane uses already-built binaries without implicitly downloading or compiling:

```bash
IPE_M1_SOURCE_BIN_DIR=/path/to/ipe/build/bin bash scripts/gates/check-m1.sh
```

## 7.2.30 Empirical Evidence

| Experiment | Result | Decision |
|---|---|---|
| Document without layer/view | Runtime accepts the file and saves `alpha`, one view, and `active="alpha"` | MCP serializer always emits layer/view/active; permissive behavior remains import compatibility only |
| `marked="no"` | Native writer omits it as a false default | MCP serializer materializes it explicitly |
| `custom="ipe-mcp:<uuid>"` | Preserved by load/save and `obj:clone()` | Stable identity channel, with a new UUID mandatory for every copy |
| Unknown attributes and `x-*` nodes | Accepted on input but lost on native save | Not a supported metadata channel; the sidecar preserves rich data |
| Object sequence | Preserved by load/save; Lua insertion has an explicit position | Global sequence remains the sole source of z-order |
| `BBOX`, `VIEWBBOX`, group link, and view/layer transform | Distinct CropBox/ArtBox and visual transforms preserved; XML writer elides `crop="yes"`, while reserved layers retain the boxes; link rectangle remains untransformed | Serializer materializes `crop`; per-view transform remains opt-in with an explicit warning about links and hit testing |
| Effects 0–27 | 28 views exported; Normal creates no `/Trans`, the other 27 do | Presence in the PDF is verifiable; playback remains viewer-dependent |

The golden compares normalized semantics, not whitespace, creator, or writer formatting.

## Direct Serializer and Lua Helper

The persisted representation belongs to the deterministic XML serializer. `ipescript` is not a second general-purpose serializer: it is the native adapter for operations whose semantics are not safely reconstructible outside Ipelib.

| Mutation | Definitive backend |
|---|---|
| Creation of documents and objects fully represented in the IR | Deterministic XML, followed by native validation in the full lane |
| Updating attributes, layer/view, and z-order already supported by the IR | Deterministic XML; layer and z-order remain separate operations |
| Import of an existing document | Ipelib load mandatory for capability/diagnostics; lossless XML parsing keeps the source unchanged until saved |
| Copying imported objects/pages | `obj:clone()`/Page/Document through `ipescript`, then assignment of a new `ipe-mcp:<uuid>` |
| Native bbox, layer matrices, view maps, style check, LaTeX, export/render | `ipescript`/Ipe CLI mandatory |
| Unknown node or attribute not represented in the IR | No silent mutation: byte/sidecar preservation or capability error |

Every full save returns to the IR and is reserialized to restore the contract's explicit attributes. The M1 corpus makes every divergence observable before M2 implements parsing and persistence.

## Technical Sources

- Ipe 7.2.30, `manual/90_file_format.rst`: unknown attributes, `x-*` elements, view transforms, and effects.
- Ipe 7.2.30, `src/ipelua/bindings.txt`: `Document`, `Page`, `Object`, clone, custom, bbox, and layer matrices.
- `report-source.md`: project incompatibilities and normative choices.
