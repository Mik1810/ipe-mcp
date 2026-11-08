import { chmod, link, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BridgeSpool } from "../../src/bridge/spool.js";

describe.skipIf(process.platform !== "linux")("private bridge spool", () => {
  let root: string;
  let directory: string;
  let workspace: string;
  const key = { epoch: "a".repeat(32), sequence: 1, kind: "receipt" } as const;
  const pathFor = (sequence: number) => join(directory, key.epoch + "-" + String(sequence) + "-receipt.json");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ipe-bridge-spool-"));
    directory = join(root, "spool");
    workspace = join(root, "workspace");
    await mkdir(directory, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("keeps receipts immutable and idempotent through duplicate delivery and reopen", async () => {
    const first = await BridgeSpool.open(directory, [workspace]);
    const bytes = Buffer.from('{"accepted":true}');
    const [a, b] = await Promise.all([first.publish(key, bytes), first.publish(key, bytes)]);
    expect(a).toEqual(b);
    const recorded = await stat(pathFor(1));
    const next = await BridgeSpool.open(directory, [workspace]);
    expect(await next.read(key)).toEqual({ bytes, sha256: a });
    await expect(next.publish(key, Buffer.from('{"accepted":false}'))).rejects.toThrow(/different content/u);
    expect((await stat(pathFor(1))).ino).toBe(recorded.ino);
  });

  it("rejects overlapping, public, aliased and replaced directories", async () => {
    await expect(BridgeSpool.open(root, [workspace])).rejects.toThrow(/separate/u);
    await expect(BridgeSpool.open(workspace, [workspace])).rejects.toThrow(/separate/u);
    const alias = join(root, "alias");
    await symlink(directory, alias);
    await expect(BridgeSpool.open(alias, [workspace])).rejects.toThrow(/separate/u);
    await chmod(directory, 0o755);
    await expect(BridgeSpool.open(directory, [workspace])).rejects.toThrow(/not private/u);
    await chmod(directory, 0o700);
    const spool = await BridgeSpool.open(directory, [workspace]);
    await rename(directory, join(root, "displaced"));
    await mkdir(directory, { mode: 0o700 });
    await expect(spool.read(key)).rejects.toThrow(/directory changed/u);
  });

  it("rejects malformed keys, symlinks, hardlinks and oversized records", async () => {
    const spool = await BridgeSpool.open(directory, [workspace]);
    await expect(spool.read({ ...key, epoch: "../forbidden" })).rejects.toThrow(/entry key/u);
    const external = join(workspace, "canary");
    await writeFile(external, "unchanged", { mode: 0o600 });
    await symlink(external, pathFor(1));
    await expect(spool.read(key)).rejects.toThrow(/cannot be opened/u);
    await expect(spool.publish(key, Buffer.from("mutation"))).rejects.toThrow(/cannot be opened/u);
    await link(external, pathFor(2));
    await expect(spool.read({ ...key, sequence: 2 })).rejects.toThrow(/bounded private file/u);
    await expect(spool.publish({ ...key, sequence: 3 }, Buffer.alloc(32 * 1024 + 1))).rejects.toThrow(/size/u);
    await writeFile(pathFor(3), Buffer.alloc(32 * 1024 + 1), { mode: 0o600 });
    await expect(spool.read({ ...key, sequence: 3 })).rejects.toThrow(/bounded private file/u);
    expect(await spool.read({ ...key, sequence: 4 })).toBeUndefined();
  });
});
