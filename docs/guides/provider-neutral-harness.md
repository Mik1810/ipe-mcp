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
