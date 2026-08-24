# ADR-0001 — Baseline di compatibilità

- Stato: **Accepted**
- Data: 2026-08-24

## Decisione

La baseline normativa dell'MVP è Ipe **7.2.30**, su Ubuntu 26.04/WSL, con `FILE_FORMAT` XML **70218**. Il serializer deve emettere esplicitamente `version="70218"`; la versione della libreria (70230) non viene usata come versione del file. La compatibilità stabile richiede il percorso `full` descritto in `docs/compatibility-modes.md`.

Sono mantenute tre lane indipendenti: `full-7.2.30` (release), `structural-only` (controlli locali senza Ipe) e `nightly-7.3.x` (sperimentale/allowed-failure). Il contratto MVP non usa API 7.3.x; la nightly non riscrive un file stabile senza consenso. Lo smoke 7.2.29 è solo un controllo esterno.

## Conseguenze e confini

Il supporto a divergenze DTD/runtime, helper nativi, viewer PDF e feature sperimentali viene chiuso da probe M1/M6/M7. M0 fissa nomi, invarianti e criteri di esito, senza dichiarare risolta alcuna divergenza empirica. Ogni diagnostica riporta lane, versione rilevata, formato XML e livello di validazione.

## Deferral approvato

La strategia distributiva (bundle, npm, helper installabile e supporto oltre Ubuntu 26.04/WSL) è **rinviata dopo la validazione dell'MVP locale**. È una decisione approvata di deferral, non una decisione mancante; sarà rivalutata in M10 con evidenze di conformance, licenze e riproducibilità.
