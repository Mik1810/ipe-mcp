#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [tag, artifactArgument] = process.argv.slice(2);
if (tag === undefined || artifactArgument === undefined || !/^v1\.0\.0-rc\.\d+$/u.test(tag)) {
  throw new Error("usage: audit-deployment.mjs v1.0.0-rc.N ARTIFACT_DIRECTORY");
}

const artifactDirectory = resolve(artifactArgument);
const manifest = JSON.parse(await readFile(join(artifactDirectory, "release-manifest.json"), "utf8"));
const release = JSON.parse(process.env.RELEASE_JSON ?? "null");
const version = tag.slice(1);
const tarballName = `ipe-mcp-${version}.tgz`;
const hash = (algorithm, data) => createHash(algorithm).update(data).digest("hex");

if (manifest.schemaVersion !== 1 || manifest.package !== "ipe-mcp" || manifest.version !== version || manifest.tag !== tag) {
  throw new Error("release manifest identity does not match the requested deployment");
}
if (manifest.tarball.filename !== tarballName || manifest.distTag !== "next") {
  throw new Error("release manifest artifact or dist-tag is invalid");
}

const tagType = (await exec("git", ["cat-file", "-t", `refs/tags/${tag}`], { cwd: root })).stdout.trim();
if (tagType !== "tag") throw new Error("deployment audit requires an annotated Git tag");
const tagRevision = (await exec("git", ["rev-parse", `${tag}^{commit}`], { cwd: root })).stdout.trim();
const tagTree = (await exec("git", ["rev-parse", `${tag}^{tree}`], { cwd: root })).stdout.trim();
if (manifest.source.revision !== tagRevision || manifest.source.tree !== tagTree) {
  throw new Error("release manifest source does not match the immutable Git tag");
}

const tarball = await readFile(join(artifactDirectory, tarballName));
const sbom = await readFile(join(artifactDirectory, "package-sbom.json"));
const lock = (await exec("git", ["show", `${tag}:package-lock.json`], { cwd: root, maxBuffer: 4 * 1024 * 1024 })).stdout;
const notes = (await exec("git", ["show", `${tag}:docs/releases/${tag}.md`], { cwd: root, maxBuffer: 1024 * 1024 })).stdout;
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
if (
  hash("sha1", tarball) !== manifest.tarball.sha1 ||
  hash("sha256", tarball) !== manifest.tarball.sha256 ||
  hash("sha512", tarball) !== manifest.tarball.sha512 ||
  integrity !== manifest.tarball.integrity
) {
  throw new Error("GitHub Release tarball digest does not match the release manifest");
}
if (
  hash("sha256", sbom) !== manifest.inputs.sbomSha256 ||
  hash("sha256", lock) !== manifest.inputs.lockfileSha256 ||
  hash("sha256", notes) !== manifest.inputs.releaseNotesSha256
) {
  throw new Error("release evidence digest does not match the tagged source");
}

const expectedAssets = [tarballName, "package-sbom.json", "release-manifest.json"].sort();
const actualAssets = release?.assets?.map((asset) => basename(asset.name)).sort();
if (
  release?.tagName !== tag ||
  release?.isPrerelease !== true ||
  release?.isDraft !== false ||
  JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)
) {
  throw new Error("GitHub prerelease identity or asset inventory is invalid");
}

if (process.env.GITHUB_OUTPUT !== undefined) {
  await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\ntarball=${tarballName}\nintegrity=${integrity}\n`);
}
process.stdout.write(`${JSON.stringify({ result: "PASS", tag, version, revision: tagRevision, tarball: tarballName, sha256: manifest.tarball.sha256, integrity })}\n`);
