# ADR-0007 — Authenticated Loopback Streamable HTTP

- Status: **Accepted** for implementation in M10
- Decision issue: [#37](https://github.com/Mik1810/ipe-mcp/issues/37)
- Implementation issue: [#38](https://github.com/Mik1810/ipe-mcp/issues/38)

## Decision

Expose an opt-in local endpoint at /mcp on the numeric IPv4 loopback address
127.0.0.1. Keep stdio as the default and preserve its CLI, framing and behavior.
The HTTP process serves one configured local operator profile, with a private
state root and an explicit workspace allowlist. Multiple clients configured
with the same credential intentionally share that profile. Operators requiring
separate authorization run separate instances with distinct credentials,
workspace roots and state roots. The HTTP entry point must acquire exclusive use of its state root before
binding, in addition to the existing per-write locks. Keep the state root
inside its allowed workspace, as required by the document service. Remote/LAN binding,
forwarding, reverse proxies, OAuth, browser clients and multi-tenant hosting
are outside the supported deployment boundary.

| MCP revision | Ipe MCP HTTP policy | Wire behavior |
| --- | --- | --- |
| 2026-07-28 | Primary | POST with the per-request version, client metadata and method/name mirrors required by the specification. Use server/discover for capability negotiation. No transport session. |
| 2025-11-25 | Compatibility | Accept initialize and the initialized notification, then require the negotiated version on subsequent POSTs. No transport session. |
| 2025-06-18, 2025-03-26 | Out of profile | These revisions defined Streamable HTTP. Reject explicit requests for these revisions and leave stdio behavior to its existing SDK configuration. |
| 2024-11-05 and earlier | Out of profile | The old HTTP+SSE handshake and separate message endpoint are unavailable. |
| Unknown/future | Out of profile | Return a protocol-appropriate unsupported-version error identifying the supported revisions. |

Legacy negotiation starts with a headerless initialize. Its requested revision
must be 2025-11-25. A missing version on an ordinary legacy request defaults to
2025-03-26 in that revision of the specification, which is outside this profile.
Modern discovery and version correction follow the 2026-07-28 discovery rules
rather than synthesizing a legacy handshake. Check the request envelope and
allowlist before any Ipe handler runs, including versions that the SDK legacy
fallback can otherwise negotiate. Reject mixed modern/legacy envelopes and
mismatched or duplicate critical headers. Answer authenticated GET and DELETE
with 405 and Allow: POST, and issue no Mcp-Session-Id. Support JSON responses
and request-scoped SSE as appropriate. Do not enable stream replay, resource
subscriptions, or server-initiated client interactions in the product profile.
Advertised capabilities must match what the endpoint actually accepts.

Use the installed @modelcontextprotocol/server createMcpHandler with
legacy set to stateless and a new createMcpServer(service) per exchange.
Use the SDK for JSON-RPC, era-specific framing and metadata checks. Keep a
thin Node boundary for binding, HTTP admission, parsing once under a byte
cap, authentication and lifecycle accounting. Forward the parsed body to the
SDK. Any Node bridge must preserve abort/backpressure behavior and must pass
the socket-level gate. The IpeMcpService owns document IDs, revisions,
recovery and the workspace policy. A new SDK server, client reconnect,
credential rotation or server restart does not change document identity.
The process must still apply revision guards, confirmations and filesystem
rules to every authorized call.

## Authentication and credentials

The operator provisions a dedicated 32-byte cryptographically random bearer
secret encoded as unpadded base64url. Deliver it only through the
Authorization: Bearer header on every request, including discovery and notifications. Read it from a regular owner-only
credential file on a private directory outside all served workspace roots.
Open safely without following symlinks and check the opened file's type,
owner and permissions. Reject invalid configuration before binding. Configure
the client through its private credential store or token-file mechanism.
Compare fixed-length decoded tokens in constant time. Respond 401 with a
generic Bearer challenge for missing or invalid credentials. This is a
preconfigured local bearer mechanism. OAuth discovery, token issuance and
delegated access are separate designs.

Never put the credential in a URL, query, command-line flag, logs, telemetry,
error payloads or retained evidence. Reject endpoint queries. Forward neither
cookies nor client-supplied authorization context to the application. Rotate
by atomically replacing the credential file and restarting the endpoint,
with no dual-key acceptance. For urgent revocation stop the endpoint before
restarting with a new key. Rotation preserves the application state directory.
Restricting the listener to loopback limits network exposure. A local process
able to read the operator's client configuration or process memory can
impersonate that operator.

## Capability and SDK evidence

Run npm ci, then npx vitest run tests/mcp/http-sdk.test.ts. With the lockfile's
TypeScript SDK 2.0.0, the real client and handler exchange HTTP-shaped messages
using injected fetch, without opening a socket. The probe verifies the
2025-11-25 wire header, pinned 2026-07-28 discovery and tool/resource headers,
no transport ID, parity of the orientation text and structured content, and
reading a document created by the legacy client from the modern client after
disconnect. The build checks SDK types. The probe establishes SDK wiring and
document-state independence. Socket admission and lifecycle are release
criteria in [TM-HTTP](../security/tm-http.md).

The implemented gate will discover the negotiated revision, advertised tool
and resource capabilities, and the selected Ipe backend. It will call
ipe_orientation, ipe_get_capabilities, and run the portable authoring scenario
over real loopback for both revisions. Report the observed revision, capability
mode and assertion outcomes. Retain no headers, request bodies, document IDs,
absolute paths, credentials or artifacts from the probe.

## References

- [Streamable HTTP, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Streamable HTTP, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Authorization, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Provider-neutral scenario harness](0006-provider-neutral-scenario-harness.md)
