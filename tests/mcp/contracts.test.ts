import { describe, expect, it } from "vitest";

import { MAX_HINTS, MCP_CONTRACT_VERSION, operationSchema, resultSchema, viewBuildSchema } from "../../src/mcp/contracts.js";
import { failure, safeLog, sanitizePublicText, success } from "../../src/mcp/errors.js";
import { SERVER_INSTRUCTIONS } from "../../src/mcp/server.js";

describe("M8 public contracts", () => {
  it("keeps bootstrap instructions compact and independently useful", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(700);
    for (const term of ["ipe_orientation", "expectedRevision", "REVISION_CONFLICT", "resource links"]) expect(SERVER_INSTRUCTIONS).toContain(term);
  });

  it("uses strict versioned schemas and bounded hints", () => {
    expect(operationSchema.safeParse({ op: "add_page", unexpected: true }).success).toBe(false);
    const result = success("test", "done", {}, Array.from({ length: 8 }, (_, index) => ({ priority: "nudge" as const, code: `H${index}`, message: "bounded" })));
    expect(result.contractVersion).toBe(MCP_CONTRACT_VERSION);
    expect(result.hints).toHaveLength(MAX_HINTS);
    expect(resultSchema.safeParse(result).success).toBe(true);
  });

  it("returns stable corrective identifier and redacted path failures", () => {
    const missing = failure("apply_operations", new Error("unknown object object-deadbeef at /private/user/diagram.ipe"));
    expect(missing.error).toMatchObject({ code: "IDENTIFIER_NOT_FOUND", retryable: true });
    expect(JSON.stringify(missing)).not.toContain("/private/user");
    expect(missing.error?.correction).toContain("ipe_inspect");
  });

  it("redacts complete POSIX and Windows paths even when they contain spaces", () => {
    for (const message of ["cannot open /private/User Name/diagram draft.ipe because access failed", String.raw`cannot open C:\Users\Jane Doe\diagram draft.ipe because access failed`]) {
      const sanitized = sanitizePublicText(message);
      expect(sanitized).toContain("<redacted-path>");
      expect(sanitized).not.toMatch(/User Name|Jane Doe|diagram draft/iu);
    }
  });

  it("contracts the stabilized M0-M7 authoring surface", () => {
    for (const op of ["add_path", "add_image", "add_symbol_use", "replace_object", "duplicate_object", "group_objects", "ungroup_object", "set_object_layer", "transform_object", "add_stylesheet", "layout_objects", "reorder_pages", "reorder_layers", "reorder_views"]) expect(JSON.stringify(operationSchema)).toContain(op);
    expect(operationSchema.safeParse({ op: "replace_object", pageId: "page-000000000000000000000000", objectId: "object-000000000000000000000000", replacement: { kind: "path", path: { kind: "circle", center: { x: 10, y: 20 }, radius: 5 } } }).success).toBe(true);
    expect(operationSchema.safeParse({ op: "replace_object", pageId: "page-000000000000000000000000", objectId: "object-000000000000000000000000", replacement: { kind: "raw_xml", xml: "<path/>" } }).success).toBe(false);
    for (const kind of ["reveal", "motion", "panel_scroll", "camera_pan", "transition"]) expect(JSON.stringify(viewBuildSchema)).toContain(kind);
  });

  it("logs structural values only on stderr", () => {
    let output = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((value: string | Uint8Array) => { output += value.toString(); return true; }) as typeof process.stderr.write;
    try { safeLog("tool_complete", { tool: "ipe_open_document", secret: "/private/work/file.ipe", ok: false }); }
    finally { process.stderr.write = original; }
    expect(output).toContain('"tool":17');
    expect(output).not.toContain("ipe_open_document");
    expect(output).not.toContain("/private/work");
  });
});
