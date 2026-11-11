# Ipe MCP

[![npm prerelease](https://img.shields.io/npm/v/ipe-mcp?label=npm%20prerelease&color=245a81)](https://www.npmjs.com/package/ipe-mcp)
[![MIT license](https://img.shields.io/badge/license-MIT-366e52)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-41743c)](https://nodejs.org/)
[![Verified on WSL2](https://img.shields.io/badge/verified-Ubuntu%2026.04%20on%20WSL2-5a4283)](./SETUP-WSL.md)

Ipe MCP lets an AI assistant create and edit drawings and presentations in Ipe.
Ask for a diagram, a slide with LaTeX labels, or a proof that unfolds one step
per click. You get an editable `.ipe` file you can open in Ipe and a PDF or PNG
when you need to present or share it.

## Why use it?

- **Keep the drawing editable.** Revise individual shapes, labels, layers, and
  views in Ipe or ask your assistant to change them in a later turn.
- **Present one step at a time.** Use successive Ipe views to reveal a proof or
  show the next move on a board. Each exported view becomes a PDF page.
- **Review changes before saving.** The assistant works in a separate session.
  You can preview the result, ask for revisions, and explicitly save it.

The Ipe editor window can stay closed while the server works on saved files.

## Install

Run the commands in Ubuntu on WSL2 with Node.js 20 or newer and npm installed.
Use an MCP client that can launch the server in the same WSL environment.

| Install from | Available features |
| --- | --- |
| [npm](#from-npm) or [GitHub Releases](#from-github-releases) | Published prerelease with stdio, editable Ipe documents, discrete views, and native preview and export. |
| [Source candidate](#from-source) | Includes the local deck CLI, supported SVG and PDF import, and authenticated local HTTP. |

### From npm

```bash
npm install --global --ignore-scripts ipe-mcp@1.0.0-rc.1
```

### From GitHub Releases

Install the packaged prerelease directly from the release asset. [Release downloads](https://github.com/Mik1810/ipe-mcp/releases/tag/v1.0.0-rc.1)

```bash
npm install --global --ignore-scripts \
  https://github.com/Mik1810/ipe-mcp/releases/download/v1.0.0-rc.1/ipe-mcp-1.0.0-rc.1.tgz
```

### From source

Run this from a checkout that contains the deck CLI changes from
[#67](https://github.com/Mik1810/ipe-mcp/issues/67). The published
`1.0.0-rc.1` predates those changes. If you already have a candidate tarball,
skip to the final command and use its absolute path.

```bash
npm ci
npm run build
ipe_package_dir="$(mktemp -d)"
npm pack --ignore-scripts --pack-destination "$ipe_package_dir"
npm install --global --ignore-scripts "$ipe_package_dir/ipe-mcp-1.0.0-rc.1.tgz"
```

### Add the tools you need

Basic `.ipe` editing and structural checks use Node.js. For LaTeX rendering,
native validation, and PDF or PNG export, install the native tools separately.
The verified baseline uses Ipe 7.2.30 on Ubuntu 26.04 WSL2. [WSL setup guide](./SETUP-WSL.md)

```bash
sudo apt update
sudo apt install ipe lua5.4 texlive-latex-base texlive-latex-recommended poppler-utils mupdf-tools bubblewrap util-linux
```

Ipe uses `xcolor.sty` from `texlive-latex-recommended` to render deck text.
The native workflow uses MuPDF and Poppler to check artifacts, plus
bubblewrap and `prlimit` (from `util-linux`) to isolate native subprocesses.
The npm package keeps these system tools external.

## Generate an editable deck locally

The [Ipe authoring skill](./plugins/ipe-mcp/skills/ipe-authoring/SKILL.md)
can write a version-1 JSON specification for you, or you can write it by hand.
The JSON already describes the slide order, each object's content and
position, and the layers visible at each click. The CLI reads those
instructions and creates native Ipe objects locally, without starting an MCP
server or calling a model.

### Put the command on your PATH

Install the [source candidate](#from-source) to get `ipe-mcp-cli`. If your
user-writable npm prefix is outside the shell's PATH, add its bin directory
before running the command. Add the same line to your shell startup file to
keep it on PATH:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
command -v ipe-mcp-cli
```

### Example with a formula reveal

Save this as `example.json`. The first view shows only the `base` layer. The
second view keeps the title visible and adds the `formula` layer.

```json
{
  "version": 1,
  "preset": "16:9",
  "slides": [
    {
      "layers": ["base", "formula"],
      "views": [["base"], ["base", "formula"]],
      "objects": [
        {
          "op": "add_text",
          "layer": "base",
          "text": "An example",
          "position": {"x": 80, "y": 580}
        },
        {
          "op": "add_text",
          "layer": "formula",
          "text": "Result: $3^2=9$",
          "position": {"x": 80, "y": 440}
        }
      ]
    }
  ]
}
```

```bash
ipe-mcp-cli example.json --out example.ipe --pdf example.pdf
```

In the `.ipe` you can move the title or edit the formula's LaTeX. The PDF
contains two consecutive pages, one per view. Omit `--pdf` to generate just
the editable file with structural validation using Node.js. PDF export runs
full native validation and requires the separate system tools listed above.

For a larger example with editable paths, see the
[lattice-path deck](./fixtures/decks/lattice-paths.json). See the
[deck specification and diagnostics](./docs/guides/package-installation.md#local-deck-command)
for the supported object types and fields.

## Connect your assistant

Create a dedicated directory for the drawings the server may access.

```bash
mkdir -p "$HOME/ipe-work"
```

### Codex over stdio

Add this to your Codex configuration. Replace `/home/your-user/ipe-work` with
the absolute path to your directory.

```toml
[mcp_servers.ipe-mcp]
command = "ipe-mcp"

[mcp_servers.ipe-mcp.env]
IPE_MCP_WORKSPACE_ROOT = "/home/your-user/ipe-work"
```

You can also install the local Codex plugin, which adds the Ipe authoring skill
and registers the server. [Install the local Codex plugin](./docs/guides/codex-plugin.md#install-locally)

### VS Code or another MCP client

In VS Code, add this configuration to `.vscode/mcp.json`. For another client
that supports stdio, use `ipe-mcp` as the executable and set the same workspace
environment variable in its configuration.

```json
{
  "servers": {
    "ipe-mcp": {
      "type": "stdio",
      "command": "ipe-mcp",
      "env": {
        "IPE_MCP_WORKSPACE_ROOT": "/home/your-user/ipe-work"
      }
    }
  }
}
```

### Authenticated local HTTP

Install from source, then start `ipe-mcp-http` with a private bearer-token file.
Point your client on the same host to `http://127.0.0.1:8765/mcp`.
[Set up the token and connect over HTTP](./docs/guides/local-http.md)

## Try your first slide

Ask your assistant to run `ipe_get_capabilities` to see whether the native
toolchain is available. Then try this prompt.

```text
Create a 16:9 Ipe slide explaining a graph reduction. Draw the input graph
on the left and the construction on the right. Use LaTeX labels and reveal
the construction in three views. Show me a preview before saving the .ipe
file and exporting the PDF.
```

The project is licensed under MIT. [License](./LICENSE)
