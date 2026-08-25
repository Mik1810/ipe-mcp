#!/usr/bin/env bash
set -euo pipefail

# Compact, diff-first context generator for review/gate agents.
# Usage:
#   scripts/agent-diff-context.sh <base-revision> [-- <pathspec>...]
# Examples:
#   scripts/agent-diff-context.sh origin/main
#   scripts/agent-diff-context.sh abc123 -- src tests

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <base-revision> [-- <pathspec>...]" >&2
  exit 2
fi

BASE="$1"
shift

PATHSPEC=()
if [[ ${1:-} == "--" ]]; then
  shift
  PATHSPEC=("$@")
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git work tree" >&2
  exit 2
fi

if ! git rev-parse --verify "${BASE}^{commit}" >/dev/null 2>&1; then
  echo "error: base revision '$BASE' is not a valid commit" >&2
  exit 2
fi

HEAD_SHA="$(git rev-parse HEAD)"
BASE_SHA="$(git rev-parse "$BASE")"

printf '=== REVISIONS ===\n'
printf 'BASE %s\n' "$BASE_SHA"
printf 'HEAD %s\n' "$HEAD_SHA"

printf '\n=== STATUS ===\n'
git status --short

printf '\n=== DIFF STAT ===\n'
if ((${#PATHSPEC[@]})); then
  git diff --stat "$BASE_SHA"..."$HEAD_SHA" -- "${PATHSPEC[@]}"
else
  git diff --stat "$BASE_SHA"..."$HEAD_SHA"
fi

printf '\n=== CHANGED FILES ===\n'
if ((${#PATHSPEC[@]})); then
  git diff --name-status "$BASE_SHA"..."$HEAD_SHA" -- "${PATHSPEC[@]}"
else
  git diff --name-status "$BASE_SHA"..."$HEAD_SHA"
fi

printf '\n=== DIFF ===\n'
if ((${#PATHSPEC[@]})); then
  git diff --find-renames --find-copies "$BASE_SHA"..."$HEAD_SHA" -- "${PATHSPEC[@]}"
else
  git diff --find-renames --find-copies "$BASE_SHA"..."$HEAD_SHA"
fi
