#!/usr/bin/env node
import { runBridgePeer } from "../bridge/peer.js";

try {
  const root = process.env.IPE_MCP_BRIDGE_ROOT;
  const workspace = process.env.IPE_MCP_WORKSPACE_ROOT;
  if (root === undefined || workspace === undefined) throw new Error("Bridge configuration is required");
  process.stdout.write(await runBridgePeer(process.argv.slice(2), root, workspace));
} catch {
  process.exitCode = 1;
}
