# Creare un nuovo strumento

[English](creating-tools.md) · **Italiano** · [Torna al README](../README.it.md)

In IBEX ogni nodo del grafo è uno **strumento**. Questa guida spiega come uno strumento passa dalla palette al worker e ritorna, quali contratti deve rispettare e come aggiungerne uno nuovo. Ogni affermazione fa riferimento a file di questo repository.

> I modelli di codice di questa guida sono **ricavati** da strumenti esistenti (soprattutto *Slice*). Seguono i contratti reali, ma non sono stati compilati né eseguiti così come sono scritti qui.

## Indice

1. [Due tipi di strumento](#1-due-tipi-di-strumento)
2. [Il percorso di uno strumento, livello per livello](#2-il-percorso-di-uno-strumento-livello-per-livello)
3. [Definire un nodo: `gn_meta.json`](#3-definire-un-nodo-gn_metajson)
4. [Il contratto del worker](#4-il-contratto-del-worker)
5. [Passo per passo: uno strumento calcolato nel worker](#5-passo-per-passo-uno-strumento-calcolato-nel-worker)
6. [Modelli](#6-modelli)
7. [Uno strumento calcolato nel browser](#7-uno-strumento-calcolato-nel-browser)
8. [Facoltativo: ispettore, nodo dedicato, cache](#8-facoltativo-ispettore-nodo-dedicato-cache)
9. [Mettere in funzione la modifica](#9-mettere-in-funzione-la-modifica)
10. [Trappole](#10-trappole)
11. [Diagnosi dei problemi](#11-diagnosi-dei-problemi)

---

## 1. Due tipi di strumento

Tutti gli strumenti di questa pubblicazione girano nel **Tier 1**, il percorso veloce: il worker li esegue **nello stesso processo**, come codice Python che gira dentro Blender. Sono quindi disponibili `bpy` e `bmesh`, insieme a trimesh, PyMeshLab, Open3D, Shapely, SciPy e scikit-image.

Sopra il Tier 1 uno strumento si può costruire in due modi.

| Tipo | Dove si calcola il risultato | Esempi |
|---|---|---|
| **Strumento del worker** | Nel worker, a ogni modifica del grafo | Slice, Pulisci mesh, Model generator, Rileva arco |
| **Strumento del browser («destructive»)** | Nel browser, in modo interattivo; il risultato viene caricato come *snapshot*, che il worker usa poi al posto dell'ingresso | Scolpisci, Cancella topologia, Disegna curva, Modifica curva |

Nel codice esiste ancora un terzo livello («Tier 2»: script di Blender generati al momento ed eseguiti in un processo separato), ma nessuno strumento lo usa e il suo registro è vuoto. **Un nuovo strumento va nel Tier 1.**

---

## 2. Il percorso di uno strumento, livello per livello

Da quando l'utente trascina uno strumento dalla palette a quando l'anteprima si aggiorna, lo strumento attraversa questi livelli.

| # | Livello | File | Cosa fa con lo strumento |
|---|---|---|---|
| 1 | **Palette** | `assets/tools_catalog.csv` | Una riga per strumento: compare nella palette, raggruppato per categoria |
| 2 | **Definizione del nodo** | `assets/logic_gn/gn_meta.json` | Porte, parametri, modalità di esecuzione, flag |
| 3 | **Costruzione del nodo** | `www/js/ibex/modules/NodeBuilder.js` | Crea il nodo nel grafo: con il modello generico, o con uno dedicato da `NODE_SPECS` |
| 4 | **Ispettore** | `www/js/ibex/modules/ContextInspector.js`, `inspectors/` | Controlli generici ricavati dai parametri, oppure una sezione dedicata |
| 5 | **Appiattimento del grafo** | `www/js/ibex/modules/ToolExecutor.js` | Trasforma il grafo in una coda ordinata di passi e ci aggiunge ciò che il browser conosce (matrici, snapshot, curve) |
| 6 | **Richiesta di bake** | `www/js/ibex/modules/BakeEngine.js` | Raggruppa le modifiche ravvicinate e invia la coda al server |
| 7 | **Validazione** | `www/Http/Controllers/EditorController.php` (`_validateQueue`) | Controlla ogni passo con regole strette, poi mette il compito nella coda Redis |
| 8 | **Smistamento nel worker** | `worker/worker.py`, `worker/modules/tier1_orchestrator.py` | Sceglie l'handler dello strumento dalla tabella `DISPATCH` |
| 9 | **Handler** | `worker/modules/tier1_handlers.py` | Fa da tramite tra il worker e il modulo di logica dello strumento |
| 10 | **Logica** | `assets/logic_py/<strumento>.py` | La geometria vera e propria |
| 11 | **Risultato** | `worker/worker.py` | STL → anteprima Draco → sostituzione in un solo passaggio → avviso al browser |

Per un nuovo strumento del worker si toccano i livelli **1, 2, 8, 9 e 10**. Gli altri lo riconoscono da soli.

---

## 3. Definire un nodo: `gn_meta.json`

`assets/logic_gn/gn_meta.json` contiene una voce per strumento, sotto il suo slug. Il browser lo scarica una volta (`?action=get_gn_meta`).

```json
"slice": {
  "tech_type": "FAST",
  "inputs": {
    "IN_GEO_Mesh":    { "type": "NodeSocketGeometry", "is_port": true },
    "G1_Origine_VEC": { "type": "vector",   "default": [0, 0, 0], "step": 0.5 },
    "G2_Normale_VEC": { "type": "vector",   "default": [0, 0, 1], "step": 0.1 },
    "G3_Cap":         { "type": "checkbox", "default": true }
  },
  "outputs": { "OUT_GEO_Mesh": { "type": "NodeSocketGeometry", "is_port": true } },
  "display_name": "Slice"
}
```

(La voce reale può avere altri campi; questa è la forma che conta.)

### Campi della voce

| Campo | Significato |
|---|---|
| `tech_type` | **Deve essere `"FAST"`.** È ciò che mette il nodo nel Tier 1. Qualsiasi altro valore lo manda al Tier 2, che è vuoto, e il bake fallisce |
| `inputs` | Porte (`IN_…`, con `"is_port": true`) e parametri (`G<n>_…`) |
| `outputs` | Porte di uscita (`OUT_…`) |
| `display_name` | Titolo del nodo |
| `destructive` | `true` per gli strumenti del browser: il nodo tiene un proprio snapshot |
| `no_backend` | `true` per i nodi che il worker non deve mai vedere (come *Burn*) |
| `description` | Descrizione, facoltativa |

Alcune voci hanno un campo `tier`, ma **non viene letto**: il tier dipende solo da `tech_type`.

### Le porte e i loro tipi

Il tipo di una porta è scritto nel **prefisso del suo nome**. Il browser legge il prefisso per decidere cosa passare al worker, e colora la porta di conseguenza. Non c'è un controllo di compatibilità tra le porte: i collegamenti sono responsabilità dell'utente.

| Prefisso | Tipo | Colore | Cosa riceve il worker |
|---|---|---|---|
| `IN_GEO_` / `OUT_GEO_` | Geometria (`NodeSocketGeometry`) | verde | il nome della mesh |
| `IN_MTX_` / `OUT_MTX_` | Matrice (`NodeSocketMatrix`) | ambra | una matrice 4×4, 16 numeri |
| `IN_CRV_` / `OUT_CRV_` | Curva (`NodeSocketCurve`) | blu | il nome di un file `.crv.json`, in `_curve_input_file_rel` |
| `IN_VEC_` | Vettore | ambra | un vettore |

### I parametri

Il nome di un parametro segue lo schema **`G<n>_<Nome>[_SUFFISSO]`**:

- **`G<n>`** raggruppa i parametri nel pannello (G1, G2, …);
- **`<Nome>`** diventa l'etichetta: il pannello la ricava dalla chiave stessa, togliendo `G<n>_` e il suffisso. Il campo `label` della definizione **non** viene usato dal pannello del nodo;
- **il suffisso** sceglie il controllo.

| Suffisso | Controllo |
|---|---|
| `_POS`, `_ROT`, `_SCL` | vettore (posizione, rotazione in gradi, scala) |
| `_INT`, `_PCT` | numero |
| `_VIS` | interruttore |
| `_COL` | colore |
| `_MAT`, `_MENU` | elenco a scelta |

Il campo `type` accetta `vector`, `slider`, `checkbox`, `color`, `segmented` (con `options`) e `select_obj`. Gli altri campi sono `default`, `min`, `max`, `step`, `hidden` e `readonly`. `min` e `max` li usa l'ispettore; senza, il suo intervallo è ±1000.

**Valore iniziale:** `default`, altrimenti 1 per `_SCL` e 0 per tutto il resto. Il browser invia sempre il valore iniziale al worker. Il modulo Python dovrebbe comunque usare lo stesso valore predefinito, così che i due non siano mai in disaccordo.

---

## 4. Il contratto del worker

### L'handler: `_apply_<strumento>(ctx) -> ToolResult`

Ogni handler riceve un unico `ToolContext` e restituisce un `ToolResult` (entrambi definiti in `worker/modules/fast_transform.py`).

**`ToolContext`**

| Campo | Contenuto |
|---|---|
| `src_path` | percorso dello STL in ingresso, già risolto |
| `params` | i parametri del nodo, più i valori aggiunti dal browser. **In sola lettura:** copialo con `dict(ctx.params)` prima di modificarlo |
| `output_dir` | dove vanno scritte le uscite. È sempre diversa da `active_path` |
| `target` | nome della mesh (per esempio `Upper.stl`) |
| `active_path` | la copia di lavoro del progetto, per i file accessori (curve, selezioni, snapshot) |
| `tool` | lo slug dello strumento |
| `logger` | funzione di log |
| `mesh_cache` | uso interno: **non toccarla** |

L'identificativo del nodo non è un campo del contesto: se serve, si legge da `params['_snapshot_node_id']`.

**`ToolResult(success, outputs)`**

| Risultato | Significato |
|---|---|
| `ToolResult(True, [(target, path, None)])` | successo; `None` dice al chiamante che la topologia è cambiata, e invalida la cache |
| `ToolResult(True, [(target, path, mesh)])` | successo con la mesh in memoria: **solo** per le trasformazioni rigide |
| `ToolResult(True, [])` | il nodo è **inerte** (non c'è niente da fare): la pipeline prosegue |
| `ToolResult(False, [])` | errore: il bake si ferma, e resta l'anteprima precedente |

### Il modulo di logica: `apply(src_path, params, output_path, logger) -> bool`

La geometria sta in `assets/logic_py/<strumento>.py`, che espone un'unica funzione.

- **Riceve:**
  - il percorso dello STL in ingresso;
  - i parametri: le chiavi di `gn_meta.json`, più i valori aggiunti dal browser come `world_matrix`, `_muted` e `_snapshot_node_id`;
  - il percorso d'uscita;
  - la funzione di log.
- **Deve scrivere uno STL binario** in `output_path` e restituire `True`, oppure restituire `False` se fallisce.
- **Segnala gli errori** con `logger("[…] [IBEX-ENGINE ERROR] …")` seguito da `return False`. Le eccezioni le intercetta l'handler.

L'handler carica il modulo **a ogni chiamata** (con `importlib`), quindi le modifiche a `logic_py` valgono dal bake successivo. `assets/logic_py/` è nel percorso di import del worker, così un modulo può usare la libreria geometrica comune: `from ibex_primitives.<modulo> import …`.

Alcuni moduli esistenti hanno una firma diversa, che il loro handler adatta: per esempio `arch_detect` (argomenti per nome), `topology_rebuild.apply(src, sel, out, log)` e `split_topology_via_curves.apply(src, crv, a, b, log)`. Per un nuovo strumento si usa quella standard.

---

## 5. Passo per passo: uno strumento calcolato nel worker

Esempio: uno strumento con slug `mio_tool`, una mesh in ingresso e una in uscita, con i parametri nel pannello generico.

1. **Scrivi la logica** in `assets/logic_py/mio_tool.py` (modello al [§6](#6-modelli)).
2. **Scrivi l'handler** `_apply_mio_tool(ctx)` in `worker/modules/tier1_handlers.py`, sul modello di `_apply_slice`.
3. **Registra lo strumento nel worker:**
   - aggiungi `'mio_tool'` a `TIER1_TOOLS` in `worker/modules/config.py`;
   - importa l'handler e aggiungilo a `DISPATCH` in `worker/modules/tier1_orchestrator.py`.

   I due devono contenere sempre gli stessi strumenti: `set(DISPATCH) == set(TIER1_TOOLS)`.
4. **Definisci il nodo:** una voce `"mio_tool"` in `assets/logic_gn/gn_meta.json`, con `"tech_type": "FAST"`, le porte e i parametri.
5. **Aggiungilo alla palette:** una riga in `assets/tools_catalog.csv`. Il separatore è `;` e le colonne sono `slug;display_name;tech_type;source_file;category;params_json`:

   ```
   mio_tool;Mio Tool;FAST;mio_tool.py;Modifica;{}
   ```

   La categoria raggruppa lo strumento nella palette. `tech_type` e `source_file` vengono solo mostrati nella palette: non decidono dove gira lo strumento.
6. **Riavvia i worker** (vedi il [§9](#9-mettere-in-funzione-la-modifica)).

Non serve cambiare niente in `ToolExecutor`, `BakeEngine` o `EditorController`, purché lo slug contenga solo lettere, cifre, `_` e `-`.

---

## 6. Modelli

### `assets/logic_py/mio_tool.py`

```python
import trimesh

def apply(src_path, params, output_path, logger):
    try:
        mesh = trimesh.load(src_path, force='mesh', process=False)
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] mio_tool: impossibile caricare '{src_path}': {e}")
        return False

    valore = float(params.get('G1_Valore_INT', 1))   # stessa chiave e default di gn_meta.json

    # … elaborazione della mesh …

    try:
        with open(output_path, 'wb') as f:
            f.write(mesh.export(file_type='stl'))     # STL binario
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] mio_tool: export fallito: {e}")
        return False
    return True
```

### Handler in `worker/modules/tier1_handlers.py`

```python
def _apply_mio_tool(ctx):
    out_path = os.path.join(ctx.output_dir, ctx.target)
    try:
        import importlib.util
        from .config import LOGIC_PY_DIR
        spec = importlib.util.spec_from_file_location(
            "ibex_mio_tool", os.path.join(LOGIC_PY_DIR, "mio_tool.py"))
        if spec is None or spec.loader is None:
            ctx.logger(f"[APPLY] [IBEX-ENGINE ERROR] mio_tool.py non caricabile da {LOGIC_PY_DIR}")
            return ToolResult(False, [])
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if not mod.apply(ctx.src_path, ctx.params, out_path, ctx.logger):
            return ToolResult(False, [])
        return ToolResult(True, [(ctx.target, out_path, None)])   # None: topologia cambiata
    except Exception as e:
        ctx.logger(f"[APPLY] [IBEX-ENGINE ERROR] mio_tool fallito: {e}")
        return ToolResult(False, [])
```

### Voce in `assets/logic_gn/gn_meta.json`

```json
"mio_tool": {
  "tech_type": "FAST",
  "inputs": {
    "IN_GEO_Mesh":   { "type": "NodeSocketGeometry", "is_port": true },
    "G1_Valore_INT": { "type": "slider", "min": 0, "max": 10, "step": 1, "default": 1 }
  },
  "outputs": { "OUT_GEO_Mesh": { "type": "NodeSocketGeometry", "is_port": true } },
  "display_name": "Mio Tool"
}
```

---

## 7. Uno strumento calcolato nel browser

Uno strumento del browser permette all'utente di lavorare in modo interattivo — scolpire, selezionare, disegnare — e poi **rende persistente** il risultato sul server. Il worker lo usa così com'è.

Come funzionano quelli esistenti:

1. Il nodo è dichiarato con `"destructive": true` in `gn_meta.json`. Il browser allora aggiunge al passo l'identificativo del nodo (`_snapshot_node_id`).
2. Una modalità del browser (per esempio `CurveMode.js`, `SculptMode.js`, `SelectionMode.js`) fa il lavoro interattivo.
3. Quando l'utente esce dalla modalità, il browser carica il risultato con `POST ?action=save_snapshot`:
   - `stl_blob`: la mesh, obbligatoria;
   - `curve_blob`: una curva, fino a 5 MB, nella forma `{"splines":[{"control_points":[[x,y,z],…],"cyclic":bool}]}`, in coordinate locali della mesh;
   - `selection_blob`: una selezione, fino a 10 MB, nella forma `{"face_indices":[…]}`.

   Uno strumento che produce due mesh usa invece `save_split`.
4. Il worker conserva i file come `<mesh>_snap_<idNodo>.stl` (e `.crv.json`, `.sel.json`).
5. A ogni bake il passo del nodo porta il suo `_snapshot_node_id`. I nodi a valle collegati a una porta curva ricevono il nome del file della curva in `_curve_input_file_rel`.
6. Quando il progetto viene salvato e chiuso, gli snapshot dei nodi che non esistono più vengono cancellati.

Per aggiungerne uno, oltre a quanto descritto al [§5](#5-passo-per-passo-uno-strumento-calcolato-nel-worker):
- imposta `"destructive": true` in `gn_meta.json`;
- aggiungi lo slug a `DESTRUCTIVE_TOOLS` in `worker/modules/config.py` **e** a `DESTRUCTIVE_TOOL_IDS` in `www/js/ibex/modules/StackManager.js`;
- scrivi la modalità del browser che chiama `save_snapshot`.

Se il worker deve solo usare lo snapshot al posto dell'ingresso, non serve un handler dedicato: gli strumenti destructive senza handler proprio passano dal generico `_apply_snapshot`.

---

## 8. Facoltativo: ispettore, nodo dedicato, cache

### Una sezione dedicata nell'ispettore

Per default l'ispettore mostra i controlli ricavati dai parametri, più un interruttore *Bypass*. Per controlli su misura:
- scrivi un modulo `www/js/ibex/modules/inspectors/mio_tool.js` che esporta `{ build, bind }`;
- registralo in `INSPECTORS` e in `BIND_ORDER` in `ContextInspector.js`;
- aggiorna la versione `?v=` dell'import di `ContextInspector` in `IbexCore.js` (vedi il [§9](#9-mettere-in-funzione-la-modifica)).

L'ispettore del rilevamento dell'arcata è un buon esempio di parametri che vivono solo nell'ispettore: chiavi che iniziano con `_`, salvate nei parametri del nodo (`inspectors/archDetect.js`).

### Un modello di nodo dedicato

I nodi con pulsanti o con una disposizione particolare sono definiti nel registro `NODE_SPECS` di `NodeBuilder.js`. La regola scritta sopra il registro: **solo dati, nessuna funzione**.

Uno strumento in `NODE_SPECS` **non** diventa caricabile da un preset in automatico: `addToolFromPreset` ha un elenco esplicito, che va esteso.

### Cache dei risultati

Per uno strumento costoso con **una sola uscita**, aggiungi il suo slug a `CACHEABLE_TOOLS` in `worker/modules/pipeline_cache.py`. Un nodo che non è cambiato viene allora servito dalla cache (`.cache_pipeline/` nella copia di lavoro). Non attivarla mai per strumenti con più di un'uscita.

---

## 9. Mettere in funzione la modifica

- **`assets/logic_py/`** viene ricaricato a ogni chiamata: il bake successivo usa il codice nuovo.
- **`worker/modules/`** (`config.py`, `tier1_handlers.py`, `tier1_orchestrator.py`, …) viene caricato all'avvio del worker. **Riavvia i worker**, per esempio con `docker compose restart ibex-worker-1 … ibex-worker-6`. Nel dubbio, cancella le cartelle `__pycache__/`.
- **`gn_meta.json` e `tools_catalog.csv`** vengono letti all'apertura dell'editor: ricarica la pagina.
- **I moduli JavaScript** sono importati con una stringa di versione fissa (`?v=…`). Se modifichi un modulo, devi cambiare anche la sua `?v=` **nel modulo che lo importa**, risalendo tutta la catena. Altrimenti il browser continua a usare la versione vecchia dalla sua cache. Lo stesso URL va usato ovunque un modulo sia importato: due URL diversi creano due istanze separate dello stesso modulo.

---

## 10. Trappole

1. **Registrazione mancante.** Uno strumento che non è sia in `TIER1_TOOLS` sia in `DISPATCH` fa fallire il bake («tool non Tier 1 nella queue»). È voluto: uno strumento sconosciuto deve fallire in modo evidente, mai essere saltato in silenzio.
2. **Un `tech_type` diverso da `"FAST"`** manda il nodo al Tier 2, che è vuoto: il bake fallisce.
3. **Nomi.** Lo slug di uno strumento può contenere solo lettere, cifre, `_` e `-`. Gli identificativi dei nodi sono validati in tre punti che devono restare allineati: `NODE_ID_RX` in `worker/modules/config.py`, il lato PHP e il browser.
4. **`ctx.params` è in sola lettura.** Copialo prima di modificarlo.
5. **`mesh_cache` appartiene al worker.** Un handler non deve né scriverla né svuotarla. Se la topologia cambia, restituisci `None` come mesh.
6. **Inerte non è un errore.** `ToolResult(True, [])` = niente da fare; `ToolResult(False, [])` = errore. Non inventare un terzo stato.
7. **`world_matrix` arriva a ogni passo del Tier 1**, ma la applicano solo *Trasforma* e *Copia trasformazione*. Non aggiungere uno strumento all'elenco «con matrice» senza applicarla davvero: la mesh si sposterebbe.
8. **Strumenti rinominati.** `_TOOL_RENAME` in `worker/modules/config.py` è l'unica mappa dai nomi vecchi ai nuovi, applicata all'arrivo della coda; il browser ne ha una copia speculare in `_migrateLegacyToolIds` (`StackManager.js`).
9. **`NODE_SPECS` contiene solo dati**, e viene consultato con `Object.hasOwn`, così uno slug come `constructor` non può coincidere con una proprietà predefinita.
10. **Le stringhe di versione** (`?v=`) vanno cambiate nel modulo che importa, altrimenti il browser usa il codice vecchio.
11. **La cache dei risultati** è solo per strumenti con un'unica uscita.
12. **Nuove azioni di scrittura nel router PHP** vanno aggiunte a `$IBEX_CSRF_GATED` in `www/index.php`. Il commento lì lo dice chiaramente: quella lista *è* la sicurezza.
13. **Formato d'uscita:** STL binario, mai ASCII.
14. **Dove scrivere:** l'uscita principale va sempre in `ctx.output_dir`, mai in `active_path`. I file accessori (curve, selezioni, snapshot) stanno in `active_path`.

---

## 11. Diagnosi dei problemi

- **Log dei worker.** Ogni strumento scrive tramite `logger`, e gli errori portano il segnale `[IBEX-ENGINE ERROR]`. Si leggono con `docker logs ibex-worker-N`.
- **Nell'editor**, un passo fallito ferma il bake, mostra l'errore come notifica e lascia l'anteprima precedente.
- **Un nodo che non fa niente** di solito è inerte di proposito (per esempio una separazione senza selezione né curva): i nodi a valle possono allora fallire perché il loro file d'ingresso non esiste.
- **Per provare solo la logica**, chiama `apply()` da una shell Python dentro un container del worker, con uno STL e un dizionario di parametri. Il modulo non dipende da Redis né dal resto del worker.
