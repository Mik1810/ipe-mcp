# M9 Real-Document Review

Gate: `bash scripts/gates/check-m9-real.sh` (includes M8, `npm run build`, a
review run against the real MCP stdio server, and an audit of the commitable
evidence). The cumulative M9 gate (#24) is expected to consume this gate
unchanged.

## Goal and source policy

This review exercises the M9 candidate on **real, licensed Ipe documents**
(not synthetic fixtures) and records a complete provenance and
classification ledger: source repository/package or owner authorization,
license, sha256, sanitization status, and retained-file policy. Boundaries:
no private deck, no PII, no authenticated URL, no unlicensed vendoring.
GPL-3+ originals are accessed in place (or copied into a private temporary
workspace at review time) and are **not retained**: the repository keeps only
the byte-identical MIT-licensed fixture and the bounded reviewable evidence.

## Source set and provenance

| Case | Document | Provenance | License | Derived | Retained |
|---|---|---|---|---|
| REAL-001 | Ipe icon library (`/usr/share/ipe/7.2.30/icons/icons.ipe`, 54 pages/54 views/56 layers/189 objects) | dpkg `ipe 7.2.30-1build2`; Debian copyright `/usr/share/doc/ipe/copyright`; upstream `otfried/ipe` release v7.2.30; creator "Ipe 7.2.17"; root `version="70216"` | GPL-3+ | yes: `ipetoipe 7.2.30 -xml` (server never produces the input) | not retained: private temp only |
| REAL-002 | Ipe logo (`/usr/share/ipe/7.2.30/icons/ipe_logo.ipe`, 1 page/1 view/3 layers/5 objects) | same package provenance; root `version="70216"` | GPL-3+ | yes: `ipetoipe 7.2.30 -xml` | not retained: private temp only |
| REAL-003 | TU Delft Ipe presentation template (`TUD-slides-template.ipe`, 3 pages/4 views/5 layers/18 objects) | GitHub `olejorik/TU-Delft-slides-Ipe`, pinned commit `9142d8e87752743adc948d14ba1da15dcd21ccda`, raw URL recorded in the manifest; creator "Ipe 7.2.24"; root `version="70218"` | MIT (© 2021 Oleg Soloviev; verbatim text in `LICENSE.TUD-slides`) | none (native 70218 as published) | vendored byte-identical under MIT with its license text |
| REAL-004 | Raw 70216 boundary check | the two package originals above, opened unmodified | GPL-3+ | none | not retained |

Sanitization: none required for any case — the documents are public assets
(the template uses placeholder text, e.g. `My Name`); no PII. The TUD
fixture is byte-identical to the pinned raw file (sha256
`c597690e...` in the manifest), so no license attribution, no altered
content, and no silent transformation.

## Methodology and phases

`scripts/conformance/m9-real-runner.mjs` drives the real stdio server through
the MCP SDK client (text/structured parity), inside a private temporary
workspace and state root: it copies the originals into the workspace, derives
70218 copies with the native toolchain where needed, then for each document
executes `ipe_open_document` → `ipe_inspect` → a deterministic edit
(`transform_object` on the first object of page 1, matrix 1 0 0 1 1.32 0.44,
fallback `update_layer`) → `ipe_validate full` → per-page
`ipe_render_preview` → `ipe_save_document` to a copy with `confirmation:
"SAVE"` → reopen of the saved copy → `ipe_export_document` (PDF then PNG).
Every phase result is PASS or the exact classified candidate response
(code + summary) an agent would receive. Proved invariants: the package
originals are byte-identical before and after the whole review, and the
rewritten copy reopens with the same outline shape.

## Evidence matrix (captured 2026-08-29 on the M9 candidate)

| Phase | REAL-001 (icons) | REAL-002 (logo) | REAL-003 (TUD template) |
|---|---|---:|---:|
| open / inspect / edit / save-to-copy / reopen | PASS (54 p, 189 objects) | PASS (1 p, 5 objects) | PASS (3 p, 18 objects) |
| validate full | CLASSIFIED `NATIVE_EXPORT_ERROR` (blank page 54, see FD-001) | CLASSIFIED `NATIVE_TEX_ERROR` (FD-002) | CLASSIFIED `NATIVE_TEX_ERROR` (FD-003) |
| every-view render | CLASSIFIED `NATIVE_RENDER_ERROR` (page 54) | CLASSIFIED `NATIVE_TEX_ERROR` (FD-002) | CLASSIFIED `NATIVE_TEX_ERROR` (FD-003) |
| PDF export | CLASSIFIED `NATIVE_EXPORT_ERROR` (FD-001) | CLASSIFIED `NATIVE_TEX_ERROR` (FD-002) | CLASSIFIED `NATIVE_TEX_ERROR` (FD-003) |
| PNG export | CLASSIFIED `NATIVE_RENDER_ERROR` (FD-001) | CLASSIFIED `NATIVE_TEX_ERROR` (FD-002) | CLASSIFIED `NATIVE_TEX_ERROR` (FD-003) |
| originals unchanged | PASS (sha256 equal) | PASS (sha256 equal) | PASS (fixture sha256 equal) |

All classifications are **recorded, non-crashing, and checked before any
write**; the working-copy and save/reopen surface passed on every real
document. The review intentionally does not claim "verified" for the
classified phases (see the support policy: degraded mode, classified native
errors; never claim verification for a skipped or blocked check).

## Findings (real-document findings and review value)

- **FD-001 (upstream, reproducible outside the server)**: page 54
  (`mode_translate`) of Ipe 7.2.30's own icon library renders as a
  completely blank 22×22 raster under `iperender -nocrop` (pure white,
  harness reproduces `iperender -page 54 ...` fully white), and crop-mode
  `iperender -page 54` aborts on it (SIGABRT 1491171) for both the original
  70216 and the derived 70218 file. The candidate therefore classifies
  `NATIVE_EXPORT_ERROR`/`NATIVE_RENDER_ERROR` on this document: 53 of the 54
  per-page render/PDF snapshot checks pass, and the integrity guard
  ("PNG has no visible content") aborts the run at page 54. Ipe 7.2.30's
  own toolchain cannot render this shipped asset.
- **FD-002 (candidate policy)**: `ipe_logo.ipe`'s preamble declares
  `\usepackage{mathpazo}`; the M6 minimal LaTeX profile allowlist rejects it
  (`NATIVE_TEX_ERROR: LaTeX package is not allowed: mathpazo`). The
  toolchain's own logo uses a font package outside the MVP profile.
- **FD-003 (real-world template pattern)**: the TUD template preamble uses
  `\renewcommand` (status bar macros and list spacing), rejected by the
  minimal-profile guard `NATIVE_TEX_ERROR: only allowlisted \usepackage
  declarations are permitted in the M6 preamble`. Real-world layouts
  customize the preamble; the MVP minimal profile does not allow arbitrary
  preambles (by design, per the release notes and support policy).
- **FD-004 (format boundary)**: the Ipe 7.2.30 package ships its icon assets
  as `version="70216"` (authored by Ipe 7.2.17, legacy `<page>` syntax). The
  candidate rejects them with the exact classification
  `Only Ipe XML format 70218 is supported` (INVALID_ARGUMENT), by design;
  this is why the exercised inputs for REAL-001/002 are the recorded native
  derivations.

## Retention, evidence, and reproducibility

- The runner keeps everything inside a private temporary workspace; the
  GPL-3+ originals are never modified and never copied into this repository.
- Committed evidence: `fixtures/conformance/m9/real/manifest.json`
  (provenance + policy), `evidence.json` (per-phase ledger), the MIT
  fixture + `LICENSE.TUD-slides`. The gate asserts the fixture is
  byte-identical to the pinned commit hash and that no other `.ipe`/PDF/PNG
  artifact is retained.
- The runner is deterministic per run (same source hashes, same pinned
  commit, same edit); classifications are observed on the machine state
  captured above and are expected to move only with intentional candidate
  changes (e.g. the M6 LaTeX profile or the format boundary), never as a
  result of re-running the review.
