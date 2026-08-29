import { NativeIpeError } from "../native/errors.js";
import { PathOutsideWorkspaceError, RevisionConflictError, SourceChangedError, StructuralValidationError } from "../persistence/errors.js";
import { LimitsExceededError, MODEL_TEXT_CAPS } from "../limits.js";
import { MAX_HINTS, MCP_CONTRACT_VERSION, resultSchema, type PublicResult } from "./contracts.js";

export const sanitizePublicText = (value: string): string => value
  // Public failures prefer dropping the remainder of a sentence over leaking
  // an absolute filesystem path. This deliberately covers spaces and both
  // POSIX and Windows separators; diagnostics must not depend on path text.
  .replaceAll(/(?:[A-Za-z]:[\\/]|(?<![\w:/])\/)[^\r\n]*/gu, "<redacted-path>")
  .replaceAll(/[\r\n\t]+/gu, " ")
  .slice(0, MODEL_TEXT_CAPS.hintMessage);

export function success(kind: string, summary: string, data: Record<string, unknown>, hints: PublicResult["hints"] = []): PublicResult {
  return resultSchema.parse({ contractVersion: MCP_CONTRACT_VERSION, ok: true, kind, summary: sanitizePublicText(summary), data, hints: hints.slice(0, MAX_HINTS) });
}

/** Normalize SDK pre-handler validation failures into the public contract. */
export function inputValidationFailure(): PublicResult {
  return failure("input_validation", new Error("Tool input failed schema validation."));
}

export function failure(kind: string, error: unknown): PublicResult {
  let code = "INTERNAL_ERROR";
  let message = "The operation failed safely.";
  let correction = "Inspect the current document state, correct the request, and retry.";
  let retryable = false;
  let details: Record<string, string | number | boolean | null> | undefined;
  if (error instanceof RevisionConflictError) {
    code = error.code; message = "The expected revision is stale; no mutation was applied."; correction = "Call ipe_inspect, then retry with its current revision."; retryable = true;
    details = { expectedRevision: error.expectedRevision, actualRevision: error.actualRevision };
  } else if (error instanceof SourceChangedError) {
    code = error.code; message = "The source changed outside this session; it was not overwritten."; correction = "Open the changed source as a new session or save to a different approved path."; retryable = true;
  } else if (error instanceof PathOutsideWorkspaceError) {
    code = error.code; message = "The requested path is outside the configured workspace roots."; correction = "Choose a path inside an allowed workspace root.";
  } else if (error instanceof StructuralValidationError) {
    code = error.code; message = "The candidate violated document invariants; the transaction was rolled back."; correction = "Use exact IDs from ipe_inspect and correct the reported invariant."; retryable = true;
    details = { diagnosticCount: error.diagnostics.length };
  } else if (error instanceof LimitsExceededError) {
    code = error.code; message = `The document exceeded its ${error.dimension} limit (${error.actual} > ${error.limit}); the transaction was rolled back.`; correction = `Reduce the document to at most ${error.limit} ${error.dimension} and retry.`; retryable = true;
    details = { dimension: error.dimension, limit: error.limit, actual: error.actual };
  } else if (error instanceof NativeIpeError) {
    code = error.code; message = sanitizePublicText(error.message); correction = error.code === "NATIVE_TIMEOUT" ? "Reduce page/view complexity and retry; the bounded native deadline was reached." : "Call ipe_get_capabilities and ipe_validate before retrying the native operation."; retryable = error.code === "NATIVE_TIMEOUT";
    details = { diagnosticCount: error.diagnostics.length };
  } else if (error instanceof Error) {
    code = /confirm/iu.test(error.message) ? "CONFIRMATION_REQUIRED" : /does not exist|unknown/iu.test(error.message) ? "IDENTIFIER_NOT_FOUND" : "INVALID_ARGUMENT";
    message = sanitizePublicText(error.message); correction = code === "IDENTIFIER_NOT_FOUND" ? "Call ipe_inspect and use an exact current identifier; names are not IDs." : "Correct the indicated argument and retry."; retryable = true;
  }
  const publicError = { code, message, retryable, correction, ...(details === undefined ? {} : { details }) };
  return { contractVersion: MCP_CONTRACT_VERSION, ok: false, kind, summary: `${code}: ${message}`, data: {}, hints: [{ priority: "recovery", code, message: correction }], error: publicError };
}

export function safeLog(event: string, fields: Record<string, string | number | boolean> = {}): void {
  const structural = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? value.length : value]));
  process.stderr.write(`${JSON.stringify({ event, ...structural })}\n`);
}
