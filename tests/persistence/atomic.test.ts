import { readdir, readFile, writeFile, mkdtemp, rm, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AtomicWriteError, atomicWriteFile } from "../../src/persistence/atomic.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("atomicWriteFile", () => {
  it("keeps the original and removes the temporary file when rename is interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ipe-mcp-atomic-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "document.ipe");
    await writeFile(target, "original", "utf8");

    await expect(
      atomicWriteFile(target, "replacement", {
        hooks: {
          beforeRename: async () => {
            throw new Error("injected crash");
          },
        },
      }),
    ).rejects.toThrow("injected crash");

    await expect(readFile(target, "utf8")).resolves.toBe("original");
    await expect(readdir(directory)).resolves.toEqual(["document.ipe"]);
  });

  it("rejects a temporary path replaced by a hook and preserves the target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ipe-mcp-atomic-replace-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "document.ipe");
    await writeFile(target, "original");
    await expect(atomicWriteFile(target, "intended", { hooks: { beforeRename: async (temporary) => {
      await unlink(temporary);
      await writeFile(temporary, "replacement");
    } } })).rejects.toThrow("replaced or resized");
    await expect(readFile(target, "utf8")).resolves.toBe("original");
  });

  it("reports a committed outcome when confirmation fails after rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ipe-mcp-atomic-committed-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "document.ipe");
    await writeFile(target, "original");
    const result = atomicWriteFile(target, "replacement", { hooks: { afterRename: async () => {
      throw new Error("injected post-rename failure");
    } } });
    await expect(result).rejects.toMatchObject({ committed: true, result: expect.any(Object) });
    await expect(result).rejects.toBeInstanceOf(AtomicWriteError);
    await expect(readFile(target, "utf8")).resolves.toBe("replacement");
  });

  it("does not evict a live lock solely because its mtime is old", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ipe-mcp-atomic-lock-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "document.ipe");
    const lock = join(directory, ".document.ipe.ipe-mcp.lock");
    let release!: () => void;
    let entered!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const first = atomicWriteFile(target, "first", { precondition: async () => {
      const old = new Date(0);
      await utimes(lock, old, old);
      entered();
      await released;
    } });
    await firstEntered;
    let secondEntered = false;
    const second = atomicWriteFile(target, "second", { precondition: async () => { secondEntered = true; } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondEntered).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe("second");
    await expect(readdir(directory)).resolves.toEqual(["document.ipe"]);
  });
});
