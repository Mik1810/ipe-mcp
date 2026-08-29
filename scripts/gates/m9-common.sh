#!/usr/bin/env bash

# A standalone M9 component inherits M8 by running it. The cumulative M9 gate
# may reuse its own successful M8 result only for the exact staged tree that it
# is checking; a caller cannot use a stale or arbitrary skip flag.
m9_require_m8() {
  local root=$1
  local current_tree
  current_tree=$(cd "$root" && git write-tree)
  if [[ -n "${IPE_M9_INHERITED_M8_TREE:-}" ]]; then
    [[ "$IPE_M9_INHERITED_M8_TREE" == "$current_tree" ]] || {
      echo "M9 FAIL: inherited M8 evidence is for a different tree" >&2
      return 1
    }
    echo "M9 INFO: reusing M8 PASS for staged tree $current_tree"
    return 0
  fi
  bash "$root/scripts/gates/check-m8.sh"
}
