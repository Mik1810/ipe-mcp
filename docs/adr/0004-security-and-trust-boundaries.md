# ADR-0004 — Sicurezza e confini di fiducia

- Stato: **Accepted**
- Data: 2026-08-24

Il server tratta documento, LaTeX, asset e metadati come input non fidati. Gli unici ID canonici del threat model M0 sono quelli sotto; ciascuno ha rischio, mitigazione e gate futuro.

## TM-XML
- Rischio: XXE, entity expansion, XML ambiguo o perdita dati.
- Mitigazione: parser senza DTD/entità esterne, limiti, XML canonico, schema/IR e round-trip separati.
- Gate futuro: M1 probe DTD/runtime, fuzz corpus e golden round-trip.

## TM-TEX
- Rischio: LaTeX/preambolo causa esecuzione, lettura file o DoS.
- Mitigazione: temp isolata, shell escape/rete disabilitati, `TEXINPUTS` controllato, timeout e limiti di risorse.
- Gate futuro: M6 sandbox pdfLaTeX con fixture ostili e timeout.

## TM-FS
- Rischio: traversal, symlink escape, sovrascrittura o leak.
- Mitigazione: root allowlist, realpath, working copy, temp+rename, snapshot e nessun path arbitrario.
- Gate futuro: M1/M9 test di symlink, traversal e recovery atomico.

## TM-ASSET
- Rischio: asset/rete malevoli, MIME falsificato, file o immagini enormi.
- Mitigazione: remoto disabilitato; download separato con allowlist, size/pixel/MIME/hash checks.
- Gate futuro: M6/M9 corpus asset e verifica dei limiti.

## TM-PROC
- Rischio: subprocess Ipe/CLI o tool arbitrari permettono injection o perdita di stdout MCP.
- Mitigazione: comandi fissi e argomenti tipizzati, nessun shell tool, env minimo, timeout, stderr per log e stdout protocol-only.
- Gate futuro: M6/M8 harness di processo e smoke MCP Inspector.

## TM-CONCURRENCY
- Rischio: race, overwrite e working copy incoerenti.
- Mitigazione: revision counter, `expectedRevision`, batch atomici, lock di sessione, hash sorgente, temp+rename e snapshot.
- Gate futuro: M1/M9 test concorrenti, crash injection e restore invariants.

## TM-METADATA
- Rischio: `custom`/sidecar persi, collisioni ID o leakage di dati.
- Mitigazione: UUID con prefisso `ipe-mcp:`, preservazione custom, sidecar versionato, log redatti e semantic diff.
- Gate futuro: M1 test `custom`/`x-*`, collision/fuzz e audit redaction.

## TM-HTTP
- Rischio: futura superficie HTTP espone sessioni o consente DNS rebinding, CSRF e accesso non autorizzato.
- Mitigazione: nessun HTTP nell'MVP; in futuro bind localhost, Origin validation, autenticazione e anti-rebinding.
- Gate futuro: M10 threat review e test auth/Origin/rebinding prima del rilascio.

La distribuzione resta un deferral approvato: sarà rivalutata con licenze, packaging e sandbox.
