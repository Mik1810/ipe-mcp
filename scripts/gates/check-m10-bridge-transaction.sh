#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
echo "M10 BRIDGE TRANSACTION MCP HARNESS: result-quality-and-recovery, permissions-and-write-safety, transport-integration-and-privacy, code-architecture-and-verification"
npm test -- --run tests/bridge tests/persistence/session-manager.test.ts
python3 scripts/conformance/m10-ipe-bridge-probe.py --transaction
