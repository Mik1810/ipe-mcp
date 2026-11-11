import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { createPortableMcpAdapter } from "./portable-mcp.mjs";
import { HarnessFailure } from "../privacy.mjs";

const listeningSockets = async (pid) => {
  const targets = [];
  for (const descriptor of await readdir(`/proc/${pid}/fd`)) {
    try { targets.push(await readlink(`/proc/${pid}/fd/${descriptor}`)); }
    catch { /* The descriptor closed during bounded inspection. */ }
  }
  const socketInodes = new Set(targets.flatMap((target) => /^socket:\[(\d+)\]$/u.exec(target)?.[1] ?? []));
  const listeners = [];
  for (const table of ["tcp", "tcp6"]) {
    const lines = (await readFile(`/proc/${pid}/net/${table}`, "utf8")).trim().split("\n").slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/u);
      if (fields[3] === "0A" && socketInodes.has(fields[9])) listeners.push(`${table}:listener`);
    }
  }
  const unixLines = (await readFile(`/proc/${pid}/net/unix`, "utf8")).trim().split("\n").slice(1);
  for (const line of unixLines) {
    const fields = line.trim().split(/\s+/u);
    const accepts = (Number.parseInt(fields[3] ?? "0", 16) & 0x10000) !== 0;
    if (accepts && socketInodes.has(fields[6])) listeners.push("unix:listener");
  }
  return listeners;
};

export function createSdkStdioAdapter({ command, args = [], cwd, workspaceDirectory, expectedVersion }) {
  return createPortableMcpAdapter({
    identity: { name: "official-sdk-stdio", version: "1", transport: "stdio" },
    workspaceDirectory,
    createConnection: ({ timeoutMs }) => createSdkStdioConnection({
      command, args, cwd, workspaceDirectory, expectedVersion, timeoutMs,
    }),
  });
}

export function createSdkStdioConnection({ command, args, cwd, workspaceDirectory, expectedVersion, timeoutMs }) {
  const transport = new StdioClientTransport({
    command, args, cwd,
    env: { PATH: process.env.PATH ?? "", IPE_MCP_WORKSPACE_ROOT: workspaceDirectory, IPE_MCP_STATE_ROOT: join(workspaceDirectory, ".state") },
    stderr: "pipe",
  });
  const client = new Client({ name: "ipe-m10-provider-neutral-harness", version: "1.0.0" });
  let stderr = "";
  let diagnosticsExceeded = false;
  transport.stderr?.on("data", (chunk) => {
    if (stderr.length + chunk.length > 64 * 1024) diagnosticsExceeded = true;
    if (!diagnosticsExceeded) stderr += String(chunk);
  });
  return {
    get productVersion() { return client.getServerVersion()?.version; },
    async connect(signal) {
      await client.connect(transport, { signal, timeout: timeoutMs });
      const server = client.getServerVersion();
      if (server?.name !== "ipe-mcp" || (expectedVersion !== undefined && server.version !== expectedVersion)) {
        throw new HarnessFailure("protocol", "PROTOCOL_SERVER_IDENTITY", "Server identity or product version mismatch");
      }
      const pid = transport.pid;
      if (pid === null) throw new HarnessFailure("protocol", "PROTOCOL_CHILD_PID", "stdio child PID unavailable");
      if ((await listeningSockets(pid)).length !== 0) throw new HarnessFailure("protocol", "TRANSPORT_LISTENER_OPEN", "stdio server opened a network listener");
    },
    callTool: (request, options) => client.callTool(request, options),
    readResource: (request) => client.readResource(request, { timeout: timeoutMs }),
    close: () => client.close(),
    assertPrivateDiagnostics() {
      if (diagnosticsExceeded || stderr.includes(workspaceDirectory) || /Bearer\s+|_authToken|password=/iu.test(stderr)) {
        throw new HarnessFailure("protocol", "TRANSPORT_PRIVACY_FAILED", "Server diagnostics exceeded their bound or exposed private transport data");
      }
    },
  };
}
