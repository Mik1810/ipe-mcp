# Package Installation

Lifecycle: **Maintained**. Audience: operators and MCP host integrators. This
guide covers the thin `ipe-mcp` npm artifact approved by ADR-0005. Version
`1.0.0-rc.1` is a locally gated package candidate; it has not been published
to the npm registry, tagged, or released on GitHub.

## What the Package Contains

The package contains the compiled JavaScript server, declarations, the
`ipe-mcp` stdio executable, two MIT runtime attestation helpers, the generated
candidate SBOM, MIT license, README, and essential package/support guides. It
contains no tests, fixtures, agent/editor configuration, local state, source
maps, secrets, or native GPL/AGPL executables.

Ipe, TeX, Poppler, MuPDF, Lua, bubblewrap, and `prlimit` remain separate system
programs. Installing the npm package does not download or install them, change
global MCP configuration, migrate documents, start a network listener, or
enable telemetry.

## Supported Native Prerequisites

The first full packaged lane is Ubuntu 26.04 on WSL2 with Ipe 7.2.30. Review
and run the native installation separately:

```bash
sudo apt update
sudo apt install ipe lua5.4 texlive-latex-base poppler-utils mupdf-tools bubblewrap
```

The server probes executable paths, Debian package ownership, versions, and
Ipe/Ipelib coherence at runtime. Missing or unsupported native tools produce
classified capability diagnostics; the npm installer never repairs the host.
Other platforms are not supported merely because npm installation succeeds.

## Build and Verify a Local Candidate

From a clean repository checkout:

```bash
npm ci
npm run check:m10:package
```

The gate builds `1.0.0-rc.1`, audits the exact allowlisted tarball, scans for
secret-like content and native binaries, generates and checks the candidate
SBOM, installs the tarball in an isolated temporary project with lifecycle
scripts disabled, verifies fail-closed missing-native diagnostics, and runs an
MCP stdio create/validate/render/export smoke with zero network listeners.
Temporary packages, dependencies, state, and artifacts are deleted afterward.
The gate never publishes, tags, edits a dist-tag, or changes global config.

To retain a tarball for a manual local installation, choose an explicit output
directory outside the repository:

```bash
PACKAGE_OUTPUT=$(mktemp -d /tmp/ipe-mcp-package-XXXXXX)
npm pack --pack-destination "$PACKAGE_OUTPUT"
npm install --global "$PACKAGE_OUTPUT/ipe-mcp-1.0.0-rc.1.tgz"
```

The global installation is an explicit user action. A project-local install
from the tarball is also supported; pin the exact filename/version rather than
depending on an unreviewed moving tag.

## MCP Host Configuration

The installed command communicates over stdio. A host configuration supplies
the command and explicit workspace/state roots; stdout is reserved for MCP
frames and diagnostics go to redacted stderr.

```toml
[mcp_servers.ipe-mcp]
command = "ipe-mcp"
env = {
  IPE_MCP_WORKSPACE_ROOT = "/absolute/allowed/workspace",
  IPE_MCP_STATE_ROOT = "/absolute/allowed/workspace/.ipe-mcp-state"
}
```

After connection, call `ipe_orientation`, then `ipe_get_capabilities`. The
supported packaged lane must report product `1.0.0-rc.1` during MCP initialize,
contract `ipe-mcp/1`, and capability mode `full-7.2.30`. A
`structural-only` result is usable only within its explicitly degraded limits.

## Update and Rollback

There is no automatic updater. Retain the previous exact tarball or, after a
future registry publication, install an exact SemVer. Restart the MCP
connection and re-query orientation/capabilities after every change.

For this first package candidate, rollback means uninstalling the candidate
and returning to the retained M9 `0.1.0` source checkout, or installing a
previous retained prerelease tarball once one exists. A major downgrade also
requires reviewing sidecar and document migration notes. Installation and
rollback do not implicitly rewrite documents or `.ipe-mcp-state`.

Public npm publication, a Git tag, a GitHub Release, or a `latest` dist-tag
change remains a separate owner-authorized action after all gates pass.
