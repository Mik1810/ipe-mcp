import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { PERSISTENCE_LIMITS } from "../limits.js";

export interface AtomicWriteHooks {
  readonly beforeRename?: (temporaryPath: string, targetPath: string) => Promise<void>;
  readonly afterRename?: (targetPath: string) => Promise<void>;
}

export interface AtomicWriteOptions {
  readonly mode?: number;
  readonly hooks?: AtomicWriteHooks;
  /** Last compare-and-swap check, run after test hooks and immediately before rename. */
  readonly precondition?: () => Promise<void>;
}

export interface AtomicWriteResult {
  readonly device: string;
  readonly inode: string;
}

/** Signals that rename completed even though durability confirmation failed. */
export class AtomicWriteError extends Error {
  readonly committed: boolean;
  readonly result: AtomicWriteResult | undefined;

  constructor(message: string, committed: boolean, result: AtomicWriteResult | undefined, cause: unknown) {
    super(message, { cause });
    this.name = "AtomicWriteError";
    this.committed = committed;
    this.result = result;
  }
}

const LOCK_WAIT_MS = PERSISTENCE_LIMITS.lockWaitMs;
const LOCK_TIMEOUT_MS = PERSISTENCE_LIMITS.lockTimeoutMs;

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

interface FileIdentity {
  readonly device: string;
  readonly inode: string;
}

function identityOf(metadata: { readonly dev: bigint; readonly ino: bigint }): FileIdentity {
  return { device: metadata.dev.toString(), inode: metadata.ino.toString() };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.device === b.device && a.inode === b.inode;
}

async function lockOwnerIsDead(lockPath: string, identity: FileIdentity): Promise<boolean> {
  const metadata = await lstat(lockPath, { bigint: true }).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile() || !sameIdentity(identityOf(metadata), identity) || metadata.size > 128n) return false;
  const handle = await open(lockPath, "r").catch(() => undefined);
  if (handle === undefined) return false;
  try {
    const source = Buffer.alloc(Number(metadata.size));
    await handle.read(source, 0, source.length, 0);
    const match = /^(\d+):/u.exec(source.toString("ascii"));
    if (match?.[1] === undefined) return false;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } finally {
    await handle.close();
  }
}

async function withTargetLock<Result>(targetPath: string, operation: () => Promise<Result>): Promise<Result> {
  const lockPath = join(dirname(targetPath), `.${basename(targetPath)}.ipe-mcp.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let lock;
  let lockIdentity: FileIdentity | undefined;
  for (;;) {
    try {
      const candidate = await open(lockPath, "wx", 0o600);
      try {
        await candidate.writeFile(`${process.pid}:${randomUUID()}\n`);
        await candidate.sync();
        lockIdentity = identityOf(await candidate.stat({ bigint: true }));
      } catch (error) {
        await candidate.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      lock = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = await lstat(lockPath, { bigint: true }).catch(() => undefined);
      const identity = metadata?.isFile() === true ? identityOf(metadata) : undefined;
      if (identity !== undefined && await lockOwnerIsDead(lockPath, identity)) {
        const current = await lstat(lockPath, { bigint: true }).catch(() => undefined);
        if (current !== undefined && sameIdentity(identityOf(current), identity)) await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring atomic write lock: ${targetPath}`);
      await delay(LOCK_WAIT_MS);
    }
  }
  try {
    return await operation();
  } finally {
    await lock.close();
    const current = await lstat(lockPath, { bigint: true }).catch(() => undefined);
    if (current !== undefined && lockIdentity !== undefined && sameIdentity(identityOf(current), lockIdentity)) {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

async function verifyTemporary(
  handle: FileHandle,
  temporaryPath: string,
  expected: Buffer,
  identity: FileIdentity,
): Promise<void> {
  const pathMetadata = await lstat(temporaryPath, { bigint: true });
  const handleMetadata = await handle.stat({ bigint: true });
  if (!sameIdentity(identityOf(pathMetadata), identity) || !sameIdentity(identityOf(handleMetadata), identity) || handleMetadata.size !== BigInt(expected.length)) {
    throw new Error("atomic temporary file was replaced or resized before rename");
  }
  const actual = Buffer.alloc(expected.length);
  let offset = 0;
  while (offset < actual.length) {
    const { bytesRead } = await handle.read(actual, offset, actual.length - offset, offset);
    if (bytesRead === 0) throw new Error("atomic temporary file was truncated before rename");
    offset += bytesRead;
  }
  if (!actual.equals(expected)) throw new Error("atomic temporary file content changed before rename");
}

export async function atomicWriteFile(
  targetPath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.ipe-mcp-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  const expected = Buffer.from(data);
  let identity: FileIdentity | undefined;
  let published = false;
  try {
    handle = await open(temporaryPath, "wx+", options.mode ?? 0o600);
    await handle.writeFile(expected);
    await handle.sync();
    identity = identityOf(await handle.stat({ bigint: true }));
    const verifiedHandle = handle;
    await options.hooks?.beforeRename?.(temporaryPath, targetPath);
    await withTargetLock(targetPath, async () => {
      if (identity === undefined) throw new Error("atomic write identity unavailable");
      await verifyTemporary(verifiedHandle, temporaryPath, expected, identity);
      await options.precondition?.();
      await verifiedHandle.close();
      handle = undefined;
      await rename(temporaryPath, targetPath);
      published = true;
      await options.hooks?.afterRename?.(targetPath);
      const committed = identityOf(await lstat(targetPath, { bigint: true }));
      if (!sameIdentity(committed, identity)) throw new Error("atomic rename did not publish the verified temporary file");
    });
    await handle?.close();
    handle = undefined;
    const directory = await open(dirname(targetPath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if (identity === undefined) throw new Error("atomic write identity unavailable");
    return identity;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (published) {
      throw new AtomicWriteError(
        `atomic write committed but durability confirmation failed: ${targetPath}`,
        true,
        identity,
        error,
      );
    }
    throw error;
  }
}
