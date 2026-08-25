# ADR-0002 — Domain Model and Layout

- Status: **Accepted**
- Date: 2026-08-24

## Decision

The server uses a versioned semantic IR independent of Ipe XML. The minimum model is `Document → Page → Layer/View/Object`: every document has at least one page, one layer, and one view; every top-level object has an explicit `layerId` and resolvable references.

Layer, view, and visual order are distinct axes:

- the layer determines membership, visibility, editability, and snapping;
- the view determines presentation state (visible layers, active layer, maps, and permitted transformations);
- z-order is the global back-to-front sequence of objects, independent of layer order. The first object is farthest back; the last is farthest forward.

Layer order does not implement `bringToFront`/`sendToBack`. Z-order APIs operate on object IDs; layer APIs move membership without changing the sequence unless explicitly requested.

The default space is `frame`, with a y-up axis and explicit conversion to `bp` points; `paper`, `normalized`, `ipe`, and `object-local` are supported. Matrices are `[a b c d s t]`, with `x'=a*x+c*y+s` and `y'=b*x+d*y+t`, and composition `viewLayerMatrix * objectMatrix * localPoint`. NaN and infinity are rejected. For the linear part, let `n=max(|a|+|c|, |b|+|d|)`; the matrix is rejected if `n=0` or `|a*d-b*c| <= 1e-12*n^2`; M3 will fix the property tests and any versioned revision of this tolerance.

## Views and Animation

Views are discrete states. Reveal and motion use copies/variants by default; per-layer transformations are opt-in and accompanied by warnings about bbox, links, and hit testing. The server's deterministic serializer owns the saved representation and always materializes `active`, `marked`, and the layer of every top-level object. The native 7.2.30 writer may omit redundant defaults during a probe: that output remains diagnostic and is not promoted directly to a server save; M1 will establish its semantic diff. PDF transitions are viewer-dependent and are not evidence of continuous motion.

## Consequences

Layout may require a second pass for LaTeX measurements, but it does not become a persistent constraint system. M0 fixtures verify coordinates/matrices, layer-view, and z-order separately; M1 probes and goldens will close native divergences without retroactively changing this contract.
