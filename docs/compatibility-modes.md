# Modalità di compatibilità e criteri di verifica

Questa matrice è il contratto operativo M0. `verified` è vincolato alla lane e ai controlli realmente eseguiti; non garantisce che ogni viewer interpreti allo stesso modo transizioni o feature sperimentali.

| Modalità | Runtime/versione | Capability | Failure mode | Label diagnostica | Quando può dire `verified` |
|---|---|---|---|---|---|
| `structural-only` | Nessun Ipe; XML target 70218 | Schema, IR, riferimenti, layer/view, z-order, numeri finiti, XML well-formed/canonico e policy locali | Mancano native, style, TeX, PDF e render; warning espliciti | `STRUCTURAL_ONLY_UNVERIFIED_NATIVE` | Solo **structural verified** se tutti i controlli locali passano. Mai `full`, `native` o `render verified`. |
| `full-7.2.30` | Ipe 7.2.30; writer XML 70218 | Tutti i controlli structural + DTD consultiva, load-save-reload nativo, style, pdfLaTeX sandbox, PDF, PNG e mapping page/view | Un livello fallito fallisce la verifica; timeout/feature non supportata è errore o warning classificato | `FULL_7_2_30_VERIFIED` / `FULL_7_2_30_FAILED` | Solo dopo tutti i livelli e conferma root `version="70218"` prima/dopo round-trip. |
| `nightly-7.3.x` | master/7.3.x, allowed-failure | Probe e controlli disponibili per la versione rilevata | Divergenza separata; non blocca stable e non riscrive file stabile | `NIGHTLY_EXPERIMENTAL_VERIFIED` / `NIGHTLY_DIVERGENCE` | Solo **nightly verified** per versione e corpus passati. Mai `full-7.2.30 verified`; API 7.3.x fuori dal MVP. |

## Regole di reporting

Ogni risultato include modalità, versione, formato, livelli eseguiti, warning/errori e artefatti. `verified` non viene emesso se un controllo è saltato, simulato o disponibile solo in un'altra lane.

Transizioni PDF, layer transform, differenze DTD/runtime e viewer sono diagnostica separata: la static correctness di ogni view può essere verificata, ma l'effetto dipendente dal viewer non diventa garanzia universale. Le note 7.3.x sono sempre `future/nightly`.
