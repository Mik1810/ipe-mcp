# Roadmap proposta — MCP server per Ipe

Stato: **baseline progettuale approvata il 2026-08-24; pronta per M0**.  
Baseline: **Ipe 7.2.30 stabile**, formato file `70218`.  
Obiettivo: consentire a Codex e ad altri agenti MCP di creare, modificare, verificare e renderizzare presentazioni Ipe senza esporre loro la complessità del formato XML.

## 1. Risultato atteso

Il prodotto sarà un server MCP locale e host-agnostic che offre due livelli d'uso:

1. **Composizione semantica**: “crea una slide, disponi titolo e tre pannelli, aggiungi un diagramma, costruisci quattro reveal”. È il percorso normale per gli agenti.
2. **Controllo preciso**: coordinate in punti Ipe, matrici, path strutturati, layer, view e stili. Serve per diagrammi scientifici, correzioni e round-trip.

Il server produrrà `.ipe` editabili, PDF e anteprime raster. Ogni mutazione sarà atomica, revisionata, validata e recuperabile. La correttezza statica di ogni view sarà un requisito; gli effetti animati dipendenti dal viewer saranno dichiarati esplicitamente come tali.

## 2. Decisioni architetturali proposte

Queste sono le scelte approvate per avviare il lavoro. Il registro decisionale è raccolto in fondo.

| Decisione | Proposta | Motivazione |
|---|---|---|
| Versione | 7.2.30 stabile; smoke 7.2.29; nightly 7.3.1/master | Ultima release verificabile, senza progettare contro codice non rilasciato |
| Linguaggio server | TypeScript ESM, Node 20+, SDK MCP ufficiale v2, Zod v4 | Contratti tool forti, distribuzione semplice, supporto MCP diretto |
| Trasporto MVP | stdio | Compatibile con Codex e altri host, superficie di sicurezza minima |
| Modello | IR semantica propria, versionata | Separa intenzione, layout e formato Ipe |
| Backend Ipe | Ibrido: serializer XML deterministico + helper ufficiale `ipescript`/Ipelib per import, mutazioni sensibili, canonicalizzazione e validazione | Evita FFI fragile ma non reimplementa ciecamente il runtime Ipe |
| Stato | Sessioni su working copy con revision counter | Evita sovrascritture e conflitti fra agenti |
| Layout | Frame-relative come default; paper/normalized/bp disponibili | Naturale per slide, ma senza perdere precisione |
| Animazione | View discrete; copie/varianti robuste come default | È il modello realmente portabile di Ipe/PDF |
| Identità | `custom="ipe-mcp:<uuid>"` + sidecar opzionale | ID stabili senza affidarsi a indici o nomi |
| Compatibilità | Contratto stretto e serializzazione esplicita | DTD, manuale e parser divergono in alcuni default |
| LaTeX MVP | pdfLaTeX e set minimo iniziale | Riduce superficie, dipendenze e variabilità nella prima fase |
| Piattaforma MVP | Ubuntu 26.04 su WSL, Ipe 7.2.30 dai repository Ubuntu | Corrisponde all'ambiente attuale e alla baseline esatta |
| Distribuzione | Rinviata a una decisione post-MVP | Prima validare core e workflow locali |

L'uso diretto di Ipelib C++ resta un'alternativa futura se i test mostrassero che `ipescript` non copre operazioni necessarie. `ipepython` non è proposto come fondazione: è un bridge non allineato alla release e ha limitazioni dichiarate sugli iteratori e sul packaging.

## 3. Modello concettuale da implementare

```text
Document
├── metadata, preamble, stylesheets, assets
└── Page[]
    ├── title, section, subsection, notes
    ├── Layer[]                 visibilità/editabilità/snapping
    ├── View[]                  stato di presentazione
    │   ├── visibleLayerIds[]
    │   ├── activeLayerId
    │   ├── attributeMaps[]
    │   ├── layerTransforms{}
    │   └── transition?
    └── Object[]                unica sequenza back-to-front
        ├── layerId             appartenenza, non z-order
        ├── zOrder              posizione nella sequenza
        ├── matrix, pin, transformationMode
        └── Path | Text | Image | Group | SymbolReference
```

Vincoli obbligatori:

- almeno una pagina, un layer e una view;
- layer esplicito su ogni oggetto top-level;
- nomi layer unici e senza whitespace;
- active layer esistente, non bloccato e normalmente visibile;
- ogni riferimento a stile, simbolo, asset, layer e oggetto deve risolversi;
- primo oggetto = più indietro, ultimo = più avanti; append porta davanti;
- `marked` e `active` sempre serializzati esplicitamente;
- nomi pagina/view impiegati come destinazioni unici;
- nomi Ipe speciali riservati e usabili solo tramite API dedicate.

## 4. Posizioni e layout

### 4.1 Spazi di coordinate

L'API deve accettare esplicitamente:

- `frame`: origine in basso a sinistra del frame; default;
- `paper`: origine in basso a sinistra del foglio;
- `normalized`: `(0,0)`–`(1,1)` rispetto a frame o paper;
- `ipe`: punti bp esatti con asse y-up;
- `object-local`: coordinate locali prima della matrice dell'oggetto.

Il core converte tutto in bp. L'API non invertirà implicitamente y senza che lo spazio scelto lo dichiari. Un helper UI opzionale potrà offrire coordinate top-left, ma dovrà serializzarle come una trasformazione esplicita e testata.

### 4.2 Ancore e box

Ogni oggetto esporrà:

- anchor: `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right`, `baseline-left` per testo;
- box logico, box geometrico e box visuale comprensivo di stroke;
- position, size, rotation, scale e transform origin;
- padding e margini dichiarativi.

Il layout distinguerà:

- **misure note**: forme e immagini con dimensioni esplicite;
- **misure differite**: testo LaTeX;
- **misure dipendenti dalla view**: oggetti trasformati o visibili selettivamente.

### 4.3 Primitive di layout

Il livello semantico offrirà:

- `place`, `move`, `resize`, `rotate`, `transform`;
- `align`, `distribute`, `center`, `fit`, `contain`, `cover`;
- container `row`, `column`, `grid`, `stack`;
- gap, padding, min/max size e aspect ratio;
- ancore fra oggetti: `below`, `rightOf`, `sameWidth`, `alignBaseline`;
- guide frame/paper e safe area;
- connector che ricalcola gli endpoint quando cambiano i box.

Non verrà promesso un sistema CAD parametrico persistente: Ipe salva coordinate, non constraint. Il sidecar può conservare le intenzioni di layout per una futura ricomposizione, mentre il `.ipe` resta autonomo e modificabile.

### 4.4 Matrici

Rappresentazione canonica `[a b c d s t]`:

```text
x' = a*x + c*y + s
y' = b*x + d*y + t
```

Ordine di composizione: `viewLayerMatrix * objectMatrix * localPoint`. Il server deve:

- offrire costruttori semantici per translate/rotate/scale/shear;
- pre-moltiplicare in modo coerente con `Page::transform`;
- rifiutare NaN, infinito e matrici singolari/quasi singolari;
- interpolare movimento mediante componenti semantiche, non elemento per elemento, per evitare shear e degenerazioni inattese;
- testare composizione, inversione e round-trip con property-based testing.

## 5. Pagine, layer e view

### 5.1 Pagine

Operazioni previste:

- creare, duplicare, spostare ed eliminare una pagina;
- impostare title, section, subsection, notes e stato marked;
- scegliere layout/stile e dimensioni;
- clonare una pagina preservando o rigenerando gli ID;
- ispezionare conteggio e mapping pagina Ipe → pagine PDF prodotte dalle view.

Le note native sono per-page e vengono replicate su tutte le view. Note per-view, se richieste, saranno metadati MCP con una politica esplicita di aggregazione per IpePresenter.

### 5.2 Layer

Operazioni previste:

- add/rename/remove/reorder metadata;
- lock/unlock (`edit`) e politica di snapping;
- spostamento di oggetti fra layer senza cambiarne lo z-order;
- show/hide in una o più view;
- layer dedicato per un oggetto animato indipendentemente;
- operazioni intenzionali per `BBOX`, `VIEWBBOX`, `BACKGROUND`, `GRID`, `NOPDF`.

L'ordine della lista layer non sarà mai usato come ordine di disegno. Il server esporrà separatamente `moveForward`, `moveBackward`, `bringToFront`, `sendToBack` e inserimento relativo a un object ID.

### 5.3 View

Operazioni previste:

- creare da una view precedente o da una lista di layer;
- visibilità cumulativa e non cumulativa;
- active layer esplicito;
- marked per handout;
- mappe simboliche per colore, pen, dash, opacity, symbol size, arrow size e symbol;
- matrice per layer con warning di compatibilità;
- transizione PDF e durate intere per il target 7.2.30;
- nome univoco e lookup stabile tramite ID MCP.

Ogni modifica mostrerà il numero di pagine PDF risultanti, per rendere evidente il costo degli overlay.

## 6. Oggetti e forme geometriche

### 6.1 Operazioni comuni

Tutti gli oggetti supporteranno:

- insert, replace, duplicate, delete, group, ungroup;
- layer e z-order indipendenti;
- matrice, pin e transformation mode (`affine`, `rigid`, `translations`);
- style patch, link, custom ID e metadata sidecar;
- bbox, hit region e diagnostica;
- mutazioni tramite replace/transform o invalidazione esplicita della cache bbox nel backend nativo.

### 6.2 IR geometrica

Primitive pubbliche:

- point, segment, polyline, polygon;
- rectangle e rounded rectangle;
- circle ed ellipse, anche ruotata;
- arc circolare/ellittico tramite centro, raggi, rotazione e angoli;
- quadratic/cubic Bézier;
- uniform spline, closed spline, cardinal/Catmull–Rom, clothoid/Spiro;
- compound path con buchi;
- connector straight/orthogonal/curved con frecce;
- raw structured path come escape hatch avanzata, mai stringa postfix non validata nell'uso normale.

Il compilatore deve preservare open/closed, fill rule, orientamento, frecce e degenerazioni. Le frecce sono ammesse soltanto su una singola subpath aperta; gradienti/tiling richiedono fill; un simbolo non definito è errore o warning configurabile.

### 6.3 Stile

Supporto previsto:

- stroke/fill, pen, dash, cap, join, winding/even-odd;
- arrow e reverse arrow;
- opacity e stroke opacity simboliche;
- gradienti axial/radial;
- tiling lineare nativo;
- pathstyle, textstyle, size e simboli;
- import, merge e precedenza degli stylesheet;
- `checkStyle()` come gate prima del salvataggio/export.

I valori assoluti saranno normalizzati; i valori simbolici dovranno esistere nella cascade. Non si farà affidamento sui default DTD controversi.

### 6.4 Testo

API distinte:

- `label`: testo breve/formula e allineamento sul baseline;
- `textBox`: compilato in minipage con larghezza;
- `title`, `subtitle`, `body`, `caption`, `code` come preset di stile, non nuovi tipi Ipe.

Pipeline:

1. validazione/policy del frammento LaTeX;
2. layout provvisorio;
3. compilazione in sandbox;
4. aggiornamento width/height/depth;
5. risoluzione di allineamenti e connector dipendenti;
6. secondo passaggio limitato e errore di non convergenza esplicito.

### 6.5 Immagini, gruppi e simboli

- PNG e JPEG garantiti; altri formati convertiti in modo esplicito da adapter installabili.
- Deduplica bitmap per hash; policy per profili colore e alpha.
- Aspect ratio `contain|cover|stretch`; crop mediante gruppo con clip.
- SVG/PDF importati mediante tool ufficiali/converter e poi validati, non mascherati da image raster.
- Group con clip/link/decorazione e ordine interno back-to-front.
- Symbol reference (`use`) con parametri ammessi, punti snap e XForm solo quando compatibile.

## 7. Animazioni, reveal e scorrimento

### 7.1 Contratto onesto

Ipe non ha una timeline continua. Il server distinguerà quattro prodotti:

1. **Reveal nativo**: visibilità layer fra view.
2. **Motion discreto**: stati intermedi generati fra view.
3. **Transizione PDF**: effetto dell'intera pagina, viewer-dependent.
4. **Video continuo**: pipeline opzionale futura, non parte del `.ipe` nativo.

Nessun tool chiamerà “fluida” una sequenza di view. L'anteprima deve poter mostrare ogni stato statico anche se il viewer non supporta transizioni.

### 7.2 Operazioni ad alto livello

`buildReveal`:

- target object/layer IDs;
- ordine o gruppi simultanei;
- cumulative/non-cumulative;
- stato iniziale e finale;
- creazione/riuso dei layer;
- marking per handout.

`buildScroll` / `buildMotion`:

- target e asse x/y o percorso;
- offset/pose iniziale e finale;
- numero di step con limite configurabile;
- easing semantico;
- regione di clipping;
- strategia `duplicate` (default) o `layer-transform` (opt-in);
- politica bbox (`fixed`, `per-view`, `explicit`);
- viewer target e fallback statico.

`setTransition`:

- enum tipizzato dei 28 effetti;
- durata pagina e transizione intere per 7.2.30;
- warning se il viewer dichiarato non le supporta;
- preset push/cover/uncover solo per intera slide.

### 7.3 Limiti e guardrail

- Default massimo di view generate per singola operazione; preventivo prima di espandere.
- Nessun tentativo di simulare 30/60 fps in PDF.
- Layer dedicato quando un oggetto deve muoversi indipendentemente.
- `BBOX` esplicito quando le trasformazioni potrebbero uscire dal box originale.
- Clip fisso o duplicazione per pannelli scrollabili; trasformare il gruppo sposterebbe anche il clip.
- Titolo e Background automatici non seguono una camera pan: vanno materializzati come oggetti se devono muoversi.
- Link, hit testing e bbox su layer transform generano diagnostiche di compatibilità.

### 7.4 Matrice di compatibilità viewer

Da verificare almeno su:

| Viewer | View statiche | Note | `/Trans` | `/Dur` | Stato |
|---|---:|---:|---:|---:|---|
| Ipe editor | sì | editing | n/a | n/a | fixture automatica/manuale |
| IpePresenter | sì | sì | non interpretato dal sorgente | non interpretato | test runtime |
| Adobe Acrobat | sì | n/a | da misurare per effetto | da misurare | test manuale |
| Okular/Evince | sì | n/a | da misurare | da misurare | test manuale |
| pdfpc | sì | presenter | da misurare | da misurare | test manuale |
| Browser PDF | sì | variabile | non affidabile | non affidabile | test manuale |

## 8. Architettura del server

### 8.1 Moduli

```text
MCP adapter
├── tool schemas e resources
├── session/document manager
└── job/diagnostic facade
Domain core
├── versioned IR
├── coordinate/layout engine
├── geometry compiler
├── style and asset registry
├── page/layer/view compiler
└── animation expander
Ipe adapters
├── canonical XML parser/serializer
├── ipescript/Ipelib helper
├── LaTeX sandbox
├── export/render CLI
└── compatibility probes
Persistence
├── atomic working copies
├── history/snapshots
├── sidecar metadata
└── artifact/resource store
```

Il domain core non dipenderà dal trasporto MCP. `createServer()` costruirà lo stesso server per stdio e, in futuro, Streamable HTTP.

### 8.2 Sessioni e concorrenza

- `open` crea una working copy; l'originale non cambia fino a `save` esplicito.
- Ogni risposta mutante restituisce `documentId`, `revision`, IDs creati e diagnostica.
- Ogni mutazione accetta `expectedRevision`; un conflitto non viene sovrascritto.
- Batch atomici: o tutte le operazioni passano, o nessuna viene applicata.
- Rilevazione del cambio hash del file sorgente fuori sessione.
- Scrittura su temporaneo + rename; backup/snapshot recuperabile.
- Undo/redo per transazioni semantiche, non per singola scrittura XML.

### 8.3 Tool surface proposta

Una superficie piccola riduce la scelta errata del modello. I dettagli vivono in union tipizzate.

| Tool | Mutazione | Scopo |
|---|---:|---|
| `ipe_get_capabilities` | no | Versioni, backend, TeX, converter, limiti e viewer profile |
| `ipe_create_document` | sì | Nuovo documento da layout/style/template |
| `ipe_open_document` | no sulla sorgente | Sessione/working copy e diagnostica iniziale |
| `ipe_inspect` | no | Outline, pagina/view, oggetti, stili, bbox e ID |
| `ipe_apply_operations` | sì | Batch tipizzato di mutazioni documentali/layout/geometria |
| `ipe_compose_slide` | sì | Composizione semantica ad alto livello |
| `ipe_build_views` | sì | Reveal, motion discreto, scroll e transizioni |
| `ipe_validate` | no | Livelli structural/native/latex/render |
| `ipe_render_preview` | no | PNG di pagina/view e diagnostica visuale |
| `ipe_save_document` | sì su file | Commit atomico della working copy |
| `ipe_export_document` | sì su artefatto | PDF, marked-view PDF, PNG/SVG dove supportato |
| `ipe_history` | sì/no | Elenco revisioni, undo, redo, snapshot |

`ipe_apply_operations` non accetterà XML arbitrario nel percorso normale. Le operazioni saranno una discriminated union: document/page/layer/view/object/layout/style/asset. L'escape hatch raw sarà sperimentale, disabilitata di default e comunque parse/round-trip validata.

### 8.4 Resources e output

Resources proposte:

- `ipe://documents/{id}/summary`
- `ipe://documents/{id}/source`
- `ipe://documents/{id}/pages/{pageId}/views/{viewId}/preview`
- `ipe://documents/{id}/diagnostics`
- `ipe://styles/{styleId}`
- `ipe://artifacts/{artifactId}`

Le anteprime richieste restituiscono una PNG compatta come content image e un resource link all'artefatto completo. `structuredContent` contiene revision, dimensioni, page/view mapping, IDs e warnings. Bitmap/PDF grandi non vengono riversati nel contesto del modello.

### 8.5 Integrazione Codex e altri host

- Configurazione progetto in `.codex/config.toml` e istruzioni server concise per Codex.
- stdio con stdout riservato al protocollo e log su stderr.
- Smoke test con Codex app/CLI, MCP Inspector e almeno un secondo host.
- Contratti indipendenti da direttive o skill proprietarie di Codex.
- Streamable HTTP solo dopo l'MVP, con localhost, Origin validation e autenticazione.

## 9. Validazione, sicurezza e modalità degradate

### 9.1 Livelli di validazione

| Livello | Controlli | Disponibilità senza Ipe |
|---|---|---:|
| Schema | input/output, enum, limiti, numeri finiti | sì |
| IR | riferimenti, unicità, layer/view, z-order, stili | sì |
| XML | well-formed, serializer canonico, no XXE | sì |
| DTD consultiva | differenze note escluse/versionate | opzionale |
| Native | load → save → reload con Ipelib | no |
| Style | `checkStyle()` | no |
| LaTeX | compilazione e metriche testo | no |
| Export | PDF e mapping view/pagine | no |
| Render | PNG, bbox, crop, clip, blank/overflow | no |

Modalità:

- **structural-only**: genera/ispeziona ma marca chiaramente l'assenza di convalida nativa;
- **full 7.2.30**: percorso supportato per release;
- **nightly 7.3.x**: compatibilità sperimentale, mai usata per riscrivere un file stabile senza consenso.

### 9.2 Sicurezza

- Root di workspace allowlisted; canonicalizzazione path e verifica symlink.
- Nessun URL/media remoto di default; download separato con allowlist, size e MIME checks.
- Limiti su file, asset, pixel, oggetti, pagine, view e profondità gruppi.
- XML parser con DTD/entità esterne disabilitate durante il parsing normale.
- LaTeX in temp isolata, senza shell escape, rete, scrittura fuori temp o `TEXINPUTS` non controllato; timeout, RAM, processi e output limitati.
- Preambolo libero classificato come capability avanzata e soggetto a policy.
- Nessun tool shell o command arbitrario.
- Log senza contenuto LaTeX completo, file sensibili o dati binari; diagnostica redatta.
- HTTP futuro: bind localhost, Origin validation, auth e protezione DNS rebinding.

## 10. Strategia di test

### Unit e property test

- matrici: composizione, inversa, decomposition/interpolation;
- conversione frame/paper/normalized e anchor;
- parser/serializer path e archi;
- fill rule, orientamento, frecce e compound path;
- style cascade e mapping per-view;
- invariant generator su pagine/layer/view;
- convergenza del layout testuale.

### Fixture golden

- tutti i cinque object type;
- ogni primitiva geometrica, inclusi casi degeneri;
- z-order sovrapposto e group nesting;
- clip, link, BBOX/VIEWBBOX/crop;
- PNG/JPEG/alpha e deduplica;
- label/minipage/formule/Unicode con engine dichiarati;
- overlay cumulativi e arbitrari;
- layer map e transform;
- marked handout e note replicate;
- 28 effetti PDF come fixture strutturali.

### Round-trip e integrazione

- IR → XML → Ipelib → XML → Ipelib; confronto semantico, non byte-for-byte;
- import/edit/save di documenti creati a mano;
- `custom` e metadati sconosciuti senza perdita;
- LaTeX → PDF → PNG di tutte le view selezionate;
- conteggio view = pagine PDF attese;
- MCP Inspector e contract tests su errori/structured output;
- smoke host Codex e altro client;
- CI 7.2.30 da sorgente, 7.2.29 binario dove disponibile, master nightly allowed-failure.

### Verifica visuale

Non basta “il file si apre”. I gate includeranno:

- render non vuoto;
- oggetti entro safe area o overflow dichiarato;
- testo non troncato;
- bbox/crop coerenti fra view;
- clip e link nella regione attesa;
- confronto percettivo con tolleranza e revisione umana dei cambi golden.

## 11. Piano di esecuzione per milestone

Ogni milestone termina con un gate di revisione; non si procede su una decisione strutturale non accettata.

### M0 — Contratti e ADR

**Stato: completata il 2026-08-24.** Gate dimostrato da `bash scripts/check-m0.sh` su Ipe `7.2.30-1build2`, con review avversariale e test indipendenti completati.

Deliverable:

- `docs/adr/0001-compatibility-baseline.md`: Ipe 7.2.30, formato 70218 e lane 7.3.x;
- `docs/adr/0002-domain-model-and-layout.md`: IR, coordinate, matrici, z-order e page/layer/view;
- `docs/adr/0003-backend-persistence-and-identifiers.md`: backend ibrido, transazioni, `custom` e sidecar;
- `docs/adr/0004-security-and-trust-boundaries.md`: sezioni canoniche `TM-XML`, `TM-TEX`, `TM-FS`, `TM-ASSET`, `TM-PROC`, `TM-CONCURRENCY`, `TM-METADATA` e `TM-HTTP`;
- `docs/compatibility-modes.md`: matrice structural-only/full/nightly con capability, failure mode e label di diagnostica;
- `fixtures/conformance/manifest.json` e almeno sei seed `.ipe` manuali: minimal, positions/matrices, layers/views, geometry/z-order, custom metadata, text/minipage;
- `scripts/check-m0.sh`: smoke riproducibile di ADR/manifest, versione installata e round-trip di ogni seed con `ipetoipe -xml`, usando output temporanei.

Gate:

- tutti gli ADR hanno stato `Accepted`; la distribuzione è registrata come deferral approvato, non come decisione mancante;
- threat model contiene tutti gli otto ID canonici: XML/parser, LaTeX, filesystem/path, asset/rete, subprocess/CLI native, concorrenza/atomicità, metadata/sidecar e futuro HTTP; ogni rischio è collegato a una mitigazione/gate futuro;
- la matrice definisce esattamente cosa può essere dichiarato “verificato” nelle tre modalità;
- il manifest inventaria scopo, feature e invarianti di ogni seed, senza asset generati o binari superflui;
- `bash scripts/check-m0.sh` verifica gli otto ID, richiede che `dpkg-query -W -f='${Version}' ipe` inizi con `7.2.30`, mostra la versione rilevata e conferma root `version="70218"` prima e dopo il round-trip;
- nessun ADR o seed dipende da API 7.3.x; eventuali note 7.3.x sono marcate future/nightly.

Confine M0/M1: i seed di M0 fissano casi e invarianti minimi, ma non pretendono di risolvere le divergenze native. M1 implementa probe, golden e decisioni empiriche e può estendere il corpus senza cambiare retroattivamente i contratti approvati.

### M1 — Laboratorio di conformance Ipe

**Stato: completata il 2026-08-25.** Gate stabile dimostrato da `bash scripts/check-m1.sh` su Ipe `7.2.30-1build2`, con golden, review avversariale Sol e test indipendenti Luna; la lane build-sorgente resta opzionale e riproducibile tramite binari 7.2.30 forniti esplicitamente.

Deliverable:

- ambiente riproducibile con pacchetto Ubuntu Ipe/`ipescript` 7.2.30 e probe delle capability; build da sorgente mantenuta come controllo CI opzionale;
- probe automatici per divergenze DTD/runtime;
- esperimenti su `custom`, `x-*`, z-order, bbox, link e layer transform;
- confronto serializer diretto vs helper Lua;
- prima matrice viewer sugli effetti.

Gate:

- strategia ID sopravvive a load/save/copy;
- ordine visuale e default controversi coperti da golden;
- decisione definitiva su quali mutazioni richiedono `ipescript`.

### M2 — IR, XML e persistenza transazionale

**Stato: completata il 2026-08-25.** Gate stabile dimostrato da `bash scripts/check-m2.sh` su Ipe `7.2.30-1build2`: 62 test, confronto semantico/fixed-point/reload nativo dei 12 fixture, review avversariale Sol senza finding P0–P2 e test indipendenti Luna. La lane M1 da build sorgente resta opzionale e non eseguita perché `IPE_M1_SOURCE_BIN_DIR` non è configurato.

Deliverable:

- IR versionata e schema Zod;
- parser/serializer XML canonico;
- document/session manager, revision e atomic save;
- sidecar opzionale e migrazioni di schema;
- structural validator.

Gate:

- round-trip semantico del corpus senza perdita supportata;
- conflitti di revisione e recovery testati;
- originali mai mutati prima di save.

### M3 — Coordinate e layout

Deliverable:

- quattro spazi di coordinate;
- anchor, box, matrix e transform origin;
- row/column/grid/stack, align/distribute/fit;
- constraint sidecar e connector preliminari;
- property test numerici.

Gate:

- fixture su layout standard e presentation 16:9;
- nessuna inversione y o errore di composizione nelle golden;
- policy su tolleranza numerica approvata.

### M4 — Oggetti, geometria, testo, asset e stili

Deliverable:

- CRUD e z-order per i cinque tipi;
- compilatore completo delle primitive geometriche;
- style registry/cascade;
- PNG/JPEG, deduplica e clipping;
- testo LaTeX a due passaggi;
- symbol/reference e group.

Gate:

- golden per ogni tipo e primitiva;
- `checkStyle()` pulito;
- frecce/fill/clip/gradienti e testo complesso validati nativamente.

### M5 — Pagine, layer, view e composizione slide

Deliverable:

- API completa page/layer/view;
- note, section/subsection, title e handout;
- `compose_slide` con template/preset non distruttivi;
- layer speciali gestiti intenzionalmente;
- mapping Ipe page/view → PDF page.

Gate:

- layer e z-order restano indipendenti in ogni operazione;
- view cumulative e arbitrarie producono il PDF atteso;
- bbox/crop/title/notes superano le fixture.

### M6 — Adapter nativo, render ed export

Deliverable:

- helper `ipescript`, `runLatex`, `checkStyle`, export;
- sandbox LaTeX;
- preview PNG per view e diagnostica visuale;
- capability detection e modalità structural/full/nightly.

Gate:

- un documento full passa tutti i livelli di validazione;
- timeout/errori TeX non corrompono la sessione;
- output riproducibile in CI.

### M7 — Reveal, motion e scorrimento

Deliverable:

- builder reveal;
- motion/scroll con copie e layer transform opt-in;
- bbox/clip policy e limiti di espansione;
- enum effetti e viewer warnings;
- handout delle animazioni.

Gate:

- ogni view è staticamente corretta;
- test su pannello scrollabile e camera pan;
- IpePresenter non viene dichiarato compatibile con effetti che ignora;
- matrice viewer pubblicata.

### M8 — Server MCP stdio

Deliverable:

- tool surface, resources, structured output e error taxonomy;
- istruzioni server e configurazione Codex;
- MCP Inspector, Codex e secondo host;
- preview/resource links senza saturare il contesto.

Gate:

- scenario end-to-end da prompt a `.ipe`/PDF/PNG;
- tool mutanti distinguibili e revision-safe;
- stdout protocol-only e log sicuri.

### M9 — Hardening e release

Deliverable:

- limiti, fuzz/property tests e corpus ostile;
- procedura locale riproducibile su Ubuntu 26.04 WSL;
- verifica del pacchetto Ubuntu Ipe 7.2.30 e delle capability richieste;
- manuale per agenti, esempi e troubleshooting;
- SBOM, licenze e policy di supporto.

Gate:

- suite stable verde su Ubuntu 26.04 WSL;
- installazione locale pulita e ripetibile;
- nessun finding critico del threat model aperto;
- release candidate revisionata con deck reali.

### M10 — Estensioni post-MVP

- Streamable HTTP autenticato;
- live bridge con Ipe aperto e sincronizzazione bidirezionale;
- strategia distributiva, packaging npm e bundle/helper installabile;
- supporto e CI per Linux non-WSL, macOS e Windows;
- container/devcontainer se ancora utile dopo la validazione locale;
- template marketplace/plugin Codex;
- import SVG/PDF più fedele;
- presenter web dedicato con interpolazione reale;
- video continuo, solo dopo uno spike su Manim/licenze/fedeltà;
- adozione di 7.3.x solo dopo una release stabile e test di migrazione.

## 12. Definition of Done dell'MVP

L'MVP è completo soltanto quando un agente può:

1. creare o aprire un documento Ipe senza alterare l'originale;
2. comporre una slide 16:9 usando coordinate/anchor/layout;
3. inserire e modificare testo, immagini, gruppi, simboli e tutte le forme geometriche di base;
4. controllare layer e z-order separatamente;
5. creare pagine e view, reveal e uno scorrimento discreto con fallback robusto;
6. validare XML, Ipelib, stili, LaTeX, PDF e anteprima;
7. ispezionare visivamente ogni view;
8. salvare atomicamente `.ipe` ed esportare PDF/PNG;
9. annullare una transazione o recuperare lo snapshot precedente;
10. eseguire lo stesso flusso da Codex e da almeno un altro host MCP.

Non fanno parte dell'MVP: editing live della GUI Ipe, animazione continua nel `.ipe`, garanzia universale delle transizioni PDF, server pubblico remoto, preambolo LaTeX arbitrario senza sandbox, supporto fondato su 7.3.x non rilasciato.

## 13. Rischi principali e mitigazioni

| Rischio | Impatto | Mitigazione |
|---|---|---|
| Manuale/DTD/runtime divergono | file formalmente valido ma semanticamente errato | contract stretto, valori espliciti, conformance suite Ipelib |
| Upstream 7.2.30 è source-only e i pacchetti distro possono divergere | installazione/versione non uniforme fuori dall'ambiente iniziale | pin e capability probe del pacchetto Ubuntu 26.04; strategia distributiva rinviata |
| LaTeX non fidato | lettura/scrittura o DoS | sandbox e policy pacchetti/preambolo |
| Layer transform sperimentale | bbox/link/editing errati | copie default, warning e BBOX esplicito |
| Troppe view | PDF enorme e lentezza | preventivo, limiti e handout |
| Round-trip di file complessi | perdita di feature ignote | working copy, semantic diff, native canonicalization, backup |
| Differenze viewer | animazione non riprodotta | static correctness e matrice viewer |
| Metadata ID persi | impossibile aggiornare oggetti | `custom` testato + sidecar/fingerprint |
| Testo modifica il layout dopo TeX | overlap/troncamento | due passaggi limitati e diagnostica |
| FFI/native ABI | distribuzione fragile | subprocess `ipescript`; C++ solo se necessario |
| Licenza Ipe GPLv3 | vincoli di distribuzione | review legale/licenze prima del bundle; confine subprocess |

## 14. Registro delle decisioni approvate

| # | Decisione | Esito 2026-08-24 |
|---:|---|---|
| 1 | Ambito MVP | Create + edit + render/export |
| 2 | Backend | Ibrido XML deterministico + `ipescript`; Ipelib C++ resta fallback futuro |
| 3 | Dipendenza Ipe | Modalità structural-only ammessa; Ipe 7.2.30 richiesto per output “verificato” |
| 4 | Layout | `frame`/y-up predefinito; helper top-left esplicito |
| 5 | Animazione | Copie/varianti predefinite; layer transform opt-in |
| 6 | Scorrimento | Inclusi sia pannelli interni sia pan dell'intera composizione |
| 7 | LaTeX | Profilo minimo pdfLaTeX nell'MVP |
| 8 | Metadata | ID `custom` + sidecar opzionale approvati |
| 9 | Distribuzione | Decisione rinviata a dopo la validazione dell'MVP locale |
| 10 | Piattaforma iniziale | Ubuntu 26.04 WSL; altre piattaforme post-MVP |

## 15. Fonti e tracciabilità

Il dossier dettagliato, incluse contraddizioni, limiti e gap sperimentali, è in [`report-source.md`](./report-source.md). Le fonti normative principali sono la [release Ipe 7.2.30](https://github.com/otfried/ipe/releases/tag/v7.2.30), il [manuale ufficiale](https://ipe.otfried.org/ipe-manual.pdf), i [sorgenti del tag](https://github.com/otfried/ipe/tree/v7.2.30), la [specifica MCP stabile 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) e la [documentazione MCP di Codex](https://developers.openai.com/codex/mcp).
