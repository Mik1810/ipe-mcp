#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createSdkStdioAdapter } from "./adapters/sdk-stdio.mjs";
import { runScenario } from "./core.mjs";
import { portableFailure } from "./privacy.mjs";
import { parseScenario } from "./schema.mjs";

const argumentsList = process.argv.slice(2);
const option = (name) => {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
};
const scenarioPath = option("--scenario");
const command = option("--command");
const workspaceDirectory = option("--workspace");
const artifactDirectory = option("--artifacts");
const resultPath = option("--result");
const expectedVersion = option("--expected-version");
const commandArgs = option("--command-args");

if ([scenarioPath, command, workspaceDirectory, artifactDirectory, resultPath].some((value) => value === undefined)) {
  process.stderr.write("usage: run-scenario --scenario FILE --command FILE --workspace DIR --artifacts DIR --result FILE [--command-args JSON] [--expected-version VERSION]\n");
  process.exitCode = 2;
} else {
  try {
    const scenario = parseScenario(JSON.parse(await readFile(resolve(scenarioPath), "utf8")));
    const resultTarget = resolve(resultPath);
    await mkdir(dirname(resultTarget), { recursive: true });
    const adapter = createSdkStdioAdapter({
      command: resolve(command),
      args: commandArgs === undefined ? [] : JSON.parse(commandArgs),
      cwd: process.cwd(),
      workspaceDirectory: resolve(workspaceDirectory),
      expectedVersion,
    });
    const result = await runScenario({ scenario, adapter, artifactDirectory: resolve(artifactDirectory) });
    await writeFile(resultTarget, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ scenarioId: result.scenarioId, status: result.status, failure: result.failure })}\n`);
    if (result.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    const failure = portableFailure(error, "harness", "SCENARIO_INVALID");
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 2;
  }
}
