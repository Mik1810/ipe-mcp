#!/usr/bin/env bash
set -euo pipefail

# Compact Git context for an agent.
#
# Usage:
#   scripts/agent/agent-context.sh
#   scripts/agent/agent-context.sh --cached
#   scripts/agent/agent-context.sh --diff
#   scripts/agent/agent-context.sh --diff -- src tests
#
# By default this intentionally DOES NOT print the full diff.

cached=0
show_diff=0
paths=()

while (($#)); do
  case "$1" in
    --cached)
      cached=1
      shift
      ;;
    --diff)
      show_diff=1
      shift
      ;;
    --)
      shift
      paths+=("$@")
      break
      ;;
    *)
      paths+=("$1")
      shift
      ;;
  esac
done

git rev-parse --is-inside-work-tree >/dev/null

diff_args=()
if (( cached )); then
  diff_args+=(--cached)
fi

path_args=()
if ((${#paths[@]})); then
  path_args+=(-- "${paths[@]}")
fi

printf '%s\n' '=== BRANCH / STATUS ==='
git status --short --branch

printf '\n%s\n' '=== DIFF STAT ==='
git diff "${diff_args[@]}" --stat "${path_args[@]}"

printf '\n%s\n' '=== CHANGED FILES ==='
git diff "${diff_args[@]}" --name-status "${path_args[@]}"

if (( show_diff )); then
  printf '\n%s\n' '=== DIFF (capped) ==='
  # Keep accidental context explosions bounded. Increase manually only when needed.
  git diff "${diff_args[@]}" -- "${paths[@]}" | sed -n '1,500p'
  lines="$(git diff "${diff_args[@]}" -- "${paths[@]}" | wc -l | tr -d ' ')"
  if (( lines > 500 )); then
    printf '\n[diff truncated: %s total lines; scope paths or inspect specific hunks]\n' "$lines"
  fi
fi
