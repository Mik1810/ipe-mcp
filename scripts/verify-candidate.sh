#!/usr/bin/env bash
set -euo pipefail

# Verify that the current staged candidate still matches an expected digest.
# Also rejects tracked unstaged changes so read-only roles cannot accidentally
# review stale staged content while newer fixes exist in the worktree.
#
# Usage:
#   scripts/verify-candidate.sh <expected-candidate-digest>

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <expected-candidate-digest>" >&2
  exit 2
fi

EXPECTED="$1"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git work tree" >&2
  exit 2
fi

if ! git diff --quiet --; then
  echo "error: tracked unstaged changes exist; candidate/worktree mismatch" >&2
  git status --short >&2
  exit 3
fi

ACTUAL="$(git write-tree)"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo "error: candidate digest changed" >&2
  echo "expected: $EXPECTED" >&2
  echo "actual:   $ACTUAL" >&2
  exit 4
fi

printf 'candidate verified: %s\n' "$ACTUAL"
