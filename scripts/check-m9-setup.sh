#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
M9_SETUP_TMP=$(mktemp -d)
trap 'rm -rf "$M9_SETUP_TMP"' EXIT
fail() { echo "M9 SETUP FAIL: $*" >&2; exit 1; }

echo "M9 SETUP: node $(node --version) on $(uname -s)-$(uname -m)"

# --- 1. Clean snapshot install (no inherited node_modules) -------------------
SNAPSHOT="$M9_SETUP_TMP/snapshot"
mkdir -p "$SNAPSHOT"
(cd "$ROOT" && git archive --format=tar HEAD) | tar -xf - -C "$SNAPSHOT" || fail "snapshot extraction"
[[ ! -d "$SNAPSHOT/node_modules" ]] || fail "snapshot unexpectedly contains node_modules"
[[ ! -d "$SNAPSHOT/dist" ]] || fail "snapshot unexpectedly contains dist artifacts"
node_major=$(node -e "console.log(process.versions.node.split('.')[0])")
[[ "$node_major" -ge 20 ]] || fail "Node 20+ required (got $(node --version))"
(cd "$SNAPSHOT" && npm ci --no-audit --no-fund) || fail "npm ci (clean snapshot)"
(cd "$SNAPSHOT" && npm run build) || fail "build (clean snapshot)"
(cd "$SNAPSHOT" && npm test -- --run tests/limits tests/mcp) || fail "bounded test subset (clean snapshot)"
echo "M9 SETUP: clean snapshot install OK (npm ci, build, tests/limits + tests/mcp)"

# --- 2. Full Ipe 7.2.30 toolchain check --------------------------------------
ipe_pkg_version=$(dpkg-query -W -f='${Version}' ipe 2>/dev/null) || fail "ipe package not installed"
[[ "$ipe_pkg_version" == "7.2.30"* ]] || fail "expected ipe 7.2.30*, got $ipe_pkg_version"
echo "M9 SETUP: ipe $ipe_pkg_version"

for tool in ipe ipescript ipetoipe iperender ipepresenter ipeextract; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool not on PATH"
  realpath "$(command -v "$tool")" | grep -q '^/usr/' || fail "$tool does not resolve under /usr"
done
[[ -x /usr/bin/bwrap ]] || fail "bubblewrap /usr/bin/bwrap missing"
bwrap_resolved=$(realpath /usr/bin/bwrap)
[[ "$bwrap_resolved" == "/usr/bin/bwrap" ]] || fail "bubblewrap path does not resolve to the fixed executable"

owner_probe() { dpkg-query -S "$1" 2>/dev/null | awk -F: '{print $1}' | sed 's/^.* //'; }
owner_ipescript=$(owner_probe "$(command -v ipescript)")
[[ "$owner_ipescript" == "ipe" ]] || fail "ipescript not owned by ipe (got $owner_ipescript)"
for extra in ipepresenter ipeextract; do
  owner_extra=$(owner_probe "$(command -v "$extra")")
  [[ "$owner_extra" == "ipe" ]] || fail "$extra not owned by ipe (got $owner_extra)"
done

pdflatex_owner=$(owner_probe "$(command -v pdflatex)")
[[ "$pdflatex_owner" =~ ^texlive-(latex-base|binaries)$ ]] || fail "pdflatex not from texlive-latex-base/binaries (got $pdflatex_owner)"
pdfinfo_owner=$(owner_probe "$(command -v pdfinfo)")
pdftoppm_owner=$(owner_probe "$(command -v pdftoppm)")
[[ "$pdfinfo_owner" == "poppler-utils" && "$pdftoppm_owner" == "poppler-utils" ]] || fail "pdfinfo/pdftoppm not owned by poppler-utils (got $pdfinfo_owner/$pdftoppm_owner)"
mutool_owner=$(owner_probe "$(command -v mutool)")
[[ "$mutool_owner" == "mupdf-tools" ]] || fail "mutool not owned by mupdf-tools (got $mutool_owner)"
bwrap_owner=$(owner_probe /usr/bin/bwrap)
[[ "$bwrap_owner" == "bubblewrap" ]] || fail "bwrap not owned by bubblewrap (got $bwrap_owner)"
bwrap_version=$(dpkg-query -W -f='${Version}' bubblewrap)
[[ "$bwrap_version" == 0.11.1* ]] || fail "bubblewrap 0.11.1 expected (got $bwrap_version)"

echo "M9 SETUP: toolchain complete and package-owned: ipe, ipescript, ipetoipe, iperender, ipepresenter, ipeextract, pdflatex ($pdflatex_owner), pdfinfo/pdftoppm (poppler-utils), mutool (mupdf-tools), bubblewrap $bwrap_version (bwrap $bwrap_owner)"

# --- 3. Degenerate-aware capability verification -----------------------------
(cd "$ROOT" && npm run build) || fail "build (dist for capability probe)"
node --input-type=module - "$ROOT" <<'NODE' || fail "capability verification"
const root = process.argv[2];
const { NativeIpeAdapter } = await import(`${root}/dist/src/native/adapter.js`);
const adapter = await NativeIpeAdapter.create({ temporaryRoot: `${process.env.M9_SETUP_TMP ?? "/tmp"}/capability-workspace` });
const capabilities = await adapter.capabilities();
const lines = [
  `capabilities.mode=${capabilities.mode}`,
  `capabilities.verified=${capabilities.verified}`,
  `capabilities.ipeVersion=${capabilities.ipeVersion ?? "-"}`,
  `features=${JSON.stringify(capabilities.features)}`,
  `toolchain=${JSON.stringify(capabilities.toolchain ?? null)}`,
];
if (capabilities.mode !== "full-7.2.30" || capabilities.verified !== true || capabilities.ipeVersion !== "7.2.30") {
  console.error(lines.join("\n"));
  console.error("diagnostics:", JSON.stringify(capabilities.diagnostics ?? [], null, 2));
  throw new Error(`capabilities are degraded (mode=${capabilities.mode}, verified=${capabilities.verified}); refusing to claim full-7.2.30`);
}
console.log(lines.join("\n"));
NODE

echo "M9 SETUP PASS: clean snapshot, full Ipe 7.2.30 toolchain with provenance, and full-7.2.30 verified capabilities"
