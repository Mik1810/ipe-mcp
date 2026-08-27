import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, realpath, rm, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export interface StableArtifact {
  readonly path: string;
  readonly size: number;
  read(remaining: () => number): Promise<Buffer>;
  close(): Promise<void>;
}

class HeldStableArtifact implements StableArtifact {
  readonly path: string;
  readonly size: number;
  readonly #handle: FileHandle;
  readonly #directory: string;
  constructor(path: string, size: number, handle: FileHandle, directory: string) { this.path = path; this.size = size; this.#handle = handle; this.#directory = directory; }
  async read(remaining: () => number): Promise<Buffer> {
    const data = Buffer.allocUnsafe(this.size);
    let offset = 0;
    while (offset < data.length) {
      remaining();
      const { bytesRead } = await this.#handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) throw new Error("artifact snapshot ended during read");
      offset += bytesRead;
    }
    remaining();
    return data;
  }
  async close(): Promise<void> { await this.#handle.close(); await rm(this.#directory, { recursive: true, force: true }); }
}

export async function openStableArtifact(path: string, workspace: string, maximum: number, remaining: () => number): Promise<StableArtifact> {
  remaining();
  const target = resolve(path);
  const lexical = relative(workspace, target);
  if (lexical === "" || lexical.startsWith("..") || resolve(dirname(target)) !== resolve(workspace)) throw new Error("artifact escaped workspace");
  let source: FileHandle | undefined;
  let snapshot: FileHandle | undefined;
  let snapshotPath: string | undefined;
  let snapshotDirectory: string | undefined;
  try {
    source = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const descriptorPath = await realpath(`/proc/self/fd/${source.fd}`);
    const metadata = await source.stat({ bigint: true });
    remaining();
    if (relative(workspace, descriptorPath).startsWith("..") || !metadata.isFile() || metadata.size < 1n || metadata.size > BigInt(maximum)) throw new Error("artifact has an invalid size or type");
    snapshotDirectory = await mkdtemp("/tmp/ipe-mcp-artifact-");
    snapshotPath = join(snapshotDirectory, `.snapshot-${randomBytes(12).toString("hex")}`);
    snapshot = await open(snapshotPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o400);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Number(metadata.size)));
    let offset = 0;
    while (offset < Number(metadata.size)) {
      remaining();
      const length = Math.min(buffer.length, Number(metadata.size) - offset);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead === 0) throw new Error("artifact changed during snapshot");
      let written = 0;
      while (written < bytesRead) written += (await snapshot.write(buffer, written, bytesRead - written, offset + written)).bytesWritten;
      offset += bytesRead;
    }
    const after = await source.stat({ bigint: true });
    if (after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size || after.mtimeNs !== metadata.mtimeNs || after.ctimeNs !== metadata.ctimeNs) throw new Error("artifact changed during snapshot");
    await snapshot.sync();
    await chmod(snapshotPath, 0o400);
    await source.close(); source = undefined;
    const held = snapshot; snapshot = undefined;
    const heldDirectory = snapshotDirectory; snapshotDirectory = undefined;
    return new HeldStableArtifact(snapshotPath, Number(metadata.size), held, heldDirectory);
  } catch (error) {
    await source?.close();
    await snapshot?.close();
    if (snapshotPath !== undefined) await unlink(snapshotPath).catch(() => undefined);
    if (snapshotDirectory !== undefined) await rm(snapshotDirectory, { recursive: true, force: true });
    throw error;
  }
}
