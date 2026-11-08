# Run Ipe MCP over local HTTP

The opt-in ipe-mcp-http executable listens on 127.0.0.1 at /mcp. The
existing ipe-mcp executable uses stdio. The HTTP profile requires Linux or
WSL, Node 20+, and the system /usr/bin/flock from util-linux. Native
rendering requires the same verified Ipe toolchain as stdio. On the Ubuntu
baseline, the system util-linux package owns flock. Its Debian copyright
file lists the flock command under Expat. The package does not bundle flock.

Set IPE_MCP_WORKSPACE_ROOT to the directory the client may access.
IPE_MCP_STATE_ROOT defaults to .ipe-mcp-state inside that workspace. A
custom state directory must be inside the workspace with a canonical
existing parent. The state directory belongs to the operator and must have
mode 0700 or stricter. Run one server per state directory. For independent
profiles, use distinct credentials and disjoint workspace and state roots.

Create a private directory outside the workspace and generate a token
without printing it. The following example assumes an installed package
and a workspace at ~/ipe-work.

```sh
mkdir -m 700 ~/.ipe-mcp-credentials
(umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url")+"\n")' > ~/.ipe-mcp-credentials/local.token)
IPE_MCP_WORKSPACE_ROOT=~/ipe-work \
IPE_MCP_HTTP_TOKEN_FILE=~/.ipe-mcp-credentials/local.token \
ipe-mcp-http
```

Set the client endpoint to http://127.0.0.1:8765/mcp and configure the
client's private credential store to send the file's token as a bearer
credential on each request. Use MCP 2026-07-28 or 2025-11-25. The server
rejects browser Origin headers and requires the numeric Host including
the port. It does not support proxies, port forwarding, OAuth or remote
deployment. Do not pass tokens as command-line arguments or URL fields.

IPE_MCP_HTTP_PORT overrides the port. Value 0 requests a system-assigned
port reported by the structural http_started event on stderr.
IPE_MCP_HTTP_DEADLINE_MS can lower the default 125-second exchange deadline.
The body limit is 16 MiB and applies before parsing. Inspect the working
revision before retrying a write after disconnect or timeout.

To revoke the token, stop the process. Replace the file atomically with
a fresh owner-only file before restarting. The service recovers durable
working documents from the same state root. Transient preview and export
resource IDs are process-local.

See the [protocol ADR](https://github.com/Mik1810/ipe-mcp/blob/main/docs/adr/0007-local-streamable-http.md) and
[threat model](https://github.com/Mik1810/ipe-mcp/blob/main/docs/security/tm-http.md) for the deployment and gate criteria.
