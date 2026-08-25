import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  migrateSidecar,
  readSidecar,
  writeSidecar,
  type SidecarV1,
} from "../../src/persistence/sidecar.js";
import { FileSizeLimitError } from "../../src/persistence/bounded-read.js";

const temporaryDirectories: string[] = [];
const sourceHash = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("sidecar migrations", () => {
  it("migrates v0 metadata to the versioned v1 shape", () => {
    expect(
      migrateSidecar({
        version: 0,
        documentId: "doc-1",
        sourceHash,
        metadata: { "object-1": { role: "title" } },
      }),
    ).toEqual({
      schemaVersion: 1,
      documentId: "doc-1",
      sourceHash,
      revision: 0,
      objectMetadata: { "object-1": { role: "title" } },
      layoutConstraints: {},
    });
  });

  it("writes and reads a canonical v1 sidecar atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ipe-mcp-sidecar-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "document.ipe-mcp.json");
    const sidecar: SidecarV1 = {
      schemaVersion: 1,
      documentId: "doc-1",
      sourceHash,
      revision: 3,
      objectMetadata: { "object-1": { role: "title" } },
      layoutConstraints: {},
    };
    await writeSidecar(path, sidecar);
    await expect(readSidecar(path)).resolves.toEqual(sidecar);
    await expect(readFile(path, "utf8")).resolves.toMatch(/\n$/u);
  });

  it("rejects unknown fields and non-finite data", () => {
    expect(() =>
      migrateSidecar({
        schemaVersion: 1,
        documentId: "doc-1",
        sourceHash,
        revision: 0,
        objectMetadata: { bad: Number.POSITIVE_INFINITY },
        layoutConstraints: {},
        unexpected: true,
      }),
    ).toThrow();
  });

  it("bounds sidecar reads using the opened file handle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ipe-mcp-sidecar-limit-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "oversized.json");
    await writeFile(path, Buffer.alloc(2048, 0x20));
    await expect(readSidecar(path, 1024)).rejects.toBeInstanceOf(FileSizeLimitError);
  });
});
