# ADR-0003 — Backend, Persistence, and Identifiers

- Status: **Accepted**
- Date: 2026-08-24

## Decision

The backend is hybrid: a deterministic XML serializer/parser for the format and the official `ipescript`/Ipelib helper for import, sensitive mutations, canonicalization probes, and native validation. The server serializer owns the final representation: native output that omits explicit defaults is brought back into the IR and reserialized, rather than copied directly to the destination file. The core does not depend on MCP transport. C++ Ipelib is a future fallback, not the MVP foundation; `ipepython` is not the basis.

Every `open` creates a working copy. Mutations are atomic batches with `expectedRevision`; conflicts and a changed source hash fail without overwriting. Saving uses a temporary file plus rename and a recoverable snapshot. The source does not change before an explicit `save`.

Objects created by the server receive `custom="ipe-mcp:<uuid>"`; existing custom values are preserved. An optional versioned sidecar stores rich metadata, provenance, and layout intent without making the `.ipe` dependent on the sidecar. No XML index, name, or page order is a sufficient persistent identifier.

## Validation and Round Trip

The pipeline is layered: schema/IR, well-formed XML without external entities, advisory DTD, native load-save-reload, stylesheet, LaTeX, PDF export, and rendering. A feature not preserved by the round trip produces a diagnostic; it is not silently promised. The XML version remains `70218` after canonicalization. The `full` lane requires runtime 7.2.30; `structural-only` cannot call the native round trip “verified”.

## Consequences

The separation reduces ABI dependencies and keeps the document editable, but requires semantic diffs, fixtures, and conformance probes. Backups and revisions are part of correctness. Bundle/helper distribution is the approved deferral from ADR-0001.
