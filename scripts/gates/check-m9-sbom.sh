#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/gates/m9-common.sh"
M9_SBOM_TMP=$(mktemp -d)
trap 'rm -rf "$M9_SBOM_TMP"' EXIT
fail() { echo "M9 SBOM FAIL: $*" >&2; exit 1; }

m9_require_m8 "$ROOT" || fail "M8 gate"
(cd "$ROOT" && npm run build) || fail "build"

# Deterministic regeneration: must be byte-identical to the committed artifact.
(cd "$ROOT" && node scripts/tools/sbom.mjs "$M9_SBOM_TMP/regenerated.json" --project-version 0.1.0) || fail "sbom generation"
cmp "$M9_SBOM_TMP/regenerated.json" "$ROOT/docs/reference/sbom.json" || fail "SBOM is not byte-deterministic"

# Project license must be explicit and present.
[[ "$(node -e 'console.log(require("./package.json").license)')" == "MIT" ]] || fail "package.json license is not MIT"
[[ -f "$ROOT/LICENSE" ]] || fail "LICENSE file missing"
grep -q "Copyright (c) 2026 Michael Piccirilli" "$ROOT/LICENSE" || fail "LICENSE copyright holder missing"
grep -q '"license": "MIT"' "$ROOT/package-lock.json" || fail "package-lock.json root license missing"

python3 - "$ROOT/docs/reference/sbom.json" "$ROOT/docs/milestones/core-m9-sbom.md" <<'PY' || fail "SBOM coverage audit"
import json, pathlib, sys
sbom = json.loads(pathlib.Path(sys.argv[1]).read_text())
doc = pathlib.Path(sys.argv[2]).read_text()
components = sbom["components"]
# native toolchain present and licensed
natives = [c for c in components if c["bom-ref"].startswith("deb:")]
assert len(natives) == 6, f"expected 6 native packages, got {len(natives)}"
for name in ["ipe", "poppler-utils", "mupdf-tools", "bubblewrap", "lua5.4", "texlive-latex-base"]:
    assert any(c["name"] == name for c in natives), f"native {name} missing"
# every npm component has a license
npm = [c for c in components if c["type"] == "library"]
assert len(npm) == 111, f"expected 111 npm components, got {len(npm)}"
assert all(c.get("licenses") for c in npm), "some npm component has no license"
# boundary analysis present in the doc
for token in ["GPL subprocess boundary", "separate programs", "AGPL-3+", "private", "MIT", "runControlledProcess"]:
    assert token in doc, f"doc missing '{token}'"
PY

echo "M9 SBOM PASS: deterministic CycloneDX SBOM, npm + native license inventory, explicit MIT project license, and documented GPL subprocess boundary"
