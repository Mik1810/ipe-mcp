# M9 SBOM and License Inventory

This is technical provenance documentation, not legal advice. It records what
the local release candidate ships, the licenses of its dependencies, and the
boundary between this server and the GPL-licensed native Ipe toolchain. Any
future distribution decision is out of scope here (M10).

The machine-readable inventory is generated deterministically from
`package-lock.json` and the installed `dpkg` metadata by `scripts/tools/sbom.mjs`
and committed as [`sbom.json`](../reference/sbom.json) (CycloneDX 1.5).

## Project license

`ipe-mcp` is licensed under the **MIT License** — `Copyright (c) 2026 Michael
Piccirilli` (see [`LICENSE`](../../LICENSE)). This is stated explicitly in
`package.json` (`"license": "MIT"`); no license is inferred or invented for any
third-party component.

## npm dependency inventory (from package-lock.json)

111 resolved packages. Direct dependencies:

| Package | Scope | License |
|---|---|---|
| `@modelcontextprotocol/server` | prod | MIT |
| `jpeg-js` | prod | BSD-3-Clause |
| `pngjs` | prod | MIT |
| `saxes` | prod | ISC |
| `zod` | prod | MIT |
| `@modelcontextprotocol/client` | dev | MIT |
| `@types/node` | dev | MIT |
| `@types/pngjs` | dev | MIT |
| `typescript` | dev | Apache-2.0 |
| `vitest` | dev | MIT |

Transitive summary (deduplicated):

| License | Packages |
|---|---:|
| MIT | 69 |
| Apache-2.0 | 23 (mostly `typescript`/`lightningcss` platform binaries + `detect-libc`, `expect-type`, `typescript`) |
| MPL-2.0 | 12 (all `lightningcss*` platform variants; `lightningcss` itself is MPL-2.0) |
| ISC | 5 (`saxes`, `which`, `isexe`, `picocolors`, `siginfo`) |
| BSD-3-Clause | 2 (`jpeg-js`, `source-map-js`) |

Every npm package declares an SPDX license; none is unlicensed or copyleft
(no GPL/AGPL in the npm graph).

## Native toolchain inventory (from dpkg + `/usr/share/doc/*/copyright`)

| Package | Version | License (from copyright file) |
|---|---|---|
| `ipe` | 7.2.30-1build2 | GPL-3+ **with CGAL exception** |
| `lua5.4` | 5.4.8-1build1 | Expat |
| `texlive-latex-base` | 2025.20260124-1 | multiple (TeX Live compilation; see copyright file) |
| `poppler-utils` | 26.01.0-2ubuntu0.1 | GPL-2 or GPL-3 (+ Apache-2.0 parts) |
| `mupdf-tools` | 1.27.0+ds1-3ubuntu2 | AGPL-3+ (+ BSD/Apache/Expat/ISC/OFL/etc. parts) |
| `bubblewrap` | 0.11.1-1ubuntu0.1 | LGPL-2+ (+ public-domain icon) |

## GPL subprocess boundary

The GPL/AGPL components above are **separate programs**, not libraries linked
or bundled into `ipe-mcp`:

- The server never links against Ipe, Poppler, MuPDF, or Lua. It spawns fixed
  argv executables (`ipescript`, `ipetoipe`, `iperender`, `pdflatex`,
  `pdfinfo`, `pdftoppm`, `mutool`) as **child processes** through
  `runControlledProcess` (`src/native/process.ts`), each sandboxed with
  `bwrap` + `prlimit` and passing input/output via the filesystem.
- No GPL/AGPL source or binary is copied into the repository, the npm package,
  or the built `dist/` output. The native tools are installed system-wide by
  the OS package manager (`apt`) and read from `/usr/bin`.
- The release candidate is **not published** to npm or any other registry, and
  there is no public distribution. `package.json` remains `"private": true`.
- The npm dependency graph contains no copyleft licenses, so the MIT license
  of `ipe-mcp` is not affected by the native GPL toolchain.

### Conclusion and required review

The current local release candidate uses Ipe and the other GPL/AGPL tools only
as independent subprocesses with no linking, bundling, or public distribution.
This is the boundary recorded in ADR-0004 ("Distribution remains an approved
deferral"). **Before any future distribution** (bundling, packaging, or
publishing), this analysis must be re-reviewed by the owner/legal — especially
because MuPDF is AGPL-3+ (network-saas clauses) and Ipe is GPL-3+ — even though
the subprocess boundary would normally keep the server's MIT code independent.

## Regeneration and verification

```bash
node scripts/tools/sbom.mjs docs/reference/sbom.json      # regenerate (byte-deterministic)
bash scripts/gates/check-m9-sbom.sh                # gate: determinism + coverage
```

The SBOM is deterministic: identical inputs produce byte-identical output
(no timestamps, UUIDs, or map-iteration ordering). The gate regenerates into a
temporary directory and asserts it matches `docs/reference/sbom.json` exactly.
