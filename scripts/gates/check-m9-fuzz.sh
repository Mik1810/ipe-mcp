#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/gates/m9-common.sh"
fail() { echo "M9 FUZZ FAIL: $*" >&2; exit 1; }

m9_require_m8 "$ROOT" || fail "M8 gate"
(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && npm test -- --run tests/property) || fail "property/fuzz suites"

echo "M9 FUZZ PASS: seeded, budgeted property/fuzz suites for matrices, geometry, XML parser, CRUD, and MCP protocol"
