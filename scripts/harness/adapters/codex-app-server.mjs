import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { HarnessFailure } from "../privacy.mjs";
import { createPortableMcpAdapter } from "./portable-mcp.mjs";

const SERVER = "ipe_harness";
const unsupported = () => new HarnessFailure("harness", "ADAPTER_CAPABILITY_UNMET", "Codex App Server does not support direct MCP calls");
class AppServerRpcError extends Error {}

function openRpc({ codex, cwd, env, config, timeoutMs, maxResponseBytes }) {
  const child = spawn(codex, ["app-server", "--listen", "stdio://", ...(config === undefined ? [] : ["-c", config])], {
    // App Server may log its private working directory. Only the validated RPC
    // results are used as evidence; discard raw host diagnostics at the source.
    cwd, env, detached: true, stdio: ["pipe", "pipe", "ignore"],
  });
  let id = 0;
  let pending;
  let failure;
  let closePromise;
  let chunks = [];
  let size = 0;

  function fail(error) {
    failure ??= error;
    pending?.reject(failure);
  }

  function readMessage(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      fail(new Error("Invalid App Server frame"));
      return;
    }
    if (message?.id !== pending?.id || pending === undefined) return;
    if (message.error !== undefined) {
      if (message.error.code === -32601) pending.reject(unsupported());
      else pending.reject(new AppServerRpcError("App Server RPC failed"));
    } else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
    else fail(new Error("App Server reply is missing its result"));
  }

  child.stdout.on("data", (buffer) => {
    for (let offset = 0; offset < buffer.length && failure === undefined;) {
      const newline = buffer.indexOf(10, offset);
      const end = newline === -1 ? buffer.length : newline;
      const chunk = buffer.subarray(offset, end);
      size += chunk.length;
      if (size > maxResponseBytes) {
        fail(new Error("App Server frame exceeded its byte limit"));
        break;
      }
      chunks.push(chunk);
      if (newline === -1) break;
      readMessage(Buffer.concat(chunks, size).toString("utf8"));
      chunks = [];
      size = 0;
      offset = end + 1;
    }
  });
  child.on("error", (error) => fail(error.code === "ENOENT" ? unsupported() : new Error("Could not launch Codex App Server")));
  child.stdin.on("error", () => fail(new Error("Could not write to Codex App Server")));
  child.on("exit", () => fail(new Error("Codex App Server exited")));

  function send(message) {
    if (failure !== undefined) throw failure;
    child.stdin.write(JSON.stringify(message) + "\n");
  }
  async function request(method, params) {
    if (pending !== undefined) throw new Error("Concurrent App Server calls are unsupported");
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending = { id: ++id, resolve, reject };
        timer = setTimeout(() => fail(new Error("App Server call exceeded its timeout")), timeoutMs);
        send({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
      pending = undefined;
    }
  }
  function terminateGroup() {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  return {
    request,
    notify: (method) => send({ method }),
    close() {
      return closePromise ??= (async () => {
        fail(new Error("App Server connection closed"));
        child.stdin.end();
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          await Promise.race([once(child, "close"), delay(500, undefined, { ref: false })]).catch(() => undefined);
        }
        terminateGroup();
      })();
    },
  };
}

export function createCodexAppServerAdapter({ codex, command, args = [], cwd, workspaceDirectory, installedPlugin }) {
  return createPortableMcpAdapter({
    identity: { name: "codex-app-server", version: "1", transport: "stdio" },
    workspaceDirectory,
    createConnection({ timeoutMs, maxResponseBytes }) {
      let rpc;
      let threadId;
      return {
        async connect(signal) {
          const codexHome = installedPlugin?.codexHome ?? await mkdtemp(join(workspaceDirectory, ".codex-host-"));
          const server = installedPlugin?.server ?? SERVER;
          signal.throwIfAborted();
          const quote = (value) => JSON.stringify(value);
          const config = installedPlugin !== undefined ? undefined : "mcp_servers={" + SERVER + "={command=" + quote(command) +
            ",args=" + quote(args) + ",cwd=" + quote(cwd) + ",env={IPE_MCP_WORKSPACE_ROOT=" + quote(workspaceDirectory) +
            ",IPE_MCP_STATE_ROOT=" + quote(join(workspaceDirectory, ".state")) + "}}}";
          rpc = openRpc({
            codex, cwd: workspaceDirectory, config, timeoutMs, maxResponseBytes,
            env: { PATH: process.env.PATH ?? "", CODEX_HOME: codexHome },
          });
          await rpc.request("initialize", {
            clientInfo: { name: "ipe-m10-cross-host-harness", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          });
          rpc.notify("initialized");
          const started = await rpc.request("thread/start", {
            cwd: workspaceDirectory, ephemeral: true, sandbox: "read-only", approvalPolicy: "never",
          });
          threadId = started.thread?.id;
          if (typeof threadId !== "string") throw new Error("App Server did not start an ephemeral session");
          if (installedPlugin !== undefined) {
            const { data } = await rpc.request("mcpServerStatus/list", { threadId, serverName: server });
            if (!data.some(({ name }) => name === server)) {
              throw new HarnessFailure("protocol", "PLUGIN_MCP_NOT_REGISTERED", "The installed plugin did not register its MCP server");
            }
          }
          // Probe the resource route before any mutation. A missing document is
          // expected; a missing RPC method is a host capability skip.
          try {
            await rpc.request("mcpServer/resource/read", {
              threadId, server, uri: "ipe://documents/00000000-0000-4000-8000-000000000000/summary",
            });
          } catch (error) {
            if (!(error instanceof AppServerRpcError)) throw error;
          }
        },
        callTool: ({ name, arguments: args }) => rpc.request("mcpServer/tool/call", { threadId, server: installedPlugin?.server ?? SERVER, tool: name, arguments: args }),
        readResource: ({ uri }) => rpc.request("mcpServer/resource/read", { threadId, server: installedPlugin?.server ?? SERVER, uri }),
        close: async () => { await rpc?.close(); },
      };
    },
  });
}
