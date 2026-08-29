import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function connect(extraEnv: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "ipe-mcp-protocol-")); temporary.push(root);
  const stderr: string[] = [];
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/src/cli/mcp-stdio.js")], cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", IPE_MCP_WORKSPACE_ROOT: root, IPE_MCP_STATE_ROOT: join(root, ".state"), ...extraEnv }, stderr: "pipe" });
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "ipe-m8-test-host", version: "1" });
  await client.connect(transport);
  return { client, transport, stderr };
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>) {
  return result.structuredContent as { ok: boolean; kind: string; data: Record<string, unknown>; error?: { code: string }; hints: unknown[] };
}

describe("M8 real stdio protocol", () => {
  it("lists described schemas and preserves text/structured parity", async () => {
    const { client, stderr } = await connect();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ipe_orientation", "ipe_create_document", "ipe_apply_operations", "ipe_render_preview", "ipe_history"]));
      expect(listed.tools.every((tool) => tool.description && tool.inputSchema && tool.outputSchema)).toBe(true);
      const visit = (node: unknown, path = "schema"): void => {
        if (node === null || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
        const record = node as Record<string, unknown>;
        if (record.properties && typeof record.properties === "object") for (const [name, property] of Object.entries(record.properties)) {
          expect((property as { description?: string }).description, `${path}.${name}`).toBeTruthy();
        }
        for (const [name, child] of Object.entries(record)) visit(child, `${path}.${name}`);
      };
      for (const tool of listed.tools) { visit(tool.inputSchema, `${tool.name}.input`); visit(tool.outputSchema, `${tool.name}.output`); }
      const orientation = await client.callTool({ name: "ipe_orientation", arguments: {} });
      const text = orientation.content.find((item) => item.type === "text");
      expect(text?.type === "text" ? JSON.parse(text.text) : undefined).toEqual(orientation.structuredContent);
      expect(structured(orientation).data.resources).toHaveLength(5);
      const capabilities = await client.callTool({ name: "ipe_get_capabilities", arguments: {} });
      expect(JSON.stringify(capabilities.structuredContent)).not.toContain("/usr/");
    } finally { await client.close(); }
    expect(stderr.join("")).toContain("server_started");
  });

  it("normalizes SDK input rejection into ipe-mcp/1 text/structured parity", async () => {
    const { client } = await connect();
    try {
      const invalid = await client.callTool({ name: "ipe_create_document", arguments: { preset: "letter" } });
      const parsed = structured(invalid);
      expect(invalid.isError).toBe(true);
      expect(parsed).toMatchObject({ ok: false, kind: "input_validation", error: { code: "INVALID_ARGUMENT" } });
      expect(parsed.hints).toHaveLength(1);
      const text = invalid.content.find((item) => item.type === "text");
      expect(text?.type === "text" ? JSON.parse(text.text) : undefined).toEqual(invalid.structuredContent);
    } finally { await client.close(); }
  });

  it("redacts filesystem failures containing spaces on the real protocol", async () => {
    const { client } = await connect();
    try {
      const failed = await client.callTool({ name: "ipe_open_document", arguments: { path: "/private/User Name/diagram draft.ipe" } });
      const serialized = JSON.stringify(failed);
      expect(structured(failed).ok).toBe(false);
      expect(serialized).not.toMatch(/User Name|diagram draft|\/private/iu);
    } finally { await client.close(); }
  });

  it("exposes corrective stale errors, resources, and clean shutdown without stdout pollution", async () => {
    const { client, transport, stderr } = await connect();
    const created = await client.callTool({ name: "ipe_create_document", arguments: { preset: "standard", title: "private title" } });
    const data = structured(created).data as { documentId: string; outline: { pages: Array<{ id: string; layers: Array<{ id: string }> }> } };
    const page = data.outline.pages[0]!;
    const applied = await client.callTool({ name: "ipe_apply_operations", arguments: { documentId: data.documentId, expectedRevision: 0, operations: [{ op: "add_rectangle", pageId: page.id, layerId: page.layers[0]!.id, x: 1, y: 2, width: 3, height: 4 }] } });
    expect(structured(applied).ok).toBe(true);
    const objectId = (structured(applied).data.createdIds as string[]).find((id) => id.startsWith("object-"))!;
    const replaced = await client.callTool({ name: "ipe_apply_operations", arguments: { documentId: data.documentId, expectedRevision: 1, operations: [{ op: "replace_object", pageId: page.id, objectId, replacement: { kind: "path", path: { kind: "circle", center: { x: 25, y: 30 }, radius: 8, style: { fill: "0.2" } } } }] } });
    expect(structured(replaced).data).toMatchObject({ revision: 2, createdIds: [], deletedIds: [] });
    expect(((structured(replaced).data.outline as { pages: Array<{ objects: Array<{ id: string }> }> }).pages[0]!.objects)).toEqual([expect.objectContaining({ id: objectId })]);
    const stale = await client.callTool({ name: "ipe_apply_operations", arguments: { documentId: data.documentId, expectedRevision: 1, operations: [{ op: "set_metadata", title: "must not commit" }] } });
    expect(structured(stale).error?.code).toBe("REVISION_CONFLICT");
    expect(structured(stale).hints).toHaveLength(1);
    const resource = await client.readResource({ uri: `ipe://documents/${data.documentId}/summary` });
    expect(JSON.parse((resource.contents[0] as { text: string }).text).revision).toBe(2);
    await client.close();
    expect(transport.pid).toBeNull();
    expect(stderr.join("")).not.toContain("private title");
    expect(stderr.join("")).not.toContain("must not commit");
  });

  it("keeps native failures on structured protocol results and emits bounded progress", async () => {
    const { client, stderr } = await connect({ IPE_MCP_NATIVE_TIMEOUT_MS: "1" });
    try {
      const created = structured(await client.callTool({ name: "ipe_create_document", arguments: { preset: "standard" } }));
      const progress: unknown[] = [];
      const failed = await client.callTool({ name: "ipe_validate", arguments: { documentId: created.data.documentId, level: "full" } }, { timeout: 30_000, onprogress: (item) => progress.push(item) });
      expect(structured(failed).ok).toBe(false);
      expect(structured(failed).error?.code).toMatch(/^NATIVE_/u);
      expect(progress.length).toBeGreaterThanOrEqual(1);
    } finally { await client.close(); }
    expect(stderr.join("")).not.toMatch(/\.ipe|\/tmp|private/iu);
  });
});
