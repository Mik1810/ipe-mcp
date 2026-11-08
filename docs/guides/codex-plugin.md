# Local Codex Plugin Template

The template registers a local stdio Ipe MCP server and one authoring skill. It
uses the officially supported Codex compatibility manifest
(`.codex-plugin/plugin.json` and `.mcp.json`). Codex CLI 0.164.0 installed the
portable manifest in testing but did not expose its MCP server. The
compatibility layout passed the installed-plugin workflow on this version.

## Install locally

Run these commands from the checkout in native Ubuntu WSL with Node.js 20+,
Codex CLI, and the [Ipe 7.2.30 native toolchain](../../SETUP-WSL.md). Install the
exact package version in a private directory. Choose an existing directory for
the documents Ipe MCP should be allowed to access.

```bash
IPE_PLUGIN_BASE=$(mktemp -d)
mkdir "$IPE_PLUGIN_BASE/deps" "$IPE_PLUGIN_BASE/documents"
npm install --prefix "$IPE_PLUGIN_BASE/deps" --ignore-scripts ipe-mcp@1.0.0-rc.1
node scripts/tools/prepare-codex-plugin.mjs \
  --executable "$IPE_PLUGIN_BASE/deps/node_modules/.bin/ipe-mcp" \
  --workspace "$IPE_PLUGIN_BASE/documents" \
  --output "$IPE_PLUGIN_BASE/marketplace"
codex plugin marketplace add "$IPE_PLUGIN_BASE/marketplace"
codex plugin add ipe-mcp@ipe-mcp-local
```

Open a new Codex session. Ask Ipe MCP to create a 16:9 drawing with a rectangle,
validate it, save it to the configured directory, and export a PDF. The skill
uses the server's current capabilities, revisions, and explicit confirmations.
A `structural-only` backend can edit Ipe XML and cannot run native export.

## Permissions, privacy, and rollback

The generated config launches the selected executable directly over stdio. It
contains the local executable, workspace, and state paths and is intended for
that machine. The plugin has no hooks, authentication, UI, network server, or
automatic dependency installation. It relies on the normal Codex approval
settings and Ipe MCP's workspace, revision, and confirmation checks. Keep the
workspace dedicated to the documents you want the server to access. The host
can receive document content and generated resources through MCP tool calls.

To uninstall, run `codex plugin remove ipe-mcp@ipe-mcp-local` and start a new
session. Remove the local catalog with
`codex plugin marketplace remove ipe-mcp-local` when it is no longer needed.
Keep your documents and state directory if you intend to reinstall or restore
a previous package version. For rollback, prepare a new local catalog from a
checkout and exact package version verified together.

## Verification and distribution

Run `bash scripts/gates/check-m10-codex-plugin.sh`. It installs a local package
tarball with lifecycle scripts disabled, registers a private catalog under an
isolated Codex profile, runs the unchanged portable scenario through the
installed server, and verifies that uninstall removes its MCP registration
while preserving the saved file.

The plugin and helper are MIT licensed. The system Ipe and its native
dependencies remain external and retain their own licenses. See the
[distribution ADR](../adr/0005-distribution-versioning-and-native-dependencies.md) and
[OpenAI's desktop-only submission guidance](https://developers.openai.com/plugins/deploy/desktop-only).
The generated catalog is for local use. A public submission would require a
separately reviewed package with portable dependency wiring, publisher and
privacy metadata, and eligibility for local MCP submission.
