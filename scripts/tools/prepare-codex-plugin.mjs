#!/usr/bin/env node
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const selector = "ipe-mcp@ipe-mcp-local";
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const contains = (root, path) => {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith("../") && !isAbsolute(part));
};

export async function prepareCodexPlugin({ executable, workspace, output }) {
  const command = await realpath(executable);
  await access(command, constants.X_OK);
  const pkgRoot = resolve(dirname(command), "../../..");
  const installed = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
  const supported = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  if (installed.name !== "ipe-mcp" || installed.version !== supported.version ||
      installed.bin?.["ipe-mcp"] !== "dist/src/cli/mcp-stdio.js" ||
      command !== join(pkgRoot, installed.bin["ipe-mcp"])) {
    throw new Error("Select the executable from the supported exact ipe-mcp package");
  }

  const workspaceRoot = await realpath(workspace);
  if (!(await stat(workspaceRoot)).isDirectory() || workspaceRoot === "/") {
    throw new Error("Select a dedicated workspace directory");
  }
  const stateRoot = join(workspaceRoot, ".ipe-mcp-state");
  const stateInfo = await lstat(stateRoot).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (stateInfo !== undefined && !stateInfo.isDirectory()) throw new Error("State root must be a directory and cannot be a symlink");

  const target = resolve(output);
  const market = join(await realpath(dirname(target)), basename(target));
  if (contains(workspaceRoot, market) || contains(market, workspaceRoot)) {
    throw new Error("The marketplace and document workspace must be separate directories");
  }
  await mkdir(market, { mode: 0o700 });
  const plugin = join(market, "plugins", "ipe-mcp");
  const catalog = join(market, ".agents", "plugins");
  for (const path of [".codex-plugin/plugin.json", "skills/ipe-authoring/SKILL.md"]) {
    const targetPath = join(plugin, path);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(join(repo, "plugins", "ipe-mcp", path), targetPath, { errorOnExist: true, force: false });
  }
  await cp(join(repo, "LICENSE"), join(plugin, "LICENSE"), { errorOnExist: true, force: false });
  await mkdir(catalog, { recursive: true });
  await writeJson(join(plugin, ".mcp.json"), {
    mcpServers: {
      "ipe-mcp": {
        command, args: [], cwd: workspaceRoot,
        env: { IPE_MCP_WORKSPACE_ROOT: workspaceRoot, IPE_MCP_STATE_ROOT: stateRoot },
      },
    },
  });
  await writeJson(join(catalog, "marketplace.json"), {
    name: "ipe-mcp-local",
    interface: { displayName: "Ipe MCP local" },
    plugins: [{
      name: "ipe-mcp", source: { source: "local", path: "./plugins/ipe-mcp" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity",
    }],
  });
  return { market, selector };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { executable: { type: "string" }, workspace: { type: "string" }, output: { type: "string" } } });
  if (!values.executable || !values.workspace || !values.output) {
    throw new Error("Usage: prepare-codex-plugin --executable FILE --workspace DIR --output NEW_DIR");
  }
  console.log(JSON.stringify(await prepareCodexPlugin(values)));
}
