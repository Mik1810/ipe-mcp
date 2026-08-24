# Installazione Ipe 7.2.30 su Ubuntu WSL

Verificato il 2026-08-24 nell'ambiente del progetto:

- Ubuntu 26.04 LTS (`resolute`), utente `mik`;
- repository Ubuntu `universe` già disponibile;
- candidato APT: `ipe 7.2.30-1build2`;
- WSLg attivo (`DISPLAY=:0`, Wayland disponibile);
- Ipe installato e verificato in WSL: `7.2.30-1build2`.

## Installazione consigliata

Eseguire nel terminale Ubuntu WSL, non in PowerShell:

```bash
sudo apt update
sudo apt install ipe lua5.4
```

Il pacchetto `ipe` installa già pdfLaTeX base e le librerie Qt richieste. Include anche i programmi necessari al server MCP:

- `ipe`;
- `ipescript`;
- `ipetoipe`;
- `iperender`;
- `ipepresenter`;
- `ipeextract`.

Per il profilo LaTeX minimo dell'MVP non serve altro. Se in seguito serviranno pacchetti LaTeX comuni o una migliore copertura dei caratteri accentati:

```bash
sudo apt install texlive-latex-recommended
```

## Verifica

```bash
dpkg-query -W -f='${Version}\n' ipe
command -v ipe ipescript ipetoipe iperender ipepresenter pdflatex
```

Il primo comando deve stampare una versione che inizi con `7.2.30`; gli altri devono restituire path sotto `/usr/bin`.

Verifica completata il 2026-08-24: `ipe`, `ipescript`, `ipetoipe`, `iperender`, `ipepresenter` e `pdflatex` sono tutti disponibili sotto `/usr/bin`.

Per verificare la GUI Linux tramite WSLg:

```bash
ipe
```

La finestra dovrebbe aprirsi direttamente sul desktop Windows. Nell'ambiente attuale WSLg risulta già configurato. Se in futuro non si aprisse, eseguire da PowerShell:

```powershell
wsl --update
wsl --shutdown
```

e poi riaprire Ubuntu.

## Perché installarlo anche in WSL

L'Ipe installato su Windows e quello installato in Ubuntu sono ambienti separati. Il server MCP verrà eseguito in `/home/mik/github/ipe-mcp` e deve poter chiamare i binari Linux nativi senza attraversare `/mnt/c` o dipendere dall'interoperabilità Windows. Questo rende path, subprocess, LaTeX e test molto più prevedibili.

Non serve compilare Ipe dal sorgente: Ubuntu 26.04 fornisce già esattamente la versione stabile scelta come baseline.

## Laboratorio di conformance M1

Con il pacchetto stabile installato, il laboratorio completo si esegue dalla root del repository:

```bash
bash scripts/check-m1.sh
```

Il comando verifica capability Lua/Ipelib, round-trip e copy, golden semantiche, render SVG ed export PDF degli effetti. Non scrive artefatti nel repository.

La build sorgente resta una lane CI opzionale. Se esiste già una build 7.2.30, indicare la directory che contiene `ipetoipe`, `iperender` e `ipescript`:

```bash
IPE_M1_SOURCE_BIN_DIR=/path/to/ipe/build/bin bash scripts/check-m1.sh
```

Il gate non scarica, compila o installa automaticamente la build sorgente; senza la variabile la lane viene riportata esplicitamente come `SKIP` e il gate stabile usa il pacchetto Ubuntu verificato.
