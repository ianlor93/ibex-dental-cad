# IBEX

[English](README.md) · **Italiano**

IBEX è un **CAD dentale sperimentale che gira nel browser**, costruito attorno a un **grafo procedurale di nodi**.

Non si modifica una mesh passo dopo passo. Si costruisce nel browser un grafo di operazioni — trasformare, scolpire, pulire, tagliare, rilevare l'arcata, generare la base di un modello — e il server lo calcola e rimanda il risultato nel viewport 3D. Ogni passaggio resta modificabile: si cambia un parametro, o un nodo a metà della catena, e il grafo viene ricalcolato da lì in poi. Quando il risultato è pronto, un nodo dedicato consegna la mesh finale nella cartella cloud dell'utente.

È progettato per il settore dentale nel suo insieme: chiunque lavori nel settore può usarlo. Era in preparazione per una beta chiusa. Questo repository ne è una **versione di riferimento ripulita**: sono stati tolti l'identità dell'installazione originale, le credenziali e i dettagli dell'infrastruttura, e tutto ciò che identifica un'installazione è diventato configurazione.

> **Non è un dispositivo medico.** IBEX non è un software certificato e non è stato validato per l'uso clinico. Chi lo usa per progettare o fabbricare dispositivi dentali su misura resta interamente responsabile della verifica di ogni risultato.

## Indice

- [Grafo, bake, burn](#grafo-bake-burn)
- [I nodi](#i-nodi)
- [Lavorare nell'editor](#lavorare-nelleditor)
- [Come si svolge un calcolo](#come-si-svolge-un-calcolo)
- [Progetti, salvataggio e pulizia](#progetti-salvataggio-e-pulizia)
- [Architettura](#architettura)
- [Sicurezza](#sicurezza)
- [Installazione](#installazione)
- [Usarlo senza Nextcloud](#usarlo-senza-nextcloud)
- [Estendere IBEX: creare nuovi strumenti](#estendere-ibex-creare-nuovi-strumenti)
- [API HTTP](#api-http)
- [Limiti noti](#limiti-noti)
- [Come è stata preparata questa pubblicazione](#come-è-stata-preparata-questa-pubblicazione)
- [Autore](#autore) · [Licenza](#licenza)

---

## Grafo, bake, burn

Tre parole descrivono tutto il flusso di lavoro.

- **Grafo.** In un editor a nodi accanto al viewport, l'utente collega dei nodi. Ogni nodo ha porte di ingresso e di uscita (mesh, curve, matrici di trasformazione) e i propri parametri. I nodi si scelgono da una palette con ricerca, raggruppata per categoria.
- **Bake.** Ogni modifica al grafo — un parametro, un nuovo collegamento, un nodo rimosso — avvia un nuovo calcolo sul server, dopo una breve pausa (500 ms), così che trascinare uno slider non riempia la coda. Un gruppo di worker calcola il grafo e rimanda un'anteprima compressa. La geometria pesante non gira mai sul dispositivo dell'utente: per questo IBEX si può usare anche da tablet.
- **Burn.** Quando il risultato è quello giusto, il nodo *Burn* consegna la mesh finale — STL, OBJ o PLY — in una cartella a scelta dello spazio cloud dell'utente, dove compare subito tra i suoi file. Il bake è il calcolo continuo; il burn è la consegna una tantum.

---

## I nodi

Questa pubblicazione comprende tredici nodi.

| Nodo | Categoria | Cosa fa |
|---|---|---|
| **Trasforma mesh** | Modifica | Sposta e ruota una mesh. Espone la sua trasformazione su una porta matrice che altri nodi possono riusare. |
| **Copia trasformazione** | Modifica | Applica a una mesh la trasformazione di un altro nodo (un «padre»), seguendo l'intera catena dei padri. |
| **Scolpisci** | Modifica | Scultura interattiva nel browser, con topologia dinamica (porting modificato di SculptGL). |
| **Pulisci mesh** | Modifica | Pulisce una scansione con PyMeshLab: toglie i difetti, leviga la fascia lungo il bordo aperto, ripara la geometria non-manifold, chiude i fori e decima le mesh molto dense (oltre 200.000 facce, fino a circa 150.000). |
| **Cancella topologia** | Modifica | Cancella le facce selezionate dall'utente. |
| **Separa topologia** | Modifica | Divide una mesh in due (uscite A e B): per selezione, oppure lungo una curva chiusa, con un taglio geodetico che segue la superficie. |
| **Ricostruisci topologia** | Modifica | Lavora su una regione selezionata: con un solo bordo aperto chiude il foro; con due bordi separati li collega con un ponte. |
| **Disegna curva** | Modifica | Disegna curve spline sulla superficie della mesh, da usare in altri nodi. |
| **Rileva arco** | Detect | Trova automaticamente la cresta dell'arcata dentale, sia su modelli dentati sia edentuli, e la classifica rispetto alle forme d'arcata standard. Il risultato è una curva. |
| **Modifica curva** | Detect | Modifica una curva esistente: trascina i punti di controllo (agganciati alla superficie), inserisce o toglie punti, aggiunge spline, le apre o le chiude, ne inverte il verso. |
| **Model generator** | Modifica | Genera la base di un modello dentale: estrude verso il basso il bordo aperto della scansione e lo taglia in piano; con uno spessore di parete maggiore di zero rende il modello cavo. |
| **Slice** | Modifica | Taglia una mesh con un piano (origine e normale) e, se richiesto, chiude il taglio. |
| **Burn** | Output | Consegna la mesh finale nella cartella cloud dell'utente. |

### Parametri da conoscere

- **Pulisci mesh:** larghezza della fascia di bordo (in anelli), iterazioni di levigatura, dimensione massima dei fori, e un'opzione per patch adattate alla curvatura (più lenta, circa 18 s).
- **Rileva arco:** offset in altezza della curva (0–15 mm), levigatezza, estensione delle estremità e la forma d'arcata di riferimento — automatica, oppure una delle famiglie standard (Europa, TrueForm, standard, Bioform 1–5).
- **Model generator:** profondità della base (5–50 mm), margine (0–5 mm), spessore della parete (2–4 mm).
- **Slice:** origine e normale del piano, chiusura del taglio sì o no.

### Dove calcola ciascun nodo

- **Sul server** (Trasforma, Copia trasformazione, Pulisci mesh, Rileva arco, Model generator, Slice, e Separa topologia quando taglia lungo una curva): il worker calcola il nodo a ogni modifica del grafo.
- **Nel browser, poi salvato sul server** (Scolpisci, Cancella topologia, Separa topologia per selezione, Disegna curva, Modifica curva; Ricostruisci topologia per la selezione): l'utente lavora in modo interattivo e, quando esce dalla modalità, il risultato viene caricato come *snapshot* di quel nodo. Da lì in poi il server usa lo snapshot, e i nodi a valle vengono ricalcolati come sempre.
- **Burn** non usa i worker: l'applicazione web copia direttamente il file calcolato.

I nodi costosi (Pulisci mesh, Model generator) tengono in cache il proprio risultato, così un nodo che non è cambiato non viene ricalcolato.

---

## Lavorare nell'editor

### Scultura

Pennelli: **Inflate** e **Crease** (ciascuno con verso + e −), **Smooth**, **Flatten**, **Simplify**. Caduta (*falloff*): morbida, netta o cilindrica. Slider di raggio e forza, un tratto **lazy** con un raggio proprio, e la **topologia dinamica**: sotto il pennello la mesh viene raffinata o semplificata, con un livello di dettaglio regolabile e un comando *Flood* che lo applica a tutta la mesh. Un materiale tipo creta rende la superficie leggibile mentre si scolpisce.

### Selezione

Tre modalità: **cerchio** (una sfera 3D, dipinta in modo continuo), **box** e **lazo**. Le selezioni si sommano: Shift aggiunge, Ctrl/⌘ toglie. L'interruttore **Attraverso** (raggi X) include le facce sul retro. Una selezione serve a cancellare facce, a dividere una mesh in due o a ricostruire una regione.

### Curve

Le curve si disegnano sulla superficie (*Disegna curva*), si rilevano automaticamente (*Rileva arco*) e si rifiniscono (*Modifica curva*). Oggi guidano il taglio geodetico di *Separa topologia*, che richiede una curva chiusa.

### Preset

Una selezione di nodi si può salvare come **preset** e riusare in altri progetti. I preset privati stanno nella cartella cloud dell'utente; i preset pubblici formano un insieme condiviso da tutti gli utenti, e solo gli amministratori possono pubblicarli o cancellarli.

### Import ed export

- **Import:** solo file STL, fino a 20 alla volta, scelti dalle cartelle cloud dell'utente. Un file importato non sovrascrive mai una mesh esistente: se il nome coincide, viene rinominato.
- **Export:** con il nodo *Burn*, in STL, OBJ o PLY. L'export OBJ ha un tetto al numero di triangoli, calcolato dai limiti di memoria e di tempo di PHP; STL e PLY non ne hanno.

### Pannelli e viewport

- **Grafo** (DAG) con la palette dei nodi, con ricerca e raggruppata per categoria.
- **Outliner** delle mesh della scena: visibilità, rinomina, isolamento.
- **Ispettore:** proprietà della mesh selezionata, ombreggiatura (piatta, smussata, orientamento), la catena dei nodi che agiscono su di lei, con un interruttore di **bypass** su ciascun nodo, e i controlli dedicati del nodo selezionato.
- **Viewport:** inquadra tutto, quattro viste predefinite (dall'alto, frontale, laterale, ¾), un **box di sezione**, viste salvate (memorizzate con il progetto), griglia, assi, colori originali della scansione sì o no, tema chiaro e scuro.
- **Annulla e ripeti** sul grafo.

### Scorciatoie da tastiera

| Tasti | Azione |
|---|---|
| ⌘/Ctrl + S | Salva |
| ⌘/Ctrl + Z | Annulla |
| ⇧⌘Z, ⌘/Ctrl + Y | Ripeti |
| ⌘/Ctrl + C / V | Copia / incolla nodi |
| M | Bypass del nodo selezionato |
| Canc / Backspace | Elimina i nodi selezionati |
| I | Isola la mesh selezionata |
| F | Inquadra tutto |
| Alt + B | Box di sezione |

---

## Come si svolge un calcolo

1. **Il browser invia il grafo.** Ordina i nodi in sequenza topologica, scarta quelli che non hanno nulla da calcolare e invia una coda di passi. Ogni passo porta il proprio strumento, la mesh su cui agisce e i parametri, più ciò che il browser conosce già: le matrici di trasformazione, i nomi degli snapshot e delle curve.
2. **L'applicazione web controlla e mette in coda.** Valida ogni passo con regole strette, verifica che l'utente sia il proprietario del progetto e mette il compito in una coda Redis.
3. **Conta solo l'ultima richiesta.** Ogni richiesta ha un identificativo crescente. Un worker scarta un compito più vecchio di uno già calcolato per lo stesso progetto, così una raffica di modifiche produce un solo calcolo e non un arretrato.
4. **Un progetto, un worker alla volta.** Prima di calcolare, un worker prende un blocco sul progetto; i blocchi dei worker che si fermano vengono rilasciati da un controllo periodico.
5. **Una mesh nello stesso processo, più mesh in parallelo.** Con una sola mesh, il worker esegue la coda da sé. Con più mesh diventa coordinatore: divide il lavoro in un sotto-compito per mesh su una coda prioritaria, che gli altri worker prendono in carico, e inoltra ogni risultato appena è pronto.
6. **Il risultato arriva tutto insieme.** Le mesh calcolate vengono compresse con Draco e sostituite nell'anteprima in un solo passaggio, così il browser non vede mai un risultato scritto a metà. Se un nodo fallisce, resta l'anteprima precedente.
7. **Il browser attende con il long polling** e carica ogni mesh appena arriva. Le richieste respinte per eccesso (HTTP 429) vengono ripetute con pause crescenti; un calcolo troppo lungo mostra un avviso senza bloccare l'editor.

---

## Progetti, salvataggio e pulizia

### L'archivio `.ibex`

Un progetto è un unico file nella cartella cloud dell'utente (`IBEX/nome.ibex`), cifrato con **AES-256-GCM** e due chiavi separate:

- la **chiave degli archivi** cifra il progetto vero e proprio (mesh, grafo, curve, cache). La conoscono solo i worker;
- la **chiave delle miniature** cifra l'immagine di anteprima e il registro dei burn. La conosce anche l'applicazione web, che così può mostrare le anteprime nell'elenco dei progetti.

Se il container esposto al web venisse compromesso, esporrebbe le miniature, mai i progetti. L'intestazione contiene anche l'identificativo del progetto e un'impronta della sessione salvata, leggibili senza decifrare nulla: è ciò che permette alla pulizia descritta qui sotto di verificare un salvataggio.

### Salvataggio

- L'**autosalvataggio**, ogni 15 secondi, salva la sessione (grafo, parametri, viste) nella copia di lavoro del progetto sul server, solo quando qualcosa è cambiato.
- L'archivio cifrato viene riscritto quando l'utente **esce dal progetto** (salva ed esci, oppure chiusura della scheda) e quando lo **rinomina**. Una scrittura fallita non sostituisce mai l'archivio precedente.
- **Chiudi senza salvare** scarta la copia di lavoro e lascia intatto l'archivio.
- All'apertura, un progetto non in uso viene prima estratto dall'archivio (compare una pagina di caricamento); un progetto già aperto altrove si apre subito.

### Pulizia dei dati clinici

Mentre un progetto è aperto, sul server ne esiste una copia di lavoro decifrata. Un processo di pulizia la cancella solo quando è **certo** che tutto sia salvato:

- l'impronta della copia di lavoro deve coincidere con quella registrata nell'intestazione dell'archivio;
- per quel progetto non deve esserci nessun compito in coda;
- il progetto deve essere fermo da 15 minuti.

Vengono cancellate anche le copie di lavoro dei progetti eliminati dal cloud. I file temporanei rimasti vengono rimossi dopo un'ora.

---

## Architettura

```
browser — editor (Drawflow + three.js), di solito dentro un iframe di Nextcloud
   │  HTTPS
   ▼
ibex-app — nginx + PHP-FPM, front controller PHP semplice (senza framework)
   │  code dei compiti
   ▼
ibex-redis — code, sessioni, registro dei progetti, token dei file (non persistente)
   │
   ▼
ibex-worker × 6 — Blender 4.5 headless + librerie geometriche Python
```

| Componente | Ruolo | Codice |
|---|---|---|
| Editor | Grafo, viewport, scultura, selezione, curve | `www/Views/projects/editor/`, `www/js/ibex/modules/`, `www/js/ibex/sculptgl/` |
| Applicazione web | API, validazione, autenticazione, burn | `www/index.php`, `www/Http/`, `www/Core/` |
| Worker | Calcolo del grafo, archivi, import | `worker/worker.py`, `worker/modules/` |
| Logica dei nodi | Un modulo Python per strumento, più una libreria geometrica | `assets/logic_py/`, `assets/logic_py/ibex_primitives/` |
| Definizione dei nodi | Porte e parametri; la palette | `assets/logic_gn/gn_meta.json`, `assets/tools_catalog.csv` |

- I worker girano **dentro Blender** in modalità headless, quindi ogni modulo può usare `bpy` e `bmesh`, insieme a trimesh, PyMeshLab, Open3D, Shapely, SciPy e scikit-image.
- **Redis di proposito non è persistente:** lo stato autorevole sta negli archivi.
- **Dati:** la copia di lavoro decifrata (`active/<utente>/<progetto>/`) sul server; gli archivi cifrati nella cartella cloud di ciascun utente.
- **Database:** IBEX non ha tabelle proprie. Legge e scrive solo quattro tabelle di Nextcloud (`oc_filecache`, `oc_storages`, `oc_mimetypes`, `oc_group_user`).

---

## Sicurezza

- **Accesso.** Gli utenti arrivano da Nextcloud con un token firmato in ES256, verificato con una chiave pubblica configurata. Senza la chiave nessuno può accedere. Lo scaricamento delle mesh usa un token di file di breve durata (un'ora).
- **Configurazione chiusa per default.** Se l'indirizzo di Nextcloud non è impostato, IBEX non invia header CORS, può essere incorniciato solo da sé stesso, non invia messaggi ad altre pagine e non ne accetta.
- **Richieste da altri siti.** Ogni azione che cambia lo stato richiede che la richiesta provenga dall'origine di IBEX stessa.
- **Messaggi tra pagine.** L'editor comunica con la pagina Nextcloud che lo incornicia solo con l'origine configurata, in entrambe le direzioni.
- **Validazione rigorosa degli input:** nomi degli strumenti, delle mesh, dei nodi, dei progetti e file caricati (tipo e dimensione massima).
- **Cifratura a riposo** con due chiavi separate (vedi sopra).
- **Worker senza privilegi:** utente non root, nessuna capability Linux, `no-new-privileges`, un limite di memoria per ciascun worker.
- **Un endpoint di stato** che controlla database e Redis senza credenziali, con un proprio limite di richieste.

---

## Installazione

> IBEX non è un'applicazione autonoma: richiede un'istanza Nextcloud e un'app Nextcloud — la lobby dei progetti, `ibex_workspace` — che **non è inclusa in questa pubblicazione**. Questa pubblicazione è pensata prima di tutto per essere **letta e studiata**; per farla funzionare da capo a fondo bisogna ricostruire quell'ambiente.

### Requisiti

- Docker con Docker Compose.
- Nextcloud con l'app **External Sites**, che apre IBEX e firma il token con cui arrivano gli utenti.
- Un gruppo Nextcloud chiamato **`Amministrazione`**: i suoi membri (e l'utente `admin`) possono pubblicare i preset condivisi. Il nome oggi è fisso nel codice (`www/Core/UserContext.php`).

### Passi

```bash
cp .env.example .env          # da compilare: vedi i commenti nel file
openssl rand -base64 32       # due volte: IBEX_ARCHIVE_KEY e IBEX_THUMB_KEY
docker compose build ibex-worker-1
docker compose up -d
```

- **Due chiavi di cifratura**, ciascuna di 32 byte casuali in base64. Se perdi `IBEX_ARCHIVE_KEY`, gli archivi esistenti non si aprono più.
- **`NEXTCLOUD_URL`** è l'indirizzo dell'istanza Nextcloud che incornicia IBEX.
- **`NEXTCLOUD_SSO_PUBKEY_B64`** è la chiave pubblica dell'app *External Sites*, in formato PEM codificato in base64 su una riga (`base64 -w0 chiave.pem`). Se resta vuota, nessuno può accedere.
- **`IBEX_REDIS_PASS` è obbligatoria**: senza, Redis non parte.
- **Come raggiungere l'app.** `ibex-app` non pubblica porte. Collegala alla rete del tuo reverse proxy, oppure aggiungi una porta (vedi i commenti in fondo a `docker-compose.yml`).
- **Utente del database.** Gli bastano i permessi sulle quattro tabelle di Nextcloud elencate sopra.

---

## Usarlo senza Nextcloud

Il grafo, il bake, i worker e il formato degli archivi non dipendono da Nextcloud. Il legame è concentrato in cinque punti.

1. **Accesso.** `www/Http/Middleware/NextcloudAuthBridge.php` accetta solo il token firmato di *External Sites*. Può sostituirlo qualsiasi provider di identità che emetta un token ES256 con l'utente in `userdata.uid`, oppure un altro metodo di autenticazione.
2. **Ruolo di amministratore.** `www/Core/UserContext.php` legge la tabella dei gruppi di Nextcloud. Decide solo chi può pubblicare i preset condivisi.
3. **File.** Archivi, mesh consegnate e preset privati vengono scritti direttamente nella cartella dell'utente dentro la directory dati di Nextcloud, e registrati **a mano** nella cache dei file di Nextcloud (`oc_filecache`). È il legame più profondo, perché dipende dallo schema interno di Nextcloud. Senza Nextcloud, questo livello va sostituito con un'archiviazione propria.
4. **Lobby dei progetti.** L'elenco dei progetti, la creazione di un progetto, le schede e i menu intorno all'editor stanno nell'app Nextcloud `ibex_workspace`, che non è inclusa. Senza di lei va scritta una lobby; le API che usa sono elencate più sotto.
5. **Incorporamento.** L'editor è pensato per girare in un iframe: la regola CSP `frame-ancestors` e un piccolo protocollo di messaggi con la pagina che lo ospita (chiudi scheda, apri il selettore dei file, progetto rinominato, stato dell'editor, comandi). Per l'uso fuori dalla cornice, l'editor ha anche una propria barra dei menu.

Questo adattamento **non** è stato fatto né provato in questa pubblicazione.

---

## Estendere IBEX: creare nuovi strumenti

Ogni nodo è uno strumento, e aggiungerne uno non richiede di toccare il cuore del bake. Un tipico strumento calcolato sul server è fatto di:

- un modulo Python in `assets/logic_py/` con un'unica funzione, `apply(src_path, params, output_path, logger)`;
- un breve handler nel worker, registrato in due elenchi;
- una voce in `assets/logic_gn/gn_meta.json` (porte e parametri) e una riga in `assets/tools_catalog.csv` (palette).

Il pannello dei parametri viene generato automaticamente dalla definizione del nodo.

**→ La guida completa, con i contratti, i modelli e le trappole, è in [`docs/creating-tools.it.md`](docs/creating-tools.it.md).**

---

## API HTTP

Tutte le azioni passano da `www/index.php?action=…` e richiedono l'autenticazione (una sessione aperta, un token di file oppure il token firmato da Nextcloud). Le azioni che cambiano lo stato richiedono inoltre che la richiesta provenga dall'origine di IBEX stessa.

| Azione | Scopo |
|---|---|
| `editor` | Apre l'editor (`id` oppure `open_name`) |
| `create_empty_project` | Crea un nuovo progetto vuoto (solo POST) |
| `rename_project` | Rinomina un progetto (e lo salva) |
| `fast_transform`, `preview_bake` | Mettono in coda un calcolo |
| `check_preview` | Attende il risultato (long polling) |
| `serve_file` | Serve le mesh e i file del progetto |
| `save_snapshot`, `save_split` | Caricano il risultato di un nodo calcolato nel browser |
| `save_session` | Salva la sessione nella copia di lavoro |
| `save_exit` | Salva l'archivio ed esce |
| `exit_project` | Esce senza salvare |
| `heartbeat`, `check_status`, `projects_status` | Presenza e stato dei progetti |
| `list_nextcloud_dirs`, `import_files` | Sfogliano le cartelle cloud, importano file STL |
| `export_node_stl` | Burn: consegna la mesh finale |
| `save_preset`, `list_presets`, `load_preset`, `delete_preset` | Preset |
| `thumb` | Miniatura di un progetto |
| `get_gn_meta` | Definizioni dei nodi |
| `bake_project` | Calcolo completo in una cartella a parte (non raggiungibile dall'interfaccia) |

`/health.php` è fuori dal router: è pubblico e ha un limite di richieste.

---

## Limiti noti

- **Software sperimentale.** IBEX era in preparazione per una beta chiusa e non è mai stato usato nella produzione clinica.
- **Nessuna verifica da capo a fondo.** Non c'è una suite di test automatici: l'unico test è `worker/scripts/_test_ibx2_passob.py`, sul formato degli archivi. Il modello di salvataggio è stato riprogettato più volte durante lo sviluppo e non ha una verifica completa di riferimento.
- **Il calcolo geometrico non è stato rieseguito per questa pubblicazione.** I worker richiedono Blender e l'intero ambiente; la pubblicazione è stata verificata su tutto ciò che si può eseguire senza di loro (vedi sotto).
- **Legame con lo schema interno di Nextcloud** (`oc_filecache`): una versione diversa di Nextcloud può richiedere modifiche.
- **La lobby non è inclusa** (vedi [Installazione](#installazione)). Alcune scorciatoie mostrate nei menu (⌘B, ⌘N, ⌘/) sono gestite dalla lobby, non dall'editor; alcune voci di menu (Documentazione, Scorciatoie, Info) sono disattivate.
- **Valori predefiniti incoerenti**, lasciati come erano:
  - *Model generator*: l'interfaccia parte con uno spessore di parete di 2,5 mm, mentre il modulo Python usa 0 se il valore manca;
  - *Scolpisci*: il raggio predefinito del pennello (2,0) supera il massimo dello slider (1,5), e il pennello predefinito nel codice non è tra i pulsanti;
  - *Rileva arco*: tre parametri letti dal modulo Python non hanno un controllo nell'interfaccia.
- **Gruppo degli amministratori fisso nel codice** (`Amministrazione`).
- **Codice e dipendenze inutilizzati:**
  - esiste un'infrastruttura per strumenti basati su script di Blender («Tier 2»), ma nessuno strumento la usa;
  - un set di icone (`www/js/ibex/ibex-icons.js`) non è caricato da nessuna pagina;
  - `libigl`, `manifold3d` e `rtree` sono installate nell'immagine del worker ma non vengono importate; restano perché non è stato possibile rieseguire il calcolo per confermarlo.
- **Texture matcap esterna.** Il materiale della scultura carica una texture da un repository di terzi che non dichiara una licenza; se non è raggiungibile, IBEX ne usa una procedurale.
- **Rimandi interni nei commenti.** Molti commenti citano invarianti numerate (*Inv. N*, *§N*) di un documento di progetto non pubblicato.
- **Italiano.** L'interfaccia e i commenti sono in italiano.

---

## Come è stata preparata questa pubblicazione

Prima della pubblicazione il codice ha seguito la stessa revisione strutturata del progetto gemello, [Order Manager](https://github.com/ianlor93/dental-order-manager):

- sono stati tolti l'identità dell'installazione originale, i nomi degli host, i dati personali, le chiavi scritte nel codice e i percorsi dell'infrastruttura, e ogni valore legato all'installazione è passato in configurazione;
- sono stati tolti il codice morto e i documenti interni; le dipendenze sono fissate alle versioni che giravano in produzione;
- un messaggio che l'editor inviava a *qualsiasi* pagina lo incorniciasse è stato limitato all'origine Nextcloud configurata.

Lo stato finale è stato verificato in container puliti:
- sintassi di ogni file PHP, JavaScript, Python e JSON;
- il livello di configurazione con valori validi, vuoti e malevoli;
- l'accesso con il middleware vero e una coppia di chiavi generata per la prova: accettato con la chiave giusta, rifiutato con una chiave sbagliata, rifiutato quando nessuna chiave è configurata;
- `docker compose config`;
- le dipendenze fissate, confrontate con il worker che girava in produzione.

---

## Autore

Progettato e diretto da **Lorenzo Ianniello**.

Il codice è stato sviluppato con **Claude Code** (Anthropic) sotto la sua direzione. Suoi sono i requisiti, l'architettura, la progettazione della sicurezza e della protezione dei dati, e la verifica del risultato.

---

## Licenza

Distribuito con licenza **GNU Affero General Public License v3.0 o successiva**: vedi [`LICENSE`](LICENSE). Chi fa girare una versione modificata come servizio di rete è tenuto, secondo l'AGPL, a renderne disponibile il codice sorgente ai suoi utenti.

Il materiale di terzi (il porting di SculptGL, la libreria JWT, i font Ubuntu) mantiene la propria licenza, così come le librerie caricate a runtime e le dipendenze del worker: vedi [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
