# Package Installation

Lifecycle: **Maintained**. Audience: operators and MCP host integrators. This
guide covers the thin `ipe-mcp` npm artifact approved by ADR-0005.
`1.0.0-rc.1` is available from npm and GitHub Releases. The local deck command
requires a source candidate that includes #67, even when the candidate has
the same package version as the published prerelease.

## What the Package Contains

The source candidate contains the compiled JavaScript server, declarations,
the stdio server and local deck command, MIT runtime helpers, the generated
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
sudo apt install ipe lua5.4 texlive-latex-base texlive-latex-recommended poppler-utils mupdf-tools bubblewrap util-linux
```

The server probes executable paths, Debian package ownership, versions, and
Ipe/Ipelib coherence at runtime. Missing or unsupported native tools produce
classified capability diagnostics; the npm installer never repairs the host.
Other platforms are not supported merely because npm installation succeeds.

## Local deck command

Run `ipe-mcp-cli <spec.json> --out <deck.ipe> [--pdf <deck.pdf>]` using new
filenames in existing output directories. The command works independently of
MCP and keeps its authoring state in a private temporary directory. It refuses
to overwrite either target. With `--pdf`, full native validation must pass
before the command writes the outputs.

The [original lattice-path example](../../fixtures/decks/lattice-paths.json)
illustrates the version-1 JSON format:

- Set `version` to `1` and `preset` to `"16:9"` or `"standard"`. The preset
  applies to the entire deck. `title` is optional document metadata.
- List `slides` in presentation order. Each slide has an optional metadata
  `title` and three required arrays, `layers`, `views`, and `objects`.
- Declare unique, whitespace-free layer names. Each entry of `views` is a
  nonempty ordered array of visible layer names on that slide. Its first layer
  is active. For a reveal, list the base view first and add the new layer in
  the next view. Layer membership determines visibility and object order
  determines stacking. A slide with no reveals still needs one view.
- Use `add_text`, `add_rectangle`, `add_segment`, or `add_path` objects in
  back-to-front order. Each uses the corresponding `ipe_apply_operations`
  fields with a slide-local `layer` name in place of `pageId` and `layerId`.
  Place text and shapes in Ipe coordinates (bp, y up). Use LaTeX fragments such
  as `Count: $x^2$` for editable math. The native reload check currently
  requires a text prefix or suffix for dollar-delimited labels because Ipe
  rewrites an entirely math-mode label into a different XML form.

The command rejects unsupported versions, presets, operations, and fields.
Use the slide/object numbers or field paths in the diagnostic to fix the JSON.
For `NATIVE_UNAVAILABLE`, install the supported external prerequisites above
or omit `--pdf` to create the editable deck with structural validation only.

## Build and Verify a Local Candidate

From a clean repository checkout:

```bash
npm ci
npm run check:m10:package
```

The gate builds `1.0.0-rc.1`, audits the exact allowlisted tarball, scans for
secret-like content and native binaries, generates and checks the candidate
SBOM, installs the tarball in an isolated temporary project with lifecycle
scripts disabled, verifies fail-closed missing-native diagnostics, and runs the
ADR-0006 provider-neutral MCP stdio create/edit/recovery/validate/render/export
scenario with zero network listeners and a redacted portable result bundle.
Temporary packages, dependencies, state, and artifacts are deleted afterward.
The gate never publishes, tags, edits a dist-tag, or changes global config.

To retain a tarball for a manual local installation, choose an explicit output
directory outside the repository:

```bash
PACKAGE_OUTPUT=$(mktemp -d /tmp/ipe-mcp-package-XXXXXX)
npm run build
npm pack --ignore-scripts --pack-destination "$PACKAGE_OUTPUT"
npm install --global --ignore-scripts "$PACKAGE_OUTPUT/ipe-mcp-1.0.0-rc.1.tgz"
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

For the optional local Codex integration, see the [plugin template](./codex-plugin.md).

## Update and Rollback

There is no automatic updater. Retain the previous exact tarball or install
an exact published SemVer. Restart the MCP
connection and re-query orientation/capabilities after every change.

For this first package candidate, rollback means uninstalling the candidate
and returning to the retained M9 `0.1.0` source checkout, or installing a
previous retained prerelease tarball once one exists. A major downgrade also
requires reviewing sidecar and document migration notes. Installation and
rollback do not implicitly rewrite documents or `.ipe-mcp-state`.

Public npm publication, a Git tag, a GitHub Release, or a `latest` dist-tag
change remains a separate owner-authorized action after all gates pass.
