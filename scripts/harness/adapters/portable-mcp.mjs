import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isDeepStrictEqual } from "node:util";

import { HarnessFailure, portableFailure, redactPortableText } from "../privacy.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const supportedFeatures = new Set(["create", "edit", "history", "validate", "render", "export", "import"]);

const serverFailure = (tool, structured) => {
  const code = structured?.error?.code ?? "SERVER_ERROR";
  const stage = String(code).startsWith("NATIVE_") ? "native-ipe" : "server";
  const message = structured?.error?.summary ?? structured?.error?.message ?? `${tool} failed`;
  return new HarnessFailure(stage, code, message);
};

const artifactRecord = (kind, mediaType, bytes, observations) => ({
  kind, mediaType, bytes: bytes.length, sha256: sha256(bytes), ...(observations === undefined ? {} : { observations }),
});

export function createPortableMcpAdapter({ identity, workspaceDirectory, createConnection }) {
  return {
    identity,
    async execute({ scenario, artifactDirectory, signal }) {
      await mkdir(workspaceDirectory, { recursive: true });
      await mkdir(artifactDirectory, { recursive: true });
      const client = createConnection({ timeoutMs: scenario.limits.toolCallTimeoutMs, maxResponseBytes: Math.ceil(scenario.limits.maxArtifactBytes * 4 / 3) + 1024 * 1024 });
      const transcript = [];
      const diagnostics = [];
      const mutationHistory = [];
      const artifacts = [];
      let steps = 0;
      let totalArtifactBytes = 0;

      const record = (kind, name, outcome, code) => {
        if (transcript.length >= scenario.limits.maxTranscriptEntries) throw new HarnessFailure("harness", "TRANSCRIPT_LIMIT", "Transcript entry limit exceeded");
        transcript.push({ sequence: transcript.length + 1, kind, name, outcome, ...(code === undefined ? {} : { code }) });
      };
      const beginStep = () => {
        steps += 1;
        if (steps > scenario.limits.maxSteps) throw new HarnessFailure("harness", "STEP_LIMIT", "Scenario step limit exceeded");
      };
      const call = async (name, argumentsValue) => {
        beginStep();
        let result;
        try {
          result = await client.callTool(
            { name, arguments: argumentsValue },
            { timeout: scenario.limits.toolCallTimeoutMs, onprogress: () => undefined },
          );
        } catch (error) {
          if (error instanceof HarnessFailure) throw error;
          record("tool", name, "fail", "PROTOCOL_CALL_FAILED");
          throw new HarnessFailure("protocol", "PROTOCOL_CALL_FAILED", `${name} protocol call failed`);
        }
        if (result.structuredContent === undefined) {
          record("tool", name, "fail", "PROTOCOL_RESULT_MISSING");
          throw new HarnessFailure("protocol", "PROTOCOL_RESULT_MISSING", `${name} omitted structuredContent`);
        }
        const text = result.content.find((item) => item.type === "text");
        try {
          if (text?.type !== "text" || !isDeepStrictEqual(JSON.parse(text.text), result.structuredContent)) throw new Error("parity");
        } catch {
          record("tool", name, "fail", "PROTOCOL_PARITY_FAILED");
          throw new HarnessFailure("protocol", "PROTOCOL_PARITY_FAILED", `${name} text and structured results differ`);
        }
        if (result.structuredContent.ok !== true) {
          const code = result.structuredContent?.error?.code ?? "SERVER_ERROR";
          record("tool", name, "fail", code);
          throw serverFailure(name, result.structuredContent);
        }
        record("tool", name, "pass");
        return result.structuredContent;
      };
      const callExpectedFailure = async (name, argumentsValue, expectedCode) => {
        beginStep();
        let result;
        try {
          result = await client.callTool({ name, arguments: argumentsValue }, { timeout: scenario.limits.toolCallTimeoutMs });
        } catch (error) {
          if (error instanceof HarnessFailure) throw error;
          record("tool", name, "fail", "PROTOCOL_CALL_FAILED");
          throw new HarnessFailure("protocol", "PROTOCOL_CALL_FAILED", `${name} protocol call failed`);
        }
        const text = result.content.find((item) => item.type === "text");
        try {
          if (result.structuredContent === undefined || text?.type !== "text" || !isDeepStrictEqual(JSON.parse(text.text), result.structuredContent)) throw new Error("parity");
        } catch {
          record("tool", name, "fail", "PROTOCOL_PARITY_FAILED");
          throw new HarnessFailure("protocol", "PROTOCOL_PARITY_FAILED", `${name} expected error lacks text and structured parity`);
        }
        if (result.structuredContent?.ok !== false || result.structuredContent?.error?.code !== expectedCode) {
          record("tool", name, "fail", "EXPECTED_FAILURE_MISSING");
          throw new HarnessFailure("server", "EXPECTED_FAILURE_MISSING", `${name} did not return the expected corrective error`);
        }
        record("tool", name, "pass", expectedCode);
        return result.structuredContent;
      };
      const readResource = async (name, uri) => {
        beginStep();
        try {
          const result = await client.readResource({ uri });
          const blob = result.contents?.[0]?.blob;
          if (typeof blob !== "string") throw new Error("binary resource missing");
          if (blob.length > Math.ceil((scenario.limits.maxArtifactBytes - totalArtifactBytes) / 3) * 4) {
            throw new HarnessFailure("harness", "ARTIFACT_BYTES_LIMIT", "Encoded resource exceeds the remaining artifact limit");
          }
          record("resource", name, "pass");
          return Buffer.from(blob, "base64");
        } catch (error) {
          if (error instanceof HarnessFailure) throw error;
          record("resource", name, "fail", "PROTOCOL_RESOURCE_FAILED");
          throw new HarnessFailure("protocol", "PROTOCOL_RESOURCE_FAILED", "Resource read failed");
        }
      };
      const retainArtifact = async (kind, mediaType, data, filename, observations) => {
        if (artifacts.length >= scenario.limits.maxArtifacts) throw new HarnessFailure("harness", "ARTIFACT_COUNT_LIMIT", "Artifact count limit exceeded");
        totalArtifactBytes += data.length;
        if (totalArtifactBytes > scenario.limits.maxArtifactBytes) throw new HarnessFailure("harness", "ARTIFACT_BYTES_LIMIT", "Artifact byte limit exceeded");
        await writeFile(join(artifactDirectory, filename), data);
        artifacts.push(artifactRecord(kind, mediaType, data, observations));
      };

      const onAbort = () => { void client.close().catch(() => undefined); };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const unsupportedFeatures = scenario.requirements.features.filter((feature) => !supportedFeatures.has(feature));
        if (unsupportedFeatures.length > 0) throw new HarnessFailure("harness", "ADAPTER_CAPABILITY_UNMET", "Adapter does not support every required scenario feature");
        try {
          await client.connect(signal);
        } catch (error) {
          if (error instanceof HarnessFailure) throw error;
          throw new HarnessFailure("protocol", "PROTOCOL_CONNECT_FAILED", "MCP host initialization failed");
        }
        const orientation = await call("ipe_orientation", {});
        if (orientation.data.contractVersion !== scenario.requirements.contract) throw new HarnessFailure("protocol", "PROTOCOL_CONTRACT_MISMATCH", "MCP contract version mismatch");
        const capabilities = await call("ipe_get_capabilities", {});
        const capabilityMode = capabilities.data.capabilities.mode;
        if (capabilityMode !== scenario.requirements.capabilityMode) throw new HarnessFailure("server", "CAPABILITY_REQUIREMENT_UNMET", "Required capability mode is unavailable");

        const importing = scenario.task.kind === "import-validate-export";
        let documentId;
        let currentRevision;
        let importedOutline;
        let importDiagnostics;
        if (importing) {
          const input = await readFile(new URL("../../../fixtures/conformance/m10/import/mixed.pdf", import.meta.url));
          const imported = await call("ipe_import_pdf", { dataBase64: input.toString("base64") });
          if (imported.data.revision !== 0 || imported.data.source.sha256 !== sha256(input) ||
              !(await readResource("original-import", imported.data.source.uri)).equals(input)) {
            throw new HarnessFailure("artifact-quality", "IMPORT_SOURCE_ASSERTION_FAILED", "Import did not retain the exact source bytes and initial revision");
          }
          documentId = imported.data.documentId;
          currentRevision = imported.data.revision;
          importedOutline = imported.data.outline;
          importDiagnostics = imported.data.diagnostics.map(({ code }) => code);
          mutationHistory.push({ action: "import-pdf", beforeRevision: 0, afterRevision: 0, outcome: "applied" });
        } else {
          const created = await call("ipe_create_document", scenario.task.document);
          documentId = created.data.documentId;
          const page = created.data.outline.pages[0];
          const layerId = page?.layers[0]?.id;
          if (page === undefined || layerId === undefined) throw new HarnessFailure("server", "SERVER_OUTLINE_INVALID", "Created document has no editable page and layer");
          const rectangle = scenario.task.rectangle;
          const added = await call("ipe_apply_operations", {
            documentId, expectedRevision: created.data.revision,
            operations: [{ op: "add_rectangle", pageId: page.id, layerId, ...rectangle }],
          });
          mutationHistory.push({ action: "add-rectangle", beforeRevision: created.data.revision, afterRevision: added.data.revision, outcome: "applied" });

          currentRevision = added.data.revision;
          let snapshotId;
          if (scenario.task.recovery.includes("snapshot-restore")) {
            const snapshot = await call("ipe_history", { documentId, action: "snapshot", expectedRevision: currentRevision });
            snapshotId = snapshot.data.snapshotId;
          }
          if (scenario.task.recovery.includes("stale-write") || scenario.task.recovery.includes("undo")) {
            const temporary = await call("ipe_apply_operations", { documentId, expectedRevision: currentRevision, operations: [{ op: "set_metadata", author: "temporary" }] });
            mutationHistory.push({ action: "temporary-metadata", beforeRevision: currentRevision, afterRevision: temporary.data.revision, outcome: "applied" });
            if (scenario.task.recovery.includes("stale-write")) {
              await callExpectedFailure("ipe_apply_operations", { documentId, expectedRevision: currentRevision, operations: [{ op: "set_metadata", title: "stale" }] }, "REVISION_CONFLICT");
              mutationHistory.push({ action: "stale-write", beforeRevision: currentRevision, afterRevision: currentRevision, outcome: "rejected" });
            }
            currentRevision = temporary.data.revision;
          }
          if (scenario.task.recovery.includes("undo")) {
            const undone = await call("ipe_history", { documentId, action: "undo", expectedRevision: currentRevision, confirmation: "UNDO" });
            mutationHistory.push({ action: "undo", beforeRevision: currentRevision, afterRevision: undone.data.revision, outcome: "applied" });
            currentRevision = undone.data.revision;
          }
          if (scenario.task.recovery.includes("snapshot-restore")) {
            const restored = await call("ipe_history", { documentId, action: "restore", expectedRevision: currentRevision, snapshotId, confirmation: "RESTORE" });
            mutationHistory.push({ action: "snapshot-restore", beforeRevision: currentRevision, afterRevision: restored.data.revision, outcome: "applied" });
            currentRevision = restored.data.revision;
          }
        }

        const validation = await call("ipe_validate", { documentId, level: scenario.task.validation });
        if (validation.data.ok !== true) throw new HarnessFailure("native-ipe", "NATIVE_VALIDATION_FAILED", "Full native validation did not pass");
        const targetPath = join(workspaceDirectory, `${scenario.id}.ipe`);
        await call("ipe_save_document", { documentId, expectedRevision: currentRevision, targetPath, confirmation: "SAVE" });
        const source = await readFile(targetPath);
        const sourceText = source.toString("utf8");
        if (importing) {
          const reopened = await call("ipe_open_document", { path: targetPath });
          if (!isDeepStrictEqual(reopened.data.outline, importedOutline)) {
            throw new HarnessFailure("artifact-quality", "IMPORT_REOPEN_ASSERTION_FAILED", "Saved import changed its editable outline on reopen");
          }
          documentId = reopened.data.documentId;
        }
        const inspected = await call("ipe_inspect", { documentId, maxObjects: 100 });
        const outline = inspected.data.outline;
        const semantic = scenario.assertions.semantic;
        const semanticPass = sourceText.startsWith("<?xml") && sourceText.includes('version="70218"') &&
          (importing ? isDeepStrictEqual(importDiagnostics, semantic.importDiagnostics)
            : sourceText.includes('title="' + semantic.title + '"') && sourceText.includes(semantic.rectanglePath)) &&
          outline.pageCount === semantic.pageCount && outline.objectCount === semantic.objectCount;
        if (!semanticPass) throw new HarnessFailure("artifact-quality", "SEMANTIC_ASSERTION_FAILED", "Saved document did not satisfy semantic assertions");
        const artifactAssertion = (kind) => scenario.assertions.artifacts.find((item) => item.kind === kind);
        if (scenario.task.outputs.includes("ipe")) {
          if (source.length < artifactAssertion("ipe").minBytes) throw new HarnessFailure("artifact-quality", "IPE_QUALITY_FAILED", "Saved Ipe artifact is below the declared size threshold");
          await retainArtifact("ipe", "application/xml", source, `${scenario.id}.ipe`, { pageCount: outline.pageCount, objectCount: outline.objectCount, ipeFormat: 70218 });
        }
        if (scenario.task.outputs.includes("preview-png")) {
          const preview = await call("ipe_render_preview", { documentId });
          const bytes = await readResource("preview-png", preview.data.resources[0]?.uri);
          if (!bytes.subarray(0, 8).equals(pngSignature) || bytes.length < artifactAssertion("preview-png").minBytes) throw new HarnessFailure("artifact-quality", "PREVIEW_QUALITY_FAILED", "Preview PNG signature or size is invalid");
          await retainArtifact("preview-png", "image/png", bytes, `${scenario.id}-preview.png`, { signature: "PNG" });
        }
        if (scenario.task.outputs.includes("pdf")) {
          const exported = await call("ipe_export_document", { documentId, format: "pdf" });
          const bytes = await readResource("pdf", exported.data.resources[0]?.uri);
          if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || bytes.length < artifactAssertion("pdf").minBytes) throw new HarnessFailure("artifact-quality", "PDF_QUALITY_FAILED", "PDF signature or size is invalid");
          await retainArtifact("pdf", "application/pdf", bytes, `${scenario.id}.pdf`, { signature: "%PDF-" });
        }
        if (scenario.task.outputs.includes("png")) {
          const exported = await call("ipe_export_document", { documentId, format: "png" });
          const bytes = await readResource("png", exported.data.resources[0]?.uri);
          if (!bytes.subarray(0, 8).equals(pngSignature) || bytes.length < artifactAssertion("png").minBytes) throw new HarnessFailure("artifact-quality", "PNG_QUALITY_FAILED", "PNG signature or size is invalid");
          await retainArtifact("png", "image/png", bytes, `${scenario.id}.png`, { signature: "PNG" });
        }
        client.assertPrivateDiagnostics?.();

        return {
          adapter: this.identity,
          contract: orientation.data.contractVersion,
          ...(client.productVersion === undefined ? {} : { productVersion: client.productVersion }),
          capabilityMode,
          approvals: scenario.approvals,
          transcript, diagnostics, mutationHistory, artifacts,
          assertions: { semantic: "PASS", visual: "PASS" },
        };
      } catch (error) {
        const failure = portableFailure(error, "protocol", "PROTOCOL_ADAPTER_FAILED");
        diagnostics.push(failure);
        return {
          adapter: this.identity,
          approvals: scenario.approvals,
          transcript, diagnostics, mutationHistory, artifacts,
          assertions: { semantic: artifacts.some((item) => item.kind === "ipe") ? "PASS" : "NOT_RUN", visual: artifacts.some((item) => item.kind !== "ipe") ? "PASS" : "NOT_RUN" },
          failure: { ...failure, message: redactPortableText(failure.message) },
        };
      } finally {
        signal.removeEventListener("abort", onAbort);
        await client.close().catch(() => undefined);
      }
    },
  };
}
