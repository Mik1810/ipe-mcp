#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
M10_PACKAGE_TMP=$(mktemp -d)
trap 'rm -rf "$M10_PACKAGE_TMP"' EXIT
fail() { echo "M10 PACKAGE FAIL: $*" >&2; exit 1; }

PACK_DIR="$M10_PACKAGE_TMP/pack"
INSTALL_DIR="$M10_PACKAGE_TMP/install"
EXTRACT_DIR="$M10_PACKAGE_TMP/extract"
SMOKE_WORKSPACE="$M10_PACKAGE_TMP/smoke/workspace"
SMOKE_ARTIFACTS="$M10_PACKAGE_TMP/smoke/artifacts"
SMOKE_RESULT="$M10_PACKAGE_TMP/smoke/result.json"
mkdir -p "$PACK_DIR" "$INSTALL_DIR" "$EXTRACT_DIR"
PACKAGE_VERSION=$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")

(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && npm test -- --run tests/version.test.ts tests/mcp/protocol.test.ts) || fail "directly affected tests"
(cd "$ROOT" && node scripts/tools/sbom.mjs "$M10_PACKAGE_TMP/package-sbom.json") || fail "candidate SBOM generation"
cmp "$M10_PACKAGE_TMP/package-sbom.json" "$ROOT/docs/reference/package-sbom.json" || fail "candidate SBOM is not byte-deterministic"
(cd "$ROOT" && npm pack --ignore-scripts --json --pack-destination "$PACK_DIR" > "$M10_PACKAGE_TMP/pack.json") || fail "npm pack"

node --input-type=module - "$ROOT" "$M10_PACKAGE_TMP" "$PACKAGE_VERSION" <<'NODE' || fail "metadata and package allowlist"
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const [root, temporary, expectedVersion] = process.argv.slice(2);
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const packed = JSON.parse(await readFile(join(temporary, "pack.json"), "utf8"));
if (!Array.isArray(packed) || packed.length !== 1) throw new Error("expected one packed artifact");
const artifact = packed[0];
if (packageJson.name !== "ipe-mcp" || packageJson.version !== expectedVersion || packageJson.private !== false || !/^\d+\.\d+\.\d+-rc\.\d+$/u.test(packageJson.version)) throw new Error("public candidate identity mismatch");
if (lock.name !== packageJson.name || lock.version !== packageJson.version || lock.packages[""].version !== packageJson.version) throw new Error("package-lock root identity mismatch");
if (packageJson.license !== "MIT" || packageJson.bin?.["ipe-mcp"] !== "dist/src/cli/mcp-stdio.js") throw new Error("license/bin metadata mismatch");
if (packageJson.publishConfig?.tag !== "next" || packageJson.publishConfig?.provenance !== true) throw new Error("safe prerelease publish metadata missing");
for (const forbidden of ["install", "postinstall", "preinstall", "prepare"]) {
  if (packageJson.scripts?.[forbidden] !== undefined) throw new Error(`forbidden install lifecycle script: ${forbidden}`);
}
if (artifact.name !== packageJson.name || artifact.version !== packageJson.version) throw new Error("packed artifact identity mismatch");
if (artifact.size > 512 * 1024 || artifact.unpackedSize > 2 * 1024 * 1024) throw new Error(`package size budget exceeded: ${artifact.size}/${artifact.unpackedSize}`);

const fixed = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "docs/guides/package-installation.md",
  "docs/guides/support-policy.md",
  "docs/guides/versioning-and-releases.md",
  "docs/reference/package-sbom.json",
  "scripts/conformance/m6-artifact-worker.mjs",
  "scripts/conformance/m6-native.lua",
]);
const paths = artifact.files.map((file) => file.path);
for (const path of paths) {
  const compiled = /^dist\/src\/.+\.(?:js|d\.ts)$/u.test(path);
  if (!fixed.has(path) && !compiled) throw new Error(`package path is not allowlisted: ${path}`);
  if (/\.(?:map|exe|dll|dylib|so)$/u.test(path)) throw new Error(`forbidden artifact type: ${path}`);
}
for (const required of fixed) if (!paths.includes(required)) throw new Error(`required package path missing: ${required}`);
if (!paths.includes(packageJson.bin["ipe-mcp"]) || !paths.includes("dist/src/index.js") || !paths.includes("dist/src/index.d.ts")) throw new Error("entry point missing");
await import(join(root, "dist/src/index.js"));
process.stdout.write(`${JSON.stringify({ name: artifact.name, version: artifact.version, filename: artifact.filename, files: paths.length, size: artifact.size, unpackedSize: artifact.unpackedSize, integrity: artifact.integrity })}\n`);
NODE

TARBALL=$(find "$PACK_DIR" -maxdepth 1 -type f -name 'ipe-mcp-*.tgz' -print -quit)
[[ -n "$TARBALL" && -f "$TARBALL" ]] || fail "tarball path"
tar -xzf "$TARBALL" -C "$EXTRACT_DIR" || fail "tarball extraction"

node --input-type=module - "$EXTRACT_DIR/package" <<'NODE' || fail "secret and native-binary scan"
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.argv[2];
const files = [];
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) files.push(path);
    else throw new Error(`non-regular package entry: ${relative(root, path)}`);
  }
};
await walk(root);
const secretPatterns = [
  /-----BEGIN [^-]*PRIVATE KEY-----/u,
  /(?:^|\W)npm_[A-Za-z0-9]{36}(?:$|\W)/u,
  /(?:^|\W)gh[pousr]_[A-Za-z0-9]{36,}(?:$|\W)/u,
  /(?:^|\W)AKIA[A-Z0-9]{16}(?:$|\W)/u,
  /_authToken\s*=/u,
];
for (const path of files) {
  const data = await readFile(path);
  const magic = data.subarray(0, 4);
  const executable = magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || magic.subarray(0, 2).equals(Buffer.from("MZ")) || magic.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) || magic.equals(Buffer.from([0xfe, 0xed, 0xfa, 0xcf]));
  if (executable) throw new Error(`native executable in package: ${relative(root, path)}`);
  const text = data.toString("utf8");
  if (secretPatterns.some((pattern) => pattern.test(text))) throw new Error(`secret-like content in package: ${relative(root, path)}`);
}
NODE

node --input-type=module - "$M10_PACKAGE_TMP/package-sbom.json" "$PACKAGE_VERSION" <<'NODE' || fail "candidate SBOM audit"
import { readFile } from "node:fs/promises";
const sbom = JSON.parse(await readFile(process.argv[2], "utf8"));
if (sbom.metadata.component.name !== "ipe-mcp" || sbom.metadata.component.version !== process.argv[3]) throw new Error("SBOM candidate identity mismatch");
const npm = sbom.components.filter((component) => component.type === "library");
if (npm.length === 0 || npm.some((component) => !component.licenses?.length)) throw new Error("npm license inventory incomplete");
if (npm.some((component) => component.licenses.some((license) => /(?:AGPL|GPL)/u.test(license.expression)))) throw new Error("copyleft dependency in npm graph");
NODE

(cd "$INSTALL_DIR" && npm init -y >/dev/null && npm install --ignore-scripts --no-audit --no-fund "$TARBALL" >/dev/null) || fail "clean tarball install"
(cd "$INSTALL_DIR" && npm ls --omit=dev --all >/dev/null) || fail "installed dependency tree"
CLI="$INSTALL_DIR/node_modules/.bin/ipe-mcp"
[[ -x "$CLI" ]] || fail "installed bin is not executable"
(cd "$INSTALL_DIR" && EXPECTED_VERSION="$PACKAGE_VERSION" node --input-type=module -e 'const m = await import("ipe-mcp"); if (m.PRODUCT_VERSION !== process.env.EXPECTED_VERSION) throw new Error("package export/version mismatch")') || fail "package export"
(
cd "$INSTALL_DIR"
node --input-type=module - "$M10_PACKAGE_TMP/degraded" <<'NODE'
import { NativeIpeAdapter } from "ipe-mcp";
const temporaryRoot = process.argv[2];
const missing = "/ipe-mcp-intentionally-missing";
const adapter = await NativeIpeAdapter.create({
  temporaryRoot,
  executables: { ipescript: missing, ipetoipe: missing, iperender: missing, pdflatex: missing },
});
const capabilities = await adapter.capabilities();
if (capabilities.mode !== "structural-only" || capabilities.verified !== false) throw new Error("missing native tools did not fail closed");
if (!capabilities.diagnostics.some((item) => item.includes("unavailable"))) throw new Error("missing native diagnostics are not actionable");
NODE
) || fail "installed fail-closed capability probe"
(cd "$ROOT" && node scripts/harness/run-scenario.mjs \
  --scenario fixtures/conformance/m10/portable-create-edit-export.json \
  --command "$CLI" \
  --workspace "$SMOKE_WORKSPACE" \
  --artifacts "$SMOKE_ARTIFACTS" \
  --result "$SMOKE_RESULT" \
  --expected-version "$PACKAGE_VERSION") || fail "installed provider-neutral stdio/native scenario"

node --input-type=module - "$SMOKE_RESULT" "$SMOKE_ARTIFACTS" "$PACKAGE_VERSION" <<'NODE' || fail "portable scenario evidence"
import { readFile } from "node:fs/promises";
const evidence = JSON.parse(await readFile(process.argv[2], "utf8"));
if (evidence.schemaVersion !== 1 || evidence.scenarioId !== "portable-create-edit-export" || evidence.status !== "PASS") throw new Error("scenario identity/status mismatch");
if (evidence.productVersion !== process.argv[4] || evidence.contract !== "ipe-mcp/1" || evidence.capabilityMode !== "full-7.2.30") throw new Error("installed product/contract/capability mismatch");
if (evidence.adapter?.name !== "official-sdk-stdio" || evidence.adapter?.transport !== "stdio") throw new Error("adapter/transport mismatch");
if (evidence.assertions?.semantic !== "PASS" || evidence.assertions?.visual !== "PASS" || evidence.failure !== undefined || evidence.diagnostics.length !== 0) throw new Error("scenario assertions or diagnostics failed");
if (evidence.artifacts.length !== 4 || evidence.mutationHistory.length !== 5) throw new Error("portable artifact or mutation evidence incomplete");
const tools = new Set(evidence.transcript.filter((entry) => entry.kind === "tool").map((entry) => entry.name));
for (const required of ["ipe_orientation", "ipe_get_capabilities", "ipe_create_document", "ipe_apply_operations", "ipe_validate", "ipe_save_document", "ipe_render_preview", "ipe_export_document"]) {
  if (!tools.has(required)) throw new Error(`portable scenario did not exercise ${required}`);
}
const serialized = JSON.stringify(evidence);
if (serialized.includes(process.argv[3]) || /Bearer\s+|_authToken|password=|reasoning_content/iu.test(serialized)) throw new Error("portable result leaked private state");
NODE

echo "M10 PACKAGE MCP HARNESS: orientation-and-dynamic-behavior, result-quality-and-recovery, permissions-and-write-safety, transport-integration-and-privacy, code-architecture-and-verification"
echo "M10 PACKAGE PASS: thin $PACKAGE_VERSION tarball, allowlist/secret/native/SBOM audit, clean install, fail-closed diagnostics, exports/bin, provider-neutral stdio full-7.2.30 create/edit/recovery/validate/render/export, zero listeners; no publication"
