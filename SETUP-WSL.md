# Installing Ipe 7.2.30 on Ubuntu WSL

Verified on 2026-08-24 in the project environment:

- Ubuntu 26.04 LTS (`resolute`), user `mik`;
- Ubuntu `universe` repository already available;
- APT candidate: `ipe 7.2.30-1build2`;
- WSLg active (`DISPLAY=:0`, Wayland available);
- Ipe installed and verified in WSL: `7.2.30-1build2`.

Re-verified on 2026-08-29 for the M9 clean-setup gate (see below): `ipe 7.2.30-1build2`, `texlive-latex-base 2025.20260124-1`, `poppler-utils 26.01.0-2ubuntu0.1`, `mupdf-tools 1.27.0+ds1-3ubuntu2`, `bubblewrap 0.11.1-1ubuntu0.1`, Node `24.18.0`.

## Recommended installation

Run in the Ubuntu WSL terminal, not PowerShell:

```bash
sudo apt update
sudo apt install ipe lua5.4
```

The `ipe` package already installs the base pdfLaTeX environment and required Qt libraries. It also includes the programs needed by the MCP server:

- `ipe`;
- `ipescript`;
- `ipetoipe`;
- `iperender`;
- `ipepresenter`;
- `ipeextract`.

Nothing else is needed for the MVP's minimal LaTeX profile. If common LaTeX packages or better accented-character coverage are needed later:

```bash
sudo apt install texlive-latex-recommended
```

## Verification

```bash
dpkg-query -W -f='${Version}\n' ipe
command -v ipe ipescript ipetoipe iperender ipepresenter pdflatex
```

The first command must print a version beginning with `7.2.30`; the others must return paths under `/usr/bin`.

Verification completed on 2026-08-24: `ipe`, `ipescript`, `ipetoipe`, `iperender`, `ipepresenter`, and `pdflatex` are all available under `/usr/bin`.

## Verification tools required by the server hard subprocess boundary

The native adapter relies on fixed local validators and isolation, all
verifiable with the same package metadata:

```bash
dpkg-query -W -f='${Package}\t${Version}\n' ipe texlive-latex-base poppler-utils mupdf-tools bubblewrap
```

Expected for the verified 7.2.30 lane:

- `ipe` starting with `7.2.30`;
- `texlive-latex-base` (provides `pdflatex`);
- `poppler-utils` (provides `pdfinfo`, `pdftoppm`);
- `mupdf-tools` (provides `mutool`);
- `bubblewrap` `0.11.1` (provides `/usr/bin/bwrap`, attested as an ELF owned by that package).

If a package is missing on a fresh Ubuntu 26.04 WSL image:

```bash
sudo apt update
sudo apt install ipe lua5.4 texlive-latex-base poppler-utils mupdf-tools bubblewrap
```

When the toolchain is incomplete or a version mismatches, the adapter reports a
degraded mode (`structural-only` or `nightly` diagnostics) instead of a
full-verification claim; `ipe_get_capabilities` exposes `mode`, `verified`,
`features`, and `diagnostics` for exactly that determination.

## M9 clean-setup verification gate

Run from a clean checkout to prove the setup procedure end to end without
inheriting `node_modules`:

```bash
bash scripts/check-m9-setup.sh
```

The gate:

1. extracts a `git archive HEAD` snapshot into a temporary directory and
   asserts it has no `node_modules`;
2. requires Node 20 or newer, runs `npm ci`, `npm run build`, and the bounded
   `tests/limits` + `tests/mcp` suites inside the snapshot;
3. checks the full Ipe 7.2.30 toolchain and package ownership (`ipe`,
   `ipescript`, `ipetoipe`, `iperender`, `ipepresenter`, `ipeextract`,
   `pdflatex` from TeX Live, Poppler, MuPDF, bubblewrap 0.11.1);
4. runs the real capability probe through `dist` and fails unless
   `mode=full-7.2.30`, `verified=true`, and `ipeVersion=7.2.30`, printing
   diagnostics otherwise so a degraded lane is never claimed as full.

It leaves its temporary snapshot in `mktemp -d` (removed on exit) and writes
nothing into the repository.

To verify the Linux GUI through WSLg:

```bash
ipe
```

The window should open directly on the Windows desktop. WSLg is already configured in the current environment. If it stops opening in the future, run from PowerShell:

```powershell
wsl --update
wsl --shutdown
```

Then reopen Ubuntu.

## Why Ipe must also be installed in WSL

Ipe installed on Windows and Ipe installed in Ubuntu are separate environments. The MCP server runs in `/home/mik/github/ipe-mcp` and must be able to invoke native Linux binaries without crossing `/mnt/c` or depending on Windows interoperability. This makes paths, subprocesses, LaTeX, and tests far more predictable.

There is no need to compile Ipe from source: Ubuntu 26.04 already provides exactly the stable version selected as the baseline.

## M1 conformance laboratory

With the stable package installed, run the complete laboratory from the repository root:

```bash
bash scripts/check-m1.sh
```

The command verifies Lua/Ipelib capabilities, round-trip and copy behavior, semantic goldens, SVG rendering, and PDF export of effects. It writes no artifacts to the repository.

The source-build lane remains an optional CI lane. If an existing 7.2.30 build is available, specify the directory containing `ipetoipe`, `iperender`, and `ipescript`:

```bash
IPE_M1_SOURCE_BIN_DIR=/path/to/ipe/build/bin bash scripts/check-m1.sh
```

The gate does not automatically download, compile, or install a source build. Without the variable, the lane is explicitly reported as `SKIP`, and the stable gate uses the verified Ubuntu package.
