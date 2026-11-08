#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { NATIVE_OPERATION_LIMITS } from "../limits.js";
import { safeLog } from "../mcp/errors.js";
import { listenHttp } from "../mcp/http/listener.js";
import { claimStateRoot, readCredential } from "../mcp/http/profile.js";
import { IpeMcpService } from "../mcp/service.js";

function numberSetting(key: string, fallback: number, min: number, max: number): number {
  const value = process.env[key];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < min || number > max) throw new Error("Invalid HTTP numeric configuration");
  return number;
}

async function start(): Promise<void> {
  if (process.platform !== "linux") throw new Error("HTTP requires the Linux profile lock");
  if (process.argv.length !== 2) throw new Error("HTTP configuration uses environment settings");
  const workspace = await realpath(resolve(process.env.IPE_MCP_WORKSPACE_ROOT ?? process.cwd()));
  const credentialFile = process.env.IPE_MCP_HTTP_TOKEN_FILE;
  if (credentialFile === undefined) throw new Error("HTTP requires a credential file");
  const credential = await readCredential(credentialFile, workspace);
  const port = numberSetting("IPE_MCP_HTTP_PORT", 8765, 0, 65535);
  const limit = NATIVE_OPERATION_LIMITS.deadlineMs + 5000;
  const deadlineMs = numberSetting("IPE_MCP_HTTP_DEADLINE_MS", limit, 1, limit);
  const stateRoot = resolve(process.env.IPE_MCP_STATE_ROOT ?? join(workspace, ".ipe-mcp-state"));
  const lease = await claimStateRoot(stateRoot, workspace);
  try {
    const service = await IpeMcpService.create([workspace], stateRoot);
    await service.recover();
    const listener = await listenHttp(service, { port, credential, deadlineMs });
    let shutdown: Promise<void> | undefined;
    const stop = () => {
      shutdown ??= (async () => {
        const force = setTimeout(() => { safeLog("http_shutdown_deadline"); process.exit(1); }, 10_000);
        force.unref();
        try {
          await listener.close();
          await lease.close();
          safeLog("http_stopped");
        } finally { clearTimeout(force); }
      })();
      void shutdown.catch(() => { safeLog("http_shutdown_failed"); process.exitCode = 1; });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    safeLog("http_started", { port: listener.port });
  } catch (error) {
    await lease.close();
    throw error;
  }
}

await start().catch(() => { safeLog("http_start_failed"); process.exitCode = 1; });
