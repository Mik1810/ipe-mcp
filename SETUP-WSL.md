# Installing Ipe 7.2.30 on Ubuntu WSL

Verified on 2026-08-24 in the project environment:

- Ubuntu 26.04 LTS (`resolute`), user `mik`;
- Ubuntu `universe` repository already available;
- APT candidate: `ipe 7.2.30-1build2`;
- WSLg active (`DISPLAY=:0`, Wayland available);
- Ipe installed and verified in WSL: `7.2.30-1build2`.

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
