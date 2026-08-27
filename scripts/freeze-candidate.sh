#!/usr/bin/env bash
set -euo pipefail

# Freeze the current staged candidate and print a compact identity block.
# The script refuses to freeze when tracked unstaged changes exist, because
# reviewer/verifier/gate must not inspect an older staged candidate while
# newer tracked fixes live only in the worktree.
#
# Usage:
#   scripts/freeze-candidate.sh [output-file]
#
# Default output file: .agent-candidate.yaml

OUT="${1:-.agent-candidate.yaml}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git work tree" >&2
  exit 2
fi

if ! git diff --quiet --; then
  echo "error: tracked unstaged changes exist; stage or revert them before freezing the candidate" >&2
  git status --short >&2
  exit 3
fi

HEAD_SHA="$(git rev-parse HEAD)"
TREE_SHA="$(git write-tree)"
INDEX_DIFF_SHA="$(git diff --cached --binary HEAD | git hash-object --stdin)"

# Capture untracked paths before writing the manifest itself, so the manifest
# does not create a false warning simply by existing.
mapfile -t UNTRACKED < <(git ls-files --others --exclude-standard)

{
  cat <<YAML
kind: frozen-candidate
head_revision: "$HEAD_SHA"
candidate_digest: "$TREE_SHA"
staged_diff_digest: "$INDEX_DIFF_SHA"
YAML

  printf 'untracked_paths:\n'
  if ((${#UNTRACKED[@]} == 0)); then
    printf '  []\n'
  else
    printf '  - "%s"\n' "${UNTRACKED[@]}"
  fi
} > "$OUT"

printf '%s\n' "candidate_digest=$TREE_SHA"
printf '%s\n' "head_revision=$HEAD_SHA"
printf '%s\n' "staged_diff_digest=$INDEX_DIFF_SHA"
printf '%s\n' "manifest=$OUT"

if git diff --cached --quiet --; then
  echo "warning: candidate has no staged changes relative to HEAD" >&2
fi

if ((${#UNTRACKED[@]})); then
  echo "warning: untracked files exist; they are listed in $OUT but are not part of the staged candidate" >&2
fi
