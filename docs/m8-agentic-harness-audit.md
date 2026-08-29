# M8 Issue #8 agentic-harness audit

Audit target: M8 / Issue #5. Owner for every deferred item is **M9 / Issue #6** unless noted. Evidence abbreviations: `C` contracts tests, `P` real stdio protocol tests, `S` service tests, `H` retained real-host evidence, `E` independent portable scenario, `D` M8 docs.

## Model-facing contract

| Item | Result | Evidence / rationale |
|---|---|---|
| Compact independently useful instructions | PASS | `SERVER_INSTRUCTIONS`; C truncation terms/size |
| Naming grammar and predictable results | PASS | `ipe_` tools; `ipe-mcp/1` result schema; C/P |
| Semantic tool/field descriptions | PASS | strict Inspector `tools/list`; H |
| Corrective validation/runtime errors | PASS | stable errors/corrections; C/P/S |
| Guidance in text and structured output | PASS | identical JSON plus resource links; P/E/H |

## Orientation and dynamic behavior

| Item | Result | Evidence / rationale |
|---|---|---|
| Stable bootstrap | PASS | `ipe_orientation`; P/H |
| Identity/capability/count/routing context | PASS | orientation, capabilities, inspect; P/E |
| State-aware versioned guidance | PASS | revision/conflict/hints and instructionsVersion 1; P/S |
| Explicit truncation/limits/staleness | PASS | outline/source bounds and recovery hints; C/P/S |

## Result quality and recovery

| Item | Result | Evidence / rationale |
|---|---|---|
| Typed capped hints, quiet success | PASS | maximum three; C/P |
| False exact matches / hallucinated IDs | PASS | ID schemas plus exact lookup and rollback; S |
| Categorical confidence | NOT APPLICABLE | M8 makes no scored/probabilistic decisions |
| Exact lookup with safe semantic fallback | NOT APPLICABLE | entity fallback is unsafe; names never substitute for IDs |
| Minimal actionable public shapes | PASS | bounded outline/diagnostics/artifact metadata; P/E |
| Sanitize untrusted model-facing text | PASS | path/content redaction and diagnostic bounds; C/P |

## Permissions and write safety

| Item | Result | Evidence / rationale |
|---|---|---|
| Per-connection personalized surface | NOT APPLICABLE | local stdio MVP has one uniform workspace-scoped permission set |
| Structurally omit unavailable tools | NOT APPLICABLE | no per-user/auth capability surface in M8 |
| Duplicate-create policy/override | PASS | deliberate distinct local sessions documented by orientation; no external record collision |
| Meaningful previous update values | PASS | bounded `previousValues`; S |
| Destructive annotation/confirmation/deleted evidence | PASS | DELETE/SAVE/UNDO/RESTORE guards; deleted IDs; S/P |
| No premature async completion | NOT APPLICABLE | M8 operations are synchronous and verified before success |

## Transport, integration, and privacy

| Item | Result | Evidence / rationale |
|---|---|---|
| Progress and bounded timeouts | PASS | progress for full validate/render/export; M6 deadlines; P/E |
| Discriminated upstream HTTP failures | NOT APPLICABLE | no HTTP/upstream service in stdio M8 |
| Expiry/reinit/restart/scaling plan | PASS | restart recovery documented/tested; expiry/scaling belong to M10 HTTP, not stdio |
| OAuth vs upstream credentials | NOT APPLICABLE | no auth, remote credentials, or upstream network in M8 |
| Declarative telemetry redaction/fail closed | PASS | fixed structural `safeLog`; unknown values become lengths; C/P |

## Code architecture and verification

| Item | Result | Evidence / rationale |
|---|---|---|
| Controllers/use cases/mappers/transport/telemetry separation | PASS | contracts/errors/service/artifacts/server/CLI boundaries; D |
| Deliberate feature facade | PASS | server depends on `IpeMcpService`; core has no MCP imports |
| Central behavioral vocabulary | PASS | contract version, schemas, hint cap, annotations, orientation constants; C |
| Actual clients: visibility/parity/progress/recovery | PASS | Inspector 2.4.0 launcher/remote-session protocol automation completed one persistent 14-call workflow and three distinct generated-resource reads; its web UI separately passed a minimal discovery/create/document-summary/disconnect smoke in 13 browser rounds; Codex CLI and SDK host also complete the scenario; P/H/E |
| Rejected/deferred mechanisms documented | PASS | exact-ID fallback, stdio permissions, M10 HTTP/OAuth, and connection-local artifacts; D |

## Disposition

PASS: 24. NOT APPLICABLE: 7. DEFERRED M9: 0. No M8 blocker is knowingly deferred. Full fuzzing, SBOM/release provenance, dependency audit, and expanded host matrices remain M9 work because they are outside these individual M8 compliance bullets.
