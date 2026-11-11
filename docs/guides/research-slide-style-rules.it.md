# Stile visivo per le presentazioni di ricerca

Una slide di ricerca dovrebbe rendere evidente la propria funzione. In una
definizione, separa chiaramente l'enunciato e le sue ipotesi dal resto della
slide. In un esempio svolto, dai al pubblico un modo per riconoscere lo
stesso oggetto in rappresentazioni diverse. In una dimostrazione, disponi la
tesi, il passaggio in corso e la conclusione in un ordine facile da seguire.
Gli esempi di questa guida sono schemi generali per preparare e rivedere
presentazioni in Ipe. [Versione inglese](research-slide-style-rules.md)

## Mantieni un riferimento stabile tra le viste

Lascia fermi il titolo, la linea di base, la griglia o il diagramma che
servono da riferimento mentre compaiono nuovi elementi. In un esempio
svolto, mostra prima l'istanza, poi la scelta e infine lo stato aggiornato
sulla stessa struttura grafica. In una dimostrazione, tieni visibile la
tesi mentre introduci i passaggi che la giustificano. All'apertura di una
sezione o quando cambi deliberatamente l'impaginazione puoi usare un
riferimento diverso.

L'harness può verificare la posizione di un titolo dichiarato persistente.
Per gli altri riferimenti confronta visivamente le viste consecutive. Se
un riferimento si sposta, valuta cosa il pubblico deve ritrovare e a
quale scopo serve lo spostamento.
[Controlli sui titoli e procedura di revisione](research-slide-style.md)

## Usa forme e posizione per mostrare la struttura

- **Riquadri.** Usa uno sfondo tenue per una definizione, un teorema o
  un'osservazione chiave che il pubblico dovrà ritrovare durante la
  spiegazione. Tieni la derivazione o il commento fuori dal riquadro. Un
  fondo grigio può distinguere un listato dal testo. Un riquadro a parte
  può mettere in evidenza una tecnica riutilizzabile all'interno di un
  esempio.
- **Contorni e graffe.** Un contorno indica quali oggetti appartengono
  allo stesso gruppo o insieme. Una graffa a fianco di più righe di
  pseudocodice può associare un costo all'intero blocco. Controlla che
  sia chiaro dove inizia e finisce il raggruppamento.
- **Forme che rappresentano dati.** Barre su uno stesso asse possono
  rappresentare una durata, mentre gli archi di un grafo mostrano quali
  vertici sono collegati. Mantieni coerenti scale e distanze nelle viste
  in cui queste proprietà hanno un significato. Metti le etichette
  vicino ai dati che identificano.

## Rendi chiara la funzione del colore

Riusa un colore quando lo stesso oggetto compare in più punti. Se un
cammino dell'albero originale diventa un solo arco nell'albero compresso,
ripeti il colore e mantieni riconoscibile la struttura che permette di
seguire la corrispondenza.

Quando il colore indica un cambio di stato, affiancagli un segno
riconoscibile per forma, posizione o testo. Un bordo può indicare una
cella selezionata, una croce può barrare un ramo scartato e una campitura
più tenue può lasciare visibile un'opzione inattiva per il confronto.
Lo stesso rosso può svolgere funzioni diverse. Verifica che sia chiaro a
quale elemento si riferisce il segno e che restino leggibili le etichette
ancora necessarie. Nei diagrammi monocromatici puoi affidare le
corrispondenze a posizione, motivi ripetuti e contorni distinti.

## Dai alle frecce origine, destinazione e significato chiari

Una freccia può mostrare un messaggio tra partecipanti, collegare una nota
a un termine, indicare il passaggio a una nuova rappresentazione o
tracciare un percorso in un esempio. Avvicina ogni estremità all'elemento
a cui si riferisce. Tieni le etichette accanto alle rispettive frecce e
controlla che gli incroci non rendano ambiguo il percorso. Quando il
verso è irrilevante, una linea di collegamento può bastare per associare
una nota al suo oggetto.

Controlla il verso delle punte rispetto all'azione descritta nel testo.
Per esempio, una tabella di programmazione dinamica può mostrare il
cammino risultante in ordine diretto, mentre l'algoritmo lo ricostruisce
a ritroso. Una didascalia può chiarire quale dei due versi mostrano le
frecce.

## Costruisci il disegno intorno al ragionamento

Dai al pubblico una rappresentazione stabile da seguire. Lascia i
partecipanti al loro posto mentre compaiono le frecce dei messaggi.
Mantieni fermo l'albero o l'array mentre evidenzi nodi, cammini o celle.
Quando una trasformazione cambia la rappresentazione stessa, disponi
lo stato iniziale e quello finale in posizioni che facilitino il
confronto e conserva, dove possibile, corrispondenze visibili. Usa le
icone per identificare ruoli o oggetti che il pubblico deve riconoscere.

## Rivedi le viste renderizzate in sequenza

1. Individua la funzione della slide e l'oggetto o l'enunciato che fa da
   riferimento.
2. Confronta viste consecutive. Annota cosa compare, scompare, si sposta o
   cambia colore. Verifica se il passaggio introduce un nuovo passo del
   ragionamento o chiarisce una corrispondenza.
3. Segui le frecce e le annotazioni che contano fino al loro bersaglio.
   Leggi formule, pedici e codice denso alla dimensione di proiezione.
4. Valuta le sovrapposizioni nel loro contesto. Una croce su un'alternativa
   scartata può essere intenzionale. Verifica che il pubblico riesca
   ancora a identificare sia l'alternativa scartata sia la scelta rimasta.
   Se serve un'eccezione nell'harness, registra la coppia di oggetti e il
   motivo.

La posizione del titolo persistente ha un controllo automatico. Il
significato delle frecce, l'assegnazione dei colori, la leggibilità e la
funzione dei disegni richiedono un giudizio in revisione.
[Rubrica di revisione](research-slide-style.md#review-by-role) · [Harness di qualità delle slide](slide-quality-harness.md)

## Evidenze e ambito della revisione

Il corpus di riferimento contiene 45 presentazioni e 5.028 pagine fisiche
PDF, tutte renderizzate. La revisione in ordine di PDF ha coperto 285
pagine di cinque presentazioni complete, con aperture singole dei
dettagli selezionati. Lo spostamento misurato dei titoli persistenti è
stato di 0 punti PDF in 56 transizioni di calibrazione e 78 transizioni
di verifica. Nei PDF appiattiti, i confini fra slide sono stati inferiti.

Un campione stratificato ha aggiunto 1.005 pagine dalle altre 40
presentazioni, 714 di ISNS e 291 di LPAA. Il passaggio è avvenuto su fogli
di contatto in miniatura, con sette raster aperti singolarmente e 72
osservazioni illustrative. Il campione amplia gli esempi delle regole
visive. Stimare quanto ricorrano, verificare la sequenza dei reveal e
valutare la leggibilità del testo minuto richiede una revisione più
ravvicinata.

A questo punto restano 3.738 pagine mai visionate. Altre 1.005 hanno avuto
il passaggio in miniatura e devono ancora essere seguite in sequenza.
I PDF di riferimento, i render e le evidenze per pagina restano in una
cartella di lavoro privata.
