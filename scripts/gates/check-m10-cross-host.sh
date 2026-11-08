#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
cd "$ROOT"
npm run build
npm test -- --run tests/harness/scenario.test.mjs tests/mcp/protocol.test.ts

codex_args=()
if codex_bin=$(command -v codex); then codex_args=(--codex "$codex_bin"); fi
version=$(node -p 'require("./package.json").version')
status=0
node scripts/harness/run-cross-host.mjs \
  --scenario fixtures/conformance/m10/portable-create-edit-export.json \
  --command "$(command -v node)" \
  --command-args '["dist/src/cli/mcp-stdio.js"]' \
  --expected-version "$version" \
  --output "$output" \
  "${codex_args[@]}" || status=$?

echo "M10 CROSS-HOST MCP HARNESS: model-facing-contract, orientation-and-dynamic-behavior, result-quality-and-recovery, transport-integration-and-privacy, code-architecture-and-verification"
case "$status" in
  0) echo "M10 CROSS-HOST PASS: both hosts passed the same semantic and visual checks" ;;
  77) echo "M10 CROSS-HOST SKIP: a required host capability was unavailable" ;;
  *) echo "M10 CROSS-HOST FAIL: see bounded host outcomes above" >&2 ;;
esac
exit "$status"
