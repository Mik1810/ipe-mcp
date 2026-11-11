#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { authorDeck, deckSpecSchema } from "../../dist/src/cli/deck-spec.js";
import { hasArtifactSignature, hasToolResultParity } from "./adapters/portable-mcp.mjs";
import { createSdkStdioConnection } from "./adapters/sdk-stdio.mjs";
import { CheckFailure, editableContent, evaluateSlides, maxViews, requireCheck, reviewSchema, run } from "./slide-quality.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const defaultSpec = join(root, "fixtures/decks/odd-squares.json");
const defaultReview = join(root, "fixtures/decks/odd-squares.review.json");
const maxResourceBytes = 16 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readMcpArtifact(client, resource, kind, location) {
  const criterion = kind === "pdf" ? "MCP_PDF_RESOURCE" : "MCP_PREVIEW_RESOURCE";
  const mime = kind === "pdf" ? "application/pdf" : "image/png";
  requireCheck(resource?.mediaType === mime && Number.isSafeInteger(resource.bytes) &&
    resource.bytes > 0 && resource.bytes <= maxResourceBytes, criterion, location);
  let contents;
  try { ({ contents } = await client.readResource({ uri: resource.uri })); }
  catch { throw new CheckFailure(criterion, location); }
  const content = contents[0];
  requireCheck(contents.length === 1 && content?.uri === resource.uri && content.mimeType === mime &&
    typeof content.blob === "string" && content.blob.length <= 4 * Math.ceil(resource.bytes / 3), criterion, location);
  const bytes = Buffer.from(content.blob, "base64");
  requireCheck(bytes.length === resource.bytes && digest(bytes) === resource.sha256 &&
    hasArtifactSignature(kind, bytes), criterion, location);
  return bytes;
}

async function buildMcp(spec, directory, sourcePath, pdfPath) {
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const client = createSdkStdioConnection({
    command: process.execPath,
    args: [join(root, "dist/src/cli/mcp-stdio.js")],
    cwd: directory,
    workspaceDirectory: directory,
    expectedVersion: version,
    timeoutMs: 90_000,
  });
  async function call(name, args = {}) {
    let result;
    try { result = await client.callTool({ name, arguments: args }, { timeout: 90_000, onprogress: () => {} }); }
    catch { throw new CheckFailure("MCP_PROTOCOL", { tool: name }); }
    requireCheck(hasToolResultParity(result), "MCP_RESULT_PARITY", { tool: name });
    requireCheck(result.isError !== true && result.structuredContent.ok === true, "MCP_TOOL", { tool: name });
    return result.structuredContent.data;
  }
  try {
    try { await client.connect(AbortSignal.timeout(90_000)); }
    catch { throw new CheckFailure("MCP_STDIO_PREFLIGHT"); }
    const orientation = await call("ipe_orientation");
    requireCheck(orientation.contractVersion === "ipe-mcp/1", "MCP_CONTRACT");
    const { capabilities } = await call("ipe_get_capabilities");
    requireCheck(capabilities.mode === "full-7.2.30", "MCP_NATIVE_CAPABILITIES");
    const { documentId, revision } = await authorDeck({
      createDocument: (preset, title) => call("ipe_create_document", { preset, title }),
      compose: (id, expectedRevision, input) => call("ipe_compose_slide", { documentId: id, expectedRevision, ...input }),
      apply: (id, expectedRevision, operations, confirmation) =>
        call("ipe_apply_operations", { documentId: id, expectedRevision, operations, confirmation }),
    }, spec).catch((error) => {
      const slide = /^Slide (\d+):/u.exec(error.message);
      if (!slide) throw error;
      const finding = error.cause instanceof CheckFailure ? error.cause.finding : {};
      throw new CheckFailure(finding.criterion ?? "MCP_AUTHOR_DECK", { ...finding, slide: Number(slide[1]) });
    });
    requireCheck((await call("ipe_validate", { documentId, level: "structural" })).ok, "MCP_STRUCTURAL_VALIDATION");
    await call("ipe_save_document", { documentId, expectedRevision: revision, targetPath: sourcePath, confirmation: "SAVE" });
    const saved = await readFile(sourcePath);
    const reopened = await call("ipe_open_document", { path: sourcePath });
    const id = reopened.documentId;
    requireCheck((await call("ipe_validate", { documentId: id, level: "full" })).ok, "MCP_NATIVE_VALIDATION");
    const states = reopened.outline.pages.flatMap((page, i) => page.views.map((view, j) => ({
      slide: i + 1, view: j + 1, pageId: page.id, viewId: view.id,
    })));
    const preview = await call("ipe_render_preview", { documentId: id });
    requireCheck(preview.resources.length === states.length, "MCP_PREVIEW_COUNT");
    for (const [index, { slide, view, pageId, viewId }] of states.entries()) {
      const resource = preview.resources[index];
      const location = { slide, view };
      requireCheck(resource.metadata?.page === slide && resource.metadata.view === view &&
        resource.metadata.pageId === pageId && resource.metadata.viewId === viewId, "MCP_PREVIEW_ORDER", location);
      await readMcpArtifact(client, resource, "png", location);
    }
    const exported = await call("ipe_export_document", { documentId: id, format: "pdf" });
    requireCheck(exported.resources.length === 1, "MCP_PDF_RESOURCE_COUNT");
    const resource = exported.resources[0];
    const mapping = resource.metadata?.mapping;
    requireCheck(mapping?.length === states.length, "MCP_PDF_MAPPING_COUNT");
    for (const [i, { slide, view, pageId, viewId }] of states.entries()) {
      requireCheck(isDeepStrictEqual(mapping[i], { pdfPage: i + 1, pageId, viewId }), "MCP_PDF_MAPPING", { slide, view });
    }
    await writeFile(pdfPath, await readMcpArtifact(client, resource, "pdf"), { flag: "wx" });
    requireCheck((await readFile(sourcePath)).equals(saved), "MCP_SAVED_SOURCE_CHANGED");
    try { client.assertPrivateDiagnostics(); }
    catch { throw new CheckFailure("MCP_STDIO_PRIVACY"); }
  } finally {
    await client.close();
  }
}

function within(parent, path) {
  const name = relative(parent, path);
  return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith("../"));
}

async function requireOutsideGit(directory, criterion) {
  const git = await run("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], {
    env: { PATH: process.env.PATH },
  }).catch((error) => {
    if (error.code !== 128) throw error;
    return { stdout: "false" };
  });
  requireCheck(!within(await realpath(root), directory) && git.stdout.trim() !== "true", criterion);
}

async function readInput(path) {
  const data = await readFile(path);
  requireCheck(data.length <= 1024 * 1024, "INPUT_SIZE");
  return JSON.parse(data.toString("utf8"));
}

async function main() {
  const { values } = parseArgs({ options: {
    out: { type: "string" }, spec: { type: "string" }, review: { type: "string" },
    negative: { type: "boolean" },
  } });
  requireCheck(values.out && Boolean(values.spec) === Boolean(values.review) &&
    !(values.negative && values.spec), "USAGE");
  const parent = await realpath(dirname(resolve(values.out)));
  await requireOutsideGit(parent, "OUTPUT_INSIDE_GIT");
  const directory = join(parent, basename(resolve(values.out)));
  const specPath = values.spec ? await realpath(values.spec) : defaultSpec;
  const reviewPath = values.review ? await realpath(values.review) : defaultReview;
  if (values.spec) {
    await requireOutsideGit(dirname(specPath), "PRIVATE_INPUT_INSIDE_GIT");
    await requireOutsideGit(dirname(reviewPath), "PRIVATE_INPUT_INSIDE_GIT");
  }
  const spec = deckSpecSchema.parse(await readInput(specPath));
  const review = reviewSchema.parse(await readInput(reviewPath));
  const count = spec.slides.reduce((total, slide) => total + slide.views.length, 0);
  requireCheck(count <= maxViews, "VIEW_LIMIT");
  if (values.negative) {
    // Move the rim heading over the setup text and add a shape crossing the paper edge.
    spec.slides[0].objects[6].position = { ...spec.slides[0].objects[2].position };
    spec.slides[2].objects.push({ op: "add_rectangle", layer: "base", x: 1215, y: 190, width: 70, height: 95, fill: "0.8 0.1 0.2" });
  }
  await mkdir(directory, { mode: 0o700 });

  const report = { case: values.spec ? "local" : values.negative ? "synthetic-negative" : "synthetic",
    automatic: "FAIL", humanReview: "REQUIRED", routes: {}, findings: [] };
  const results = {};
  for (const route of ["cli", "mcp"]) {
    const output = join(directory, route);
    await mkdir(output);
    const ipe = join(output, "deck.ipe");
    const pdf = join(output, "deck.pdf");
    let stage = route === "cli" ? "CLI_NATIVE_GENERATION" : "MCP_NATIVE_GENERATION";
    try {
      if (route === "cli") {
        const input = join(output, "input.json");
        await writeFile(input, JSON.stringify(spec), { mode: 0o600 });
        await run(process.execPath, [join(root, "dist/src/cli/deck.js"), input, "--out", ipe, "--pdf", pdf]);
      } else {
        await buildMcp(spec, output, ipe, pdf);
      }
      stage = "ARTIFACT_INSPECTION";
      const result = await evaluateSlides(ipe, pdf, review, output);
      results[route] = { ...result, source: editableContent(await readFile(ipe, "utf8")) };
      report.routes[route] = { views: result.views, intentionalOverlaps: result.intentionalOverlaps,
        headingAnchors: result.headingAnchors };
      report.findings.push(...result.findings.map(({ evidence, previousEvidence, ...finding }) => ({
        ...finding, route, evidence: evidence ? route + "/" + evidence : null,
        ...(previousEvidence === undefined ? {} : {
          previousEvidence: previousEvidence ? route + "/" + previousEvidence : null,
        }),
      })));
    } catch (error) {
      report.findings.push({ route, ...(error instanceof CheckFailure ? error.finding :
        { criterion: stage, slide: null, view: null, evidence: null }) });
    }
  }
  if (results.cli && results.mcp) {
    if (results.cli.source !== results.mcp.source) {
      report.findings.push({ route: "both", criterion: "EDITABLE_PARITY", slide: null, view: null, evidence: null });
    }
    for (const { slide, view } of review.views) {
      const filename = "s" + slide + "-v" + view + ".png";
      const key = filename.slice(0, -4);
      const cli = results.cli.rasters.get(key);
      const mcp = results.mcp.rasters.get(key);
      if (cli && mcp && !cli.equals(mcp)) {
        report.findings.push({ route: "both", criterion: "PDF_RASTER_PARITY", slide, view,
          evidence: ["cli/" + filename, "mcp/" + filename] });
      }
    }
  }
  if (report.findings.length === 0) report.automatic = "PASS";
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("Slide quality " + report.automatic + " (" + report.findings.length + " findings). See report.json in the output directory.");
  if (report.automatic === "FAIL") process.exitCode = 1;
}

try { await main(); }
catch (error) {
  const criterion = error instanceof CheckFailure ? error.finding.criterion : "INPUT_OR_OUTPUT";
  console.error("Slide quality could not start or write its report (" + criterion + ").");
  console.error("Usage: node scripts/harness/run-slide-quality.mjs --out NEW_LOCAL_DIR [--negative | --spec FILE --review FILE]");
  process.exitCode = 2;
}
