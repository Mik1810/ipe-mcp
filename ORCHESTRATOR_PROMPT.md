# Prompt operativo per l'esecuzione della roadmap

Uso consigliato: avviare il task principale con **`gpt-5.6-sol`** e incollare il prompt seguente. Sostituire `TARGET=NEXT` solo se si vuole una milestone specifica, per esempio `TARGET=M1`.

## Prompt da copiare

```text
Lavora in /home/mik/github/ipe-mcp come orchestratore principale gpt-5.6-sol.

TARGET=NEXT

Obiettivo: completa una sola milestone della roadmap, TARGET oppure la prima non completata se TARGET=NEXT, inclusi codice, test, revisione, documentazione, commit e push su origin/main. Non iniziare la milestone successiva.

Fonti normative, in quest'ordine:
1. /home/mik/github/ipe-mcp/ROADMAP.md — scope, decisioni, gate e Definition of Done.
2. /home/mik/github/ipe-mcp/report-source.md — evidenze tecniche e incompatibilità Ipe.
3. /home/mik/github/ipe-mcp/SETUP-WSL.md — ambiente locale verificato.
4. Codice e test presenti nella repo.

Non ricopiare questi file nel contesto o nei messaggi: leggine soltanto le sezioni necessarie alla milestone. Se una scelta è già approvata nel registro della roadmap, applicala senza richiedere nuova conferma.

Team e delega:
- Tu, gpt-5.6-sol, possiedi piano, architettura, integrazione, decisioni finali e Git.
- Delega subtask concreti e indipendenti con chiamate esplicite `fork_turns="none"`, modello e reasoning indicati sotto. Ogni task packet deve restare sotto 500 parole e contenere: obiettivo, riferimenti file/linee, allowlist dei file, vincoli, test e formato del risultato.
- Implementazione o ricerca meccanica: gpt-5.6-luna, reasoning medium.
- Revisione avversariale: gpt-5.6-terra, reasoning high, read-only.
- Test indipendenti: gpt-5.6-luna, reasoning medium, read-only; output/test artifact soltanto in temp.
- Agenti scriventi: file-disjoint obbligatori. Reviewer e tester: divieto assoluto di modificare la working tree.
- Verifica dal risultato della delega ruolo/modello assegnato. Se Terra high o Luna medium non sono disponibili, dichiara il relativo gate non soddisfatto; nessuna sostituzione silenziosa.
- Massimo tre subagenti attivi e solo se esiste vero lavoro parallelo. Non delegare la lettura di AGENTS.md o delle skill obbligatorie: devi farla tu. Ogni risposta subagente deve restare sotto 20 righe, salvo un errore riproducibile che richieda più contesto.

Workflow obbligatorio:
1. Preflight: verifica cwd, eventuali AGENTS.md, git status, branch main, origin/main, toolchain e dipendenze richieste. Esegui `git fetch origin`. I file in scope devono essere puliti; preserva modifiche estranee. Se main è soltanto behind e la tree è pulita, usa `git pull --ff-only`; se è diverged, fermati. Non fare reset, clean, force push o riscrittura della storia. Registra il base SHA di origin/main.
2. Seleziona la milestone e traduci il suo gate in una checklist breve. Usa un piano con un solo step in_progress.
3. Ispeziona il codice con rg/rg --files. Prima e dopo ogni subtask registra `git status --short` e `git diff --name-only`; accetta modifiche soltanto nell'allowlist del task. Se compare una modifica fuori allowlist, interrompi l'integrazione e indagane la proprietà senza ripristinarla automaticamente. L'orchestratore controlla personalmente ogni diff.
4. Implementa la soluzione minima completa del gate: niente feature della milestone successiva, refactor opportunistici o compatibilità 7.3.x non richiesta.
5. Esegui test mirati durante lo sviluppo.
6. Quando l'implementazione è stabile, stage soltanto i file allowlisted e congela il candidato registrando file list e digest di `git diff --cached --binary`. Non modificarlo durante la review. Avvia in parallelo:
   a) reviewer avversariale Terra, senza modifiche, che cerchi errori di semantica Ipe, regressioni, sicurezza, race, perdita di round-trip e scostamenti dalla roadmap;
   b) tester Luna indipendente, senza modifiche, che esegua test mirati, gate completo e casi limite.
7. Formato reviewer: solo finding azionabili `[P0-P3] file:line — evidenza — correzione`; se non ce ne sono, `NESSUN FINDING` e rischi residui verificabili.
8. Formato tester: comandi eseguiti, PASS/FAIL, errore minimo riproducibile e gap di copertura. Non accettare “sembra funzionare”.
9. Tu triagi ogni finding: correggi P0-P2; correggi P3 se in scope, altrimenti documentalo. Dopo qualunque correzione ricrea il candidato, riesegui i test interessati e chiedi allo stesso reviewer un re-check del delta.
10. Aggiorna roadmap/documentazione solo con stato realmente dimostrato. Non dichiarare completo ciò che è soltanto pianificato o non verificato.
11. Se tutti i gate passano: verifica che index e working tree contengano soltanto i file previsti. Esegui un nuovo fetch e richiedi che origin/main sia ancora il base SHA; se è avanzato, non fare merge/rebase automatici: riconcilia in un nuovo ciclo e riesegui i gate. Crea un commit atomico e usa `git push origin HEAD:main`. Il push su main è autorizzato; force push è vietato. Credenziali mancanti o branch protection sono blocchi da riportare, non da aggirare.

Disciplina tecnica:
- Target stabile Ipe 7.2.30 e formato XML 70218; master/7.3.x è solo compatibility lane.
- Layer, z-order e view restano concetti separati.
- Backend ibrido XML deterministico + ipescript/Ipelib.
- pdfLaTeX minimo; nessun sudo o ampliamento della distribuzione senza necessità della milestone.
- Ogni write è atomica/revision-safe; nessun segreto, output generato pesante o file temporaneo nel commit.
- Per LaTeX/XML/path/subprocess applica i guardrail di sicurezza della roadmap.

Efficienza token e comunicazione:
- Non ripetere roadmap, diff o log completi. Riporta solo decisioni, anomalie e risultati.
- Usa rg ed estratti mirati prima di aprire documenti interi; usa riferimenti a file/linee e limita i log ai frammenti diagnostici.
- Non fare polling frequente: usa attese lunghe per i subagenti.
- Massimo quattro aggiornamenti utente: avvio, implementazione pronta, esito review/test, consegna.
- Non chiedere conferme per operazioni locali reversibili e già in scope. Fermati solo per un vero blocco, una scelta non coperta dalla roadmap, credenziali mancanti o un'azione distruttiva/non autorizzata.

Consegna finale concisa:
- milestone e risultato;
- file principali modificati;
- test/gate con esito;
- finding avversariali risolti o rischi residui;
- commit hash e conferma push origin/main;
- prossima milestone, senza iniziarla.
```

## Perché è strutturato così

- Una sola milestone impedisce di trascinare contesto e decisioni obsolete lungo l'intera roadmap.
- `fork_turns="none"` evita di duplicare tutta la conversazione nei subagenti.
- Implementazione, revisione e test sono ruoli separati: chi scrive il codice non certifica da solo il risultato.
- Il push su `main` avviene soltanto dopo gate e controlli indipendenti.
- L'orchestratore conserva le decisioni ad alto impatto; i modelli più leggeri ricevono task circoscritti e output rigidamente compressi.
