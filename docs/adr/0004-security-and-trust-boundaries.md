# ADR-0004 — Security and Trust Boundaries

- Status: **Accepted**
- Date: 2026-08-24

The server treats documents, LaTeX, assets, and metadata as untrusted input. The canonical IDs in the M0 threat model are listed below; each has a risk, mitigation, and future gate.

## TM-XML
- Risk: XXE, entity expansion, ambiguous XML, or data loss.
- Mitigation: parser without DTD/external entities, limits, canonical XML, separate schema/IR and round-trip checks.
- Future gate: M1 DTD/runtime probe, fuzz corpus, and golden round trip.

## TM-TEX
- Risk: LaTeX/preamble causes execution, file reads, or DoS.
- Mitigation: isolated temp directory, shell escape/network disabled, controlled `TEXINPUTS`, timeout, and resource limits.
- Future gate: M6 pdfLaTeX sandbox with hostile fixtures and timeout.

## TM-FS
- Risk: traversal, symlink escape, overwrite, or leakage.
- Mitigation: root allowlist, realpath, working copy, temp+rename, snapshot, and no arbitrary paths.
- Future gate: M1/M9 symlink, traversal, and atomic recovery tests.

## TM-ASSET
- Risk: malicious assets/network, forged MIME, or oversized files/images.
- Mitigation: remote access disabled; separate downloads with allowlist and size/pixel/MIME/hash checks.
- Future gate: M6/M9 asset corpus and limit verification.

## TM-PROC
- Risk: arbitrary Ipe/CLI subprocesses or tools enable injection or loss of MCP stdout.
- Mitigation: fixed commands and typed arguments, no shell tool, minimal environment, timeout, stderr for logs, and protocol-only stdout.
- Future gate: M6/M8 process harness and MCP Inspector smoke test.

## TM-CONCURRENCY
- Risk: races, overwrites, and inconsistent working copies.
- Mitigation: revision counter, `expectedRevision`, atomic batches, session lock, source hash, temp+rename, and snapshot.
- Future gate: M1/M9 concurrency tests, crash injection, and restore invariants.

## TM-METADATA
- Risk: lost `custom`/sidecar data, ID collisions, or data leakage.
- Mitigation: UUIDs with `ipe-mcp:` prefix, custom preservation, versioned sidecar, redacted logs, and semantic diff.
- Future gate: M1 `custom`/`x-*` tests, collision/fuzz testing, and redaction audit.

## TM-HTTP
- Risk: a future HTTP surface exposes sessions or permits DNS rebinding, CSRF, and unauthorized access.
- Mitigation: no HTTP in the MVP; future localhost binding, Origin validation, authentication, and anti-rebinding.
- Future gate: M10 threat review and auth/Origin/rebinding tests before release.

Distribution remains an approved deferral: it will be reassessed with licensing, packaging, and sandboxing.
