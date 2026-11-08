#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { createCodexAppServerAdapter } from "./adapters/codex-app-server.mjs";
import { createSdkStdioAdapter } from "./adapters/sdk-stdio.mjs";
import { runScenario } from "./core.mjs";
import { crossHostOutcome } from "./cross-host.mjs";
import { assertPortableValue, portableFailure } from "./privacy.mjs";
import { parseScenario } from "./schema.mjs";

try {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string" }, command: { type: "string" }, "command-args": { type: "string" },
      "expected-version": { type: "string" }, codex: { type: "string" }, output: { type: "string" },
    },
  });
  if (!values.scenario || !values.command || !values.output) throw new Error("Missing scenario, command, or output option");
  const scenario = parseScenario(JSON.parse(await readFile(resolve(values.scenario), "utf8")));
  const args = JSON.parse(values["command-args"] ?? "[]");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Command arguments must be an array of strings");
  const output = resolve(values.output);
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(output, "cross-host-"));
  const command = resolve(values.command);
  const run = async (host, adapter) => {
    const result = await runScenario({ scenario, adapter, artifactDirectory: join(root, host, "artifacts") });
    await writeFile(join(root, host, "result.json"), JSON.stringify(result, null, 2) + "\n");
    return result;
  };
  const sdk = await run("sdk", createSdkStdioAdapter({
    command, args, cwd: process.cwd(), workspaceDirectory: join(root, "sdk", "workspace"), expectedVersion: values["expected-version"],
  }));
  const codex = values.codex === undefined ? undefined : await run("codex", createCodexAppServerAdapter({
    codex: resolve(values.codex), command, args, cwd: process.cwd(), workspaceDirectory: join(root, "codex", "workspace"),
  }));
  const outcome = { scenarioId: scenario.id, ...crossHostOutcome(sdk, codex) };
  assertPortableValue(outcome);
  await writeFile(join(root, "comparison.json"), JSON.stringify(outcome, null, 2) + "\n");
  process.stdout.write(JSON.stringify(outcome) + "\n");
  process.exitCode = { PASS: 0, FAIL: 1, SKIP: 77 }[outcome.status];
} catch (error) {
  process.stderr.write(JSON.stringify(portableFailure(error, "harness", "CROSS_HOST_SETUP_FAILED")) + "\n");
  process.exitCode = 2;
}
