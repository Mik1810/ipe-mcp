# ADR-0001 — Compatibility Baseline

- Status: **Accepted**
- Date: 2026-08-24

## Decision

The normative MVP baseline is Ipe **7.2.30**, on Ubuntu 26.04/WSL, with XML `FILE_FORMAT` **70218**. The serializer must emit `version="70218"` explicitly; the library version (70230) is not used as the file version. Stable compatibility requires the `full` lane described in `docs/reference/compatibility-modes.md`.

Three independent lanes are maintained: `full-7.2.30` (release), `structural-only` (local checks without Ipe), and `nightly-7.3.x` (experimental/allowed-failure). The MVP contract does not use 7.3.x APIs; nightly does not rewrite a stable file without consent. The 7.2.29 smoke test is only an external check.

## Consequences and Boundaries

Support for DTD/runtime divergences, native helpers, PDF viewers, and experimental features is closed by M1/M6/M7 probes. M0 fixes names, invariants, and outcome criteria without claiming that any empirical divergence is resolved. Every diagnostic reports the lane, detected version, XML format, and validation level.

## Approved Deferral

The distribution strategy (bundle, npm, installable helper, and support beyond Ubuntu 26.04/WSL) is **deferred until after local MVP validation**. This is an approved deferral decision, not a missing decision; it will be reassessed in M10 using conformance, licensing, and reproducibility evidence.
