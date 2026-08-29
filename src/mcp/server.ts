import type { CallToolResult, ResourceLink } from "@modelcontextprotocol/server";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";

import { MCP_CONTRACT_VERSION, documentIdSchema, entityIdSchema, operationSchema, resultSchema, revisionSchema, viewBuildSchema, type PublicResult } from "./contracts.js";
import { failure, inputValidationFailure, safeLog, success } from "./errors.js";
import { IpeMcpService } from "./service.js";
import { DOCUMENT_SHAPE_LIMITS, MCP_LIMITS } from "../limits.js";

export const SERVER_INSTRUCTIONS = `Ipe MCP ${MCP_CONTRACT_VERSION}. Start with ipe_orientation, then create/open and retain exact document/page/layer/view/object IDs. Every mutation requires the latest expectedRevision; on REVISION_CONFLICT inspect and retry. Validate before save/export. DELETE, SAVE, UNDO, and RESTORE require explicit confirmation tokens. Binary outputs are resource links: read only the artifact needed.`;

type LinkInput = { readonly uri: string; readonly name: string; readonly mimeType: string; readonly bytes?: number };
function response(result: PublicResult, links: readonly LinkInput[] = []): CallToolResult {
  const resources: ResourceLink[] = links.map((link) => ({ type: "resource_link", uri: link.uri, name: link.name, mimeType: link.mimeType, ...(link.bytes === undefined ? {} : { size: link.bytes }) }));
  return { content: [{ type: "text", text: JSON.stringify(result) }, ...resources], structuredContent: result, ...(!result.ok ? { isError: true } : {}) };
}

async function run(kind: string, operation: () => Promise<PublicResult>, links?: (result: PublicResult) => readonly LinkInput[]): Promise<CallToolResult> {
  try { const result = await operation(); safeLog("tool_complete", { tool: kind, ok: true }); return response(result, links?.(result)); }
  catch (error) { const result = failure(kind, error); safeLog("tool_complete", { tool: kind, ok: false, code: result.error?.code ?? "unknown" }); return response(result); }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

export function createMcpServer(service: IpeMcpService): McpServer {
  const server = new McpServer({ name: "ipe-mcp", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {}, resources: {} } });
  // SDK v2 validates registered schemas before invoking callbacks. Its default
  // error is text-only, so replace that last-resort formatter with the same
  // versioned text/structured envelope used by tool handlers.
  (server as unknown as { createToolError: (message: string) => CallToolResult }).createToolError = () => response(inputValidationFailure());

  server.registerTool("ipe_orientation", {
    title: "Orient to Ipe MCP", description: "Stable bootstrap: returns workflow, contract version, limits, resource routes, and revision/write rules without invoking native tools.",
    inputSchema: z.object({}).strict(), outputSchema: resultSchema, annotations: readOnly,
  }, async () => response(success("orientation", "Use create/open → inspect → revision-guarded mutation → validate → save/export; binary results stay behind resource links.", {
    contractVersion: MCP_CONTRACT_VERSION, instructionsVersion: 1, workflow: ["ipe_create_document|ipe_open_document", "ipe_inspect", "ipe_apply_operations|ipe_compose_slide|ipe_build_views", "ipe_validate", "ipe_save_document|ipe_export_document"],
    invariants: ["Use exact IDs from results/resources", "Every mutation needs current expectedRevision", "Delete/save/undo/restore need confirmation", "Read binary resources only on demand", "Duplicate create calls deliberately create distinct local sessions"],
    resources: ["ipe://documents/{documentId}/summary", "ipe://documents/{documentId}/source", "ipe://documents/{documentId}/diagnostics", "ipe://previews/{artifactId}", "ipe://artifacts/{artifactId}"], limits: { operationsPerBatch: MCP_LIMITS.operationsPerBatch, inspectObjectsDefault: MCP_LIMITS.inspectObjectsDefault, maxInspectObjects: MCP_LIMITS.maxInspectObjects, sourceResourceBytes: MCP_LIMITS.sourceResourceBytes, hints: MCP_LIMITS.maxHints, documentShape: DOCUMENT_SHAPE_LIMITS },
  })));

  server.registerTool("ipe_get_capabilities", {
    title: "Get Ipe capabilities", description: "Reports structural/native mode, fixed local backends, format and supported semantic surfaces; call before full validation or export.", inputSchema: z.object({}).strict(), outputSchema: resultSchema, annotations: readOnly,
  }, async () => await run("capabilities", async () => {
    const capabilities = await service.capabilities();
    const publicTool = (tool: { readonly package: string; readonly packageVersion?: string }) => ({ package: tool.package, ...(tool.packageVersion === undefined ? {} : { packageVersion: tool.packageVersion }) });
    const publicCapabilities = { ...capabilities, ...(capabilities.toolchain === undefined ? {} : { toolchain: Object.fromEntries(Object.entries(capabilities.toolchain).map(([name, tool]) => [name, publicTool(tool)])) }), ...(capabilities.validators === undefined ? {} : { validators: Object.fromEntries(Object.entries(capabilities.validators).map(([name, tool]) => [name, { package: tool.package }])) }) };
    return success("capabilities", `Ipe backend mode is ${capabilities.mode}.`, { format: 70218, contractVersion: MCP_CONTRACT_VERSION, capabilities: publicCapabilities });
  }));

  server.registerTool("ipe_create_document", {
    title: "Create Ipe document", description: "Creates a private recoverable working session; it does not write the eventual destination until ipe_save_document.",
    inputSchema: z.object({ preset: z.enum(["standard", "16:9"]).describe("Global Ipe page layout; choose 16:9 for presentations."), title: z.string().max(MCP_LIMITS.operationsPerBatch*0+500).optional().describe("Optional document title; duplicate creates are intentionally allowed because this is a local working session.") }).strict(), outputSchema: resultSchema, annotations: mutation,
  }, async ({ preset, title }) => await run("create_document", async () => { const data = await service.createDocument(preset, title); return success("create_document", `Created recoverable ${preset} working session at revision 0.`, data, [{ priority: "nudge", code: "INSPECT_IDS", message: "Use returned exact IDs or call ipe_inspect before composing." }]); }));

  server.registerTool("ipe_open_document", {
    title: "Open Ipe document", description: "Opens an allowed local .ipe path into a private working copy; the source stays byte-identical until explicit save.",
    inputSchema: z.object({ path: z.string().min(1).max(MCP_LIMITS.pathChars).describe("Local .ipe path inside a configured workspace root; remote URLs and symlink escapes are rejected.") }).strict(), outputSchema: resultSchema, annotations: mutation,
  }, async ({ path }) => await run("open_document", async () => { const data = await service.openDocument(path); return success("open_document", "Opened a private working copy; the source was not modified.", data); }));

  server.registerTool("ipe_inspect", {
    title: "Inspect Ipe document", description: "Returns bounded outline, exact actionable IDs, counts and an explicit truncation flag. Read the summary resource for the same stable orientation shape.",
    inputSchema: z.object({ documentId: documentIdSchema, maxObjects: z.number().int().min(1).max(MCP_LIMITS.maxInspectObjects).default(Number(MCP_LIMITS.inspectObjectsDefault)).describe("Maximum object identities returned across all pages; counts remain exact when truncated.") }).strict(), outputSchema: resultSchema, annotations: readOnly,
  }, async ({ documentId, maxObjects }) => await run("inspect", async () => { const data = service.inspect(documentId, maxObjects); const truncated = (data.outline as { truncated: boolean }).truncated; return success("inspect", `Document revision ${data.revision}${truncated ? "; object index is truncated" : ""}.`, data, truncated ? [{ priority: "warning", code: "INDEX_TRUNCATED", message: "Increase maxObjects up to 500 or inspect the returned page IDs; never infer omitted IDs." }] : []); }));

  server.registerTool("ipe_apply_operations", {
    title: "Apply atomic Ipe operations", description: "Applies up to 64 typed M0-M6 operations atomically: metadata; page/layer/view CRUD and reorder; paths/text/images/symbols/groups/object transforms; styles; and row/column/grid/stack layout. Any invalid ID or invariant rolls back the whole batch. Raw XML is not accepted.",
    inputSchema: z.object({ documentId: documentIdSchema, expectedRevision: revisionSchema, operations: z.array(operationSchema).min(1).max(MCP_LIMITS.operationsPerBatch).describe("Ordered typed operations committed as one revision or not at all."), confirmation: z.literal("DELETE").optional().describe("Required only when the batch contains a delete operation.") }).strict(), outputSchema: resultSchema, annotations: destructive,
  }, async ({ documentId, expectedRevision, operations, confirmation }) => await run("apply_operations", async () => { const data = await service.apply(documentId, expectedRevision, operations, confirmation); return success("apply_operations", `Applied ${operations.length} operations atomically; revision is ${data.revision}.`, data); }));

  server.registerTool("ipe_compose_slide", {
    title: "Compose semantic slide", description: "Adds one layout-compatible semantic slide with page/layer/view IDs; then use apply_operations to populate its exact layer IDs.",
    inputSchema: z.object({ documentId: documentIdSchema, expectedRevision: revisionSchema, preset: z.enum(["standard", "16:9"]).describe("Must match the document global layout."), name: z.string().min(1).max(MCP_LIMITS.nameChars).optional().describe("Unique destination name; safe suffixes resolve duplicates."), title: z.string().max(MCP_LIMITS.titleChars).optional().describe("Visible semantic page title metadata."), notes: z.string().max(MCP_LIMITS.notesChars).optional().describe("Ipe page notes, replicated across its views."), layers: z.array(z.string().regex(/^\S+$/u).max(MCP_LIMITS.nameChars)).min(1).max(MCP_LIMITS.composeLayersMax).optional().describe("Whitespace-free layer names; defaults to content.") }).strict(), outputSchema: resultSchema, annotations: mutation,
  }, async ({ documentId, expectedRevision, ...input }) => await run("compose_slide", async () => { const data = await service.compose(documentId, expectedRevision, input); return success("compose_slide", `Composed slide ${data.pageId}; revision is ${data.revision}.`, data); }));

  server.registerTool("ipe_build_views", {
    title: "Build reveal, motion, scroll, pan, or transition views", description: "Exposes the stabilized M7 facade for bounded reveal, discrete motion, clipped panel scroll, camera pan, and viewer-aware transition assignment; never claims continuous animation.",
    inputSchema: z.object({ documentId: documentIdSchema, expectedRevision: revisionSchema, build: viewBuildSchema.describe("Reveal groups or discrete motion using exact page/object/layer IDs.") }).strict(), outputSchema: resultSchema, annotations: mutation,
  }, async ({ documentId, expectedRevision, build }) => await run("build_views", async () => { const data = await service.buildViews(documentId, expectedRevision, build); return success("build_views", `Built independently renderable static views; revision is ${data.revision}.`, data, data.diagnostics.slice(0, MCP_LIMITS.maxHints).map((item) => ({ priority: item.severity === "warning" ? "warning" as const : "nudge" as const, code: item.code, message: item.message }))); }));

  server.registerTool("ipe_validate", {
    title: "Validate Ipe document", description: "Runs structural validation or the bounded full native/style/LaTeX/PDF/render pipeline. Full validation can be slow and reports recoverable native failures.",
    inputSchema: z.object({ documentId: documentIdSchema, level: z.enum(["structural", "full"]).describe("structural is process-free; full uses attested fixed native commands with a bounded deadline.") }).strict(), outputSchema: resultSchema, annotations: readOnly,
  }, async ({ documentId, level }, ctx) => await run("validate", async () => { const token = ctx.mcpReq._meta?.progressToken; if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: 0, total: 1, message: `Starting ${level} validation` } }); const data = await service.validate(documentId, level); if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 1, message: "Validation complete" } }); return success("validate", `${level} validation ${data.ok ? "passed" : "failed"} with ${data.diagnosticCount} diagnostics.`, data); }));

  server.registerTool("ipe_render_preview", {
    title: "Render Ipe preview", description: "Renders bounded fixed-paper PNG previews and returns resource links only; omit IDs for every view, or provide exact page/view IDs to narrow.",
    inputSchema: z.object({ documentId: documentIdSchema, pageId: entityIdSchema.optional().describe("Exact page ID from inspect; omit for all pages."), viewId: entityIdSchema.optional().describe("Exact view ID from inspect; omit for all views.") }).strict(), outputSchema: resultSchema, annotations: readOnly,
  }, async ({ documentId, pageId, viewId }, ctx) => { let artifacts: Awaited<ReturnType<typeof service.render>> = []; return await run("render_preview", async () => { const token = ctx.mcpReq._meta?.progressToken; if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: 0, total: 1, message: "Starting bounded PNG render" } }); artifacts = await service.render(documentId, pageId, viewId); if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 1, message: "Render complete" } }); return success("render_preview", `Rendered ${artifacts.length} PNG preview resource(s).`, { documentId, resources: artifacts.map((item) => ({ uri: service.artifacts.uri(item), mediaType: item.mediaType, bytes: item.data.length, sha256: item.sha256, metadata: item.metadata })) }); }, () => artifacts.map((item) => ({ uri: service.artifacts.uri(item), name: item.name, mimeType: item.mediaType, bytes: item.data.length }))); });

  server.registerTool("ipe_save_document", {
    title: "Save Ipe document", description: "Atomically writes the current working copy to an allowed local target after explicit confirmation, with source-change detection and recoverable snapshot when replacing.",
    inputSchema: z.object({ documentId: documentIdSchema, expectedRevision: revisionSchema, targetPath: z.string().min(1).max(MCP_LIMITS.pathChars).describe("Destination inside an allowed workspace root; traversal and symlink escape are rejected."), confirmation: z.literal("SAVE").describe("Explicit user-authorized destructive confirmation token.") }).strict(), outputSchema: resultSchema, annotations: destructive,
  }, async ({ documentId, expectedRevision, targetPath }) => await run("save_document", async () => { const data = await service.save(documentId, expectedRevision, targetPath); return success("save_document", `Saved revision ${data.revision} atomically; target path is intentionally omitted from the result.`, data); }));

  server.registerTool("ipe_export_document", {
    title: "Export Ipe document", description: "Exports validated PDF or per-view PNG artifacts with bounded native commands; returns resource links rather than binary blobs.",
    inputSchema: z.object({ documentId: documentIdSchema, format: z.enum(["pdf", "png"]).describe("PDF includes deterministic page/view mapping; PNG returns one fixed-paper artifact per view.") }).strict(), outputSchema: resultSchema, annotations: readOnly,
  }, async ({ documentId, format }, ctx) => { let artifacts: Awaited<ReturnType<typeof service.export>> = []; return await run("export_document", async () => { const token = ctx.mcpReq._meta?.progressToken; if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: 0, total: 1, message: `Starting bounded ${format.toUpperCase()} export` } }); artifacts = await service.export(documentId, format); if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 1, message: "Export complete" } }); return success("export_document", `Exported ${artifacts.length} ${format.toUpperCase()} artifact resource(s).`, { documentId, format, resources: artifacts.map((item) => ({ uri: service.artifacts.uri(item), mediaType: item.mediaType, bytes: item.data.length, sha256: item.sha256, metadata: item.metadata })) }); }, () => artifacts.map((item) => ({ uri: service.artifacts.uri(item), name: item.name, mimeType: item.mediaType, bytes: item.data.length }))); });

  server.registerTool("ipe_history", {
    title: "Snapshot, undo, restore, or recover", description: "Lists/captures private recovery snapshots, promotes the previous working revision, restores a snapshot, or recovers durable sessions after restart. Paths stay private.",
    inputSchema: z.object({ documentId: documentIdSchema.optional().describe("Required except for recover, which scans the configured private state root."), action: z.enum(["list", "snapshot", "undo", "restore", "recover"]).describe("History action; undo/restore are revisioned mutations."), expectedRevision: revisionSchema.optional().describe("Required for snapshot, undo, and restore."), snapshotId: z.string().uuid().optional().describe("Opaque ID returned by snapshot/list; required to select a restore target."), confirmation: z.enum(["UNDO", "RESTORE"]).optional().describe("Required for undo or restore respectively.") }).strict(), outputSchema: resultSchema, annotations: destructive,
  }, async ({ documentId, action, expectedRevision, snapshotId, confirmation }) => await run("history", async () => {
    if (action === "recover") { const recovered = await service.recover(); return success("history", `Recovered ${recovered.length} durable session(s).`, { recovered }); }
    if (documentId === undefined) throw new Error(`${action} requires documentId`);
    if (action === "undo" && confirmation !== "UNDO") throw new Error("undo requires confirmation='UNDO'");
    if (action === "restore" && confirmation !== "RESTORE") throw new Error("restore requires confirmation='RESTORE'");
    if (action === "restore" && snapshotId === undefined) throw new Error("restore requires snapshotId from snapshot/list");
    const data = await service.history(documentId, action, expectedRevision, snapshotId); return success("history", `History action ${action} completed.`, data);
  }));

  server.registerResource("ipe-document", new ResourceTemplate("ipe://documents/{documentId}/{kind}", { list: undefined }), { title: "Bounded Ipe document state", description: "Summary, canonical source, or diagnostics for a live session. Source declares truncation metadata when bounded.", mimeType: "application/json" }, async (uri, variables) => {
    const kind = String(variables.kind); if (!(["summary", "source", "diagnostics"] as const).includes(kind as "summary")) throw new Error("resource kind must be summary, source, or diagnostics");
    const resource = service.documentResource(String(variables.documentId), kind as "summary" | "source" | "diagnostics");
    return { contents: [{ uri: uri.href, mimeType: resource.mimeType, text: resource.text, ...(resource.metadata === undefined ? {} : { _meta: resource.metadata }) }] };
  });
  for (const family of ["artifacts", "previews"] as const) server.registerResource(`ipe-${family}`, new ResourceTemplate(`ipe://${family}/{artifactId}`, { list: undefined }), { title: family === "artifacts" ? "Ipe binary artifact" : "Ipe PNG preview", description: "Explicit on-demand binary read; tool results contain only a resource link and metadata.", mimeType: family === "artifacts" ? "application/octet-stream" : "image/png" }, async (uri, variables) => {
    const item = service.artifactResource(family === "artifacts" ? "artifact" : "preview", String(variables.artifactId));
    return { contents: [{ uri: uri.href, mimeType: item.mediaType, blob: item.data.toString("base64"), _meta: { bytes: item.data.length, sha256: item.sha256, ...item.metadata } }] };
  });
  return server;
}
