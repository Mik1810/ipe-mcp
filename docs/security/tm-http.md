# TM-HTTP — Local Streamable HTTP threat model

The [HTTP ADR](../adr/0007-local-streamable-http.md) defines the supported
protocol revisions and the bearer credential lifecycle. The following
criteria gate implementation and release in #38.

## Trust boundaries

1. An untrusted process or browser reaches a TCP socket. The peer address,
   Host and Origin are admission checks. Only an authenticated request may
   reach the SDK. Forwarded and proxy metadata confer no authority.
2. Untrusted HTTP bytes cross the parser into the SDK. Only a bounded single
   JSON-RPC message reaches the era-specific handler. Its server instance and
   response stream belong to that exchange.
3. The authenticated profile crosses into IpeMcpService. Document and artifact
   IDs identify state in that service. They confer no authority, even when
   another profile guesses or captures an ID. The canonical workspace and
   state roots, revisions, explicit confirmations and atomic write rules
   still apply to tools and resource reads.
4. Application data crosses into native workers and back to the client.
   Existing native provenance, sandbox, timeout, cleanup and document limits
   apply. Logs and gate evidence cross a separate boundary and retain only
   structural data.

Assets include bearer secrets, user documents and assets, their editable
working copies and revision history, native outputs, filesystem metadata,
CPU, memory, descriptors and temporary storage. Attackers include an
arbitrary website (including DNS rebinding and CSRF), another local process
or user, a client holding a valid credential that sends malicious input,
and an operator who misconfigures binding, roots or diagnostics.

## Mitigations and adversarial gate

Admission rejections must never enter an Ipe handler. Domain-level rejections
must leave application state unchanged. Run a real loopback process in an isolated temporary workspace,
using the official SDK and the [portable harness](../adr/0006-provider-neutral-scenario-harness.md)
for positive flows and raw HTTP clients for negative cases.

| Area | Required mitigation | Gate cases |
| --- | --- | --- |
| Binding and rebinding | Bind a numeric 127.0.0.1 socket only. Check peer address and require exactly one Host equal to the listener's actual numeric authority, including its port. Disable forwarding. Validate all Origins by rejecting any present Origin in this non-browser profile. | Loopback works. Wildcard, LAN, IPv6 and forwarded admission fail. Reject Host aliases, foreign or duplicate values, malformed authorities, missing Host, a rebinding hostname, foreign/local/null Origins and duplicate Origin. No CORS allow headers. |
| CSRF and authentication | No ambient cookies, URL credentials, referer trust or CORS. Authenticate each request independently before reading the body or running SDK methods. Refuse malformed, duplicate or invalid Authorization headers. | Missing, incorrect, malformed and duplicate bearer; cookie-only, token in query, preflight, and auth-free discovery all fail. Invalid file type, access mode or symlink prevents startup. After rotation the former credential fails and the current one works. |
| Routing and negotiation | Match the literal endpoint. Bound and parse a single UTF-8 JSON-RPC object, with SDK validation for headers, metadata and framing. Match modern method/name to the body before tool dispatch. | Accept both specified revisions via the SDK. Reject wrong path, queries, malformed/duplicate headers, wrong content type, batches, bad JSON, absent or mixed version metadata and mismatched method/name. Authenticated GET and DELETE return 405. Verify no transport ID, no legacy SSE endpoint and correct notification acknowledgments. |
| Authorization and races | Scope each service instance to its own profile, canonical roots and exclusive state directory. Requests sharing a profile still require expectedRevision and confirmation where applicable. Preserve native artifact and path policy. | Isolated profiles with disjoint roots cannot use each other's document or artifact IDs or route outside a workspace. Concurrent responses stay with their requests, including reused JSON-RPC IDs across clients. Exercise stale revision, missing confirmation, symlink escape, simultaneous saves and a duplicate state-root claim. |
| Resource exhaustion | Start with 16 MiB decoded HTTP request cap, 16 KiB header cap, 5 s header and 10 s body deadlines, 8 active exchanges and 32 connections per process. Start with a global token bucket of 60 admissions per second and a burst of 16 before authentication. Bound work per profile with the exchange cap. Reject content encodings, and enforce streaming limits even when no Content-Length is supplied. Tune limits against the portable scenario and document tighter HTTP bounds where applicable. | Oversized bodies with and without a length, slow headers/bodies, malformed lengths, request flood, compressed bodies and concurrent work saturation. Return bounded 413/429 or close expired connections. Verify recovery after pressure and no orphan streams or workers. |
| Cancellation and cleanup | Propagate transport disconnect/abort to cancellable work, release counters and streams once, and keep the native deadline. Bound admitted exchanges by the configured native timeout plus response/cleanup overhead. Do not interrupt an atomic commit mid-write. Never automatically replay a write when its outcome is unknown. | Disconnect and deadline during upload and native work, cancellation during a write and duplicate delivery. Verify recoverable revisions, no partial writes, bounded child lifetime, and inspect-before-retry guidance. |
| Privacy | No payload, document, resource URL, token, native diagnostic text or path in request logs. Record allowed structural event IDs, status and durations. Set Cache-Control: no-store on responses. Preserve the sanitized public error contract. | Plant canaries in credentials, input, paths and injected failure messages. Check both log streams and retained gate output for leakage. Check responses for generic admission errors and cache control. |
| Shutdown and restart | On SIGTERM/SIGINT stop accepting new work, cancel bounded in-flight work where safe, allow an atomic commit to finish, then close streams and native workers. A hard deadline ends draining. Restart on the same address and recover document state from disk. | Stop during idle and active work, verify release of port, descriptors, temporary files and workers, then restart. The surviving authorized client can inspect the last committed revision. Stdio passes its existing M0-M9 gate. |

## Residual risks

A compromised client, the operator's OS account, or a privileged local
process can read data accessible to that profile. Clients sharing a credential
share its authority, and intentional port forwarding invalidates the deployment
assumptions. Shared host resources mean a local process can still cause
temporary denial of service within or outside the endpoint's quotas. A client
disconnect can leave a successfully committed mutation with no delivered
response. The revision and recovery contract is the reconciliation mechanism.
