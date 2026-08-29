import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { failure, success } from "../../src/mcp/errors.js";
import { resultSchema } from "../../src/mcp/contracts.js";
import { MCP_LIMITS } from "../../src/limits.js";
import { IpeMcpService } from "../../src/mcp/service.js";
import { PINNED_SEEDS, XorShift32, fail, iterations } from "./rng.js";

const SEED = PINNED_SEEDS.protocol;
const CASES = iterations();

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function serviceFixture() {
  const root = await mkdtemp(join(tmpdir(), "ipe-mcp-property-")); roots.push(root);
  return { root, service: await IpeMcpService.create([root], join(root, ".state")) };
}

describe("property: public result contract", () => {
  it("produces schema-valid results for random success data", () => {
    const random = new XorShift32(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const result = success("probe", "summary that may contain secrets", {
        value: random.integer(-1000, 1000),
        nested: { a: [random.next(), null, true, "text"] },
        ...(random.next() < 0.3 ? { secret: `/tmp/data-${random.integer(0, 99)}` } : {}),
      });
      const parsed = resultSchema.safeParse(result);
      if (!parsed.success) fail(SEED, index, `result failed schema: ${JSON.stringify(parsed.error.issues[0])}`);
      expect(result.summary).not.toContain("/tmp");
      expect(JSON.stringify(result.data)).not.toContain(process.env.HOME ?? "/nonexistent");
    }
  });

  it("keeps random failures within the strict public envelope", () => {
    const random = new XorShift32(SEED);
    const errors: unknown[] = [
      new Error("no such object"),
      new Error("requested page/view does not exist"),
      new Error("timed out at /private/work/deck.ipe"),
      new Error("tried 1000 connections at 127.0.0.1"),
      { boom: true },
      "plain string failure",
      42,
      null,
      undefined,
    ];
    for (let index = 0; index < CASES; index += 1) {
      const result = failure("probe", errors[random.integer(0, errors.length - 1)]);
      const parsed = resultSchema.safeParse(result);
      if (!parsed.success) fail(SEED, index, `failure envelope invalid: ${JSON.stringify(parsed.error.issues[0])}`);
      expect(JSON.stringify(result)).not.toContain("/private/work");
      expect(result.hints.length).toBeLessThanOrEqual(MCP_LIMITS.maxHints);
    }
  });

  it("keeps summaries and diagnostics bounded and safe", () => {
    let output = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((value: string | Uint8Array) => { output += value.toString(); return true; }) as typeof process.stderr.write;
    const { safeLog } = { safeLog: async () => {} };
    process.stderr.write = original;
    const long = "x".repeat(10_000);
    const result = success("probe", long, { value: long });
    expect(result.summary.length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(result).length).toBeLessThan(1_000_000);
    void safeLog;
  });
});

describe("property: service transaction workflow", () => {
  it("keeps revision-guarded mutation sequences coherent between failures", async () => {
    const { service } = await serviceFixture();
    const created = await service.createDocument("standard");
    const page = (created.outline.pages as Array<{ id: string; layers: Array<{ id: string }> }>)[0]!;
    const random = new XorShift32(SEED);
    let revision = 0;
    const workflowCases = Math.min(CASES, 256);
    for (let index = 0; index < workflowCases; index += 1) {
      const operation = random.next() < 0.6
        ? { op: "add_rectangle", pageId: page.id, layerId: page.layers[0]!.id, x: random.between(-1000, 1000), y: random.between(-1000, 1000), width: random.between(1, 500), height: random.between(1, 500) } as const
        : random.next() < 0.5
          ? { op: "set_metadata", title: random.string(1, 60) } as const
          : { op: "add_layer", pageId: page.id, name: `` + `L-${String(index).padStart(8, "0")}` } as const;
      let next = 0;
      try {
        const applied = await service.apply(created.documentId, revision, [operation]);
        next = applied.revision;
      } catch (error) {
        const result = failure("apply_operations", error);
        const parsed = resultSchema.safeParse(result);
        if (!parsed.success) fail(SEED, index, "failure envelope invalid");
        next = revision;
      }
      const state = service.inspect(created.documentId);
      if (!resultSchema.safeParse({ contractVersion: "ipe-mcp/1", ok: true, kind: "inspect", summary: "ok", data: {}, hints: [] }).success) fail(SEED, index, "inspection state is unserializable");
      if (state.revision !== next) fail(SEED, index, `revision became ${state.revision} after case ${index}, expected ${next}`);
      revision = next;
    }
    const final = service.inspect(created.documentId);
    if (!Number.isSafeInteger(final.revision) || final.revision < 0 || final.revision > MCP_LIMITS.operationsPerBatch * (workflowCases + 1)) {
      fail(SEED, workflowCases, `impossible revision ${final.revision}`);
    }
  }, 30_000);

  it("never leaks workspace paths into public failures", async () => {
    const { root, service } = await serviceFixture();
    const created = await service.createDocument("standard");
    let caught: unknown;
    try {
      await service.apply(created.documentId, 1024, [{ op: "set_metadata", title: "stale" }]);
    } catch (error) { caught = error; }
    const result = failure("apply_operations", caught);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z]:[\\/]/u);
  });

  it("returns inspectable outline data that stays schema-shaped after many mutations", async () => {
    const { service } = await serviceFixture();
    const created = await service.createDocument("standard");
    const page = (created.outline.pages as Array<{ id: string; layers: Array<{ id: string }> }>)[0]!;
    const random = new XorShift32(SEED);
    let revision = 0;
    for (let index = 0; index < 64; index += 1) {
      const applied = await service.apply(created.documentId, revision, [
        { op: "add_rectangle", pageId: page.id, layerId: page.layers[0]!.id, x: random.between(-100, 100), y: random.between(-100, 100), width: 20, height: 10, stroke: "0" } as const,
      ]);
      revision = applied.revision;
      const inspected = service.inspect(created.documentId, 50);
      const outline = inspected.outline as { pages: unknown[]; objectCount: number; truncated: boolean };
      if (!Array.isArray(outline.pages) || outline.pages.length < 1 || typeof outline.objectCount !== "number") fail(SEED, index, "outline shape diverged");
      const data = z.record(z.string(), z.json()).safeParse({ outline: inspected.outline }).success;
      if (!data) fail(SEED, index, "outline data not JSON-serializable");
    }
  }, 30_000);
});
