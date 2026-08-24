# ADR-0003 — Backend, persistenza e identificatori

- Stato: **Accepted**
- Data: 2026-08-24

## Decisione

Il backend è ibrido: serializer/parser XML deterministico per il formato e helper ufficiale `ipescript`/Ipelib per import, mutazioni sensibili, probe di canonicalizzazione e validazione nativa. Il serializer del server possiede la forma finale: un output nativo che omette default espliciti viene ricondotto nell'IR e riserializzato, non copiato direttamente sul file destinazione. Il core non dipende dal trasporto MCP. Ipelib C++ è fallback futuro, non fondazione MVP; `ipepython` non è la base.

Ogni `open` crea una working copy. Le mutazioni sono batch atomici con `expectedRevision`; conflitti e hash sorgente cambiato falliscono senza sovrascrittura. Il salvataggio usa temporaneo + rename e snapshot recuperabile. La sorgente non cambia prima di un `save` esplicito.

Gli oggetti creati dal server ricevono `custom="ipe-mcp:<uuid>"`; i custom presenti sono preservati. Un sidecar opzionale versionato conserva metadati ricchi, provenienza e intenzioni di layout senza rendere il `.ipe` dipendente dal sidecar. Nessun indice XML, nome o ordine di pagina è un identificatore persistente sufficiente.

## Validazione e round-trip

La pipeline è stratificata: schema/IR, XML well-formed senza entità esterne, DTD consultiva, load-save-reload nativo, stylesheet, LaTeX, export PDF e render. Una feature non conservata dal round-trip produce diagnostica; non viene silenziosamente promessa. La versione XML resta `70218` anche dopo canonicalizzazione. La lane `full` richiede runtime 7.2.30; `structural-only` non può chiamare il round-trip nativo “verified”.

## Conseguenze

La separazione riduce dipendenze ABI e mantiene il documento editabile, ma richiede semantic diff, fixture e probe di conformance. Backup e revisioni sono parte della correttezza. La distribuzione del bundle/helper è il deferral approvato dell'ADR-0001.
