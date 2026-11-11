import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, expect, it } from "vitest";

import { authorDeck, deckSpecSchema } from "../../src/cli/deck-spec.js";
import { ipeDocumentCodec } from "../../src/core/ipe-document-codec.js";

const exec = promisify(execFile);
const fixture = resolve("fixtures/decks/lattice-paths.json");
const deckCli = resolve("dist/src/cli/deck.js");
const nativeAvailable = (await Promise.all(
  ["ipescript", "ipetoipe", "iperender", "pdflatex", "pdftotext"].map((tool) =>
    access("/usr/bin/" + tool).then(() => true, () => false)),
)).every(Boolean);

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "ipe-deck-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("creates an editable deck independently and refuses to overwrite it", async () => {
  const root = await workspace();
  const output = join(root, "deck.ipe");
  const args = [deckCli, fixture, "--out", output];
  const { stdout } = await exec(process.execPath, args, { cwd: root });
  expect(stdout).toContain("structural validation passed");
  const editable = await readFile(output, "utf8");
  const { pages } = ipeDocumentCodec.parse(editable);
  expect(pages.map((page) => page.views.length)).toEqual([3, 1]);
  expect(pages[0]!.views[1]!.activeLayerId).toBe(pages[0]!.layers[1]!.id);
  expect(editable).toContain("Route count:");
  expect(editable).toContain("<path");
  await expect(exec(process.execPath, args, { cwd: root })).rejects.toMatchObject({
    code: 1, stderr: expect.stringContaining("Choose a new filename."),
  });
  expect(await readFile(output, "utf8")).toBe(editable);
  expect(await readdir(root)).toEqual(["deck.ipe"]);
});

it("rejects unsupported operations and unresolved layer names with corrective diagnostics", async () => {
  const root = await workspace();
  const specPath = join(root, "unsupported.json");
  const output = join(root, "deck.ipe");
  const spec = JSON.parse(await readFile(fixture, "utf8"));
  const args = [deckCli, specPath, "--out", output];
  const originalOp = spec.slides[0].objects[0].op;
  spec.slides[0].objects[0].op = "add_image";
  await writeFile(specPath, JSON.stringify(spec));
  await expect(exec(process.execPath, args)).rejects.toMatchObject({
    code: 1, stderr: expect.stringMatching(/add_text.*add_rectangle.*slides\[0\]\.objects\[0\]\.op/su),
  });
  spec.slides[0].objects[0].op = originalOp;
  spec.slides[0].objects[0].layer = "undeclared";
  await writeFile(specPath, JSON.stringify(spec));
  await expect(exec(process.execPath, args)).rejects.toMatchObject({
    code: 1, stderr: expect.stringMatching(/Slide 1: Unknown layer "undeclared". Declare it/u),
  });
  await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("identifies a missing native tool and points to installation and editable-only mode", async () => {
  const root = await workspace();
  const output = join(root, "deck.ipe");
  const pdf = join(root, "deck.pdf");
  const preload = join(root, "missing-native.mjs");
  const capabilities = pathToFileURL(resolve("dist/src/native/capabilities.js")).href;
  // Point one real adapter probe at an absent executable without changing WSL.
  await writeFile(preload, 'import { DEFAULT_NATIVE_EXECUTABLES } from ' + JSON.stringify(capabilities) +
    ';\nDEFAULT_NATIVE_EXECUTABLES.ipetoipe = ' + JSON.stringify(join(root, "missing-ipetoipe")) + ';\n');
  const args = ["--import", preload, deckCli, fixture, "--out", output];
  await expect(exec(process.execPath, [...args, "--pdf", pdf])).rejects.toMatchObject({
    code: 1, stderr: expect.stringMatching(/NATIVE_UNAVAILABLE.*ipetoipe is unavailable.*Install.*omit --pdf/su),
  });
  await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(pdf)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(exec(process.execPath, args)).resolves.toMatchObject({
    stdout: expect.stringContaining("structural validation passed"),
  });
});

// Compare complete serialized editable content apart from generated object identities.
const editableContent = (source: string) =>
  source.replace(/ (?:custom="ipe-mcp:[0-9a-f-]+"|x-ipe-mcp-id="object-[0-9a-f]+")/gu, "");

it.skipIf(!nativeAvailable)("matches CLI and real MCP stdio decks and the physical PDF reveal order", async () => {
  const root = await workspace();
  const cliIpe = join(root, "cli.ipe");
  const cliPdf = join(root, "cli.pdf");
  const cli = await exec(process.execPath, [deckCli, fixture, "--out", cliIpe, "--pdf", cliPdf]);
  expect(cli.stdout).toContain("native validation passed, 4 PDF views");

  const mcpRoot = join(root, "mcp");
  await mkdir(mcpRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/src/cli/mcp-stdio.js")],
    env: { PATH: process.env.PATH ?? "", IPE_MCP_WORKSPACE_ROOT: mcpRoot, IPE_MCP_STATE_ROOT: join(mcpRoot, ".state") },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "ipe-deck-equivalence", version: "1" });
  await client.connect(transport);
  try {
    async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const result = await client.callTool({ name, arguments: args }, { timeout: 60_000 });
      const envelope = result.structuredContent as { ok: boolean; data: T; error?: { code: string } };
      expect(result.isError, name).not.toBe(true);
      expect(envelope.ok, name).toBe(true);
      return envelope.data;
    }
    await call("ipe_orientation");
    expect(await call("ipe_get_capabilities")).toMatchObject({ capabilities: { mode: "full-7.2.30" } });
    const spec = deckSpecSchema.parse(JSON.parse(await readFile(fixture, "utf8")));
    const { documentId, revision } = await authorDeck({
      createDocument: (preset, title) => call("ipe_create_document", { preset, title }),
      compose: (id, expectedRevision, input) => call("ipe_compose_slide", { documentId: id, expectedRevision, ...input }),
      apply: (id, expectedRevision, operations, confirmation) =>
        call("ipe_apply_operations", { documentId: id, expectedRevision, operations, confirmation }),
    }, spec);
    expect(await call("ipe_validate", { documentId, level: "structural" })).toMatchObject({ ok: true });
    expect(await call("ipe_validate", { documentId, level: "full" })).toMatchObject({ ok: true, capabilityMode: "full-7.2.30" });

    const mcpIpe = join(mcpRoot, "mcp.ipe");
    await call("ipe_save_document", { documentId, expectedRevision: revision, targetPath: mcpIpe, confirmation: "SAVE" });
    const sources = await Promise.all([cliIpe, mcpIpe].map((path) => readFile(path, "utf8")));
    expect(editableContent(sources[0]!)).toBe(editableContent(sources[1]!));

    const exported = await call<{ resources: [{ uri: string }] }>("ipe_export_document", { documentId, format: "pdf" });
    const resource = await client.readResource({ uri: exported.resources[0].uri });
    const blob = resource.contents[0];
    if (!blob || !("blob" in blob)) throw new Error("Expected a PDF blob from the MCP resource");
    const mcpPdf = join(mcpRoot, "mcp.pdf");
    await writeFile(mcpPdf, Buffer.from(blob.blob, "base64"));

    const [cliText, mcpText] = await Promise.all([cliPdf, mcpPdf].map(async (path) => {
      const { stdout } = await exec("/usr/bin/pdftotext", ["-layout", path, "-"]);
      return stdout.trim().split("\f").map((page) => page.trim());
    }));
    expect(mcpText).toEqual(cliText);
    expect(cliText).toHaveLength(4);
    expect(cliText!.map((page) => page.split("\n")[0]!.trim())).toEqual([
      "Lattice setup", "Lattice setup", "Lattice setup", "General rule",
    ]);
    expect(cliText!.map((page) => page.includes("Example route:"))).toEqual([false, true, true, false]);
    expect(cliText!.map((page) => page.includes("Route count:"))).toEqual([false, false, true, false]);
  } finally {
    await client.close();
  }
  expect(transport.pid).toBeNull();
}, 90_000);
