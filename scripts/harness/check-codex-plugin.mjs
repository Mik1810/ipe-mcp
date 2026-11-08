import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { prepareCodexPlugin } from "../tools/prepare-codex-plugin.mjs";
import { createCodexAppServerAdapter } from "./adapters/codex-app-server.mjs";
import { runScenario } from "./core.mjs";
import { parseScenario } from "./schema.mjs";

const [codex, executable, root] = process.argv.slice(2).map((path) => resolve(path));
const workspace = join(root, "workspace");
const codexHome = join(root, "codex-home");
const artifacts = join(root, "artifacts");
await mkdir(workspace);
await mkdir(codexHome);
const options = { executable, workspace, output: join(root, "marketplace") };
const { market, selector } = await prepareCodexPlugin(options);
await assert.rejects(() => prepareCodexPlugin(options), { code: "EEXIST" });
const config = JSON.parse(await readFile(join(market, "plugins", "ipe-mcp", ".mcp.json"), "utf8"));
assert.deepEqual(Object.keys(config.mcpServers), ["ipe-mcp"]);
assert.deepEqual(config.mcpServers["ipe-mcp"].env, {
  IPE_MCP_WORKSPACE_ROOT: workspace, IPE_MCP_STATE_ROOT: join(workspace, ".ipe-mcp-state"),
});

const exec = promisify(execFile);
const cli = async (...args) => {
  try {
    const { stdout } = await exec(codex, args, {
      cwd: workspace, env: { PATH: process.env.PATH ?? "", CODEX_HOME: codexHome },
      maxBuffer: 256 * 1024, timeout: 30_000,
    });
    return JSON.parse(stdout);
  } catch {
    throw new Error("Codex " + args.slice(0, 2).join(" ") + " lifecycle command failed");
  }
};
const scenario = parseScenario(JSON.parse(await readFile("fixtures/conformance/m10/portable-create-edit-export.json", "utf8")));
const run = (artifactDirectory) => runScenario({
  scenario, artifactDirectory,
  adapter: createCodexAppServerAdapter({ codex, workspaceDirectory: workspace, installedPlugin: { codexHome, server: "ipe-mcp" } }),
});

assert.equal((await cli("plugin", "marketplace", "add", market, "--json")).marketplaceName, "ipe-mcp-local");
const installed = await cli("plugin", "add", selector, "--json");
assert.equal(installed.pluginId, selector);
const document = join(workspace, scenario.id + ".ipe");
let bytes;
try {
  const result = await run(artifacts);
  assert.equal(result.status, "PASS", JSON.stringify(result.failure));
  assert.deepEqual(result.assertions, { semantic: "PASS", visual: "PASS" });
  assert.deepEqual(result.artifacts.map(({ kind }) => kind), ["ipe", "preview-png", "pdf", "png"]);
  bytes = await readFile(document);
  console.log("Installed Codex plugin passed the portable create/edit/recovery/validate/export scenario.");
} finally {
  assert.equal((await cli("plugin", "remove", selector, "--json")).pluginId, selector);
}
await assert.rejects(() => access(installed.installedPath), { code: "ENOENT" });
const removed = await run(join(root, "after-remove"));
assert.equal(removed.status, "FAIL");
assert.equal(removed.failure?.code, "PLUGIN_MCP_NOT_REGISTERED");
assert.deepEqual(removed.mutationHistory, []);
assert.deepEqual(await readFile(document), bytes);
console.log("Uninstall removed the cached plugin and MCP server; the saved document remains unchanged.");
