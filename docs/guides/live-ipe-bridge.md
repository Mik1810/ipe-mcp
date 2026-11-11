# Synchronize with an open Ipe document

The opt-in bridge uses Ipe 7.2.30 Qt on the verified Ubuntu 26.04 WSL
lane. Both Ipe and the MCP stdio server run as the same local operator.
Give them a private, existing mode-0700 spool outside all served
workspaces and keep that directory for the lifetime of active proposals.
The bridge stays disabled unless the stdio server receives
IPE_MCP_BRIDGE_ROOT. The HTTP listener does not load the bridge.

Install bridge/ipe-mcp-live.lua into an Ipe ipelet directory. The packaged
bridge/ipe-mcp-transaction.lua is a library. Keep it outside the ipelet
scan path. Set IPE_MCP_WORKSPACE_ROOT and IPE_MCP_BRIDGE_ROOT in both
processes. In the Ipe process, set IPE_MCP_BRIDGE_TRANSACTION to the
absolute library path and IPE_MCP_BRIDGE_PEER to the absolute packaged
dist/src/cli/bridge-peer.js path. The ipelet invokes the local Node
executable from PATH. Restart Ipe to load the menu.

1. Open the same canonical .ipe source in Ipe and with ipe_open_document.
   Run ipe_bridge with action invite, the document ID and its current
   revision. In Ipe choose Attach this document and enter the returned
   attachment ID. Run attach to acknowledge the first snapshot. Both
   copies must agree before attaching. A file replaced on disk or an
   already divergent open copy requires explicit reconciliation.
2. To send changes from Ipe, choose Send working copy and run ingest for
   the sequence reported in Ipe. The broker imports into the private
   MCP working revision. The open source file is not overwritten.
   Preserve existing object carriers. When two edits could refer to
   the same untagged entity and identity cannot be proved, the broker
   stops with BRIDGE_CONFLICT.
3. To send a change to Ipe, run offer with the next sequence and current
   expectedRevision. In Ipe choose Review MCP proposal and confirm or
   decline the working-copy replacement. The prompt identifies the
   revisions, page counts and exact proposal digest. After approval,
   run authorize, then choose Apply approved proposal in Ipe. Run settle
   to verify the resulting GUI snapshot. A declined proposal also needs
   settle. The source file is saved only by an explicit normal save.
4. If a process stops after authorization, the working revision stays
   reserved. Reopen the exact baseline or applied document and choose
   Recover pending outcome. Enter the attachment ID, sequence, and
   applied or unchanged. Run settle to release the reservation after
   verification, then create a new invitation for the reopened window.
   If neither snapshot matches, preserve both copies and resolve the
   divergence before further writes. A recovery command does not apply
   or replay the proposal.

The spool is local to the operator account. Keep the attachment ID and
private paths out of shared logs. Same-account programs and installed
ipelets are trusted within this boundary. The GUI does not run LaTeX
during bridge application. Native validation regenerates the derived text
metrics and preserves declared minipage widths.

Run npm run check:m10:bridge for the real stdio and Ipe Qt protocol gate
on the verified native lane. The gate drives production menu dispatch
offscreen with deterministic yes and no dialog answers. See the
[bridge ADR](https://github.com/Mik1810/ipe-mcp/blob/main/docs/adr/0008-live-ipe-bridge.md).
