# ADR-0002 — Modello di dominio e layout

- Stato: **Accepted**
- Data: 2026-08-24

## Decisione

Il server usa una IR semantica versionata, indipendente dall'XML Ipe. Il modello minimo è `Document → Page → Layer/View/Object`: ogni documento ha almeno una pagina, un layer e una view; ogni oggetto top-level ha `layerId` esplicito e riferimenti risolvibili.

Layer, view e ordine visuale sono assi distinti:

- il layer determina appartenenza, visibilità, editabilità e snapping;
- la view determina lo stato di presentazione (layer visibili, active layer, mappe e trasformazioni ammesse);
- lo z-order è la sequenza globale back-to-front degli oggetti, indipendente dall'ordine dei layer. Il primo oggetto è più indietro, l'ultimo più avanti.

L'ordine dei layer non implementa `bringToFront`/`sendToBack`. Le API di z-order operano su object ID; quelle di layer spostano appartenenza senza alterare la sequenza, salvo richiesta esplicita.

Lo spazio predefinito è `frame`, con asse y-up e conversione esplicita a punti `bp`; sono supportati `paper`, `normalized`, `ipe` e `object-local`. Le matrici sono `[a b c d s t]`, con `x'=a*x+c*y+s` e `y'=b*x+d*y+t`, e composizione `viewLayerMatrix * objectMatrix * localPoint`. NaN e infinito sono rifiutati. Per la parte lineare, posto `n=max(|a|+|c|, |b|+|d|)`, la matrice è rifiutata se `n=0` oppure `|a*d-b*c| <= 1e-12*n^2`; M3 fisserà i property test e l'eventuale revisione versionata di questa tolleranza.

## View e animazione

Le view sono stati discreti. Reveal e movimento usano copie/varianti come default; le trasformazioni per-layer sono opt-in e accompagnate da warning su bbox, link e hit testing. Il serializer deterministico del server è proprietario della forma salvata e materializza sempre `active`, `marked` e il layer di ogni oggetto top-level. Il writer nativo 7.2.30 può omettere default ridondanti durante un probe: quell'output resta diagnostico e non viene promosso direttamente a salvataggio server; M1 ne fisserà il semantic diff. Le transizioni PDF sono dipendenti dal viewer e non sono prova di movimento continuo.

## Conseguenze

Il layout può richiedere un secondo passaggio per misure LaTeX, ma non diventa un sistema di constraint persistente. Le fixture M0 verificano coordinate/matrici, layer-view e z-order separatamente; probe e golden M1 chiuderanno divergenze native senza cambiare retroattivamente questo contratto.
