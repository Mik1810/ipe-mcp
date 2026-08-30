#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
M10_HARNESS_TMP=$(mktemp -d)
trap 'rm -rf "$M10_HARNESS_TMP"' EXIT
fail() { echo "M10 HARNESS FAIL: $*" >&2; exit 1; }

(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && npm test -- --run tests/harness/scenario.test.mjs tests/mcp/protocol.test.ts) || fail "schema/privacy/protocol tests"
(cd "$ROOT" && node scripts/harness/generate-schemas.mjs "$M10_HARNESS_TMP/schemas") || fail "schema generation"
cmp "$M10_HARNESS_TMP/schemas/scenario.schema.json" "$ROOT/fixtures/conformance/m10/scenario.schema.json" || fail "scenario JSON Schema drift"
cmp "$M10_HARNESS_TMP/schemas/result.schema.json" "$ROOT/fixtures/conformance/m10/result.schema.json" || fail "result JSON Schema drift"

PACKAGE_VERSION=$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")
NODE_BIN=$(command -v node)
(cd "$ROOT" && node scripts/harness/run-scenario.mjs \
  --scenario fixtures/conformance/m10/portable-create-edit-export.json \
  --command "$NODE_BIN" \
  --command-args '["dist/src/cli/mcp-stdio.js"]' \
  --workspace "$M10_HARNESS_TMP/workspace" \
  --artifacts "$M10_HARNESS_TMP/artifacts" \
  --result "$M10_HARNESS_TMP/result.json" \
  --expected-version "$PACKAGE_VERSION") || fail "representative end-to-end scenario"

node --input-type=module - "$M10_HARNESS_TMP/result.json" "$M10_HARNESS_TMP/artifacts" <<'NODE' || fail "portable result audit"
import { readFile, readdir } from "node:fs/promises";
const result = JSON.parse(await readFile(process.argv[2], "utf8"));
if (result.schemaVersion !== 1 || result.scenarioId !== "portable-create-edit-export" || result.status !== "PASS") throw new Error("result identity/status mismatch");
if (result.contract !== "ipe-mcp/1" || result.capabilityMode !== "full-7.2.30") throw new Error("contract/capability mismatch");
if (result.assertions.semantic !== "PASS" || result.assertions.visual !== "PASS") throw new Error("semantic/visual assertions did not pass");
if (result.transcript.some((entry) => "arguments" in entry || "uri" in entry || "prompt" in entry)) throw new Error("private transcript field retained");
for (const stage of ["agent-planning", "protocol", "server", "native-ipe", "artifact-quality"]) {
  const schema = await readFile("fixtures/conformance/m10/result.schema.json", "utf8");
  if (!schema.includes(`\"${stage}\"`)) throw new Error(`failure stage missing: ${stage}`);
}
const serialized = JSON.stringify(result);
if (serialized.includes(process.argv[3]) || /Bearer\s+|_authToken|password=|reasoning_content/iu.test(serialized)) throw new Error("portable bundle leaked private data");
const files = (await readdir(process.argv[3])).sort();
if (JSON.stringify(files) !== JSON.stringify(["portable-create-edit-export-preview.png", "portable-create-edit-export.ipe", "portable-create-edit-export.pdf", "portable-create-edit-export.png"])) throw new Error(`artifact set mismatch: ${files}`);
if (result.artifacts.length !== 4 || result.mutationHistory.length !== 5) throw new Error("artifact or mutation evidence incomplete");
NODE

echo "M10 HARNESS MCP HARNESS: model-facing-contract, orientation-and-dynamic-behavior, result-quality-and-recovery, transport-integration-and-privacy, code-architecture-and-verification"
echo "M10 HARNESS PASS: scenario/result v1, bounded official-SDK stdio adapter, classified portable evidence, create/edit/recovery/validate/render/export"
