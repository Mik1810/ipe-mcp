#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const output = resolve(process.argv[2] ?? "fixtures/conformance/m8/generated/sdk-host");
await mkdir(output, { recursive: true });
const state = join(output, ".state");
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/src/cli/mcp-stdio.js")], cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", IPE_MCP_WORKSPACE_ROOT: output, IPE_MCP_STATE_ROOT: state }, stderr: "pipe" });
let stderr = ""; transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
const client = new Client({ name: "ipe-m8-independent-sdk-host", version: "1.0.0" });
const call = async (name, args, options) => {
  const result = await client.callTool({ name, arguments: args }, options);
  if (result.structuredContent === undefined) throw new Error(`${name}: missing structuredContent`);
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text" || JSON.stringify(JSON.parse(text.text)) !== JSON.stringify(result.structuredContent)) throw new Error(`${name}: text/structured parity`);
  return result.structuredContent;
};
const readBinary = async (uri) => Buffer.from((await client.readResource({ uri })).contents[0].blob, "base64");

await client.connect(transport);
try {
  await call("ipe_orientation", {});
  const created = await call("ipe_create_document", { preset: "16:9", title: "M8 portable scenario" });
  const page = created.data.outline.pages[0]; const layerId = page.layers[0].id;
  const added = await call("ipe_apply_operations", { documentId: created.data.documentId, expectedRevision: 0, operations: [
    { op: "add_rectangle", pageId: page.id, layerId, x: 160, y: 250, width: 500, height: 160, stroke: "0", fill: "0.8" },
  ] });
  const snapshot = await call("ipe_history", { documentId: created.data.documentId, action: "snapshot", expectedRevision: 1 });
  await call("ipe_apply_operations", { documentId: created.data.documentId, expectedRevision: 1, operations: [{ op: "set_metadata", author: "temporary" }] });
  const stale = await call("ipe_apply_operations", { documentId: created.data.documentId, expectedRevision: 1, operations: [{ op: "set_metadata", title: "stale" }] });
  if (stale.ok || stale.error.code !== "REVISION_CONFLICT") throw new Error("stale write was not rejected");
  const undone = await call("ipe_history", { documentId: created.data.documentId, action: "undo", expectedRevision: 2, confirmation: "UNDO" });
  const restored = await call("ipe_history", { documentId: created.data.documentId, action: "restore", expectedRevision: undone.data.revision, snapshotId: snapshot.data.snapshotId, confirmation: "RESTORE" });
  const validation = await call("ipe_validate", { documentId: created.data.documentId, level: "full" }, { onprogress: () => undefined, timeout: 180_000 });
  if (!validation.ok || !validation.data.ok) throw new Error(`full validation failed: ${JSON.stringify(validation)}`);
  const ipePath = join(output, "portable-scenario.ipe");
  await call("ipe_save_document", { documentId: created.data.documentId, expectedRevision: restored.data.revision, targetPath: ipePath, confirmation: "SAVE" });
  const preview = await call("ipe_render_preview", { documentId: created.data.documentId }, { onprogress: () => undefined, timeout: 180_000 });
  const pdf = await call("ipe_export_document", { documentId: created.data.documentId, format: "pdf" }, { onprogress: () => undefined, timeout: 180_000 });
  const png = await call("ipe_export_document", { documentId: created.data.documentId, format: "png" }, { onprogress: () => undefined, timeout: 180_000 });
  const previewData = await readBinary(preview.data.resources[0].uri);
  const pdfData = await readBinary(pdf.data.resources[0].uri);
  const pngData = await readBinary(png.data.resources[0].uri);
  await writeFile(join(output, "portable-scenario-preview.png"), previewData);
  await writeFile(join(output, "portable-scenario.pdf"), pdfData);
  await writeFile(join(output, "portable-scenario.png"), pngData);
  const source = await readFile(ipePath, "utf8");
  if (!source.includes('title="M8 portable scenario"') || !source.includes("160 250 m 660 250 l 660 410 l 160 410 l h") || !source.startsWith("<?xml")) throw new Error("saved semantic Ipe evidence invalid");
  if (!pdfData.subarray(0, 5).equals(Buffer.from("%PDF-")) || !pngData.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("binary signatures invalid");
  process.stdout.write(`${JSON.stringify({ host: "official-typescript-sdk", protocol: "stdio", scenario: "portable-m8-v1", documentId: created.data.documentId, revision: restored.data.revision, staleRollback: "PASS", undoRestore: "PASS", fullValidation: "PASS", resourcesRead: 3, artifacts: { ipeBytes: Buffer.byteLength(source), pdfBytes: pdfData.length, pngBytes: pngData.length }, stderrProtocolSafe: !stderr.includes("M8 portable scenario") })}\n`);
} finally { await client.close(); }
