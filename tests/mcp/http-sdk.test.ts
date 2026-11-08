import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import { resultSchema } from "../../src/mcp/contracts.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { IpeMcpService } from "../../src/mcp/service.js";

it("serves both selected HTTP revisions with per-request MCP servers and shared Ipe state", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ipe-http-sdk-"));
  const service = await IpeMcpService.create([workspace], join(workspace, "state"));
  let serverInstances = 0;
  const handler = createMcpHandler(() => {
    serverInstances++;
    return createMcpServer(service);
  }, { legacy: "stateless", keepAliveMs: 0 });

  const endpoint = new URL("http://127.0.0.1/mcp");
  const observed: { method: string | null; revision: string | null; session: string | null }[] = [];
  const fetchInMemory: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await handler.fetch(request);
    observed.push({
      method: request.headers.get("mcp-method"),
      revision: request.headers.get("mcp-protocol-version"),
      session: response.headers.get("mcp-session-id"),
    });
    return response;
  };

  const identity = { name: "ipe-http-sdk-probe", version: "1" };
  const legacy = new Client(identity);
  const modern = new Client(identity, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const transport = () => new StreamableHTTPClientTransport(endpoint, { fetch: fetchInMemory });
  const callOptions = { timeout: 2000 };
  try {
    await legacy.connect(transport(), callOptions);
    const created = await legacy.callTool({ name: "ipe_create_document", arguments: { preset: "standard" } }, callOptions);
    const result = resultSchema.parse(created.structuredContent);
    expect(result).toMatchObject({ ok: true, data: { documentId: expect.any(String) } });
    const documentId = result.data?.documentId;
    await legacy.close();

    await modern.connect(transport(), callOptions);
    const discovery = await modern.discover(callOptions);
    expect(discovery.capabilities).toMatchObject({ tools: {}, resources: {} });
    const orientation = await modern.callTool({ name: "ipe_orientation", arguments: {} }, callOptions);
    expect(orientation.structuredContent).toMatchObject({ ok: true, contractVersion: "ipe-mcp/1" });
    const text = orientation.content?.find((block) => block.type === "text");
    expect(JSON.parse(text?.text ?? "null")).toEqual(orientation.structuredContent);
    const uri = `ipe://documents/${documentId}/summary`;
    const summary = await modern.readResource({ uri }, callOptions);
    expect(summary.contents).toEqual([expect.objectContaining({ uri, text: expect.any(String) })]);

    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ revision: "2025-11-25", method: null }),
      expect.objectContaining({ revision: "2026-07-28", method: "server/discover" }),
      expect.objectContaining({ revision: "2026-07-28", method: "tools/call" }),
      expect.objectContaining({ revision: "2026-07-28", method: "resources/read" }),
    ]));
    expect(observed.every(({ session }) => session === null)).toBe(true);
    expect(serverInstances).toBeGreaterThanOrEqual(4);
  } finally {
    await legacy.close();
    await modern.close();
    await handler.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
