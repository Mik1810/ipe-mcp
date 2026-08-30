#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const [name, version, expectedIntegrity] = process.argv.slice(2);
if (name === undefined || version === undefined || expectedIntegrity === undefined) {
  throw new Error("usage: verify-registry.mjs PACKAGE VERSION EXPECTED_INTEGRITY");
}

const spec = `${name}@${version}`;
let metadata;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    metadata = JSON.parse((await exec("npm", ["view", spec, "name", "version", "dist.integrity", "dist.attestations", "dist-tags", "--json"])).stdout);
    if (metadata?.version === version) break;
  } catch {
    // Registry propagation is bounded and retried below.
  }
  if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 5_000));
}
if (metadata?.name !== name || metadata.version !== version || metadata["dist.integrity"] !== expectedIntegrity) {
  throw new Error("published registry identity or integrity mismatch");
}
if (metadata["dist.attestations"]?.provenance?.predicateType !== "https://slsa.dev/provenance/v1") throw new Error("npm provenance attestation is missing");
if (metadata["dist-tags"]?.next !== version) throw new Error("npm next tag does not select the release candidate");
if (metadata["dist-tags"]?.latest === version) throw new Error("prerelease unexpectedly changed npm latest");
process.stdout.write(`${JSON.stringify({ result: "PASS", name, version, integrity: expectedIntegrity, distTag: "next" })}\n`);
