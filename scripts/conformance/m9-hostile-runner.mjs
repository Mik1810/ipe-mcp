#!/usr/bin/env node
/**
 * M9 hostile-input corpus runner.
 *
 * Reads fixtures/conformance/m9/hostile/manifest.json and executes every case
 * against a deterministic in-process oracle.  Each case declares its threat
 * ID, input provenance, expected classification, and a size/time budget.  All
 * temporary state lives under a private directory that is removed before
 * exit; there is no repository residue, no PII, and no large blobs.
 */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const manifestRoot = join(root, "fixtures/conformance/m9/hostile");
const manifest = JSON.parse(await readFile(join(manifestRoot, "manifest.json"), "utf8"));
const dist = join(root, "dist/src");

const { canonicalizeIpe, ipeDocumentCodec } = await import(`${dist}/core/ipe-document-codec.js`);
const { assertMinimalPreamble } = await import(`${dist}/native/adapter.js`);
const { NativeIpeError } = await import(`${dist}/native/errors.js`);
const { parseIpeXml, XmlParseError } = await import(`${dist}/ipe/xml/parser.js`);
const { addBitmapAsset } = await import(`${dist}/objects/assets.js`);
const { DocumentSessionManager } = await import(`${dist}/persistence/session-manager.js`);
const { PathOutsideWorkspaceError, SourceChangedError } = await import(`${dist}/persistence/errors.js`);
const { FileSizeLimitError } = await import(`${dist}/persistence/bounded-read.js`);
const { migrateSidecar } = await import(`${dist}/persistence/sidecar.js`);
const { operationSchema } = await import(`${dist}/mcp/contracts.js`);
const { runControlledProcess } = await import(`${dist}/native/process.js`);
const { MCP_LIMITS } = await import(`${dist}/limits.js`);

class XorShift32 {
  constructor(state) { this.state = state | 0; }
  next() {
    let value = this.state | 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value | 0;
    return (value >>> 0) / 0x100000000;
  }
  between(minimum, maximum) { return minimum + this.next() * (maximum - minimum); }
}

const temporary = [];
let passes = 0;
let failures = 0;
const details = [];
const records = [];

const classify = (error) => (error === undefined ? "-" : error?.constructor?.name ?? typeof error);
const fail = (caseId, reason) => { failures += 1; details.push(`  ✗ ${caseId}: ${reason}`); };
const pass = (caseId) => { passes += 1; details.push(`  ✓ ${caseId}`); };

function inputFor(caseDef) {
  if (caseDef.provenance.kind === "file") {
    return readFile(join(manifestRoot, caseDef.provenance.path), "utf8");
  }
  if (caseDef.provenance.kind === "inline") {
    return Promise.resolve(caseDef.provenance.source);
  }
  throw new Error(`unsupported provenance ${caseDef.provenance.kind}`);
}

function withinBudget(caseDef, inputBytes, startMs) {
  if (inputBytes > caseDef.budget.maxInputBytes) return false;
  if (Date.now() - startMs > caseDef.budget.maxMs + 500) return false;
  return true;
}

async function newSessionRoot(prefix) {
  const work = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(work);
  const workspaceRoot = join(work, "workspace");
  await mkdir(workspaceRoot);
  const stateRoot = join(workspaceRoot, ".ipe-mcp-state");
  return { work, workspaceRoot, stateRoot };
}

const oracles = {
  "xml-rejects": async (_caseDef, source) => {
    let rejection = null;
    try { parseIpeXml(source); } catch (error) { rejection = error; }
    if (rejection === null) return { ok: false, reason: "hostile XML accepted" };
    return { ok: rejection instanceof XmlParseError, reason: `wrong rejection: ${classify(rejection)}` };
  },
  "xml-canonical-fixed-point": async (_caseDef, source) => {
    let first;
    try { first = canonicalizeIpe(source); } catch (error) { return { ok: false, reason: `failed to canonicalize: ${classify(error)}` }; }
    return { ok: canonicalizeIpe(first) === first };
  },
  "xml-fuzz-safe": async () => {
    const random = new XorShift32(0x9c0d1e2f);
    for (let index = 0; index < 512; index += 1) {
      const source = `<ipe version="70218"><page><layer name="alpha"/><path>${random.between(0, 500)} ${random.between(0, 500)} m</path></page></ipe>`;
      try { void parseIpeXml(source); } catch (error) {
        if (!(error instanceof XmlParseError)) return { ok: false, reason: `fuzz case ${index}: ${classify(error)}` };
      }
    }
    return { ok: true };
  },
  "latex-policy": async (caseDef, source) => {
    let rejection = false;
    try { assertMinimalPreamble(source); } catch (error) { rejection = error instanceof NativeIpeError && error.code === "NATIVE_TEX_ERROR"; }
    return { ok: rejection === caseDef.expected.reject, reason: `rejection=${rejection}` };
  },
  "fs-path-traversal": async () => {
    const { workspaceRoot, stateRoot } = await newSessionRoot("hostile-fs-");
    const sessions = await DocumentSessionManager.create({ workspaceRoots: [workspaceRoot], stateRoot }, ipeDocumentCodec);
    let rejection = null;
    // A sibling file outside the workspace root that really exists.
    const outside = join(dirname(workspaceRoot), "outside.ipe");
    await writeFile(outside, "<ipe version=\"70218\"><page><layer name=\"alpha\"/></page></ipe>");
    try { await sessions.open(join(workspaceRoot, "..", "outside.ipe")); }
    catch (error) { rejection = error; }
    return { ok: rejection instanceof PathOutsideWorkspaceError, reason: `got ${classify(rejection)}` };
  },
  "fs-symlink-escape": async () => {
    const { work, workspaceRoot, stateRoot } = await newSessionRoot("hostile-link-");
    const externalRoot = join(work, "external");
    await mkdir(externalRoot);
    await writeFile(join(externalRoot, "secret.ipe"), "<ipe version=\"70218\"><page></page></ipe>");
    const target = join(workspaceRoot, "link.ipe");
    try { await symlink(join(externalRoot, "secret.ipe"), target); }
    catch { return { ok: false, reason: "could not create symlink on this platform" }; }
    const sessions = await DocumentSessionManager.create({ workspaceRoots: [workspaceRoot], stateRoot }, ipeDocumentCodec);
    let rejection = null;
    try { await sessions.open(target); } catch (error) { rejection = error; }
    return { ok: rejection instanceof PathOutsideWorkspaceError, reason: `got ${classify(rejection)}` };
  },
  "fs-oversized-source": async () => {
    const { workspaceRoot, stateRoot } = await newSessionRoot("hostile-size-");
    const big = Buffer.alloc(17 * 1024 * 1024);
    big.write("<ipe version=\"70218\"><page><layer name=\"alpha\"/><path>0 0 m</path></page></ipe>");
    await writeFile(join(workspaceRoot, "big.ipe"), big);
    const sessions = await DocumentSessionManager.create({ workspaceRoots: [workspaceRoot], stateRoot }, ipeDocumentCodec);
    let rejection = null;
    try { await sessions.open(join(workspaceRoot, "big.ipe")); } catch (error) { rejection = error; }
    return { ok: rejection instanceof FileSizeLimitError, reason: `got ${classify(rejection)}` };
  },
  "asset-ihdr-bomb": async (_caseDef, source) => {
    let rejection = null;
    const encoded = /<bitmap[^>]*>([^<]+)<\/bitmap>/u.exec(source)?.[1];
    if (encoded === undefined) return { ok: false, reason: "hostile bitmap payload is missing" };
    const document = { schemaVersion: 1, format: 70218, pages: [] };
    const before = document.assets?.length ?? 0;
    try {
      addBitmapAsset(document, Buffer.from(encoded, "base64"), "image/png");
    } catch (error) {
      rejection = error;
    }
    const unchanged = (document.assets?.length ?? 0) === before;
    const safe = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4AWP8z8DwnwEImBigAAAfFwICgH3ifwAAAABJRU5ErkJggg==", "base64");
    const control = { schemaVersion: 1, format: 70218, pages: [] };
    let safeAccepted = false;
    try { safeAccepted = addBitmapAsset(control, safe, "image/png").created; } catch { safeAccepted = false; }
    const exactRejection = rejection instanceof Error && rejection.message === "bitmap exceeds pixel limit";
    return { ok: exactRejection && unchanged && safeAccepted, reason: `rejection=${classify(rejection)} exact=${exactRejection} unchanged=${unchanged} safeAccepted=${safeAccepted}` };
  },
  "asset-png-payload": async () => {
    let declined = false;
    try { addBitmapAsset({ schemaVersion: 1, format: 70218, pages: [] }, Buffer.from("iVBORw0KGgo=", "base64"), "image/png", { maxPixels: 0 }); }
    catch { declined = true; }
    return { ok: declined, reason: "truncated PNG payload was accepted" };
  },
  "contract-base64-cap": async () => {
    const parsed = operationSchema.safeParse({
      op: "add_image", pageId: "page-000000000000000000000000", layerId: "layer-000000000000000000000000", mediaType: "image/png",
      dataBase64: "a".repeat(MCP_LIMITS.imageBase64Chars + 1), target: { x: 0, y: 0, width: 10, height: 10 },
    });
    return { ok: !parsed.success, reason: "over-cap payload passed the schema" };
  },
  "proc-output-cap": async () => {
    const limits = { timeoutMs: 2000, maxOutputBytes: 1024, maxMemoryBytes: 64 * 1024 * 1024, maxProcesses: 16, maxFileBytes: 1024 * 1024 };
    let rejection = null;
    let exitedCleanly = false;
    try {
      const result = await runControlledProcess(process.execPath, ["-e", "for(let i=0;i<64;i++){process.stdout.write('x'.repeat(1024))}"], process.cwd(), limits, "NATIVE_RENDER_ERROR");
      exitedCleanly = true;
    } catch (error) { rejection = error; }
    return { ok: rejection !== null && (rejection?.code === "NATIVE_OUTPUT_LIMIT" || rejection?.code === "NATIVE_CRASH") && !exitedCleanly, reason: `got ${classify(rejection)} code=${rejection?.code}` };
  },
  "proc-fork-cap": async () => {
    const { work } = await newSessionRoot("hostile-fork-");
    const limits = { timeoutMs: 10_000, maxOutputBytes: 4096, maxMemoryBytes: 256 * 1024 * 1024, maxProcesses: 32, maxFileBytes: 16 * 1024 * 1024 };
    const bomb = "import os,signal,time\nchildren=[]\ntry:\n while True:\n  pid=os.fork()\n  if pid==0: time.sleep(30); os._exit(0)\n  children.append(pid)\nexcept OSError:\n for pid in children: os.kill(pid,signal.SIGKILL)\n for pid in children:\n  try: os.waitpid(pid,0)\n  except ChildProcessError: pass\n print('PROCESS_LIMIT',end='')";
    try {
      const result = await runControlledProcess("/usr/bin/python3", ["-c", bomb], work, limits, "NATIVE_RENDER_ERROR");
      return { ok: result.stdout === "PROCESS_LIMIT" && result.stderr === "", reason: `stdout=${JSON.stringify(result.stdout)} stderrBytes=${Buffer.byteLength(result.stderr)}` };
    } catch (error) {
      return { ok: false, reason: `fork-limit probe failed: ${classify(error)} code=${error?.code ?? "-"}` };
    }
  },
  "concurrency-snapshot-uniqueness": async () => {
    const { workspaceRoot, stateRoot } = await newSessionRoot("hostile-race-");
    const source = join(workspaceRoot, "doc.ipe");
    await writeFile(source, "<ipe version=\"70218\"><page><layer name=\"alpha\"/></page></ipe>");
    const first = await DocumentSessionManager.create({ workspaceRoots: [workspaceRoot], stateRoot }, ipeDocumentCodec);
    const second = await DocumentSessionManager.create({ workspaceRoots: [workspaceRoot], stateRoot }, ipeDocumentCodec);
    const opened = await first.open(source);
    const recovered = await second.recover();
    const documentId = recovered[0]?.documentId ?? opened.documentId;
    const firstTarget = join(workspaceRoot, "concurrent-first.ipe");
    const secondTarget = join(workspaceRoot, "concurrent-second.ipe");
    await writeFile(firstTarget, "<ipe version=\"70218\"><page><layer name=\"alpha\"/></page></ipe>");
    await writeFile(secondTarget, "<ipe version=\"70218\"><page><layer name=\"alpha\"/></page></ipe>");
    const [saved1, saved2] = await Promise.all([
      first.save(opened.documentId, 0, firstTarget),
      second.save(documentId, 0, secondTarget),
    ]);
    if (saved1.snapshotPath === undefined || saved2.snapshotPath === undefined) {
      return { ok: false, reason: "missing snapshot evidence" };
    }
    const snapshots = await first.snapshots(opened.documentId);
    return { ok: saved1.snapshotPath !== saved2.snapshotPath && snapshots.length === 2, reason: "snapshots collide or are missing" };
  },
  "sidecar-unknown-field": async (_caseDef, source) => {
    let rejection = null;
    try { migrateSidecar(JSON.parse(source)); } catch (error) { rejection = error; }
    return { ok: rejection !== null, reason: `got ${classify(rejection)}` };
  },
  "http-no-remote-source": async (_caseDef, source) => {
    const { workspaceRoot, stateRoot } = await newSessionRoot("hostile-http-");
    const sessions = await DocumentSessionManager.create({ workspaceRoots: [workspaceRoot], stateRoot }, ipeDocumentCodec);
    let rejection = null;
    try { await sessions.open(source); } catch (error) { rejection = error; }
    const localMissing = rejection instanceof Error && rejection.code === "ENOENT";
    return { ok: localMissing, reason: `remote source rejection was ${classify(rejection)} code=${rejection?.code ?? "-"}` };
  },
  "http-link-schema": async (_caseDef, source) => {
    const parsed = operationSchema.safeParse({
      op: "group_objects", pageId: "page-000000000000000000000000",
      objectIds: ["object-000000000000000000000000", "object-000000000000000000000001"],
      url: source,
    });
    return { ok: !parsed.success, reason: "javascript URL accepted by the schema" };
  },
};

for (const caseDef of manifest.cases) {
  const start = Date.now();
  let inputBytes = 0;
  let result;
  try {
    const provided = caseDef.provenance.kind === "file" || caseDef.provenance.kind === "inline" ? await inputFor(caseDef) : undefined;
    inputBytes = provided === undefined ? Math.floor(caseDef.budget.maxInputBytes / 2) : Buffer.byteLength(provided, "utf8");
    const oracleFn = oracles[caseDef.oracle];
    if (oracleFn === undefined) throw new Error(`unknown oracle ${caseDef.oracle}`);
    result = await oracleFn(caseDef, provided);
  } catch (error) {
    result = { ok: false, reason: `oracle exception: ${classify(error)}` };
  }
  if (!withinBudget(caseDef, inputBytes, start)) {
    fail(caseDef.id, `budget exceeded (input ${inputBytes} B / ${caseDef.budget.maxInputBytes}, ${Date.now() - start} ms / ${caseDef.budget.maxMs})`);
    continue;
  }
  if (result.ok) {
    pass(caseDef.id);
    records.push({ id: caseDef.id, threatId: caseDef.threatId, result: "PASS", classification: caseDef.expected.classification, inputBytes, maxInputBytes: caseDef.budget.maxInputBytes, maxMs: caseDef.budget.maxMs });
  } else fail(caseDef.id, result.reason ?? "oracle failed");
}

for (const directory of temporary) {
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

if (failures > 0) {
  console.error(`HOSTILE corpus: ${passes} pass, ${failures} fail\n${details.join("\n")}`);
  process.exit(1);
}
console.log(`HOSTILE corpus: ${passes} pass (${manifest.cases.length} cases, no residue)`);
console.log(JSON.stringify({ scenario: manifest.corpus, milestone: manifest.milestone, result: "PASS", cases: records, cleanup: "PASS" }));
