# Ipe MCP — dossier tecnico delle fonti

Stato: studio preliminare per roadmap, nessuna implementazione.  
Data di verifica: 2026-08-24.

Questo documento conserva le evidenze che motivano la roadmap. Le conclusioni di prodotto e le fasi operative sono in `ROADMAP.md`.

## 1. Baseline e compatibilità

| Tema | Evidenza | Decisione conseguente | Confidenza |
|---|---|---|---|
| Release stabile | GitHub marca [`v7.2.30`](https://github.com/otfried/ipe/releases/tag/v7.2.30) come ultima release; è una mini-release solo sorgente. | Baseline normativa e di test: Ipe 7.2.30. | Alta |
| Binari pubblici | La pagina upstream espone ancora in prevalenza binari 7.2.29; Ubuntu 26.04 offre invece il pacchetto `7.2.30-1build2`, verificato nell'ambiente WSL del progetto. | Ubuntu 26.04/WSL è la piattaforma MVP; smoke test 7.2.29 solo per compatibilità esterna. | Alta |
| Sviluppo futuro | Il ramo `master` si identifica come 7.3.1 ma non è una release stabile. | Compatibilità nightly/allowed-failure separata; nessuna API 7.3.x nell'MVP. | Alta |
| Versione XML | In 7.2.30 `IPELIB_VERSION` è 70230, ma `FILE_FORMAT` è 70218 e il writer usa quest'ultimo. | Il root generato deve avere `version="70218"`; mai derivarlo dalla release. | Alta |
| Formato aperto | Il [manuale del formato](https://github.com/otfried/ipe/blob/v7.2.30/manual/90_file_format.rst) dichiara esplicitamente che applicazioni esterne possono creare XML Ipe. | La generazione diretta di XML è una strategia supportata. | Alta |

## 2. Coordinate, pagina e trasformazioni

- Le unità native sono punti PostScript/PDF (`bp`), cioè 1/72 di pollice. L'asse x cresce verso destra, l'asse y verso l'alto. Fonte: [snapping e unità](https://github.com/otfried/ipe/blob/v7.2.30/manual/40_snapping.rst).
- `<layout paper="W H" origin="ox oy" frame="Fw Fh">` distingue foglio e frame. `origin` è l'angolo inferiore sinistro del frame nel sistema del foglio; il frame è una guida, non un clipping path. Fonte: [layout nel formato](https://github.com/otfried/ipe/blob/v7.2.30/manual/90_file_format.rst).
- Una matrice XML `[a b c d s t]` applica `x' = a·x + c·y + s`, `y' = b·x + d·y + t`. `lhs * rhs` applica prima `rhs`; la composizione visiva è quindi, concettualmente, `matrixViewLayer * matrixObject * puntoLocale`. Fonti: [formato](https://github.com/otfried/ipe/blob/v7.2.30/manual/90_file_format.rst), [geometria Ipelib](https://github.com/otfried/ipe/blob/v7.2.30/src/include/ipegeo.h).
- Matrici non finite o singolari non sono proibite in modo sufficiente dal formato; l'inversione nativa presume determinante non nullo. Il server deve rifiutarle e definire una tolleranza testata.
- Il `MediaBox` PDF corrisponde alla carta; `CropBox` è opzionale e dipende da `crop` e dal bounding box calcolato. Fonte: [writer PDF](https://github.com/otfried/ipe/blob/v7.2.30/src/ipelib/ipepdfwriter.cpp).

Conseguenza per l'API: lo spazio predefinito sarà `frame`, ma saranno supportati anche `paper`, coordinate normalizzate e punti Ipe esatti. Ogni conversione termina in bp con asse y-up.

## 3. Documento, pagine, layer, view e ordine visuale

### Documento XML

- Ordine canonico del root: `info?`, `preamble?`, bitmap e stylesheet, poi pagine. Fonti: [DTD](https://github.com/otfried/ipe/blob/v7.2.30/doc/ipe.dtd), [formato](https://github.com/otfried/ipe/blob/v7.2.30/manual/90_file_format.rst).
- Gli stylesheet sono a cascata: l'ultimo incorporato ha priorità maggiore; lo stile standard incorporato è alla base.
- Il parser di Ipe non è un parser XML generico: niente namespace, alcune forme vuote richiedono la serializzazione canonica, attributi ignoti possono andare persi dopo un salvataggio in Ipe.
- DTD e runtime non coincidono sempre. Esempi osservati: il DTD richiede almeno una pagina ma il parser può accettarne zero; `active` è formalmente obbligatorio ma può essere inferito; il default DTD di `view marked` non viene applicato dal parser custom.

Decisione: validazione a strati — XML sicuro, DTD consultiva, invarianti semantiche più strette, caricamento/round-trip con Ipelib, LaTeX, export e render. Nessun singolo livello è sufficiente.

### Pagine e layer

- Una pagina contiene metadati, note, layer, view e una sequenza globale di oggetti. Ogni oggetto top-level appartiene a un layer.
- **Il layer non determina lo z-order.** Lo stacking deriva dalla sequenza globale degli oggetti; ordine layer e ordine visuale sono ortogonali. Il renderer percorre la sequenza in ordine crescente: il primo oggetto è più indietro, l'ultimo è più avanti; appendere equivale quindi a portare davanti. Fonti: [concetti](https://github.com/otfried/ipe/blob/v7.2.30/manual/20_concepts.rst), [Page](https://github.com/otfried/ipe/blob/v7.2.30/src/ipelib/ipepage.cpp), [canvas](https://github.com/otfried/ipe/blob/v7.2.30/src/ipecanvas/ipecanvas.cpp), [azioni Front/Back](https://github.com/otfried/ipe/blob/v7.2.30/src/ipe/lua/actions.lua).
- Se mancano layer/view Ipe ne sintetizza, ma il comportamento contiene edge case su layer bloccati e active layer. Il generatore deve sempre produrre almeno un layer e almeno una view espliciti.
- L'attributo `layer` degli oggetti può essere ereditato in modo stateful. Per eliminare ambiguità, ogni oggetto top-level generato avrà il layer esplicito.
- I nomi layer devono essere unici, senza spazi, e ogni riferimento deve risolversi.
- Nomi riservati con semantica speciale: `BBOX`, `VIEWBBOX`, `NOPDF`, `BACKGROUND`, `GRID`, oltre alla famiglia interna `EDIT-GROUP*`. Il server li espone solo tramite operazioni intenzionali.

### View

- Una view contiene i layer visibili, l'active layer e opzionalmente nome, stato marked, effetto, mappe simboliche e trasformazioni di layer. Ogni view produce una pagina distinta nel PDF. Fonte: [presentazioni](https://github.com/otfried/ipe/blob/v7.2.30/manual/70_presentations.rst).
- L'active layer serve all'editing e al posizionamento di nuovi oggetti; non controlla né visibilità né z-order.
- Le mappe per-view possono rimappare solo valori simbolici supportati e definiti nello stylesheet.
- Le trasformazioni di layer per-view sono dichiarate sperimentali. Hit testing, bounding box e annotazioni link possono restare nella posizione originaria. Non sono quindi il meccanismo robusto predefinito per il movimento.
- Normalmente tutte le view condividono il bounding box unione. `BBOX` lo stabilizza; `VIEWBBOX`, quando visibile, chiede un bbox specifico. Titoli automatici, numeri pagina e trasformazioni per-view non sono inclusi in tutti i calcoli del bbox.
- Il generatore serializzerà sempre `active` e `marked` esplicitamente per evitare differenze DTD/runtime.

### Metadati di presentazione

- Il titolo di pagina è disegnato in ogni view tramite lo stile, fuori dai layer.
- Section e subsection alimentano bookmark e destinazioni PDF; i nomi devono essere unici quando sono usati come destinazioni.
- Le note sono testo semplice per pagina e vengono mostrate da IpePresenter. Fonti: [presentazioni](https://github.com/otfried/ipe/blob/v7.2.30/manual/70_presentations.rst), [writer PDF](https://github.com/otfried/ipe/blob/v7.2.30/src/ipelib/ipepdfwriter.cpp).

## 4. Oggetti, forme e stili

I cinque tipi nativi sono `path`, `text`, `image`, `group` e riferimento a simbolo (`use`). Fonte principale: [oggetti](https://github.com/otfried/ipe/blob/v7.2.30/manual/30_objects.rst).

### Path e geometria

Il linguaggio path supporta:

- segmenti e polilinee (`m`, `l`);
- chiusura (`h`) e path composti con buchi;
- spline uniformi/quadratiche/cubiche (`c`, con forme storiche deprecate);
- ellissi come immagine affine del cerchio unitario (`e`);
- archi ellittici (`a`);
- spline cardinali (`C`);
- clothoid/spiro (`L`);
- spline uniformi chiuse (`u`).

L'IR ad alto livello non esporrà direttamente questa grammatica. Offrirà segment, polyline, polygon, rectangle, rounded rectangle, circle, ellipse, arc, quadratic/cubic Bézier, uniform/cardinal spline, clothoid, compound path e connector; un compilatore deterministico li abbasserà nel path Ipe.

Aspetti da preservare: path aperto/chiuso, orientamento, winding/even-odd fill rule, cap/join, frecce, degenerazioni, tolleranze e bounding box dello stroke.

### Testo

- `label`: punto di riferimento e allineamento; dimensioni dipendono dal passaggio LaTeX.
- `minipage`: larghezza fissa e sviluppo verso il basso dal bordo superiore.
- Il contenuto è un frammento LaTeX; preambolo e pacchetti influenzano misure e output.

Conseguenza: il layout accurato richiede due passaggi limitati — layout provvisorio, compilazione LaTeX/aggiornamento dimensioni, risoluzione delle dipendenze e al massimo un rerun controllato.

### Immagini, gruppi e simboli

- Ipe conserva JPEG come DCT; altri raster possono essere incorporati come bitmap compressa. Il rettangolo dell'immagine ne determina il posizionamento.
- Gli asset vanno deduplicati per hash; crop e mascheramento si compilano in gruppi con clipping.
- I gruppi possono annidare oggetti, avere clipping path, decorazione e link. Le annotazioni PDF attive hanno vincoli sui gruppi top-level.
- I simboli risiedono negli stylesheet e sono istanziati con `use`; i parametri ammessi sono codificati nel nome/definizione simbolica.
- Stroke, fill, pen, dash, cap, join, fill rule, frecce, opacità, gradienti e tiling fanno parte del modello di stile. Fonte: [stylesheet](https://github.com/otfried/ipe/blob/v7.2.30/manual/60_stylesheets.rst).

### Identità persistente

Il parser runtime supporta un attributo `custom`, benché non sia descritto completamente dal DTD. Il piano prevede token XML-safe brevi `ipe-mcp:<uuid>` per gli oggetti creati dal server, preservando valori custom già esistenti. Metadati ricchi e provenienza vivranno in un sidecar opzionale `.ipe-mcp.json`; non si farà affidamento esclusivo su estensioni `x-*` senza un esperimento di round-trip.

## 5. Animazioni, reveal e scorrimento

Ipe non possiede una timeline continua o interpolazione temporale degli oggetti. Le primitive native sono:

1. reveal incrementali mediante visibilità cumulativa dei layer nelle view;
2. rimappatura per-view di attributi simbolici;
3. trasformazione discreta di interi layer per-view, sperimentale;
4. transizione PDF tra la pagina/view corrente e la successiva.

Gli effetti PDF disponibili nel runtime 7.2.30 sono 28: Normal; Split H/V in/out; Blinds H/V; Box in/out; Wipe nelle quattro direzioni; Dissolve; Glitter; Fly in/out; Push; Cover; Uncover; Fade. La resa dipende dal viewer. IpePresenter naviga tra pagine PDF e non garantisce l'interpolazione degli effetti PDF.

### Strategie per lo scorrimento

| Strategia | Meccanismo | Vantaggi | Limiti | Uso previsto |
|---|---|---|---|---|
| View + copie | Varianti di oggetti/layer a posizioni discrete | Robusta, bbox e link controllabili | File più grande | Default MVP |
| View + transform | Matrice per-view sul layer | Compatta, naturale per offset | Sperimentale; bbox/hit/link incoerenti | Opt-in con warning |
| Transizione PDF | Push/wipe tra view | Semplice per intera slide | Viewer-dependent, non muove singoli oggetti | Decorativa |
| Video esterno | Render continuo con pipeline dedicata | Movimento fluido reale | Non è più una presentazione Ipe nativa | Modulo futuro |

Per una regione interna scrollabile servono clipping/mask fissi o duplicazione precomputata: una trasformazione applicata al gruppo sposterebbe anche il suo clip. L'operazione ad alto livello deve quindi dichiarare asse, offset iniziale/finale, numero passi o durata logica, easing, regione di clip, strategia e viewer target.

Riferimento esterno, solo come spike: Anna Henriksson, *Animations in Ipe Presentations* (TU Wien, 2025), [tesi PDF](https://www.ac.tuwien.ac.at/bachthes/ba_thesis_ah-mn-2025-03-08.pdf), descrive una pipeline Ipe → Manim → video. Non è una dipendenza candidata finché codice, licenza e riproducibilità non sono verificati.

## 6. Scelte MCP e integrazione con agenti

- Baseline di protocollo: specifica MCP stabile [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25), non la release candidate successiva.
- Trasporto MVP: stdio. La [specifica dei trasporti](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) richiede che stdout contenga solo messaggi MCP; i log vanno su stderr.
- SDK TypeScript ufficiale v2, ESM, Zod v4, Node 20+: [guida server](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server).
- Contratti tool con input/output schema, `structuredContent`, errori leggibili e link/resource per artefatti grandi: [specifica tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- Codex condivide la configurazione MCP fra app, CLI ed estensione e supporta server stdio e Streamable HTTP: [documentazione Codex MCP](https://developers.openai.com/codex/mcp).

Decisione: package standalone, local-first e host-agnostic; adattatore/plugin Codex opzionale, non requisito del core.

## 7. Validazione e sicurezza

Pipeline prevista:

1. schema dei parametri e valori numerici finiti;
2. invarianti dell'IR;
3. XML well-formed con entità esterne disattivate;
4. DTD come controllo consultivo;
5. parse e round-trip con Ipelib/Ipe CLI;
6. controllo stylesheet;
7. compilazione LaTeX;
8. export PDF;
9. render PNG delle view richieste;
10. controlli strutturali e visuali su pagine vuote, bbox, clip, overflow e font.

Il testo e il preambolo LaTeX sono input eseguibili in senso lato: la compilazione deve avvenire in directory temporanea isolata, senza shell escape, con limiti di tempo/memoria/processi, `TEXINPUTS` controllato e politica esplicita sui pacchetti. Non sarà esposto alcun tool di comando arbitrario.

I path saranno limitati alle radici autorizzate dopo risoluzione dei symlink. Le modifiche useranno working copy, revisioni ottimistiche, batch atomici, scrittura temp+rename e snapshot recuperabili.

## 8. Gap da chiudere con prototipi di conformance

| Gap | Esperimento richiesto | Criterio di chiusura |
|---|---|---|
| Round-trip ID/metadati | Salvare e riaprire `custom` e `x-*` con Ipe 7.2.30 | Strategia ID sopravvive senza perdita di dati utente |
| Z-order esatto | Fixture sovrapposta con ordine XML, UI front/back ed export | Semantica documentata e test golden |
| Bbox e crop | Matrice `BBOX`/`VIEWBBOX`, titolo, link e transform | PDF/PNG coerenti per ogni view |
| Effetti PDF | Viewer matrix IpePresenter, Acrobat, Okular/Evince, pdfpc, browser | Supporto dichiarato per effetto/viewer |
| Testo a due passaggi | Label/minipage con font, formule e pacchetti diversi | Layout converge entro limite definito |
| Matrici limite | Property test su inverse/composizione e determinante | Tolleranza numerica motivata e stabile |
| 7.3.x | Nightly su `master` | Divergenze segnalate senza bloccare la stable |

## 9. Fonti primarie principali

- [Ipe release 7.2.30](https://github.com/otfried/ipe/releases/tag/v7.2.30)
- [Repository ufficiale Ipe](https://github.com/otfried/ipe)
- [Manuale PDF ufficiale](https://ipe.otfried.org/ipe-manual.pdf)
- [Formato XML 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/90_file_format.rst)
- [Presentazioni 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/70_presentations.rst)
- [Oggetti 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/30_objects.rst)
- [Concetti e layer 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/20_concepts.rst)
- [Snapping e coordinate 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/40_snapping.rst)
- [Stylesheet 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/60_stylesheets.rst)
- [Programmi a riga di comando 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/manual/94_commandline_programs.rst)
- [DTD 7.2.30](https://github.com/otfried/ipe/blob/v7.2.30/doc/ipe.dtd)
- [Bindings Lua/Ipelib](https://github.com/otfried/ipe/blob/v7.2.30/src/ipelua/bindings.txt)
- [IpePresenter](https://ipepresenter.otfried.org/)
- [MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Codex e MCP](https://developers.openai.com/codex/mcp)
