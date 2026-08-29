import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkDocumentShapeLimits, DOCUMENT_SHAPE_LIMITS, LimitsExceededError } from "../../src/limits.js";
import { DocumentSessionManager } from "../../src/persistence/session-manager.js";
import type { IpeDocument } from "../../src/core/ipe-document-codec.js";

let workspace: string;
let source: string;
let stateRoot: string;
const temporaryDirectories: string[] = [];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "ipe-mcp-limit-session-"));
  temporaryDirectories.push(workspace);
  source = join(workspace, "source.ipe");
  stateRoot = join(workspace, ".ipe-mcp-work");
  const minimal = `<ipe version="70218"><page><layer name="content"/><view layers="content" active="content" marked="no"/></page></ipe>`;
  await mkdir(workspace, { recursive: true });
  await writeFile(source, minimal, "utf8");
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("session mutation guard", () => {
  it("rolls back the mutation and keeps the revision when the shape guard throws", async () => {
    const { ipeDocumentCodec } = await import("../../src/core/ipe-document-codec.js");
    const sessions = await DocumentSessionManager.create<IpeDocument>(
      { workspaceRoots: [workspace], stateRoot, mutationGuard: (document) => checkDocumentShapeLimits(document as IpeDocument) },
      ipeDocumentCodec,
    );
    const opened = await sessions.open(source);
    let caught: unknown;
    try {
      await sessions.mutate(opened.documentId, 0, (draft) => {
        for (let index = 0; index < DOCUMENT_SHAPE_LIMITS.maxPages + 1; index += 1) {
          draft.pages.push({ ...draft.pages[0]!, id: `page-extra-${index}` });
        }
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(LimitsExceededError);
    expect((caught as LimitsExceededError).dimension).toBe("pages");
    const current = sessions.inspect(opened.documentId);
    expect(current.revision).toBe(0);
    expect(current.document.pages.length).toBe(1);
  });
});
