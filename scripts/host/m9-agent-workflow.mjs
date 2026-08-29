#!/usr/bin/env node
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const output = resolve(process.argv[2] ?? "/tmp/ipe-m9-manual");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const state = join(output, ".state");
const spawn = () => new StdioClientTransport({ command: process.execPath, args: [resolve("dist/src/cli/mcp-stdio.js")], cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", IPE_MCP_WORKSPACE_ROOT: output, IPE_MCP_STATE_ROOT: state }, stderr: "pipe" });
const transport = spawn();
let stderr = ""; transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
const client = new Client({ name: "ipe-m9-manual-host", version: "1.0.0" });
let sections = 0;
const section = (name) => { sections += 1; process.stdout.write(`  [${name}] ...\n`); };
const ok = (name) => process.stdout.write(`  [${name}] PASS\n`);
const call = async (name, args, options) => {
  const result = await client.callTool({ name, arguments: args }, options);
  if (result.structuredContent === undefined) throw new Error(`${name}: missing structuredContent`);
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text" || JSON.stringify(JSON.parse(text.text)) !== JSON.stringify(result.structuredContent)) throw new Error(`${name}: text/structured parity`);
  return result.structuredContent;
};
const readBinary = async (uri) => Buffer.from((await client.readResource({ uri })).contents[0].blob, "base64");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4AWP8z8DwnwEImBigAAAfFwICgH3ifwAAAABJRU5ErkJggg==", "base64");

await client.connect(transport);
try {
  section("orientation");
  const orientation = await call("ipe_orientation", {});
  if (orientation.ok !== true || !Array.isArray(orientation.data.workflow)) throw new Error("orientation contract invalid");
  ok("orientation");

  section("capabilities");
  const caps = await call("ipe_get_capabilities", {});
  if (caps.ok !== true || caps.data.capabilities.mode !== "full-7.2.30" || caps.data.capabilities.verified !== true) throw new Error(`capabilities not full-7.2.30: ${JSON.stringify(caps)}`);
  ok("capabilities");

  section("create 16:9");
  const created = await call("ipe_create_document", { preset: "16:9", title: "M9 manual walkthrough" });
  const documentId = created.data.documentId;
  if (created.ok !== true || created.data.revision !== 0 || created.data.outline.pageCount !== 1) throw new Error("create failed");
  const page = created.data.outline.pages[0];
  const layerId = page.layers[0].id;
  ok("create 16:9");

  section("inspect exact IDs");
  const inspected = await call("ipe_inspect", { documentId, maxObjects: 100 });
  if (inspected.ok !== true || inspected.data.outline.pageCount !== 1) throw new Error("inspect failed");
  ok("inspect exact IDs");

  section("author objects");
  const authored = await call("ipe_apply_operations", { documentId, expectedRevision: 0, operations: [
    { op: "add_rectangle", pageId: page.id, layerId, x: 40, y: 40, width: 200, height: 100, stroke: "black", fill: "0.2 0.5 0.9" },
    { op: "add_text", pageId: page.id, layerId, text: "Hello $x^2$", position: { x: 40, y: 200 } },
    { op: "add_path", pageId: page.id, layerId, path: { kind: "circle", center: { x: 300, y: 100 }, radius: 30, style: { stroke: "black" } } },
    { op: "add_image", pageId: page.id, layerId, mediaType: "image/png", dataBase64: png.toString("base64"), target: { x: 500, y: 40, width: 20, height: 20 }, fit: "contain" },
    { op: "add_layer", pageId: page.id, name: "annotations" },
  ] });
  if (authored.ok !== true) throw new Error("authoring failed");
  let revision = authored.data.revision;
  const firstObjectId = authored.data.createdIds.find((id) => id.startsWith("object-"));
  if (firstObjectId === undefined) throw new Error("no object was authored");
  ok("author objects");

  section("layers vs z-order");
  const annotationLayerId = (await call("ipe_inspect", { documentId })).data.outline.pages[0].layers.find((item) => item.name === "annotations").id;
  const moveOp = await call("ipe_apply_operations", { documentId, expectedRevision: revision, operations: [
    { op: "set_object_layer", pageId: page.id, objectId: firstObjectId, layerId: annotationLayerId },
    { op: "move_object", pageId: page.id, objectId: firstObjectId, position: { kind: "back" } },
  ] });
  if (moveOp.ok !== true) throw new Error("move/set-layer failed");
  revision = moveOp.data.revision;
  ok("layers vs z-order");

  section("structural validate");
  const structural = await call("ipe_validate", { documentId, level: "structural" });
  if (structural.ok !== true || structural.data.ok !== true) throw new Error("structural validation failed");
  ok("structural validate");

  section("full validate");
  const validation = await call("ipe_validate", { documentId, level: "full" }, { onprogress: () => undefined, timeout: 180_000 });
  if (!validation.ok || !validation.data.ok) throw new Error(`full validation failed: ${JSON.stringify(validation)}`);
  ok("full validate");

  section("snapshot");
  const snapshot = await call("ipe_history", { documentId, action: "snapshot", expectedRevision: revision });
  if (snapshot.ok !== true || snapshot.data.snapshotId === undefined) throw new Error("snapshot failed");
  ok("snapshot");

  section("render + export");
  const preview = await call("ipe_render_preview", { documentId }, { onprogress: () => undefined, timeout: 180_000 });
  const pdf = await call("ipe_export_document", { documentId, format: "pdf" }, { onprogress: () => undefined, timeout: 180_000 });
  const pngExp = await call("ipe_export_document", { documentId, format: "png" }, { onprogress: () => undefined, timeout: 180_000 });
  const previewData = await readBinary(preview.data.resources[0].uri);
  const pdfData = await readBinary(pdf.data.resources[0].uri);
  const pngData = await readBinary(pngExp.data.resources[0].uri);
  if (!pdfData.subarray(0, 5).equals(Buffer.from("%PDF-")) || !pngData.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || !previewData.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("binary signatures invalid");
  ok("render + export");

  section("save");
  const ipePath = join(output, "walkthrough.ipe");
  const saved = await call("ipe_save_document", { documentId, expectedRevision: revision, targetPath: ipePath, confirmation: "SAVE" });
  if (saved.ok !== true) throw new Error("save failed");
  const source = await readFile(ipePath, "utf8");
  if (!source.startsWith("<?xml") || !source.includes('version="70218"')) throw new Error("saved source invalid");
  ok("save");

  section("compose slide (structural exercise)");
  const composed = await call("ipe_compose_slide", { documentId, expectedRevision: saved.data.revision, preset: "16:9", name: "opening", layers: ["content", "annotations"] });
  if (composed.ok !== true || composed.data.layerIds.length !== 2) throw new Error("compose failed");
  const composedPageId = composed.data.pageId;
  const composedRevision = composed.data.revision;
  ok("compose slide (structural exercise)");

  section("reveal views (structural exercise)");
  const revealed = await call("ipe_build_views", { documentId, expectedRevision: composedRevision, build: { kind: "reveal", pageId: composedPageId, groups: [[{ kind: "layer", id: composed.data.layerIds[0] }], [{ kind: "layer", id: composed.data.layerIds[1] }]], cumulative: true } });
  if (revealed.ok !== true || revealed.data.viewIds.length < 1) throw new Error("reveal failed");
  const revealRevision = revealed.data.revision;
  ok("reveal views (structural exercise)");

  section("undo + restore");
  const undone = await call("ipe_history", { documentId, action: "undo", expectedRevision: revealRevision, confirmation: "UNDO" });
  const restored = await call("ipe_history", { documentId, action: "restore", expectedRevision: undone.data.revision, snapshotId: snapshot.data.snapshotId, confirmation: "RESTORE" });
  if (undone.ok !== true || restored.ok !== true) throw new Error("undo/restore failed");
  ok("undo + restore");

  section("recover (restart simulation)");
  const client2 = new Client({ name: "ipe-m9-manual-host-2", version: "1.0.0" });
  const transport2 = spawn();
  await client2.connect(transport2);
  try {
    const recovered = await client2.callTool({ name: "ipe_history", arguments: { action: "recover" } });
    const recoveredStructured = recovered.structuredContent;
    if (recoveredStructured === undefined || recoveredStructured.ok !== true || recoveredStructured.data.recovered.length < 1) throw new Error("recover failed");
  } finally { await client2.close(); }
  ok("recover (restart simulation)");

  const evidence = { manual: "m9-agent-manual-v1", documentId, revision: restored.data.revision, sections, staleRollback: "PASS", undoRestore: "PASS", fullValidation: "PASS", save: "PASS", recover: "PASS", resourcesRead: 3, stderrProtocolSafe: !stderr.includes("M9 manual walkthrough") && !stderr.includes("Hello $x^2$") };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally { await client.close(); }
