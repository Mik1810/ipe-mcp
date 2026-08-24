# Laboratorio di conformance M1

Baseline verificata il 2026-08-25: Ubuntu 26.04/WSL, pacchetto Ipe `7.2.30-1build2`, runtime Lua `Ipe 7.2.30`, formato XML `70218`.

Il gate riproducibile è:

```bash
bash scripts/check-m1.sh
```

Il gate esegue M0, capability probe, load/save nativo, copia tramite Ipelib Lua, export PDF/SVG e confronto con un golden JSON deterministico. Gli output vivono esclusivamente in una directory temporanea. La lane opzionale da build sorgente usa binari già costruiti, senza scaricare o compilare implicitamente:

```bash
IPE_M1_SOURCE_BIN_DIR=/path/to/ipe/build/bin bash scripts/check-m1.sh
```

## Evidenze empiriche 7.2.30

| Esperimento | Risultato | Decisione |
|---|---|---|
| Documento senza layer/view | Il runtime accetta il file e salva `alpha`, una view e `active="alpha"` | Il serializer MCP emette sempre layer/view/active; il comportamento permissivo resta solo import compatibility |
| `marked="no"` | Il writer nativo lo omette come default falso | Il serializer MCP lo rimaterializza esplicitamente |
| `custom="ipe-mcp:<uuid>"` | Conservato da load/save e da `obj:clone()` | Canale stabile per l'identità, con nuovo UUID obbligatorio per ogni copia |
| Attributi ignoti e nodi `x-*` | Accettati in input ma persi al save nativo | Non sono un canale metadata supportato; il sidecar conserva i dati ricchi |
| Sequenza oggetti | Conservata dal load/save; l'inserimento Lua ha una posizione esplicita | La sequenza globale resta l'unica fonte dello z-order |
| `BBOX`, `VIEWBBOX`, link gruppo e transform view/layer | CropBox/ArtBox distinti e transform visivi conservati; il writer XML elide `crop="yes"`, mentre i layer riservati mantengono i box; il rettangolo link resta non trasformato | Il serializer rimaterializza `crop`; il transform per-view resta opt-in con warning esplicito su link e hit test |
| Effetti 0–27 | 28 view esportate; Normal non crea `/Trans`, gli altri 27 sì | La presenza nel PDF è verificabile; la riproduzione resta viewer-dependent |

Il golden confronta semantica normalizzata, non whitespace, creator o formattazione del writer.

## Serializer diretto e helper Lua

La forma persistita appartiene al serializer XML deterministico. `ipescript` non è un secondo serializer generale: è l'adapter nativo per operazioni in cui Ipelib possiede semantica non ricostruibile in sicurezza.

| Mutazione | Backend definitivo |
|---|---|
| Creazione di documenti e oggetti interamente rappresentati nell'IR | XML deterministico, seguito da validazione nativa nella lane full |
| Aggiornamento di attributi, layer/view e z-order già supportati dall'IR | XML deterministico; layer e z-order rimangono operazioni separate |
| Import di un documento esistente | Load Ipelib obbligatorio per capability/diagnostica; parsing XML lossless mantiene la sorgente finché non viene salvata |
| Copia di oggetti/pagine importati | `obj:clone()`/Page/Document via `ipescript`, poi assegnazione di un nuovo `ipe-mcp:<uuid>` |
| Bbox nativo, layer matrices, view maps, style check, LaTeX, export/render | `ipescript`/CLI Ipe obbligatori |
| Nodo o attributo ignoto non rappresentato nell'IR | Nessuna mutazione silenziosa: preservazione byte/sidecar oppure errore di capability |

Ogni salvataggio full rientra nell'IR e viene riserializzato per ripristinare gli attributi espliciti del contratto. Il corpus M1 rende osservabile ogni divergenza prima che M2 implementi parser e persistenza.

## Fonti tecniche

- Ipe 7.2.30, `manual/90_file_format.rst`: attributi ignoti, elementi `x-*`, view transform ed effetti.
- Ipe 7.2.30, `src/ipelua/bindings.txt`: `Document`, `Page`, `Object`, clone, custom, bbox e layer matrices.
- `report-source.md`: incompatibilità e scelte normative del progetto.
