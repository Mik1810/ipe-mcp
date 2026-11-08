#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if ! codex_bin=$(command -v codex); then
  echo "M10 CODEX PLUGIN SKIP: Codex CLI unavailable"
  exit 77
fi
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
cd "$ROOT"
npm run build
mkdir "$output/pack" "$output/install"
npm pack --ignore-scripts --pack-destination "$output/pack" --silent
tarballs=("$output/pack/"*.tgz)
[[ ${#tarballs[@]} == 1 && -f "${tarballs[0]}" ]]
npm install --prefix "$output/install" --ignore-scripts --no-audit --no-fund "${tarballs[0]}"
node scripts/harness/check-codex-plugin.mjs "$codex_bin" "$output/install/node_modules/.bin/ipe-mcp" "$output"
echo "M10 CODEX PLUGIN MCP HARNESS: model-facing-contract, orientation-and-dynamic-behavior, permissions-and-write-safety, transport-integration-and-privacy, code-architecture-and-verification"
echo "M10 CODEX PLUGIN PASS: installed local plugin, portable workflow, uninstall and retained workspace"
