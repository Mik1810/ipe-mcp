# M9 Hostile-Input Corpus

Gate: `bash scripts/gates/check-m9-hostile.sh` (includes M8, `npm run build`, and the
corpus runner).  The cumulative M9 gate (#24) is expected to consume this gate
unchanged.

## Layout

- `fixtures/conformance/m9/hostile/manifest.json`: every case with a stable
  `id`, a canonical threat ID (`TM-XML`, `TM-TEX`, `TM-FS`, `TM-ASSET`,
  `TM-PROC`, `TM-CONCURRENCY`, `TM-METADATA`, `TM-HTTP`), input provenance
  (`file`, `inline`, or `generated`), an oracle reference, the expected
  classification, and a size/time budget (`maxInputBytes`, `maxMs`).
- `fixtures/conformance/m9/hostile/inputs/`: synthetic, small, PII-free input
  files referenced by file-provenance cases.
- `scripts/conformance/m9-hostile-runner.mjs`: deterministic in-process
  runner; imports `dist` only, creates all state under private temporary
  directories, removes them before exit, and exits non-zero on any failure.

## Case inventory (24 cases)

| Case | Threat ID | Input | Oracle |
|---|---|---:|---|
| HOST-001..006 | TM-XML | entity declaration, namespace, remote doctype, wrong version, CDATA null, depth bomb | `xml-rejects` |
| HOST-007 | TM-XML | inline minimal document | `xml-canonical-fixed-point` |
| HOST-008 | TM-XML | seeded structural fuzz (64 KiB cap) | `xml-fuzz-safe` |
| HOST-009..011 | TM-TEX | disallowed package, arbitrary preamble, allowlisted package | `latex-policy` |
| HOST-012 | TM-FS | `../` traversal against an existing outside file | `fs-path-traversal` |
| HOST-013 | TM-FS | symlink escaping the workspace root | `fs-symlink-escape` |
| HOST-014 | TM-FS | 17 MiB source read | `fs-oversized-source` |
| HOST-015..016 | TM-ASSET | oversized IHDR bomb, truncated PNG | `asset-ihdr-bomb` / `asset-png-payload` |
| HOST-017 | TM-ASSET | base64 payload over contract cap | `contract-base64-cap` |
| HOST-018 | TM-PROC | runaway output producer | `proc-output-cap` |
| HOST-019 | TM-CONCURRENCY | concurrent save-as across managers | `concurrency-snapshot-uniqueness` |
| HOST-020..021 | TM-METADATA | unknown sidecar fields, non-finite numbers | `sidecar-unknown-field` |
| HOST-022 | TM-HTTP | remote URL used as a document source | `http-no-remote-source` |
| HOST-023 | TM-HTTP | `javascript:` group hyperlink | `http-link-schema` |
| HOST-024 | TM-PROC | fork bomb containment under prlimit | `proc-fork-cap` |

## Oracle stability

Every case returns exactly one of PASS or FAIL with a stable expected
classification; a deviation (wrong rejection type, accepted hostile input,
budget overrun, oracle exception) surfaces as a case-level failure with the
exact reason.  HOST-023 drove a contract hardening: the `group_objects`
hyperlink field now validates absolute `http(s)` URLs only (was permissive
`z.string().url()`).
