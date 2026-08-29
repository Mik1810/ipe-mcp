#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/gates/m9-common.sh"
M9_THREAT_TMP=$(mktemp -d)
trap 'rm -rf "$M9_THREAT_TMP"' EXIT
fail() { echo "M9 THREAT AUDIT FAIL: $*" >&2; exit 1; }

CANDIDATE_SOURCE=ac854a747011f2e944619fefd3a3d0adf392ec98
CANDIDATE_TREE=17b5fb3cb883b5af06f619483c11a8f9d1a8c73a
[[ "$(cd "$ROOT" && git rev-parse "$CANDIDATE_SOURCE^{tree}")" == "$CANDIDATE_TREE" ]] || fail "frozen candidate identity"
(cd "$ROOT" && git merge-base --is-ancestor "$CANDIDATE_SOURCE" HEAD) || fail "candidate source is not an ancestor of HEAD"
(cd "$ROOT" && git diff --quiet "$CANDIDATE_SOURCE" -- src package.json package-lock.json) || fail "product surface changed after candidate freeze"

bash "$ROOT/scripts/gates/check-m9-hostile.sh" || fail "hostile corpus and inherited M8 gate"
(cd "$ROOT" && node scripts/conformance/m9-hostile-runner.mjs "$ROOT") >"$M9_THREAT_TMP/hostile.json" || fail "bounded hostile evidence record"

node --input-type=module - "$ROOT" "$M9_THREAT_TMP" <<'NODE' >"$M9_THREAT_TMP/http-surface.json" || fail "runtime stdio-only probe"
import { mkdir, readFile, readlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const [root, temporary] = process.argv.slice(2);
const workspace = join(temporary, "http-workspace");
const state = join(workspace, ".state");
await mkdir(workspace);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist/src/cli/mcp-stdio.js")],
  cwd: root,
  env: { PATH: process.env.PATH ?? "", IPE_MCP_WORKSPACE_ROOT: workspace, IPE_MCP_STATE_ROOT: state },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
const client = new Client({ name: "m9-no-http-surface-probe", version: "1.0.0" });
await client.connect(transport);
try {
  const orientation = await client.callTool({ name: "ipe_orientation", arguments: {} });
  const pid = transport.pid;
  if (pid === null) throw new Error("stdio child PID is unavailable");
  const targets = [];
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    try { targets.push(await readlink(`/proc/${pid}/fd/${fd}`)); } catch { /* descriptor closed during inspection */ }
  }
  const socketInodes = new Set(targets.flatMap((target) => /^socket:\[(\d+)\]$/u.exec(target)?.[1] ?? []));
  const listeners = [];
  for (const table of ["tcp", "tcp6"]) {
    const lines = (await readFile(`/proc/${pid}/net/${table}`, "utf8")).trim().split("\n").slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/u);
      if (fields[3] === "0A" && socketInodes.has(fields[9])) listeners.push(`${table}:${fields[1]}`);
    }
  }
  const unixLines = (await readFile(`/proc/${pid}/net/unix`, "utf8")).trim().split("\n").slice(1);
  for (const line of unixLines) {
    const fields = line.trim().split(/\s+/u);
    const accepts = (Number.parseInt(fields[3] ?? "0", 16) & 0x10000) !== 0;
    if (accepts && socketInodes.has(fields[6])) listeners.push(`unix:${fields[7] ?? "anonymous"}`);
  }
  const structured = orientation.structuredContent;
  if (structured?.ok !== true || listeners.length !== 0) throw new Error(`unexpected listening surface: ${JSON.stringify(listeners)}`);
  process.stdout.write(`${JSON.stringify({ transport: "stdio", orientation: "PASS", socketListeners: 0, authSurface: "ABSENT", stderrProtocolSafe: !stderr.includes(workspace) && !stderr.includes("Bearer" + " ") })}\n`);
} finally {
  await client.close();
}
NODE

python3 - "$ROOT" "$M9_THREAT_TMP" "$CANDIDATE_SOURCE" "$CANDIDATE_TREE" <<'PY' || fail "eight-ID matrix audit"
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
temporary = pathlib.Path(sys.argv[2])
source_revision = sys.argv[3]
candidate_tree = sys.argv[4]
doc_path = root / "docs/milestones/core-m9-threat-audit.md"
doc = doc_path.read_text(encoding="utf-8")
expected_ids = ["TM-XML", "TM-TEX", "TM-FS", "TM-ASSET", "TM-PROC", "TM-CONCURRENCY", "TM-METADATA", "TM-HTTP"]

assert source_revision in doc and candidate_tree in doc
rows = [line for line in doc.splitlines() if re.match(r"^\| TM-[A-Z]+ \|", line)]
assert len(rows) == 8, f"expected eight threat rows, found {len(rows)}"
assert [row.split("|")[1].strip() for row in rows] == expected_ids
for row in rows:
    fields = [field.strip() for field in row.strip().strip("|").split("|")]
    assert len(fields) == 9, f"incomplete audit row: {fields[0]}"
    assert all(fields), f"empty audit field: {fields[0]}"
    assert "CURRENT:" in fields[4], f"documentation-only evidence: {fields[0]}"
    assert fields[5] in {"PASS", "NOT APPLICABLE"}, f"invalid disposition: {fields[0]}"
    assert fields[6] and fields[7] and fields[8], f"missing residual/owner/target: {fields[0]}"
assert rows[-1].split("|")[6].strip() == "NOT APPLICABLE"
assert "There are no open CRITICAL findings" in doc
for finding in ["AUD-001", "AUD-002", "AUD-003"]:
    assert finding in doc
assert doc.count("| RESOLVED |") == 3

references = sorted(set(re.findall(r"`(?:(?:bash|node) )?((?:tests|scripts|fixtures)/[^` ;]+\.(?:ts|mjs|sh|json))", doc)))
assert references
for reference in references:
    path = root / reference
    assert path.is_file(), f"missing evidence reference: {reference}"
    if reference.endswith(".sh"):
        assert path.stat().st_mode & 0o111, f"gate is not executable: {reference}"

manifest = json.loads((root / "fixtures/conformance/m9/hostile/manifest.json").read_text(encoding="utf-8"))
assert len(manifest["cases"]) == 24
assert sorted(set(case["threatId"] for case in manifest["cases"])) == sorted(expected_ids)
assert next(case for case in manifest["cases"] if case["id"] == "HOST-022")["expected"]["classification"] == "ENOENT_LOCAL_PATH"
assert next(case for case in manifest["cases"] if case["id"] == "HOST-024")["expected"]["classification"] == "PROCESS_LIMIT"

hostile_lines = [line for line in (temporary / "hostile.json").read_text(encoding="utf-8").splitlines() if line.startswith("{")]
assert hostile_lines
hostile = json.loads(hostile_lines[-1])
assert hostile["scenario"] == "hostile-input-v1" and hostile["milestone"] == "M9" and hostile["result"] == hostile["cleanup"] == "PASS"
assert len(hostile["cases"]) == 24 and {case["id"] for case in hostile["cases"]} == {case["id"] for case in manifest["cases"]}
assert all(case["result"] == "PASS" and case["inputBytes"] <= case["maxInputBytes"] and case["maxMs"] > 0 for case in hostile["cases"])
assert sorted(set(case["threatId"] for case in hostile["cases"])) == sorted(expected_ids)

http = json.loads((temporary / "http-surface.json").read_text(encoding="utf-8"))
assert http == {"transport": "stdio", "orientation": "PASS", "socketListeners": 0, "authSurface": "ABSENT", "stderrProtocolSafe": True}

package = json.loads((root / "package.json").read_text(encoding="utf-8"))
assert package["bin"] == {"ipe-mcp": "dist/src/cli/mcp-stdio.js"}
assert package["scripts"]["mcp"] == "node dist/src/cli/mcp-stdio.js"
entry = (root / "src/cli/mcp-stdio.ts").read_text(encoding="utf-8")
assert 'from "@modelcontextprotocol/server/stdio"' in entry and "serveStdio" in entry
source = "\n".join(path.read_text(encoding="utf-8") for path in (root / "src").rglob("*.ts"))
for forbidden in ['from "node:http"', 'from "node:https"', 'from "node:net"', 'from "node:tls"', "StreamableHTTP", "SSEServerTransport", ".listen(", "WebSocket", "EventSource", "OAuth", "Bearer" + " ", "client_secret"]:
    assert forbidden not in source, f"network/auth surface present: {forbidden}"

retained = "\n".join((root / path).read_text(encoding="utf-8") for path in [
    "docs/milestones/core-m9-threat-audit.md",
    "docs/milestones/core-m9-hostile.md",
    "scripts/gates/check-m9-threat-audit.sh",
    "scripts/conformance/m9-hostile-runner.mjs",
    "fixtures/conformance/m9/hostile/manifest.json",
])
for forbidden in ["/" + "home/", "/" + "mnt/", "Bearer" + " ", "token" + "=", "password" + "=", "PRIVATE" + " KEY"]:
    assert forbidden not in retained, f"private path or secret marker retained: {forbidden}"
assert doc_path.stat().st_size < 32 * 1024
assert (root / "scripts/gates/check-m9-threat-audit.sh").stat().st_size < 32 * 1024
PY

echo "M9 THREAT AUDIT PASS: eight complete dispositions, corrected hostile oracles, no critical finding, stdio-only TM-HTTP N/A, and bounded cleanup"
