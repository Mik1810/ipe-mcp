#!/usr/bin/env bash
set -euo pipefail

# Creates a compact handoff skeleton populated with git revisions.
# Usage: scripts/new-handoff.sh <milestone> <base-revision> [output-file]

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <milestone> <base-revision> [output-file]" >&2
  exit 2
fi

MILESTONE="$1"
BASE="$2"
OUT="${3:-.agent-handoff.yaml}"

BASE_SHA="$(git rev-parse "$BASE")"
HEAD_SHA="$(git rev-parse HEAD)"

cat > "$OUT" <<YAML
kind: agent-handoff
milestone: "$MILESTONE"
role_completed: "<implementer|reviewer|gate>"
base_revision: "$BASE_SHA"
head_revision: "$HEAD_SHA"

goal: >-
  <short goal>

relevant_constraints: []

changed_paths:
$(git diff --name-only "$BASE_SHA"..."$HEAD_SHA" | sed 's/^/  - "/; s/$/"/' || true)

findings:
  blockers: []
  majors: []
  minors: []

verification:
  passed: []
  failed: []
  recommended_next: []

caveats: []
next_role: "<reviewer|implementer|gate|done>"
YAML

printf 'created %s\n' "$OUT"
