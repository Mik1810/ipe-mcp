import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = await mkdtemp(join(tmpdir(), "ipe-m10-live-bridge-"));
const work = join(root, "work");
const spool = join(root, "spool");
const plugins = join(root, "ipelets");
const control = join(root, "control");
const state = join(work, "state");
const source = join(work, "source.ipe");
const file = "fixtures/conformance/m6/full.xml";
const serverErrors = [];
const guiErrors = [];
let currentServer;
let currentGui;
let sequence = 0;
let phase = "setup";

async function waitFor(number, result) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const response = await readFile(join(control, "reply"), "utf8").catch(() => "");
    if (response.startsWith(number + " ")) {
      assert.equal(response, number + " " + result);
      return;
    }
    assert.equal(currentGui.exitCode, null);
    await delay(25);
  }
  throw new Error("Ipe event did not finish");
}
async function gui(action, value = "", expected = "OK") {
  sequence++;
  await writeFile(join(control, "request.tmp"), sequence + " " + action + " " + value);
  await rename(join(control, "request.tmp"), join(control, "request"));
  await waitFor(sequence, expected);
}
async function openGui() {
  currentGui = spawn("/usr/bin/ipe", [source], {
    env: { ...process.env, QT_QPA_PLATFORM: "offscreen", IPELETPATH: plugins, IPESTYLES: "_",
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      IPE_MCP_WORKSPACE_ROOT: work, IPE_MCP_BRIDGE_ROOT: spool,
      IPE_MCP_BRIDGE_TRANSACTION: resolve("bridge/ipe-mcp-transaction.lua"),
      IPE_MCP_BRIDGE_PEER: resolve("dist/src/cli/bridge-peer.js"), IPE_BRIDGE_TEST_CONTROL: control },
    stdio: ["ignore", "ignore", "pipe"],
  });
  currentGui.stderr.on("data", (chunk) => { if (guiErrors.length < 100) guiErrors.push(String(chunk)); });
  await waitFor(0, "READY");
}
async function stopGui(signal = "SIGTERM") {
  if (!currentGui || currentGui.exitCode !== null || currentGui.signalCode !== null) return;
  const stopped = new Promise((done) => currentGui.once("exit", done));
  currentGui.kill(signal);
  await Promise.race([stopped, delay(1500)]);
  if (currentGui.exitCode === null && currentGui.signalCode === null) currentGui.kill("SIGKILL");
  await stopped;
}
async function openServer(bridgeEnabled = true) {
  const client = new Client({ name: "ipe-bridge-real-gate", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/src/cli/mcp-stdio.js")],
    env: { PATH: process.env.PATH ?? "", IPE_MCP_WORKSPACE_ROOT: work, IPE_MCP_STATE_ROOT: state,
      ...(bridgeEnabled ? { IPE_MCP_BRIDGE_ROOT: spool } : {}) }, stderr: "pipe" });
  transport.stderr.on("data", (chunk) => { if (serverErrors.length < 100) serverErrors.push(String(chunk)); });
  currentServer = client;
  await client.connect(transport, { timeout: 5000 });
}
async function tool(name, args, expectedError) {
  const result = await currentServer.callTool({ name, arguments: args }, { timeout: 45000 });
  const structured = result.structuredContent;
  if (expectedError === undefined && structured?.ok !== true) {
    const code = structured?.error?.code;
    throw new Error(/^[A-Z_]{1,40}$/u.test(code) ? code : "UNEXPECTED_TOOL_FAILURE");
  }
  assert.deepEqual(JSON.parse(result.content.find(({ type }) => type === "text").text), structured);
  if (expectedError !== undefined) assert.equal(structured.error?.code, expectedError);
  else assert.equal(structured.ok, true, structured.error?.code);
  return { ...structured.data, content: result.content };
}
const bridge = (action, args, error) => tool("ipe_bridge", { action, ...args }, error);

try {
  await Promise.all([work, spool, plugins, control].map((directory) => mkdir(directory, { mode: 0o700 })));
  await copyFile(file, source);
  const original = await readFile(source);
  await copyFile("bridge/ipe-mcp-live.lua", join(plugins, "ipe-mcp-live.lua"));
  await copyFile("scripts/conformance/m10-live-bridge-driver.lua", join(plugins, "bridge-driver.lua"));
  await openServer(false);
  assert.ok(!(await currentServer.listTools()).tools.some(({ name }) => name === "ipe_bridge"));
  assert.equal((await tool("ipe_orientation", {})).bridge, undefined);
  await currentServer.close();
  await openServer();
  assert.ok((await currentServer.listTools()).tools.some(({ name }) => name === "ipe_bridge"));
  assert.deepEqual((await tool("ipe_orientation", {})).bridge, {
    tool: "ipe_bridge", transport: "private-local-files", guiConsentRequired: true,
  });
  const opened = await tool("ipe_open_document", { path: source });
  const documentId = opened.documentId;
  const ids = opened.outline.pages.flatMap(({ objects }) => objects.map(({ id }) => id));
  const { epoch } = await bridge("invite", { documentId, expectedRevision: 0 });
  const step = (sequence) => ({ epoch, sequence });
  const patch = (expectedRevision, title, error) => tool("ipe_apply_operations", {
    documentId, expectedRevision, operations: [{ op: "set_metadata", title }],
  }, error);

  phase = "attach";
  await openGui();
  await gui("attach", epoch);
  assert.equal((await bridge("attach", { epoch })).revision, 0);

  phase = "GUI to MCP";
  await gui("edit", "From the Ipe operator");
  await gui("send");
  assert.equal((await bridge("ingest", step(1))).revision, 1);
  const afterGUI = await tool("ipe_inspect", { documentId });
  assert.deepEqual(afterGUI.outline.pages.flatMap(({ objects }) => objects.map(({ id }) => id)), ids);
  const readSource = await currentServer.readResource({ uri: "ipe://documents/" + documentId + "/source" });
  assert.match(readSource.contents[0].text, /From the Ipe operator/u);

  phase = "declined";
  await patch(1, "From MCP");
  await bridge("offer", { ...step(2), expectedRevision: 2 });
  await bridge("authorize", step(2), "BRIDGE_CONFLICT");
  await gui("review", "no");
  assert.equal((await bridge("settle", step(2))).revision, 1);
  await gui("verify", "From the Ipe operator");

  phase = "approved reservation and restart";
  await bridge("offer", { ...step(3), expectedRevision: 2 });
  await gui("review", "yes");
  await gui("apply", "", "WARNING");
  await bridge("authorize", step(3));
  await currentServer.close();
  phase = "restart";
  await openServer();
  await patch(2, "Concurrent MCP edit", "BRIDGE_REVIEW_PENDING");
  await bridge("authorize", step(3));
  await gui("apply");
  phase = "settle";
  assert.equal((await bridge("settle", step(3))).revision, 2);
  assert.equal((await bridge("settle", step(3))).revision, 2);
  await gui("verify", "From MCP");
  await gui("undo");
  await gui("verify", "From the Ipe operator");
  await gui("redo");
  await gui("verify", "From MCP");

  phase = "stale GUI base";
  await patch(2, "Second MCP proposal");
  await bridge("offer", { ...step(4), expectedRevision: 3 });
  await gui("edit", "Concurrent Ipe edit");
  await gui("review", "yes", "WARNING");
  await bridge("authorize", step(4), "BRIDGE_CONFLICT");
  await gui("verify", "Concurrent Ipe edit");

  phase = "native pipeline";
  const validation = await tool("ipe_validate", { documentId, level: "full" });
  assert.equal(validation.ok, true);
  const destination = join(work, "saved-copy.ipe");
  await tool("ipe_save_document", { documentId, expectedRevision: 3, targetPath: destination, confirmation: "SAVE" });
  const reloaded = await tool("ipe_open_document", { path: destination });
  const reloadedIds = reloaded.outline.pages.flatMap(({ objects }) => objects.map(({ id }) => id));
  assert.deepEqual(reloadedIds, ids);
  await tool("ipe_render_preview", { documentId: reloaded.documentId });
  const exported = await tool("ipe_export_document", { documentId: reloaded.documentId, format: "pdf" });
  const pdf = await currentServer.readResource({ uri: exported.content.find(({ type }) => type === "resource_link").uri });
  assert.match(Buffer.from(pdf.contents[0].blob, "base64").subarray(0, 8).toString(), /^%PDF-/u);
  assert.deepEqual(await readFile(source), original);

  phase = "Ipe crash and explicit recovery";
  await stopGui();
  await Promise.all(["request", "reply"].map((name) => rm(join(control, name), { force: true })));
  const fresh = await tool("ipe_open_document", { path: source });
  const freshId = fresh.documentId;
  const crashEpoch = (await bridge("invite", { documentId: freshId, expectedRevision: 0 })).epoch;
  const crashStep = { epoch: crashEpoch, sequence: 1 };
  await openGui();
  await gui("attach", crashEpoch);
  await bridge("attach", { epoch: crashEpoch });
  await tool("ipe_apply_operations", { documentId: freshId, expectedRevision: 0, operations: [{ op: "set_metadata", title: "Interrupted proposal" }] });
  const crashOffer = await bridge("offer", { ...crashStep, expectedRevision: 1 });
  await gui("review", "yes");
  await bridge("authorize", crashStep);
  // Simulate process death just after consuming a grant and before changing the model.
  await promisify(execFile)(process.execPath, [resolve("dist/src/cli/bridge-peer.js"), "claim", crashEpoch,
    "1", source, crashOffer.proposalHash, String(currentGui.pid)], {
    env: { ...process.env, IPE_MCP_WORKSPACE_ROOT: work, IPE_MCP_BRIDGE_ROOT: spool }, timeout: 5000,
  });
  await stopGui("SIGKILL");
  await Promise.all(["request", "reply"].map((name) => rm(join(control, name), { force: true })));
  await openGui();
  await gui("recover", crashEpoch + " 1 unchanged");
  assert.equal((await bridge("settle", crashStep)).revision, 0);
  await bridge("authorize", crashStep, "BRIDGE_CONFLICT");
  await tool("ipe_apply_operations", { documentId: freshId, expectedRevision: 1, operations: [{ op: "set_metadata", title: "After explicit recovery" }] });
  assert.deepEqual(await readFile(source), original);

  phase = "privacy";
  for (const diagnostics of [serverErrors, guiErrors]) {
    const text = diagnostics.join("");
    assert.ok(![root, epoch, crashEpoch, "Concurrent Ipe edit", "From the Ipe operator"].some((value) => text.includes(value)));
  }
  process.stdout.write("M10 LIVE BRIDGE PASS: real stdio and Qt Ipe, bidirectional revisions, explicit consent, restart, conflict, undo and native output\n");
} catch (error) {
  const line = /m10-live-bridge\.mjs:(\d+):/u.exec(error.stack)?.[1];
  const values = [error.actual, error.expected].map((value) => typeof value === "number" || /^[A-Z_]{1,40}$/u.test(String(value)) ? value : undefined);
  const code = /^[A-Z_]{1,40}$/u.test(error.message) ? error.message : undefined;
  process.stderr.write(JSON.stringify({ result: "M10 LIVE BRIDGE FAIL", phase, line, values, code }) + "\n");
  process.exitCode = 1;
} finally {
  await currentServer?.close().catch(() => undefined);
  await stopGui();
  await rm(root, { recursive: true, force: true });
}
