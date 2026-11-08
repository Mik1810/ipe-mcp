#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
echo "M10 IPE BRIDGE MCP HARNESS: orientation-and-dynamic-behavior, result-quality-and-recovery, permissions-and-write-safety, transport-integration-and-privacy, code-architecture-and-verification"
python3 "$ROOT/scripts/conformance/m10-ipe-bridge-probe.py"
