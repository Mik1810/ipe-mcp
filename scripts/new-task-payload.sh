#!/usr/bin/env bash
set -euo pipefail

# Create a compact explicit task payload for a fresh worker.
# Usage:
#   scripts/new-task-payload.sh <milestone> <role> <base-revision> [output-file] [issue] [candidate-digest]

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <milestone> <role> <base-revision> [output-file] [issue] [candidate-digest]" >&2
  exit 2
fi

MILESTONE="$1"
ROLE="$2"
BASE="$3"
OUT="${4:-.agent-task.yaml}"
ISSUE="${5:-null}"
CANDIDATE="${6:-null}"

case "$ROLE" in
  implementer|corrector|reviewer|finding-verifier|gate) ;;
  *)
    echo "error: role must be implementer, corrector, reviewer, finding-verifier, or gate" >&2
    exit 2
    ;;
esac

BASE_SHA="$(git rev-parse "$BASE")"
HEAD_SHA="$(git rev-parse HEAD)"

cat > "$OUT" <<YAML
kind: agent-task
milestone: "$MILESTONE"
issue: "$ISSUE"
role: "$ROLE"
base_revision: "$BASE_SHA"
head_revision: "$HEAD_SHA"
candidate_digest: "$CANDIDATE"

goal: >-
  <exact atomic goal>

acceptance_criteria: []

relevant_context:
  docs: []
  constraints: []

scope:
  expected_paths: []
  out_of_scope: []

findings_to_address: []
findings_to_verify: []

verification:
  targeted: []
  final: []

expected_output: >-
  <compact role-specific result>
YAML

printf 'created %s\n' "$OUT"
