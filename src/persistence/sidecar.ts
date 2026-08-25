import { z } from "zod";

import { atomicWriteFile, type AtomicWriteOptions } from "./atomic.js";
import { readFileBounded } from "./bounded-read.js";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const sidecarV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  documentId: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  revision: z.number().int().nonnegative(),
  objectMetadata: z.record(z.string().min(1), jsonValueSchema).default({}),
  layoutConstraints: z.record(z.string().min(1), jsonValueSchema).default({}),
});

export type SidecarV1 = z.infer<typeof sidecarV1Schema>;

const legacyV0Schema = z.strictObject({
  version: z.literal(0),
  documentId: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  revision: z.number().int().nonnegative().default(0),
  metadata: z.record(z.string().min(1), jsonValueSchema).default({}),
});

export function migrateSidecar(input: unknown): SidecarV1 {
  const current = sidecarV1Schema.safeParse(input);
  if (current.success) return current.data;
  const legacy = legacyV0Schema.parse(input);
  return sidecarV1Schema.parse({
    schemaVersion: 1,
    documentId: legacy.documentId,
    sourceHash: legacy.sourceHash,
    revision: legacy.revision,
    objectMetadata: legacy.metadata,
    layoutConstraints: {},
  });
}

export async function readSidecar(path: string, maxBytes = 4 * 1024 * 1024): Promise<SidecarV1> {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFileBounded(path, maxBytes));
  return migrateSidecar(JSON.parse(source) as unknown);
}

export async function writeSidecar(
  path: string,
  sidecar: SidecarV1,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const validated = sidecarV1Schema.parse(sidecar);
  await atomicWriteFile(path, `${JSON.stringify(validated, null, 2)}\n`, options);
}
