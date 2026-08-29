# M8 host integration

## Build and run

Requirements are Node 20+, Ipe 7.2.30, pdfLaTeX, Poppler, MuPDF, and the other M6 dependencies in `SETUP-WSL.md`.

```bash
npm ci
npm run build
IPE_MCP_WORKSPACE_ROOT="$PWD" IPE_MCP_STATE_ROOT="$PWD/.ipe-mcp-state" npm run mcp
```

Do not type into the server process: stdin/stdout carry MCP frames. Logs go to stderr. Stop with the host disconnect, `SIGINT`, or `SIGTERM`. The optional `IPE_MCP_NATIVE_TIMEOUT_MS` accepts 1-300000; native operations also retain the M6 total deadline and resource limits.

## Codex

The project-local `.codex/config.toml` launches the built entry point without changing user configuration. From this repository, `codex mcp list` should show `ipe-mcp` enabled. A non-interactive probe is:

```bash
codex exec --ephemeral -C "$PWD" 'Use ipe_orientation, create a standard document, and inspect it.'
```

Codex CLI 0.149.0-alpha.4.3 was exercised over real stdio through the complete mutation/native workflow: exact-ID authoring, stale rollback, snapshot/undo/restore, full validation, confirmed save, and preview/PDF/PNG resource links, all with text/structured parity. Its conservative tool approval stopped an initial no-approval mutation as intended; the isolated fixture run used explicit approval bypass. Codex must be run without `--ignore-user-config`, because that option also suppresses project MCP configuration in the tested build.

## VS Code and second host

`.vscode/mcp.json` is a project-scoped VS Code stdio configuration. Open the repository, run `npm run build`, then use **MCP: List Servers** and start `ipe-mcp`. No user-global configuration is changed.

The automated independent host is `scripts/m8-sdk-host.mjs`, built on `@modelcontextprotocol/client` 2.0.0 and a spawned stdio transport—not an in-process controller mock:

```bash
node scripts/m8-sdk-host.mjs /tmp/ipe-m8-sdk
```

It performs orientation, create, exact-ID authoring, snapshot, stale rejection, undo, restore, full native validation, save, render, PDF/PNG export, three resource reads, and native artifact checks.

## MCP Inspector

MCP Inspector 2.4.0 was exercised as an actual stdio host. Pass isolated roots with Inspector's `-e` options so they reach the stdio child (environment variables set only on the outer process are not inherited by the child transport):

```bash
INSPECTOR_RUN_ROOT=$(mktemp -d /tmp/ipe-m8-inspector-XXXXXX)
npx --yes @modelcontextprotocol/inspector@2.4.0 --web \
  node "$PWD/dist/src/cli/mcp-stdio.js" --cwd "$PWD" \
  -e IPE_MCP_WORKSPACE_ROOT="$INSPECTOR_RUN_ROOT" \
  -e IPE_MCP_STATE_ROOT="$INSPECTOR_RUN_ROOT/.state"
```

The required preflight passed with explicit child environment propagation, isolated workspace/state roots, initialization, discovery of 13 tools and three resource templates, orientation, and clean stdout/stderr separation.

The complete deterministic workflow used Inspector's real launcher/web remote-session protocol API over stdio, not browser click automation. One persistent connection executed 14 tool calls: orientation; 16:9 create; a rectangle with exact page/layer IDs and numeric Ipe colors; snapshot; a revision-guarded mutation; rejected stale mutation with revision unchanged; confirmed undo and restore; inspect at revision 4 with one object; full native validation; confirmed save; preview; and PDF/PNG export. It read all three distinct generated resources. The saved document was XML 70218, the PDF began with `%PDF-`, and both PNG resources had the PNG signature and 1280x720 dimensions. The protocol stream used stdout exclusively, stderr contained only bounded structural events, and shutdown and cleanup passed.

The web UI was used only for a minimal client-specific smoke: in 13 browser automation rounds it confirmed discovery, ran one create tool, read one document-summary resource, and disconnected cleanly. The frozen candidate digest `b35d7c398613542d8aa3fc4160c5b799dd6936c7` was verified before and after external verification. No temporary paths, authorization URLs, or artifact payloads are retained in this evidence.

## Recovery and troubleshooting

- `REVISION_CONFLICT`: inspect and retry using the current revision; the stale batch made no write.
- `IDENTIFIER_NOT_FOUND`: inspect and copy the exact current ID.
- `CONFIRMATION_REQUIRED`: obtain user intent, then send the documented token.
- `PATH_OUTSIDE_WORKSPACE`: choose a target under `IPE_MCP_WORKSPACE_ROOT`.
- `NATIVE_TIMEOUT` or other `NATIVE_*`: call capabilities, inspect diagnostics, reduce complexity if retryable, and verify the fixed local toolchain.
- Restart: call `ipe_history` with `action="recover"`, then inspect the recovered ID. Snapshot IDs returned by list remain usable after restart. Artifacts are connection-local and must be regenerated after restart.
