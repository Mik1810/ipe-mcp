# M3 coordinate and layout core

M3 implements a deterministic, transport-independent geometry layer over the M2 IR. It does not claim native text or path measurement: those measurements belong to M4. All layout functions are pure. A `LayoutPlan` is validated in full before `applyLayoutPlan` changes an M2 draft.

## Coordinate contract

The four relative coordinate-space families are `frame`, `paper`, `normalized` and `object-local`. `ipe` is the canonical explicit bp domain and an API escape hatch, so the TypeScript union has five `kind` values. Coordinates are always y-up. Row, column and grid use reading order explicitly; they do not change the coordinate-axis convention.

An Ipe `<layout paper="Pw Ph" origin="Ox Oy" frame="Fw Fh">` resolves to:

- frame box `(0, 0, Fw, Fh)` in Ipe coordinates;
- paper box `(-Ox, -Oy, Pw, Ph)` in Ipe coordinates;
- normalized coordinates relative to the selected frame or paper box.

The last explicit `<layout>` encountered in stylesheet cascade order is effective. If there is no explicit layout, Ipe 7.2.30's built-in standard A4 layout is used: `paper="595 842" origin="0 0" frame="595 842"`. Malformed, non-positive paper/frame sizes and values outside the finite domain are errors.

`object-local` requires a phase. `model` applies only `objectMatrix`; `rendered` applies `viewLayerMatrix * objectMatrix`. This makes it impossible to apply a view transform accidentally during a persistent object mutation.

## Affine matrices and numeric policy

Matrices use Ipe's `[a b c d s t]` convention:

```
x' = a*x + c*y + s
y' = b*x + d*y + t
```

`multiplyMatrices(A, B)` means `A * B`, so it applies `B` first. Page-space transforms pre-multiply an object matrix; object-local transforms post-multiply. A transform about page point `o` is `T(o) * M * T(-o)`.

Every input and computed coordinate or matrix component must be finite and within `±1e9`. Let `n=max(|a|+|c|, |b|+|d|)`: a matrix is rejected when `n=0` or `|a*d-b*c| <= 1e-12*n²`. Core calculations do not round. Numeric comparisons use:

```
abs(a-b) <= 1e-9 + 1e-12 * max(abs(a), abs(b))
```

The property suite is deterministic (`seed=0x1a2b3c4d`) and checks 1,024 well-conditioned matrix cases, inverse round trips, application order and associativity by application. Threshold, non-finite and overflow cases are separate.

## Boxes, anchors and bounds

`Box` is `(x, y, width, height)` with non-negative dimensions. Ten anchors are supported: the nine edge/center anchors plus `baseline-left`. Baseline anchoring is an error unless `baselineFromBottom` is known explicitly.

Bounds distinguish `logical`, `geometric` and `visual`. A measurement can instead be `deferred` for `latex`, `native`, `view-dependent` or `unsupported`. M3 does not impose a nesting relationship between these boxes: clipping and effects can invalidate such an assumption.

## Layout semantics

- `row`: stable input order, left to right; cross-axis `start` means top.
- `column`: stable input order, top to bottom; cross-axis `start` means left.
- `grid`: explicit positive column count, row-major from the top, no spans or flex behavior.
- `stack`: every item is anchored in the same padded content box and must fit it.
- `align`: selected x/y edge or center against the union or an explicit coordinate.
- `distribute`: stable output order; the positional extremes are preserved unless explicit bounds are supplied.
- `fit`: `contain` and `cover` scale uniformly; `stretch` scales axes independently.

Padding, margins and gaps are non-negative. Min/max/aspect constraints remain authoritative under cross-axis stretch; aspect-constrained items keep their feasible size and max-constrained items stretch only to that maximum. Conflicts, overflow, impossible cells and zero-size fit sources are errors rather than silent clamps. `overflow: "allow"` is an explicit opt-in for linear layouts; when content is too large, `space-between` preserves the requested non-negative gap instead of creating overlap.

## Sidecar constraints and connectors

M3 uses the existing M2 sidecar without narrowing its schema. Its payload is namespaced at `layoutConstraints["ipe-mcp.layout.v1"]`; unrelated writers are retained. The v1 payload holds constraints, connector intents and optional `lastApplied` revision/hash/fingerprint evidence.

The preliminary one-way constraint language supports `right-of`, `below`, `same-width` and `align-baseline`. It is resolved only on explicit request with at most 10,000 constraints and connectors. Missing IDs, deferred bounds, revision/hash/input-fingerprint stale evidence, cycles, self-reference and multiple writers on the same subject axis reject the complete plan. Resolution uses a linear graph traversal.

Connector intents reference persistent M2 object IDs, a box kind and an explicit or automatic anchor. M3 computes straight or deterministic orthogonal polylines with an explicit tie-break. It rejects ambiguous coincident centers and zero-length routes. Curve routing, obstacle avoidance and path XML generation are deferred to M4.

## Golden fixtures

`fixtures/conformance/m3/standard-layout.json` uses a non-zero paper origin and asymmetric normalized sentinel. `presentation-16x9-layout.json` mirrors Ipe 7.2.30 presentation geometry (`paper="1280 720" origin="32 0" frame="1216 648"`). Their placements are byte-exact JSON golden values and deliberately distinguish top from bottom to detect y inversion.
