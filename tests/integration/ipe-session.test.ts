import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ipeDocumentCodec } from "../../src/core/ipe-document-codec.js";
import { DocumentSessionManager } from "../../src/persistence/session-manager.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("Ipe session integration", () => {
  it("keeps the original byte-identical until save and emits valid edited Ipe", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ipe-mcp-integration-"));
    cleanup.push(workspace);
    const sourcePath = join(workspace, "document.ipe");
    const original = await readFile(resolve("fixtures/conformance/minimal.ipe"), "utf8");
    await writeFile(sourcePath, original);
    const manager = await DocumentSessionManager.create(
      { workspaceRoots: [workspace], stateRoot: join(workspace, ".ipe-mcp-work") },
      ipeDocumentCodec,
    );
    const opened = await manager.open(sourcePath);
    const changed = await manager.mutate(opened.documentId, 0, (document) => {
      document.pages[0]!.title = "transactional edit";
      document.pages[0]!.marked = false;
      document.pages[0]!.layers[0]!.edit = true;
      document.pages[0]!.layers[0]!.snap = "always";
    });
    expect(await readFile(sourcePath, "utf8")).toBe(original);
    await manager.save(opened.documentId, changed.revision);
    const saved = await readFile(sourcePath, "utf8");
    expect(saved).not.toBe(original);
    expect(ipeDocumentCodec.parse(saved).pages[0]).toMatchObject({
      title: "transactional edit",
      marked: false,
      layers: [{ edit: true, snap: "always" }],
    });
  });
});
