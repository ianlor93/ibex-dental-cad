import { NodeBuilder } from './NodeBuilder.js?v=NodeSkin_V5.21-BurnRename_L10.1-FormatSel_L10.4-GodCollapse_29-7-P3H1_30-7';
import { DragEngine } from './DragEngine.js?v=Inspector_V11.3';
import { BakeEngine } from './BakeEngine.js?v=ColorReadyL11_V19.0-BakeSplit_29-7';
// RightClickPan_V3.30 (2026-05-04, schema mouse Blender/Maya):
//   - Tasto SINISTRO  → select / drag nodi (nativo Drawflow, preservato).
//   - Tasto DESTRO    → pan vista (custom handler indipendente da Drawflow,
//     listeners su `window` per drag robusto fuori dal canvas).
//   - Rotellina       → zoom (V3.21 invariato).
//   Block contextmenu sul container DAG. Override `editor.click`: button=0
//   sull'area vuota viene IGNORATO (no pan con sinistro). Il fix CSS
//   `.parent-node { pointer-events: none }` resta — ora aiuta il destro a
//   beccare l'area "vuota" anche sopra wrapper di nodi (semantica simmetrica
//   rispetto a V3.21). Fix nella stessa sessione: NodeBuilder._centerOf
//   VisibleCanvas() risolve il bug "nodi spawn lontano dalla vista" (V5.15).
//
// DagSync_V3.21 (2026-04-30, fix UX canvas Drawflow — pan + wheel-zoom):
//   - Pan-on-empty-area era rotto: cliccando su area "vuota" il target
//     era `.parent-node` (wrapper Drawflow per ciascun nodo), che NON è
//     in nessun `case` dello switch di Drawflow `click()` → fall-through
//     → editor_selected resta false → niente pan. Fix CSS in main.blade
//     rende `.parent-node` trasparente agli eventi (pointer-events:none)
//     e ripristina pointer-events:auto sui figli (`.drawflow-node` ecc.)
//     → click su area vuota arriva alla precanvas, classList[0]
//     === 'drawflow' → editor_selected = true → pan ✓.
//   - Wheel-zoom senza Ctrl. Drawflow `zoom_enter` richiede e.ctrlKey
//     per default. Wrappiamo l'handler dopo editor.start() per ignorare
//     il check + registriamo un nostro wheel listener (passive:false)
//     che lo invoca. Pinch trackpad continua a funzionare.
//
// DagSync_V3.20 (2026-04-26, fix sync widget vector — wrapper div con
//   data-key veniva incluso in slice(0,3) shifftando X/Y/Z → ogni valore
//   digitato in vec3 inspector/nodo veniva resettato a 0):
//   - `_syncWidgetValue` filtra il risultato del querySelectorAll alle
//     sole tag INPUT/SELECT/TEXTAREA. Il wrapper `.ibex-vector-group`
//     porta `data-key` (e talvolta `data-node-id` lato inspector) per
//     consentire il grouping; senza filtro, slice[0]=div, slice[1]=X
//     input → value[1]=0 → X riportato a 0.
//
// DagSync_V3.19 (2026-04-25, getter displayName + sezione proprietà mesh):
//   - `getMeshDisplayName(meshName)` — getter pubblico speculare a
//     `setMeshDisplayName`. Lookup nel grafo Drawflow del primo nodo
//     mesh con `data.meshName === meshName`, ritorna `data.displayName`
//     o fallback stem `.stl`-stripped. Centralizza il lookup duplicato
//     in OutlinerManager._getDisplayName e ContextInspector._buildHtml.
//
// DagSync_V3.18 (2026-04-25, sync DOM bidirezionale params nodo↔inspector):
//   - Setter centralizzato `setNodeParam(nodeId, key, value, options)`.
//     I widget esistono in 2 DOM indipendenti che riflettono lo stesso
//     `node.data.params[key]`: dentro `#node-{id}` (input `[data-key]`) e
//     dentro `#ibex-inspector-panel` (input `[data-node-id][data-key]`).
//     `editor.updateNodeDataFromId` aggiornava il grafo ma non sincronizzava
//     i due DOM. Pre-V3.18: modifica via Inspector → DAG node mostrava
//     valore vecchio; modifica via DAG → Inspector mostrava valore vecchio.
//     Il setter scrive nel grafo + propaga il valore a entrambi i punti
//     DOM via `_syncWidgetValue` (skip dell'`sourceEl` per non interferire
//     col cursor del typing). Per vector: 3 input in ordine DOM = X, Y, Z.
//   - I 4 metodi storici (`updateNodeData`, `updateNodeDataPreviewOnly`,
//     `updateNodeDataById`, `updateNodeDataByIdPreviewOnly`) delegano
//     completamente a `setNodeParam` — mantenuti per compat con i call
//     site nei template HTML inline generati da NodeBuilder + handler
//     onchange di ContextInspector + DragEngine.
//
// DagSync_V3.17 (2026-04-25, post-deploy fix label destructive output-only):
//   - `_refreshDestructiveNodeLabels` ora mostra SOLO l'identità della mesh
//     USCENTE — la mesh entrante è già visibile dalla connessione DAG, lo
//     stem entrante è ridondante. Format:
//       sculpt / delete_topology → `snap_{nodeId}`
//       split_topology           → `snap_{nodeId}_A + _B`
//     Tooltip (`label.title`) mostra il filename completo su disco
//     (`{originalStem}_snap_{nodeId}.stl`) + eventuale displayName se
//     l'utente ha rinominato.
//   - `setMeshDisplayName` chiama anche `_refreshDestructiveNodeLabels()`
//     dopo l'update — così il tooltip dei nodi destructive si riallinea
//     subito al rename senza aspettare un syncAndBake.
//
// DagSync_V3.16 (2026-04-25, centralizzazione setter displayName + hooks):
//   - `setMeshDisplayName(meshName, displayName)` — setter pubblico.
//     Scrive `node.data.displayName` su tutti i nodi mesh con quel
//     `meshName`, persiste via `editor.updateNodeDataFromId`, aggiorna
//     `.title-box` DOM dei nodi DAG, refresha `inspectorPanel` se
//     aperto su quella mesh. OutlinerManager._applyDisplayRename V12.6
//     delega completamente a questo metodo.
//   - `_refreshAllMeshNodeTitles()` — hook post-import. Drawflow `import`
//     ricostruisce nodi mesh dall'HTML raw cotto al primo `addNode`
//     (`cleanInitial` = stem iniziale); il `data.displayName` aggiornato
//     resta in payload ma il DOM mostra il vecchio. Iter nodi mesh, per
//     ognuno se `data.displayName` differisce dal `.title-box.textContent`
//     riapplica il valore corretto. Pattern identico a
//     `_refreshAllSculptNodesDOM`. Chiamato nel setTimeout 200ms post-import
//     dopo `_refreshAllSculptNodesDOM` e prima di `_migrateLegacyToolIds`.
//   - `_onDagNodeSelected(nodeId)` esteso: dopo `sceneMgr.selectMesh`
//     chiama `inspectorPanel.openForMesh(meshName)` simmetricamente al
//     click viewport e al click outliner. Risolve l'asimmetria della
//     cascata di selezione (Invariante 97).
//
// DagSync_V3.15 (2026-04-25, Obiettivo 1):
//   - `_refreshAllNodeTargetLabels` rinominato in `_refreshDestructiveNodeLabels`.
//     Itera SOLO i nodi `toolId ∈ {sculpt, delete_topology, split_topology}` e
//     scrive il nome del file snapshot prodotto:
//       sculpt / delete_topology → `{stem}_snap_{nodeId}`
//       split_topology           → `{stem}_snap_{nodeId}_A + _B`
//     Stem da `data.meta.mesh_name` (popolato post-save snapshot); fallback
//     a `step.target` via `flattenGraphForBackend`. Iniezione difensiva del
//     placeholder `.ibex-node-target-label` se manca (compatibilità con
//     nodi destructive legacy salvati pre-V5.11). Tool generici NON hanno
//     più la label (era ridondante: target = mesh root upstream).
//
// DagSync_V3.14 (2026-04-25, post-deploy fix validazione):
//   - `_validateLastConnection()` aggiunge whitelist `ALLOWED_CROSS`:
//     `GEO → MTX` esplicitamente permessa. Permette al pattern di
//     parenting standard `mesh.OUT_GEO_Mesh → fast_parenting.IN_MTX_Parent`
//     di passare la validazione (l'executor in ToolExecutor.js:511-535
//     sintetizza la matrice dalla worldMat del nodo sorgente
//     indipendentemente dal tipo socket dichiarato). Senza la whitelist,
//     V3.10 rompeva il workflow di parenting introdotto pre-DagSync.
//   - Parallelo: `gn_meta.json` aggiunge `OUT_MTX_Transform` al nodo
//     `fast_transform` come secondo socket output (NodeSocketMatrix).
//     I NUOVI nodi `fast_transform` espongono 2 socket OUT (Drawflow li
//     renderizza dal `numOutputs = outKeys.length` calcolato in
//     `NodeBuilder.addTool`). I nodi pre-esistenti nei session_settings
//     mantengono 1 OUT (Drawflow ricostruisce esattamente lo stato
//     salvato — per upgrade serve cancellare e ricreare il nodo).
//
// DagSync_V3.10 (2026-04-25, sessione 4 obiettivi):
//   Obiettivo 1 — validazione tipi socket post-creazione
//     · `_validateLastConnection()` invocato in `connectionCreated` PRIMA
//       di `syncAndBake`. Estrae le classi `node_out_node-X / output_N /
//       node_in_node-Y / input_M` dall'ultimo SVG.connection, risolve i
//       nomi via `data.outPorts/inPorts` (mesh node → 'OUT_GEO_Mesh'
//       hardcoded), confronta il SECONDO segmento (`split('_')[1]`).
//       Se incompatibili → `removeSingleConnection()` + `uiMgr.notify`
//       warning. Caller ritorna early (no syncAndBake spurio).
//   Obiettivo 2a — label target nei nodi tool
//     · `_refreshAllNodeTargetLabels()` itera `flattenGraphForBackend(graph)`
//       e scrive lo `stem` (`step.target` senza `.stl`) in
//       `#node-{id} .ibex-node-target-label`. Sincrono, chiamato a fine
//       `syncAndBake`. NodeBuilder V5.11 ha aggiunto il placeholder span
//       `<span class="ibex-node-target-label">—</span>` sotto il title-box
//       di ogni nodo tool (generico, sculpt, delete_topology, split_topology).
//   Obiettivo 2b — highlight nodi DAG per mesh selezionata
//     · Listener `ibex:selection-changed` registrato nel costruttore →
//       `_highlightNodesForMesh(meshName)`. Rimuove `.ibex-node-mesh-selected`
//       da tutti i `.drawflow-node`, poi applica ai nodi con
//       `step.target === meshName` + nodi mesh con `data.meshName === meshName`.
//   Obiettivo 2c — click nodo DAG seleziona mesh viewport
//     · Handler `editor.on('nodeSelected', ...)` esteso: oltre a
//       `bindDragInputs()` chiama `_onDagNodeSelected(nodeId)`. Per
//       nodi mesh legge `data.meshName`; per tool risolve via
//       `flattenGraphForBackend`. Chiama `sceneMgr.selectMesh(meshName)`
//       passando il nome CON `.stl` (matcha `mesh.name` Three.js).
//
// SnapshotKeyed_S3_V3.8 (2026-04-25 post-deploy UX):
//   - `updateSculptNodeMeta` accetta sculpt + delete_topology + split_topology
//     (prima era gated solo a sculpt). Il nome resta per compat con chiamanti.
//   - `_refreshSculptNodeDOM` gestisce 3 label distinti:
//       · sculpt          → "Modificato · N verts"
//       · delete_topology → "Modificato · N facce eliminate"
//       · split_topology  → "Separato · A:Na · B:Nb facce" + popola i 2 nomi
//         output (`{stem}_snap_{nodeId}_A/B`) nei `.ibex-split-out-name`.
//   - `_refreshAllSculptNodesDOM` itera ora tutti e 3 i toolId destructive.
//
// SnapshotKeyed_S3_V3.7 (2026-04-25):
//   - `extractDAG` loop `Object.entries(node.outputs)` ora usa la chiave
//     `outputKey` (es. "output_1", "output_2") per mappare l'output index al
//     relativo `outPorts[idx]` name. Gli edge emessi contengono un nuovo
//     campo `from_port` con il nome del socket sorgente (es. "OUT_GEO_A").
//     Usato da ToolExecutor.resolveBaseMesh S3 per detectare il ramo A/B
//     dei nodi split upstream.
//   - `DESTRUCTIVE_TOOL_IDS` estesa con `'split_topology'`.
//   - Bump import NodeBuilder V5.9 + BakeEngine V17.7.
//
// SnapshotKeyed_S2_V3.6 (2026-04-24):
//   - Bump import NodeBuilder V5.8 (branch delete_topology) + BakeEngine V17.6
//     (rename setSculptSavePending → setSnapshotSavePending).
//   - `_migrateLegacyToolIds` estende `DESTRUCTIVE_TOOL_IDS` con `'delete_topology'`:
//     backfill `data.destructive = true` per nodi delete_topology pre-S2
//     (transitorio — session_settings a questa data non contengono tale nodo,
//     ma la lista è manutenibile).
//
// SnapshotKeyed_S1_V3.5 (2026-04-23):
//   - extractDAG propaga node.data.destructive nel graph node (usato da
//     ToolExecutor.flattenGraphForBackend per iniettare _snapshot_node_id).
//   - Rename hard: getSculptedMeshNames() → getSnapshotNodes() che ritorna
//     [{mesh: "Upper.stl", nodeId: "5"}, ...] invece di ["Upper.stl", ...].
//     Chiamato da IbexCore.saveAndExit, propagato al worker SAVE_EXIT per
//     cleanup file snapshot orfani.
//   - _migrateLegacyToolIds estesa: aggiunge node.data.destructive = true ai
//     nodi sculpt esistenti (session_settings pre-S1 non hanno il campo).
//
// NonDestructive_S5_V3.1 — + sculpt position warning (Fix 2b):
//   · Nuovo metodo `_checkSculptPosition(graph)`: per ogni nodo con
//     `toolId === 'sculpt'`, verifica se esistono edge entranti da altri
//     tool (`from_mesh` inizia con `tool_output_`). Se sì → notify warning
//     una-volta-per-sessione tramite flag `_sculptPositionWarned`.
//     Motivazione: quando sculpt ha tool upstream, il risultato del bake
//     può divergere dalla preview client-side (Tier 1 upstream viene
//     scartato da `_apply_sculpt`; Tier 2 viene applicato DOPO sculpt
//     lato worker via split tier). Chiamato da `syncAndBake` dopo
//     extractDAG. Flag resettato in `loadFromConfig` per nuova sessione.
//
// NonDestructive_S5_V3.0 — reload atomico (2026-04-22):
//   · Rimosso `setTimeout(() => syncAndBake(), 3000)` cieco al fondo di
//     loadFromConfig. Era difesa contro rate-limiter Cloudflare, risolto
//     lato infrastruttura (rimossa rule WAF path-based sull'host di IBEX).
//   · Event handler Drawflow (connectionCreated/Removed, nodeRemoved,
//     nodeSelected) registrati DOPO editor.import() — o DOPO editor.start()
//     se non c'è sessione da importare. Così il bulk import non può triggerare
//     syncAndBake spuri per ogni connessione importata. Invariante 76.
//   · Primo syncAndBake al reload chiamato come ultima istruzione dentro la
//     callback setTimeout(200ms) post-import, dopo updateConnectionNodes +
//     bindDragInputs + _colorAllConnections + _fixAllConnSvgSizes +
//     _markLegacyNodes + _refreshAllSculptNodesDOM + _migrateLegacyToolIds.
//     Grafo completamente caricato prima del bake → un singolo POST worker
//     anziché timer cieco a 3s.
// NonDestructive_S4_V2.1 — fix regressioni post-ristrutturazione:
//   · RIMOSSA pre-pop `_lastBakedParams` in loadFromConfig (v2.0 richiede
//     auto-bake al reload perché master scanner-space + preview/ cancellata)
//   · getSculptedMeshNames: extractDAG fresh + fallback a `node.data.meta.mesh_name`
//     (evita perdita file _sculpted.stl quando nodo sculpt disconnesso)
// PyMeshLab_V3.4 — bump import BakeEngine V17.5 (revertToMaster al remove nodi DAG,
//   Bug 2: "cancello nodo meshcleaner, mesh non torna al master").
// PyMeshLab_V3.3 — meshcleaner Tier 2 → Tier 1 (2026-04-22):
//   · _migrateLegacyToolIds estesa: forza node.data.tier=1 su ogni nodo
//     meshcleaner. Session_settings pre-migrazione hanno tier=2 salvato →
//     senza questa patch BakeEngine route-a preview_bake (cold-start Blender)
//     invece di fast_transform (PyMeshLab in-process).
//   · Nessun altro cambio comportamentale: alias gn_meshcleaner_v2 → meshcleaner
//     resta gestito.
// NonDestructive_S1_V2.0 — rimosso `is_baked` completamente:
//   · extractDAG non popola più `is_baked` sui nodi del grafo
//   · rimosso `_applyNodeStateClasses()` (classe `.ibex-node-baked`)
//   · rimosso filtro `!n.is_baked` da pre-pop `_lastBakedParams`
//   · rimosso filtro `!n.is_baked` da getSculptedMeshNames
//   I master STL in active/ sono immutabili: la pipeline ricalcola sempre tutto.
// SculptV2_S7_V1.11 — _migrateLegacyToolIds (gn_meshcleaner_v2 → meshcleaner).
// V1.10 — escludi `sculpt` da pre-pop `_lastBakedParams` al load.
//   Risolve "reload perde sculpt": `{}` vs `{}` = hasChanges false → bake skippato
//   → `_apply_sculpt` mai invocato → mesh mostrata = master (sculpt invisibile).
// V1.9 (Sessione 5): getSculptedMeshNames() per lazy cleanup al SAVE_EXIT.
// V1.8 (Sessione 4): updateSculptNodeMeta + refresh DOM strip/label.
// V1.7 (Sessione 2): nodo sculpt con meta preserved in extractDAG.
// V1.6 (Sessione 1): delta_sculpting rimosso; legacy node detection + bake block.
// (Storico: Bug8Fix_V1.5 — fix SVG connection sizing in flex-column layouts.)

export class StackManager {
    constructor(executor, outliner) {
        this.executor = executor;
        this.outliner = outliner;
        this.editor = null;
        this.gnManifest = null;
        this.graph = { nodes: [], edges: [] };
        // Fix 2b (Invariante 77b): warning "sculpt ha tool upstream" mostrato
        // una sola volta per sessione editor. Reset in loadFromConfig.
        this._sculptPositionWarned = false;
        // Preset DAG (2026-05-05) — multi-select via marquee. Set di nodeId stringa.
        this.multiSelectedSet = new Set();
        // Suspend bake durante spawnPreset (evita N+1 syncAndBake su connectionCreated)
        this._suspendPresetBake = false;

        // UX-A Undo/Redo (snapshot-based via editor.export()/import()).
        this._undoStack = [];
        this._undoCursor = -1;
        this._undoRestoring = false;   // re-entrancy guard durante import()
        this._undoSeeded = false;      // push attivi solo dopo seedUndoBaseline()
        this._UNDO_CAP = 50;

        this.nodeBuilder = new NodeBuilder(this);
        this.dragEngine = new DragEngine(this);
        this.bakeEngine = new BakeEngine(this);

        // V3.12 (Obiettivo 2b) — listener globale `ibex:selection-changed`
        // dispatched da SceneManager.selectMesh/deselectMesh. Aggiorna
        // `.ibex-node-mesh-selected` sui nodi DAG correlati alla mesh.
        window.addEventListener('ibex:selection-changed', (e) => {
            this._highlightNodesForMesh(e.detail?.meshName || null);
        });
    }

    async fetchManifest() {
        if (!this.gnManifest) {
            try {
                const res = await fetch(`/?action=get_gn_meta&_t=${Date.now()}`);
                this.gnManifest = res.ok ? await res.json() : {};
            } catch (e) { this.gnManifest = {}; }
        }
        
        return this.gnManifest;
    }

    async loadFromConfig(settings) {
        // Reset flag warning sculpt-position per la nuova sessione editor.
        // Se l'utente lascia un DAG con sculpt dopo tool upstream, il warning
        // riapparirà al primo syncAndBake anche se era stato già visto nella
        // sessione precedente (intenzionale: il problema resta, ricorda).
        this._sculptPositionWarned = false;

        await this.fetchManifest();
        const container = document.getElementById('drawflow');
        if (!container) return;

        this.editor = new Drawflow(container);
        this.editor.reroute = true;
        this.editor.reroute_fix_curvature = true;
        this.editor.start();

        // T2Split 2026-07-29 -> this._installWheelZoom(container) (ex righe 314-337)
        this._installWheelZoom(container);

        // T2Split 2026-07-29 -> this._installCanvasMouse(container) (ex righe 339-557)
        this._installCanvasMouse(container);

        // T2Split 2026-07-29 -> this._installKeyboardShortcuts() (ex righe 559-642)
        this._installKeyboardShortcuts();

        // T2Split 2026-07-29 -> this._installConnectionEditing(container) (ex righe 644-773)
        this._installConnectionEditing(container);

        // UX-A batch2 — input di ricerca nodi (idempotente, una volta).
        this._initNodeSearchBox();

        // Helper per registrare gli event handler Drawflow. DEVE essere chiamato
        // DOPO editor.import() (se c'è sessione da importare) o DOPO editor.start()
        // (se non c'è sessione) — mai prima dell'import, altrimenti il bulk load
        // può triggerare syncAndBake per ogni connessione importata. Invariante 76.
        const _registerDrawflowHandlers = () => {
            // T2Split 2026-07-29 -> _installDrawflowEvents (ex righe 783-842)
            this._installDrawflowEvents();
        };

        if (settings && settings.ui_graph && settings.ui_graph.drawflow) {
            try {
                // PhpJsonFix V3.65 (2026-07-10): PHP round-trip {} → [] (array
                // vuoto). Se Home.data arriva come Array, Drawflow lo importa
                // come array → addNode scrive per indice creando buchi →
                // export() li serializza come null → extractDAG crash su
                // OGNI interazione (cavi inclusi). Normalizza a Object
                // scartando le voci nulle — stessa malattia della BLINDATURA
                // PARAMS (extractDAG), qui sul contenitore dei nodi. Guarisce
                // anche i manifest già persistiti corrotti, senza toccarli.
                const _home = settings.ui_graph?.drawflow?.Home;
                if (_home && Array.isArray(_home.data)) {
                    const _obj = {};
                    _home.data.forEach((v, i) => { if (v) _obj[v.id != null ? v.id : i] = v; });
                    _home.data = _obj;
                }
                this.editor.import(settings.ui_graph);
                // Invariante 76: handler registrati DOPO import bulk.
                _registerDrawflowHandlers();
                // Post-import cleanup + primo syncAndBake UNICO.
                //
                // Drawflow calcola le posizioni dei connector prima che il CSS
                // sia completamente applicato → le linee appaiono disallineate.
                // Il setTimeout 200ms lascia al browser il tempo di risolvere
                // il layout, poi esegue tutti i cleanup post-import, e SOLO alla
                // fine lancia il primo syncAndBake (un singolo POST al worker).
                setTimeout(() => {
                    try {
                        const data = this.editor.export().drawflow.Home.data;
                        Object.keys(data).forEach(id => {
                            this.editor.updateConnectionNodes('node-' + id);
                        });
                    } catch (e) { /* non critico */ }
                    this.dragEngine.bindDragInputs();
                    // D2 DarkRedesign: colora connessioni dopo import
                    this._colorAllConnections();
                    // Bug #8 fix: size-correct tutti gli SVG connection dopo import.
                    this._fixAllConnSvgSizes();
                    // Sculpt V2 Sessione 1: marca nodi delta_sculpting legacy + blocca bake.
                    const legacy = this._markLegacyNodes();
                    if (legacy.length > 0 && window.ibex?.uiMgr) {
                        window.ibex.uiMgr.notify(
                            `${legacy.length} nodo/i obsoleto/i nel grafo (delta_sculpting) — eliminali per continuare.`,
                            'error'
                        );
                    }
                    // Sculpt V2 Sessione 4: refresh DOM dei nodi sculpt con meta persistito
                    // (strip verde + label "Modificato · N verts" se sculpted=true).
                    this._refreshAllSculptNodesDOM();
                    // V3.16 (2026-04-25): re-applica `data.displayName` al
                    // `.title-box` DOM dei nodi mesh dopo l'import. Drawflow
                    // import ricostruisce dall'HTML raw cotto al primo addNode
                    // (= stem iniziale) — il displayName aggiornato vive in
                    // node.data ma il DOM mostra il vecchio finché non
                    // riapplichiamo. Pattern identico a _refreshAllSculptNodesDOM.
                    this._refreshAllMeshNodeTitles();
                    // V14.0 (2026-05-13) — riapplica `data.toolName` al `.title-box`
                    // DOM dei tool nodes. Necessario per propagare rename legacy
                    // (es. "Rileva Arcata" → "Rileva Arco" via _migrateLegacyToolIds).
                    this._refreshAllToolNodeTitles();
                    // ExportNodeSTL (2026-05-03) — fix "valori reset alla riapertura":
                    // Drawflow import re-renderizza il DOM dal template HTML originale
                    // (cotto al primo addNode con `value="${defaultValue}"`). Modifiche
                    // successive aggiornano `node.data.params` ma il template salvato
                    // mantiene i valori iniziali → al reload gli input mostrano default.
                    // Helper generico itera tutti i tool node + applica `data.params[K]`
                    // ai widget `[data-key=K]`. Risolve TUTTI i tool, non solo export.
                    this._refreshAllToolWidgetsDOM();
                    // Refresh widget custom dei nodi export (button label, status)
                    // che non seguono il pattern `[data-key]` standard.
                    this._refreshAllExportNodesDOM();
                    // NodeMute (2026-05-05) — riapplica classe `.ibex-node-muted`
                    // ai nodi con `data.muted=true` (persistito in session_settings.
                    // ui_graph). Drawflow import ricrea il DOM dal template HTML
                    // raw — la classe muted vive nel data, va re-injected nel DOM.
                    this._refreshAllMutedClasses();
                    // V3.43 SocketRecolor (2026-05-05) — Drawflow `import()` ricrea
                    // il DOM dei socket SENZA chiamare `_colorDrawflowPorts` (che
                    // applica `borderColor` inline via JS al momento di `addNode`).
                    // Conseguenza: al reload tutti i socket appaiono grigi default
                    // invece dei colori per tipo (verde GEO / ambra MTX). Helper
                    // re-itera ogni nodo e ricolora dai metadata salvati in
                    // `node.data.inPorts/outPorts/panelId`.
                    this._recolorAllSockets();
                    // Migrazione in-place 2026-04-22: tool rinominato `gn_meshcleaner_v2`
                    // → `meshcleaner`. Session_settings pre-rinomina hanno ancora il
                    // vecchio toolId. Rimappiamo in-place: al prossimo save_exit il DB
                    // viene aggiornato. L'alias backward-compat nel worker copre comunque
                    // i task in coda ma evitiamo di trascinarselo all'infinito.
                    this._migrateLegacyToolIds();
                    // L10.1 (2026-07-25) — trappola d'ordine: _refreshAllToolNodeTitles()
                    // sopra (a monte) gira PRIMA di _migrateLegacyToolIds() → dopo la
                    // migrazione i `.title-box` restano stale (i dati dicono «Burn» ma il
                    // DOM «Esporta STL»). updateNodeDataFromId aggiorna solo i data, non il
                    // `.title-box`. Rifaccio il sync titoli DOPO la migrazione: idempotente
                    // (rilegge node.data.toolName e riscrive il testo). Copre anche i rename
                    // legacy (es. «Rileva Arcata» → «Rileva Arco»), fino a ora anch'essi stale.
                    this._refreshAllToolNodeTitles();
                    // FastReload (2026-05-02) — pre-popolo lo stato di bake
                    // PRIMA del primo syncAndBake. Se session_settings.last_bake
                    // è presente (saveAndExit precedente l'ha salvato + worker
                    // SAVE_EXIT ha incluso preview/ nel .ibex), BakeEngine
                    // sa già quali params/nodes/targets erano nell'ultimo bake
                    // e `hasChanges` ritornerà false al primo syncAndBake →
                    // niente POST al worker → preview/ già caricata da
                    // MeshLoader resta visibile senza ricalcolo.
                    // Fallback automatico: se last_bake è assente (legacy /
                    // fresh project), restoreLastBakeSnapshot è no-op e il
                    // primo syncAndBake fa bake completo come prima.
                    if (settings?.last_bake && this.bakeEngine?.restoreLastBakeSnapshot) {
                        this.bakeEngine.restoreLastBakeSnapshot(settings.last_bake);
                        const n = Object.keys(settings.last_bake.params || {}).length;
                        console.log(`[FastReload] _lastBakedParams pre-popolato per ${n} nodi`);
                    }
                    // L3-boot (2026-07-23) — le righe dell'outliner sono costruite da
                    // IbexCore PRIMA di questo import (`loadAssets` :290/292/296 vs :294):
                    // a grafo vuoto `getMeshDisplayName` cade sullo stem del filename, e
                    // nessuno le rilegge più. Con FastReload valido il syncAndBake qui
                    // sotto non fa partire alcun bake (`hasChanges` falso) → niente
                    // refresh post-bake → riga stale col nome grezzo. Qui il grafo C'È:
                    // un update rilegge i displayName. Gemello del refresh nel percorso
                    // di restore (`_applyPostImportRefresh`).
                    try { window.ibex?.outlinerMgr?.update?.(); } catch (e) {}
                    // Fix 1c (Invariante 76): primo syncAndBake UNICO, come ultima
                    // istruzione dopo tutti i cleanup post-import. A questo punto il
                    // grafo è completamente caricato → un singolo POST al worker
                    // anziché N trigger spuri o timer cieco a 3s.
                    this.syncAndBake();
                    // UX-A — baseline undo dopo il caricamento completo del grafo.
                    this.seedUndoBaseline();
                }, 200);
            } catch (e) {
                console.error('[StackManager] editor.import() fallito, avvio con editor vuoto:', e);
                if (window.ibex && window.ibex.uiMgr) {
                    window.ibex.uiMgr.notify('Sessione corrotta: editor azzerato.', 'error');
                }
                // Ramo catch: import fallito → editor vuoto. Registra comunque gli
                // handler: l'utente può aggiungere nodi a mano.
                _registerDrawflowHandlers();
                this.seedUndoBaseline();
            }
        } else {
            // Nessuna sessione da importare (progetto nuovo o session_settings vuote):
            // registra gli handler subito dopo editor.start(). L'editor è vuoto, non
            // c'è bake iniziale da lanciare.
            _registerDrawflowHandlers();
            this.seedUndoBaseline();
        }
    }

    // ─────────────────────────────────────────────────────────────
    // T2Split 2026-07-29 — estratto VERBATIM da loadFromConfig() (righe 314-337
    // del file pre-refactor, md5 2721d600b2416c38fc789a7fbd551424).
    // Il corpo e' BYTE-IDENTICO: il parametro porta lo STESSO nome del locale
    // di partenza, quindi non una riga di handler e' stata riscritta.
    // ─────────────────────────────────────────────────────────────
    _installWheelZoom(container) {
        // 2026-04-30 — Wheel-zoom senza Ctrl. Drawflow `zoom_enter` di
        // default richiede `e.ctrlKey` (rotellina + Ctrl, oppure pinch
        // trackpad che emula ctrlKey su macOS). UX da editor di nodi
        // (Houdini/Blender style): wheel diretto = zoom. Wrappiamo
        // l'handler ignorando il check ctrlKey. Il pinch trackpad
        // continua a funzionare (genera comunque deltaY). Il listener
        // wheel su container è attaccato in editor.start() e fa già
        // bind di zoom_enter via .bind(this) → riassegnare il metodo
        // qui non aggiorna il listener. Soluzione: rimuoviamo il vecchio
        // listener e ne registriamo uno nostro che chiama zoom_in/out
        // direttamente.
        this.editor.zoom_enter = (e) => {
            e.preventDefault();
            if (e.deltaY > 0) this.editor.zoom_out();
            else this.editor.zoom_in();
        };
        // Re-bind del listener wheel: il listener originale era
        // `zoom_enter.bind(this)` quindi punta al metodo bound al momento
        // di start(). Per sostituirlo dobbiamo aggiungere un nuovo
        // listener che chiami il nuovo zoom_enter (this.editor.zoom_enter
        // ora è il nostro override). Il vecchio listener resta ma fa
        // ancora il check ctrlKey — non interferisce, semplicemente
        // a vuoto sui wheel senza Ctrl. Il nostro fa il lavoro.
        container.addEventListener('wheel', (e) => this.editor.zoom_enter(e), { passive: false });
    }

    // ─────────────────────────────────────────────────────────────
    // T2Split 2026-07-29 — estratto VERBATIM da loadFromConfig() (righe 339-557
    // del file pre-refactor, md5 2721d600b2416c38fc789a7fbd551424).
    // Il corpo e' BYTE-IDENTICO: il parametro porta lo STESSO nome del locale
    // di partenza, quindi non una riga di handler e' stata riscritta.
    //
    // ⚠️ PERCHE' PAN E MARQUEE STANNO INSIEME E NON IN DUE HELPER:
    //    e' UN SOLO listener `mousedown` (window, capture) a servirli entrambi
    //    — destro => pan, sinistro su area vuota => marquee. Il ramo marquee
    //    legge `_marquee` / `_onMarqueeMove` / `_onMarqueeUp`, che nascono piu'
    //    sotto in questo stesso blocco. Separarli lascerebbe quei tre fuori
    //    scope (misurato: residuo ['_marquee','_onMarqueeMove','_onMarqueeUp'])
    //    e obbligherebbe a promuoverli su `this` — cioe' a RISCRIVERE. Restano
    //    uno scope solo: e' la granularita' che il codice impone, non una scelta.
    // ─────────────────────────────────────────────────────────────
    _installCanvasMouse(container) {
        // 2026-05-04 RightClickPan — schema mouse Blender/Maya:
        //   • Tasto SINISTRO  → select / drag nodi (nativo Drawflow)
        //   • Tasto DESTRO    → pan vista (custom, no Drawflow)
        //   • Rotellina       → zoom (vedi sopra)
        //
        // Drawflow di base usa SOLO button=0 per tutto. Per invertire usiamo
        // un pan handler completamente CUSTOM, indipendente da Drawflow.
        // Vantaggi: niente rischio di doppia chiamata position/dragEnd, drag
        // robusto via listener su `window` (continua anche fuori dal canvas
        // — sopra sidebar, header, viewport 3D).
        //
        // 4 modifiche:
        //   1) Block `contextmenu` sul container DAG (no menu browser sul
        //      tasto destro, che ora è dedicato al pan).
        //   2) Custom mousedown handler: button=2 sull'area vuota
        //      (`.drawflow` o `.parent-drawflow`) → start pan.
        //   3) Override `editor.click`: button=0 sull'area vuota → ignorato
        //      (niente pan con sinistro). Comportamento nativo per tutti
        //      gli altri target (nodi, socket, output) preservato.
        //   4) Listener `mousemove`/`mouseup` su `window` durante pan attivo
        //      (drag robusto). Removed sul `mouseup` per non sprecare ticks.
        const dagContainer = container;

        // Custom mouse handler — CAPTURE PHASE su WINDOW.
        // CRITICO — perché window e non container: Drawflow attacca i suoi
        // mouse listener su `editor.container` (=#drawflow) durante
        // `editor.start()` via `this.click.bind(this)`. Listener su uno
        // SPECIFICO elemento (anche capture phase) può arrivare DOPO i
        // listener Drawflow se Drawflow li attacca prima e in capture sullo
        // stesso elemento. Capture phase su `window` è la PRIMISSIMA fase
        // del ciclo eventi — non c'è handler che viene prima. Con
        // `stopPropagation()` blocchiamo l'evento prima che Drawflow lo
        // veda, indipendentemente da dove è bound. Drag dei nodi (mousedown
        // sul `.drawflow-node` o `.title-box`) NON è bloccato perché lì
        // `isEmptyCanvas === false` e lasciamo l'evento passare intatto.
        let _rightPan = null; // { startClientX, startClientY, canvasX0, canvasY0 }

        // V3.33 diagnostic logging — disattivato di default. Per troubleshooting
        // dal browser console: `window.ibex.stackMgr._panDebug = true` e ricarica
        // la pagina NO — basta abilitare e riprovare il pan, i log appaiono live.
        // Disabilita: `window.ibex.stackMgr._panDebug = false`.
        this._panDebug = false;
        const _logPan = (...args) => {
            if (this._panDebug) console.log('[PAN]', ...args);
        };

        const _onWindowMove = (ev) => {
            if (!_rightPan) return;
            const dx = ev.clientX - _rightPan.startClientX;
            const dy = ev.clientY - _rightPan.startClientY;
            this.editor.canvas_x = _rightPan.canvasX0 + dx;
            this.editor.canvas_y = _rightPan.canvasY0 + dy;
            this.editor.precanvas.style.transform =
                `translate(${this.editor.canvas_x}px, ${this.editor.canvas_y}px) scale(${this.editor.zoom})`;
        };

        const _closePan = () => {
            // Chiusura idempotente del destro pan. Chiamata da:
            //   • _onWindowUp     — al mouseup di QUALSIASI bottone (V3.33).
            //   • blur            — finestra browser perde focus (Alt+Tab).
            //   • visibilitychange— tab nascosta o utente cambia desktop.
            //   • mouseleave doc  — mouse esce dal viewport finestra.
            // Pattern "always close on any release/exit" semplifica drasticamente
            // rispetto al guard `button !== 2` di V3.32 che falliva quando
            // MouseEvent.button non era riconosciuto come 2 dal browser/OS, o
            // quando il mouseup avveniva fuori finestra. Trade-off: se l'utente
            // fa chord (sinistro premuto durante destro pan), il primo rilascio
            // chiude il pan — caso d'uso raro che accettiamo.
            if (!_rightPan) return;
            _logPan('close', 'wasActive');
            _rightPan = null;
            document.body.style.cursor = '';
            window.removeEventListener('mousemove', _onWindowMove, true);
            window.removeEventListener('mouseup', _onWindowUp, true);
        };
        const _onWindowUp = (ev) => {
            _logPan('mouseup', 'button=', ev?.button, 'rightPan=', !!_rightPan);
            _closePan();
        };

        // Helper: l'evento è dentro il container DAG?
        const _isInDag = (e) => dagContainer.contains(e.target);

        // (1) Block menu contestuale browser dentro DAG (window-level capture).
        // V3.33: aggiunto stopPropagation oltre a preventDefault. Su Linux/X11
        // alcuni window manager fires contextmenu al mousedown del destro, e
        // senza stopPropagation l'evento può propagare a listener Drawflow o
        // lasciare il browser in stato "context menu pending" che interferisce
        // col mouseup successivo del destro → pan non si chiude correttamente.
        window.addEventListener('contextmenu', (e) => {
            if (_isInDag(e)) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);

        // V3.34 RollbackSafetyNets: rimossi i listener blur/visibilitychange/
        // mouseleave introdotti in V3.33 che peggioravano il sintomo "perdo il
        // pan da solo": chiudevano il pan in scenari legittimi (mouse vicino al
        // bordo finestra, notifiche OS che brevemente toglievano focus alla tab,
        // movimenti rapidi che facevano uscire il puntatore dal viewport).
        // Compensiamo con _closePan() idempotente all'inizio del prossimo
        // mousedown destro (sotto): se per qualsiasi motivo _rightPan è stuck,
        // viene azzerato prima di partire un nuovo pan.

        // (2+3) mousedown capture su WINDOW
        window.addEventListener('mousedown', (e) => {
            if (!_isInDag(e)) return;

            const cls = (e.target && e.target.classList && e.target.classList[0]) || '';
            // V3.35 fix flex-1: il container outer `#drawflow` ha classe Tailwind
            // utility `flex-1` (vedi stack.blade.php). Drawflow crea il precanvas
            // interno come figlio. Quando canvas_x è shiftato (pan già fatto),
            // cliccando in zone "scoperte" del container outer il target è
            // `#drawflow` stesso (cls=flex-1), NON il precanvas. Pre-V3.35
            // il check `cls === 'drawflow'` fallisce → no pan, sintomo
            // "funziona per un po' poi smette". Fix: considera "area vuota"
            // anche il container outer e il precanvas via reference equality,
            // oltre alle classList drawflow/parent-drawflow legacy.
            const isEmptyCanvas = (
                e.target === dagContainer ||
                e.target === this.editor.precanvas ||
                cls === 'drawflow' ||
                cls === 'parent-drawflow'
            );

            if (e.button === 2) {
                _logPan('mousedown right', 'empty=', isEmptyCanvas, 'cls=', cls, 'rightPanActive=', !!_rightPan);
                // Destro: pan SOLO sull'area vuota; sui nodi/socket ignora
                // (no menu browser, no pan — l'utente deve mirare area vuota).
                if (!isEmptyCanvas) {
                    e.preventDefault(); // niente menu browser sui nodi
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                // V3.33: chiusura idempotente di eventuale pan precedente "stuck"
                // (es. se mouseup precedente è stato perso fuori finestra).
                _closePan();
                _rightPan = {
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    canvasX0: this.editor.canvas_x,
                    canvasY0: this.editor.canvas_y,
                };
                document.body.style.cursor = 'grabbing';
                window.addEventListener('mousemove', _onWindowMove, true);
                window.addEventListener('mouseup', _onWindowUp, true);
                _logPan('start pan', _rightPan);
                return;
            }

            if (e.button === 0 && isEmptyCanvas) {
                // Preset DAG (2026-05-05) — sinistro su area vuota AVVIA marquee
                // selection (rect screen-space). Distinzione click vs drag via
                // soglia 5px in mousemove (sotto soglia → trattato come click,
                // deselect tutto). Threshold scelta come pattern simili
                // (SelectionMode V1.3 lasso, SceneManager pointer click).
                e.preventDefault();
                e.stopPropagation();
                _marquee = {
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    currentClientX: e.clientX,
                    currentClientY: e.clientY,
                    started: false,
                    overlay: null,
                };
                window.addEventListener('mousemove', _onMarqueeMove, true);
                window.addEventListener('mouseup', _onMarqueeUp, true);
                return;
            }
        }, true);

        // Preset DAG (2026-05-05) — marquee selection state + handlers.
        // multiSelectedSet vive sull'istanza (this) → accessibile da
        // _onMultiSelectChanged + extractPresetPayload + nodeSelected hook.
        let _marquee = null;
        const _onMarqueeMove = (ev) => {
            if (!_marquee) return;
            _marquee.currentClientX = ev.clientX;
            _marquee.currentClientY = ev.clientY;
            const dx = ev.clientX - _marquee.startClientX;
            const dy = ev.clientY - _marquee.startClientY;
            // Soglia 5px: sotto è click (no marquee). Sopra → mostra overlay.
            if (!_marquee.started && Math.hypot(dx, dy) >= 5) {
                _marquee.started = true;
                _marquee.overlay = this._createMarqueeOverlay();
            }
            if (_marquee.started && _marquee.overlay) {
                this._updateMarqueeOverlay(_marquee);
            }
        };
        const _onMarqueeUp = (ev) => {
            if (!_marquee) return;
            const wasStarted = _marquee.started;
            const overlay = _marquee.overlay;
            const startX = _marquee.startClientX;
            const startY = _marquee.startClientY;
            const endX = ev.clientX;
            const endY = ev.clientY;
            _marquee = null;
            window.removeEventListener('mousemove', _onMarqueeMove, true);
            window.removeEventListener('mouseup', _onMarqueeUp, true);
            if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);

            if (wasStarted) {
                const rect = {
                    left:   Math.min(startX, endX),
                    top:    Math.min(startY, endY),
                    right:  Math.max(startX, endX),
                    bottom: Math.max(startY, endY),
                };
                this._applyMarqueeSelection(rect);
            } else {
                // Click puro su area vuota → deseleziona tutto
                this.clearMultiSelection();
            }
        };
    }

    // ─────────────────────────────────────────────────────────────
    // T2Split 2026-07-29 — estratto VERBATIM da loadFromConfig() (righe 559-642
    // del file pre-refactor, md5 2721d600b2416c38fc789a7fbd551424).
    // Il corpo e' BYTE-IDENTICO: il parametro porta lo STESSO nome del locale
    // di partenza, quindi non una riga di handler e' stata riscritta.
    // ─────────────────────────────────────────────────────────────
    _installKeyboardShortcuts() {
        // NodeMute (2026-05-05) — shortcut tastiera `M` su nodo selezionato.
        // Pattern Houdini/Blender. Skip se l'utente sta editando un input/
        // textarea/contentEditable (es. rename inline outliner / inspector).
        // Trova il nodo Drawflow attualmente selezionato via `.drawflow-node.selected`
        // (CSS class applicata da Drawflow al click sinistro su nodo).
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'm' && e.key !== 'M') return;
            // Skip se sto editando testo: non rubare la lettera M
            const tag = (e.target && e.target.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (e.target && e.target.isContentEditable) return;
            // Skip modificatori (ctrl+M / cmd+M / alt+M sono per il browser)
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            const selEl = document.querySelector('.drawflow-node.selected');
            if (!selEl) return;
            const nodeId = (selEl.id || '').replace(/^node-/, '');
            if (!nodeId) return;
            e.preventDefault();
            this.toggleNodeMute(nodeId);
        });

        // UX-A — shortcut con modificatore: Salva / Undo / Redo / Copia / Incolla.
        window.addEventListener('keydown', (e) => {
            const mod = e.metaKey || e.ctrlKey;
            if (!mod) return;
            const k = (e.key || '').toLowerCase();
            // Ctrl/⌘+S → salva (sempre, anche dentro un input: blocca il dialog
            // "salva pagina" del browser).
            if (k === 's') {
                e.preventDefault();
                if (window.ibex?.saveSession) window.ibex.saveSession();
                return;
            }
            // Le restanti NON rubano lo shortcut dentro un campo testo (undo/copia/
            // incolla nativi dell'input vincono).
            const tag = (e.target && e.target.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (e.target && e.target.isContentEditable) return;
            if (k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
            else if (k === 'y') { e.preventDefault(); this.redo(); }
            else if (k === 'c') {
                // copia sotto-grafo: solo con nodi marquee-selezionati e senza
                // testo selezionato (altrimenti lascia la copia nativa).
                if (this.multiSelectedSet && this.multiSelectedSet.size > 0) {
                    const sel = window.getSelection && window.getSelection();
                    if (sel && String(sel).length) return;
                    e.preventDefault();
                    this.copySelectedNodes();
                }
            }
            else if (k === 'v') {
                if (this._nodeClipboard) { e.preventDefault(); this.pasteClipboard(); }
            }
        });

        // UX-A batch2 — shortcut a tasto singolo: Canc (elimina) · I (isola) · F (fit).
        window.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const tag = (e.target && e.target.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (e.target && e.target.isContentEditable) return;
            if (e.key === 'Delete' || e.key === 'Backspace') {
                let ids = [];
                if (this.multiSelectedSet && this.multiSelectedSet.size > 0) {
                    ids = Array.from(this.multiSelectedSet);
                } else {
                    const selEl = document.querySelector('.drawflow-node.selected');
                    if (selEl) { const nid = (selEl.id || '').replace(/^node-/, ''); if (nid) ids = [nid]; }
                }
                if (!ids.length) return;
                e.preventDefault();
                this.deleteNodes(ids);
            } else if (e.key === 'i' || e.key === 'I') {
                if (window.ibex?.sculptMgr?.active) return;
                const name = window.ibex?.sceneMgr?.selectedMeshName;
                if (!name) return;
                e.preventDefault();
                window.ibex?.sceneMgr?.toggleIsolate?.(name);
            } else if (e.key === 'f' || e.key === 'F') {
                e.preventDefault();
                window.ibex?.viewGizmo?.fitAll?.();
            }
        });
    }

    // ─────────────────────────────────────────────────────────────
    // T2Split 2026-07-29 — estratto VERBATIM da loadFromConfig() (righe 644-773
    // del file pre-refactor, md5 2721d600b2416c38fc789a7fbd551424).
    // Il corpo e' BYTE-IDENTICO: il parametro porta lo STESSO nome del locale
    // di partenza, quindi non una riga di handler e' stata riscritta.
    // ─────────────────────────────────────────────────────────────
    _installConnectionEditing(container) {
        // Bug #8 fix (2026-04-22): Drawflow inietta `<svg class="connection">`
        // senza attributi width/height/viewBox. Con CSS height:100% e il nostro
        // layout (precanvas dentro flex-column con h-full a catena), Chromium
        // non risolve height:100% e applica l'aspect-ratio intrinseco 1:1 del
        // replaced element → l'SVG diventa quadrato (1167×1167) con top
        // statico ≈183.5px, sfasando le linee di quel valore verso il basso.
        // Fix: forziamo width/height in pixel espliciti via inline style al
        // momento della creazione di ogni connection (hook su drawConnection)
        // e dopo ogni import/resize (vedi _fixAllConnSvgSizes). Vedi invariante 61.
        const _origDrawConnection = this.editor.drawConnection.bind(this.editor);
        this.editor.drawConnection = (ele) => {
            _origDrawConnection(ele);
            this._fixConnSvgSize(this.editor.connection_ele);
        };

        // V3.40 (2026-05-05) — disconnessione cavi: 2 modalità.
        //   • dblclick sulla connection (legacy, preservato)
        //   • Alt+click sulla connection (nuovo, single-click rapido + discoverable
        //     dato che il cursore cambia su hover via CSS)
        // Drawflow nativo aveva right-click → menu delete, ma il destro è ora
        // dedicato al pan (V3.35) → serviva un meccanismo alternativo.
        const _removeConnectionFromEvent = (e) => {
            const path = e.target.closest('.connection');
            if (!path) return false;
            const cl = Array.from(path.classList);
            const out = cl.find(c => c.startsWith('node_out_node-'));
            const inp = cl.find(c => c.startsWith('node_in_node-'));
            const outC = cl.find(c => c.startsWith('output_'));
            const inpC = cl.find(c => c.startsWith('input_'));
            if (!out || !inp || !outC || !inpC) return false;
            this.editor.removeSingleConnection(
                out.replace('node_out_node-', ''),
                inp.replace('node_in_node-', ''), outC, inpC
            );
            return true;
        };
        container.addEventListener('dblclick', (e) => {
            if (_removeConnectionFromEvent(e)) {
                e.preventDefault();
                e.stopPropagation();
            }
        });
        container.addEventListener('click', (e) => {
            if (!e.altKey) return; // Alt+click only
            if (_removeConnectionFromEvent(e)) {
                e.preventDefault();
                e.stopPropagation();
            }
        });

        // V3.42 (2026-05-05) — rip-and-redrag su input collegato. Pattern
        // Blender Geometry Nodes / Houdini: click sull'INPUT con cavo collegato
        // → la connection esistente viene rimossa E parte una NUOVA connection-
        // in-progress dall'output del nodo upstream, che segue il mouse fino
        // al rilascio. Mouseup su un altro input → ricollegata. Mouseup nel
        // vuoto → cancellata definitivamente.
        //
        // Implementazione (3 step):
        //   1. Trova la connection esistente sull'input cliccato.
        //   2. Rimuovi la connection (`editor.removeSingleConnection`).
        //   3. Dispatch synthetic mousedown sull'output socket del nodo
        //      upstream → Drawflow inizia nativamente il drag della nuova
        //      connection (gestisce mousemove + mouseup automaticamente).
        //
        // Capture phase su `container` per arrivare PRIMA di Drawflow al
        // click iniziale → stopPropagation() impedisce a Drawflow di vedere
        // l'evento e iniziare LUI un drag dall'input (comportamento errato).
        // Il synthetic mousedown successivo sull'output viene invece visto
        // da Drawflow normalmente (è un evento separato in bubble phase).
        //
        // Se sull'input NON c'è connection (socket libero), lasciamo passare
        // l'evento intatto — Drawflow di base non innesca drag dagli input.
        container.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // solo sinistro
            const inputEl = e.target.closest('.input');
            if (!inputEl) return;
            const nodeEl = inputEl.closest('.drawflow-node');
            if (!nodeEl) return;
            const nodeId = (nodeEl.id || '').replace(/^node-/, '');
            if (!nodeId) return;
            const inputClass = Array.from(inputEl.classList).find(c => /^input_\d+$/.test(c));
            if (!inputClass) return;

            // Cerca connection col target: node_in_node-{id} + {inputClass}
            const conn = container.querySelector(
                `.connection.node_in_node-${CSS.escape(nodeId)}.${CSS.escape(inputClass)}`
            );
            if (!conn) return; // socket libero, lascia passare a Drawflow

            const cl = Array.from(conn.classList);
            const outClass = cl.find(c => c.startsWith('node_out_node-'));
            const outPortClass = cl.find(c => c.startsWith('output_'));
            if (!outClass || !outPortClass) return;
            const upstreamNodeId = outClass.replace('node_out_node-', '');

            // Trova l'output socket DOM del nodo upstream PRIMA di rimuovere
            // la connection (la rimozione non tocca il socket DOM ma è meglio
            // referenziarlo subito).
            const outputEl = container.querySelector(
                `#node-${CSS.escape(upstreamNodeId)} .outputs .${CSS.escape(outPortClass)}`
            );

            e.preventDefault();
            e.stopPropagation();

            // Step 2: rimuovi la connection esistente
            try {
                this.editor.removeSingleConnection(
                    upstreamNodeId, nodeId, outPortClass, inputClass
                );
            } catch (err) {
                console.warn('[StackManager] removeSingleConnection failed:', err);
                return;
            }

            // Step 3: synthetic mousedown sull'output socket → Drawflow inizia
            // il drag della nuova connection. Coordinate del cursore corrente
            // per non avere "salto" visivo all'inizio del drag.
            if (outputEl) {
                const synth = new MouseEvent('mousedown', {
                    bubbles: true,
                    cancelable: true,
                    button: 0,
                    buttons: 1,
                    clientX: e.clientX,
                    clientY: e.clientY,
                });
                outputEl.dispatchEvent(synth);
            }
        }, true);
    }

    // ─────────────────────────────────────────────────────────────
    // T2Split 2026-07-29 — estratto VERBATIM da loadFromConfig() (righe 783-842
    // del file pre-refactor, md5 2721d600b2416c38fc789a7fbd551424).
    // Il corpo e' BYTE-IDENTICO: il parametro porta lo STESSO nome del locale
    // di partenza, quindi non una riga di handler e' stata riscritta.
    //
    // ⚠️ UNICO blocco NON byte-identico: il corpo viveva a 12 spazi (dentro
    //    l'arrow che lo chiamava), qui sta a 8. E' un DEDENT MECCANICO di -4
    //    su ogni riga, verificato per costruzione: re-indentando +4 si riottiene
    //    l'originale carattere per carattere. Nessun altro cambiamento.
    //    Il chiamante resta quell'arrow in loadFromConfig, ridotta a shim di una
    //    riga: i suoi TRE call-site dentro il gate di import del DAG non sono
    //    toccati (quel gate e' load-bearing e resta byte-identico).
    // ─────────────────────────────────────────────────────────────
    _installDrawflowEvents() {
        this.editor.on('connectionCreated', (conn) => {
            // V3.10 — validazione tipi socket post-creazione.
            // Drawflow non espone hook pre-creazione: leggiamo l'ultimo
            // SVG.connection generato, confrontiamo i prefissi tipo (GEO/
            // MTX/VEC/SRT) e rimuoviamo se incompatibili. Se rimossa,
            // skip syncAndBake (la connessione non è mai esistita
            // dal punto di vista della pipeline).
            const valid = this._validateLastConnection();
            if (!valid) return;
            // Preset spawn (2026-05-05): durante uno spawnPreset, ogni
            // addConnection scatta connectionCreated → senza guard avremmo
            // N+1 syncAndBake. Skippiamo e lasciamo bake unico al termine
            // di spawnPreset. Pattern come loadFromConfig invariante 76.
            if (!this._suspendPresetBake) { this.syncAndBake(); this.pushUndoSnapshot(); }
            // D2 DarkRedesign: colora la connessione per tipo socket sorgente
            // + Bug #8: size-correct l'SVG connection appena creato.
            requestAnimationFrame(() => {
                this._colorAllConnections();
                this._fixAllConnSvgSizes();
                // NodeSkin V3.64: stato .filled dei socket dei 2 nodi toccati
                if (conn) { this._recolorNodeSockets(conn.output_id); this._recolorNodeSockets(conn.input_id); }
            });
        });
        this.editor.on('connectionRemoved', (conn) => {
            if (!this._suspendPresetBake) { this.syncAndBake(); this.pushUndoSnapshot(); }
            // NodeSkin V3.64: svuota i socket rimasti liberi
            if (conn) { this._recolorNodeSockets(conn.output_id); this._recolorNodeSockets(conn.input_id); }
        });
        this.editor.on('nodeRemoved', (nodeId) => {
            // Preset DAG: se il nodo rimosso era nel multi-select, pulisci.
            const idStr = String(nodeId).replace(/^node-/, '');
            if (this.multiSelectedSet?.has(idStr)) {
                this.multiSelectedSet.delete(idStr);
                this._onMultiSelectChanged();
            }
            if (!this._suspendPresetBake) { this.syncAndBake(); this.pushUndoSnapshot(); }
        });
        // NodeMute (2026-05-05) — inietta il toggle "M" sul title-box dei
        // nodi nuovi appena creati. requestAnimationFrame per attendere il
        // primo layout del DOM (Drawflow inserisce i nodi async). Idempotent
        // (skip se toggle già esiste).
        this.editor.on('nodeCreated', () => {
            requestAnimationFrame(() => this._refreshAllMutedClasses());
            if (!this._suspendPresetBake) this.pushUndoSnapshot();
        });
        // UX-A — node spostato (drag end): push snapshot (undo posizione).
        this.editor.on('nodeMoved', () => {
            if (!this._suspendPresetBake) this.pushUndoSnapshot();
        });
        this.editor.on('nodeSelected', (nodeId) => {
            this.dragEngine.bindDragInputs();
            // V3.13 (Obiettivo 2c): click su nodo DAG seleziona la mesh
            // associata nel viewport (e di conseguenza highlight outliner
            // + apertura InspectorPanel via SceneManager.selectMesh).
            this._onDagNodeSelected(nodeId);
            // Preset DAG (2026-05-05) — single-select esclusivo: clearing
            // multi-selection se l'utente clicca un singolo nodo (pattern
            // outliner standard, multi-select e single-select mutually exc).
            this.clearMultiSelection();
        });
    }


    // ═══════════════════════════════════════════════════════════════
    // V3.10 (Obiettivo 1) — validazione tipi socket post-creazione.
    //
    // Drawflow non espone hook pre-creazione (`connectionCreating`,
    // `beforeConnectionCreated`). L'unico evento è `connectionCreated`
    // (DOPO che la connessione è registrata in `editor.drawflow.Home.data`).
    // Qui leggiamo l'ULTIMO SVG.connection generato dal DOM, parsiamo le
    // classi `node_out_node-X / output_N / node_in_node-Y / input_M`,
    // risolviamo i nomi socket via `data.outPorts/inPorts` e confrontiamo
    // il SECONDO segmento (`IN_GEO_Mesh.split('_')[1]` → `'GEO'`).
    // Se incompatibili → `removeSingleConnection(...)` + toast warning.
    //
    // Returns: true se valida (o non determinabile → consenti), false se
    // rimossa (caller deve skippare syncAndBake).
    // ═══════════════════════════════════════════════════════════════
    _validateLastConnection() {
        const svgs = document.querySelectorAll('#drawflow svg.connection');
        if (!svgs.length) return true;
        const lastSvg = svgs[svgs.length - 1];
        const classes = Array.from(lastSvg.classList);

        const outClass  = classes.find(c => c.startsWith('output_'));
        const inClass   = classes.find(c => c.startsWith('input_'));
        const fromClass = classes.find(c => c.startsWith('node_out_node-'));
        const toClass   = classes.find(c => c.startsWith('node_in_node-'));
        if (!outClass || !inClass || !fromClass || !toClass) return true;

        const fromId = fromClass.replace('node_out_node-', '');
        const toId   = toClass.replace('node_in_node-', '');
        const outIdx = parseInt(outClass.replace('output_', ''), 10);
        const inIdx  = parseInt(inClass.replace('input_', ''), 10);

        let fromNode, toNode;
        try { fromNode = this.editor.getNodeFromId(fromId); } catch (e) { return true; }
        try { toNode   = this.editor.getNodeFromId(toId);   } catch (e) { return true; }
        if (!fromNode || !toNode) return true;

        const fromPortName = fromNode.name === 'mesh'
            ? 'OUT_GEO_Mesh'
            : (fromNode.data?.outPorts?.[outIdx - 1] || '');
        const toPortName = toNode.data?.inPorts?.[inIdx - 1] || '';

        const fromType = fromPortName.split('_')[1] || '';
        const toType   = toPortName.split('_')[1]   || '';

        // Se uno dei due nomi non è risolto o i tipi coincidono → consenti.
        if (!fromType || !toType || fromType === toType) return true;

        // V3.14 — whitelist di connessioni cross-type esplicitamente permesse
        // per design. `GEO → MTX` consente di usare un nodo mesh (o un tool
        // con OUT_GEO_*) come "parent matrix" di fast_parenting: l'executor
        // ([ToolExecutor.js:511-535](.)) sintetizza la matrice di trasformazione
        // dalla worldMat del nodo sorgente indipendentemente dal tipo socket
        // dichiarato. Senza questa eccezione, il workflow di parenting standard
        // sarebbe rotto dalla validazione introdotta in V3.10.
        const ALLOWED_CROSS = [
            { from: 'GEO', to: 'MTX' }
        ];
        if (ALLOWED_CROSS.some(r => r.from === fromType && r.to === toType)) {
            return true;
        }

        // Tipi incompatibili — rimuovi la connessione e notifica.
        try {
            this.editor.removeSingleConnection(
                fromId, toId, `output_${outIdx}`, `input_${inIdx}`
            );
        } catch (e) {
            console.warn('[StackManager] removeSingleConnection failed:', e);
        }
        if (window.ibex?.uiMgr?.notify) {
            window.ibex.uiMgr.notify(
                `Connessione non valida: socket "${fromPortName}" → "${toPortName}"`,
                'warning'
            );
        }
        return false;
    }

    // ═══════════════════════════════════════════════════════════════
    // V3.15 (Obiettivo 1) — popola la label SOLO sui nodi destructive.
    //
    // Itera `editor.export().drawflow.Home.data` filtrando i nodi con
    // `data.toolId ∈ DESTRUCTIVE_TOOL_IDS`. Per ogni destructive node:
    //   - sculpt / delete_topology → `{stem}_snap_{nodeId}`
    //   - split_topology           → `{stem}_snap_{nodeId}_A + _B`
    // Il `stem` deriva da `data.meta.mesh_name` (popolato post-save dello
    // snapshot, identifica il file su disco). Se `meta.mesh_name` non c'è
    // ancora (nodo nuovo non eseguito) → fallback a `step.target` via
    // `flattenGraphForBackend`. Se anche quello manca → label "—".
    //
    // Iniezione difensiva del DOM: se lo span placeholder manca (nodi
    // legacy importati con HTML pre-V5.11), lo crea on-the-fly sotto il
    // `.title-box`. Risultato: le label appaiono anche su progetti legacy.
    // ═══════════════════════════════════════════════════════════════
    _refreshDestructiveNodeLabels() {
        if (!this.editor || !this.executor) return;
        const DESTRUCTIVE = new Set(['sculpt', 'delete_topology', 'split_topology', 'topology_rebuild', 'draw_curve', 'arch_detect', 'curve_edit']);

        let data;
        try { data = this.editor.export().drawflow.Home.data; }
        catch (e) { return; }

        // V3.17 — lookup `displayName` per `meshName`. La label visiva del
        // nodo destructive deve riflettere il rename UI; il filename effettivo
        // su disco resta `{originalStem}_snap_{nodeId}.stl` (immutabile,
        // determinato da `meta.mesh_name`). Per coerenza col cosmetic-safe
        // rename, lo stem visivo è il displayName.
        const displayNameByMesh = new Map();
        for (const [, n] of Object.entries(data)) {
            if (n?.name === 'mesh' && n.data?.meshName && n.data?.displayName) {
                displayNameByMesh.set(n.data.meshName, n.data.displayName);
            }
        }
        const stemForMesh = (rawName) => {
            if (!rawName) return '';
            const dn = displayNameByMesh.get(rawName);
            if (dn) return dn;
            return String(rawName).replace(/\.stl$/i, '');
        };

        // Risolutore fallback: target via flattenGraphForBackend (mesh root).
        let stepsByNodeId = null;
        const getFallbackTarget = (nodeId) => {
            if (stepsByNodeId === null) {
                stepsByNodeId = new Map();
                try {
                    const g = this.extractDAG();
                    for (const s of this.executor.flattenGraphForBackend(g)) {
                        if (s._nodeId) stepsByNodeId.set(String(s._nodeId), s.target);
                    }
                } catch (e) { stepsByNodeId = new Map(); }
            }
            return stepsByNodeId.get(String(nodeId)) || '';
        };

        Object.entries(data).forEach(([id, node]) => {
            if (!node?.data) return;
            const toolId = node.data.toolId;
            if (!DESTRUCTIVE.has(toolId)) return;

            // V3.17: la label identifica solo la mesh USCENTE — l'entrante
            // è già visibile dalla connessione DAG, ripeterla è ridondante.
            //   sculpt / delete_topology → `snap_{nodeId}`
            //   split_topology           → `snap_{nodeId}_A + _B`
            // Il filename effettivo su disco resta `{originalStem}_snap_*`
            // (immutabile, determinato da `meta.mesh_name`); quel valore è
            // accessibile come tooltip via `title` (vedi sotto).
            const meshNameRaw = node.data.meta?.mesh_name || getFallbackTarget(id);
            const stemDisplay = stemForMesh(meshNameRaw);
            const stemFile    = meshNameRaw
                ? String(meshNameRaw).replace(/\.stl$/i, '')
                : '';

            let labelTxt;
            let labelTitle;
            if (toolId === 'split_topology') {
                labelTxt   = `snap_${id}_A + _B`;
                labelTitle = stemFile
                    ? `${stemFile}_snap_${id}_A.stl + ${stemFile}_snap_${id}_B.stl`
                    : `snap_${id}_A.stl + _B.stl`;
            } else {
                labelTxt   = `snap_${id}`;
                labelTitle = stemFile
                    ? `${stemFile}_snap_${id}.stl`
                    : `snap_${id}.stl`;
            }
            // displayName è informativo per il tooltip ma non altera il file.
            if (stemDisplay && stemDisplay !== stemFile) {
                labelTitle += `  (mesh: ${stemDisplay})`;
            }

            const nodeEl = document.getElementById(`node-${id}`);
            if (!nodeEl) return;
            let label = nodeEl.querySelector('.ibex-node-target-label');
            if (!label) {
                // Iniezione difensiva (nodi legacy senza placeholder).
                const title = nodeEl.querySelector('.title-box');
                if (!title || !title.parentNode) return;
                const row = document.createElement('div');
                row.className = 'ibex-node-target-row';
                label = document.createElement('span');
                label.className = 'ibex-node-target-label';
                row.appendChild(label);
                title.insertAdjacentElement('afterend', row);
            }
            label.textContent = labelTxt;
            if (labelTitle) label.title = labelTitle;
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // V3.12 (Obiettivo 2b) — highlight nodi DAG per la mesh selezionata.
    //
    // Listener `ibex:selection-changed` (dispatched da SceneManager.
    // selectMesh/deselectMesh) chiama questo metodo. Tutti i nodi che
    // hanno come target la mesh selezionata + il nodo mesh sorgente
    // ottengono la classe `.ibex-node-mesh-selected` (CSS in main.blade).
    // ═══════════════════════════════════════════════════════════════
    _highlightNodesForMesh(meshName) {
        document.querySelectorAll('.drawflow-node.ibex-node-mesh-selected')
            .forEach(el => el.classList.remove('ibex-node-mesh-selected'));

        if (!meshName || !this.editor || !this.executor) return;

        let graph;
        try { graph = this.extractDAG(); } catch (e) { return; }
        const steps = this.executor.flattenGraphForBackend(graph);

        // CurveDisplayName V3.56 (2026-05-14): un nodo è "mesh-related" SOLO
        // se produce una mesh (ha almeno un OUT_GEO_*). I curve-only producers
        // (arch_detect, draw_curve) hanno il loro input legato alla mesh ma
        // l'output è una CURVA — l'utente seleziona la mesh, il curve-only
        // node NON appartiene al "ramo" di quella mesh. Concettualmente la
        // curva è un oggetto separato (vedi outliner come oggetto di prima
        // classe). Skip dal highlight via filtro sui outPorts.
        const isMeshProducer = (nodeId) => {
            const n = graph.nodes.find(nn => String(nn.id) === String(nodeId));
            if (!n) return false;
            // Mesh source nodes sono per definizione mesh producers.
            if (n.type === 'mesh') return true;
            const out = Array.isArray(n.outPorts) ? n.outPorts : [];
            // Almeno un output GEO → produce mesh. Output solo CRV → curve-only.
            if (out.length === 0) return true;  // legacy fallback: tratta come mesh
            return out.some(p => typeof p === 'string' && p.includes('_GEO_'));
        };

        const relatedIds = new Set(
            steps
                .filter(s => s.target === meshName)
                .filter(s => isMeshProducer(s._nodeId))
                .map(s => String(s._nodeId))
        );

        // Aggiungi anche il nodo mesh sorgente (o nodi mesh con stesso name).
        for (const n of graph.nodes) {
            if (n.type !== 'mesh') continue;
            let dfNode;
            try { dfNode = this.editor.getNodeFromId(n.id); } catch (e) { continue; }
            if (dfNode?.data?.meshName === meshName) {
                relatedIds.add(String(n.id));
            }
        }

        for (const id of relatedIds) {
            const el = document.getElementById(`node-${id}`);
            if (el) el.classList.add('ibex-node-mesh-selected');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // V3.13 (Obiettivo 2c) — click su nodo DAG seleziona la mesh nel
    // viewport (e di riflesso nell'outliner via evento
    // `ibex:selection-changed` + apertura InspectorPanel).
    //
    // Per nodo mesh: legge `data.meshName`. Per nodo tool: trova
    // `step.target` corrispondente in `flattenGraphForBackend`.
    // `SceneManager.selectMesh` accetta il nome CON estensione (matcha
    // contro `mesh.name` Three.js, es. "Upper.stl").
    // ═══════════════════════════════════════════════════════════════
    _onDagNodeSelected(nodeId) {
        if (!this.editor) return;
        let node;
        try { node = this.editor.getNodeFromId(nodeId); } catch (e) { return; }
        if (!node) return;

        let meshName = null;
        if (node.name === 'mesh') {
            meshName = node.data?.meshName || null;
        } else {
            let graph;
            try { graph = this.extractDAG(); } catch (e) { return; }
            const steps = this.executor.flattenGraphForBackend(graph);
            const step = steps.find(s => String(s._nodeId) === String(nodeId));
            meshName = step?.target || null;
        }

        if (!meshName) return;
        if (window.ibex?.sceneMgr?.selectMesh) {
            window.ibex.sceneMgr.selectMesh(meshName);
        }
        // V3.16 — apri InspectorPanel come fanno viewport e outliner
        // (cascata simmetrica). `openForMesh` accetta sia mesh oggetto
        // che stringa (estrae .name internamente).
        if (window.ibex?.inspectorPanel?.openForMesh) {
            window.ibex.inspectorPanel.openForMesh(meshName);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // D2 DarkRedesign: colora connessioni Drawflow per tipo socket sorgente
    // ═══════════════════════════════════════════════════════════════
    _colorAllConnections() {
        if (!this.editor) return;
        const svgs = document.querySelectorAll('.drawflow svg.connection');
        svgs.forEach(svg => {
            const cls = Array.from(svg.classList);
            const outCls = cls.find(c => c.startsWith('node_out_node-'));
            const outIdxCls = cls.find(c => c.startsWith('output_'));
            if (!outCls || !outIdxCls) return;

            const fromId = outCls.replace('node_out_node-', '');
            const outIdx = parseInt(outIdxCls.replace('output_', ''), 10) - 1;

            let fromNode;
            try { fromNode = this.editor.getNodeFromId(parseInt(fromId, 10)); } catch (e) { return; }
            if (!fromNode || !fromNode.data) return;

            // Per i nodi mesh c'è un solo output GEO. Per tool leggo outPorts[idx].
            let portName = '';
            if (fromNode.name === 'mesh') {
                portName = 'OUT_GEO_Mesh';
            } else {
                const outPorts = fromNode.data.outPorts || [];
                portName = outPorts[outIdx] || '';
            }

            svg.classList.remove('conn-geo', 'conn-mtx', 'conn-vec', 'conn-crv');
            if      (portName.includes('_GEO_')) svg.classList.add('conn-geo');
            else if (portName.includes('_MTX_')) svg.classList.add('conn-mtx');
            else if (portName.includes('_VEC_')) svg.classList.add('conn-vec');
            else if (portName.includes('_CRV_')) svg.classList.add('conn-crv');
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // Bug #8 fix: force-size il singolo <svg class="connection"> ai pixel
    // esatti del precanvas. Necessario perché Chromium non risolve height:100%
    // attraverso la catena flex di #dag-panel → #dag-body → #dag-canvas →
    // #drawflow → precanvas e cade sull'aspect-ratio intrinseco (1:1) del
    // replaced element SVG, causando un offset verticale di ~183px sul path
    // disegnato. Vedi §0 Bug #8 e invariante 61.
    // ═══════════════════════════════════════════════════════════════
    _fixConnSvgSize(svg) {
        if (!svg || !this.editor?.precanvas) return;
        const pc = this.editor.precanvas;
        const w = pc.clientWidth;
        const h = pc.clientHeight;
        if (w <= 0 || h <= 0) return;
        svg.style.setProperty('top',    '0px',    'important');
        svg.style.setProperty('left',   '0px',    'important');
        svg.style.setProperty('width',  w + 'px', 'important');
        svg.style.setProperty('height', h + 'px', 'important');
    }

    _fixAllConnSvgSizes() {
        if (!this.editor?.precanvas) return;
        this.editor.precanvas.querySelectorAll('svg.connection')
            .forEach(svg => this._fixConnSvgSize(svg));
    }

    extractDAG() {
        if (!this.editor) return { nodes: [], edges: [] };
        const exported = this.editor.export().drawflow.Home.data;
        const graph = { nodes: [], edges: [] };

        Object.values(exported).forEach(node => {
            // PhpJsonFix V3.65: blindatura voci null (grafo importato come
            // array da manifest PHP-corrotto → buchi serializzati a null).
            if (!node || !node.data) return;
            // BLINDATURA PARAMS: Array → Object
            const rawParams = node.data.params;
            const safeParams = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
                ? rawParams : {};

            // ═══════════════════════════════════════════════════════
            // 🟢 BLINDATURA PREVIEW_BAKED_PARAMS
            //
            // Deep copy per evitare reference sharing.
            // Se non esiste → null → extractSRT restituisce zeri →
            // M_baked = TRS(0) = identityish. Corretto solo al primo ciclo.
            // Dopo il primo bake, BakeEngine scrive qui i params salvati.
            // ═══════════════════════════════════════════════════════
            const rawBaked = node.data.preview_baked_params;
            const safeBaked = (rawBaked && typeof rawBaked === 'object' && !Array.isArray(rawBaked))
                ? JSON.parse(JSON.stringify(rawBaked))
                : null;

            graph.nodes.push({
                id: node.id.toString(),
                type: node.name,
                name: node.data.name || node.data.toolName,
                toolId: node.data.toolId,
                tier: node.data.tier || 2,
                destructive: !!node.data.destructive,
                noBackend: !!node.data.no_backend,  // ExportNodeSTL — nodi I/O esclusi dal bake
                muted: !!node.data.muted,           // NodeMute (2026-05-05) — Houdini bypass pattern
                params: safeParams,
                paramsConfig: node.data.paramsConfig || {},
                preview_baked_params: safeBaked,
                // CurveDisplayName V3.56 (2026-05-14): outPorts esposto a graph.nodes
                // per consumer downstream (es. _highlightNodesForMesh skip
                // curve-only producers come arch_detect/draw_curve).
                outPorts: Array.isArray(node.data.outPorts) ? [...node.data.outPorts] : [],
                inPorts:  Array.isArray(node.data.inPorts)  ? [...node.data.inPorts]  : []
            });

            Object.entries(node.outputs).forEach(([outputKey, outData]) => {
                // SnapshotKeyed S3 (2026-04-25): mappa outputKey (es. "output_1",
                // "output_2") al relativo nome socket in `data.outPorts`.
                // Per mesh node: c'è solo OUT_GEO_Mesh. Per tool generici
                // single-output: outPorts[0] = 'OUT_GEO_Mesh'. Per split_topology
                // multi-output: outPorts = ['OUT_GEO_A', 'OUT_GEO_B'] → fromPort
                // distingue il ramo downstream.
                const outIdx = parseInt(String(outputKey).replace('output_', ''), 10) - 1;
                const outPortName = (node.data?.outPorts || [])[outIdx] || null;

                outData.connections.forEach(conn => {
                    const toId = conn.node.toString();
                    const targetData = exported[conn.node].data;
                    const inKeys = targetData.inPorts || [];

                    const targetPortName = conn.output || conn.input || "input_1";
                    const portIndex = parseInt(String(targetPortName).replace('input_','')) - 1;
                    let role = inKeys[portIndex];

                    // DrawCurve V1.0 (2026-05-06) — fallback robusto per role.
                    // Se `inKeys[portIndex]` è undefined (nodo target con
                    // `data.inPorts` non aggiornato dalla migrazione runtime,
                    // es. split_topology pre-DrawCurve con socket blu
                    // aggiunto via `editor.addNodeInput` ma metadata stale),
                    // ricava il role dal port name sorgente. Pattern:
                    //   from_port='OUT_CRV_Curve' → role='IN_CRV_Curve'
                    //   from_port='OUT_GEO_*'     → role='IN_GEO_Mesh'
                    //   altrimenti                 → role='target'
                    if (!role) {
                        if (outPortName && outPortName.includes('_CRV_')) {
                            role = 'IN_CRV_Curve';
                        } else if (outPortName && outPortName.includes('_GEO_')) {
                            role = 'IN_GEO_Mesh';
                        } else {
                            role = 'target';
                        }
                    }

                    const fromMesh = node.name === 'mesh' ? node.data.meshName : `tool_output_${node.id}`;
                    graph.edges.push({
                        from_mesh: fromMesh,
                        to_node:   toId,
                        role,
                        from_port: outPortName   // S3: null per mesh node / single-output tool; 'OUT_GEO_A|B' per split
                    });
                });
            });
        });

        this.graph = graph;
        return graph;
    }

    _castParamValue(value) {
        if (Array.isArray(value)) return value;
        if (value === true || value === false) return value;
        if (typeof value === 'string' && value.startsWith('#')) return value;
        const num = parseFloat(value);
        return isNaN(num) ? value : num;
    }

    // ═══════════════════════════════════════════════════════════════
    // V3.18 (2026-04-25) — Setter centralizzato params node + sync DOM
    // bidirezionale tra widget nodo DAG e widget InspectorPanel.
    //
    // I widget esistono in 2 punti DOM indipendenti che riflettono lo
    // stesso `node.data.params[key]`:
    //   - dentro `#node-{id}` (template Drawflow), input `[data-key="K"]`
    //   - dentro `#ibex-inspector-panel`, input `[data-node-id="X"][data-key="K"]`
    //
    // `editor.updateNodeDataFromId` aggiorna il grafo MA non sincronizza
    // i due DOM tra loro. Il setter qui scrive il grafo + propaga il
    // valore a entrambi i punti DOM (skip dell'input sorgente per non
    // interferire col cursor di typing).
    // ═══════════════════════════════════════════════════════════════
    setNodeParam(nodeId, key, value, options = {}) {
        const id = parseInt(nodeId, 10);
        const node = this.editor.getNodeFromId(id);
        if (!node) return;
        const cast = this._castParamValue(value);
        node.data.params = node.data.params || {};
        node.data.params[key] = cast;
        try { this.editor.updateNodeDataFromId(id, node.data); }
        catch (e) { /* non critico */ }

        // Sync DOM bidirezionale.
        const sourceEl = options.sourceEl || null;
        const isVector = Array.isArray(cast);

        // 1. Widget dentro il nodo DAG.
        const nodeEl = document.getElementById(`node-${id}`);
        if (nodeEl) this._syncWidgetValue(nodeEl, key, cast, isVector, sourceEl);

        // 2. Widget dentro l'InspectorPanel (se aperto su una mesh che
        //    espone questo nodo). Filtro per `data-node-id="${id}"` —
        //    ContextInspector V2.7 emette quegli attributi sui widget tool.
        const inspectorRoot = document.getElementById('ibex-inspector-panel');
        if (inspectorRoot && inspectorRoot.classList.contains('ibex-inspector-open')) {
            this._syncWidgetValue(inspectorRoot, key, cast, isVector, sourceEl, id);
        }

        // 3. ExportNodeSTL (2026-05-03) — widget custom (button label,
        // status) non seguono pattern `[data-key]`. Refresh dedicato del
        // singolo nodo se è un export e key è directory_path / filename_override.
        if (node.data?.toolId === 'burn' &&
            (key === 'directory_path' || key === 'filename_override')) {
            this._refreshSingleExportNode(id);
        }

        // UX-A Undo/Redo — push snapshot su edit param COMMITTATO (non durante il
        // drag: previewOnly non pusha → un gesto slider = un solo undo, al rilascio).
        if (!options.previewOnly) this.pushUndoSnapshot();

        // Trigger pipeline. ExportNodeSTL: skip — i nodi export sono noBackend
        // (cambiare directory/filename non richiede ricalcolo pipeline).
        if (node.data?.toolId === 'burn' || node.data?.no_backend === true) return;
        if (options.previewOnly) this.syncPreview();
        else if (options.bake !== false) this.syncAndBake();
    }

    // ═══════════════════════════════════════════════════════════════
    // UX-A — Undo/Redo snapshot-based (editor.export()/import()).
    // Stack di snapshot JSON + cursore. Edit committato → push; undo →
    // import dello snapshot precedente; redo → successivo. import() NON
    // spara eventi Drawflow (Inv. 76) e i flag _undoRestoring/
    // _suspendPresetBake bloccano push e bake spuri durante il restore.
    // ═══════════════════════════════════════════════════════════════
    pushUndoSnapshot() {
        if (!this._undoSeeded || this._undoRestoring || !this.editor) return;
        let snap;
        try { snap = JSON.stringify(this.editor.export()); } catch (e) { return; }
        // dedup: edit che non cambia lo stato serializzato → niente push.
        if (this._undoCursor >= 0 && this._undoStack[this._undoCursor] === snap) return;
        // tronca il ramo redo (un nuovo edit dopo un undo).
        if (this._undoCursor < this._undoStack.length - 1) {
            this._undoStack = this._undoStack.slice(0, this._undoCursor + 1);
        }
        this._undoStack.push(snap);
        if (this._undoStack.length > this._UNDO_CAP) this._undoStack.shift();
        this._undoCursor = this._undoStack.length - 1;
        this._updateUndoButtons();
    }

    seedUndoBaseline() {
        // baseline post-load: azzera lo stack e cattura lo stato corrente.
        this._undoStack = [];
        this._undoCursor = -1;
        this._undoSeeded = true;
        try {
            this._undoStack.push(JSON.stringify(this.editor.export()));
            this._undoCursor = 0;
        } catch (e) { /* stack vuoto → undo no-op finché non si edita */ }
        this._updateUndoButtons();
    }

    undo() {
        if (this._undoCursor <= 0) return;
        this._undoCursor--;
        this._restoreUndoSnapshot(this._undoStack[this._undoCursor]);
    }

    redo() {
        if (this._undoCursor >= this._undoStack.length - 1) return;
        this._undoCursor++;
        this._restoreUndoSnapshot(this._undoStack[this._undoCursor]);
    }

    _restoreUndoSnapshot(snapStr) {
        if (!snapStr || !this.editor) return;
        let snap;
        try { snap = JSON.parse(snapStr); } catch (e) { return; }
        this._undoRestoring = true;
        this._suspendPresetBake = true;
        try { this.editor.import(snap); }
        catch (e) {
            this._undoRestoring = false;
            this._suspendPresetBake = false;
            return;
        }
        // import() ricostruisce il DOM dai template raw → replay delle stesse
        // refresh-pass del post-import di loadFromConfig (Inv. 30/61), poi un
        // singolo syncAndBake per riallineare la preview allo stato ripristinato.
        setTimeout(() => {
            try { this._applyPostImportRefresh(); } catch (e) { /* non critico */ }
            this._undoRestoring = false;
            this._suspendPresetBake = false;
            this._updateUndoButtons();
            try { this.syncAndBake(); } catch (e) { /* non critico */ }
        }, 200);
    }

    // Replica le refresh-pass post-import di loadFromConfig (DOM ricostruito dai
    // template raw → widget/mute/socket/title vanno re-sincronizzati dal data).
    _applyPostImportRefresh() {
        try {
            const data = this.editor.export().drawflow.Home.data;
            Object.keys(data).forEach(id => this.editor.updateConnectionNodes('node-' + id));
        } catch (e) { /* non critico */ }
        this.dragEngine.bindDragInputs();
        this._colorAllConnections();
        this._fixAllConnSvgSizes();
        this._refreshAllSculptNodesDOM();
        this._refreshAllMeshNodeTitles();
        this._refreshAllToolNodeTitles();
        this._refreshAllToolWidgetsDOM();
        this._refreshAllExportNodesDOM();
        this._refreshAllMutedClasses();
        this._recolorAllSockets();
        // L3: nessun refresher post-import per la riga outliner (il rename
        // inline la scrive in-place) → dopo un restore resterebbe stale.
        try { window.ibex?.outlinerMgr?.update?.(); } catch (e) {}
    }

    _updateUndoButtons() {
        const u = document.getElementById('ibex-undo-btn');
        const r = document.getElementById('ibex-redo-btn');
        const canUndo = this._undoCursor > 0;
        const canRedo = this._undoCursor < this._undoStack.length - 1;
        if (u) { u.disabled = !canUndo; u.style.opacity = canUndo ? '' : '0.4'; }
        if (r) { r.disabled = !canRedo; r.style.opacity = canRedo ? '' : '0.4'; }
    }

    /**
     * V3.18 — sincronizza i widget DOM `[data-key="${key}"]` (e opzionalmente
     * `[data-node-id="${nodeIdHint}"]` per scoping inspector) dentro `rootEl`
     * col `value`. Skip dell'input `sourceEl` (è quello che ha emesso il
     * change → ha già il valore corretto, settarlo di nuovo può interferire
     * col cursor). Per vector: 3 input in ordine DOM = X, Y, Z.
     */
    _syncWidgetValue(rootEl, key, value, isVector, sourceEl, nodeIdHint) {
        const sel = (nodeIdHint != null)
            ? `[data-node-id="${nodeIdHint}"][data-key="${CSS.escape(key)}"]`
            : `[data-key="${CSS.escape(key)}"]`;
        // Filtra ai soli elementi di input — il wrapper `.ibex-vector-group`
        // espone anch'esso `data-key` (e talvolta `data-node-id`) per il
        // grouping; senza filtro, finirebbe in slice(0,3) e shifterebbe
        // gli indici X/Y/Z (bug V3.18: typing X → reset a 0 perché slice[1]
        // = X input riceve value[1], non value[0]).
        const all = Array.from(rootEl.querySelectorAll(sel));
        const inputs = all.filter(el =>
            el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
        );
        if (!inputs.length) return;

        if (isVector) {
            const slice = inputs.slice(0, 3);
            for (let i = 0; i < slice.length; i++) {
                const inp = slice[i];
                if (inp === sourceEl) continue;
                const v = (i < value.length) ? value[i] : 0;
                if (inp.tagName === 'INPUT') inp.value = v;
            }
        } else {
            for (const inp of inputs) {
                if (inp === sourceEl) continue;
                if (inp.type === 'checkbox') inp.checked = !!value;
                else if (inp.tagName === 'SELECT') inp.value = value;
                else inp.value = (value == null ? '' : value);
            }
        }
    }

    // I 4 metodi seguenti delegano al setter centralizzato `setNodeParam`.
    // Mantenuti per compat con i call site esistenti (template HTML inline
    // generati da NodeBuilder + ContextInspector + DragEngine).

    updateNodeDataPreviewOnly(inputEl, key, value) {
        const nodeId = inputEl.closest('.drawflow-node').id.replace('node-', '');
        this.setNodeParam(nodeId, key, value, { previewOnly: true, sourceEl: inputEl });
    }

    updateNodeData(inputEl, key, value) {
        const nodeId = inputEl.closest('.drawflow-node').id.replace('node-', '');
        this.setNodeParam(nodeId, key, value, { sourceEl: inputEl });
    }

    updateNodeDataById(nodeId, key, value) {
        this.setNodeParam(nodeId, key, value);
    }

    updateNodeDataByIdPreviewOnly(nodeId, key, value) {
        this.setNodeParam(nodeId, key, value, { previewOnly: true });
    }

    syncPreview() {
        if (this._hasLegacyNodes()) {
            this._notifyLegacyBlock();
            return;
        }
        const graph = this.extractDAG();
        this.executor.applyGraph(graph);
    }

    syncAndBake() {
        if (this._hasLegacyNodes()) {
            this._notifyLegacyBlock();
            return;
        }
        const graph = this.extractDAG();
        // Fix 2b (Invariante 77b): warning una-volta-per-sessione se un nodo
        // sculpt ha tool upstream. Non blocca il bake.
        this._checkSculptPosition(graph);
        this.executor.applyGraph(graph);
        this.bakeEngine.requestBake();
        // V3.15 (Obiettivo 1) — popola `.ibex-node-target-label` SOLO sui
        // nodi destructive col nome del file snapshot prodotto.
        this._refreshDestructiveNodeLabels();
    }

    // ═══════════════════════════════════════════════════════════════
    // Sculpt V2 Sessione 1 — Legacy node detection
    //
    // delta_sculpting è stato rimosso completamente. Le sessioni esistenti nel
    // DB possono contenere nodi `delta_sculpting` nel ui_graph: al caricamento
    // li marchiamo visualmente come obsoleti (classe .ibex-node-legacy-deleted
    // + overlay "⚠ Strumento rimosso") e blocchiamo syncAndBake/syncPreview
    // finché non vengono eliminati dall'utente.
    // ═══════════════════════════════════════════════════════════════

    _hasLegacyNodes() {
        if (!this.editor) return false;
        try {
            const data = this.editor.export()?.drawflow?.Home?.data || {};
            return Object.values(data).some(n => n?.data?.toolId === 'delta_sculpting');
        } catch (e) { return false; }
    }

    _markLegacyNodes() {
        if (!this.editor) return [];
        const data = this.editor.export()?.drawflow?.Home?.data || {};
        const legacy = [];
        Object.entries(data).forEach(([id, node]) => {
            if (node?.data?.toolId !== 'delta_sculpting') return;
            legacy.push(id);
            const el = document.getElementById('node-' + id);
            if (!el) return;
            el.classList.add('ibex-node-legacy-deleted');
            const box = el.querySelector('.box');
            if (box) {
                box.innerHTML = `
                    <div class="ibex-legacy-msg">⚠ Strumento rimosso</div>
                    <button class="ibex-legacy-delete"
                            onclick="window.ibex.stackMgr._removeLegacyNode('${id}')">
                        Elimina nodo
                    </button>
                `;
            }
        });
        return legacy;
    }

    _removeLegacyNode(id) {
        if (!this.editor) return;
        try { this.editor.removeNodeId('node-' + id); } catch (e) {}
        // Dopo remove, Drawflow emette 'nodeRemoved' → syncAndBake;
        // se nessun legacy residuo, il bake procede normale.
        const remaining = this._markLegacyNodes();
        if (remaining.length === 0 && window.ibex?.uiMgr) {
            window.ibex.uiMgr.notify('Nodo obsoleto eliminato.', 'info');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Migrazione in-place toolId legacy (2026-04-22 rinomina meshcleaner)
    //
    // Session_settings salvate prima della rinomina hanno `toolId:
    // 'gn_meshcleaner_v2'`. Il worker ha un alias backward-compat, ma
    // rimappando in-place nel frontend al load evitiamo di trascinarsi
    // l'alias. Al prossimo save_exit il DB viene riscritto col nuovo nome.
    // ═══════════════════════════════════════════════════════════════
    _migrateLegacyToolIds() {
        if (!this.editor) return;
        const LEGACY_NAMES = {
            'Pulisci Scansione': 'Pulisci Mesh',
            'Pulisci Mesh V2': 'Pulisci Mesh',
            // V2.5 (2026-05-13): rename arch_detect display_name
            'Rileva Arcata': 'Rileva Arco',
            'rileva arcata': 'Rileva Arco',
            // L10.1 (2026-07-25): «Esporta STL» → «Burn» (toolName cotto nei grafi salvati)
            'Esporta STL': 'Burn',
        };
        // SnapshotKeyed S1+S2+S3: tool-ids registrati come destructive (mirror
        // frontend di gn_meta.json destructive:true + worker DESTRUCTIVE_TOOLS).
        // Serve per backfill `data.destructive` su nodi salvati pre-S1 (sculpt),
        // pre-S2 (delete_topology), pre-S3 (split_topology). Quando aggiungi un
        // nuovo tool destructive, AGGIORNA questa lista oltre a gn_meta.json +
        // config.py (Invariante 82).
        const DESTRUCTIVE_TOOL_IDS = new Set(['sculpt', 'delete_topology', 'split_topology', 'topology_rebuild', 'draw_curve', 'arch_detect', 'curve_edit']);
        // RENAME 2026-07-21 (speculare a config._TOOL_RENAME): auto-migrazione dei
        // grafi salvati. Al load i vecchi toolId → nuovi; al save si persistono i nuovi.
        const TOOLID_RENAME = { 'fast_transform': 'transform', 'fast_parenting': 'parent', 'export_stl': 'burn' };
        try {
            const data = this.editor.export()?.drawflow?.Home?.data || {};
            Object.entries(data).forEach(([id, node]) => {
                let changed = false;
                if (TOOLID_RENAME[node?.data?.toolId]) { node.data.toolId = TOOLID_RENAME[node.data.toolId]; changed = true; }
                // L10.1 (2026-07-25): «Esporta STL» → «Burn» sui grafi già salvati.
                // DEVE stare DOPO TOOLID_RENAME (che ha già portato export_stl → burn).
                if (node?.data?.toolId === 'burn' && LEGACY_NAMES[node.data.toolName]) {
                    node.data.toolName = LEGACY_NAMES[node.data.toolName];
                    changed = true;
                }
                if (node?.data?.toolId === 'gn_meshcleaner_v2') {
                    node.data.toolId = 'meshcleaner';
                    if (LEGACY_NAMES[node.data.toolName]) {
                        node.data.toolName = LEGACY_NAMES[node.data.toolName];
                    }
                    changed = true;
                }
                // V2.5 (2026-05-13): rename arch_detect "Rileva Arcata" → "Rileva Arco".
                // Migra il toolName cotto nei session_settings pre-rename.
                if (node?.data?.toolId === 'arch_detect' && LEGACY_NAMES[node.data.toolName]) {
                    node.data.toolName = LEGACY_NAMES[node.data.toolName];
                    changed = true;
                }
                // 2026-04-22 V16.0: meshcleaner passa da Tier 2 a Tier 1 (PyMeshLab).
                // Session_settings pre-migrazione hanno `data.tier: 2` salvato;
                // forziamo a 1 altrimenti BakeEngine route-a su preview_bake invece
                // di fast_transform per pipeline 100% Tier 1. (Il worker route-a
                // comunque tier1 via TIER1_TOOLS check, ma evitiamo il cold-start
                // Blender inutile.)
                if (node?.data?.toolId === 'meshcleaner' && node.data.tier !== 1) {
                    node.data.tier = 1;
                    changed = true;
                }
                // SnapshotKeyed S1 (2026-04-23): backfill data.destructive per nodi
                // salvati pre-S1. Senza questa patch, ToolExecutor.flattenGraphForBackend
                // non inietta `_snapshot_node_id` → worker `_apply_sculpt` cade nel
                // fallback legacy `_sculpted.stl` (assente su progetti nuovi) → mesh
                // sculpted mai vista. Al prossimo save_exit il DB viene riscritto.
                if (node?.data?.toolId && DESTRUCTIVE_TOOL_IDS.has(node.data.toolId)
                        && !node.data.destructive) {
                    node.data.destructive = true;
                    changed = true;
                }
                if (changed) {
                    try {
                        this.editor.updateNodeDataFromId(parseInt(id, 10), node.data);
                    } catch (e) {}
                }
            });
        } catch (e) { /* non critico */ }

        // DrawCurve V1.0 (2026-05-06): migra nodi `split_topology` salvati
        // pre-DrawCurve aggiungendo il secondo input `IN_CRV_Curve` runtime.
        // Pre-V1, il template addNode aveva `numInputs=1` (solo IN_GEO_Mesh).
        // Drawflow non aggiunge socket retroattivamente — al `import()` ricostruisce
        // il DOM dal HTML salvato + i metadata salvati. Quindi i nodi vecchi
        // restano a 1 input. Soluzione: `editor.addNodeInput(id)` runtime per
        // aggiungere il socket blu CRV, + aggiorno `data.inPorts` /
        // `data.paramsConfig` per coerenza con tutto il flow.
        try {
            const data2 = this.editor.export()?.drawflow?.Home?.data || {};
            Object.entries(data2).forEach(([id, node]) => {
                if (node?.data?.toolId !== 'split_topology') return;
                const inPorts = node.data.inPorts || ['IN_GEO_Mesh'];
                if (inPorts.includes('IN_CRV_Curve')) return; // già migrato
                // Aggiunge un socket input al nodo Drawflow (DOM + state)
                try { this.editor.addNodeInput(parseInt(id, 10)); }
                catch (e) { /* non critico */ }
                // Update IBEX metadata
                node.data.inPorts = [...inPorts, 'IN_CRV_Curve'];
                node.data.paramsConfig = {
                    ...(node.data.paramsConfig || {}),
                    IN_CRV_Curve: { type: 'NodeSocketCurve', is_port: true }
                };
                try {
                    this.editor.updateNodeDataFromId(parseInt(id, 10), node.data);
                } catch (e) {}
                // Color del nuovo socket blu
                if (this.nodeBuilder?._colorDrawflowPorts) {
                    this.nodeBuilder._colorDrawflowPorts(
                        id, node.data.inPorts, node.data.outPorts || ['OUT_GEO_A', 'OUT_GEO_B'],
                        node.data.panelId
                    );
                }
            });
        } catch (e) { /* non critico */ }
    }

    _notifyLegacyBlock() {
        if (window.ibex?.uiMgr) {
            window.ibex.uiMgr.notify(
                'Nodi obsoleti nel grafo — eliminali per continuare.',
                'error'
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Fix 2b (Invariante 77b) — Sculpt position warning
    //
    // Quando un nodo `sculpt` ha tool upstream sullo stesso target, il
    // risultato del bake può divergere dalla preview client-side:
    //   · Tier 1 upstream (fast_transform/fast_parenting): `_apply_sculpt`
    //     nel worker copia `{stem}_sculpted.stl` sopra l'output Tier 1 →
    //     matrice upstream SCARTATA (commento esplicito in
    //     fast_transform.py::_apply_sculpt, "LIMITAZIONE NOTA").
    //   · Tier 2 upstream (meshcleaner): il worker splitta tier1/tier2 e
    //     applica Tier 1 (sculpt) PRIMA di Tier 2 → ordine effettivo
    //     invertito rispetto al DAG → risultato ≠ preview.
    //
    // Notifica warning una sola volta per sessione editor. Flag
    // `_sculptPositionWarned` cleared in loadFromConfig. Non blocca il bake.
    // ═══════════════════════════════════════════════════════════════
    _checkSculptPosition(graph) {
        if (this._sculptPositionWarned) return;
        if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return;

        const sculptNodes = graph.nodes.filter(n => n.toolId === 'sculpt');
        if (!sculptNodes.length) return;

        // Un sculpt è "mal posizionato" se ha almeno un edge entrante dove
        // `from_mesh` inizia con `tool_output_` (= proviene da un altro tool).
        // Se tutti gli edge vengono da mesh base (Upper.stl, Lower.stl, …),
        // sculpt è primo step del target → OK.
        const hasUpstream = sculptNodes.some(sn => {
            const incoming = graph.edges.filter(e => String(e.to_node) === String(sn.id));
            return incoming.some(e => e.from_mesh && String(e.from_mesh).startsWith('tool_output_'));
        });

        if (hasUpstream && window.ibex?.uiMgr) {
            window.ibex.uiMgr.notify(
                'Il nodo "Scolpisci" ha tool a monte — il risultato potrebbe non corrispondere alla preview. Posizionalo come primo step del suo target.',
                'warning'
            );
            this._sculptPositionWarned = true;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Sculpt V2 Sessione 4 — Update meta nodo `sculpt` + refresh DOM
    //
    // Il `node.data.meta = {sculpted, vertex_count, last_modified}` resta
    // sempre UI-only (non propagato al backend via extractDAG). Funzioni:
    //
    //   updateSculptNodeMeta(nodeId, partialMeta)
    //     Merge parziale in node.data.meta + scrive su Drawflow tramite
    //     editor.updateNodeDataFromId (persiste su ui_graph nel prossimo
    //     save_exit). Poi refresh DOM del nodo.
    //
    //   _refreshSculptNodeDOM(nodeId)
    //     Applica/rimuove classe `.ibex-sculpt-node-modified` (strip verde).
    //     Aggiorna testo `.ibex-sculpt-label` a "Modificato · N verts" o
    //     "Non ancora modificato".
    //
    //   _refreshAllSculptNodesDOM()
    //     Chiamato post-import (loadFromConfig): applica il refresh a tutti
    //     i nodi `toolId === 'sculpt'` caricati dal session_settings.
    // ═══════════════════════════════════════════════════════════════

    updateSculptNodeMeta(nodeId, partialMeta) {
        if (!this.editor) return;
        const id = parseInt(nodeId, 10);
        const node = this.editor.getNodeFromId(id);
        // S3 (2026-04-25): accetta tutti i tool destructive (sculpt + delete_topology + split_topology).
        // Il nome del metodo resta `updateSculptNodeMeta` per compat con chiamanti esistenti —
        // semanticamente è `updateDestructiveNodeMeta`. Non renominato per minimizzare churn.
        if (!node) return;
        const toolId = node.data?.toolId;
        if (!['sculpt', 'delete_topology', 'split_topology', 'topology_rebuild', 'draw_curve', 'arch_detect', 'curve_edit'].includes(toolId)) return;
        node.data.meta = { ...(node.data.meta || {}), ...(partialMeta || {}) };
        try { this.editor.updateNodeDataFromId(id, node.data); } catch (e) {}
        this._refreshSculptNodeDOM(id);
    }

    // ═══════════════════════════════════════════════════════════════
    // DrawCurve V1.0 (2026-05-07) — refresh meta dei nodi split_topology
    // post-bake worker.
    //
    // PROBLEMA: `applySplit` (modalità brush client-side) chiama
    // `updateSculptNodeMeta` per popolare i nomi A/B nel template.
    // Ma in modalità "curva" (cut geodetico via worker), `applySplit`
    // NON viene chiamato — il bake parte automaticamente al syncAndBake
    // quando la curva è collegata. Risultato: il nodo split rimane
    // "Non ancora modificato" + input A/B disabilitati anche dopo
    // che il worker ha prodotto correttamente i 2 file.
    //
    // FIX: dopo l'hot-swap post-bake, itera i nodi `split_topology` nel
    // grafo Drawflow. Per ognuno, trova la mesh upstream IN_GEO_Mesh →
    // calcola lo stem → cerca le 2 mesh derivate `{stem}_snap_{nodeId}_A.stl`
    // + `_B.stl` in `sceneMgr.group.children`. Se entrambe presenti,
    // calcola face counts via `geometry.index.count/3` e chiama
    // `updateSculptNodeMeta` con `{sculpted, mesh_name (master upstream),
    // faces_a, faces_b, last_modified}` → triggera _refreshSculptNodeDOM
    // → popola gli input A/B nel template.
    //
    // Chiamato da BakeEngine post-success (insieme a updateSplitMasterVisibility).
    // ═══════════════════════════════════════════════════════════════
    _refreshSplitNodesMetaPostBake() {
        // Defensive: questo helper è chiamato da BakeEngine post-success bake.
        // Qualsiasi eccezione qui NON deve bloccare il flow del bake (notify
        // success, _markDone, finally cleanup). Wrap try/catch silenzioso.
        try {
            if (!this.editor) return;
            const sceneMgr = window.ibex?.sceneMgr;
            if (!sceneMgr?.group) return;

            let exported;
            try { exported = this.editor.export().drawflow.Home.data; }
            catch (e) { return; }
            if (!exported) return;

            // Riusa graph cached (popolato da extractDAG nei call site upstream
            // del bake). Fallback a fresh extractDAG se non disponibile.
            const graph = this.graph && Array.isArray(this.graph.edges)
                ? this.graph
                : this.extractDAG();
            if (!graph || !Array.isArray(graph.edges)) return;

            Object.entries(exported).forEach(([id, node]) => {
                try {
                    if (node?.data?.toolId !== 'split_topology') return;

                    // Trova la mesh upstream (IN_GEO_Mesh edge entrante).
                    const inEdges = graph.edges.filter(e => String(e.to_node) === String(id));
                    const inGeoEdge = inEdges.find(e => e.role === 'IN_GEO_Mesh');
                    if (!inGeoEdge) return;

                    const masterName = this.resolveBaseMesh(inGeoEdge.from_mesh, inGeoEdge.from_port);
                    if (!masterName || typeof masterName !== 'string') return;
                    if (!masterName.toLowerCase().endsWith('.stl')) return;

                    const stem = masterName.replace(/\.stl$/i, '');
                    const meshA = sceneMgr.group.children.find(c =>
                        c.isMesh && c.name === `${stem}_snap_${id}_A.stl`);
                    const meshB = sceneMgr.group.children.find(c =>
                        c.isMesh && c.name === `${stem}_snap_${id}_B.stl`);

                    // Se le mesh derivate non sono ancora in scena (worker non ha
                    // ancora prodotto, o l'utente non le ha collegate downstream),
                    // skip — il prossimo bake farà il refresh quando saranno presenti.
                    if (!meshA || !meshB) return;

                    // Face count via index buffer (BufferGeometry indexed).
                    const facesA = meshA.geometry?.index
                        ? Math.floor(meshA.geometry.index.count / 3)
                        : Math.floor((meshA.geometry?.attributes?.position?.count || 0) / 3);
                    const facesB = meshB.geometry?.index
                        ? Math.floor(meshB.geometry.index.count / 3)
                        : Math.floor((meshB.geometry?.attributes?.position?.count || 0) / 3);

                    // Nota: NON skippare se i meta sembrano già coerenti — il
                    // template DOM potrebbe essere stato re-creato da Drawflow
                    // import() senza gli input editabili; meglio chiamare sempre
                    // updateSculptNodeMeta che a sua volta chiama
                    // _refreshSculptNodeDOM (che ha già skip-on-focus interno
                    // per preservare cursor utente). Costo trascurabile.
                    this.updateSculptNodeMeta(id, {
                        sculpted:      true,
                        mesh_name:     masterName,
                        faces_a:       facesA,
                        faces_b:       facesB,
                        last_modified: Math.floor(Date.now() / 1000)
                    });
                } catch (e) {
                    console.warn('[StackManager] _refreshSplitNodesMetaPostBake node failed:', id, e);
                }
            });
        } catch (e) {
            console.warn('[StackManager] _refreshSplitNodesMetaPostBake failed:', e);
        }
    }

    _refreshSculptNodeDOM(nodeId) {
        const id = parseInt(nodeId, 10);
        if (!this.editor) return;
        const node = this.editor.getNodeFromId(id);
        if (!node) return;
        // SnapshotKeyed S3 (2026-04-25): il refresh DOM supporta ora 3 tipi di nodo destructive:
        //   - sculpt            : "Modificato · N verts"
        //   - delete_topology   : "Modificato · N facce eliminate"
        //   - split_topology    : "Separato · A:Na · B:Nb facce" + popola names output
        // Tutti usano lo stesso template DOM `.ibex-sculpt-status` + `.ibex-sculpt-label`.
        const toolId = node.data?.toolId;
        const isSupportedDestructive = ['sculpt', 'delete_topology', 'split_topology', 'topology_rebuild', 'draw_curve', 'arch_detect', 'curve_edit'].includes(toolId);
        if (!isSupportedDestructive) return;

        const el = document.getElementById('node-' + id);
        if (!el) return;

        const meta = node.data.meta || {};
        const sculpted = !!meta.sculpted;
        // CurveDisplayName V3.57 (2026-05-14): TUTTI i nodi che producono o
        // editano curve usano la strip BLU `.ibex-curve-node-configured`
        // (coerente con socket CRV `#2A6FDB`). Comprende:
        //   - arch_detect  (output curva auto-detect)
        //   - draw_curve   (output curva user-drawn)
        //   - curve_edit   (input curva + output curva editata)
        // I nodi che modificano la mesh restano sulla strip VERDE
        // `.ibex-sculpt-node-modified` (sculpt, delete_topology,
        // split_topology, topology_rebuild). Mutuamente esclusivi.
        const CURVE_TOOLS = new Set(['arch_detect', 'draw_curve', 'curve_edit']);
        if (CURVE_TOOLS.has(toolId)) {
            el.classList.remove('ibex-sculpt-node-modified');
            el.classList.toggle('ibex-curve-node-configured', sculpted);
        } else {
            el.classList.remove('ibex-curve-node-configured');
            el.classList.toggle('ibex-sculpt-node-modified', sculpted);
        }

        const statusEl = el.querySelector('.ibex-sculpt-status');
        const labelEl  = el.querySelector('.ibex-sculpt-label');
        if (statusEl) statusEl.dataset.state = sculpted ? 'modified' : 'idle';

        // Label personalizzato per tipo
        if (labelEl) {
            if (!sculpted) {
                // Default per nodi non ancora configurati. Per draw_curve la
                // semantica "Non ancora modificato" è ambigua (la mesh non
                // viene modificata mai dal nodo) → testo neutro.
                // arch_detect è auto-detect al bake → testo che descrive il
                // comportamento (V1.0: meta post-bake non aggiornato — il
                // label resta su "Calcolo automatico al bake" anche se la
                // curva è stata calcolata sul disco).
                if (toolId === 'draw_curve') {
                    labelEl.textContent = 'Nessuna curva disegnata';
                } else if (toolId === 'arch_detect') {
                    labelEl.textContent = 'Calcolo automatico al bake';
                } else if (toolId === 'curve_edit') {
                    labelEl.textContent = 'Curva passthrough — non modificata';
                } else {
                    labelEl.textContent = 'Non ancora modificato';
                }
            } else if (toolId === 'sculpt') {
                labelEl.textContent = `Modificato · ${meta.vertex_count || 0} verts`;
            } else if (toolId === 'delete_topology') {
                const nd = meta.faces_deleted || 0;
                labelEl.textContent = `Modificato · ${nd} facce eliminate`;
            } else if (toolId === 'split_topology') {
                const fa = meta.faces_a || 0;
                const fb = meta.faces_b || 0;
                const fmt = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
                labelEl.textContent = `Separato · A:${fmt(fa)} · B:${fmt(fb)} facce`;
            } else if (toolId === 'topology_rebuild') {
                const ns = meta.n_faces_selected || 0;
                labelEl.textContent = `Ricostruito · ${ns} facce selez.`;
            } else if (toolId === 'draw_curve') {
                const nClosed = meta.n_closed || 0;
                const nTotal  = meta.n_splines || 0;
                const nOpen   = nTotal - nClosed;
                // No "Modificato" — il nodo NON modifica la mesh, produce solo
                // un datablock curve. Label neutro che descrive il contenuto.
                labelEl.textContent = `${nClosed} chiuse + ${nOpen} aperte`;
            } else if (toolId === 'arch_detect') {
                // V1.0 (2026-05-12): nodo auto-detect. Label mostra n_ctrl_points
                // e lunghezza arcata in mm post-bake. Pre-bake il testo default
                // "Calcolo automatico al bake" è già scritto dal template.
                const nPts = meta.n_ctrl_points || 0;
                const arcLen = meta.arch_length_mm || 0;
                labelEl.textContent = `Arcata · ${nPts} pts · ${arcLen.toFixed(0)}mm`;
            } else if (toolId === 'curve_edit') {
                // V1.0 (2026-05-12): curve_edit. Label mostra count splines + CPs
                // post-save. Pre-edit il default "passthrough — non modificata"
                // è settato sopra.
                const nClosed = meta.n_closed || 0;
                const nTotal  = meta.n_splines || 0;
                const nOpen   = nTotal - nClosed;
                const nCp     = meta.n_ctrl_points || 0;
                labelEl.textContent = `Editato · ${nClosed} chiuse + ${nOpen} aperte · ${nCp} CP`;
            }
        }

        // CurveDisplayName V3.56 (2026-05-14): per arch_detect e draw_curve,
        // popola l'input editabile `.ibex-curve-output-name-input` con il
        // valore di `node.data.curveDisplayName` (null/empty → placeholder
        // mostra il fallback `toolName`). Bind handler una volta sola
        // (idempotente via `_bindCurveNameInput`).
        // Injection runtime per legacy nodes (creati pre-V5.16 senza input
        // nel template HTML salvato).
        // V3.58 (2026-05-14): curve_edit RIMOSSO dal set — il nodo è un
        // editor di curva esistente, non un producer, eredita il nome dal
        // producer upstream (arch_detect / draw_curve).
        const CURVE_PRODUCERS = new Set(['arch_detect', 'draw_curve']);
        if (CURVE_PRODUCERS.has(toolId)) {
            this._ensureCurveOutputInput(el, node.data?.toolName);
            const curveInput = el.querySelector('.ibex-curve-output-name-input');
            if (curveInput && document.activeElement !== curveInput) {
                const custom = node.data?.curveDisplayName;
                curveInput.value = (custom && String(custom).trim()) ? String(custom).trim() : '';
                // Placeholder mostra il fallback (es. "Arco" / "Curva" / "Curva editata")
                curveInput.placeholder = String(node.data?.toolName || 'Curva');
            }
            this._bindCurveNameInput(id, el);
        }

        // SplitBranchRename (2026-05-05): per split_topology, popola i 2 INPUT
        // editabili A/B con il displayName custom utente (se presente in
        // `data.branchDisplayNames`) o con il filename derivato come fallback.
        // Naming default: `{stem}_snap_{nodeId}_{A|B}` (senza .stl per compattezza).
        // Skip aggiornamento input se l'utente sta digitando (focus): preserva
        // cursor e selezione (pattern coerente con _refreshAllToolWidgetsDOM).
        if (toolId === 'split_topology') {
            // DrawCurveSplitMeta V3.55 (2026-05-08): se il template DOM è di un
            // nodo split creato pre-V5.17 SplitBranchRename, mancano i 2 input
            // editabili .ibex-split-out-name-input. Drawflow `import()` ricostruisce
            // il DOM dal template HTML salvato, NON dal template aggiornato in
            // NodeBuilder. Iniettiamo gli input al volo se mancano (pattern
            // parallelo a _ensureMuteToggle / _ensureNodeDeleteBtn).
            this._ensureSplitOutputInputs(el);

            const inA = el.querySelector('.ibex-split-out-name-input[data-branch="A"]');
            const inB = el.querySelector('.ibex-split-out-name-input[data-branch="B"]');
            const branchNames = node.data.branchDisplayNames || { A: null, B: null };

            const fillInput = (input, branch, fallback, fallbackTitle) => {
                if (!input) return;
                if (document.activeElement === input) return; // skip durante digit
                const custom = branchNames[branch];
                input.value = (custom && String(custom).trim()) ? custom : (fallback || '');
                input.placeholder = fallback || '—';
                input.title = (custom ? `Custom: ${custom}` : `File: ${fallbackTitle || fallback}.stl`);
            };

            if (sculpted && meta.mesh_name) {
                const stem = String(meta.mesh_name).replace(/\.stl$/i, '');
                const nameA = `${stem}_snap_${nodeId}_A`;
                const nameB = `${stem}_snap_${nodeId}_B`;
                fillInput(inA, 'A', nameA, nameA);
                fillInput(inB, 'B', nameB, nameB);
                // Sblocca gli input solo dopo il primo applySplit (mesh derivate
                // esistono su disco con il loro meshName immutabile, il custom
                // è puramente UI label).
                if (inA) inA.disabled = false;
                if (inB) inB.disabled = false;
            } else {
                fillInput(inA, 'A', '', 'Output branch A (non ancora generato)');
                fillInput(inB, 'B', '', 'Output branch B (non ancora generato)');
                // Pre-applySplit: il meshName derivato non esiste ancora →
                // input disabled per evitare scritture su un meshName fantasma.
                if (inA) inA.disabled = true;
                if (inB) inB.disabled = true;
            }

            // Bind handler una volta sola per nodo (idempotente via flag).
            this._bindSplitNameInputs(id, el);
        }
    }

    /**
     * DrawCurveSplitMeta V3.55 (2026-05-08) — inietta i 2 input editabili
     * `.ibex-split-out-name-input` nel `.box` del nodo split_topology, se
     * mancanti.
     *
     * Motivo: nodi split creati pre-V5.17 SplitBranchRename hanno il template
     * HTML salvato in DB SENZA gli input. Drawflow `editor.import()` ricostruisce
     * il DOM dal template salvato, NON dal nuovo template di NodeBuilder. Senza
     * gli input, `_refreshSculptNodeDOM` querySelector fallisce silentemente
     * → label A/B mai popolate.
     *
     * Idempotente: se gli input già esistono, no-op.
     */
    _ensureSplitOutputInputs(nodeEl) {
        if (!nodeEl) return;
        // Se gli input già esistono, niente da fare.
        if (nodeEl.querySelector('.ibex-split-out-name-input[data-branch="A"]')
                && nodeEl.querySelector('.ibex-split-out-name-input[data-branch="B"]')) {
            return;
        }
        // Cerca il container `.box` (corpo del nodo).
        const box = nodeEl.querySelector('.box');
        if (!box) return;
        // Se il blocco `.ibex-split-outputs` esiste ma è vuoto/parziale,
        // rimuovilo per ricominciare pulito.
        const existingBlock = box.querySelector('.ibex-split-outputs');
        if (existingBlock) existingBlock.remove();
        // Costruisci il blocco DOM con gli input editabili.
        const block = document.createElement('div');
        block.className = 'ibex-split-outputs';
        block.innerHTML = `
            <div class="ibex-split-out" data-branch="A">
                <span class="ibex-split-out-badge">A</span>
                <input class="ibex-split-out-name-input" data-branch="A"
                       type="text"
                       title="Nome branch A (modificabile)"
                       placeholder="—"
                       spellcheck="false"
                       autocomplete="off"
                       disabled />
            </div>
            <div class="ibex-split-out" data-branch="B">
                <span class="ibex-split-out-badge">B</span>
                <input class="ibex-split-out-name-input" data-branch="B"
                       type="text"
                       title="Nome branch B (modificabile)"
                       placeholder="—"
                       spellcheck="false"
                       autocomplete="off"
                       disabled />
            </div>
        `;
        box.appendChild(block);
    }

    /**
     * CurveDisplayName V3.56 (2026-05-14) — inietta l'input editabile
     * `.ibex-curve-output-name-input` nel `.box` di un nodo produttore di
     * curva (arch_detect / draw_curve) se mancante.
     *
     * Motivo: progetti salvati pre-V5.16 hanno il template HTML cotto
     * SENZA il blocco `.ibex-curve-output`. Drawflow `import()` ricostruisce
     * dal template salvato → l'input non c'è → `_refreshSculptNodeDOM`
     * fallisce. Pattern identico a `_ensureSplitOutputInputs`.
     *
     * Idempotente: se l'input già esiste, no-op.
     */
    _ensureCurveOutputInput(nodeEl, toolName) {
        if (!nodeEl) return;
        if (nodeEl.querySelector('.ibex-curve-output-name-input')) return;
        const box = nodeEl.querySelector('.box');
        if (!box) return;
        // Rimuovi blocco parziale esistente.
        const existing = box.querySelector('.ibex-curve-output');
        if (existing) existing.remove();
        const block = document.createElement('div');
        block.className = 'ibex-curve-output';
        const placeholder = String(toolName || 'Curva');
        block.innerHTML = `
            <span class="ibex-curve-output-badge">CRV</span>
            <input class="ibex-curve-output-name-input"
                   type="text"
                   title="Nome curva (modificabile)"
                   placeholder="${placeholder}"
                   spellcheck="false"
                   autocomplete="off" />
        `;
        box.appendChild(block);
    }

    /**
     * SplitBranchRename (2026-05-05) — bind handlers focus/blur/Enter/Escape
     * sui 2 input editabili nel nodo split_topology. Idempotente via flag
     * `el.dataset.splitInputsBound`. Per ogni input:
     *   - focus     → select all + memorizza valore iniziale
     *   - blur/Enter → setMeshDisplayName(meshName, value || null) se cambiato
     *   - Escape    → revert al valore iniziale + blur
     * Il `meshName` è ricostruito al volo da `meta.mesh_name + nodeId + branch`.
     */
    _bindSplitNameInputs(nodeId, el) {
        if (!el || el.dataset.splitInputsBound === '1') return;
        el.dataset.splitInputsBound = '1';

        const inputs = el.querySelectorAll('.ibex-split-out-name-input');
        inputs.forEach(input => {
            input.addEventListener('focus', () => {
                input.dataset.initial = input.value || '';
                try { input.select(); } catch (e) {}
            });

            const commit = () => {
                if (!this.editor) return;
                const node = this.editor.getNodeFromId(parseInt(nodeId, 10));
                if (!node) return;
                const meta = node.data?.meta || {};
                if (!meta.mesh_name) return; // pre-applySplit, no meshName su cui scrivere
                const branch = input.dataset.branch;
                if (branch !== 'A' && branch !== 'B') return;

                const stem = String(meta.mesh_name).replace(/\.stl$/i, '');
                const meshName = `${stem}_snap_${nodeId}_${branch}.stl`;
                const newVal = (input.value || '').trim();
                const initial = input.dataset.initial || '';
                if (newVal === initial) return; // no change

                // null/empty → reset al fallback (default filename derivato)
                this.setMeshDisplayName(meshName, newVal || null);
            };

            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur(); // triggera commit
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    input.value = input.dataset.initial || '';
                    input.blur();
                }
            });
            // Stop drag/click propagation per evitare che Drawflow inizi a
            // trascinare il nodo mentre l'utente seleziona testo nell'input.
            ['mousedown', 'pointerdown'].forEach(evt => {
                input.addEventListener(evt, (e) => e.stopPropagation());
            });
        });
    }

    _refreshAllSculptNodesDOM() {
        if (!this.editor) return;
        // S3 (2026-04-25): refresh anche per delete_topology + split_topology.
        const DESTRUCTIVE_UI_TOOLS = new Set(['sculpt', 'delete_topology', 'split_topology', 'topology_rebuild', 'draw_curve', 'arch_detect', 'curve_edit']);
        try {
            const data = this.editor.export()?.drawflow?.Home?.data || {};
            Object.keys(data).forEach(id => {
                if (DESTRUCTIVE_UI_TOOLS.has(data[id]?.data?.toolId)) {
                    this._refreshSculptNodeDOM(id);
                }
            });
        } catch (e) { /* non critico */ }
    }

    // ═══════════════════════════════════════════════════════════════
    // V3.16 (2026-04-25) — Setter centralizzato displayName.
    //
    // Il grafo Drawflow è la single source of truth (Invariante 98). Ogni
    // mutazione di `displayName` deve passare per qui — scrive nel grafo
    // (per tutti i nodi mesh con `data.meshName === meshName`), persiste
    // via `editor.updateNodeDataFromId`, aggiorna il `.title-box` DOM dei
    // nodi DAG, e refresha l'InspectorPanel se aperto su quella mesh.
    // OutlinerManager._applyDisplayRename delega completamente a questo
    // metodo (la riga outliner viene aggiornata localmente dal finalize
    // del rename via `nameSpan.innerText`).
    // ═══════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════
    // V3.19 (2026-04-25) — Getter pubblico displayName, speculare a setter.
    //
    // Lookup live nel grafo Drawflow del primo nodo mesh con
    // `data.meshName === meshName`; ritorna `data.displayName` se presente,
    // altrimenti fallback allo stem `.stl`-stripped del meshName. Riusabile
    // da OutlinerManager._getDisplayName e ContextInspector._buildHtml
    // (rimuovono la duplicazione del lookup inline).
    // ═══════════════════════════════════════════════════════════════
    /**
     * Helper privato: parse mesh derivate split (`{stem}_snap_{nodeId}_{A|B}.stl`).
     * Ritorna `{stem, nodeId, branch}` se match, null altrimenti.
     * Il regex tollera nodeId alphanumerici (Drawflow usa interi ma la whitelist
     * worker `^[a-zA-Z0-9_\-]+$` è più ampia per future estensioni).
     */
    _parseSplitDerivedMeshName(meshName) {
        if (!meshName) return null;
        const m = String(meshName).match(/^(.+)_snap_([A-Za-z0-9_\-]+)_([AB])\.stl$/i);
        if (!m) return null;
        return { stem: m[1], nodeId: m[2], branch: m[3].toUpperCase() };
    }

    getMeshDisplayName(meshName) {
        if (!meshName) return '';
        if (this.editor) {
            // SplitBranchRename (2026-05-05): se è una mesh derivata da split,
            // legge displayName da `node.data.branchDisplayNames[branch]` del
            // nodo split_topology con quel nodeId. Fallback al filename se non set.
            const split = this._parseSplitDerivedMeshName(meshName);
            if (split) {
                try {
                    const node = this.editor.getNodeFromId(parseInt(split.nodeId, 10));
                    if (node?.data?.toolId === 'split_topology') {
                        const custom = node.data?.branchDisplayNames?.[split.branch];
                        if (custom && String(custom).trim()) return String(custom);
                    }
                } catch (e) { /* non critico */ }
                // Fallback al filename derivato (senza .stl).
                return String(meshName).replace(/\.stl$/i, '');
            }

            // Mesh source: cerca un nodo mesh con `data.meshName === meshName`.
            try {
                const data = this.editor.export()?.drawflow?.Home?.data || {};
                for (const id of Object.keys(data)) {
                    const node = data[id];
                    if (node?.name === 'mesh'
                        && node?.data?.meshName === meshName
                        && node?.data?.displayName) {
                        return node.data.displayName;
                    }
                }
            } catch (e) { /* non critico */ }
        }
        return String(meshName).replace(/\.stl$/i, '');
    }

    setMeshDisplayName(meshName, displayName) {
        if (!this.editor || !meshName) return;

        // SplitBranchRename (2026-05-05): se è una mesh derivata da split,
        // scrive in `node.data.branchDisplayNames[branch]` del nodo split.
        // null/empty → reset al fallback (default filename derivato).
        const split = this._parseSplitDerivedMeshName(meshName);
        if (split) {
            const splitId = parseInt(split.nodeId, 10);
            try {
                const node = this.editor.getNodeFromId(splitId);
                if (node?.data?.toolId === 'split_topology') {
                    const branchNames = { ...(node.data.branchDisplayNames || { A: null, B: null }) };
                    const newVal = (displayName && String(displayName).trim()) ? String(displayName).trim() : null;
                    branchNames[split.branch] = newVal;
                    node.data.branchDisplayNames = branchNames;
                    try { this.editor.updateNodeDataFromId(splitId, node.data); }
                    catch (e) { /* non critico */ }
                    // Re-render input nel nodo (sblocca cursor focus mantenendo coerenza)
                    this._refreshSculptNodeDOM(splitId);
                }
            } catch (e) { /* non critico */ }

            // Refresh outliner (riga mesh derivata mostra ora il custom).
            try { window.ibex?.outlinerMgr?.update?.(); } catch (e) {}

            // Refresh InspectorPanel se aperto sulla derivata corrente.
            const panel = window.ibex?.inspectorPanel;
            if (panel?.isOpen
                && panel.currentMeshName === meshName
                && typeof panel.refresh === 'function') {
                panel.refresh();
            }
            // L3: passo di undo regolare (stesso pattern degli altri call-site).
            this.pushUndoSnapshot();
            return;
        }

        // Pattern esistente per mesh source.
        let data;
        try { data = this.editor.export()?.drawflow?.Home?.data || {}; }
        catch (e) { return; }

        // 1. Scrivi nel grafo per tutti i nodi mesh col meshName richiesto
        //    + aggiorna il `.title-box` DOM in-place.
        for (const id of Object.keys(data)) {
            const node = data[id];
            if (!node || node.name !== 'mesh') continue;
            if (node.data?.meshName !== meshName) continue;
            node.data.displayName = displayName;
            try { this.editor.updateNodeDataFromId(parseInt(id, 10), node.data); }
            catch (e) { /* non critico */ }
            const el = document.getElementById(`node-${id}`);
            const tb = el?.querySelector('.title-box');
            this._setTitleText(tb, displayName);
        }

        // 2. Refresha InspectorPanel se aperto su questa mesh.
        const panel = window.ibex?.inspectorPanel;
        if (panel?.isOpen
            && panel.currentMeshName === meshName
            && typeof panel.refresh === 'function') {
            panel.refresh();
        }

        // 3. V3.17 — Riallinea la label dei nodi destructive (lo stem visivo
        //    è il displayName, vedi `_refreshDestructiveNodeLabels`).
        this._refreshDestructiveNodeLabels();
        // L3: passo di undo regolare (stesso pattern degli altri call-site).
        this.pushUndoSnapshot();
    }

    // ═══════════════════════════════════════════════════════════════
    // NodeSkin V3.63 (2026-07-09) — writer unico del titolo nodo.
    //
    // La testata legge è `.title-box > span.tt` (ellipsis). I vecchi
    // writer facevano `tb.textContent = x`, che SPAZZA tutti i figli
    // (mute toggle incluso — sopravviveva solo perché un refresher lo
    // re-iniettava dopo). Questo helper scrive SOLO nello span .tt e,
    // sui nodi legacy (HTML persistito in ui_graph senza .tt), migra
    // in-place: rimuove i soli text-node e crea lo span come primo
    // figlio, preservando toggle/bottoni. Convergenza al primo open.
    // ═══════════════════════════════════════════════════════════════
    _setTitleText(tb, text) {
        if (!tb) return;
        let tt = tb.querySelector('span.tt');
        if (!tt) {
            tt = document.createElement('span');
            tt.className = 'tt';
            [...tb.childNodes].forEach(n => { if (n.nodeType === 3) tb.removeChild(n); });
            tb.insertBefore(tt, tb.firstChild);
        }
        if (tt.textContent !== text) tt.textContent = text;
    }

    // ═══════════════════════════════════════════════════════════════
    // V3.16 (2026-04-25) — Hook post-import per ri-applicare displayName.
    //
    // Drawflow `editor.import` ricostruisce i nodi dall'HTML raw salvato
    // (cotto al primo `addNode` con `cleanInitial = stem`). Il
    // `data.displayName` aggiornato post-rename persiste nel payload via
    // save_exit ma il DOM al reload mostra il vecchio. Pattern identico
    // a `_refreshAllSculptNodesDOM` ma per `data.displayName` su nodi mesh.
    // Chiamato nel setTimeout 200ms post-import.
    // ═══════════════════════════════════════════════════════════════
    _refreshAllMeshNodeTitles() {
        if (!this.editor) return;
        let data;
        try { data = this.editor.export()?.drawflow?.Home?.data || {}; }
        catch (e) { return; }
        for (const id of Object.keys(data)) {
            const node = data[id];
            if (!node || node.name !== 'mesh') continue;
            const displayName = node.data?.displayName;
            if (!displayName) continue;
            const el = document.getElementById(`node-${id}`);
            const tb = el?.querySelector('.title-box');
            this._setTitleText(tb, displayName);
        }
    }

    /**
     * V14.0 (2026-05-13) — Pattern speculare a _refreshAllMeshNodeTitles ma
     * per i tool nodes (non-mesh). Riapplica `node.data.toolName` al `.title-box`
     * DOM post-import. Necessario perché Drawflow `import()` ricostruisce dal
     * template HTML cotto al primo `addNode` (es. "Rileva Arcata" pre-rename);
     * la migrazione `_migrateLegacyToolIds` aggiorna `node.data.toolName` ma
     * NON il DOM. Questo hook fa il sync.
     */
    _refreshAllToolNodeTitles() {
        if (!this.editor) return;
        let data;
        try { data = this.editor.export()?.drawflow?.Home?.data || {}; }
        catch (e) { return; }
        for (const id of Object.keys(data)) {
            const node = data[id];
            if (!node || node.name === 'mesh') continue;  // skip mesh — gestiti altrove
            const toolName = node.data?.toolName;
            if (!toolName) continue;
            const el = document.getElementById(`node-${id}`);
            const tb = el?.querySelector('.title-box');
            this._setTitleText(tb, toolName);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CurveDisplayName V3.56 (2026-05-14) — Curve come "oggetti
    // indipendenti" con display name editabile.
    //
    // Schema: `node.data.curveDisplayName` (string | null) sui nodi
    // produttori di curve (toolId ∈ {arch_detect, draw_curve}). null =
    // fallback al `node.data.toolName` (es. "Rileva Arco" / "Disegna Curva").
    //
    // Edit points (tre modalità identiche):
    //  - input editabile `.ibex-curve-output-name-input` nel template
    //    DAG → bound da `_bindCurveNameInput`;
    //  - dblclick sulla riga curva nell'outliner → input inline
    //    (OutlinerManager._startCurveRename);
    //  - (futuro) header InspectorPanel quando il nodo produttore è
    //    selezionato.
    //
    // Persistenza automatica via Drawflow `editor.export()` →
    // `session_settings.ui_graph` → `manifest.session.ui_graph`.
    // ═══════════════════════════════════════════════════════════════
    getCurveDisplayName(nodeId) {
        if (!this.editor) return '';
        try {
            const node = this.editor.getNodeFromId(parseInt(nodeId, 10));
            if (!node || !node.data) return '';
            const custom = node.data.curveDisplayName;
            if (custom && String(custom).trim()) return String(custom).trim();
            // Fallback al toolName (es. "Rileva Arco")
            return String(node.data.toolName || node.data.name || `Curva (nodo ${nodeId})`);
        } catch (e) {
            return '';
        }
    }

    setCurveDisplayName(nodeId, displayName) {
        if (!this.editor) return;
        const id = parseInt(nodeId, 10);
        let node;
        try { node = this.editor.getNodeFromId(id); }
        catch (e) { return; }
        if (!node || !node.data) return;

        // V5.18 (2026-05-14): curve_edit RIMOSSO — non ha display name
        // proprio (la curva editata mantiene l'identità del producer upstream).
        const allowed = new Set(['arch_detect', 'draw_curve']);
        if (!allowed.has(node.data.toolId)) return;

        const newVal = (displayName && String(displayName).trim()) ? String(displayName).trim() : null;
        node.data.curveDisplayName = newVal;
        try { this.editor.updateNodeDataFromId(id, node.data); }
        catch (e) { /* non critico */ }

        // Re-populate input nel DOM nodo DAG (skip durante focus per cursor preservation)
        try {
            const el = document.getElementById(`node-${id}`);
            const input = el?.querySelector('.ibex-curve-output-name-input');
            if (input && document.activeElement !== input) {
                input.value = newVal || '';
            }
        } catch (e) {}

        // Refresh outliner (riga curva mostra ora il custom).
        try { window.ibex?.outlinerMgr?.update?.(); } catch (e) {}
        // L3: passo di undo regolare (stesso pattern degli altri call-site).
        this.pushUndoSnapshot();
    }

    /**
     * Bind handler `change/Enter/Escape` sull'input
     * `.ibex-curve-output-name-input` di un nodo produttore curva.
     * Idempotente via flag `dataset.curveInputBound`.
     */
    _bindCurveNameInput(nodeId, el) {
        if (!el || el.dataset.curveInputBound === '1') return;
        const input = el.querySelector('.ibex-curve-output-name-input');
        if (!input) return;
        el.dataset.curveInputBound = '1';

        input.addEventListener('focus', () => {
            input.dataset.initial = input.value || '';
            try { input.select(); } catch (e) {}
        });

        const commit = () => {
            const newVal = (input.value || '').trim();
            const initial = input.dataset.initial || '';
            if (newVal === initial) return;
            // null/empty → reset al fallback (default toolName)
            this.setCurveDisplayName(nodeId, newVal || null);
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur(); // triggera commit
            } else if (e.key === 'Escape') {
                e.preventDefault();
                input.value = input.dataset.initial || '';
                input.blur();
            }
        });
        // Stop drag/click propagation per evitare che Drawflow inizi a
        // trascinare il nodo mentre l'utente seleziona testo nell'input.
        ['mousedown', 'pointerdown'].forEach(evt => {
            input.addEventListener(evt, (e) => e.stopPropagation());
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // NodeMute (2026-05-05) — Houdini bypass / Blender mute pattern.
    //
    // Quando un nodo è muted:
    //   • resta presente nel DAG e nel grafo persistito (node.data.muted=true);
    //   • il worker `apply_tier1_queue` legge `step.params._muted` e fa
    //     passthrough invece del compute (skip cache + skip dispatch tool);
    //   • visualmente il nodo appare "spento" (opacity 0.4 + strip grigia
    //     via classe `.ibex-node-muted`);
    //   • cambio mute triggera bake (cambia `step.params._muted` → diff in
    //     BakeEngine.hasChanges → re-bake con passthrough applicato).
    //
    // Mesh nodes non sono mutabili: sono input source, niente compute da
    // skippare. toggleNodeMute filtra esplicitamente `node.name === 'mesh'`.
    // ═══════════════════════════════════════════════════════════════
    toggleNodeMute(nodeId) {
        if (!this.editor) return;
        const node = this.editor.getNodeFromId(nodeId);
        if (!node || !node.data) return;
        // Mesh nodes non hanno computation — no-op silenzioso.
        if (node.name === 'mesh') return;

        const newMuted = !node.data.muted;
        const newData = { ...node.data, muted: newMuted };
        this.editor.updateNodeDataFromId(nodeId, newData);

        // Sync DOM feedback visivo IMMEDIATO (senza aspettare bake/refresh):
        //   • `.ibex-node-muted` sul wrapper nodo (opacity + pattern title-box)
        //   • `.is-muted` sul bottone interno `.ibex-mute-toggle` (icona open/closed)
        const el = document.getElementById(`node-${nodeId}`);
        if (el) {
            el.classList.toggle('ibex-node-muted', newMuted);
            const btn = el.querySelector('.ibex-mute-toggle');
            if (btn) btn.classList.toggle('is-muted', newMuted);
        }

        // Refresh inspector se aperto sulla mesh corrente (per aggiornare
        // l'etichetta del bottone Mute → Riattiva e viceversa)
        try {
            window.ibex?.inspectorPanel?.refresh?.();
        } catch (e) { /* silent */ }

        // Trigger bake — il diff su `step.params._muted` farà partire il worker
        this.syncAndBake();
        // L3: passo di undo regolare (stesso pattern degli altri call-site).
        this.pushUndoSnapshot();
    }

    // V3.43 (2026-05-05) — ricolora i socket pin dei nodi DAG dopo `editor.import()`.
    // `_colorDrawflowPorts` di NodeBuilder applica `borderColor` inline su ogni
    // socket al momento di `addNode` (prima creazione del nodo). Drawflow `import`
    // ricostruisce il DOM dal template HTML salvato (cotto al primo addNode con
    // class CSS pure) → gli inline style applicati runtime sono persi → tutti
    // i socket appaiono grigi (default Drawflow). Helper itera ogni nodo del
    // grafo e re-applica i colori dai metadata `node.data.inPorts/outPorts/
    // panelId`. Costo: O(N_nodi × N_socket_per_nodo), trascurabile post-import.
    // NodeSkin V3.64 — recolor mirato di UN nodo (per i listener di
    // connessione: aggiorna lo stato .filled dei soli 2 nodi toccati).
    _recolorNodeSockets(id) {
        if (!this.editor || !this.nodeBuilder) return;
        let node;
        try { node = this.editor.getNodeFromId(id); } catch (e) { return; }
        if (!node) return;
        const inKeys  = node.name === 'mesh' ? [] : (node.data?.inPorts || []);
        const outKeys = node.name === 'mesh' ? ['OUT_GEO_Mesh'] : (node.data?.outPorts || []);
        try { this.nodeBuilder._colorDrawflowPorts(id, inKeys, outKeys, node.data?.panelId || ''); }
        catch (e) { /* non critico */ }
    }

    _recolorAllSockets() {
        if (!this.editor || !this.nodeBuilder) return;
        let data;
        try { data = this.editor.export()?.drawflow?.Home?.data || {}; }
        catch (e) { return; }
        for (const id of Object.keys(data)) {
            const node = data[id];
            if (!node) continue;
            // Mesh nodes: 0 inputs, 1 output (OUT_GEO_Mesh). Tool nodes: salvato
            // esplicitamente in node.data.inPorts/outPorts da NodeBuilder.addTool
            // e dai costruttori dedicati `_addSculptNode/_addDeleteTopologyNode/
            // _addSplitTopologyNode/_addExportNode`.
            let inKeys, outKeys, panelId;
            if (node.name === 'mesh') {
                inKeys = [];
                outKeys = ['OUT_GEO_Mesh'];
                panelId = node.data?.panelId || '';
            } else {
                inKeys = node.data?.inPorts || [];
                outKeys = node.data?.outPorts || [];
                panelId = node.data?.panelId || '';
            }
            try {
                this.nodeBuilder._colorDrawflowPorts(id, inKeys, outKeys, panelId);
            } catch (err) {
                console.warn('[StackManager] socket recolor failed for node', id, err);
            }
        }
    }

    _refreshAllMutedClasses() {
        if (!this.editor) return;
        let data;
        try { data = this.editor.export()?.drawflow?.Home?.data || {}; }
        catch (e) { return; }
        for (const id of Object.keys(data)) {
            const node = data[id];
            if (!node) continue;
            const muted = !!(node.data && node.data.muted);
            const el = document.getElementById(`node-${id}`);
            if (!el) continue;
            el.classList.toggle('ibex-node-muted', muted);
            // Mesh nodes non hanno computation → nessun mute toggle.
            // export_stl: no_backend, niente da skippare.
            const skipToggle = (node.name === 'mesh') || (node.data?.toolId === 'burn');
            if (!skipToggle) {
                this._ensureMuteToggle(el, id, muted);
            }
            // V3.40 — bottone X delete nodo. Visibile solo su `.drawflow-node.selected`
            // (CSS handles visibility); injectato qui in modo idempotente.
            this._ensureNodeDeleteBtn(el, id, node.name);
        }
    }

    // V3.40 (2026-05-05) — bottone X tondo rosso in alto-sx del nodo per
    // eliminarlo dal DAG. Visibile SOLO quando il nodo è selezionato
    // (`.drawflow-node.selected`, classe applicata da Drawflow al click sx).
    // Skippa i mesh nodes per evitare la rimozione accidentale di un input
    // source (l'utente li elimina via outliner o trascinandoli fuori dal DAG).
    // Click → `editor.removeNodeId('node-' + id)` → triggera il listener
    // `nodeRemoved` (vedi _registerDrawflowHandlers) che fa syncAndBake.
    _ensureNodeDeleteBtn(el, nodeId, nodeName) {
        if (nodeName === 'mesh') return; // skip mesh source nodes
        if (el.querySelector('.ibex-node-delete-btn')) return; // already injected
        const btn = document.createElement('span');
        btn.className = 'ibex-node-delete-btn';
        btn.title = 'Elimina nodo';
        btn.innerHTML = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
            '<path d="M2.5 2.5 L7.5 7.5 M7.5 2.5 L2.5 7.5" stroke="currentColor" ' +
            'stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';
        btn.addEventListener('mousedown', (e) => e.stopPropagation()); // no drag node
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            try { this.editor.removeNodeId('node-' + nodeId); }
            catch (err) { console.warn('[StackManager] removeNodeId failed:', err); }
            // syncAndBake è già triggered dal listener `nodeRemoved`
        });
        el.appendChild(btn);
    }

    // NodeMute (2026-05-05) — inietta il bottone "M" nel title-box del nodo
    // DAG se mancante. Chiamato da `_refreshAllMutedClasses` (post-import o
    // post-addNode). Idempotent: se il bottone esiste già, aggiorna solo lo
    // stato `is-muted`. Pattern: `<span class="ibex-mute-toggle">M</span>` nel
    // title-box. Click toggle mute via stopPropagation per non innescare il
    // drag/select del nodo Drawflow.
    _ensureMuteToggle(el, nodeId, muted) {
        const titleBox = el.querySelector('.title-box');
        if (!titleBox) return;
        let btn = titleBox.querySelector('.ibex-mute-toggle');
        if (!btn) {
            btn = document.createElement('span');
            btn.className = 'ibex-mute-toggle';
            btn.title = 'Mute / Bypass nodo (M con nodo selezionato)';
            btn.innerHTML = StackManager.muteToggleSvg();
            btn.addEventListener('mousedown', (e) => e.stopPropagation()); // no drag node
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.toggleNodeMute(String(nodeId));
            });
            titleBox.appendChild(btn);
        }
        btn.classList.toggle('is-muted', muted);
    }

    // NodeMute (2026-05-05) — interruttore stilizzato SVG inline.
    // Due SVG nello stesso bottone: `.icon-closed` (default, circuito chiuso,
    // due cerchi-terminali connessi da linea orizzontale) e `.icon-open`
    // (stato muted, leva alzata e disconnessa). Toggle via CSS sulla classe
    // `.is-muted` del bottone genitore. Helper static perché non dipende da
    // istanze, e il ContextInspector lo usa per l'inspector.
    static muteToggleSvg() {
        return `
            <svg class="ibex-mute-icon icon-closed" viewBox="0 0 18 10" aria-hidden="true">
                <circle cx="2.5" cy="5" r="1.6" fill="currentColor"/>
                <circle cx="15.5" cy="5" r="1.6" fill="currentColor"/>
                <line x1="4.1" y1="5" x2="13.9" y2="5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
            <svg class="ibex-mute-icon icon-open" viewBox="0 0 18 10" aria-hidden="true">
                <circle cx="2.5" cy="5" r="1.6" fill="currentColor"/>
                <circle cx="15.5" cy="5" r="1.6" fill="currentColor"/>
                <line x1="4.1" y1="5" x2="12.5" y2="0.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
        `;
    }

    // ═══════════════════════════════════════════════════════════════
    // ExportNodeSTL (2026-05-03) — fix "valori reset alla riapertura"
    //
    // Drawflow `editor.import()` ricostruisce il DOM dal template HTML
    // originale cotto al primo `addNode` (`value="${defaultValue}"`).
    // Modifiche successive aggiornano `node.data.params` ma il template
    // salvato mantiene i valori iniziali → input visualizzano default
    // invece dei valori correnti.
    //
    // Helper generico applica `data.params[K]` ai widget `[data-key=K]`
    // del nodo DAG. Pattern speculare a `_syncWidgetValue` (singolo param)
    // ma per TUTTI i tool node + TUTTI i loro params. Skip metadata
    // interna (cavi `IN_*`, `world_matrix`, `_snapshot_node_id`).
    //
    // Hookato post-import in `loadFromConfig` setTimeout(200).
    // ═══════════════════════════════════════════════════════════════
    _refreshAllToolWidgetsDOM() {
        if (!this.editor) return;
        let data;
        try { data = this.editor.export()?.drawflow?.Home?.data || {}; }
        catch (e) { return; }

        const isInternalKey = (k) => k.startsWith('IN_') || k === 'world_matrix' || k === '_snapshot_node_id';

        for (const id of Object.keys(data)) {
            const node = data[id];
            if (!node || (node.name !== 'tool' && node.class !== 'tool')) continue;
            const params = node.data?.params || {};
            const nodeEl = document.getElementById(`node-${id}`);
            if (!nodeEl) continue;

            for (const [key, value] of Object.entries(params)) {
                if (isInternalKey(key)) continue;
                const sel = `[data-key="${CSS.escape(key)}"]`;
                const all = Array.from(nodeEl.querySelectorAll(sel));
                const inputs = all.filter(el =>
                    el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
                );
                if (!inputs.length) continue;

                if (Array.isArray(value)) {
                    // Vector vec3: 3 input X/Y/Z in ordine DOM
                    const slice = inputs.slice(0, 3);
                    for (let i = 0; i < slice.length; i++) {
                        const inp = slice[i];
                        const v = (i < value.length) ? value[i] : 0;
                        if (inp.tagName === 'INPUT') inp.value = v;
                    }
                } else {
                    for (const inp of inputs) {
                        if (inp.type === 'checkbox') inp.checked = !!value;
                        else if (inp.tagName === 'SELECT') inp.value = value;
                        else inp.value = (value == null ? '' : value);
                    }
                }
            }
        }
    }

    // Refresh widget CUSTOM dei nodi export (button label "Cartella",
    // input filename, status "ultimo export"). Pattern non standard
    // [data-key] perché il button non ha attributo `value`. Hook usato:
    //   - post-import in loadFromConfig
    //   - dopo ExportPicker.execute / _selectCurrent / _fillFilenameFromExisting
    //     (per tener button label sincronizzato durante editing).
    _refreshAllExportNodesDOM() {
        if (!this.editor) return;
        let data;
        try { data = this.editor.export()?.drawflow?.Home?.data || {}; }
        catch (e) { return; }
        for (const id of Object.keys(data)) {
            const node = data[id];
            if (!node || node.data?.toolId !== 'burn') continue;
            this._refreshSingleExportNode(id);
        }
    }

    _refreshSingleExportNode(nodeId) {
        const node = this.editor?.getNodeFromId?.(parseInt(nodeId, 10));
        if (!node || node.data?.toolId !== 'burn') return;
        const params = node.data?.params || {};
        const meta   = node.data?.meta   || {};
        const dirPath = params.directory_path || '';
        const filenameOverride = params.filename_override || '';

        const nodeEl = document.getElementById(`node-${nodeId}`);
        if (!nodeEl) return;

        const dirBtn = nodeEl.querySelector('.ibex-export-dir-btn');
        if (dirBtn) {
            // IBEX-27-7 radice — '/' = radice scelta, '' = mai scelta. Testo
            // IDENTICO al gemello in ContextInspector (Inv. 123).
            dirBtn.textContent = dirPath === '/' ? '📁 / — cartella principale'
                               : dirPath ? `📁 ${dirPath}`
                               : '📁 — Scegli cartella —';
        }
        const filenameInput = nodeEl.querySelector('.ibex-export-filename');
        if (filenameInput && document.activeElement !== filenameInput) {
            // skip se l'utente sta digitando per non interferire col cursore
            filenameInput.value = filenameOverride;
        }
        // IBEX-EXPORT-27-7 §B — serve solo al RIPRISTINO: _refreshAllExportNodesDOM
        // gira dopo il load e riporta il selettore sul valore salvato. Durante
        // l'uso ci pensa gia' _syncWidgetValue (il <select> segue [data-key]).
        const fmtSel = nodeEl.querySelector('.ibex-export-format');
        if (fmtSel) fmtSel.value = (params.format_override || 'stl');
        if (meta.last_export_at && meta.last_export_path) {
            const dt = new Date(meta.last_export_at * 1000);
            const dts = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
            const statusEl = nodeEl.querySelector('.ibex-export-status');
            if (statusEl) {
                statusEl.dataset.state = 'ok';
                statusEl.textContent = `OK · ${meta.last_export_path} · ${dts}`;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // SnapshotKeyed Session 1 (2026-04-23) — lista nodi destructive nel DAG.
    //
    // Rimpiazzo hard di `getSculptedMeshNames()`. Ritorna
    //   [{mesh: "Upper.stl", nodeId: "5"}, ...]
    // invece di solo nomi mesh, perché gli snapshot sono keyed per nodeId:
    // due nodi sculpt sullo stesso target producono file distinti
    // `{stem}_snap_{nodeIdA}.stl` e `{stem}_snap_{nodeIdB}.stl`.
    //
    // Usata da IbexCore.saveAndExit, propagata a PHP → worker SAVE_EXIT per
    // lazy cleanup dei file snapshot orfani (nodi rimossi dal DAG lasciano
    // il file su disco finché save_exit non lo pulisce).
    //
    // Filtro: tutti i nodi con `n.destructive === true` (non solo sculpt, così
    // Sessioni future S2/S3 — delete_topology, split_topology — funzionano
    // senza modifiche qui).
    //
    // Robustezza ereditata:
    //   1. Usa `extractDAG()` fresh (non `this.graph` cached) — se il nodo è
    //      stato aggiunto dopo l'ultima sync, `this.graph` potrebbe essere stale.
    //   2. Fallback su `node.data.meta.mesh_name`: SculptMode.exit scrive lì il
    //      nome mesh al success del save. Se il nodo è disconnesso ma
    //      meta.mesh_name è presente, il file viene comunque preservato.
    // ═══════════════════════════════════════════════════════════════
    getSnapshotNodes() {
        if (!this.editor) return [];
        const graph = this.extractDAG();
        const out = [];
        const seen = new Set();  // dedup su chiave "{mesh}|{nodeId}"
        graph.nodes
            .filter(n => n.destructive === true)
            .forEach(n => {
                const nodeId = String(n.id);
                let meshName = null;

                // Primary: risolvi tramite edge IN_GEO_Mesh (o target generico)
                const edges = graph.edges.filter(e => String(e.to_node) === nodeId);
                if (edges.length) {
                    const geoEdge = edges.find(e => e.role === 'IN_GEO_Mesh')
                                 || edges.find(e => !e.role || e.role === 'target')
                                 || edges[0];
                    const baseName = this.resolveBaseMesh(geoEdge.from_mesh, geoEdge.from_port);
                    if (baseName) meshName = baseName;
                }
                // Fallback: meta.mesh_name (scritto da SculptMode.exit al save)
                if (!meshName) {
                    const rawNode = this.editor.getNodeFromId(parseInt(nodeId, 10));
                    const metaMesh = rawNode?.data?.meta?.mesh_name;
                    if (metaMesh && typeof metaMesh === 'string') meshName = metaMesh;
                }
                if (!meshName) return;

                const key = `${meshName}|${nodeId}`;
                if (seen.has(key)) return;
                seen.add(key);
                out.push({ mesh: meshName, nodeId });
            });
        return out;
    }

    addMeshNode(name, x, y) { this.nodeBuilder.addMeshNode(name, x, y); }
    addTool(config, x, y) { this.nodeBuilder.addTool(config, x, y); }

    // ═══════════════════════════════════════════════════════════════
    // Preset DAG (2026-05-05) — Marquee selection + multi-select state
    // ═══════════════════════════════════════════════════════════════

    _createMarqueeOverlay() {
        // DOM div fisso z-index 62 (sopra DAG overlay z:60). Border arancione
        // tratteggiato + sfondo accent tenue. Pattern coerente con
        // SelectionMode brush overlay.
        const ov = document.createElement('div');
        ov.id = 'ibex-marquee-overlay';
        ov.style.cssText = [
            'position:fixed', 'pointer-events:none', 'z-index:62',
            'border:1.5px dashed var(--ibex-accent, #FF6037)',
            'background:rgba(255,96,55,0.08)',
            'border-radius:2px', 'box-sizing:border-box',
        ].join(';');
        document.body.appendChild(ov);
        return ov;
    }

    _updateMarqueeOverlay(m) {
        if (!m || !m.overlay) return;
        const left = Math.min(m.startClientX, m.currentClientX);
        const top  = Math.min(m.startClientY, m.currentClientY);
        const w    = Math.abs(m.currentClientX - m.startClientX);
        const h    = Math.abs(m.currentClientY - m.startClientY);
        m.overlay.style.left   = left + 'px';
        m.overlay.style.top    = top  + 'px';
        m.overlay.style.width  = w    + 'px';
        m.overlay.style.height = h    + 'px';
    }

    _applyMarqueeSelection(rectClient) {
        if (!this.editor) return;
        if (!this.multiSelectedSet) this.multiSelectedSet = new Set();
        // Replace mode (no Shift+drag additivo in V1).
        const previouslySelected = new Set(this.multiSelectedSet);
        this.multiSelectedSet.clear();

        let data;
        try { data = this.editor.export()?.drawflow?.Home?.data || {}; }
        catch (e) { return; }

        for (const id of Object.keys(data)) {
            const node = data[id];
            if (!node) continue;
            // Filtra mesh source + export_stl (non parte di un preset)
            if (node.name === 'mesh') continue;
            if (node.data?.toolId === 'burn') continue;
            const el = document.getElementById(`node-${id}`);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            // AABB intersect: any-pixel-inside-marquee → selezionato
            const intersects = !(
                r.right  < rectClient.left ||
                r.left   > rectClient.right ||
                r.bottom < rectClient.top ||
                r.top    > rectClient.bottom
            );
            if (intersects) this.multiSelectedSet.add(String(id));
        }

        // Apply/remove `.ibex-multi-selected` class — DOM update mirato.
        const allChanged = new Set([...previouslySelected, ...this.multiSelectedSet]);
        for (const id of allChanged) {
            const el = document.getElementById(`node-${id}`);
            if (el) el.classList.toggle('ibex-multi-selected', this.multiSelectedSet.has(id));
        }
        this._onMultiSelectChanged();
    }

    clearMultiSelection() {
        if (!this.multiSelectedSet || this.multiSelectedSet.size === 0) return;
        for (const id of this.multiSelectedSet) {
            const el = document.getElementById(`node-${id}`);
            if (el) el.classList.remove('ibex-multi-selected');
        }
        this.multiSelectedSet.clear();
        this._onMultiSelectChanged();
    }

    _onMultiSelectChanged() {
        // Trigger floating bar visibility (Fase 3). DOM stub: se la bar
        // non esiste ancora (caricamento parziale) → no-op silenzioso.
        const bar = document.getElementById('ibex-multiselect-bar');
        if (!bar) return;
        const n = this.multiSelectedSet ? this.multiSelectedSet.size : 0;
        bar.classList.toggle('hidden', n === 0);
        const counter = bar.querySelector('.ibex-mb-count');
        if (counter) counter.textContent = `${n} ${n === 1 ? 'nodo selezionato' : 'nodi selezionati'}`;
    }

    // Preset DAG (2026-05-05) — costruisce il payload JSON da salvare a partire
    // dal multiSelectedSet corrente. Posizioni relative all'ancora (primo
    // nodo iterato). Connessioni interne preservate; connessioni "esterne"
    // (verso nodi non nel set, es. mesh source o downstream export) scartate.
    // Filtro defensive mesh + export_stl (anche se _applyMarqueeSelection già
    // li skippa).
    extractPresetPayload() {
        if (!this.editor || !this.multiSelectedSet || this.multiSelectedSet.size === 0) {
            return { version: '1.0', nodes: [], connections: [] };
        }
        let data;
        try { data = this.editor.export()?.drawflow?.Home?.data || {}; }
        catch (e) { return { version: '1.0', nodes: [], connections: [] }; }

        // Filtra il set: solo tool effettivi (defensive)
        const validIds = [...this.multiSelectedSet].filter(id => {
            const n = data[id];
            if (!n) return false;
            if (n.name === 'mesh') return false;
            if (n.data?.toolId === 'burn') return false;
            return true;
        });
        if (validIds.length === 0) {
            return { version: '1.0', nodes: [], connections: [] };
        }

        // Anchor = nodo con pos_x minimo. Se tie, primo dell'iterazione.
        let anchorId = validIds[0];
        let anchorX = data[anchorId].pos_x ?? 0;
        let anchorY = data[anchorId].pos_y ?? 0;
        for (const id of validIds) {
            const n = data[id];
            if ((n.pos_x ?? 0) < anchorX) {
                anchorId = id;
                anchorX = n.pos_x ?? 0;
                anchorY = n.pos_y ?? 0;
            }
        }

        // Mappa Drawflow id (string) → local_id contatore.
        const localOf = {};
        let counter = 1;
        for (const id of validIds) localOf[id] = counter++;

        // Nodes
        const nodes = validIds.map(id => {
            const n = data[id];
            return {
                local_id: localOf[id],
                toolId: n.data?.toolId || '',
                params: { ...(n.data?.params || {}) },
                pos: {
                    dx: (n.pos_x ?? 0) - anchorX,
                    dy: (n.pos_y ?? 0) - anchorY,
                },
            };
        }).filter(o => o.toolId !== ''); // skip nodi senza toolId

        // Connessioni interne: per ogni nodo nel set, leggi outputs e check se
        // il target è ANCHE nel set. Risolvi outPort/inPort name via inPorts/outPorts.
        const connections = [];
        for (const id of validIds) {
            const n = data[id];
            const outputs = n.outputs || {};
            for (const outputKey of Object.keys(outputs)) {
                const outIdx = parseInt(String(outputKey).replace('output_', ''), 10) - 1;
                const fromPort = (n.data?.outPorts || [])[outIdx];
                if (!fromPort) continue;
                const conns = outputs[outputKey].connections || [];
                for (const c of conns) {
                    const targetId = String(c.node);
                    if (!localOf[targetId]) continue; // esterno → scarta
                    const inputKey = c.output; // Drawflow naming weird: c.output qui = "input_N"
                    const inIdx = parseInt(String(inputKey).replace('input_', ''), 10) - 1;
                    const targetNode = data[targetId];
                    const toPort = (targetNode.data?.inPorts || [])[inIdx];
                    if (!toPort) continue;
                    connections.push({
                        from_local: localOf[id],
                        from_port: fromPort,
                        to_local: localOf[targetId],
                        to_port: toPort,
                    });
                }
            }
        }

        return { version: '1.0', nodes, connections };
    }

    // ═══════════════════════════════════════════════════════════════

    // Preset DAG (2026-05-05) — fetch + spawn di un preset al drop sul canvas.
    // dropX/dropY sono coord canvas (post-conversione (client - precanvas) / zoom),
    // pre-calcolate da IbexCore.dropMeshToCanvas. Pattern coerente con drag tool.
    //
    // Flag `_suspendPresetBake` evita N+1 syncAndBake su connectionCreated
    // durante lo spawn (un syncAndBake unico al termine — pattern come
    // loadFromConfig invariante 76).
    async spawnPreset(id, namespace, dropX, dropY) {
        if (!this.editor || !this.nodeBuilder) return;
        let preset;
        try {
            const r = await fetch(`/?action=load_preset&id=${encodeURIComponent(id)}&namespace=${encodeURIComponent(namespace)}`);
            const data = await r.json();
            if (!data || data.success === false) {
                throw new Error(data?.error || 'load fallita');
            }
            preset = data;
        } catch (err) {
            window.ibex?.uiMgr?.notify?.('Preset non caricabile: ' + err.message, 'error');
            console.warn('[StackManager] spawnPreset load failed', err);
            return;
        }

        const nodes = Array.isArray(preset.nodes) ? preset.nodes : [];
        const conns = Array.isArray(preset.connections) ? preset.connections : [];
        if (nodes.length === 0) {
            window.ibex?.uiMgr?.notify?.('Preset vuoto', 'warning');
            return;
        }

        // Suspend bake durante lo spawn — i listener `connectionCreated`/
        // `nodeCreated` risparmiano sync+bake intermedi. Ripristinato + bake
        // unico al termine.
        this._suspendPresetBake = true;

        const localToNew = {};
        try {
            for (const n of nodes) {
                const nx = dropX + (n.pos?.dx || 0);
                const ny = dropY + (n.pos?.dy || 0);
                const newId = this.nodeBuilder.addToolFromPreset(
                    n.toolId, n.params || {}, nx, ny
                );
                if (newId == null) continue; // toolId stale, skip silenzioso
                localToNew[n.local_id] = newId;
            }

            for (const c of conns) {
                const fromId = localToNew[c.from_local];
                const toId   = localToNew[c.to_local];
                if (fromId == null || toId == null) continue;

                const fromNode = this.editor.getNodeFromId(fromId);
                const toNode   = this.editor.getNodeFromId(toId);
                if (!fromNode || !toNode) continue;

                const outIdx = (fromNode.data?.outPorts || []).indexOf(c.from_port);
                const inIdx  = (toNode.data?.inPorts || []).indexOf(c.to_port);
                if (outIdx < 0 || inIdx < 0) continue;

                try {
                    this.editor.addConnection(
                        fromId, toId, `output_${outIdx + 1}`, `input_${inIdx + 1}`
                    );
                } catch (e) {
                    console.warn('[StackManager] preset addConnection failed', e);
                }
            }
        } finally {
            this._suspendPresetBake = false;
        }

        // Refresh decorazioni post-spawn (mute toggle + delete X + recolor)
        try { this._refreshAllMutedClasses?.(); } catch (e) {}
        try { this._recolorAllSockets?.(); } catch (e) {}
        try { this._fixAllConnSvgSizes?.(); } catch (e) {}

        // Bake unico finale
        try { this.syncAndBake(); } catch (e) {}

        const skipped = nodes.length - Object.keys(localToNew).length;
        const msg = skipped > 0
            ? `Preset evocato: ${preset.name || id} (${skipped} nodi stale skippati)`
            : `Preset evocato: ${preset.name || id}`;
        window.ibex?.uiMgr?.notify?.(msg, skipped > 0 ? 'warning' : 'success');
    }
    
    // ═══════════════════════════════════════════════════════════════
    // UX-A batch 2 — Canc · Copia/Incolla sotto-grafo · Cerca nodo.
    // (Isola e Zoom-fit vivono in SceneManager/ViewGizmo, view-only.)
    // ═══════════════════════════════════════════════════════════════

    // Elimina i nodi indicati (skip mesh source, come il bottone X — Inv.112).
    // Single → nodeRemoved fa bake+undo; multi → un solo bake + un solo undo.
    deleteNodes(ids) {
        if (!ids || !ids.length || !this.editor) return;
        const deletable = ids.filter(id => {
            try { const n = this.editor.getNodeFromId(id); return n && n.name !== 'mesh'; }
            catch (e) { return false; }
        });
        if (!deletable.length) return;
        if (deletable.length === 1) {
            try { this.editor.removeNodeId('node-' + deletable[0]); } catch (e) {}
            return;
        }
        this._suspendPresetBake = true;
        try {
            deletable.forEach(id => { try { this.editor.removeNodeId('node-' + id); } catch (e) {} });
        } finally { this._suspendPresetBake = false; }
        try { this.multiSelectedSet?.clear?.(); this._onMultiSelectChanged?.(); } catch (e) {}
        try { this.syncAndBake(); } catch (e) {}
        this.pushUndoSnapshot();
    }

    // Copia i nodi marquee-selezionati (+ connessioni interne) nella clipboard
    // in-memory dell'app, riusando il payload dei preset (extractPresetPayload).
    copySelectedNodes() {
        if (!this.multiSelectedSet || this.multiSelectedSet.size === 0) return false;
        try {
            const payload = this.extractPresetPayload();
            if (payload && payload.nodes && payload.nodes.length) {
                this._nodeClipboard = payload;
                window.ibex?.uiMgr?.notify?.(`Copiati ${payload.nodes.length} nodi`, 'info');
                return true;
            }
        } catch (e) { /* */ }
        return false;
    }

    // Incolla la clipboard con ID NUOVI + wiring interno preservato, al centro
    // del canvas visibile (+offset). Un incolla = un solo undo (push esplicito,
    // perché l'instanziamento gira in _suspendPresetBake).
    pasteClipboard() {
        const payload = this._nodeClipboard;
        if (!payload || !payload.nodes || !payload.nodes.length || !this.editor) return;
        let dropX = 0, dropY = 0;
        const host = document.getElementById('drawflow');
        if (host) {
            const rect = host.getBoundingClientRect();
            const z = this.editor.zoom || 1;
            dropX = (rect.width / 2 - (this.editor.canvas_x || 0)) / z + 30;
            dropY = (rect.height / 2 - (this.editor.canvas_y || 0)) / z + 30;
        }
        const localToNew = {};
        this._suspendPresetBake = true;
        try {
            for (const n of payload.nodes) {
                const nx = dropX + (n.pos?.dx || 0);
                const ny = dropY + (n.pos?.dy || 0);
                const newId = this.nodeBuilder.addToolFromPreset(n.toolId, n.params || {}, nx, ny);
                if (newId == null) continue;
                localToNew[n.local_id] = newId;
            }
            for (const c of (payload.connections || [])) {
                const fromId = localToNew[c.from_local];
                const toId   = localToNew[c.to_local];
                if (fromId == null || toId == null) continue;
                try {
                    const fromNode = this.editor.getNodeFromId(fromId);
                    const toNode   = this.editor.getNodeFromId(toId);
                    if (!fromNode || !toNode) continue;
                    const outIdx = (fromNode.data?.outPorts || []).indexOf(c.from_port);
                    const inIdx  = (toNode.data?.inPorts || []).indexOf(c.to_port);
                    if (outIdx < 0 || inIdx < 0) continue;
                    this.editor.addConnection(fromId, toId, `output_${outIdx + 1}`, `input_${inIdx + 1}`);
                } catch (e) {}
            }
        } finally { this._suspendPresetBake = false; }
        try { this._refreshAllMutedClasses?.(); } catch (e) {}
        try { this._recolorAllSockets?.(); } catch (e) {}
        try { this._fixAllConnSvgSizes?.(); } catch (e) {}
        try { this.syncAndBake(); } catch (e) {}
        this.pushUndoSnapshot();
        window.ibex?.uiMgr?.notify?.(`Incollati ${Object.keys(localToNew).length} nodi`, 'info');
    }

    // Crea l'input di ricerca nodi (idempotente, una volta), ancorato al canvas DAG.
    _initNodeSearchBox() {
        const host = document.getElementById('dag-canvas');
        if (!host || document.getElementById('ibex-node-search')) return;
        const box = document.createElement('input');
        box.id = 'ibex-node-search';
        box.type = 'text';
        box.placeholder = 'Cerca nodo…';
        box.autocomplete = 'off';
        box.spellcheck = false;
        box.style.cssText = 'position:absolute;top:8px;right:8px;z-index:20;width:150px;padding:5px 9px;border:1px solid var(--ibex-border,#E3E5E7);border-radius:6px;background:var(--ibex-surface,#fff);color:var(--ibex-text,#0B0B0C);font-size:12px;font-family:inherit;box-shadow:var(--shadow-card,0 1px 2px rgba(0,0,0,.06));outline:none;';
        box.addEventListener('input', () => this.searchNode(box.value));
        box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.searchNode(box.value); });
        host.appendChild(box);
    }

    // Trova il primo nodo che matcha (nome/tipo) e centra il canvas su di esso.
    searchNode(query) {
        const q = (query || '').trim().toLowerCase();
        if (!q) return;
        let data;
        try { data = this.editor.export().drawflow.Home.data; } catch (e) { return; }
        let match = null;
        for (const id of Object.keys(data)) {
            const n = data[id];
            const hay = [n.data?.toolName, n.data?.displayName, n.data?.curveDisplayName,
                         n.data?.name, n.data?.toolId, n.name].filter(Boolean).join(' ').toLowerCase();
            if (hay.includes(q)) { match = n; break; }
        }
        if (!match) { window.ibex?.uiMgr?.notify?.('Nessun nodo trovato', 'info'); return; }
        this._centerOnNode(match);
    }

    _centerOnNode(node) {
        const host = document.getElementById('drawflow');
        if (!host || !this.editor?.precanvas) return;
        const rect = host.getBoundingClientRect();
        const z = this.editor.zoom || 1;
        this.editor.canvas_x = (rect.width / 2) - (node.pos_x || 0) * z;
        this.editor.canvas_y = (rect.height / 2) - (node.pos_y || 0) * z;
        this.editor.precanvas.style.transform =
            `translate(${this.editor.canvas_x}px, ${this.editor.canvas_y}px) scale(${z})`;
        const el = document.getElementById('node-' + node.id);
        if (el) {
            el.style.transition = 'box-shadow .2s ease';
            el.style.boxShadow = '0 0 0 3px var(--ibex-accent, #FF6037)';
            setTimeout(() => { el.style.boxShadow = ''; }, 1600);
        }
    }

    bindDragInputs() { this.dragEngine.bindDragInputs(); }

    /**
     * Variante StackManager di resolveBaseMesh — usata da SelectionMode/SculptMode
     * per risolvere il nome della mesh target di un nodo destructive.
     *
     * S3 (2026-04-25): supporto split_topology upstream. Se il chiamante passa
     * `fromPort = 'OUT_GEO_A'|'_B'` e il nodo sorgente è split, ritorna
     * `{stem}_snap_{splitId}_{A|B}.stl`. Delega a `this.executor.resolveBaseMesh`
     * per riusare la stessa logica di ToolExecutor (evita duplicazione).
     *
     * @param {string} nodeId — 'tool_output_X' oppure nome mesh base
     * @param {string|null} fromPort — nome socket di output del nodo sorgente
     * @returns {string} Nome target
     */
    resolveBaseMesh(nodeId, fromPort = null) {
        // Delega a ToolExecutor per riuso logica S3 (split_topology detection).
        // Passa `this.graph` come grafo corrente (StackManager mantiene il cache
        // dell'ultimo extractDAG).
        if (this.executor && typeof this.executor.resolveBaseMesh === 'function') {
            return this.executor.resolveBaseMesh(nodeId, this.graph, fromPort);
        }
        // Fallback (non dovrebbe mai servire — executor è sempre wired): logica legacy.
        const edge = this.graph.edges.find(
            e => `tool_output_${e.to_node}` === nodeId && !e.from_mesh.startsWith('tool_output_')
        );
        if (edge) return edge.from_mesh;
        const chain = this.graph.edges.find(e => `tool_output_${e.to_node}` === nodeId);
        if (chain && chain.from_mesh.startsWith('tool_output_')) return this.resolveBaseMesh(chain.from_mesh);
        return nodeId;
    }

    getQueueForBackend() {
        if (!this.executor.flattenGraphForBackend) return [];
        return this.executor.flattenGraphForBackend(this.graph);
    }

    getUIGraph() { return this.editor ? this.editor.export() : {}; }
}
