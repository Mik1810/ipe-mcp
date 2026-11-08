# ADR-0008 — Consent-driven bridge to an open Ipe process

- Status: **Accepted for implementation**
- Decision and spike: [#39](https://github.com/Mik1810/ipe-mcp/issues/39)
- Bridge implementation: [#40](https://github.com/Mik1810/ipe-mcp/issues/40)

## Decision

Use an explicitly invoked Lua ipelet and a private, local file handoff
managed by an Ipe MCP broker. A user attaches a specific open document
through the ipelet. Each outbound snapshot and each inbound application
requires a separate Ipe action. Incoming proposals may be listed or
validated without modifying the open document. Keep the server's existing
stdio and HTTP deployment boundaries independent of the bridge.

| Candidate | Decision and evidence |
| --- | --- |
| Lua ipelet | Selected to access the in-memory Ipe document, dirty state and undo stack. The spike runs in the real Qt application and directly observes all three. |
| File watcher on the open source | Rejected as a synchronization authority. Replacing the source file while Ipe is dirty left the open in-memory revision unchanged in the spike. A watcher may only prompt a fresh inspect. |
| Private spool and sidecar | Selected for bounded messages, sequence, acknowledgments and reconnect state. Publish each complete entry by atomic rename. Read bounded data as data, without evaluating Lua or shell commands. Keep the open source separate from handoff files. |
| Socket or public HTTP IPC | Deferred. The spike verified access from inside Ipe using its Lua model and local files. It established no need for a listener or a runtime Lua networking dependency. |
| C++ ipelet or embedded Ipelib | Deferred. The selected spike uses the Lua Ipe model and an external broker process. Native ABI and GPL distribution review would be required before adopting a compiled or linked alternative. |

## Ownership and revision mapping

- Ipe owns the open model, unsaved edits, view and selection. The MCP
  service owns its working document, expectedRevision and history. The
  source file belongs to the operator. The broker never overwrites it.
- A bridge binding maps a random attachment ID and connection epoch to one
  Ipe document instance and one existing MCP document ID. A filename,
  title, window number or process ID is insufficient to rebind. A fresh
  open or restart requires an explicit attach and full snapshot. Persist
  the last confirmed base and receipt journal separately from the source.
- A confirmed base contains the MCP revision and the accepted Ipe
  snapshot identity. Compare the current Ipe snapshot, the base and the
  broker's proposed candidate. The broker assigns a bounded monotone
  sequence per epoch and computes SHA-256 over the exact admitted
  snapshot bytes. A changed source-file identity is independent evidence
  of divergence, even if the GUI model still matches the base.
- Preserve existing Ipe MCP IDs via the canonical parser and sidecar.
  Reconcile missing GUI IDs only when mapping is unique. Reject ambiguous
  matches instead of silently minting replacements for tracked objects.
  The implementation gate must verify stable identity across actual Ipe
  edits, save, reload and undo.
- An inbound proposal records its base, target revision, sequence and
  digest. Load the bounded candidate into an isolated temporary model,
  present its effect and bind confirmation to that exact staged content.
  Verify the live baseline again after the confirmation, immediately
  before applying. Apply only through a supported single undoable
  transaction. Prove that operation in #40 before enabling inbound
  application for a platform or Ipe version.

## Ordering, conflicts and recovery

| State | Event | Required transition |
| --- | --- | --- |
| Detached | Operator attaches one open document | Establish a new epoch. Capture both baselines and report any existing divergence before enabling proposals. |
| Attached | Operator sends the working copy | Capture and submit that exact snapshot. Accept only if its base still matches the current MCP revision. Record the new common base after an acknowledgment. |
| Attached | MCP offers a candidate | Enter Pending review. Listing or loading into the private staging model leaves the live GUI and source untouched. |
| Pending review | Operator declines or consent expires | Return to Attached and record a rejection. Discard the staged candidate. |
| Pending review | Operator accepts, base and sequence match | Apply the staged candidate as one undoable GUI operation. Record the resulting revision and receipt, then acknowledge. |
| Attached or Pending review | Ipe edits/undo, MCP revision moves, or file identity changes since the base | Enter Conflict. Freeze writes and show the two working copies, the common base and the relevant revision differences. Resolve only through a fresh explicit choice, such as export a separate copy or start a new base. |
| Any attached state | Duplicate message or lost acknowledgment | Return a prior receipt only if the epoch, sequence and digest match. Unknown delivery remains unresolved until the actual revision is inspected. |
| Any attached state | Process exit, reconnect, crash or stale epoch | Discard unapproved proposals. Reconcile durable receipts and actual snapshots before a new base. Never automatically replay a GUI mutation with an uncertain outcome. |

An atomic spool entry is complete only after it has been closed and
renamed into its final name. A GUI acceptance receipt acknowledges the
application. A disk commit remains a separate operator save action. If the
GUI crashes after applying and before acknowledging, the broker marks the
outcome uncertain. After a restart it compares the newly offered snapshot,
the prior base and any available Ipe recovery copy without overwriting any
of them. GUI undo is another state change, so an approval based on the old
revision expires.

## Threat and license boundary

Use a private directory owned by the operator outside served workspace
roots. Bind to one explicit attachment ticket, reject symlinks and unexpected
owners, cap message and snapshot sizes, use fixed relative entry names and
open entries without following links. Authenticate pairing through the
operator's trusted local channel. An untrusted workspace, stale process, symlinked spool or replayed approval
must not gain GUI write authority. The spool must never load executables or
Lua extensions. The gate in #40 must exercise these cases and the same-account
and crash boundaries. A process that already controls the operator's OS
account or loaded Lua extensions is outside that local trust boundary.

Retain only structural event types, revisions and bounded diagnostics.
Never retain tokens, absolute paths, titles, XML, screenshots or raw
messages in harness evidence. The broker treats file contents as hostile
Ipe input and uses the existing XML/TeX/path policy. Its tool output exposes
approved document IDs and conflict state, not broker paths. Keep process
and library boundaries explicit. The installed Ipe package is GPL-3+
with a CGAL exception for applicable code. The spike uses an original Lua
driver and the system Ipe executable, with no copied Ipe source or linked
native code in the server. Review the installed ipelet distribution and
license boundary again for #40.

## Verified capability and limits

Run bash scripts/gates/check-m10-bridge-spike.sh on the Ubuntu 26.04 WSL
baseline with package ipe 7.2.30-1build2. The gate launches /usr/bin/ipe
with Qt's offscreen platform and a disposable fixture. A timer fires inside
its running event loop after the document opens. The probe creates a
reversible fixture-only edit through Ipe's undo API, invokes the ipelet
through Ipe's menu dispatch to snapshot the dirty document as separate XML, replaces the copied source from outside
Ipe, and verifies that Ipe still reports the unsaved in-memory title and
that native Undo restores the previous title without writing the source.
The process is stopped and its private workspace removed. A test-only
hook schedules the probe. Production consent must use explicit ipelet
actions.

Verified here: Linux Qt model access, dirty-state capture, snapshot
serialization, separation from external file replacement and native
Undo. The spike exercises no production pairing, protocol, approval
dialog or inbound synchronization. macOS, Windows, later Ipe revisions
and other GUI toolkits need independent evidence.

## References

- [Ipe 7.2.30 manual](https://ipe.otfried.org/ipe-manual.pdf), ipelets and scripts.
- [Persistence and identifiers](0003-backend-persistence-and-identifiers.md).
- [Security and trust boundaries](0004-security-and-trust-boundaries.md).
- [Provider-neutral harness](0006-provider-neutral-scenario-harness.md).
