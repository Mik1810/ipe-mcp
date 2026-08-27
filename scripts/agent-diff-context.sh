#!/usr/bin/env bash
set -euo pipefail

# Compact diff-first context generator.
# Usage:
#   scripts/agent-diff-context.sh <base-revision> [--cached] [-- <pathspec>...]
#
# Examples:
#   scripts/agent-diff-context.sh origin/main
#   scripts/agent-diff-context.sh abc123 --cached
#   scripts/agent-diff-context.sh abc123 --cached -- src tests

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <base-revision> [--cached] [-- <pathspec>...]" >&2
  exit 2
fi

BASE="$1"
shift
CACHED=0
PATHSPEC=()

if [[ ${1:-} == "--cached" ]]; then
  CACHED=1
  shift
fi

if [[ ${1:-} == "--" ]]; then
  shift
  PATHSPEC=("$@")
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git work tree" >&2
  exit 2
fi

BASE_SHA="$(git rev-parse "${BASE}^{commit}")"
HEAD_SHA="$(git rev-parse HEAD)"

printf '=== REVISIONS ===\n'
printf 'BASE %s\n' "$BASE_SHA"
printf 'HEAD %s\n' "$HEAD_SHA"
printf 'MODE %s\n' "$([[ $CACHED -eq 1 ]] && echo staged-candidate || echo committed-head)"

printf '\n=== STATUS ===\n'
git status --short

if [[ $CACHED -eq 1 ]]; then
  printf '\n=== CANDIDATE DIGEST ===\n'
  git write-tree
  DIFF_ARGS=(--cached "$BASE_SHA")
else
  DIFF_ARGS=("$BASE_SHA"..."$HEAD_SHA")
fi

printf '\n=== DIFF STAT ===\n'
if ((${#PATHSPEC[@]})); then
  git diff --stat "${DIFF_ARGS[@]}" -- "${PATHSPEC[@]}"
else
  git diff --stat "${DIFF_ARGS[@]}"
fi

printf '\n=== CHANGED FILES ===\n'
if ((${#PATHSPEC[@]})); then
  git diff --name-status "${DIFF_ARGS[@]}" -- "${PATHSPEC[@]}"
else
  git diff --name-status "${DIFF_ARGS[@]}"
fi

printf '\n=== DIFF ===\n'
if ((${#PATHSPEC[@]})); then
  git diff --find-renames --find-copies "${DIFF_ARGS[@]}" -- "${PATHSPEC[@]}"
else
  git diff --find-renames --find-copies "${DIFF_ARGS[@]}"
fi
