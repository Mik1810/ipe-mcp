import { isDeepStrictEqual } from "node:util";

const capabilityCodes = new Set(["ADAPTER_CAPABILITY_UNMET", "CAPABILITY_REQUIREMENT_UNMET"]);

export function crossHostOutcome(sdk, codex) {
  const hosts = [sdk, codex].map((result, index) => {
    const host = index === 0 ? "official-sdk-stdio" : "codex-app-server";
    if (result === undefined) return { host, status: "SKIP", code: "HOST_UNAVAILABLE" };
    if (result.status === "PASS") {
      return result.assertions.semantic === "PASS" && result.assertions.visual === "PASS"
        ? { host, status: "PASS" }
        : { host, status: "FAIL", code: "ASSERTION_EVIDENCE_MISSING" };
    }
    const unsupported = capabilityCodes.has(result.failure.code) && result.mutationHistory.length === 0;
    return { host, status: unsupported ? "SKIP" : "FAIL", code: result.failure.code };
  });
  if (hosts.some(({ status }) => status === "FAIL")) return { status: "FAIL", hosts, differences: [] };
  if (hosts.some(({ status }) => status === "SKIP")) return { status: "SKIP", hosts, differences: [] };

  const differences = [];
  const compare = (code, left, right) => {
    if (!isDeepStrictEqual(left, right)) differences.push(code);
  };
  const evidence = (result) => result.artifacts
    .map(({ kind, mediaType, observations }) => ({ kind, mediaType, observations }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  const mutations = (result) => result.mutationHistory
    .map(({ action, outcome, beforeRevision, afterRevision }) => ({ action, outcome, delta: afterRevision - beforeRevision }))
    .sort((a, b) => a.action.localeCompare(b.action));
  compare("SCENARIO_MISMATCH", sdk.scenarioId, codex.scenarioId);
  compare("CONTRACT_MISMATCH", sdk.contract, codex.contract);
  compare("CAPABILITY_MODE_MISMATCH", sdk.capabilityMode, codex.capabilityMode);
  compare("ASSERTIONS_MISMATCH", sdk.assertions, codex.assertions);
  compare("ARTIFACT_OBSERVATIONS_MISMATCH", evidence(sdk), evidence(codex));
  compare("MUTATION_EVIDENCE_MISMATCH", mutations(sdk), mutations(codex));
  return { status: differences.length === 0 ? "PASS" : "FAIL", hosts, differences };
}
