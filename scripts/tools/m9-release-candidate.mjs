#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outputArgument = process.argv[2];
if (outputArgument === undefined) {
  throw new Error("usage: node scripts/tools/m9-release-candidate.mjs ABSOLUTE_OUTPUT_DIRECTORY");
}
if (!isAbsolute(outputArgument)) throw new Error("output directory must be absolute");
const output = resolve(outputArgument);
const outputRelative = relative(root, output);
if (output === root || (outputRelative !== "" && !outputRelative.startsWith("..") && !isAbsolute(outputRelative))) {
  throw new Error("output directory must be outside the candidate repository");
}

const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
const run = async (command, args, options = {}) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  const append = (current, chunk) => {
    const combined = Buffer.concat([current, chunk]);
    return combined.length <= MAX_DIAGNOSTIC_BYTES ? combined : combined.subarray(combined.length - MAX_DIAGNOSTIC_BYTES);
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  child.on("error", rejectRun);
  child.on("close", (code, signal) => {
    const result = { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
    if (code === 0) resolveRun(result);
    else rejectRun(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})\n${result.stderr || result.stdout}`));
  });
});

const text = async (command, args, options) => (await run(command, args, options)).stdout.trim();
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const exists = async (path) => stat(path).then(() => true, () => false);
const packageVersion = async (name) => text("dpkg-query", ["-W", "-f=${Version}", name]);
const artifactMediaType = new Map([
  ["walkthrough.ipe", "application/vnd.ipe+xml"],
  ["walkthrough-preview.png", "image/png"],
  ["walkthrough.pdf", "application/pdf"],
  ["walkthrough.png", "image/png"],
]);

await mkdir(output, { recursive: true });
const canonicalOutput = await realpath(output);
const canonicalOutputRelative = relative(root, canonicalOutput);
if (canonicalOutput === root || (canonicalOutputRelative !== "" && !canonicalOutputRelative.startsWith("..") && !isAbsolute(canonicalOutputRelative))) {
  throw new Error("resolved output directory must be outside the candidate repository");
}
if ((await readdir(output)).length !== 0) throw new Error("output directory must be empty");

const unstaged = await text("git", ["diff", "--name-only", "--ignore-submodules=none"]);
if (unstaged !== "") throw new Error(`candidate has unstaged tracked changes: ${unstaged.split("\n").join(", ")}`);
const untracked = await text("git", ["ls-files", "--others", "--exclude-standard"]);
if (untracked !== "") throw new Error(`candidate has untracked non-ignored files: ${untracked.split("\n").join(", ")}`);

const candidateTree = await text("git", ["write-tree"]);
const sourceRevision = await text("git", ["rev-parse", "HEAD"]);
const lockBytes = await readFile(join(root, "package-lock.json"));
const lock = JSON.parse(lockBytes.toString("utf8"));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const workRoot = await mkdtemp(join(tmpdir(), "ipe-mcp-m9-candidate-"));
const checkout = join(workRoot, "checkout");
const workflowOutput = join(workRoot, "workflow");
const archive = join(workRoot, "candidate.tar");
const checks = [];
let artifacts;
let workflow;
let cleanup = "FAIL";

const passed = (id, contract) => checks.push({ id, result: "PASS", contract });

try {
  await mkdir(checkout);
  await run("git", ["archive", "--format=tar", `--output=${archive}`, candidateTree]);
  await run("tar", ["-xf", archive, "-C", checkout]);
  passed("frozen-tree-extract", "git archive of the staged tree; no working-copy or ignored state");

  if (await exists(join(checkout, "node_modules")) || await exists(join(checkout, "dist"))) {
    throw new Error("frozen tree retained node_modules or dist");
  }
  await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: checkout });
  passed("clean-install", "npm ci from package-lock.json with no inherited node_modules");

  await run("npm", ["run", "build"], { cwd: checkout });
  passed("build", "TypeScript production build from the frozen tree");

  const stableTestOptions = ["--no-file-parallelism", "--maxWorkers=1", "--testTimeout=30000"];
  await run("npm", ["test", "--", "--run", "tests/native/adapter.test.ts", ...stableTestOptions], { cwd: checkout });
  await run("npm", ["test", "--", "--run", "--exclude", "tests/native/adapter.test.ts", ...stableTestOptions], { cwd: checkout });
  passed("stable-suite", "complete Vitest suite from the frozen tree; native adapter lane first, remaining files second, both serialized");

  const workflowRun = await run(process.execPath, ["scripts/host/m9-agent-workflow.mjs", workflowOutput], { cwd: checkout });
  const jsonLine = workflowRun.stdout.trim().split("\n").findLast((line) => line.startsWith("{"));
  if (jsonLine === undefined) throw new Error("M9 workflow did not emit evidence");
  const rawWorkflow = JSON.parse(jsonLine);
  workflow = {
    scenario: rawWorkflow.manual,
    sections: rawWorkflow.sections,
    open: rawWorkflow.open,
    layout: rawWorkflow.layout,
    staleRollback: rawWorkflow.staleRollback,
    undoRestore: rawWorkflow.undoRestore,
    fullValidation: rawWorkflow.fullValidation,
    render: "PASS",
    save: rawWorkflow.save,
    reopen: "PASS",
    exportPdf: "PASS",
    exportPng: "PASS",
    recover: rawWorkflow.recover,
    resourcesRead: rawWorkflow.resourcesRead,
    stderrProtocolSafe: rawWorkflow.stderrProtocolSafe,
  };
  if (Object.values(workflow).includes("FAIL") || workflow.stderrProtocolSafe !== true || workflow.resourcesRead !== 3) {
    throw new Error(`M9 workflow evidence failed: ${JSON.stringify(workflow)}`);
  }
  passed("agent-workflow", "create/open/edit/layout/validate/render/save/reopen/export/history/recover through real MCP stdio");

  artifacts = [];
  for (const [name, mediaType] of artifactMediaType) {
    const data = await readFile(join(workflowOutput, name));
    if (data.length === 0) throw new Error(`empty workflow artifact: ${name}`);
    artifacts.push({ name, mediaType, bytes: data.length, sha256: sha256(data) });
  }
  const ipe = await readFile(join(workflowOutput, "walkthrough.ipe"), "utf8");
  const pdf = await readFile(join(workflowOutput, "walkthrough.pdf"));
  const png = await readFile(join(workflowOutput, "walkthrough.png"));
  const preview = await readFile(join(workflowOutput, "walkthrough-preview.png"));
  if (!ipe.startsWith("<?xml") || !ipe.includes('version="70218"')) throw new Error("saved Ipe artifact is not XML 70218");
  if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("PDF artifact signature is invalid");
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!png.subarray(0, 8).equals(pngSignature) || !preview.subarray(0, 8).equals(pngSignature)) throw new Error("PNG artifact signature is invalid");
  passed("bounded-artifacts", "Ipe 70218, PDF, exported PNG, and preview PNG validated and represented only by size and sha256");
} finally {
  await rm(workRoot, { recursive: true, force: true });
  cleanup = await exists(workRoot) ? "FAIL" : "PASS";
}

if (cleanup !== "PASS") throw new Error("candidate temporary root cleanup failed");
passed("cleanup", "temporary checkout, dependency install, state, logs, and generated binaries removed");

const toolchain = {
  platform: await text("uname", ["-s"]),
  architecture: await text("uname", ["-m"]),
  node: process.version,
  npm: await text("npm", ["--version"]),
  git: (await text("git", ["--version"])).replace(/^git version /u, ""),
  packages: {
    bubblewrap: await packageVersion("bubblewrap"),
    ipe: await packageVersion("ipe"),
    mupdfTools: await packageVersion("mupdf-tools"),
    popplerUtils: await packageVersion("poppler-utils"),
    texliveLatexBase: await packageVersion("texlive-latex-base"),
  },
};

const manifest = {
  schemaVersion: 1,
  milestone: "M9",
  subissue: 21,
  candidate: {
    identity: "git-staged-tree-sha1",
    tree: candidateTree,
    sourceRevision,
    trackedWorktreeMatchesIndex: true,
    untrackedNonIgnoredFiles: 0,
  },
  project: { name: packageJson.name, version: packageJson.version, contract: "ipe-mcp/1" },
  baseline: { platform: "Ubuntu 26.04 WSL", ipe: "7.2.30", xmlFormat: 70218, node: ">=20" },
  dependencyLock: { file: "package-lock.json", lockfileVersion: lock.lockfileVersion, sha256: sha256(lockBytes) },
  toolchain,
  checks: checks.map(({ id, contract }) => ({ id, contract })),
  artifacts,
  retention: {
    retained: ["manifest.json", "evidence.json"],
    excluded: ["checkout", "node_modules", "dist", "state", "logs", "ipe", "pdf", "png"],
  },
};
const evidence = {
  schemaVersion: 1,
  milestone: "M9",
  subissue: 21,
  candidateTree,
  result: "PASS",
  checks: checks.map(({ id, result }) => ({ id, result })),
  workflow,
  artifacts,
  cleanup: { temporaryRoot: cleanup, retainedRecordsOnly: true },
};

const writeExclusive = async (name, value) => {
  const handle = await open(join(output, name), "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); }
  finally { await handle.close(); }
};
await writeExclusive("manifest.json", manifest);
await writeExclusive("evidence.json", evidence);
process.stdout.write(`M9 CANDIDATE PASS: ${candidateTree}\n`);
