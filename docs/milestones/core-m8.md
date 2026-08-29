# M8 MCP stdio core

M8 exposes the stabilized M0-M7 core through the official TypeScript MCP SDK v2 over stdio. The transport entry point is `dist/src/cli/mcp-stdio.js`; stdout is reserved for MCP frames and structural telemetry is emitted on stderr without values, paths, identifiers, or content.

## Surface

The stable `ipe_` grammar provides orientation and capabilities; document create/open/inspect; atomic typed operations; semantic slide composition; reveal/motion view building; structural/full validation; PNG previews; save; PDF/PNG export; and snapshot/list/undo/restore/recover history. All results use contract `ipe-mcp/1`, the same JSON in text and structured content, capped typed hints, and discriminated corrective failures.

Every source mutation uses `DocumentSessionManager` compare-and-swap with `expectedRevision`. Delete, save, undo, and restore require explicit tokens and destructive annotations are conservative. Delete results identify removed IDs, while updates return bounded previous values. New sessions and working revisions are durable; snapshot IDs are opaque and deterministic across restart.

Document summary/source/diagnostic resources are bounded. Preview and artifact tool calls return metadata plus `resource_link` blocks; base64 is produced only by an explicit resource read. Native processes remain the fixed, attested M6 commands with process, output, artifact, and total-operation bounds. Full validation, render, and export report progress when the host supplies a progress token.

## Architecture

`src/mcp/contracts.ts` owns public vocabulary and Zod contracts; `errors.ts` owns public mapping/redaction and structural logging; `service.ts` is the deliberate facade over domain/persistence/native features; `artifacts.ts` bounds connection-local binary resources; `server.ts` maps that facade to tools/resources; and `src/cli/mcp-stdio.ts` owns environment parsing, transport, signals, and shutdown. The domain core has no MCP dependency.

## Verification

`tests/mcp` checks contracts, rollback/CAS, exact IDs, confirmations/evidence, persistent history, real SDK stdio, progress, native failure framing, resources, redaction, parity, and shutdown. `scripts/host/m8-sdk-host.mjs` runs the portable native scenario through an independent real MCP client and validates `.ipe`, PDF, PNG, rollback, undo/restore, and explicit resource reads. `scripts/gates/check-m8.sh` recursively runs M7, M8 tests, the portable scenario, manifest/audit/config checks, and retained real-host evidence.

M8 is complete: the designated repository review, finding verification, external integration verification, and final gate passed. M9 hardening and M10 HTTP/OAuth/distribution remain out of scope.
