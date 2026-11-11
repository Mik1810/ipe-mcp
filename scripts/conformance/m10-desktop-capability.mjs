import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, open, readFile, rm, symlink } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { NATIVE_PROCESS_LIMITS } from "../../dist/src/limits.js";
import { runControlledProcess } from "../../dist/src/native/process.js";

import { atomicWriteFile, AtomicWriteError } from "../../dist/src/persistence/atomic.js";

const [platform, architecture] = process.argv.slice(2);
assert.ok(platform === "win32" || platform === "darwin");
assert.ok(architecture === "x64" || architecture === "arm64");
assert.equal(process.platform, platform);
assert.equal(process.arch, architecture);

const temporary = await mkdtemp(join(tmpdir(), "ipe desktop probe "));
const workspace = join(temporary, "allowed workspace");
const outside = join(temporary, "outside workspace");
const client = new Client({ name: "ipe-desktop-capability", version: "1" });
try {
  await mkdir(workspace);
  await mkdir(outside);
  const marker = join(workspace, "native process started");
  await assert.rejects(
    runControlledProcess(
      process.execPath,
      ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", marker],
      workspace, NATIVE_PROCESS_LIMITS, "NATIVE_RENDER_ERROR",
    ),
    { code: "NATIVE_UNAVAILABLE" },
  );
  await assert.rejects(access(marker), { code: "ENOENT" });

  const link = join(workspace, "outside link");
  await copyFile("fixtures/conformance/m6/full.xml", join(outside, "fixture.ipe"));
  await symlink(outside, link, platform === "win32" ? "junction" : "dir");
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/src/cli/mcp-stdio.js")],
    env: {
      IPE_MCP_WORKSPACE_ROOT: workspace,
      IPE_MCP_STATE_ROOT: join(workspace, "state"),
    },
    stderr: "pipe",
  }));

  const result = await client.callTool({ name: "ipe_get_capabilities", arguments: {} });
  const capabilities = result.structuredContent?.data?.capabilities;
  assert.equal(result.structuredContent?.ok, true);
  assert.equal(capabilities.mode, "structural-only");
  assert.equal(capabilities.verified, false);
  assert.deepEqual(capabilities.features, { ipelib: false, latex: false, pdf: false, png: false, svg: false });
  assert.ok(capabilities.diagnostics.some((item) => item.includes("verified process isolation")));
  assert.equal(Object.hasOwn(capabilities, "toolchain"), false);
  assert.deepEqual(JSON.parse(result.content.find(({ type }) => type === "text").text), result.structuredContent);

  const escaped = await client.callTool({
    name: "ipe_open_document",
    arguments: { path: join(link, "fixture.ipe") },
  });
  assert.equal(escaped.structuredContent?.error?.code, "PATH_OUTSIDE_WORKSPACE");
  assert.ok(!JSON.stringify(escaped).includes("outside workspace"));

  let directorySync = "ok";
  try {
    const handle = await open(workspace, "r");
    try { await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (typeof error.code !== "string") throw error;
    directorySync = error.code;
  }
  const target = join(workspace, "atomic replacement.txt");
  await copyFile("fixtures/conformance/m6/full.xml", target);
  const replacement = Buffer.from("new contents");
  let atomicWrite = "confirmed";
  try {
    await atomicWriteFile(target, replacement);
  } catch (error) {
    assert.notEqual(directorySync, "ok");
    assert.ok(error instanceof AtomicWriteError && error.committed);
    assert.equal(error.cause?.code, directorySync);
    atomicWrite = "committed; durability unconfirmed";
  }
  assert.equal(atomicWrite, directorySync === "ok" ? "confirmed" : "committed; durability unconfirmed");
  assert.deepEqual(await readFile(target), replacement);

  console.log(JSON.stringify({
    result: "PASS", platform: process.platform, architecture: process.arch, osRelease: release(),
    node: process.version, mode: capabilities.mode, nativeSpawn: "rejected", linkEscape: "rejected",
    directorySync, atomicWrite,
    mcpHarnessAreas: [
      "result-quality-and-recovery", "permissions-and-write-safety",
      "transport-integration-and-privacy", "code-architecture-and-verification",
    ],
  }));
} finally {
  await client.close();
  await rm(temporary, { recursive: true, force: true });
}
