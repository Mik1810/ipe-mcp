#!/usr/bin/env node
/**
 * Deterministic CycloneDX 1.5 SBOM generator.
 *
 * Reads package-lock.json and emits a stable JSON document: components are
 * sorted by their package-lock key, values come only from the lockfile (name,
 * version, license, integrity hash), and there are no timestamps, UUIDs, or
 * nondeterministic ordering.  A native-toolchain section is appended from the
 * installed dpkg packages and their /usr/share/doc copyright files.
 *
 * Usage: node scripts/tools/sbom.mjs [OUTPUT.json] [--project-version VERSION] [--stdout]
 *   With --stdout, the JSON is written to standard output (no trailing noise).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const stdout = args.includes("--stdout");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const project = lock.packages[""];
if (typeof project?.name !== "string" || typeof project.version !== "string" || typeof project.license !== "string") {
  throw new Error("package-lock root project metadata is incomplete");
}
const versionFlag = args.indexOf("--project-version");
const projectVersion = versionFlag === -1 ? project.version : args[versionFlag + 1];
if (typeof projectVersion !== "string" || projectVersion.length === 0) throw new Error("--project-version requires a value");
const positional = args.filter((arg, index) => (
  arg !== "--stdout"
  && index !== versionFlag
  && (versionFlag === -1 || index !== versionFlag + 1)
));
const outputPath = positional[0] ?? join(root, "docs/reference/package-sbom.json");

function integrityToHash(integrity) {
  if (integrity === undefined) return undefined;
  const match = /^sha512-([A-Za-z0-9+/=]+)$/u.exec(integrity);
  if (match === null) return undefined;
  return { alg: "SHA-512", content: match[1] };
}

function licenseFor(pkg) {
  const raw = pkg.license;
  if (raw === undefined) return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0) return undefined;
  return values.map((value) => ({ expression: value }));
}

function purlFor(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

const npmComponents = [];
for (const [key, pkg] of Object.entries(lock.packages)) {
  if (key === "" || key.startsWith("node_modules/") === false) continue;
  const name = key.replace(/^node_modules\//u, "");
  const hash = integrityToHash(pkg.integrity);
  npmComponents.push({
    type: "library",
    "bom-ref": `npm:${name}@${pkg.version ?? ""}`,
    name,
    version: pkg.version ?? "0.0.0",
    ...(pkg.license !== undefined ? { licenses: licenseFor(pkg) } : {}),
    purl: purlFor(name, pkg.version ?? "0.0.0"),
    ...(hash === undefined ? {} : { hashes: [hash] }),
  });
}
npmComponents.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

function dpkgVersion(name) {
  try { return execFileSync("dpkg-query", ["-W", "-f=${Version}", name], { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

function dpkgStatus(name) {
  try { return execFileSync("dpkg-query", ["-W", "-f=${db:Status-Status}", name], { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

function copyrightLicense(name) {
  const copyrightPath = `/usr/share/doc/${name}/copyright`;
  if (!existsSync(copyrightPath)) return { license: "(no copyright file)", provenance: "missing" };
  const text = readFileSync(copyrightPath, "utf8");
  const licenses = new Set();
  for (const match of text.matchAll(/^License:\s*(.+)$/gmu)) {
    const value = match[1].trim().replace(/\.$/, "");
    if (/^pd-/u.test(value)) licenses.add("public-domain");
    else if (value === "public-domain") licenses.add("public-domain");
    else licenses.add(value);
  }
  if (licenses.size === 0) return { license: "multiple (see copyright file)", provenance: copyrightPath };
  return { license: [...licenses].sort().join(" AND "), provenance: copyrightPath };
}

const nativeToolchain = [];
const nativePackages = ["ipe", "lua5.4", "texlive-latex-base", "poppler-utils", "mupdf-tools", "bubblewrap"];
for (const name of nativePackages) {
  const pkgVersion = dpkgVersion(name);
  if (pkgVersion === "" || dpkgStatus(name) !== "installed") continue;
  const info = copyrightLicense(name);
  nativeToolchain.push({
    type: "application",
    "bom-ref": `deb:${name}@${pkgVersion}`,
    name,
    version: pkgVersion,
    licenses: [{ expression: info.license }],
    properties: [{ name: "ipe-mcp:provenance", value: info.provenance }],
    purl: `pkg:deb/ubuntu/${name}@${pkgVersion}`,
  });
}
nativeToolchain.sort((a, b) => a.name.localeCompare(b.name));

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
  version: 1,
  metadata: {
    timestamp: "2026-01-01T00:00:00Z",
    component: {
      type: "application",
      "bom-ref": `${project.name}@${projectVersion}`,
      name: project.name,
      version: projectVersion,
      licenses: [{ expression: project.license }],
      purl: purlFor(project.name, projectVersion),
    },
    properties: [
      { name: "ipe-mcp:project-license", value: project.license },
      { name: "ipe-mcp:generator", value: "scripts/tools/sbom.mjs" },
    ],
  },
  components: [...npmComponents, ...nativeToolchain],
};

const output = `${JSON.stringify(sbom, null, 2)}\n`;
if (stdout) process.stdout.write(output);
else writeFileSync(outputPath, output);
