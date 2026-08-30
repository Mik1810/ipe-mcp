#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [command, outputArgument] = process.argv.slice(2);
if (!new Set(["prepare", "verify"]).has(command) || outputArgument === undefined) {
  throw new Error("usage: release-candidate.mjs prepare|verify OUTPUT_DIRECTORY");
}

const output = resolve(outputArgument);
const sha = (algorithm, data) => createHash(algorithm).update(data).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const product = await readJson(join(root, "package.json"));
const version = product.version;
const tag = `v${version}`;
const notesName = `${tag}.md`;

if (!/^1\.0\.0-rc\.\d+$/u.test(version) || product.name !== "ipe-mcp" || product.private !== false) {
  throw new Error("release candidate package identity is invalid");
}
if (product.publishConfig?.tag !== "next" || product.publishConfig?.provenance !== true || product.publishConfig?.access !== "public") {
  throw new Error("safe public prerelease publishConfig is incomplete");
}

const assertTag = async () => {
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== tag) {
    throw new Error(`workflow tag ${process.env.GITHUB_REF_NAME} does not match package ${tag}`);
  }
  if (process.env.GITHUB_REF_TYPE === "tag") {
    const tagType = (await exec("git", ["cat-file", "-t", `refs/tags/${tag}`], { cwd: root })).stdout.trim();
    if (tagType !== "tag") throw new Error("release workflow requires an annotated Git tag");
    const tagCommit = (await exec("git", ["rev-parse", `${tag}^{commit}`], { cwd: root })).stdout.trim();
    const mainCommit = (await exec("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: root })).stdout.trim();
    if (tagCommit !== mainCommit) throw new Error("release tag must point to the current origin/main commit");
  }
};

const emitOutputs = async (manifest) => {
  if (process.env.GITHUB_OUTPUT === undefined) return;
  await appendFile(process.env.GITHUB_OUTPUT, [
    `version=${manifest.version}`,
    `tag=${manifest.tag}`,
    `tarball=${manifest.tarball.filename}`,
    `integrity=${manifest.tarball.integrity}`,
  ].join("\n") + "\n");
};

if (command === "prepare") {
  await assertTag();
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) throw new Error("release candidate output directory must be empty");
  const status = (await exec("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root })).stdout.trim();
  if (status !== "") throw new Error("release candidate source tree is dirty");

  const sourceRevision = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const sourceTree = (await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
  const notesSource = join(root, "docs", "releases", notesName);
  const notes = await readFile(notesSource);
  for (const required of ["ipe-mcp", version, "ipe-mcp/1", "Ubuntu 26.04 WSL2", "npm install", "rollback"]) {
    if (!notes.toString("utf8").includes(required)) throw new Error(`release notes missing ${required}`);
  }

  const packResult = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const packed = JSON.parse(packResult.stdout);
  if (!Array.isArray(packed) || packed.length !== 1) throw new Error("npm pack did not produce exactly one artifact");
  const pack = packed[0];
  const tarballPath = join(output, pack.filename);
  const tarball = await readFile(tarballPath);
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (integrity !== pack.integrity || sha("sha1", tarball) !== pack.shasum) throw new Error("npm pack digest metadata mismatch");

  const lock = await readFile(join(root, "package-lock.json"));
  const sbomSource = join(root, "docs", "reference", "package-sbom.json");
  const sbom = await readFile(sbomSource);
  const manifest = {
    schemaVersion: 1,
    package: product.name,
    version,
    tag,
    distTag: "next",
    source: { revision: sourceRevision, tree: sourceTree },
    tarball: {
      filename: basename(tarballPath),
      files: pack.files.length,
      bytes: tarball.length,
      unpackedBytes: pack.unpackedSize,
      sha1: pack.shasum,
      sha256: sha("sha256", tarball),
      sha512: sha("sha512", tarball),
      integrity,
    },
    inputs: {
      lockfileSha256: sha("sha256", lock),
      sbomSha256: sha("sha256", sbom),
      releaseNotesSha256: sha("sha256", notes),
    },
    publication: { requiresExplicitOwnerApproval: true, bootstrapCredentialRetained: false },
  };
  await copyFile(sbomSource, join(output, "package-sbom.json"));
  await copyFile(notesSource, join(output, notesName));
  await writeFile(join(output, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await emitOutputs(manifest);
  process.stdout.write(`${JSON.stringify({ result: "PASS", version, tag, tarball: pack.filename, sha256: manifest.tarball.sha256 })}\n`);
} else {
  await assertTag();
  const manifest = await readJson(join(output, "release-manifest.json"));
  if (manifest.schemaVersion !== 1 || manifest.package !== product.name || manifest.version !== version || manifest.tag !== tag || manifest.distTag !== "next") {
    throw new Error("release manifest identity mismatch");
  }
  const expectedFiles = [manifest.tarball.filename, notesName, "package-sbom.json", "release-manifest.json"].sort();
  const actualFiles = (await readdir(output)).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error(`release candidate file set mismatch: ${actualFiles}`);
  const currentRevision = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const currentTree = (await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
  if (manifest.source.revision !== currentRevision || manifest.source.tree !== currentTree) throw new Error("release artifact source does not match the checked-out revision");
  const tarball = await readFile(join(output, manifest.tarball.filename));
  const sbom = await readFile(join(output, "package-sbom.json"));
  const notes = await readFile(join(output, notesName));
  const lock = await readFile(join(root, "package-lock.json"));
  const checks = [
    [manifest.tarball.bytes, (await stat(join(output, manifest.tarball.filename))).size, "tarball bytes"],
    [manifest.tarball.sha1, sha("sha1", tarball), "tarball sha1"],
    [manifest.tarball.sha256, sha("sha256", tarball), "tarball sha256"],
    [manifest.tarball.sha512, sha("sha512", tarball), "tarball sha512"],
    [manifest.tarball.integrity, `sha512-${createHash("sha512").update(tarball).digest("base64")}`, "tarball integrity"],
    [manifest.inputs.lockfileSha256, sha("sha256", lock), "lockfile sha256"],
    [manifest.inputs.sbomSha256, sha("sha256", sbom), "SBOM sha256"],
    [manifest.inputs.releaseNotesSha256, sha("sha256", notes), "release notes sha256"],
  ];
  for (const [expected, actual, label] of checks) if (expected !== actual) throw new Error(`${label} mismatch`);
  if (manifest.publication?.requiresExplicitOwnerApproval !== true || manifest.publication?.bootstrapCredentialRetained !== false) {
    throw new Error("release approval/credential retention policy mismatch");
  }
  await emitOutputs(manifest);
  process.stdout.write(`${JSON.stringify({ result: "PASS", version, tag, tarball: manifest.tarball.filename, sha256: manifest.tarball.sha256 })}\n`);
}
