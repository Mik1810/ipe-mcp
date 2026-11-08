#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

echo "M10 VECTOR IMPORT MCP HARNESS: model-facing-contract, orientation-and-dynamic-behavior, result-quality-and-recovery, permissions-and-write-safety, transport-integration-and-privacy, code-architecture-and-verification"
npm run build
npm test -- --run tests/import tests/mcp/protocol.test.ts
