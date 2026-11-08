#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
npm run build
npx vitest run tests/mcp/http-lifecycle.test.ts
echo "M10 HTTP MCP HARNESS: model-facing-contract, orientation-and-dynamic-behavior, result-quality-and-recovery, permissions-and-write-safety, transport-integration-and-privacy, code-architecture-and-verification"
node scripts/harness/run-local-http.mjs
