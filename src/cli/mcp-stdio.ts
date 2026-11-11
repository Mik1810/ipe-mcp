#!/usr/bin/env node
import { resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { BridgeBroker } from "../bridge/broker.js";
import { BridgeSpool } from "../bridge/spool.js";
import { safeLog } from "../mcp/errors.js";
import { createMcpServer } from "../mcp/server.js";
import { IpeMcpService } from "../mcp/service.js";

const workspaceRoot = resolve(process.env.IPE_MCP_WORKSPACE_ROOT ?? process.cwd());
const stateRoot = resolve(process.env.IPE_MCP_STATE_ROOT ?? `${workspaceRoot}/.ipe-mcp-state`);
const timeoutSource = process.env.IPE_MCP_NATIVE_TIMEOUT_MS;
const nativeTimeoutMs = timeoutSource === undefined ? undefined : Number(timeoutSource);
if (nativeTimeoutMs !== undefined && (!Number.isSafeInteger(nativeTimeoutMs) || nativeTimeoutMs < 1 || nativeTimeoutMs > 300_000)) throw new Error("IPE_MCP_NATIVE_TIMEOUT_MS must be an integer from 1 to 300000");
const service = await IpeMcpService.create([workspaceRoot], stateRoot, nativeTimeoutMs === undefined ? {} : { limits: { timeoutMs: nativeTimeoutMs } });
const bridgeRoot = process.env.IPE_MCP_BRIDGE_ROOT;
let bridge: BridgeBroker | undefined;
if (bridgeRoot !== undefined) {
  try {
    const spool = await BridgeSpool.open(bridgeRoot, [workspaceRoot]);
    await service.recover();
    bridge = new BridgeBroker(service.sessions, spool);
  } catch {
    safeLog("bridge_start_failed");
    process.exit(1);
  }
}
const handle = serveStdio(() => createMcpServer(service, bridge), { legacy: "serve", onerror: (error) => safeLog("transport_error", { name: error.name }) });
safeLog("server_started", { contract: "ipe-mcp/1", rootCount: 1 });

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return; closing = true; safeLog("server_shutdown", { signal });
  await handle.close();
};
process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
