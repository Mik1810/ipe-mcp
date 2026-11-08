# Provider-Neutral Scenario Harness

Run the representative scenario against the built source CLI:

```bash
npm run build
bash scripts/gates/check-m10-harness.sh
```

The gate creates a private temporary workspace, result bundle, and artifacts,
then deletes them. To retain a local run for inspection:

```bash
node scripts/harness/run-scenario.mjs \
  --scenario fixtures/conformance/m10/portable-create-edit-export.json \
  --command "$(command -v node)" \
  --command-args '["dist/src/cli/mcp-stdio.js"]' \
  --workspace /tmp/ipe-mcp-harness/workspace \
  --artifacts /tmp/ipe-mcp-harness/artifacts \
  --result /tmp/ipe-mcp-harness/result.json \
  --expected-version "$(node -p 'require("./package.json").version')"
```

The paths are runner inputs only and are never written into the portable result.
The result's transcript records public event names and outcomes, not raw MCP
arguments, prompts, resource URIs, local paths, or private reasoning.

Run `npm run check:m10:cross-host` to exercise that same scenario through the
official SDK and a local Codex App Server. Codex CLI must be on `PATH` and expose
the App Server MCP tool and resource methods. The runner uses an ephemeral,
read-only App Server session with an isolated configuration and an allowlisted
environment. It calls the registered Ipe server directly, without starting a
model turn or requiring an account. The Ipe server writes only into the private
scenario workspace under the fixture's explicit approvals.

The comparison checks the contract, capability mode, semantic and visual
assertions, artifact observations, and mutation outcomes. Host-local IDs,
artifact hashes, tool-call order, and private App Server diagnostics are not
comparison inputs. A host that lacks a required capability before mutation is
reported as `SKIP` (exit 77), a mismatch or failure as `FAIL`, and a `PASS`
requires both hosts to pass. For retained per-host result bundles and bounded
comparison codes, call `scripts/harness/run-cross-host.mjs` with the same
scenario and command arguments plus `--codex /path/to/codex --output /path/to/results`.
The official SDK checks MCP initialize identity and server version. App Server
does not expose that handshake to the runner, so its result omits the product
version and checks the contract through the explicitly configured server.

## Adapter contract

An adapter exposes an `identity` and an asynchronous `execute()` function. The
runner supplies the parsed scenario, a private artifact directory, and an abort
signal. The adapter returns the fields consumed by the result v1 schema:
capability/contract identity, approvals, sanitized transcript, diagnostics,
mutation history, artifact metadata, assertions, and optional classified
failure.

An adapter must:

1. declare which semantic task kinds and capabilities it supports;
2. reject unsupported requirements before mutating a document;
3. enforce the supplied step, transcript, artifact, and call-time limits;
4. close its transport when aborted;
5. expose no raw arguments, paths, prompts, secrets, private reasoning, or
   proprietary transcript fields in its portable return value;
6. classify failures using ADR-0006 rather than parsing exact prose in a gate.

Scenarios may assert semantic structure, signatures, dimensions, bounded sizes,
and other visual observations. They must not assert exact agent prose, exact
tool-call order, transient document IDs, local paths, or byte equality of
artifacts containing legitimate generated identities.
