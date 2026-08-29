import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  atomicWriteFile,
  AtomicWriteError,
  type AtomicWriteHooks,
  type AtomicWriteOptions,
} from "./atomic.js";
import {
  PathOutsideWorkspaceError,
  RevisionConflictError,
  SourceChangedError,
  StructuralValidationError,
  type SessionDiagnostic,
} from "./errors.js";
import { FileSizeLimitError, readFileBounded, readHandleBounded } from "./bounded-read.js";
import { PERSISTENCE_LIMITS } from "../limits.js";

const DEFAULT_MAX_SOURCE_BYTES = PERSISTENCE_LIMITS.maxSourceBytes;
const METADATA_BYTES = PERSISTENCE_LIMITS.maxMetadataBytes;

export interface DocumentCodec<Document> {
  parse(source: string | Uint8Array): Document;
  serialize(document: Document): string;
  validate(document: Document): readonly SessionDiagnostic[];
}

/** Optional pre-serialize guard; throwing rolls back the whole mutation. */
export type MutationGuard<Document> = (document: Document) => void;

export interface SessionManagerOptions<Document = unknown> {
  readonly workspaceRoots: readonly string[];
  readonly stateRoot: string;
  readonly atomicWriteHooks?: AtomicWriteHooks;
  readonly maxSourceBytes?: number;
  readonly mutationGuard?: MutationGuard<Document>;
}

export interface OpenSessionResult<Document> {
  readonly documentId: string;
  readonly revision: number;
  readonly document: Document;
  readonly sourcePath: string;
  readonly sourceHash: string;
}

export interface MutationResult<Document> {
  readonly documentId: string;
  readonly revision: number;
  readonly document: Document;
  readonly diagnostics: readonly SessionDiagnostic[];
}

export interface SaveResult {
  readonly documentId: string;
  readonly revision: number;
  readonly path: string;
  readonly sourceHash: string;
  readonly snapshotPath?: string;
}

class Mutex {
  #tail: Promise<void> = Promise.resolve();

  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface StoredSession<Document> {
  readonly documentId: string;
  readonly sourcePath: string;
  readonly workDirectory: string;
  workingPath: string;
  readonly mutex: Mutex;
  document: Document;
  revision: number;
  sourceHash: string;
  sourceDevice: string;
  sourceInode: string;
  manifestState: TargetState;
}

interface ExistingTargetState {
  readonly exists: true;
  readonly data: Uint8Array;
  readonly hash: string;
  readonly device: string;
  readonly inode: string;
}

interface MissingTargetState {
  readonly exists: false;
}

type TargetState = ExistingTargetState | MissingTargetState;

interface SessionManifestV1 {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly sourceDevice: string;
  readonly sourceInode: string;
  readonly revision: number;
  readonly workingFile: string;
}

interface SaveJournalV1 {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly targetPath: string;
  readonly expected: {
    readonly exists: boolean;
    readonly hash: string | null;
    readonly device: string | null;
    readonly inode: string | null;
  };
  readonly nextHash: string;
}

function hash(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function targetState(path: string, maxBytes: number): Promise<TargetState> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()) throw new Error(`save target is not a regular file: ${path}`);
    if (metadata.size > BigInt(maxBytes)) throw new FileSizeLimitError(maxBytes);
    const data = await readHandleBounded(handle, maxBytes);
    return { exists: true, data, hash: hash(data), device: metadata.dev.toString(), inode: metadata.ino.toString() };
  } finally {
    await handle.close();
  }
}

function sameTargetState(expected: TargetState, actual: TargetState): boolean {
  if (!expected.exists || !actual.exists) return expected.exists === actual.exists;
  return expected.hash === actual.hash && expected.device === actual.device && expected.inode === actual.inode;
}

function targetIdentity(state: TargetState): SaveJournalV1["expected"] {
  return state.exists
    ? { exists: true, hash: state.hash, device: state.device, inode: state.inode }
    : { exists: false, hash: null, device: null, inode: null };
}

function stateMatchesIdentity(expected: SaveJournalV1["expected"], actual: TargetState): boolean {
  if (!expected.exists || !actual.exists) return expected.exists === actual.exists;
  return expected.hash === actual.hash && expected.device === actual.device && expected.inode === actual.inode;
}

function parseSaveJournal(input: unknown): SaveJournalV1 {
  if (typeof input !== "object" || input === null) throw new Error("invalid save journal");
  const value = input as Record<string, unknown>;
  const expected = value.expected as Record<string, unknown> | undefined;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["documentId", "expected", "nextHash", "schemaVersion", "targetPath"]) ||
      expected === undefined || JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(["device", "exists", "hash", "inode"]) ||
      value.schemaVersion !== 1 || typeof value.documentId !== "string" || typeof value.targetPath !== "string" ||
      typeof value.nextHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.nextHash) || expected === undefined ||
      typeof expected.exists !== "boolean" ||
      (expected.exists && (typeof expected.hash !== "string" || !/^[a-f0-9]{64}$/u.test(expected.hash) ||
        typeof expected.device !== "string" || !/^\d+$/u.test(expected.device) ||
        typeof expected.inode !== "string" || !/^\d+$/u.test(expected.inode))) ||
      (!expected.exists && (expected.hash !== null || expected.device !== null || expected.inode !== null))) {
    throw new Error("invalid save journal values");
  }
  return value as unknown as SaveJournalV1;
}

function parseManifest(input: unknown): SessionManifestV1 {
  if (typeof input !== "object" || input === null) throw new Error("invalid session manifest");
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = ["documentId", "revision", "schemaVersion", "sourceDevice", "sourceHash", "sourceInode", "sourcePath", "workingFile"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error("invalid session manifest fields");
  if (value.schemaVersion !== 1 || typeof value.documentId !== "string" || typeof value.sourcePath !== "string" ||
      typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.sourceHash) ||
      typeof value.sourceDevice !== "string" || !/^\d+$/u.test(value.sourceDevice) ||
      typeof value.sourceInode !== "string" || !/^\d+$/u.test(value.sourceInode) ||
      typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.workingFile !== "string" || !/^working-r\d+-[a-f0-9-]+\.ipe$/u.test(value.workingFile)) {
    throw new Error("invalid session manifest values");
  }
  return value as unknown as SessionManifestV1;
}

function clone<Document>(document: Document): Document {
  return structuredClone(document);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export class DocumentSessionManager<Document> {
  readonly #roots: readonly string[];
  readonly #stateRoot: string;
  readonly #codec: DocumentCodec<Document>;
  readonly #hooks: AtomicWriteHooks | undefined;
  readonly #maxSourceBytes: number;
  readonly #mutationGuard: MutationGuard<Document> | undefined;
  readonly #sessions = new Map<string, StoredSession<Document>>();

  private constructor(
    roots: readonly string[],
    stateRoot: string,
    codec: DocumentCodec<Document>,
    hooks: AtomicWriteHooks | undefined,
    maxSourceBytes: number,
    mutationGuard: MutationGuard<Document> | undefined,
  ) {
    this.#roots = roots;
    this.#stateRoot = stateRoot;
    this.#codec = codec;
    this.#hooks = hooks;
    this.#maxSourceBytes = maxSourceBytes;
    this.#mutationGuard = mutationGuard;
  }

  static async create<Document>(
    options: SessionManagerOptions<Document>,
    codec: DocumentCodec<Document>,
  ): Promise<DocumentSessionManager<Document>> {
    if (options.workspaceRoots.length === 0) {
      throw new Error("at least one workspace root is required");
    }
    const roots = await Promise.all(options.workspaceRoots.map((root) => realpath(resolve(root))));
    await mkdir(resolve(options.stateRoot), { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(resolve(options.stateRoot));
    if (!roots.some((root) => isInside(root, stateRoot))) {
      throw new PathOutsideWorkspaceError(stateRoot);
    }
    const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) throw new Error("maxSourceBytes must be a positive safe integer");
    return new DocumentSessionManager(roots, stateRoot, codec, options.atomicWriteHooks, maxSourceBytes, options.mutationGuard);
  }

  async open(sourcePath: string): Promise<OpenSessionResult<Document>> {
    const canonicalSource = await this.#resolveExistingAllowed(sourcePath);
    const source = await targetState(canonicalSource, this.#maxSourceBytes);
    if (!source.exists) throw new SourceChangedError(canonicalSource);
    const document = this.#codec.parse(source.data);
    const diagnostics = this.#codec.validate(document);
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      throw new StructuralValidationError(diagnostics);
    }

    const documentId = randomUUID();
    const workDirectory = join(this.#stateRoot, documentId);
    await mkdir(workDirectory, { recursive: false, mode: 0o700 });
    const workingPath = join(workDirectory, `working-r0-${randomUUID()}.ipe`);
    await atomicWriteFile(workingPath, source.data, this.#atomicOptions());
    const session: StoredSession<Document> = {
      documentId,
      sourcePath: canonicalSource,
      workDirectory,
      workingPath,
      mutex: new Mutex(),
      document,
      revision: 0,
      sourceHash: source.hash,
      sourceDevice: source.device,
      sourceInode: source.inode,
      manifestState: { exists: false },
    };
    await this.#writeManifest(session);
    this.#sessions.set(documentId, session);
    return {
      documentId,
      revision: 0,
      document: clone(document),
      sourcePath: canonicalSource,
      sourceHash: source.hash,
    };
  }

  /** Start a recoverable session for a new document without touching its eventual save target. */
  async create(document: Document): Promise<OpenSessionResult<Document>> {
    const diagnostics = this.#codec.validate(document);
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      throw new StructuralValidationError(diagnostics);
    }
    const source = this.#codec.serialize(document);
    this.#assertSerializedSize(source);
    const seedDirectory = join(this.#stateRoot, "created-sources");
    await mkdir(seedDirectory, { recursive: true, mode: 0o700 });
    const seedPath = join(seedDirectory, `created-${randomUUID()}.ipe`);
    await atomicWriteFile(seedPath, source, this.#atomicOptions());
    return await this.open(seedPath);
  }

  inspect(documentId: string): OpenSessionResult<Document> {
    const session = this.#session(documentId);
    return {
      documentId,
      revision: session.revision,
      document: clone(session.document),
      sourcePath: session.sourcePath,
      sourceHash: session.sourceHash,
    };
  }

  mutate(
    documentId: string,
    expectedRevision: number,
    operation: (draft: Document) => void | Promise<void>,
  ): Promise<MutationResult<Document>> {
    const session = this.#session(documentId);
    return session.mutex.run(async () => {
      this.#assertRevision(session, expectedRevision);
      const draft = clone(session.document);
      await operation(draft);
      this.#mutationGuard?.(draft);
      const diagnostics = this.#codec.validate(draft);
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        throw new StructuralValidationError(diagnostics);
      }
      const serialized = this.#codec.serialize(draft);
      this.#assertSerializedSize(serialized);
      const nextRevision = session.revision + 1;
      const nextWorkingPath = join(session.workDirectory, `working-r${nextRevision}-${randomUUID()}.ipe`);
      await atomicWriteFile(nextWorkingPath, serialized, this.#atomicOptions());
      try {
        await this.#writeManifest(session, { revision: nextRevision, workingPath: nextWorkingPath });
      } catch (error) {
        if (error instanceof AtomicWriteError && error.committed) {
          session.document = draft;
          session.revision = nextRevision;
          session.workingPath = nextWorkingPath;
        }
        throw error;
      }
      session.document = draft;
      session.revision = nextRevision;
      session.workingPath = nextWorkingPath;
      return {
        documentId,
        revision: session.revision,
        document: clone(draft),
        diagnostics,
      };
    });
  }

  save(
    documentId: string,
    expectedRevision: number,
    targetPath?: string,
  ): Promise<SaveResult> {
    const session = this.#session(documentId);
    return session.mutex.run(async () => {
      this.#assertRevision(session, expectedRevision);
      const target = await this.#resolveTargetAllowed(targetPath ?? session.sourcePath);
      const previous = await targetState(target, this.#maxSourceBytes);
      if (target === session.sourcePath) {
        if (!previous.exists || previous.hash !== session.sourceHash || previous.device !== session.sourceDevice || previous.inode !== session.sourceInode) {
          throw new SourceChangedError(target);
        }
      }

      let snapshotPath: string | undefined;
      if (previous.exists) {
        const snapshotSequence = await this.#allocateSnapshotSequence(session);
        const nextSnapshotPath = join(
          session.workDirectory,
          `snapshot-s${snapshotSequence}-r${session.revision}-${previous.hash.slice(0, 16)}.ipe`,
        );
        await atomicWriteFile(nextSnapshotPath, previous.data, this.#atomicOptions());
        snapshotPath = nextSnapshotPath;
      }
      const serialized = this.#codec.serialize(session.document);
      this.#assertSerializedSize(serialized);
      const journalPath = await this.#writeSaveJournal(session, target, previous, hash(serialized));
      let committedIdentity: { readonly device: string; readonly inode: string };
      try {
        committedIdentity = await atomicWriteFile(target, serialized, {
          ...this.#atomicOptions(),
          precondition: async () => {
            if (!sameTargetState(previous, await targetState(target, this.#maxSourceBytes))) throw new SourceChangedError(target);
          },
        });
      } catch (error) {
        if (!(error instanceof AtomicWriteError && error.committed)) {
          await this.#removeJournal(journalPath).catch(() => undefined);
        }
        throw error;
      }
      const current: ExistingTargetState = {
        exists: true,
        data: Buffer.from(serialized),
        hash: hash(serialized),
        device: committedIdentity.device,
        inode: committedIdentity.inode,
      };
      if (target === session.sourcePath) {
        session.sourceHash = current.hash;
        session.sourceDevice = current.device;
        session.sourceInode = current.inode;
        try {
          await this.#writeManifest(session);
          await this.#removeJournal(journalPath);
        } catch {
          // The source commit is complete.  Keep the durable journal so a
          // restarted manager can reconcile the manifest without reporting a
          // false failed save after the rename already happened.
        }
      } else {
        await this.#removeJournal(journalPath).catch(() => undefined);
      }
      return {
        documentId,
        revision: session.revision,
        path: target,
        sourceHash: current.hash,
        ...(snapshotPath === undefined ? {} : { snapshotPath }),
      };
    });
  }

  /** Reload durable working sessions after a process restart. */
  async recover(): Promise<OpenSessionResult<Document>[]> {
    const recovered: OpenSessionResult<Document>[] = [];
    for (const entry of await readdir(this.#stateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workDirectory = await realpath(join(this.#stateRoot, entry.name));
      if (!isInside(this.#stateRoot, workDirectory)) throw new PathOutsideWorkspaceError(workDirectory);
      let manifestState: TargetState;
      try {
        const manifestPath = await realpath(join(workDirectory, "session.json"));
        if (!isInside(workDirectory, manifestPath)) throw new PathOutsideWorkspaceError(manifestPath);
        manifestState = await targetState(manifestPath, METADATA_BYTES);
        if (!manifestState.exists) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const manifestSource = new TextDecoder("utf-8", { fatal: true }).decode(manifestState.data);
      const manifest = parseManifest(JSON.parse(manifestSource) as unknown);
      if (manifest.documentId !== entry.name) throw new Error("session manifest directory mismatch");
      if (this.#sessions.has(manifest.documentId)) continue;
      const sourcePath = await this.#resolveRecoverableAllowed(manifest.sourcePath);
      const workingPath = await realpath(join(workDirectory, manifest.workingFile));
      if (!isInside(workDirectory, workingPath)) throw new PathOutsideWorkspaceError(workingPath);
      const working = await readFileBounded(workingPath, this.#maxSourceBytes);
      const document = this.#codec.parse(working);
      const diagnostics = this.#codec.validate(document);
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        throw new StructuralValidationError(diagnostics);
      }
      const session: StoredSession<Document> = {
        documentId: manifest.documentId,
        sourcePath,
        workDirectory,
        workingPath,
        mutex: new Mutex(),
        document,
        revision: manifest.revision,
        sourceHash: manifest.sourceHash,
        sourceDevice: manifest.sourceDevice,
        sourceInode: manifest.sourceInode,
        manifestState,
      };
      this.#sessions.set(session.documentId, session);
      await this.#recoverSaveJournals(session);
      recovered.push(this.inspect(session.documentId));
    }
    return recovered;
  }

  async snapshots(documentId: string): Promise<string[]> {
    const session = this.#session(documentId);
    return (await readdir(session.workDirectory))
      .filter((name) => /^snapshot-s\d+-r\d+-[a-f0-9]{16}\.ipe$/u.test(name))
      .sort((a, b) => Number(/^snapshot-s(\d+)/u.exec(a)?.[1]) - Number(/^snapshot-s(\d+)/u.exec(b)?.[1]))
      .map((name) => join(session.workDirectory, name));
  }

  /** Capture the current working revision as a private recovery snapshot. */
  async createSnapshot(documentId: string, expectedRevision: number): Promise<string> {
    const session = this.#session(documentId);
    return await session.mutex.run(async () => {
      this.#assertRevision(session, expectedRevision);
      const serialized = this.#codec.serialize(session.document);
      this.#assertSerializedSize(serialized);
      const sequence = await this.#allocateSnapshotSequence(session);
      const snapshotPath = join(
        session.workDirectory,
        `snapshot-s${sequence}-r${session.revision}-${hash(serialized).slice(0, 16)}.ipe`,
      );
      await atomicWriteFile(snapshotPath, serialized, this.#atomicOptions());
      return snapshotPath;
    });
  }

  /** Promote the immediately preceding durable working revision as a new revision. */
  async undo(documentId: string, expectedRevision: number): Promise<MutationResult<Document>> {
    const session = this.#session(documentId);
    return await session.mutex.run(async () => {
      this.#assertRevision(session, expectedRevision);
      if (expectedRevision < 1) throw new Error("session has no previous revision to undo");
      const prefix = `working-r${expectedRevision - 1}-`;
      const previousName = (await readdir(session.workDirectory)).find((name) => name.startsWith(prefix) && name.endsWith(".ipe"));
      if (previousName === undefined) throw new Error("previous working revision is unavailable; use a named snapshot instead");
      const previousPath = await realpath(join(session.workDirectory, previousName));
      if (!isInside(session.workDirectory, previousPath)) throw new PathOutsideWorkspaceError(previousPath);
      const document = this.#codec.parse(await readFileBounded(previousPath, this.#maxSourceBytes));
      const diagnostics = this.#codec.validate(document);
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) throw new StructuralValidationError(diagnostics);
      const nextRevision = expectedRevision + 1;
      const nextWorkingPath = join(session.workDirectory, `working-r${nextRevision}-${randomUUID()}.ipe`);
      await atomicWriteFile(nextWorkingPath, this.#codec.serialize(document), this.#atomicOptions());
      try {
        await this.#writeManifest(session, { revision: nextRevision, workingPath: nextWorkingPath });
      } catch (error) {
        if (error instanceof AtomicWriteError && error.committed) {
          session.document = document;
          session.revision = nextRevision;
          session.workingPath = nextWorkingPath;
        }
        throw error;
      }
      session.document = document;
      session.revision = nextRevision;
      session.workingPath = nextWorkingPath;
      return { documentId, revision: nextRevision, document: clone(document), diagnostics };
    });
  }

  async restoreSnapshot(
    documentId: string,
    expectedRevision: number,
    snapshotPath?: string,
  ): Promise<MutationResult<Document>> {
    const session = this.#session(documentId);
    return session.mutex.run(async () => {
      this.#assertRevision(session, expectedRevision);
      const available = await this.snapshots(documentId);
      const selected = snapshotPath ?? available.at(-1);
      if (selected === undefined) throw new Error("session has no snapshot to restore");
      const canonical = await realpath(resolve(selected));
      if (!isInside(session.workDirectory, canonical) || !available.includes(canonical)) {
        throw new PathOutsideWorkspaceError(canonical);
      }
      const document = this.#codec.parse(await readFileBounded(canonical, this.#maxSourceBytes));
      const diagnostics = this.#codec.validate(document);
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        throw new StructuralValidationError(diagnostics);
      }
      const nextRevision = session.revision + 1;
      const nextWorkingPath = join(session.workDirectory, `working-r${nextRevision}-${randomUUID()}.ipe`);
      await atomicWriteFile(nextWorkingPath, this.#codec.serialize(document), this.#atomicOptions());
      try {
        await this.#writeManifest(session, { revision: nextRevision, workingPath: nextWorkingPath });
      } catch (error) {
        if (error instanceof AtomicWriteError && error.committed) {
          session.document = document;
          session.revision = nextRevision;
          session.workingPath = nextWorkingPath;
        }
        throw error;
      }
      session.document = document;
      session.revision = nextRevision;
      session.workingPath = nextWorkingPath;
      return { documentId, revision: nextRevision, document: clone(document), diagnostics };
    });
  }

  #session(documentId: string): StoredSession<Document> {
    const session = this.#sessions.get(documentId);
    if (!session) throw new Error(`unknown document session: ${documentId}`);
    return session;
  }

  #assertRevision(session: StoredSession<Document>, expectedRevision: number): void {
    if (session.revision !== expectedRevision) {
      throw new RevisionConflictError(expectedRevision, session.revision);
    }
  }

  #atomicOptions(): AtomicWriteOptions {
    return this.#hooks === undefined ? {} : { hooks: this.#hooks };
  }

  #assertSerializedSize(source: string): void {
    if (Buffer.byteLength(source) > this.#maxSourceBytes) throw new FileSizeLimitError(this.#maxSourceBytes);
  }

  async #allocateSnapshotSequence(session: StoredSession<Document>): Promise<number> {
    const counterPath = join(session.workDirectory, "snapshot-sequence.txt");
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const expected = await targetState(counterPath, 64);
      let current = 0;
      if (expected.exists) {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(expected.data).trim();
        if (!/^\d+$/u.test(source)) throw new Error("invalid snapshot sequence counter");
        current = Number(source);
      }
      for (const name of await readdir(session.workDirectory)) {
        const value = Number(/^snapshot-s(\d+)-r\d+-[a-f0-9]{16}\.ipe$/u.exec(name)?.[1]);
        if (Number.isSafeInteger(value)) current = Math.max(current, value);
      }
      const next = current + 1;
      if (!Number.isSafeInteger(next)) throw new Error("snapshot sequence exhausted");
      try {
        await atomicWriteFile(counterPath, `${next}\n`, {
          ...this.#atomicOptions(),
          precondition: async () => {
            if (!sameTargetState(expected, await targetState(counterPath, 64))) throw new SourceChangedError(counterPath);
          },
        });
        return next;
      } catch (error) {
        if (error instanceof SourceChangedError || (error instanceof AtomicWriteError && error.committed)) continue;
        throw error;
      }
    }
    throw new Error("could not allocate a snapshot sequence after concurrent updates");
  }

  async #writeManifest(
    session: StoredSession<Document>,
    overrides: { readonly revision?: number; readonly workingPath?: string } = {},
  ): Promise<void> {
    const manifest: SessionManifestV1 = {
      schemaVersion: 1,
      documentId: session.documentId,
      sourcePath: session.sourcePath,
      sourceHash: session.sourceHash,
      sourceDevice: session.sourceDevice,
      sourceInode: session.sourceInode,
      revision: overrides.revision ?? session.revision,
      workingFile: basename(overrides.workingPath ?? session.workingPath),
    };
    const path = join(session.workDirectory, "session.json");
    const expected = session.manifestState;
    const source = `${JSON.stringify(manifest, null, 2)}\n`;
    const nextState = (identity: { readonly device: string; readonly inode: string }): ExistingTargetState => ({
      exists: true,
      data: Buffer.from(source),
      hash: hash(source),
      device: identity.device,
      inode: identity.inode,
    });
    try {
      const identity = await atomicWriteFile(
        path,
        source,
        {
          ...this.#atomicOptions(),
          precondition: async () => {
            if (!sameTargetState(expected, await targetState(path, METADATA_BYTES))) throw new SourceChangedError(path);
          },
        },
      );
      session.manifestState = nextState(identity);
    } catch (error) {
      if (error instanceof AtomicWriteError && error.committed && error.result !== undefined) {
        session.manifestState = nextState(error.result);
      }
      throw error;
    }
  }

  async #writeSaveJournal(
    session: StoredSession<Document>,
    targetPath: string,
    expected: TargetState,
    nextHash: string,
  ): Promise<string> {
    const path = join(session.workDirectory, `save-journal-${randomUUID()}.json`);
    const journal: SaveJournalV1 = {
      schemaVersion: 1,
      documentId: session.documentId,
      targetPath,
      expected: targetIdentity(expected),
      nextHash,
    };
    await atomicWriteFile(path, `${JSON.stringify(journal, null, 2)}\n`, this.#atomicOptions());
    return path;
  }

  async #removeJournal(path: string): Promise<void> {
    await unlink(path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async #recoverSaveJournals(session: StoredSession<Document>): Promise<void> {
    const names = (await readdir(session.workDirectory))
      .filter((name) => /^save-journal-[a-f0-9-]+\.json$/u.test(name))
      .sort();
    for (const name of names) {
      const path = await realpath(join(session.workDirectory, name));
      if (!isInside(session.workDirectory, path)) throw new PathOutsideWorkspaceError(path);
      const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFileBounded(path, METADATA_BYTES));
      const journal = parseSaveJournal(JSON.parse(source) as unknown);
      if (journal.documentId !== session.documentId) throw new Error("save journal session mismatch");
      const target = await this.#resolveTargetAllowed(journal.targetPath);
      const current = await targetState(target, this.#maxSourceBytes);
      const manifestAlreadyCoversTarget = target === session.sourcePath && current.exists &&
        current.hash === session.sourceHash && current.device === session.sourceDevice && current.inode === session.sourceInode;
      const journalAlreadyInManifest = target === session.sourcePath && session.sourceHash === journal.nextHash;
      if (manifestAlreadyCoversTarget || journalAlreadyInManifest) {
        await this.#removeJournal(path);
      } else if (current.exists && current.hash === journal.nextHash) {
        if (target === session.sourcePath) {
          session.sourceHash = current.hash;
          session.sourceDevice = current.device;
          session.sourceInode = current.inode;
          await this.#writeManifest(session);
        }
        await this.#removeJournal(path);
      } else if (stateMatchesIdentity(journal.expected, current)) {
        await this.#removeJournal(path);
      } else {
        throw new SourceChangedError(target);
      }
    }
  }

  async #resolveExistingAllowed(path: string): Promise<string> {
    const canonical = await realpath(resolve(path));
    if (!this.#roots.some((root) => isInside(root, canonical))) {
      throw new PathOutsideWorkspaceError(canonical);
    }
    return canonical;
  }

  async #resolveTargetAllowed(path: string): Promise<string> {
    const absolute = resolve(path);
    try {
      await stat(absolute);
      return this.#resolveExistingAllowed(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = await realpath(resolve(absolute, ".."));
    const candidate = join(parent, basename(absolute));
    if (!this.#roots.some((root) => isInside(root, candidate))) {
      throw new PathOutsideWorkspaceError(candidate);
    }
    return candidate;
  }

  async #resolveRecoverableAllowed(path: string): Promise<string> {
    const absolute = resolve(path);
    if (!this.#roots.some((root) => isInside(root, absolute))) throw new PathOutsideWorkspaceError(absolute);
    try {
      const canonical = await realpath(absolute);
      if (!this.#roots.some((root) => isInside(root, canonical))) throw new PathOutsideWorkspaceError(canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = await realpath(resolve(absolute, ".."));
      if (!this.#roots.some((root) => isInside(root, parent))) throw new PathOutsideWorkspaceError(parent);
    }
    return absolute;
  }
}
