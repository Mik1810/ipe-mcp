#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/gates/m9-common.sh"
M9_SBOM_TMP=$(mktemp -d)
trap 'rm -rf "$M9_SBOM_TMP"' EXIT
fail() { echo "M9 SBOM FAIL: $*" >&2; exit 1; }

m9_require_m8 "$ROOT" || fail "M8 gate"
(cd "$ROOT" && npm run build) || fail "build"

# Determinism is a property of identical inputs, including installed packages.
(cd "$ROOT" && node scripts/tools/sbom.mjs "$M9_SBOM_TMP/regenerated.json" --project-version 0.1.0) || fail "sbom generation"
(cd "$ROOT" && node scripts/tools/sbom.mjs "$M9_SBOM_TMP/repeated.json" --project-version 0.1.0) || fail "repeated sbom generation"
cmp "$M9_SBOM_TMP/regenerated.json" "$M9_SBOM_TMP/repeated.json" || fail "SBOM is not byte-deterministic for the installed toolchain"

# Project license must be explicit and present.
[[ "$(node -e 'console.log(require("./package.json").license)')" == "MIT" ]] || fail "package.json license is not MIT"
[[ -f "$ROOT/LICENSE" ]] || fail "LICENSE file missing"
grep -q "Copyright (c) 2026 Michael Piccirilli" "$ROOT/LICENSE" || fail "LICENSE copyright holder missing"
grep -q '"license": "MIT"' "$ROOT/package-lock.json" || fail "package-lock.json root license missing"

python3 - "$ROOT/docs/reference/sbom.json" "$M9_SBOM_TMP/regenerated.json" "$ROOT/docs/milestones/core-m9-sbom.md" <<'PY' || fail "SBOM coverage audit"
import json, pathlib, re, sys
archived = json.loads(pathlib.Path(sys.argv[1]).read_text())
sbom = json.loads(pathlib.Path(sys.argv[2]).read_text())
doc = pathlib.Path(sys.argv[3]).read_text()
assert {k: v for k, v in archived.items() if k != "components"} == {k: v for k, v in sbom.items() if k != "components"}, "SBOM metadata changed"
assert len(archived["components"]) == len(sbom["components"]), "SBOM component count changed"
for recorded, live in zip(archived["components"], sbom["components"]):
    if recorded == live:
        continue
    name = recorded["name"]
    assert name in {"bubblewrap", "poppler-utils"} and recorded["type"] == "application", f"unexpected SBOM drift: {name}"
    assert {k: v for k, v in recorded.items() if k not in {"version", "bom-ref", "purl"}} == {k: v for k, v in live.items() if k not in {"version", "bom-ref", "purl"}}, f"{name} metadata or license changed"
    old, new = (re.fullmatch(r"(.+ubuntu0)\.(\d+)", entry["version"]) for entry in (recorded, live))
    assert old and new and old[1] == new[1] and int(new[2]) >= int(old[2]), f"{name} changed outside the allowed Ubuntu update series"
    version = live["version"]
    assert live["bom-ref"] == f"deb:{name}@{version}" and live["purl"] == f"pkg:deb/ubuntu/{name}@{version}", f"{name} identity does not match its installed version"
    print(f"M9 SBOM INFO: {name} Ubuntu revision {recorded['version']} -> {version}")

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
