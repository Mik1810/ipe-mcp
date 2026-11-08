import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { NATIVE_OPERATION_LIMITS } from "../limits.js";
import { atomicWriteFile } from "../persistence/atomic.js";
import { readHandleBounded } from "../persistence/bounded-read.js";

const entryLimits = {
  attachment: 32 * 1024,
  snapshot: NATIVE_OPERATION_LIMITS.maxDocumentSourceBytes,
  proposal: NATIVE_OPERATION_LIMITS.maxDocumentSourceBytes,
  receipt: 32 * 1024,
} as const;

export interface BridgeEntryKey {
  readonly epoch: string;
  readonly sequence: number;
  readonly kind: keyof typeof entryLimits;
}

interface Entry {
  readonly bytes: Buffer;
  readonly sha256: string;
}

class EntryAlreadyExists extends Error {}

function inside(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(".." + sep);
}

function sameInode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function privateOwner(info: BigIntStats): boolean {
  return info.uid === BigInt(process.getuid!()) && (info.mode & 0o077n) === 0n;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function entryName({ epoch, sequence, kind }: BridgeEntryKey): string {
  if (!/^[a-f0-9]{32}$/u.test(epoch) || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0x7fff_ffff
    || !Object.hasOwn(entryLimits, kind)) throw new Error("Invalid bridge entry key");
  return [epoch, sequence, kind].join("-") + (kind === "proposal" || kind === "snapshot" ? ".ipe" : ".json");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readEntry(path: string, limit: number): Promise<Entry | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw new Error("Bridge entry cannot be opened");
  });
  if (handle === undefined) return undefined;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !privateOwner(before) || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit)) {
      throw new Error("Bridge entry is not a bounded private file");
    }
    const bytes = await readHandleBounded(handle, limit);
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (!sameInode(before, named) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.ctimeNs !== named.ctimeNs || BigInt(bytes.length) !== before.size) {
      throw new Error("Bridge entry changed while being read");
    }
    return { bytes, sha256: digest(bytes) };
  } finally {
    await handle.close();
  }
}

/** Immutable transport records. An entry alone confers no approval or pairing. */
export class BridgeSpool {
  readonly #root: string;
  readonly #identity: BigIntStats;

  private constructor(root: string, identity: BigIntStats) {
    this.#root = root;
    this.#identity = identity;
  }

  static async open(directory: string, workspaceRoots: readonly string[]): Promise<BridgeSpool> {
    if (process.platform !== "linux") throw new Error("Bridge spool requires the Linux filesystem profile");
    const root = resolve(directory);
    const roots = await Promise.all(workspaceRoots.map((workspace) => realpath(workspace)));
    if (await realpath(root) !== root || roots.some((workspace) => inside(workspace, root) || inside(root, workspace))) {
      throw new Error("Bridge spool must be separate from all served workspaces");
    }
    const identity = await lstat(root, { bigint: true });
    if (!identity.isDirectory() || !privateOwner(identity)) throw new Error("Bridge spool directory is not private");
    return new BridgeSpool(root, identity);
  }

  async read(key: BridgeEntryKey): Promise<Entry | undefined> {
    const name = entryName(key);
    return await this.#withDirectory((directory) => readEntry(join(directory, name), entryLimits[key.kind]));
  }

  async publish(key: BridgeEntryKey, data: Uint8Array): Promise<string> {
    const name = entryName(key);
    const limit = entryLimits[key.kind];
    if (data.byteLength === 0 || data.byteLength > limit) throw new Error("Bridge entry size exceeds its bounds");
    const bytes = Buffer.from(data);
    await this.#withDirectory(async (directory) => {
      const path = join(directory, name);
      try {
        await atomicWriteFile(path, bytes, {
          precondition: async () => {
            await this.#verifyRoot();
            const current = await lstat(path).catch((error: unknown) => {
              if (missing(error)) return undefined;
              throw error;
            });
            if (current !== undefined) throw new EntryAlreadyExists();
          },
        });
      } catch (error) {
        if (!(error instanceof EntryAlreadyExists)) throw error;
        const existing = await readEntry(path, limit);
        if (existing === undefined || !bytes.equals(existing.bytes)) throw new Error("Bridge entry already exists with different content");
      }
    });
    return digest(bytes);
  }

  async #verifyRoot(): Promise<void> {
    const named = await lstat(this.#root, { bigint: true });
    if (!named.isDirectory() || !sameInode(named, this.#identity) || !privateOwner(named)) throw new Error("Bridge spool directory changed");
  }

  async #withDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
    const handle = await open(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const current = await handle.stat({ bigint: true });
      if (!sameInode(current, this.#identity) || !privateOwner(current)) throw new Error("Bridge spool directory changed");
      const result = await operation("/proc/self/fd/" + String(handle.fd));
      await this.#verifyRoot();
      return result;
    } finally {
      await handle.close();
    }
  }
}
