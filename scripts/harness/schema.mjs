import { z } from "zod";

export const HARNESS_SCHEMA_VERSION = 1;

export const GLOBAL_LIMITS = Object.freeze({
  timeoutMs: 300_000,
  toolCallTimeoutMs: 180_000,
  maxSteps: 32,
  maxTranscriptEntries: 64,
  maxArtifacts: 8,
  maxArtifactBytes: 64 * 1024 * 1024,
});

const boundedInteger = (maximum) => z.number().int().positive().max(maximum);
const identifier = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(80);

const limitsSchema = z.strictObject({
  timeoutMs: boundedInteger(GLOBAL_LIMITS.timeoutMs),
  toolCallTimeoutMs: boundedInteger(GLOBAL_LIMITS.toolCallTimeoutMs),
  maxSteps: boundedInteger(GLOBAL_LIMITS.maxSteps),
  maxTranscriptEntries: boundedInteger(GLOBAL_LIMITS.maxTranscriptEntries),
  maxArtifacts: boundedInteger(GLOBAL_LIMITS.maxArtifacts),
  maxArtifactBytes: boundedInteger(GLOBAL_LIMITS.maxArtifactBytes),
}).refine((value) => value.toolCallTimeoutMs <= value.timeoutMs, {
  message: "toolCallTimeoutMs must not exceed timeoutMs",
  path: ["toolCallTimeoutMs"],
}).refine((value) => value.maxTranscriptEntries >= value.maxSteps, {
  message: "maxTranscriptEntries must be at least maxSteps",
  path: ["maxTranscriptEntries"],
});

const artifactKindSchema = z.enum(["ipe", "preview-png", "pdf", "png"]);
const mediaTypeByArtifact = Object.freeze({
  ipe: "application/xml",
  "preview-png": "image/png",
  pdf: "application/pdf",
  png: "image/png",
});

export const scenarioSchema = z.strictObject({
  schemaVersion: z.literal(HARNESS_SCHEMA_VERSION),
  id: identifier,
  title: z.string().min(1).max(160),
  requirements: z.strictObject({
    contract: z.string().regex(/^ipe-mcp\/\d+$/u),
    capabilityMode: z.enum(["structural-only", "full-7.2.30"]),
    features: z.array(identifier).max(32),
  }),
  limits: limitsSchema,
  task: z.strictObject({
    kind: z.literal("create-edit-validate-export"),
    document: z.strictObject({
      preset: z.literal("16:9"),
      title: z.string().min(1).max(160),
    }),
    rectangle: z.strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().positive().finite(),
      height: z.number().positive().finite(),
      stroke: z.string().min(1).max(32),
      fill: z.string().min(1).max(32),
    }),
    recovery: z.array(z.enum(["stale-write", "undo", "snapshot-restore"])).min(1).max(3),
    validation: z.literal("full"),
    outputs: z.array(artifactKindSchema).min(1).max(4),
  }),
  approvals: z.array(z.strictObject({
    id: identifier,
    action: z.enum(["save", "undo", "restore"]),
    decision: z.enum(["grant", "deny"]),
  })).max(8),
  assertions: z.strictObject({
    semantic: z.strictObject({
      title: z.string().min(1).max(160),
      pageCount: z.number().int().positive().max(100),
      objectCount: z.number().int().nonnegative().max(10_000),
      rectanglePath: z.string().min(1).max(300),
    }),
    artifacts: z.array(z.strictObject({
      kind: artifactKindSchema,
      mediaType: z.string().min(1).max(100),
      minBytes: z.number().int().positive().max(GLOBAL_LIMITS.maxArtifactBytes),
    })).min(1).max(4),
  }),
}).superRefine((scenario, context) => {
  const outputKinds = new Set(scenario.task.outputs);
  const assertedKinds = new Set(scenario.assertions.artifacts.map((artifact) => artifact.kind));
  if (outputKinds.size !== scenario.task.outputs.length) {
    context.addIssue({ code: "custom", message: "task outputs must be unique", path: ["task", "outputs"] });
  }
  if (assertedKinds.size !== scenario.assertions.artifacts.length ||
      outputKinds.size !== assertedKinds.size ||
      [...outputKinds].some((kind) => !assertedKinds.has(kind))) {
    context.addIssue({ code: "custom", message: "artifact assertions must exactly match task outputs", path: ["assertions", "artifacts"] });
  }
  const approvalActions = new Set(scenario.approvals.filter((approval) => approval.decision === "grant").map((approval) => approval.action));
  const approvalIds = new Set(scenario.approvals.map((approval) => approval.id));
  if (approvalIds.size !== scenario.approvals.length) {
    context.addIssue({ code: "custom", message: "approval ids must be unique", path: ["approvals"] });
  }
  for (const required of ["save", ...scenario.task.recovery.filter((item) => item === "undo" || item === "snapshot-restore").map((item) => item === "snapshot-restore" ? "restore" : item)]) {
    if (!approvalActions.has(required)) context.addIssue({ code: "custom", message: `missing granted ${required} approval`, path: ["approvals"] });
  }
  for (const [index, artifact] of scenario.assertions.artifacts.entries()) {
    if (artifact.mediaType !== mediaTypeByArtifact[artifact.kind]) {
      context.addIssue({ code: "custom", message: `mediaType for ${artifact.kind} must be ${mediaTypeByArtifact[artifact.kind]}`, path: ["assertions", "artifacts", index, "mediaType"] });
    }
  }
});

export const failureStageSchema = z.enum([
  "harness",
  "agent-planning",
  "protocol",
  "server",
  "native-ipe",
  "artifact-quality",
]);

const failureSchema = z.strictObject({
  stage: failureStageSchema,
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).max(80),
  message: z.string().min(1).max(400),
});

const transcriptSchema = z.strictObject({
  sequence: z.number().int().positive(),
  kind: z.enum(["tool", "resource"]),
  name: z.string().min(1).max(120),
  outcome: z.enum(["pass", "fail"]),
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).max(80).optional(),
});

const artifactSchema = z.strictObject({
  kind: artifactKindSchema,
  mediaType: z.string().min(1).max(100),
  bytes: z.number().int().positive().max(GLOBAL_LIMITS.maxArtifactBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  observations: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const resultSchema = z.strictObject({
  schemaVersion: z.literal(HARNESS_SCHEMA_VERSION),
  scenarioId: identifier,
  adapter: z.strictObject({
    name: identifier,
    version: z.string().min(1).max(40),
    transport: z.string().min(1).max(40),
  }),
  status: z.enum(["PASS", "FAIL"]),
  contract: z.string().regex(/^ipe-mcp\/\d+$/u).optional(),
  productVersion: z.string().min(1).max(80).optional(),
  capabilityMode: z.enum(["structural-only", "full-7.2.30"]).optional(),
  limitsApplied: limitsSchema,
  approvals: z.array(z.strictObject({
    id: identifier,
    action: z.enum(["save", "undo", "restore"]),
    decision: z.enum(["grant", "deny"]),
  })).max(8),
  transcript: z.array(transcriptSchema).max(GLOBAL_LIMITS.maxTranscriptEntries),
  diagnostics: z.array(failureSchema).max(32),
  mutationHistory: z.array(z.strictObject({
    action: identifier,
    beforeRevision: z.number().int().nonnegative(),
    afterRevision: z.number().int().nonnegative(),
    outcome: z.enum(["applied", "rejected"]),
  })).max(32),
  artifacts: z.array(artifactSchema).max(GLOBAL_LIMITS.maxArtifacts),
  assertions: z.strictObject({
    semantic: z.enum(["PASS", "FAIL", "NOT_RUN"]),
    visual: z.enum(["PASS", "FAIL", "NOT_RUN"]),
  }),
  failure: failureSchema.optional(),
}).superRefine((result, context) => {
  if ((result.status === "FAIL") !== (result.failure !== undefined)) {
    context.addIssue({ code: "custom", message: "FAIL requires failure and PASS forbids it", path: ["failure"] });
  }
});

export const parseScenario = (value) => scenarioSchema.parse(value);
export const parseResult = (value) => resultSchema.parse(value);

export const scenarioJsonSchema = z.toJSONSchema(scenarioSchema, { target: "draft-2020-12" });
export const resultJsonSchema = z.toJSONSchema(resultSchema, { target: "draft-2020-12" });
