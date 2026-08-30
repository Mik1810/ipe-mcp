import { assertPortableValue, HarnessFailure, portableFailure } from "./privacy.mjs";
import { parseResult } from "./schema.mjs";

const timeout = (milliseconds, abortController) => new Promise((_, reject) => {
  const timer = setTimeout(() => {
    abortController.abort();
    reject(new HarnessFailure("harness", "HARNESS_TIMEOUT", "Scenario exceeded its bounded execution time"));
  }, milliseconds);
  timer.unref?.();
});

export async function runScenario({ scenario, adapter, artifactDirectory }) {
  const abortController = new AbortController();
  let execution;
  try {
    execution = await Promise.race([
      adapter.execute({ scenario, artifactDirectory, signal: abortController.signal }),
      timeout(scenario.limits.timeoutMs, abortController),
    ]);
  } catch (error) {
    execution = {
      adapter: adapter.identity,
      approvals: scenario.approvals,
      transcript: [], diagnostics: [], mutationHistory: [], artifacts: [],
      assertions: { semantic: "NOT_RUN", visual: "NOT_RUN" },
      failure: portableFailure(error),
    };
  } finally {
    abortController.abort();
  }

  const result = {
    schemaVersion: 1,
    scenarioId: scenario.id,
    adapter: execution.adapter ?? adapter.identity,
    status: execution.failure === undefined ? "PASS" : "FAIL",
    ...(execution.contract === undefined ? {} : { contract: execution.contract }),
    ...(execution.productVersion === undefined ? {} : { productVersion: execution.productVersion }),
    ...(execution.capabilityMode === undefined ? {} : { capabilityMode: execution.capabilityMode }),
    limitsApplied: scenario.limits,
    approvals: execution.approvals ?? scenario.approvals,
    transcript: execution.transcript ?? [],
    diagnostics: execution.diagnostics ?? [],
    mutationHistory: execution.mutationHistory ?? [],
    artifacts: execution.artifacts ?? [],
    assertions: execution.assertions ?? { semantic: "NOT_RUN", visual: "NOT_RUN" },
    ...(execution.failure === undefined ? {} : { failure: execution.failure }),
  };
  const parsed = parseResult(result);
  assertPortableValue(parsed);
  return parsed;
}
