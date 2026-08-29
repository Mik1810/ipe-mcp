#!/usr/bin/env node
// M9 #20 real-document review runner.
// Drives the real MCP stdio server (text/structured parity) over licensed real
// Ipe documents: two Ipe-7.2.30 package-shipped originals (GPL-3+, derived to
// 70218 by the native ipetoipe 7.2.30 toolchain, never by the server) and one
// independent MIT-licensed template fixture (native 70218 as published).
// All inputs live inside a private temporary workspace; the package originals
// are never written to and are never copied into the repository, and each
// phase result is recorded as PASS or as a classified candidate response
// (code + reason) exactly as a real user would observe it.
import { createHash } from "node:crypto";
import { readFile, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? "/tmp/ipe-m9-real");
const evidenceTarget = resolve(process.argv[3] ?? join(output, "evidence.json"));

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const codeOf = (message) => message.match(/"code":"([^"]+)"/)?.[1];
const classOf = (message) => {
  const code = codeOf(message);
  const summary = message.match(/"summary":"([^"]+)"/)?.[1] ?? message.slice(0, 120);
  return { code, summary: summary.slice(0, 220), message: message.slice(0, 400) };
};

const manifest = JSON.parse(await readFile(join(root, "fixtures/conformance/m9/real/manifest.json"), "utf8"));
const fixture = (id) => manifest.cases.find((entry) => entry.id === id);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(join(output, "inputs"), { recursive: true });
await mkdir(join(output, "cases"), { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/src/cli/mcp-stdio.js")],
  cwd: root,
  env: { PATH: process.env.PATH ?? "", IPE_MCP_WORKSPACE_ROOT: output, IPE_MCP_STATE_ROOT: join(output, ".state") },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
const client = new Client({ name: "m9-real-host", version: "1.0.0" });

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true || result.structuredContent === undefined || result.structuredContent.ok !== true) {
    const text = result.content.find((item) => item.type === "text")?.text ?? JSON.stringify(result);
    throw Object.assign(new Error(`${name}: ${text}`), { text });
  }
  return result.structuredContent;
};
const classify = async (name, args) => {
  try {
    await call(name, args);
    return undefined;
  } catch (error) {
    const text = String(error?.message ?? error);
    return { ...classOf(text) };
  }
};
const readBinary = async (uri) => Buffer.from((await client.readResource({ uri })).contents[0].blob, "base64");

const capturePng = (data) => {
  const header = data.subarray(0, 8).toString("latin1");
  if (header !== "\u0089PNG\r\n\u001a\n") return { header, width: 0, height: 0 };
  return { header, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
};

const originalSha = async (path) => sha256(await readFile(path));

async function derive(inputPath, id) {
  const target = join(output, "inputs", `${id}-70218.ipe`);
  await exec("ipetoipe", ["-xml", inputPath, target], { timeout: 120_000, env: { ...process.env, LC_ALL: "C" } });
  const bytes = await readFile(target);
  const text = bytes.toString("utf8");
  const version = text.match(/<ipe version="(\d+)" /)?.[1];
  if (version !== "70218") throw new Error(`${id}: derived root is ${version}, expected 70218`);
  return { path: target, bytes, sha256: sha256(bytes), version };
}

async function exercise(entry) {
  const id = entry.id;
  const dir = join(output, "cases", id);
  await mkdir(dir, { recursive: true });
  const evidence = { id, name: entry.name, phases: {}, findings: [] };
  console.log(`\n== ${id} ${entry.name}`);

  const inputPath = entry.kind === "upstream-fetch" ? join(root, entry.sourcePath) : entry.sourcePath;
  const before = await originalSha(inputPath);
  if (before !== entry.originalSha256) throw new Error(`${id}: source sha mismatch ${before} != ${entry.originalSha256}`);
  evidence.originalSha256 = before;

  let derived;
  if (entry.derivation.startsWith("none")) {
    const target = join(output, "inputs", `${id}-70218.ipe`);
    await copyFile(inputPath, target);
    const bytes = await readFile(target);
    derived = { path: target, bytes, sha256: sha256(bytes), version: "70218" };
  } else {
    derived = await derive(inputPath, id);
  }
  evidence.derived = { bytes: derived.bytes.length, sha256: derived.sha256, rootVersion: derived.version };

  const opened = await call("ipe_open_document", { path: derived.path });
  const documentId = opened.data.documentId;
  evidence.phases.open = { ok: true, revision: opened.data.revision };

  const inspected = await call("ipe_inspect", { documentId, maxObjects: 500 });
  const outline = inspected.data.outline;
  evidence.phases.inspect = {
    ok: true, pageCount: outline.pageCount, objectCount: outline.objectCount,
    views: outline.pages.reduce((sum, page) => sum + page.views.length, 0),
    layers: outline.pages.reduce((sum, page) => sum + page.layers.length, 0),
    firstPageObjects: outline.pages[0]?.objectCount ?? 0,
  };
  console.log(`  [inspect] ${outline.pageCount} pages, ${outline.objectCount} objects, ${evidence.phases.inspect.views} views`);

  const targetPage = outline.pages[0];
  const targetObject = targetPage.objects[0];
  let edit = "transform_object";
  let editClassification = await classify("ipe_apply_operations", {
    documentId, expectedRevision: inspected.data.revision,
    operations: [{ op: "transform_object", pageId: targetPage.id, objectId: targetObject.id, matrix: [1, 0, 0, 1, 1.32, 0.44], space: "page" }],
  });
  let revision;
  if (editClassification === undefined) {
    revision = inspected.data.revision + 1;
    evidence.phases.edit = { ok: true, op: edit, revision, targetObjectId: targetObject.id };
    console.log(`  [edit] transform_object applied (object ${targetObject.id.slice(0, 12)})`);
  } else {
    edit = "update_layer";
    console.log(`  [edit] transform_object classified ${editClassification.code}; fallback update_layer`);
    evidence.findings.push({ kind: "edit-fallback", ...editClassification });
    const layer = targetPage.layers[0];
    const applied = await call("ipe_apply_operations", {
      documentId, expectedRevision: inspected.data.revision,
      operations: [{ op: "update_layer", pageId: targetPage.id, layerId: layer.id, name: `${layer.name}-m9real` }],
    });
    revision = applied.data.revision;
    evidence.phases.edit = { ok: true, op: edit, revision, targetObjectId: targetObject.id };
  }

  const validation = await classify("ipe_validate", { documentId, level: "full" });
  if (validation === undefined) {
    const validated = await call("ipe_validate", { documentId, level: "full" });
    evidence.phases.validate = { ok: true, diagnosticCount: validated.data.diagnosticCount ?? 0 };
    console.log(`  [validate] full native validation PASS (${evidence.phases.validate.diagnosticCount} diagnostics)`);
  } else {
    evidence.phases.validate = { ok: false, classified: true, ...validation };
    evidence.findings.push({ kind: "validate", ...validation });
    console.log(`  [validate] classified ${validation.code}`);
  }

  const renderPages = [];
  for (const page of outline.pages) {
    const pageResult = { pageId: page.id, pageNumber: page.id };
    const moved = await classify("ipe_render_preview", { documentId, pageId: page.id });
    if (moved === undefined) renderPages.push({ pageId: page.id, pass: true });
    else renderPages.push({ pageId: page.id, pass: false, code: moved.code, summary: moved.summary });
  }
  const renderPass = renderPages.filter((item) => item.pass).length;
  const renderClassified = renderPages.filter((item) => !item.pass);
  evidence.phases.renderPerPage = { pass: renderPass, classified: renderClassified.length, pages: renderPages };
  console.log(`  [render] per-page: ${renderPass} PASS / ${renderClassified.length} classified`);

  const savePath = join(dir, `${id}-copy.ipe`);
  const saved = await call("ipe_save_document", { documentId, expectedRevision: revision, targetPath: savePath, confirmation: "SAVE" });
  const savedBytes = await readFile(savePath);
  evidence.phases.saveCopy = { ok: true, revision: saved.data.revision, bytes: savedBytes.length, sha256: sha256(savedBytes) };
  console.log(`  [save] copy at ${savePath}`);

  const reopened = await call("ipe_open_document", { path: savePath });
  evidence.phases.reopen = { ok: true, pageCount: reopened.data.outline.pageCount, objectCount: reopened.data.outline.objectCount, revision: reopened.data.revision };
  console.log(`  [reopen] copied file reopened (${reopened.data.outline.pageCount} pages, ${reopened.data.outline.objectCount} objects)`);

  const pdf = await classify("ipe_export_document", { documentId, format: "pdf" });
  if (pdf === undefined) {
    const exported = await call("ipe_export_document", { documentId, format: "pdf" });
    const resources = exported.data.resources;
    const bytes = await readBinary(resources[0].uri);
    evidence.phases.pdf = { ok: true, resources: resources.length, bytes: bytes.length, header: bytes.subarray(0, 8).toString("latin1") };
    console.log(`  [pdf] ${resources.length} artifact(s), header ${evidence.phases.pdf.header}`);
  } else {
    evidence.phases.pdf = { ok: false, classified: true, ...pdf };
    evidence.findings.push({ kind: "pdf", ...pdf });
    console.log(`  [pdf] classified ${pdf.code}`);
  }

  const png = await classify("ipe_export_document", { documentId, format: "png" });
  if (png === undefined) {
    const exported = await call("ipe_export_document", { documentId, format: "png" });
    const resources = exported.data.resources;
    const first = resources[0] === undefined ? undefined : capturePng(await readBinary(resources[0].uri));
    evidence.phases.png = { ok: true, resources: resources.length, first };
    console.log(`  [png] ${resources.length} artifact(s), first ${first?.width}x${first?.height}`);
  } else {
    evidence.phases.png = { ok: false, classified: true, ...png };
    evidence.findings.push({ kind: "png", ...png });
    console.log(`  [png] classified ${png.code}`);
  }

  return evidence;
}

await client.connect(transport);

const originals = ["/usr/share/ipe/7.2.30/icons/icons.ipe", "/usr/share/ipe/7.2.30/icons/ipe_logo.ipe"];
const originalBefore = Object.fromEntries(await Promise.all(originals.map(async (path) => [path, await originalSha(path)])));

const cases = [];
let renderedPages = 0;
try {
  console.log("orientation");
  const orientation = await call("ipe_orientation", {});
  if (!Array.isArray(orientation.data.workflow)) throw new Error("orientation contract invalid");

  for (const entry of [fixture("REAL-001"), fixture("REAL-002"), fixture("REAL-003")]) {
    const evidence = await exercise(entry);
    renderedPages += evidence.phases.renderPerPage.pages.length;
    cases.push(evidence);
  }

  console.log("\n== REAL-004 raw 70216 originals rejected by the version gate");
  for (const caseEntry of [fixture("REAL-001"), fixture("REAL-002")]) {
    const temp = join(output, "inputs", `${caseEntry.id}-raw-70216.ipe`);
    await copyFile(caseEntry.sourcePath, temp);
    const classification = await classify("ipe_open_document", { path: temp });
    const ok = classification !== undefined && /Only Ipe XML format 70218 is supported/u.test(classification.summary);
    cases.push({
      id: "REAL-004", name: `raw 70216 reject (${caseEntry.name})`,
      phases: { reject: { ok, ...(classification ?? { code: "NO_ERROR", summary: "document was accepted (unexpected)" }) } },
    });
    console.log(`  [REAL-004] ${caseEntry.name.split(" ")[0].toLowerCase()} -> classified reject: ${ok}`);
    if (!ok) throw new Error("raw 70216 originals were not classified as rejects");
  }

  const originalAfter = Object.fromEntries(await Promise.all(originals.map(async (path) => [path, await originalSha(path)])));
  const unchanged = Object.keys(originalBefore).every((path) => originalBefore[path] === originalAfter[path]);
  const evidence = {
    capturedAt: new Date().toISOString().slice(0, 10),
    scenario: "m9-real-v1",
    milestone: "M9",
    subissue: 20,
    contract: "ipe-mcp/1",
    cases,
    originalsUnchanged: Object.entries(originalAfter).map(([path, sha]) => ({ path, sha256: sha, unchanged: originalBefore[path] === sha })),
    reviewSums: { caseCount: cases.length, pages: cases.reduce((sum, item) => sum + (item.phases.inspect?.pageCount ?? 0), 0), renderedPages },
    stderrProtocolSafe: !/M9 real|TUD-slides-template|olejorik/u.test(stderr),
  };
  if (!unchanged) throw new Error("a package original changed during the review run");
  if (evidence.stderrProtocolSafe !== true) throw new Error("stderr leaked review content");
  await writeFile(evidenceTarget, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nM9 REAL review complete: ${evidence.reviewSums.caseCount} cases, ${evidence.reviewSums.pages} pages, ${renderedPages} views rendered; evidence at ${evidenceTarget}`);
} finally {
  await transport.close();
}
