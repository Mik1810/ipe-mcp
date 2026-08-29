#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fail() { echo "M9 FAIL: $*" >&2; exit 1; }

if [[ "${IPE_M9_READONLY_GATE:-}" != "1" ]]; then
  (cd "$ROOT" && git diff --quiet --ignore-submodules=none) || fail "candidate has unstaged tracked changes"
  untracked=$(cd "$ROOT" && git ls-files --others --exclude-standard)
  [[ -z "$untracked" ]] || fail "candidate has non-ignored untracked files"
  candidate_tree=$(cd "$ROOT" && git write-tree)
  gate_root=$(mktemp -d)
  gate_checkout="$gate_root/checkout"
  cleanup_outer() {
    if [[ -d "$gate_checkout" ]]; then
      (cd "$gate_checkout" && git ls-files -z | xargs -0 -r chmod u+w) || true
      git -C "$ROOT" worktree remove --force "$gate_checkout" >/dev/null 2>&1 || true
    fi
    rm -rf "$gate_root"
  }
  trap cleanup_outer EXIT
  git -C "$ROOT" worktree add --detach "$gate_checkout" HEAD >/dev/null || fail "fresh gate worktree"
  git -C "$gate_checkout" read-tree --reset -u "$candidate_tree" || fail "reset fresh gate worktree to frozen tree"
  [[ "$(git -C "$gate_checkout" write-tree)" == "$candidate_tree" ]] || fail "fresh gate tree identity"
  (cd "$gate_checkout" && git ls-files -z | xargs -0 -r chmod a-w) || fail "make candidate tracked files read-only"
  IPE_M9_READONLY_GATE=1 IPE_M9_FROZEN_TREE="$candidate_tree" bash "$gate_checkout/scripts/check-m9.sh"
  echo "M9 FROZEN CANDIDATE PASS: $candidate_tree"
  exit 0
fi

[[ -n "${IPE_M9_FROZEN_TREE:-}" ]] || fail "frozen tree identity missing"
[[ "$(cd "$ROOT" && git write-tree)" == "$IPE_M9_FROZEN_TREE" ]] || fail "frozen tree identity changed"
(cd "$ROOT" && git diff --quiet --ignore-submodules=none) || fail "read-only gate checkout has tracked differences"
untracked=$(cd "$ROOT" && git ls-files --others --exclude-standard)
[[ -z "$untracked" ]] || fail "read-only gate checkout has non-ignored untracked files"
while IFS= read -r -d '' path; do
  [[ ! -w "$ROOT/$path" ]] || fail "tracked candidate file is writable: $path"
done < <(cd "$ROOT" && git ls-files -z)

echo "M9 GATE: frozen tree $IPE_M9_FROZEN_TREE"
(cd "$ROOT" && npm ci --no-audit --no-fund) || fail "fresh gate dependency install"
bash "$ROOT/scripts/gates/check-m8.sh" || fail "M0-M8 cumulative gate"
export IPE_M9_INHERITED_M8_TREE="$IPE_M9_FROZEN_TREE"

components=(
  check-m9-limits.sh
  check-m9-fuzz.sh
  check-m9-hostile.sh
  check-m9-setup.sh
  check-m9-sbom.sh
  check-m9-support.sh
  check-m9-notes.sh
  check-m9-real.sh
  check-m9-manual.sh
  check-m9-dod.sh
  check-m9-threat-audit.sh
  check-m9-candidate.sh
)
for component in "${components[@]}"; do
  echo "M9 GATE: $component"
  bash "$ROOT/scripts/gates/$component" || fail "$component"
done

python3 - "$ROOT" <<'PY' || fail "completion and Issue #8 schema audit"
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
completion = (root / "docs/milestones/core-m9-completion.md").read_text(encoding="utf-8")
rows = [line for line in completion.splitlines() if re.match(r"^\| M9-\d{2} \|", line)]
assert len(rows) == 17, f"expected 17 completion rows, found {len(rows)}"
assert [row.split("|")[1].strip() for row in rows] == [f"M9-{i:02d}" for i in range(1, 18)]
for token in ["fresh worktree", "non-writable", "does not start M10", "no pre-gate completion claim"]:
    assert token in completion, f"completion policy missing {token}"
assert re.search(r"never\s+patched in place", completion), "completion policy permits in-place gate patches"

audit = (root / "docs/guides/m8-agentic-harness-audit.md").read_text(encoding="utf-8")
sections = [
    "Model-facing contract",
    "Orientation and dynamic behavior",
    "Result quality and recovery",
    "Permissions and write safety",
    "Transport, integration, and privacy",
    "Code architecture and verification",
]
positions = [audit.index(f"## {section}") for section in sections]
assert positions == sorted(positions), "Issue #8 audit sections missing or out of order"
evidence_rows = []
for line in audit.splitlines():
    fields = [field.strip() for field in line.strip().strip("|").split("|")]
    if len(fields) == 3 and fields[1] in {"PASS", "NOT APPLICABLE"}:
        assert all(fields), "Issue #8 evidence row has an empty field"
        evidence_rows.append(fields)
assert len(evidence_rows) == 31, f"expected 31 Issue #8 evidence rows, found {len(evidence_rows)}"
assert sum(row[1] == "PASS" for row in evidence_rows) == 24
assert sum(row[1] == "NOT APPLICABLE" for row in evidence_rows) == 7
assert "PASS: 24. NOT APPLICABLE: 7. DEFERRED M9: 0." in audit

for path in [root / "scripts/check-m9.sh", *sorted((root / "scripts/gates").glob("check-m9-*.sh"))]:
    assert path.is_file() and path.stat().st_mode & 0o111, f"gate is missing or not executable: {path.name}"
PY

echo "M9 PASS: M0-M8 cumulative chain, all M9 contracts, 10 DoD items, 8 threats, Issue #8 schema, and completion audit"
