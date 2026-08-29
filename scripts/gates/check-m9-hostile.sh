#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/gates/m9-common.sh"
fail() { echo "M9 HOSTILE FAIL: $*" >&2; exit 1; }

m9_require_m8 "$ROOT" || fail "M8 gate"
(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && node scripts/conformance/m9-hostile-runner.mjs "$ROOT") || fail "hostile corpus"

echo "M9 HOSTILE PASS: classified hostile corpus green across all eight TM IDs with size/time budgets and no residue"
