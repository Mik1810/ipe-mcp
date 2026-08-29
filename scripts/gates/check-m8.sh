#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
M8_TMP=$(mktemp -d)
trap 'rm -rf "$M8_TMP"' EXIT
fail() { echo "M8 FAIL: $*" >&2; exit 1; }

bash "$ROOT/scripts/gates/check-m7.sh" || fail "M7 gate"
(cd "$ROOT" && npm run build) || fail "build"
(cd "$ROOT" && npm test -- --run tests/mcp) || fail "MCP tests"
(cd "$ROOT" && node scripts/host/m8-sdk-host.mjs "$M8_TMP/scenario" > "$M8_TMP/sdk-host.json") || fail "independent real-stdio portable scenario"

python3 - "$ROOT" "$M8_TMP" <<'PY' || fail "M8 artifacts, configs, audit, or host evidence"
import json, pathlib, re, struct, sys, xml.etree.ElementTree as ET
root, tmp = map(pathlib.Path, sys.argv[1:]); manifest=json.loads((root/'fixtures/conformance/m8/manifest.json').read_text()); result=json.loads((tmp/'sdk-host.json').read_text())
assert manifest['milestone']=='M8' and manifest['format']==70218 and result['scenario']==manifest['scenario']
assert result['staleRollback']==result['undoRestore']==result['fullValidation']=='PASS' and result['resourcesRead']==3 and result['stderrProtocolSafe'] is True
out=tmp/'scenario'
assert ET.parse(out/'portable-scenario.ipe').getroot().get('version')=='70218'
assert (out/'portable-scenario.pdf').read_bytes().startswith(b'%PDF-')
png=(out/'portable-scenario.png').read_bytes(); assert png[:8]==b'\x89PNG\r\n\x1a\n' and struct.unpack('>II',png[16:24])==(1280,720)
evidence=json.loads((root/'fixtures/conformance/m8/host-evidence.json').read_text())
assert evidence['scenario']=='portable-m8-v1' and {h['host'] for h in evidence['hosts']}==set(manifest['requiredHosts'])
assert all(h['protocol']=='stdio' and h['result']=='PASS' for h in evidence['hosts'])
inspector=next(h for h in evidence['hosts'] if h['host']=='mcp-inspector')
assert inspector['candidateDigest']=='b35d7c398613542d8aa3fc4160c5b799dd6936c7'
assert re.fullmatch(r'[0-9a-f]{40}', inspector['candidateDigest'])
assert inspector['preflight']=='PASS'
assert inspector['deterministicInterface']=='inspector-launcher/web-remote-session-protocol-api-over-stdio'
assert inspector['completeWorkflow'] is True and inspector['singleSession'] is True
assert isinstance(inspector['operationCount'], int) and inspector['operationCount'] >= 14
assert isinstance(inspector['resourceReads'], int) and inspector['resourceReads'] >= 3
assert isinstance(inspector['distinctResourcesRead'], int) and inspector['distinctResourcesRead'] >= 3
assert inspector['staleRollback']==inspector['undoRestore']==inspector['fullValidation']==inspector['cleanup']=='PASS'
assert inspector['protocolOnlyStdout'] is True and inspector['safeStderr'] is True
assert inspector['shutdown']=='PASS' and inspector['webSmoke']=='PASS'
assert isinstance(inspector['webBrowserRounds'], int) and 1 <= inspector['webBrowserRounds'] <= 15
assert isinstance(inspector['webResourceReads'], int) and inspector['webResourceReads'] >= 1
checks=inspector['artifactChecks']
assert checks['ipeFormat']==70218 and checks['ipeBytes'] > 0 and checks['pdfHeader']==checks['pngHeader']=='PASS'
assert checks['pdfBytes'] > 0 and checks['pngBytes'] > 0 and (checks['pngWidth'], checks['pngHeight'])==(1280,720)
audit=(root/'docs/guides/m8-agentic-harness-audit.md').read_text(); assert audit.count('| PASS |')==24 and audit.count('| NOT APPLICABLE |')==7 and 'DEFERRED M9: 0' in audit
assert '[mcp_servers.ipe-mcp]' in (root/'.codex/config.toml').read_text()
assert '"ipe-mcp"' in (root/'.vscode/mcp.json').read_text()
PY

echo "M8 PASS: M7, strict/versioned MCP contracts, transactional stdio protocol, privacy/native failure/progress, portable Ipe/PDF/PNG resources, and Inspector/Codex/independent-host evidence"
