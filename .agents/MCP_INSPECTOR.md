# MCP Inspector Verification Policy

Use this policy whenever an acceptance criterion requires verification with MCP Inspector.

## Default split

### 1. Inspector CLI — complete deterministic workflow

Use MCP Inspector CLI for protocol-level workflow verification when supported. Prefer a repository script that performs the scenario in one/few shell invocations and emits a compact summary.

Typical coverage:

- initialize/connect;
- tools/resources discovery;
- create/open session/document;
- representative mutations with expected revision/CAS behavior;
- stale mutation rejection;
- snapshots/undo/recovery when required;
- validation;
- render/export/resource retrieval;
- stdout/stderr protocol cleanliness;
- shutdown.

The exact scenario must follow the milestone acceptance criteria; the list above is not a requirement to test unrelated capabilities.

Preferred output shape:

```text
Inspector <version>
preflight        PASS
discovery        PASS
workflow         PASS
stale-revision   PASS
resources        PASS
protocol-stdout  PASS
shutdown         PASS
RESULT           PASS
```

Do not dump every JSON-RPC frame into model context unless diagnosing a failure.

### 2. Inspector web/TUI — minimal client-specific smoke

Use web/TUI only to prove client-specific integration not already established by CLI.

Normal web smoke:

1. start/connect with the correct explicit child environment/configuration;
2. confirm server/tool/resource discovery;
3. run one representative tool;
4. inspect/read one representative resource/result;
5. confirm clean completion.

Do not replay the complete M8 scenario through `agent-browser` merely to prove Inspector integration.

## Preflight requirement

Before any long Inspector workflow verify:

- Inspector version/capability;
- exact server command;
- explicit child environment propagation (including workspace/config variables);
- workspace isolation;
- successful connection/discovery;
- one cheap call.

Environment propagation must be proven **before** creating large scenario state.

## Browser automation rules

- Browser target <= 10 rounds, <= 15 with UI-specific justification.
- Do not `snapshot` after every click/fill/wait.
- Prefer one snapshot after connection/discovery, one at the representative result, and only additional snapshots when state is uncertain.
- Reuse known selectors and persistent session state.
- Do not open multiple fresh browser sessions to repeat the same deterministic scenario.

## Failure/retry

If an Inspector workflow fails because the child process did not receive expected environment/configuration:

1. stop immediately;
2. correct invocation/configuration;
3. prove it with preflight;
4. only then restart the scenario.

One bounded full retry after successful preflight is enough. A second infrastructure failure should be reported as blocked with evidence.
