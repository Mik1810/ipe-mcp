import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";

import { NativeIpeError } from "../../src/native/errors.js";
import { attestBubblewrap, runControlledProcess } from "../../src/native/process.js";
import { NATIVE_SUBPROCESS_COUNTS } from "../../src/native/process-accounting.js";
import { openStableArtifact } from "../../src/native/stable-artifact.js";

const limits = { timeoutMs: 2_000, maxOutputBytes: 1024, maxMemoryBytes: 2 * 1024 * 1024 * 1024, maxProcesses: 256, maxFileBytes: 1024 * 1024 };

describe("controlled native subprocess", () => {
  it("passes arguments literally without a shell", async () => {
    const marker = "value;$(touch should-not-exist)";
    const result = await runControlledProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", marker], process.cwd(), limits, "NATIVE_EXPORT_ERROR");
    expect(result.stdout).toBe(marker);
  });

  it("classifies timeouts and bounded output", async () => {
    await expect(runControlledProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd(), { ...limits, timeoutMs: 25 }, "NATIVE_RENDER_ERROR"))
      .rejects.toMatchObject({ code: "NATIVE_TIMEOUT" });
    await expect(runControlledProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], process.cwd(), { ...limits, maxOutputBytes: 64 }, "NATIVE_RENDER_ERROR"))
      .rejects.toMatchObject({ code: "NATIVE_OUTPUT_LIMIT" });
  });

  it.skipIf(process.platform !== "linux")("attests the fixed bubblewrap isolation executable", async () => {
    await expect(attestBubblewrap()).resolves.toBeUndefined();
  });

  it("centralizes exact operation subprocess boundaries", () => {
    expect(NATIVE_SUBPROCESS_COUNTS.capabilities).toBe(24);
    expect(NATIVE_SUBPROCESS_COUNTS.exportPdf(0)).toBe(5);
    expect(NATIVE_SUBPROCESS_COUNTS.exportPdf(2)).toBe(11);
    expect(NATIVE_SUBPROCESS_COUNTS.renderViews(0)).toBe(0);
    expect(NATIVE_SUBPROCESS_COUNTS.renderViews(2)).toBe(8);
    expect(NATIVE_SUBPROCESS_COUNTS.validateFull(0)).toBe(34);
    expect(NATIVE_SUBPROCESS_COUNTS.validateFull(2)).toBe(48);
  });

  it.skipIf(process.platform !== "linux")("kills surviving process-group descendants after parent success", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-descendant-"));
    try {
      const marker = join(root, "escaped");
      await expect(runControlledProcess("/bin/sh", ["-c", `(sleep 0.1; touch ${JSON.stringify(marker)}) >/dev/null 2>&1 & exit 0`], root, limits, "NATIVE_CRASH")).resolves.toBeDefined();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      await expect(import("node:fs/promises").then(({ access }) => access(marker))).rejects.toBeDefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "linux")("contains setsid descendants after success and timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-setsid-"));
    try {
      for (const mode of ["success", "timeout"] as const) {
        const marker = join(root, mode);
        const script = `(setsid sh -c 'sleep 0.1; touch ${marker}' >/dev/null 2>&1 &)${mode === "timeout" ? "; sleep 30" : "; exit 0"}`;
        const result = runControlledProcess("/bin/sh", ["-c", script], root, { ...limits, timeoutMs: mode === "timeout" ? 25 : 2_000 }, "NATIVE_CRASH");
        if (mode === "timeout") await expect(result).rejects.toMatchObject({ code: "NATIVE_TIMEOUT" }); else await expect(result).resolves.toBeDefined();
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        await expect(import("node:fs/promises").then(({ access }) => access(marker))).rejects.toBeDefined();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "linux")("keeps an immutable descriptor snapshot across pathname replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-snapshot-"));
    try {
      const artifact = join(root, "artifact.svg"); const external = join(root, "external.svg");
      await writeFile(artifact, "trusted"); await writeFile(external, "replaced");
      const stable = await openStableArtifact(artifact, root, 1024, () => 1_000);
      try {
        await unlink(artifact); await symlink(external, artifact);
        await expect(readFile(stable.path, "utf8")).resolves.toBe("trusted");
      } finally { await stable.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects SVG processing instructions including local and remote stylesheets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-svg-pi-"));
    try {
      const worker = resolve("scripts/conformance/m6-artifact-worker.mjs");
      const environment = { IPE_M6_ARTIFACT_LIMITS: JSON.stringify({ maxArtifactBytes: 1024 * 1024, maxWidth: 1024, maxHeight: 1024, maxPixels: 1024 * 1024, maxDecodedBytes: 4 * 1024 * 1024 }) };
      for (const [index, instruction] of ["<?xml-stylesheet href='file:///tmp/a.css'?>", "<?xml-stylesheet href='https://example.invalid/a.css'?>", "<?custom probe?>"].entries()) {
        const path = join(root, `pi-${index}.svg`);
        await writeFile(path, `<?xml version="1.0"?>${instruction}<svg width="10" height="10"><rect width="10" height="10"/></svg>`);
        await expect(runControlledProcess(process.execPath, [worker, "svg", path], root, limits, "NATIVE_RENDER_ERROR", environment)).rejects.toMatchObject({ code: "NATIVE_RENDER_ERROR" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "linux")("enforces inherited address-space and descendant-process limits", async () => {
    const allocation = "held=[]\ntry:\n while True: held.append(bytearray(32*1024*1024))\nexcept MemoryError: print('MEMORY_LIMIT',end='')";
    await expect(runControlledProcess("/usr/bin/python3", ["-c", allocation], process.cwd(), { ...limits, maxMemoryBytes: 256 * 1024 * 1024 }, "NATIVE_CRASH"))
      .resolves.toMatchObject({ stdout: "MEMORY_LIMIT" });
    const forks = "import os,signal,time\nchildren=[]\ntry:\n while True:\n  pid=os.fork()\n  if pid==0: time.sleep(30); os._exit(0)\n  children.append(pid)\nexcept OSError:\n for pid in children: os.kill(pid,signal.SIGKILL)\n for pid in children:\n  try: os.waitpid(pid,0)\n  except ChildProcessError: pass\n print('PROCESS_LIMIT',end='')";
    await expect(runControlledProcess("/usr/bin/python3", ["-c", forks], process.cwd(), { ...limits, timeoutMs: 10_000, maxProcesses: 128 }, "NATIVE_CRASH"))
      .resolves.toMatchObject({ stdout: "PROCESS_LIMIT" });
  }, 20_000);

  it("classifies crashes separately from ordinary export failures", async () => {
    await expect(runControlledProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], process.cwd(), limits, "NATIVE_EXPORT_ERROR"))
      .rejects.toMatchObject({ code: "NATIVE_CRASH" });
    try {
      await runControlledProcess(process.execPath, ["-e", "process.exit(7)"], process.cwd(), limits, "NATIVE_EXPORT_ERROR");
      throw new Error("expected process failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeIpeError);
      expect((error as NativeIpeError).code).toBe("NATIVE_EXPORT_ERROR");
    }
  });

  it("redacts paths and source fragments from bounded diagnostics", async () => {
    const secret = "/home/private/document.tex: \\secret{token}";
    try { await runControlledProcess(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(`IPE_M6_ERROR=latex\nIPE_M6_RESULT=/home/private/document.tex\n${secret}\n`)});process.exit(1)`], process.cwd(), limits, "NATIVE_TEX_ERROR"); }
    catch (error) {
      expect(error).toBeInstanceOf(NativeIpeError);
      expect((error as NativeIpeError).diagnostics).toEqual(["IPE_M6_ERROR=latex"]);
      expect(JSON.stringify(error)).not.toContain("private");
      expect(JSON.stringify(error)).not.toContain("secret");
    }
  });

  it("symmetrically detects one-pixel additions and omissions while tolerating antialias displacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-raster-"));
    try {
      const expected = new PNG({ width: 128, height: 128 }); expected.data.fill(255);
      const actual = new PNG({ width: 128, height: 128 }); actual.data.fill(255);
      for (let channel = 0; channel < 3; channel += 1) expected.data[(40 * 128 + 50) * 4 + channel] = 254;
      const left = join(root, "actual.png"); const right = join(root, "expected.png");
      await writeFile(left, PNG.sync.write(actual)); await writeFile(right, PNG.sync.write(expected));
      const worker = resolve("scripts/conformance/m6-artifact-worker.mjs");
      const environment = { IPE_M6_ARTIFACT_LIMITS: JSON.stringify({ maxArtifactBytes: 1024 * 1024, maxWidth: 1024, maxHeight: 1024, maxPixels: 1024 * 1024, maxDecodedBytes: 4 * 1024 * 1024 }) };
      await expect(runControlledProcess(process.execPath, [worker, "compare-png", left, right], root, limits, "NATIVE_EXPORT_ERROR", environment)).rejects.toMatchObject({ code: "NATIVE_EXPORT_ERROR" });
      await expect(runControlledProcess(process.execPath, [worker, "compare-png", right, left], root, limits, "NATIVE_EXPORT_ERROR", environment)).rejects.toMatchObject({ code: "NATIVE_EXPORT_ERROR" });
      for (let channel = 0; channel < 3; channel += 1) actual.data[(40 * 128 + 52) * 4 + channel] = 0;
      await writeFile(left, PNG.sync.write(actual));
      await expect(runControlledProcess(process.execPath, [worker, "compare-png", left, right], root, limits, "NATIVE_EXPORT_ERROR", environment)).resolves.toMatchObject({ stdout: expect.stringContaining("IPE_M6_RESULT=PASS") });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("includes pre-spawn accounting and hostile artifact work in tiny deadlines", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipe-mcp-m6-tiny-deadline-"));
    try {
      const hostile = join(root, "hostile.svg");
      await writeFile(hostile, `<svg width="10" height="10">${"<g>".repeat(10000)}<rect width="10" height="10"/>${"</g>".repeat(10000)}</svg>`);
      const worker = resolve("scripts/conformance/m6-artifact-worker.mjs");
      await expect(runControlledProcess(process.execPath, [worker, "svg", hostile], root, { ...limits, timeoutMs: 1 }, "NATIVE_RENDER_ERROR", { IPE_M6_ARTIFACT_LIMITS: JSON.stringify({ maxArtifactBytes: 1024 * 1024, maxWidth: 1024, maxHeight: 1024, maxPixels: 1024 * 1024, maxDecodedBytes: 4 * 1024 * 1024 }) })).rejects.toMatchObject({ code: "NATIVE_TIMEOUT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
