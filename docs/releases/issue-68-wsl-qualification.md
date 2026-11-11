# File-based release qualification on Ubuntu WSL2

**2026-11-09 · PASS** for the local candidate identified below. [Issue #68](https://github.com/Mik1810/ipe-mcp/issues/68)

## Platform and artifact

- Fresh Ubuntu 26.04.1 LTS x86-64 WSL2 import with kernel
  `6.18.33.2-microsoft-standard-WSL2`. The official
  `ubuntu-26.04.1-wsl-amd64.wsl` image matched SHA-256
  `48d56724b5c8e60f24893e83e73bbb58c60b3ca22fba3da977075420acd54104`.
  The test used a new unprivileged user, a user-owned npm prefix, an empty
  document workspace, and an explicit MCP state directory.
- Node.js `24.18.0`, npm `11.16.0`, MCP client SDK `2.0.0`, and npm-resolved
  runtime MCP server SDK `2.4.0`. The installed server identified itself as
  `ipe-mcp@1.0.0-rc.1` and exposed contract `ipe-mcp/1`.
- The npm `1.0.0-rc.1` manifest and the GitHub release tarball both declare
  only the `ipe-mcp` executable. The GitHub release asset had SHA-256
  `24fbdc184ba8307c5e1913fe1b55a9cd454d641e13a032300c1d91c5307bf3ce`.
  [npm prerelease](https://www.npmjs.com/package/ipe-mcp/v/1.0.0-rc.1) · [GitHub release](https://github.com/Mik1810/ipe-mcp/releases/tag/v1.0.0-rc.1)
- The tested `ipe-mcp-1.0.0-rc.1.tgz` was built using `npm ci`, `npm run build`
  and `npm pack --ignore-scripts` from the `dev` worktree at
  `43665b3e0452ccd4167ecdeb640f3980df3eacd5`, with the uncommitted #67
  implementation and the #68 capability and installation fixes. At pack time,
  `git diff --binary HEAD` had SHA-256
  `7265b82e3123833f077503acbf61ed61ac4f0bc1f0019e94a7ad06303fa62887`
  for tracked changes. The new deck sources were still untracked.
- Candidate SHA-256
  `b9dafe4c919f3a49d18cdb5d7a4cc3f9c4cfa321d85072539113e73c3f1cb73d`.
  `npm install --global --ignore-scripts` installed this exact tarball.
  Both `ipe-mcp-cli` and `ipe-mcp` resolved from the npm prefix on `PATH`.
  The package gate reproduced its integrity and passed the allowlist,
  secret, native binary and SBOM checks.

## Native prerequisites

APT was run separately using the [README package list](../../README.md#add-the-tools-you-need).
The image already had `bubblewrap` and `util-linux`, which APT upgraded.
Before APT, `ipe_get_capabilities` reported `structural-only` on the corrected
runtime and the CLI wrote a structurally validated `.ipe`.

| APT package | Tested version |
| --- | --- |
| `ipe` | `7.2.30-1build2` |
| `lua5.4` | `5.4.8-1build1` |
| `texlive-latex-base` | `2025.20260124-1` |
| `texlive-latex-recommended` | `2025.20260124-1` |
| `poppler-utils` | `26.01.0-2ubuntu0.3` |
| `mupdf-tools` | `1.27.0+ds1-3ubuntu2` |
| `bubblewrap` | `0.11.1-1ubuntu0.3` |
| `util-linux` | `2.41.3-3ubuntu2.2` |

Two corrections came from the clean environment. The MCP capability envelope
now omits unavailable toolchain and validator fields and sanitizes native
diagnostics. Ipe's TeX run also required `xcolor.sty`, confirmed with
`kpsewhich` and `dpkg -S`. The README, package guide and WSL setup guide now
include its Ubuntu package, `texlive-latex-recommended`.

## Acceptance checks

| Criterion | Result |
| --- | --- |
| Package and native setup | PASS. Installed the pinned source tarball with lifecycle scripts disabled, then the documented APT prerequisites. MCP reported `full-7.2.30` and `verified=true` after APT. |
| Skill and CLI | PASS. The [authoring skill](../../plugins/ipe-mcp/skills/ipe-authoring/SKILL.md) guided the replay of the [lattice-path specification](../../fixtures/decks/lattice-paths.json) with `ipe-mcp-cli lattice-paths.json --out cli.ipe --pdf cli.pdf`. The README example also passed with two physical pages and its formula only on the second page. |
| MCP authoring and revision | PASS. The installed stdio server composed two slides with native text and paths and view counts `[3, 1]`. A revision-guarded `replace_object` changed the count label and preserved its object ID. A stale revision was rejected. |
| MCP preview and native validation | PASS. Structural and full validation succeeded. `ipe_render_preview` returned four ordered PNG resources. All four were retrieved and verified against their reported type, length and SHA-256. |
| MCP save and reopen | PASS. A save without confirmation left the target absent. Confirmed save wrote the editable source. Its XML matched the CLI source after normalizing generated identifiers and accounting for the intentional label edit. A new stdio process reopened it with the same view counts and passed full validation. |
| MCP PDF export and view order | PASS. Export from the reopened file yielded a PDF resource with the reported SHA-256. The saved `.ipe` remained byte-identical through reopen and export. `pdfinfo`, `pdftotext` and `pdftoppm` verified the physical PDF pages. |

| PDF page | Ipe slide/view | Visible reveal |
| --- | --- | --- |
| 1 | 1/1 | Lattice setup with grid |
| 2 | 1/2 | Grid and highlighted example route |
| 3 | 1/3 | Route and count formula, labelled `Route count` in the CLI and `Verified count` after the MCP revision |
| 4 | 2/1 | General rule and its formula |

The unmodified PDF pages 1, 2 and 4 produced byte-identical PNGs between
CLI and MCP. The rasterized page 3 and its PNG preview showed the expected
label change and retained the route and formula.

## MCP harness evidence

| Applicable area | Check passed |
| --- | --- |
| `model-facing-contract` | The real stdio regression test accepted the `structural-only` envelope as valid JSON with unavailable fields omitted. |
| `orientation-and-dynamic-behavior` | Installed tool discovery, orientation and capabilities passed before and after APT. |
| `result-quality-and-recovery` | A stale revision was rejected and the saved source reopened and validated in a fresh server process. |
| `permissions-and-write-safety` | Save confirmation was enforced, and reopening and exporting preserved the source hash. |
| `transport-integration-and-privacy` | Both stdio sessions closed cleanly with sanitized diagnostics. The package gate checked for zero listeners. |
| `code-architecture-and-verification` | Build, all 306 tests and `check:m10:package` passed. The clean install used the audited artifact. |

The qualification used only the README example and the original redistributable
lattice-path fixture. The retained record summarizes the protocol and artifact
checks without including raw traces or workspace state.
