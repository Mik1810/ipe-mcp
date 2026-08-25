import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

export class FileSizeLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`file exceeds byte limit (${maxBytes})`);
    this.name = "FileSizeLimitError";
  }
}

function assertLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive safe integer");
}

export async function readHandleBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  assertLimit(maxBytes);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new FileSizeLimitError(maxBytes);
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

export async function readFileBounded(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()) throw new Error(`not a regular file: ${path}`);
    if (metadata.size > BigInt(maxBytes)) throw new FileSizeLimitError(maxBytes);
    return await readHandleBounded(handle, maxBytes);
  } finally {
    await handle.close();
  }
}
