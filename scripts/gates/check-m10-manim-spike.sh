#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
: "${MANIM_SPIKE_PYTHON:?Set MANIM_SPIKE_PYTHON to the prepared Manim 0.22.1 environment}"
if [[ "$MANIM_SPIKE_PYTHON" != /* || ! -x "$MANIM_SPIKE_PYTHON" ]]; then
  echo "M10 MANIM FAIL: use an absolute path to the executable" >&2
  exit 1
fi
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
echo "M10 MANIM MCP HARNESS: result-quality-and-recovery, permissions-and-write-safety, transport-integration-and-privacy, code-architecture-and-verification"
"$MANIM_SPIKE_PYTHON" scripts/conformance/m10-manim-probe.py "$output"
