# Matrice viewer iniziale M1

Questa è una matrice di conformance iniziale, non una dichiarazione universale di compatibilità. M1 verifica struttura statica, export e presenza delle transizioni nel PDF; la riproduzione interattiva multi-viewer resta un gate M7.

| Viewer/percorso | Staticità delle 28 view | Transizioni PDF | Stato M1 |
|---|---:|---:|---|
| Ipelib/`ipetoipe` 7.2.30 | PASS, 28 pagine PDF | PASS strutturale, 27 dizionari `/Trans` | Verificato automaticamente |
| `iperender` 7.2.30 | PASS per le view campionate | Non riproduce transizioni | Verificato automaticamente |
| IpePresenter 7.2.30 | PDF navigabile per pagina/view | Nessuna garanzia di interpolazione degli effetti | Installato; playback manuale non verificato |
| Acrobat Reader | Atteso dal formato PDF | Supporto dipendente da versione/piattaforma | Non testato |
| Okular/Evince | Atteso per pagine statiche | Supporto parziale o ignorato possibile | Non testato |
| pdfpc | Atteso per pagine statiche | Supporto non dichiarato da M1 | Non testato |
| Viewer browser | Atteso per pagine statiche | Spesso ignorato | Non testato |

## Enum 7.2.30 coperto dal corpus

| ID | Effetto | ID | Effetto |
|---:|---|---:|---|
| 0 | Normal | 14 | Glitter left-right |
| 1 | Split horizontal in | 15 | Glitter top-bottom |
| 2 | Split horizontal out | 16 | Glitter diagonal |
| 3 | Split vertical in | 17 | Fly in left-right |
| 4 | Split vertical out | 18 | Fly out left-right |
| 5 | Blinds horizontal | 19 | Fly in top-bottom |
| 6 | Blinds vertical | 20 | Fly out top-bottom |
| 7 | Box in | 21 | Push left-right |
| 8 | Box out | 22 | Push top-bottom |
| 9 | Wipe left-right | 23 | Cover left-right |
| 10 | Wipe bottom-top | 24 | Cover `ECoverLB` (PDF `/Di 270`) |
| 11 | Wipe right-left | 25 | Uncover left-right |
| 12 | Wipe top-bottom | 26 | Uncover top-bottom |
| 13 | Dissolve | 27 | Fade |

Il nome leggibile non è serializzato: il contratto normativo è l'ID enum 0–27 e la relativa struttura PDF. Le view restano staticamente corrette anche quando il viewer ignora `/Trans`.
