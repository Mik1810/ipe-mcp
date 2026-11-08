#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
echo "M10 BRIDGE TRANSACTION MCP HARNESS: result-quality-and-recovery, permissions-and-write-safety, transport-integration-and-privacy, code-architecture-and-verification"
npx vitest run tests/bridge/spool.test.ts
python3 scripts/conformance/m10-ipe-bridge-probe.py --transaction
