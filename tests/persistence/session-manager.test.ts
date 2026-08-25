import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PathOutsideWorkspaceError,
  RevisionConflictError,
  SourceChangedError,
  StructuralValidationError,
  type SessionDiagnostic,
} from "../../src/persistence/errors.js";
import { FileSizeLimitError } from "../../src/persistence/bounded-read.js";
import {
  DocumentSessionManager,
  type DocumentCodec,
} from "../../src/persistence/session-manager.js";
import { AtomicWriteError } from "../../src/persistence/atomic.js";

interface TestDocument {
  value: string;
  valid: boolean;
}

const codec: DocumentCodec<TestDocument> = {
  parse(source) {
    const text = typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true }).decode(source);
    return JSON.parse(text) as TestDocument;
  },
  serialize(document) {
    return JSON.stringify(document);
  },
  validate(document): readonly SessionDiagnostic[] {
    return document.valid
      ? []
      : [{ severity: "error", code: "INVALID", path: "valid", message: "invalid draft" }];
  },
};

let workspace: string;
let source: string;
let stateRoot: string;
const temporaryDirectories: string[] = [];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "ipe-mcp-session-"));
  temporaryDirectories.push(workspace);
  source = join(workspace, "source.ipe");
  stateRoot = join(workspace, ".ipe-mcp-work");
  await writeFile(source, JSON.stringify({ value: "original", valid: true }), "utf8");
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function manager(
  beforeRename?: (temporaryPath: string, targetPath: string) => Promise<void>,
): Promise<DocumentSessionManager<TestDocument>> {
  return DocumentSessionManager.create(
    {
      workspaceRoots: [workspace],
      stateRoot,
      ...(beforeRename === undefined ? {} : { atomicWriteHooks: { beforeRename } }),
    },
    codec,
  );
}

describe("DocumentSessionManager", () => {
  it("mutates only the working copy until an explicit save", async () => {
    const sessions = await manager();
    const opened = await sessions.open(source);
    const mutated = await sessions.mutate(opened.documentId, 0, (draft) => {
      draft.value = "changed";
    });

    expect(mutated.revision).toBe(1);
    expect(sessions.inspect(opened.documentId).document.value).toBe("changed");
    expect(JSON.parse(await readFile(source, "utf8"))).toEqual({ value: "original", valid: true });

    const saved = await sessions.save(opened.documentId, 1);
    expect(JSON.parse(await readFile(source, "utf8"))).toEqual({ value: "changed", valid: true });
    expect(saved.snapshotPath).toBeDefined();
    await expect(readFile(saved.snapshotPath!, "utf8")).resolves.toContain("original");
  });

  it("rejects stale and concurrent revisions without partial mutations", async () => {
    const sessions = await manager();
    const opened = await sessions.open(source);
    const results = await Promise.allSettled([
      sessions.mutate(opened.documentId, 0, (draft) => {
        draft.value = "first";
      }),
      sessions.mutate(opened.documentId, 0, (draft) => {
        draft.value = "second";
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({ reason: expect.any(RevisionConflictError) });
    expect(sessions.inspect(opened.documentId).revision).toBe(1);
  });

  it("rolls back a structurally invalid batch", async () => {
    const sessions = await manager();
    const opened = await sessions.open(source);
    await expect(
      sessions.mutate(opened.documentId, 0, (draft) => {
        draft.value = "partial";
        draft.valid = false;
      }),
    ).rejects.toBeInstanceOf(StructuralValidationError);
    expect(sessions.inspect(opened.documentId)).toMatchObject({
      revision: 0,
      document: { value: "original", valid: true },
    });
  });

  it("detects an external source change before save", async () => {
    const sessions = await manager();
    const opened = await sessions.open(source);
    await sessions.mutate(opened.documentId, 0, (draft) => {
      draft.value = "session";
    });
    await writeFile(source, JSON.stringify({ value: "external", valid: true }), "utf8");
    await expect(sessions.save(opened.documentId, 1)).rejects.toBeInstanceOf(SourceChangedError);
    await expect(readFile(source, "utf8")).resolves.toContain("external");
  });

  it("treats source deletion as an external change instead of recreating it", async () => {
    const sessions = await manager();
    const opened = await sessions.open(source);
    await unlink(source);
    await expect(sessions.save(opened.documentId, 0)).rejects.toBeInstanceOf(SourceChangedError);
    await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects a source replacement in the final pre-rename window", async () => {
    let armed = false;
    let raced = false;
    const sessions = await manager(async (_temporary, target) => {
      if (armed && !raced && target === source) {
        raced = true;
        await writeFile(source, JSON.stringify({ value: "racing writer", valid: true }));
      }
    });
    const opened = await sessions.open(source);
    await sessions.mutate(opened.documentId, 0, (draft) => { draft.value = "session"; });
    armed = true;
    await expect(sessions.save(opened.documentId, 1)).rejects.toBeInstanceOf(SourceChangedError);
    await expect(readFile(source, "utf8")).resolves.toContain("racing writer");
  });

  it("serializes compare-and-rename across independent managers", async () => {
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const hook = async (_temporary: string, target: string): Promise<void> => {
      if (target !== source) return;
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
    };
    const first = await manager(hook);
    const second = await manager(hook);
    const a = await first.open(source);
    const b = await second.open(source);
    await first.mutate(a.documentId, 0, (draft) => { draft.value = "first manager"; });
    await second.mutate(b.documentId, 0, (draft) => { draft.value = "second manager"; });
    const saves = await Promise.allSettled([
      first.save(a.documentId, 1),
      second.save(b.documentId, 1),
    ]);
    expect(saves.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(saves.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.any(SourceChangedError) });
  });

  it("preserves the source when atomic save fails before rename", async () => {
    let armed = false;
    const sessions = await manager(async (_temporary, target) => {
      if (armed && target === source) throw new Error("save crash");
    });
    const opened = await sessions.open(source);
    await sessions.mutate(opened.documentId, 0, (draft) => {
      draft.value = "session";
    });
    armed = true;
    await expect(sessions.save(opened.documentId, 1)).rejects.toThrow("save crash");
    await expect(readFile(source, "utf8")).resolves.toContain("original");
    expect(sessions.inspect(opened.documentId).revision).toBe(1);
  });

  it("rejects source and target paths outside workspace roots", async () => {
    const sessions = await manager();
    const outside = await mkdtemp(join(tmpdir(), "ipe-mcp-outside-"));
    temporaryDirectories.push(outside);
    const outsideSource = join(outside, "outside.ipe");
    await writeFile(outsideSource, JSON.stringify({ value: "outside", valid: true }), "utf8");
    await expect(sessions.open(outsideSource)).rejects.toBeInstanceOf(PathOutsideWorkspaceError);

    const opened = await sessions.open(source);
    await expect(sessions.save(opened.documentId, 0, join(outside, "new.ipe"))).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
  });

  it("does not follow a save-target symlink outside the workspace", async () => {
    const sessions = await manager();
    const opened = await sessions.open(source);
    const outside = await mkdtemp(join(tmpdir(), "ipe-mcp-target-outside-"));
    temporaryDirectories.push(outside);
    const external = join(outside, "external.ipe");
    await writeFile(external, "external");
    const target = join(workspace, "redirect.ipe");
    await symlink(external, target);
    await expect(sessions.save(opened.documentId, 0, target)).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
    await expect(readFile(external, "utf8")).resolves.toBe("external");
  });

  it("rejects a target symlink inserted after allowlist resolution", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ipe-mcp-race-outside-"));
    temporaryDirectories.push(outside);
    const external = join(outside, "external.ipe");
    await writeFile(external, "external");
    const target = join(workspace, "raced.ipe");
    let armed = false;
    let inserted = false;
    const sessions = await manager(async (_temporary, candidate) => {
      if (armed && !inserted && candidate === target) {
        inserted = true;
        await symlink(external, target);
      }
    });
    const opened = await sessions.open(source);
    armed = true;
    await expect(sessions.save(opened.documentId, 0, target)).rejects.toMatchObject({ code: "ELOOP" });
    await expect(readFile(external, "utf8")).resolves.toBe("external");
  });

  it("rejects a symlinked state root that escapes the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ipe-mcp-state-outside-"));
    temporaryDirectories.push(outside);
    const link = join(workspace, "state-link");
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, link, "dir");
    await expect(
      DocumentSessionManager.create({ workspaceRoots: [workspace], stateRoot: link }, codec),
    ).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  it("can save a new file only inside an existing allowed directory", async () => {
    const sessions = await manager();
    const opened = await sessions.open(source);
    const outputDirectory = join(workspace, "output");
    await mkdir(outputDirectory);
    const target = join(outputDirectory, "copy.ipe");
    await sessions.save(opened.documentId, 0, target);
    await expect(readFile(target, "utf8")).resolves.toContain("original");
  });

  it("recovers durable working revisions after a manager restart", async () => {
    const first = await manager();
    const opened = await first.open(source);
    await first.mutate(opened.documentId, 0, (draft) => { draft.value = "unsaved recovery"; });

    const restarted = await manager();
    const recovered = await restarted.recover();
    expect(recovered).toEqual([expect.objectContaining({ documentId: opened.documentId, revision: 1 })]);
    expect(restarted.inspect(opened.documentId).document.value).toBe("unsaved recovery");
    await expect(readFile(source, "utf8")).resolves.toContain("original");
  });

  it("advances in-memory state when a committed manifest has uncertain durability", async () => {
    let armed = false;
    const first = await DocumentSessionManager.create(
      {
        workspaceRoots: [workspace],
        stateRoot,
        atomicWriteHooks: {
          afterRename: async (target) => {
            if (armed && target.endsWith("session.json")) throw new Error("manifest confirmation crash");
          },
        },
      },
      codec,
    );
    const opened = await first.open(source);
    armed = true;
    await expect(first.mutate(opened.documentId, 0, (draft) => {
      draft.value = "published revision";
    })).rejects.toBeInstanceOf(AtomicWriteError);
    expect(first.inspect(opened.documentId)).toMatchObject({
      revision: 1,
      document: { value: "published revision", valid: true },
    });

    const restarted = await manager();
    await expect(restarted.recover()).resolves.toEqual([
      expect.objectContaining({ revision: 1, document: { value: "published revision", valid: true } }),
    ]);
  });

  it("advances restored state when its committed manifest has uncertain durability", async () => {
    let armed = false;
    const first = await DocumentSessionManager.create(
      {
        workspaceRoots: [workspace],
        stateRoot,
        atomicWriteHooks: {
          afterRename: async (target) => {
            if (armed && target.endsWith("session.json")) throw new Error("restore manifest confirmation crash");
          },
        },
      },
      codec,
    );
    const opened = await first.open(source);
    await first.mutate(opened.documentId, 0, (draft) => { draft.value = "saved"; });
    await first.save(opened.documentId, 1);
    await first.mutate(opened.documentId, 1, (draft) => { draft.value = "later"; });
    armed = true;
    await expect(first.restoreSnapshot(opened.documentId, 2)).rejects.toBeInstanceOf(AtomicWriteError);
    expect(first.inspect(opened.documentId)).toMatchObject({
      revision: 3,
      document: { value: "original", valid: true },
    });

    const restarted = await manager();
    await expect(restarted.recover()).resolves.toEqual([
      expect.objectContaining({ revision: 3, document: { value: "original", valid: true } }),
    ]);
  });

  it("journals a committed save when manifest publication fails and reconciles on restart", async () => {
    let failManifest = false;
    const first = await manager(async (_temporary, target) => {
      if (failManifest && target.endsWith("session.json")) throw new Error("manifest crash");
    });
    const opened = await first.open(source);
    await first.mutate(opened.documentId, 0, (draft) => { draft.value = "committed"; });
    failManifest = true;
    await expect(first.save(opened.documentId, 1)).resolves.toMatchObject({ revision: 1 });
    await expect(readFile(source, "utf8")).resolves.toContain("committed");

    const restarted = await manager();
    await restarted.recover();
    expect(restarted.inspect(opened.documentId)).toMatchObject({ revision: 1, document: { value: "committed" } });
    await expect(restarted.save(opened.documentId, 1)).resolves.toMatchObject({ revision: 1 });
  });

  it("keeps recovery evidence when confirmation fails after the source rename", async () => {
    let armed = false;
    const first = await DocumentSessionManager.create(
      {
        workspaceRoots: [workspace],
        stateRoot,
        atomicWriteHooks: {
          afterRename: async (target) => {
            if (armed && target === source) throw new Error("post-rename confirmation crash");
          },
        },
      },
      codec,
    );
    const opened = await first.open(source);
    await first.mutate(opened.documentId, 0, (draft) => { draft.value = "committed uncertain"; });
    armed = true;
    await expect(first.save(opened.documentId, 1)).rejects.toBeInstanceOf(AtomicWriteError);
    await expect(readFile(source, "utf8")).resolves.toContain("committed uncertain");
    expect((await readdir(join(stateRoot, opened.documentId))).filter((name) => name.startsWith("save-journal-"))).toHaveLength(1);

    const restarted = await manager();
    await expect(restarted.recover()).resolves.toEqual([
      expect.objectContaining({ documentId: opened.documentId, revision: 1 }),
    ]);
    await expect(restarted.save(opened.documentId, 1)).resolves.toMatchObject({ revision: 1 });
  });

  it("discards an older journal once a newer manifest and save supersede it", async () => {
    let failManifest = false;
    const first = await manager(async (_temporary, target) => {
      if (failManifest && target.endsWith("session.json")) throw new Error("manifest crash");
    });
    const opened = await first.open(source);
    await first.mutate(opened.documentId, 0, (draft) => { draft.value = "v1"; });
    failManifest = true;
    await first.save(opened.documentId, 1);
    failManifest = false;
    await first.mutate(opened.documentId, 1, (draft) => { draft.value = "v2"; });
    await first.save(opened.documentId, 2);

    const restarted = await manager();
    await expect(restarted.recover()).resolves.toEqual([
      expect.objectContaining({ documentId: opened.documentId, revision: 2, document: { value: "v2", valid: true } }),
    ]);
  });

  it("orders multiple pending journals using the source state recorded by the manifest", async () => {
    let failManifest = false;
    const first = await manager(async (_temporary, target) => {
      if (failManifest && target.endsWith("session.json")) throw new Error("manifest crash");
    });
    const opened = await first.open(source);
    await first.mutate(opened.documentId, 0, (draft) => { draft.value = "v1"; });
    failManifest = true;
    await first.save(opened.documentId, 1);
    failManifest = false;
    await first.mutate(opened.documentId, 1, (draft) => { draft.value = "v2"; });
    failManifest = true;
    await first.save(opened.documentId, 2);

    const restarted = await manager();
    await expect(restarted.recover()).resolves.toEqual([
      expect.objectContaining({ revision: 2, document: { value: "v2", valid: true } }),
    ]);
  });

  it("bounds source reads before invoking the codec", async () => {
    await writeFile(source, Buffer.alloc(2048, 0x41));
    const sessions = await DocumentSessionManager.create(
      { workspaceRoots: [workspace], stateRoot, maxSourceBytes: 1024 },
      codec,
    );
    await expect(sessions.open(source)).rejects.toBeInstanceOf(FileSizeLimitError);
  });

  it("restores a persisted snapshot into a new working revision", async () => {
    const first = await manager();
    const opened = await first.open(source);
    await first.mutate(opened.documentId, 0, (draft) => { draft.value = "saved"; });
    await first.save(opened.documentId, 1);
    await first.mutate(opened.documentId, 1, (draft) => { draft.value = "later"; });

    const restarted = await manager();
    await restarted.recover();
    const restored = await restarted.restoreSnapshot(opened.documentId, 2);
    expect(restored).toMatchObject({ revision: 3, document: { value: "original", valid: true } });
    await expect(readFile(source, "utf8")).resolves.toContain("saved");
  });

  it("restores the chronologically latest snapshot among saves at the same revision", async () => {
    const sessions = await manager();
    const opened = await sessions.open(source);
    const firstTarget = join(workspace, "first-target.ipe");
    const secondTarget = join(workspace, "second-target.ipe");
    await writeFile(firstTarget, JSON.stringify({ value: "first previous", valid: true }));
    await writeFile(secondTarget, JSON.stringify({ value: "second previous", valid: true }));
    await sessions.save(opened.documentId, 0, firstTarget);
    await sessions.save(opened.documentId, 0, secondTarget);
    const snapshots = await sessions.snapshots(opened.documentId);
    expect(snapshots.map((path) => path.match(/snapshot-s(\d+)-/u)?.[1])).toEqual(["1", "2"]);
    const restored = await sessions.restoreSnapshot(opened.documentId, 0);
    expect(restored).toMatchObject({ revision: 1, document: { value: "second previous", valid: true } });
  });

  it("allocates distinct snapshots for concurrent save-as operations across managers", async () => {
    const first = await manager();
    const opened = await first.open(source);
    const second = await manager();
    await second.recover();
    const firstTarget = join(workspace, "concurrent-first.ipe");
    const secondTarget = join(workspace, "concurrent-second.ipe");
    await writeFile(firstTarget, JSON.stringify({ value: "first backup", valid: true }));
    await writeFile(secondTarget, JSON.stringify({ value: "second backup", valid: true }));
    await Promise.all([
      first.save(opened.documentId, 0, firstTarget),
      second.save(opened.documentId, 0, secondTarget),
    ]);
    const snapshots = await first.snapshots(opened.documentId);
    expect(snapshots.map((path) => path.match(/snapshot-s(\d+)-/u)?.[1])).toEqual(["1", "2"]);
    const contents = await Promise.all(snapshots.map((path) => readFile(path, "utf8")));
    expect(contents.map((value) => JSON.parse(value).value).sort()).toEqual(["first backup", "second backup"]);
  });
});
