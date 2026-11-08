import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { listenHttp } from "../../src/mcp/http/listener.js";
import { IpeMcpService } from "../../src/mcp/service.js";

it("finishes an admitted atomic save when the HTTP client disconnects during shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "ipe-http-save-"));
  const state = join(root, "state");
  const targetPath = join(root, "saved.ipe");
  const service = await IpeMcpService.create([root], state);
  const { documentId } = await service.createDocument("standard", "Atomic save");
  const save = service.save.bind(service);
  let entered!: () => void;
  const saveEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const releaseSave = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(service, "save").mockImplementationOnce(async (...args) => {
    entered();
    await releaseSave;
    return await save(...args);
  });
  const credential = randomBytes(32);
  const listener = await listenHttp(service, { port: 0, credential, deadlineMs: 3000 });
  const controller = new AbortController();
  try {
    const result = fetch("http://127.0.0.1:" + listener.port + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + credential.toString("base64url"),
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "ipe_save_document",
      },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ipe_save_document",
          arguments: { documentId, expectedRevision: 0, targetPath, confirmation: "SAVE" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }).catch(() => null);
    await Promise.race([saveEntered, result.then(() => { throw new Error("Save did not enter the application"); })]);
    controller.abort();
    const shutdown = listener.close();
    expect(await result).toBeNull();
    await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    let closed = false;
    void shutdown.then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await shutdown;
    expect(await readFile(targetPath, "utf8")).toContain('title="Atomic save"');
    const restarted = await IpeMcpService.create([root], state);
    await restarted.recover();
    expect(restarted.inspect(documentId).revision).toBe(0);
  } finally {
    release();
    await listener.close();
    await rm(root, { recursive: true, force: true });
  }
});
