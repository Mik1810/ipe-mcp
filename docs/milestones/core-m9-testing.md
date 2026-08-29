# M9 Property and Fuzz Testing

Gate: `bash scripts/gates/check-m9-fuzz.sh` (includes M8, `npm run build`, and every
suite under `tests/property/`). The cumulative M9 gate (#24) is expected to
consume this gate without modification.

## Reproducibility contract

- One `XorShift32` state per suite, seeded from `PINNED_SEEDS` in
  `tests/property/rng.ts`; every suite exports its own seed.
- Default 1,024 cases per bounded suite; `PROPERTY_ITERATIONS=<n>` overrides
  the count (both settings keep the gate deterministic).
- A failing case reports `[property] seed=<hex> case=<n>: <reason>` so a run
  can be reproduced verbatim with the same seed; the same seed always produces
  the same failing case.
- Inputs are bounded: XML fuzz surfaces cap at 64 KiB; all generators emit
  values inside the domain contract.

## Suites

| Suite | Coverage |
|---|---|
| `tests/property/matrices.test.ts` | inverse/apply round-trip, associativity, determinant product, degenerate/non-finite rejection, determinism of the sequence |
| `tests/property/geometry.test.ts` | anchor↔box round-trip for every anchor, coordinate-space conversion round-trips, `anchorInSpace` preservation, `transformBoxEnvelope` containment |
| `tests/property/parser.test.ts` | structural XML fuzz (random tags/attributes/pages), canonicalization fixed point, rejection of entity/doctype/namespace, invalid UTF-8, XML 1.0 control characters |
| `tests/property/crud.test.ts` | batch CRUD with z-order/reference/layer invariants after every commit, identity preservation through replace, full atomic rollback on invalid batches, interleaved move/duplicate batches |
| `tests/property/protocol.test.ts` | strict public result envelope on random success/failure data, redaction of paths, bounded summaries/hints, revision-guarded mutation sequences, JSON-shaped outline data |

Fixed `it` tests continue to live alongside these suites (for example
`tests/layout/geometry-matrix.test.ts` imports the shared RNG and seed).

## Budget

At the default 1,024 cases the complete property battery runs in under four
seconds on the M8 baseline machine, with no external fuzzing service and no
post-MVP harness (per #13 boundaries).
