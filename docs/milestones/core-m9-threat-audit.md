# M9 Eight-ID Threat-Model Audit

Gate: `bash scripts/gates/check-m9-threat-audit.sh`. This is the authoritative
issue #23 disposition for the eight canonical threat IDs in ADR-0004.

## Audit target and policy

The product candidate under audit is the issue #21 frozen Git tree
`17b5fb3cb883b5af06f619483c11a8f9d1a8c73a`, resolved from immutable source
revision `ac854a747011f2e944619fefd3a3d0adf392ec98`. The issue #22 and #23
changes are attestation documentation, gates, fixtures, and conformance
tooling. The gate fails if `src/`, `package.json`, or `package-lock.json`
differs from the frozen source revision; a product change requires a new
candidate freeze before this audit can pass.

`PASS` requires direct current execution, not documentation alone.
`NOT APPLICABLE` is permitted only for an absent surface proved both
statically and at runtime. A CRITICAL finding blocks this audit and the M9
cumulative gate; lower-severity deferral requires a named owner and target.

## Disposition matrix

| Threat ID | Risk | Current surface | Mitigation | Direct current evidence | Disposition | Residual severity | Owner | Target |
|---|---|---|---|---|---|---|---|---|
| TM-XML | Entity expansion, ambiguous XML, parser exhaustion, or silent loss | Local Ipe XML 70218 parsing and canonical serialization | DTD/entities/namespaces rejected; byte/node/depth/text limits; strict IR validation; canonical fixed point | CURRENT: `HOST-001..008` in `fixtures/conformance/m9/hostile/manifest.json`; `tests/ipe/xml.test.ts`; `tests/property/parser.test.ts`; `scripts/conformance/m9-hostile-runner.mjs` | PASS | LOW — accepted documents remain bounded but parser regressions remain a dependency/test concern | M9/#24 | Cumulative M9 gate and every parser change |
| TM-TEX | Preamble execution, file access, shell escape, or resource exhaustion | Full validation and native LaTeX for local documents | Minimal allowlist; arbitrary preamble rejected before workspace/process creation; `-no-shell-escape`; fixed environment; bubblewrap/prlimit; total deadline | CURRENT: `HOST-009..011`; `tests/native/adapter.test.ts`; `tests/native/process.test.ts`; `bash scripts/gates/check-m9-setup.sh` | PASS | LOW — verified Linux isolation/toolchain is required and fails closed when unavailable | M9/#24 | Cumulative M9 gate; portability remains M10/#7 |
| TM-FS | Traversal, symlink escape, overwrite race, leakage, or partial save | Workspace-rooted open/save, private state, snapshots, journals | Canonical real paths and no-follow checks; source identity/hash CAS; locked verified temp+rename; recovery journal; bounded reads | CURRENT: `HOST-012..014`; `tests/persistence/session-manager.test.ts`; `tests/persistence/atomic.test.ts`; `tests/persistence/sidecar.test.ts` | PASS | LOW — authorized local save remains intentionally destructive but confirmed and recoverable | M9/#24 | Cumulative M9 gate and every persistence change |
| TM-ASSET | Decoder bombs, forged media, excessive allocation, or network-bearing assets | Inline PNG/JPEG insertion and retained Ipe bitmaps; no downloader | Signature/IHDR/SOF preflight; byte/pixel/decoder/base64 caps; supported MIME only; remote acquisition absent | CURRENT: corrected `HOST-015..017`; `tests/objects/assets.test.ts`; `tests/limits/limits.test.ts`; valid-PNG negative control in `scripts/conformance/m9-hostile-runner.mjs` | PASS | LOW — image decoder libraries remain bounded dependency surfaces | M9/#24 | Cumulative M9 gate and dependency review |
| TM-PROC | Shell injection, runaway output/forks/memory/files, crash, or stdout corruption | Fixed local Ipe/TeX/render/export subprocesses | Literal argv with `shell: false`; fixed executable policy; bubblewrap namespaces; prlimit; output/file/memory/process/time caps; stderr-only bounded diagnostics | CURRENT: corrected `HOST-018` and `HOST-024`; `tests/native/process.test.ts`; `tests/native/adapter.test.ts`; real `PROCESS_LIMIT` sentinel under `/usr/bin/python3` | PASS | LOW — depends on attested Ubuntu bubblewrap/kernel enforcement and fails closed otherwise | M9/#24 | Cumulative M9 gate; other platforms remain M10/#7 |
| TM-CONCURRENCY | Lost updates, snapshot collision, stale overwrite, or inconsistent recovery | Revisioned sessions, concurrent managers, atomic save and durable recovery | `expectedRevision`; atomic mutation clone/swap; per-target lock; final source CAS; unique snapshot sequence; journal reconciliation | CURRENT: `HOST-019`; `tests/persistence/session-manager.test.ts`; `tests/persistence/atomic.test.ts`; `tests/property/crud.test.ts`; M9 SDK stale/recovery workflow | PASS | LOW — guarantees are scoped to the supported local Ubuntu/WSL filesystem | M9/#24 | Cumulative M9 gate and every transaction change |
| TM-METADATA | ID collision, sidecar corruption, lost custom data, or disclosure in diagnostics | Persistent IDs/custom attributes, sidecars/manifests/journals, MCP errors/logs | Strict versioned schemas; global ID validation; bounded metadata reads; semantic round trips; opaque snapshot IDs; path/content redaction | CURRENT: `HOST-020..021`; `tests/persistence/sidecar.test.ts`; `tests/ipe/xml.test.ts`; `tests/objects/roundtrip.test.ts`; `tests/mcp/contracts.test.ts`; `tests/mcp/protocol.test.ts` | PASS | LOW — source metadata is untrusted but bounded; public diagnostics remain structurally redacted | M9/#24 | Cumulative M9 gate and every model-facing output change |
| TM-HTTP | Listener exposure, unauthenticated sessions, Origin/DNS-rebinding/CSRF, or credential misuse | No HTTP, SSE, WebSocket, auth, OAuth, downloader, or remote document-source surface in the MVP; local hyperlink validation remains | Only `serveStdio`; local workspace paths; open-world annotations false; `http(s)` hyperlinks schema-validated; HTTP implementation forbidden until M10 review | CURRENT: real remote-source rejection in `HOST-022`; unsafe-link rejection in `HOST-023`; static entrypoint/dependency scan and initialized stdio child with zero listening socket endpoints in `bash scripts/gates/check-m9-threat-audit.sh` | NOT APPLICABLE | NONE in MVP because the transport/auth surface is absent; HIGH if HTTP is enabled without the planned review | M10/#7 | Before any Streamable HTTP/OAuth implementation or release |

## Resolved evidence-integrity findings

These were blocking flaws in earlier evidence, not confirmed product
vulnerabilities. They are corrected by issue #23 and guarded by the new gate.

| Finding | Threat ID | Problem | Resolution | Status |
|---|---|---|---|---|
| AUD-001 | TM-ASSET | `HOST-015` set its decline flag on both acceptance and rejection | Require exact pixel-limit rejection, unchanged asset state, and a valid PNG control that must succeed | RESOLVED |
| AUD-002 | TM-PROC | `HOST-024` passed Python syntax to Node and accepted every error | Execute valid Python under bubblewrap/prlimit and require exact `PROCESS_LIMIT` stdout with clean stderr | RESOLVED |
| AUD-003 | TM-HTTP | `HOST-022` constructed an artificial failure envelope | Call the real session open path, then independently prove the initialized MCP child has no listening socket endpoint and source has no listener/auth implementation | RESOLVED |

There are no open CRITICAL findings and no known M9 security blocker is
deferred. The remaining LOW risks are regression obligations owned by the
cumulative M9 gate. The future HTTP risk is not a current residual surface;
it is owned by M10/#7 and must be reviewed before that surface exists.

## Agentic-harness compliance

Issue #8's M8 audit remains inherited through `check-m8.sh`: 24 PASS, 7 NOT
APPLICABLE, and zero deferred M9 compliance bullets. Issue #23 changes no MCP
tool description, server instruction, task payload, permission annotation,
host workflow, or model-facing response. The gate proves the relevant
`src/mcp`, `src/cli`, and production dependency surfaces are byte-identical to
the frozen candidate, so a new browser/Inspector replay is not applicable.

## Boundary

This audit does not implement HTTP, OAuth, remote downloads, public serving,
continuous animation, packaging, or cross-platform support. Those remain
outside M9. It retains no private path, credential, process log, hostile large
input, state directory, or generated binary.
