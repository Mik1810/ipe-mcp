#!/usr/bin/env bash
set -euo pipefail

# Create a compact handoff skeleton populated with Git revisions and changed paths.
# Usage: scripts/new-handoff.sh <milestone> <base-revision> [output-file] [issue] [candidate-digest]

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <milestone> <base-revision> [output-file] [issue] [candidate-digest]" >&2
  exit 2
fi

MILESTONE="$1"
BASE="$2"
OUT="${3:-.agent-handoff.yaml}"
ISSUE="${4:-null}"
CANDIDATE="${5:-null}"

BASE_SHA="$(git rev-parse "$BASE")"
HEAD_SHA="$(git rev-parse HEAD)"

{
  cat <<YAML
kind: agent-handoff
milestone: "$MILESTONE"
issue: "$ISSUE"
role_completed: "<implementer|reviewer|corrector|finding-verifier|gate>"
base_revision: "$BASE_SHA"
head_revision: "$HEAD_SHA"
candidate_digest: "$CANDIDATE"

objective: >-
  <short goal>

acceptance_status: []

review_findings: []

mcp_harness_compliance:
  applicable_areas: []
  evidence: []
  findings: []
  not_applicable_reason: null

verification:
  passed: []
  failed: []

changed_paths:
YAML

  # If a staged candidate exists, it is authoritative for the handoff.
  if ! git diff --cached --quiet --; then
    mapfile -t changed < <(git diff --cached --name-only "$BASE_SHA")
  else
    mapfile -t changed < <(git diff --name-only "$BASE_SHA"..."$HEAD_SHA")
  fi

  if ((${#changed[@]} == 0)); then
    printf '  []\n'
  else
    printf '  - "%s"\n' "${changed[@]}"
  fi

  cat <<'YAML'

deferred_backlog: []
blockers: []
next_role: "<reviewer|corrector|finding-verifier|gate|done>"
YAML
} > "$OUT"

printf 'created %s\n' "$OUT"
