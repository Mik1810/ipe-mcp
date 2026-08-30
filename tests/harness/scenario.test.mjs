import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runScenario } from "../../scripts/harness/core.mjs";
import { assertPortableValue, HarnessFailure, portableFailure, redactPortableText } from "../../scripts/harness/privacy.mjs";
import { GLOBAL_LIMITS, parseResult, parseScenario } from "../../scripts/harness/schema.mjs";

const fixture = JSON.parse(await readFile(resolve("fixtures/conformance/m10/portable-create-edit-export.json"), "utf8"));

describe("provider-neutral scenario schema", () => {
  it("accepts the representative semantic scenario", () => {
    expect(parseScenario(fixture).id).toBe("portable-create-edit-export");
  });

  it("rejects unknown fields and limits above the global ceiling", () => {
    expect(() => parseScenario({ ...fixture, vendorPrompt: "private" })).toThrow();
    expect(() => parseScenario({ ...fixture, limits: { ...fixture.limits, maxSteps: GLOBAL_LIMITS.maxSteps + 1 } })).toThrow();
  });

  it("requires artifact assertions to match outputs and explicit granted approvals", () => {
    expect(() => parseScenario({ ...fixture, assertions: { ...fixture.assertions, artifacts: fixture.assertions.artifacts.slice(0, 2) } })).toThrow();
    expect(() => parseScenario({ ...fixture, approvals: fixture.approvals.map((approval) => ({ ...approval, decision: "deny" })) })).toThrow();
    expect(() => parseScenario({ ...fixture, assertions: { ...fixture.assertions, artifacts: fixture.assertions.artifacts.map((artifact) => artifact.kind === "pdf" ? { ...artifact, mediaType: "image/png" } : artifact) } })).toThrow();
    expect(() => parseScenario({ ...fixture, approvals: fixture.approvals.map((approval) => ({ ...approval, id: "duplicate" })) })).toThrow();
  });
});

describe("portable result privacy and failure taxonomy", () => {
  it("redacts POSIX, Windows, and credential-shaped diagnostics", () => {
    const redacted = redactPortableText("failed /home/alice/private/file.ipe C:\\Users\\Alice\\secret.ipe Bearer abc123 password=hunter2");
    expect(redacted).not.toContain("/home/alice");
    expect(redacted).not.toContain("C:\\Users");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("hunter2");
  });

  it("rejects portable bundles containing paths or private reasoning fields", () => {
    expect(() => assertPortableValue({ path: "/home/alice/private.ipe" })).toThrow(/forbidden/u);
    expect(() => assertPortableValue({ reasoning_content: "hidden" })).toThrow(/forbidden/u);
  });

  for (const stage of ["harness", "agent-planning", "protocol", "server", "native-ipe", "artifact-quality"]) {
    it(`retains the ${stage} failure stage without transcript internals`, async () => {
      const adapter = {
        identity: { name: "fixture-adapter", version: "1", transport: "fixture" },
        async execute() { throw new HarnessFailure(stage, "FIXTURE_FAILURE", "bounded public message"); },
      };
      const result = await runScenario({ scenario: parseScenario(fixture), adapter, artifactDirectory: resolve("/tmp/not-written") });
      expect(result.status).toBe("FAIL");
      expect(result.failure.stage).toBe(stage);
      expect(result.transcript).toEqual([]);
      expect(() => parseResult(result)).not.toThrow();
    });
  }

  it("maps unknown exceptions to a bounded harness failure", () => {
    const failure = portableFailure(new Error(`boom ${"x".repeat(800)}`));
    expect(failure.stage).toBe("harness");
    expect(failure.message.length).toBeLessThanOrEqual(400);
  });
});
