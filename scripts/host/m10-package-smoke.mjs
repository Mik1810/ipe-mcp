#!/usr/bin/env node
import { mkdir, readFile, readdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const [commandArgument, outputArgument, expectedVersion] = process.argv.slice(2);
if (commandArgument === undefined || outputArgument === undefined || expectedVersion === undefined) {
  throw new Error("usage: node scripts/host/m10-package-smoke.mjs CLI OUTPUT EXPECTED_VERSION");
}

const command = resolve(commandArgument);
const output = resolve(outputArgument);
const state = join(output, ".state");
await mkdir(output, { recursive: true });

const transport = new StdioClientTransport({
  command,
  cwd: output,
  env: {
    PATH: process.env.PATH ?? "",
    IPE_MCP_WORKSPACE_ROOT: output,
    IPE_MCP_STATE_ROOT: state,
  },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
const client = new Client({ name: "ipe-m10-package-smoke", version: "1.0.0" });

const listeningSockets = async (pid) => {
  const targets = [];
  for (const descriptor of await readdir(`/proc/${pid}/fd`)) {
    try { targets.push(await readlink(`/proc/${pid}/fd/${descriptor}`)); }
    catch { /* Descriptor closed during the bounded inspection. */ }
  }
  const socketInodes = new Set(targets.flatMap((target) => /^socket:\[(\d+)\]$/u.exec(target)?.[1] ?? []));
  const listeners = [];
  for (const table of ["tcp", "tcp6"]) {
    const lines = (await readFile(`/proc/${pid}/net/${table}`, "utf8")).trim().split("\n").slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/u);
      if (fields[3] === "0A" && socketInodes.has(fields[9])) listeners.push(`${table}:${fields[1]}`);
    }
  }
  const unixLines = (await readFile(`/proc/${pid}/net/unix`, "utf8")).trim().split("\n").slice(1);
  for (const line of unixLines) {
    const fields = line.trim().split(/\s+/u);
    const accepts = (Number.parseInt(fields[3] ?? "0", 16) & 0x10000) !== 0;
    if (accepts && socketInodes.has(fields[6])) listeners.push(`unix:${fields[7] ?? "anonymous"}`);
  }
  return listeners;
};

const call = async (name, args, options) => {
  const result = await client.callTool({ name, arguments: args }, options);
  if (result.structuredContent === undefined) throw new Error(`${name}: missing structuredContent`);
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text" || JSON.stringify(JSON.parse(text.text)) !== JSON.stringify(result.structuredContent)) {
    throw new Error(`${name}: text/structured parity failed`);
  }
  return result.structuredContent;
};

await client.connect(transport);
try {
  const server = client.getServerVersion();
  if (server?.name !== "ipe-mcp" || server.version !== expectedVersion) {
    throw new Error(`server identity mismatch: ${JSON.stringify(server)}`);
  }
  const pid = transport.pid;
  if (pid === null) throw new Error("stdio child PID is unavailable");
  const listeners = await listeningSockets(pid);
  if (listeners.length !== 0) throw new Error(`installed server opened a listener: ${JSON.stringify(listeners)}`);

  const orientation = await call("ipe_orientation", {});
  if (orientation.ok !== true || orientation.data.contractVersion !== "ipe-mcp/1") throw new Error("orientation contract mismatch");
  const capabilities = await call("ipe_get_capabilities", {});
  if (capabilities.ok !== true || capabilities.data.capabilities.mode !== "full-7.2.30") {
    throw new Error(`supported native capability unavailable: ${JSON.stringify(capabilities)}`);
  }
  if (JSON.stringify(capabilities).includes("/usr/") || JSON.stringify(capabilities).includes(output)) {
    throw new Error("capability result leaked a local path");
  }

  const created = await call("ipe_create_document", { preset: "16:9", title: "Package smoke" });
  const page = created.data.outline.pages[0];
  const mutated = await call("ipe_apply_operations", {
    documentId: created.data.documentId,
    expectedRevision: 0,
    operations: [{
      op: "add_rectangle",
      pageId: page.id,
      layerId: page.layers[0].id,
      x: 160,
      y: 250,
      width: 500,
      height: 160,
      stroke: "0",
      fill: "0.8",
    }],
  });
  if (mutated.ok !== true || mutated.data.revision !== 1) throw new Error("package mutation failed");

  const validation = await call(
    "ipe_validate",
    { documentId: created.data.documentId, level: "full" },
    { timeout: 180_000, onprogress: () => undefined },
  );
  if (validation.ok !== true || validation.data.ok !== true) throw new Error("package full validation failed");

  const targetPath = join(output, "package-smoke.ipe");
  await call("ipe_save_document", {
    documentId: created.data.documentId,
    expectedRevision: 1,
    targetPath,
    confirmation: "SAVE",
  });
  const preview = await call(
    "ipe_render_preview",
    { documentId: created.data.documentId },
    { timeout: 180_000, onprogress: () => undefined },
  );
  const exported = await call(
    "ipe_export_document",
    { documentId: created.data.documentId, format: "pdf" },
    { timeout: 180_000, onprogress: () => undefined },
  );
  const previewResource = await client.readResource({ uri: preview.data.resources[0].uri });
  const pdfResource = await client.readResource({ uri: exported.data.resources[0].uri });
  const previewBytes = Buffer.from(previewResource.contents[0].blob, "base64");
  const pdfBytes = Buffer.from(pdfResource.contents[0].blob, "base64");
  const source = await readFile(targetPath, "utf8");
  if (!source.startsWith("<?xml") || !source.includes('version="70218"')) throw new Error("saved Ipe artifact is invalid");
  if (!previewBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("preview PNG is invalid");
  if (!pdfBytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("exported PDF is invalid");

  const sensitive = [output, "Bearer ", "_authToken", "password="];
  if (sensitive.some((value) => stderr.includes(value))) throw new Error("stderr leaked package-smoke state or credentials");
  process.stdout.write(`${JSON.stringify({
    scenario: "m10-package-smoke-v1",
    productVersion: server.version,
    contract: "ipe-mcp/1",
    transport: "stdio",
    socketListeners: 0,
    capabilities: "full-7.2.30",
    create: "PASS",
    validate: "PASS",
    render: "PASS",
    export: "PASS",
    stdoutProtocolSafe: true,
    stderrRedacted: true,
    artifacts: { ipe: source.length, previewPng: previewBytes.length, pdf: pdfBytes.length },
  })}\n`);
} finally {
  await client.close();
}
