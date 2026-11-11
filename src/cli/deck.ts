#!/usr/bin/env node
import { link, lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { authorDeck, deckSpecSchema } from "./deck-spec.js";
import { IpeMcpService } from "../mcp/service.js";
import { NativeIpeError } from "../native/errors.js";

const usage = "Usage: ipe-mcp-cli <spec.json> --out <deck.ipe> [--pdf <deck.pdf>]";
const maxSpecBytes = 1024 * 1024;

async function readSpec(path: string) {
  const file = await open(path, "r");
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error("Provide a regular JSON specification file.");
    const size = stats.size;
    if (size > maxSpecBytes) throw new Error("Specification exceeds 1 MiB. Split it into smaller decks.");
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read({ buffer });
    if (bytesRead !== size) throw new Error("Could not read the complete specification. Finish writing it and retry.");
    try { return JSON.parse(buffer.toString("utf8", 0, bytesRead)) as unknown; }
    catch { throw new Error("Specification is not valid JSON. Use a version-1 deck JSON file from the ipe-authoring skill."); }
  } finally {
    await file.close();
  }
}

async function requireNewFile(path: string) {
  try { await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Output already exists: " + path + ". Choose a new filename.");
}

async function publish(path: string, bytes: Uint8Array) {
  const staging = await mkdtemp(join(dirname(path), ".ipe-mcp-deck-"));
  try {
    const source = join(staging, "output");
    await writeFile(source, bytes, { mode: 0o600 });
    // Publish complete bytes without replacing an existing file or symlink.
    await link(source, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") await requireNewFile(path);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string" }, pdf: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) { console.log(usage); return; }
  const [input] = positionals;
  if (positionals.length !== 1 || input === undefined || extname(input) !== ".json" ||
      values.out === undefined || extname(values.out) !== ".ipe" ||
      (values.pdf !== undefined && extname(values.pdf) !== ".pdf")) {
    throw new Error(usage);
  }

  const parsed = deckSpecSchema.safeParse(await readSpec(input));
  if (!parsed.success) throw new Error("Unsupported or invalid deck specification:\n" + z.prettifyError(parsed.error));
  const output = resolve(values.out);
  const pdfPath = values.pdf === undefined ? undefined : resolve(values.pdf);
  await requireNewFile(output);
  if (pdfPath !== undefined) await requireNewFile(pdfPath);

  const workspace = await mkdtemp(join(tmpdir(), "ipe-mcp-deck-"));
  try {
    const service = await IpeMcpService.create([workspace], join(workspace, "state"));
    const { documentId, revision } = await authorDeck(service, parsed.data);
    const structural = await service.validate(documentId, "structural");
    if (!structural.ok) throw new Error("Structural validation failed. Review the deck specification.");
    const pdf = pdfPath === undefined ? undefined :
      (await service.native.validateFull(service.sessions.inspect(documentId).document)).pdf;
    const editable = join(workspace, "document.ipe");
    await service.save(documentId, revision, editable);
    await publish(output, await readFile(editable));
    console.log("Wrote " + output + " (structural validation passed).");
    if (pdfPath !== undefined && pdf !== undefined) {
      await publish(pdfPath, pdf.data);
      console.log("Wrote " + pdfPath + " (native validation passed, " + pdf.metadata.mapping.length + " PDF views).");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

try { await main(); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof NativeIpeError ? error.code + ": " + message : message);
  if (error instanceof NativeIpeError) {
    for (const diagnostic of error.diagnostics) console.error("  " + diagnostic);
    if (error.code === "NATIVE_UNAVAILABLE") {
      console.error("Install the supported WSL Ipe, TeX, and validation tools from SETUP-WSL.md, or omit --pdf to generate an editable .ipe with structural checks only.");
    } else if (error.code === "NATIVE_STYLE_ERROR") {
      console.error("Check for undefined named styles. Use numeric colors and pen widths, and set text size with LaTeX commands such as \\Large.");
    }
  }
  process.exitCode = 1;
}
