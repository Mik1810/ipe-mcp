# Compatibility Modes and Verification Criteria

This matrix is the M0 operating contract. `verified` is bound to the lane and checks actually executed; it does not guarantee that every viewer interprets transitions or experimental features in the same way.

| Mode | Runtime/version | Capability | Failure mode | Diagnostic label | When it may say `verified` |
|---|---|---|---|---|---|
| `structural-only` | No Ipe; target XML 70218 | Schema, IR, references, layer/view, z-order, finite numbers, well-formed/canonical XML, and local policies | Native, style, TeX, PDF, and rendering checks are unavailable; explicit warnings | `STRUCTURAL_ONLY_UNVERIFIED_NATIVE` | Only **structural verified** when all local checks pass. Never `full`, `native`, or `render verified`. |
| `full-7.2.30` | Ipe 7.2.30; XML writer 70218 | All structural checks plus advisory DTD, native load-save-reload, style, pdfLaTeX sandbox, PDF, PNG, and page/view mapping | A failed level fails verification; timeout/unsupported feature is a classified error or warning | `FULL_7_2_30_VERIFIED` / `FULL_7_2_30_FAILED` | Only after all levels and confirmation of root `version="70218"` before/after round trip. |
| `nightly-7.3.x` | master/7.3.x, allowed-failure | Probes and checks available for the detected version | Separate divergence; does not block stable or rewrite a stable file | `NIGHTLY_EXPERIMENTAL_VERIFIED` / `NIGHTLY_DIVERGENCE` | Only **nightly verified** for a passed version and corpus. Never `full-7.2.30 verified`; 7.3.x APIs are outside the MVP. |

## Reporting Rules

Every result includes mode, version, format, executed levels, warnings/errors, and artifacts. `verified` is not emitted if a check was skipped, simulated, or available only in another lane.

PDF transitions, layer transforms, DTD/runtime differences, and viewers are separate diagnostics: the static correctness of each view can be verified, but a viewer-dependent effect does not become a universal guarantee. 7.3.x notes are always `future/nightly`.
