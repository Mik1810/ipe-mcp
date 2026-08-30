#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { resultJsonSchema, scenarioJsonSchema } from "./schema.mjs";

const output = resolve(process.argv[2] ?? "fixtures/conformance/m10");
await mkdir(output, { recursive: true });
const schemas = [
  ["scenario.schema.json", { $id: "https://github.com/Mik1810/ipe-mcp/schemas/harness/scenario-v1.json", ...scenarioJsonSchema }],
  ["result.schema.json", { $id: "https://github.com/Mik1810/ipe-mcp/schemas/harness/result-v1.json", ...resultJsonSchema }],
];
for (const [name, schema] of schemas) await writeFile(resolve(output, name), `${JSON.stringify(schema, null, 2)}\n`);
