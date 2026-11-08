#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createPortableMcpAdapter } from "./adapters/portable-mcp.mjs";
import { runScenario } from "./core.mjs";
import { parseScenario } from "./schema.mjs";

const modern = "2026-07-28";
const legacy = "2025-11-25";
const revisions = [modern, legacy];
const servers = [];
const secrets = [];
const requestOptions = { timeout: 10_000 };
const accept = "application/json, text/event-stream";
const root = await mkdtemp(join(tmpdir(), "ipe-m10-http-"));
const temporaryRoot = join(root, "native");
await mkdir(temporaryRoot);
const makeToken = () => {
  const token = randomBytes(32).toString("base64url");
  secrets.push(token);
  return token;
};
const privateCanary = "ipe-http-private-probe-canary";
const profile = async (name) => {
  const workspace = join(root, name);
  const keys = join(root, name + "-keys");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(keys, { mode: 0o700 });
  const token = makeToken();
  const tokenFile = join(keys, "token");
  await writeFile(tokenFile, token + "\n", { mode: 0o600 });
  return { workspace, token, tokenFile };
};
function start({ workspace, token, tokenFile }, extraEnv = {}) {
  const child = spawn(process.execPath, [resolve("dist/src/cli/mcp-http.js")], {
    env: { ...process.env, TMPDIR: temporaryRoot, IPE_MCP_WORKSPACE_ROOT: workspace,
      IPE_MCP_STATE_ROOT: join(workspace, "state"), IPE_MCP_HTTP_PORT: "0",
      IPE_MCP_HTTP_TOKEN_FILE: tokenFile, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const server = {
    child, done, token,
    get stderr() { return stderr; },
    assertPrivateDiagnostics() {
      assert.equal(stdout, "");
      assert.ok(stderr.length <= 64 * 1024 && ![root, privateCanary, "Bearer ", ...secrets].some((value) => stderr.includes(value)));
      for (const line of stderr.trim().split("\n")) {
        if (line) assert.equal(typeof JSON.parse(line).event, "string");
      }
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      return await done;
    },
  };
  servers.push(server);
  return server;
}
async function until(check, milliseconds = 5000) {
  const end = Date.now() + milliseconds;
  do {
    const value = await check();
    if (value) return value;
    await delay(5);
  } while (Date.now() < end);
  throw new Error("Condition timed out");
}
async function assertLoopback(server) {
  const fdRoot = "/proc/" + server.child.pid + "/fd";
  const descriptors = await Promise.all((await readdir(fdRoot)).map((fd) => readlink(join(fdRoot, fd)).catch(() => "")));
  const sockets = new Set(descriptors.map((value) => /^socket:\[(\d+)\]$/u.exec(value)?.[1]).filter(Boolean));
  const table = async (family) => (await readFile("/proc/" + server.child.pid + "/net/" + family, "utf8")).trim().split("\n").slice(1)
    .map((line) => line.trim().split(/\s+/u)).filter((fields) => fields[3] === "0A" && sockets.has(fields[9])).map((fields) => fields[1]);
  const portHex = server.port.toString(16).toUpperCase().padStart(4, "0");
  assert.deepEqual(await table("tcp"), ["0100007F:" + portHex]);
  assert.deepEqual(await table("tcp6"), []);
}
async function ready(server) {
  const port = await until(() => {
    assert.equal(server.child.exitCode, null);
    return /"event":"http_started","port":(\d+)/u.exec(server.stderr)?.[1];
  });
  Object.assign(server, { port: Number(port), endpoint: new URL("http://127.0.0.1:" + port + "/mcp") });
  await assertLoopback(server);
  return server;
}
function makeClient(server, revision) {
  const client = new Client({ name: "ipe-http-gate", version: "1" }, revision === modern
    ? { versionNegotiation: { mode: { pin: modern } } } : {});
  const wire = new Set();
  const transport = new StreamableHTTPClientTransport(server.endpoint, {
    authProvider: { token: async () => server.token },
    async fetch(input, init) {
      const request = new Request(input, init);
      const response = await fetch(request);
      const actual = request.headers.get("mcp-protocol-version");
      if (actual !== null) wire.add(actual);
      assert.equal(response.headers.get("mcp-session-id"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response;
    },
  });
  return { client, wire, connect: (options) => client.connect(transport, options) };
}
async function portable(server, revision, workspace, scenario) {
  const adapter = createPortableMcpAdapter({
    identity: { name: "official-sdk-http", version: "1", transport: "streamable-http" },
    workspaceDirectory: workspace,
    createConnection({ timeoutMs }) {
      const { client, wire, connect } = makeClient(server, revision);
      return {
        get productVersion() { return client.getServerVersion()?.version; },
        async connect(signal) {
          await connect({ signal, timeout: timeoutMs });
          if (revision === modern) await client.discover({ signal, timeout: timeoutMs });
          assert.equal(client.getServerVersion()?.name, "ipe-mcp");
          assert.ok(client.getServerCapabilities()?.tools && client.getServerCapabilities()?.resources);
          assert.deepEqual([...wire], [revision]);
        },
        callTool: (request, options) => client.callTool(request, options),
        readResource: (request) => client.readResource(request, { timeout: timeoutMs }),
        close: () => client.close(),
        assertPrivateDiagnostics: () => server.assertPrivateDiagnostics(),
      };
    },
  });
  const outcome = await runScenario({ scenario, adapter, artifactDirectory: join(root, "artifacts-" + revision) });
  if (outcome.status !== "PASS") {
    process.stderr.write(JSON.stringify({ revision, failure: outcome.failure?.code, transcript: outcome.transcript.at(-1)?.name }) + "\n");
    throw new Error("Portable workflow failed");
  }
  assert.equal(outcome.assertions.semantic, "PASS");
  assert.equal(outcome.assertions.visual, "PASS");
  process.stdout.write(JSON.stringify({ revision, capabilityMode: outcome.capabilityMode, portable: "PASS" }) + "\n");
}
function rpc(method, params = {}, id = 1) {
  return { jsonrpc: "2.0", method, params, ...(id === null ? {} : { id }) };
}
function modernRpc(method, params) {
  return rpc(method, { ...params, _meta: {
    "io.modelcontextprotocol/protocolVersion": modern,
    "io.modelcontextprotocol/clientInfo": { name: "gate", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } });
}
async function post(server, body, headers = {}, options = {}) {
  return await fetch(server.endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + server.token, accept, "content-type": "application/json", "mcp-protocol-version": legacy, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
}
async function raw(server, source, { wait = 13_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: server.port });
    let response = "";
    socket.setTimeout(wait, () => socket.destroy(new Error("Raw socket deadline exceeded")));
    socket.once("connect", () => socket.write(source));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", (error) => { if (response) resolve(response); else reject(error); });
    socket.once("close", () => resolve(response));
  });
}
async function expectResponse(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await response.text();
  assert.ok(!body.includes(privateCanary));
  if (code !== undefined) assert.equal(JSON.parse(body).error.code, code);
}
const parseStatus = (wire) => Number(/^HTTP\/1\.1 (\d+)/u.exec(wire)?.[1]);
let step = "setup";
try {
  const first = await profile("main");
  const server = await ready(start(first));
  const scenario = parseScenario(JSON.parse(await readFile("fixtures/conformance/m10/portable-create-edit-export.json", "utf8")));
  for (const revision of revisions) {
    step = "portable-" + revision;
    await portable(server, revision, first.workspace, scenario);
  }

  step = "admission";
  await delay(350);
  const ping = rpc("ping");
  const url = server.endpoint;
  for (const header of ["", "Bearer invalid", "Basic " + privateCanary]) {
    const response = await post(server, ping, { authorization: header });
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    await expectResponse(response, 401);
  }
  await expectResponse(await post(server, ping, { authorization: "", cookie: "auth=" + server.token }), 401);
  await expectResponse(await fetch(new URL("/mcp?token=" + server.token, url), { signal: AbortSignal.timeout(2000) }), 404);
  await expectResponse(await post(server, ping, { forwarded: "for=127.0.0.1" }), 403);
  for (const origin of ["https://evil.invalid", url.origin, "null"]) await expectResponse(await post(server, ping, { origin }), 403);
  const auth = { authorization: "Bearer " + server.token };
  for (const method of ["GET", "DELETE", "OPTIONS"]) {
    const response = await fetch(url, { method, headers: auth, signal: AbortSignal.timeout(2000) });
    assert.equal(response.headers.get("allow"), "POST");
    await expectResponse(response, 405);
  }
  await expectResponse(await fetch(new URL("/sse", url), { headers: auth, signal: AbortSignal.timeout(2000) }), 404);
  const requestPrefix = "POST /mcp HTTP/1.1\r\n";
  const baseHeaders = "Host: " + url.host + "\r\nAuthorization: Bearer " + server.token + "\r\n";
  const emptyBody = "Content-Length: 0\r\nConnection: close\r\n\r\n";
  await delay(350);
  const rawReject = async (headers, status) => assert.equal(parseStatus(await raw(server, requestPrefix + headers + emptyBody)), status);
  // Node 24 rejects a missing HTTP/1.1 Host before the application sees it.
  assert.ok([400, 403].includes(parseStatus(await raw(server, requestPrefix + emptyBody))));
  await rawReject("Host: localhost:" + server.port + "\r\n", 403);
  await rawReject("Host: " + privateCanary + ".invalid\r\n", 403);
  await rawReject(baseHeaders + "Host: " + url.host + "\r\n", 403);
  await rawReject(baseHeaders + "Origin: null\r\nOrigin: null\r\n", 403);
  await rawReject(baseHeaders + "Authorization: Bearer " + server.token + "\r\n", 401);
  await rawReject(baseHeaders + "MCP-Protocol-Version: " + legacy + "\r\nMCP-Protocol-Version: " + legacy + "\r\n", 400);
  await delay(350);
  process.stdout.write("admission and anti-rebinding PASS\n");

  step = "wire";
  await expectResponse(await post(server, "{"), 400, -32700);
  await expectResponse(await post(server, [ping]), 400, -32600);
  await expectResponse(await post(server, ping, { "content-type": "text/plain" }), 415);
  await expectResponse(await post(server, ping, { "content-encoding": "gzip" }), 415);
  await expectResponse(await post(server, ping, { "mcp-protocol-version": "2025-06-18" }), 400, -32022);
  await expectResponse(await post(server, ping, { "mcp-protocol-version": privateCanary }), 400, -32022);
  await expectResponse(await post(server, ping, { "mcp-protocol-version": modern, "mcp-method": "ping" }), 400, -32602);
  const modernHeaders = { "mcp-protocol-version": modern, "mcp-method": "tools/call", "mcp-name": privateCanary };
  const orientation = modernRpc("tools/call", { name: "ipe_orientation", arguments: {} });
  const originalState = (await readdir(join(first.workspace, "state"))).sort();
  const wouldWrite = modernRpc("tools/call", { name: "ipe_create_document", arguments: { preset: "standard", title: privateCanary } });
  await expectResponse(await post(server, wouldWrite, modernHeaders), 400, -32020);
  await expectResponse(await post(server, wouldWrite, { ...modernHeaders, "mcp-name": "ipe_create_document", authorization: "Bearer invalid" }), 401);
  assert.deepEqual((await readdir(join(first.workspace, "state"))).sort(), originalState);
  await expectResponse(await post(server, orientation, modernHeaders), 400, -32020);
  const incomplete = structuredClone(orientation);
  incomplete.params._meta["io.modelcontextprotocol/clientInfo"] = privateCanary;
  await expectResponse(await post(server, incomplete, { ...modernHeaders, "mcp-name": "ipe_orientation" }), 400, -32602);
  await expectResponse(await post(server, orientation, { ...modernHeaders, "mcp-name": "ipe_orientation", "mcp-protocol-version": legacy }), 400, -32020);
  await expectResponse(await post(server, rpc("notifications/initialized", {}, null)), 202);
  await expectResponse(await post(server, modernRpc("subscriptions/listen", {}), { "mcp-protocol-version": modern, "mcp-method": "subscriptions/listen" }), 400, -32601);
  process.stdout.write("protocol version, envelope and mirrors PASS\n");

  step = "size and rate";
  const jsonHeaders = baseHeaders + "Content-Type: application/json\r\nAccept: " + accept + "\r\n";
  const oversized = requestPrefix + jsonHeaders + "Content-Length: 16777217\r\n\r\n";
  assert.equal(parseStatus(await raw(server, oversized)), 413);
  const chunk = "x".repeat(16 * 1024 * 1024 + 1);
  const chunked = requestPrefix + jsonHeaders + "Transfer-Encoding: chunked\r\n\r\n1000001\r\n" + chunk + "\r\n0\r\n\r\n";
  assert.equal(parseStatus(await raw(server, chunked)), 413);
  assert.equal(parseStatus(await raw(server, requestPrefix + jsonHeaders + "Content-Length: invalid\r\n\r\n")), 400);
  assert.equal(parseStatus(await raw(server, requestPrefix + baseHeaders + "X-Probe: " + "x".repeat(17_000) + "\r\n\r\n")), 431);
  const flooded = await Promise.all(Array.from({ length: 24 }, () => post(server, ping, { authorization: "Bearer invalid" })));
  assert.ok(flooded.some((reply) => reply.status === 429));
  await Promise.all(flooded.map((reply) => reply.text()));
  await delay(350);
  const [slowHeader, ...slowBodies] = await Promise.all([
    raw(server, requestPrefix + "Host: "),
    ...Array.from({ length: 9 }, () => raw(server, requestPrefix + jsonHeaders + "Content-Length: 5\r\n\r\n{")),
  ]);
  assert.equal(parseStatus(slowHeader), 408);
  assert.equal(slowBodies.filter((wire) => parseStatus(wire) === 429).length, 1);
  assert.equal(slowBodies.filter((wire) => parseStatus(wire) === 408).length, 8);
  await expectResponse(await post(server, ping), 200);
  process.stdout.write("HTTP body/header limits, deadlines, exchange cap and recovery PASS\n");

  step = "profile isolation";
  const second = await profile("isolated");
  const other = await ready(start(second));
  const clients = [makeClient(server, legacy), makeClient(server, modern), makeClient(other, modern)];
  try {
    await Promise.all(clients.map((entry) => entry.connect(requestOptions)));
    const [left, right, isolated] = clients.map((entry) => entry.client);
    const create = (client, title) => client.callTool({ name: "ipe_create_document", arguments: { preset: "standard", title } }, requestOptions);
    const [firstDoc, secondDoc] = await Promise.all([create(left, "Left"), create(right, "Right")]);
    const documentId = firstDoc.structuredContent.data.documentId;
    const secondId = secondDoc.structuredContent.data.documentId;
    assert.notEqual(documentId, secondId);
    const requestInspection = (id) => post(server, modernRpc("tools/call", { name: "ipe_inspect", arguments: { documentId: id } }),
      { "mcp-protocol-version": modern, "mcp-method": "tools/call", "mcp-name": "ipe_inspect" }).then((reply) => reply.json());
    const [firstReply, secondReply] = await Promise.all([requestInspection(documentId), requestInspection(secondId)]);
    assert.equal(firstReply.id, secondReply.id);
    assert.equal(firstReply.result.structuredContent.data.documentId, documentId);
    assert.equal(secondReply.result.structuredContent.data.documentId, secondId);
    const [firstSource, secondSource] = await Promise.all([left, right].map((client, index) => client.readResource({
      uri: "ipe://documents/" + [documentId, secondId][index] + "/source",
    }, requestOptions)));
    assert.match(firstSource.contents[0].text, /title="Left"/u);
    assert.match(secondSource.contents[0].text, /title="Right"/u);
    const uri = "ipe://documents/" + documentId + "/summary";
    await right.readResource({ uri }, requestOptions);
    await assert.rejects(isolated.readResource({ uri }, requestOptions));
    const page = firstDoc.structuredContent.data.outline.pages[0];
    const edited = await right.callTool({ name: "ipe_apply_operations", arguments: {
      documentId, expectedRevision: 0,
      operations: [{ op: "add_rectangle", pageId: page.id, layerId: page.layers[0].id, ...scenario.task.rectangle }],
    } }, requestOptions);
    assert.equal(edited.structuredContent.data.revision, 1);
    const exportResult = await left.callTool({ name: "ipe_export_document", arguments: { documentId, format: "pdf" } }, requestOptions);
    const link = exportResult.content.find((item) => item.type === "resource_link");
    assert.ok(link);
    await left.readResource({ uri: link.uri }, requestOptions);
    await assert.rejects(isolated.readResource({ uri: link.uri }, requestOptions));
    await expectResponse(await post(other, ping, auth), 401);
    const escape = join(second.workspace, "escape.ipe");
    await writeFile(join(first.workspace, "private.ipe"), privateCanary);
    await symlink(join(first.workspace, "private.ipe"), escape);
    const outside = await isolated.callTool({ name: "ipe_open_document", arguments: { path: escape } }, requestOptions);
    assert.equal(outside.structuredContent.error.code, "PATH_OUTSIDE_WORKSPACE");
    const saveArguments = { documentId, expectedRevision: 1, targetPath: join(first.workspace, "gate-save.ipe") };
    const saveRequest = { name: "ipe_save_document", arguments: saveArguments };
    const declined = await left.callTool(saveRequest, requestOptions);
    assert.equal(declined.isError, true);
    await assert.rejects(readFile(saveArguments.targetPath), { code: "ENOENT" });
    const saves = await Promise.all([left, right].map((client, index) => client.callTool({
      ...saveRequest,
      arguments: { ...saveArguments, targetPath: join(first.workspace, "gate-save-" + index + ".ipe"), confirmation: "SAVE" },
    }, requestOptions)));
    assert.ok(saves.every((result) => result.structuredContent.ok));
    assert.match(await readFile(join(first.workspace, "gate-save-0.ipe"), "utf8"), /title="Left"/u);
    assert.match(await readFile(join(first.workspace, "gate-save-1.ipe"), "utf8"), /title="Left"/u);
    const duplicate = start(first);
    assert.equal(await duplicate.done, 1);
    await other.stop();
    const badPermissions = join(second.workspace + "-keys", "insecure");
    await writeFile(badPermissions, second.token, { mode: 0o600 });
    await chmod(badPermissions, 0o644);
    assert.equal(await start({ ...second, tokenFile: badPermissions }).done, 1);
    const linked = join(second.workspace + "-keys", "link");
    await symlink(second.tokenFile, linked);
    assert.equal(await start({ ...second, tokenFile: linked }).done, 1);

    step = "disconnect and cleanup";
    const active = new AbortController();
    const childPids = async () => (await readFile("/proc/" + server.child.pid + "/task/" + server.child.pid + "/children", "utf8")).trim().split(/\s+/u).filter(Boolean);
    const nativeRequest = right.callTool({ name: "ipe_validate", arguments: { documentId, level: "full" } },
      { ...requestOptions, signal: active.signal }).catch(() => null);
    await until(async () => (await childPids()).length > 0);
    active.abort();
    assert.equal(await nativeRequest, null);
    await until(async () => (await childPids()).length === 0 && (await readdir(temporaryRoot)).length === 0);
    await expectResponse(await post(server, ping), 200);

    step = "rotation and restart";
    const stopping = post(server, modernRpc("tools/call", { name: "ipe_validate", arguments: { documentId, level: "full" } }),
      { "mcp-protocol-version": modern, "mcp-method": "tools/call", "mcp-name": "ipe_validate" }).catch(() => null);
    await until(async () => (await childPids()).length > 0);
    assert.equal(await server.stop(), 0);
    assert.equal(await stopping, null);
    await until(async () => (await readdir(temporaryRoot)).length === 0);
    assert.equal(await fetch(server.endpoint).catch(() => null), null);
    const replacement = first.tokenFile + ".new";
    const updated = makeToken();
    await writeFile(replacement, updated + "\n", { mode: 0o600 });
    await rename(replacement, first.tokenFile);
    const restarted = await ready(start({ ...first, token: updated }, { IPE_MCP_HTTP_DEADLINE_MS: "150", IPE_MCP_HTTP_PORT: String(server.port) }));
    await expectResponse(await post(restarted, ping, auth), 401);
    const resumed = makeClient(restarted, modern);
    try {
      await resumed.connect(requestOptions);
      const recovered = await resumed.client.readResource({ uri }, requestOptions);
      assert.equal(JSON.parse(recovered.contents[0].text).revision, 1);
      const timed = await post(restarted, modernRpc("tools/call", { name: "ipe_validate", arguments: { documentId, level: "full" } }),
        { "mcp-protocol-version": modern, "mcp-method": "tools/call", "mcp-name": "ipe_validate" });
      await expectResponse(timed, 504);
      await until(async () => (await readdir(temporaryRoot)).length === 0);
      await expectResponse(await post(restarted, ping), 200);
    } finally { await resumed.client.close(); }
    assert.equal(await restarted.stop(), 0);
    process.stdout.write("profile isolation, cancellation, timeout, rotation and restart PASS\n");
  } finally {
    await Promise.all(clients.map(({ client }) => client.close()));
  }
  step = "privacy and shutdown";
  for (const instance of servers) instance.assertPrivateDiagnostics();
  process.stdout.write("M10 HTTP PASS: real loopback protocol and TM-HTTP adversarial probes\n");
} catch (error) {
  const location = /run-local-http\.mjs:(\d+):/u.exec(error.stack)?.[1];
  const counts = [error.actual, error.expected].map((value) => typeof value === "number" ? value : undefined);
  process.stderr.write(JSON.stringify({ status: "M10 HTTP FAIL", step, location, counts }) + "\n");
  process.exitCode = 1;
} finally {
  await Promise.allSettled(servers.map((server) => server.stop()));
  await rm(root, { recursive: true, force: true });
}
