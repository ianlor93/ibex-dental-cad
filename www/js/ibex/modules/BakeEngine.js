// ═══════════════════════════════════════════════════════════════
// IBEX BakeEngine FastReload_V18.2 — getLastBakeSnapshot + restoreLastBakeSnapshot
//
// V18.2 (2026-05-02 FastReload — _snapshot_node_id escluso dal filterUI):
//   - hasChanges filterUI ora esclude anche `_snapshot_node_id` (oltre a `IN_*`
//     e `world_matrix`). Senza questa esclusione, al reload con FastReload
//     attivo, `hasChanges` tornava sempre true: il save snapshot legge
//     edNode.data.params (UI-only, no `_snapshot_node_id`), mentre il check
//     confronta con q.params che ha `_snapshot_node_id` iniettato da
//     flattenGraphForBackend per i nodi destructive. Asimmetria → diff
//     sempre presente → POST FAST_TRANSFORM spurio → fast reload mancato.
//
// V17.9 (2026-05-02 FastReload — preview persistente tra sessioni):
//   - Aggiunti getter `getLastBakeSnapshot()` e setter `restoreLastBakeSnapshot()`.
//   - getLastBakeSnapshot ritorna {params, node_ids, targets} serializzabile per
//     persistenza in session_settings.last_bake (IbexCore.saveAndExit lo include
//     nel payload, PHP lo salva nel JSON, worker.SAVE_EXIT include preview/ nel zip).
//   - restoreLastBakeSnapshot pre-popola lo stato di bake al reload (chiamato da
//     StackManager.loadFromConfig). Effetto: al primo syncAndBake post-load,
//     `hasChanges` ritorna false → niente POST al worker → preview/ già caricata
//     da MeshLoader resta visibile senza ricalcolo. Vedi invariante 42 aggiornata.
//
// V17.8b (2026-04-25 post-deploy fix — topology-aware change detection):
//   - Fix "rimozione nodo dal mezzo della catena non triggera bake".
//     Scenario: catena `mesh → meshcleaner → sculpt`, l'utente cancella
//     il nodo sculpt. La queue corrente diventa solo [meshcleaner]; il
//     target (Upper.stl) è ancora prodotto da meshcleaner → niente
//     orfano in `_lastBakedTargets` → no `revertToMaster`. Il loop
//     `hasChanges` itera la queue corrente confrontando i params di ogni
//     step con `_lastBakedParams[step._nodeId]`: i params del meshcleaner
//     sono invariati → `hasChanges = false` → POST mai inviato → preview
//     server resta quello del bake precedente con sculpt applicato →
//     mesh visualizzata stale.
//   - Root cause: `hasChanges` era param-only, ignorava la sparizione
//     di step. Fix: `_lastBakedNodeIds` (Set di String degli `_nodeId`
//     bakati l'ultima volta) confrontato con `currentNodeIds` derivati
//     dalla queue corrente. Se size diverse o ID mancante → flag
//     `topologyChanged=true` → `hasChanges` forzato a true → bake parte
//     anche con params identici. Aggiornato al success bake insieme a
//     `_lastBakedParams` e `_lastBakedTargets`.
//
// V17.8a (2026-04-27 SculptGL S4 Mod2 — IbexBridge re-init):
//   - dopo `r.old.geometry = r.geometry` in `hotSwapMeshes` +
//     `revertToMaster`: re-init `r.old.userData.sculptgl.initFromThreeMesh(
//     r.old)` se il bridge esiste E sculpt NON attivo su quel target →
//     MeshDynamic/Octree ricostruiti dalla nuova geometria post-bake.
//     Fix stale bridge quando user fa `meshcleaner → sculpt` cycle.
//
// V17.7 (2026-04-25, SnapshotKeyed Session 3):
//   - `hotSwapMeshes`: se il target non esiste in scena (es. mesh derivata
//     da un applySplit appena avvenuto), esegue `loader.load` completo +
//     `sceneMgr.addMesh(fresh)` invece di replace geometry. I 2 nuovi
//     target `{stem}_snap_{nodeId}_[AB].stl` appaiono nella scena al
//     primo bake post-applySplit (S3-NA3).
//   - `revertToMaster`: detecta pattern split (`_snap_{nodeId}_[AB].stl`)
//     via regex. Per questi target NON fa loader.load({fromMaster:true})
//     ma rimuove la mesh dalla scena (`group.remove(mesh)` + dispose geometry).
//     I file sul disco verranno puliti dal SAVE_EXIT (pattern esistente).
//     Target non-split (master) seguono il flow legacy invariato (S3-NA6).
//
// V17.6 (2026-04-24, SnapshotKeyed Session 2):
//   - RENAME `_sculptSavePending` → `_snapshotSavePending` +
//     `setSculptSavePending(val)` → `setSnapshotSavePending(val)`. La
//     generalizzazione del meccanismo snapshot (SculptPersist → SnapshotPersist,
//     che serve anche delete_topology + futuri split_topology) rende il nome
//     precedente fuorviante. Invariante S2-A4.
//   - Nessun cambio di comportamento: stesso gate "prossimo requestBake
//     si auto-rimanda finché il file snapshot non è su disco".
//
// V17.5 Bug 2 revertToMaster (2026-04-22):
// V17.4 (2026-04-22, stessa sessione — Obiettivo 3):
//   - AGGIUNTI _computeWorkerLabel(queue) + _markDone(queue).
//     Label contestuale per #ibex-worker-status: distingue pipeline con
//     sculpt, Tier 2, solo Tier 1.
//     _markDone applica .ibex-node-done ai nodi della queue al success
//     del bake, la rimuove dopo 1s (flash verde — invariante 78).
//   - showWorkerStatus(label) chiamato prima del POST, hideWorkerStatus()
//     nel finally (dopo _clearProcessing).
//
// V17.3 (2026-04-22, sessione reload-atomico/sculpt-race/worker-feedback):
//   - AGGIUNTO flag `_sculptSavePending` + metodo pubblico
//     `setSculptSavePending(val)`.
//     Chiamato da SculptPersist.save(): true all'inizio, false nel finally.
//     Mentre true, requestBake() ritorna early settando `_pendingRebake`.
//     Al clear (false), se c'era un pending, rilanciamo direttamente
//     requestBake() dal setter (la logica esistente del finally di
//     requestBake sta dentro il setTimeout del debounce e non si attiva
//     se il bake è stato short-circuit prima di entrare nello scheduling).
//     Invariante 77.
//
//     Risolve la race: user esce da sculpt → SculptPersist.save() parte
//     fire-and-forget → user tocca subito uno slider → requestBake()
//     partirebbe in parallelo → POST bake arriva al worker PRIMA del
//     task SAVE_SCULPT → _apply_sculpt non trova `_sculpted.stl` → fa
//     passthrough del master → mesh sculpted scartata visivamente.
//
// V16.2 (2026-04-22, Sculpt V2 Sessione 7 post-meshcleaner-rename):
//   - hotSwapMeshes resetta `userData.vertNeighbors/vertNeighborsN/
//     vertNeighborsGeom` al replace della geometry. Fix del bug smooth che
//     buca la mesh in corrispondenza dei fori chiusi da meshcleaner: il
//     cache adjacency di SculptMode era invalidato solo su cambio `N`;
//     `triangle_fill+join_triangles`/`holes_fill` aggiungono facce senza
//     nuovi verts → cache stale → `_brushSmooth` tira verso vicini
//     topologici della vecchia geometry = fori visibili.
//
// V16.1 (2026-04-21, DarkRedesign Fase D1):
//   - AGGIUNTO: _markProcessing(queue) / _clearProcessing() → applica/rimuove
//     .ibex-node-processing ai nodi nel bake corrente. Strip colorata del nodo
//     pulsa durante l'elaborazione (CSS animation definita in main.blade.php).
//   - AGGIUNTO: _markError(queue) → applica .ibex-node-error per 3s on errore.
//   - RINOMINATO: inspectorMgr.refresh() → contextInspector.refresh().
//
// V15.6 (2026-04-15):
//   - FIX RADICE "Lower non segue Upper durante sculpt":
//     Quando sculpt mode è attivo, hotSwapMeshes skippa la geometria del target
//     sculpt (V15.2). Ma appliedMatFlat veniva aggiornato ugualmente a M_ft_new.
//     Risultato: applyGraph calcolava applyMat = M_ft_new × M_ft_new_inv = identity
//     → Lower restava congelato alla vecchia posizione invece di seguire Upper.
//     Fix: in _bestMatrixByTarget.forEach, skip anche l'aggiornamento di
//     appliedMatFlat quando sm.active e target === sm.targetMesh.name.
//     Così appliedMatFlat resta = M_ft_old → applyMat = M_ft_new × M_ft_old_inv
//     → Lower correttamente riposizionato in WS anche con vertici stale.
//   - RIMOSSI log diagnostici [DIAG Lower], [DIAG bestMatrix], [DIAG applyGraph].
//
// V15.3 (2026-04-14, stessa sessione):
//   - FIX auto-bake al reload: causa radice trovata in StackManager.loadFromConfig
//     che skippava _lastBakedParams per nodi senza UI params (es. fast_parenting).
//     BakeEngine.hasChanges vedeva undefined → true → auto-bake. Ora pre-populate
//     copre anche i nodi con params={}.
//   - FIX race condition "strokes spariscono al primo bake": aggiunto LATE check
//     sm.active dopo Promise.all in hotSwapMeshes. Se sculpt diventa attivo
//     durante il fetch (~200ms), skippa il replace del target sculpt per
//     preservare le modifiche locali da _applyBrushLocal.
//
// V15.2 (2026-04-14, stessa sessione):
//   - FIX strokes che sparivano e ricomparivano durante sculpt attivo:
//     SculptMode._applyBrushLocal modifica i vertici locali a ogni stroke
//     per feedback immediato. Il worker bake-ribatte in background. Se
//     l'utente completa stroke N+1 mentre è in corso il bake di [1..N],
//     hot-swap carica il disco (N strokes) e sostituisce la geometry
//     locale (N+1 strokes) → stroke N+1 sparisce. Il pendingRebake
//     triggera bake [1..N+1], il cui hot-swap riporta lo stroke.
//     Ciclo disappear/reappear ogni 1.5-3s durante sculpt attivo.
//     Fix: hotSwapMeshes filtra OUT il target sculpt quando sm.active,
//     preservando la geometry locale. applyGraph segue Upper via
//     appliedMatFlat senza bisogno di swap sul target sculpt.
//
// V15.1 (2026-04-14, stessa sessione):
//   - FIX parenting lost: con più Tier 1 sullo stesso target (es.
//     fast_parenting + delta_sculpting), l'overwrite lineare di
//     appliedMatFlat lasciava la matrice dell'ULTIMO tool in coda
//     (identity per delta_sculpting non-spaziale) → applyGraph() calcolava
//     applyMat = worldMat × identity_inv = worldMat e applicava di nuovo
//     il parent sui vertici già in WS → mesh scollegata dal parent.
//     Ora per ogni target vince l'ULTIMO world_matrix NON-identity.
//
// V15.0 (2026-04-14):
//   - RIMOSSA opacità 0.6 durante bake. Le mesh restano opache.
//   - AGGIUNTO toggle #engine-gears.is-calculating (add in requestBake,
//     remove in finally). Feedback calcolo via ingranaggi girevoli della
//     lavagna DAG. Copre sia Tier 1 (fast_transform) sia Tier 2 (preview_bake).
//
// Contratto architetturale V14.0 (preservato):
//   - Tier 1 (FAST): routing a fast_transform, nessun Blender.
//     Dopo hotSwap: salva appliedMatFlat (world matrix flat row-major)
//     in mesh.userData.appliedMatFlat per la delta correction in applyGraph().
//   - Tier 2 (GN/PY): routing a preview_bake (Blender), salva
//     preview_baked_params come sempre.
//   - Mixed (Tier 1 + Tier 2): routing a preview_bake (Blender gestisce tutto).
//   - Bug #8 fix: preview_baked_params = null per tool senza params SRT.
//   - Tool non-spaziali (delta_sculpting): né world_matrix né preview_baked_params
//     → applyGraph() cade nel branch `else` (applyMat = worldMat su vertici già
//     scolpiti dal worker Tier 1).
//
// Invariante 24: la world_matrix nel queue item è la matrice completa
//   (con pivot compensation), calcolata in ToolExecutor.flattenGraphForBackend().
// Invariante 25: appliedMatFlat aggiornato PRIMA di syncPreview() → applyGraph().
// ═══════════════════════════════════════════════════════════════

// L7.1 (2026-07-23) — banner «bake troppo lungo».
// Soglia di silenzio: se passano SLOW_BAKE_MS senza NESSUN messaggio di progress
// dal worker (coda satura / worker tutti occupati), mostriamo un avviso piccolo e
// non-bloccante. È puramente lato client: `_pollPreviewReady` riceve già progress,
// `pending` e il finale (Tier C V18.0) → zero modifiche a PHP e worker.
// ⚠️ `pending` NON resetta il timer: è il BLPOP server-side scaduto a 25s, cioè
//    l'esatto contrario di un segnale di avanzamento.
const SLOW_BAKE_MS = 60000;

export class BakeEngine {
    constructor(stackMgr) {
        this.stackMgr = stackMgr;
        this.debounceTimer = null;
        this._bakeLock = false;
        this._pendingRebake = false;
        this._lastBakedParams = {};
        // V17.6 (Invariante 77): true mentre SnapshotPersist.save() è in volo
        // (per sculpt, delete_topology, futuri split_topology). requestBake()
        // ritorna early settando _pendingRebake se true. Clearing via
        // setSnapshotSavePending(false) rilancia il bake pendente.
        // (Pre-S2 si chiamava `_sculptSavePending` — rename in S2 per coerenza
        // con la generalizzazione del meccanismo snapshot.)
        this._snapshotSavePending = false;
        // PyMeshLab_V17.5 — Set dei target per cui è stato fatto almeno un bake
        // in questa sessione. Usato in requestBake() per detectare target "orfani"
        // quando l'utente rimuove nodi dal DAG (es. cancella il solo meshcleaner
        // sul target Upper) e ripristinare visivamente lo stato scanner-space via
        // revertToMaster(). Senza questo tracking, il guard `!activeQueue.length`
        // faceva ritornare early lasciando la mesh cleaned in viewport.
        this._lastBakedTargets = new Set();
        // V17.8 (2026-04-25) — Set degli `_nodeId` presenti nell'ultimo bake.
        // Usato in requestBake() per detectare la SPARIZIONE di step (nodi
        // rimossi dal mezzo della catena, es. user cancella sculpt downstream
        // di meshcleaner). Senza questo tracking, `hasChanges` itera solo
        // gli step CORRENTI e non rileva il fatto che uno step è scomparso →
        // POST mai inviato → preview server stale → mesh visivamente sculpted
        // anche dopo rimozione del nodo. Bug "param-centric" pre-V17.8.
        this._lastBakedNodeIds = new Set();
        // Tier C V18.0 (2026-04-30) — supporto progress messages dal worker.
        // _lastActiveQueue: snapshot della queue corrente, salvato prima del
        //   poll. Necessario al progress handler per lookup tier1Step (per
        //   appliedMatFlat) durante hot-swap incrementale per-mesh.
        // _tierC_swappedTargets: Set dei target swappati incrementalmente
        //   durante il poll (uno per ogni progress message ricevuto). Al
        //   final response, requestBake() salta hot-swap full per questi
        //   target (già aggiornati). Set vuoto = worker legacy senza
        //   progress messages → fallback hot-swap full standard.
        this._lastActiveQueue = [];
        this._tierC_swappedTargets = new Set();
        // L7.1 — banner «bake troppo lungo» (client-only, vedi SLOW_BAKE_MS).
        // _slowBakeTimer: armato all'inizio del poll, ri-armato a ogni progress.
        // _slowBakeDismissed: l'utente ha chiuso il banner → non riproporlo per
        //   QUESTO bake (si azzera all'inizio del prossimo).
        this._slowBakeTimer = null;
        this._slowBakeEl = null;
        this._slowBakeDismissed = false;
    }

    /* ═══ L7.1 — banner «il bake sta richiedendo più del previsto» ═══════════
       Non blocca nulla: il bake prosegue, l'utente può solo essere informato e,
       se vuole, aprire un ALTRO caso in una nuova scheda mentre aspetta.
       L'editor vive in un iframe → non può aprire schede da sé: chiede alla
       shell NC via postMessage origin-checked (speculare a `ibex-close-tab`). */
    _slowBakeArm() {
        if (this._slowBakeTimer) clearTimeout(this._slowBakeTimer);
        this._slowBakeTimer = setTimeout(() => this._slowBakeShow(), SLOW_BAKE_MS);
    }

    /** Inizio bake: azzera la dismissione e arma il timer di silenzio. */
    _slowBakeStart() {
        this._slowBakeDismissed = false;
        this._slowBakeArm();
    }

    /** Segnale di avanzamento ricevuto: nascondi il banner e riparti da zero. */
    _slowBakeKick() {
        this._slowBakeHide();
        this._slowBakeArm();
    }

    /** Fine bake (successo, errore o timeout): spegni tutto. */
    _slowBakeClear() {
        if (this._slowBakeTimer) { clearTimeout(this._slowBakeTimer); this._slowBakeTimer = null; }
        this._slowBakeHide();
    }

    _slowBakeHide() {
        if (this._slowBakeEl) {
            try { this._slowBakeEl.remove(); } catch (e) { /* già staccato */ }
            this._slowBakeEl = null;
        }
    }

    _slowBakeShow() {
        if (this._slowBakeDismissed || this._slowBakeEl) return;
        if (typeof document === 'undefined' || !document.body) return;

        // In embed (scheda della shell NC) possiamo proporre «apri un altro caso»;
        // standalone no — non c'è una shell a cui chiederlo.
        const embed = document.documentElement.getAttribute('data-embed') === '1'
                      && window.parent && window.parent !== window;

        const b = document.createElement('div');
        b.setAttribute('role', 'status');
        b.style.cssText = 'position:fixed;z-index:99999;left:50%;bottom:18px;'
            + 'transform:translateX(-50%);display:flex;align-items:center;gap:12px;'
            + 'max-width:min(560px,92vw);padding:10px 12px 10px 16px;border-radius:9999px;'
            + 'background:#0B0B0C;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.28);'
            + 'font:500 13px/1.35 Ubuntu, system-ui, sans-serif;';

        const msg = document.createElement('span');
        msg.textContent = embed
            ? 'Il bake sta richiedendo più del previsto. Puoi attendere, oppure aprire un altro caso in una nuova scheda.'
            : 'Il bake sta richiedendo più del previsto. Puoi attendere: il lavoro non è perso.';
        b.appendChild(msg);

        if (embed) {
            const cta = document.createElement('button');
            cta.type = 'button';
            cta.textContent = 'Apri un altro caso';
            cta.style.cssText = 'flex:0 0 auto;cursor:pointer;border:0;border-radius:9999px;'
                + 'padding:6px 14px;font:600 13px Ubuntu, system-ui, sans-serif;'
                + 'background:#FF6037;color:#fff;';
            cta.addEventListener('click', () => {
                // NON è `exitToLobby`: la scheda corrente resta aperta e il bake in
                // corso resta vivo. Chiediamo solo alla shell di aprire il picker.
                const ncOrigin = (window.IBEX_CONFIG && window.IBEX_CONFIG.nextcloudOrigin) || '';
                if (!ncOrigin) return;
                try {
                    window.parent.postMessage({ type: 'ibex-open-picker' },
                        ncOrigin);
                } catch (e) { console.warn('[SLOW-BAKE] postMessage picker fallito:', e); }
            });
            b.appendChild(cta);
        }

        const x = document.createElement('button');
        x.type = 'button';
        x.setAttribute('aria-label', 'Chiudi avviso');
        x.title = 'Chiudi avviso';
        x.textContent = '✕';
        x.style.cssText = 'flex:0 0 auto;cursor:pointer;border:0;background:transparent;'
            + 'color:#fff;opacity:.7;font-size:13px;line-height:1;padding:6px 4px;';
        x.addEventListener('click', () => { this._slowBakeDismissed = true; this._slowBakeHide(); });
        b.appendChild(x);

        document.body.appendChild(b);
        this._slowBakeEl = b;
    }

    // Fix 2a (Invariante 77): chiamato da SnapshotPersist.save() in apertura
    // (true) e finally (false). Gate sincrono sul bake che protegge dalla
    // race "bake parte prima che `_snap_{nodeId}.stl` sia sul disco".
    //
    // Sul clear (false), se c'era un pending rebake lo rilanciamo DIRETTAMENTE
    // da qui. Non possiamo fare affidamento sul ramo `_pendingRebake` nel
    // finally di requestBake perché quel finally sta dentro il setTimeout del
    // debounce: se l'unica requestBake() arrivata è stata short-circuit da
    // questo gate, il setTimeout non è mai partito → il finally non gira mai
    // → il pending resta settato per sempre.
    //
    // (Pre-S2 si chiamava `setSculptSavePending` — rename in S2 per coerenza
    // con la generalizzazione del meccanismo snapshot.)
    setSnapshotSavePending(val) {
        this._snapshotSavePending = !!val;
        if (!this._snapshotSavePending) {
            // BUGFIX (2026-07-14) — "la scolpitura sparisce alla riapertura".
            //
            // Uno snapshot è appena stato scritto su disco ({stem}_snap_{nodeId}.stl):
            // la preview lato server è STALE PER DEFINIZIONE, perché è stata generata
            // da una pipeline che quel file non lo conteneva. Il bake DEVE partire.
            //
            // E DEVE essere FORZATO. I nodi destructive non hanno widget: i loro params
            // sono `{}`. Senza `force`, `hasChanges` confronta `{}` con `{}`, non vede
            // differenze e SALTA il bake → `preview/` non viene mai rigenerata → lo
            // snapshot resta sul disco, inerte. L'utente continua a vedere la sua
            // scolpitura solo perché il brush ha modificato la geometria NEL BROWSER:
            // un'illusione locale che al reload svanisce, servendo la vecchia preview.
            // La scolpitura non era persa — non era mai stata applicata.
            //
            // Il vecchio codice rilanciava il bake SOLO `if (this._pendingRebake)`,
            // cioè solo se l'utente aveva tentato un'altra azione DURANTE il salvataggio.
            // Esci da sculpt e stai fermo → nessun bake → lavoro (apparentemente) perso.
            //
            // È il bug di Inv. 116, che era stato chiuso rattoppando i singoli call site
            // (topology_rebuild in SelectionMode:445, curve in CurveMode/CurveEditMode)
            // e lasciando scoperti sculpt, delete_topology e split_topology. Qui è chiuso
            // ALLA RADICE: vale per ogni tool destructive, presenti e futuri.
            //
            // I `requestBake({force:true})` espliciti già presenti in quei call site
            // diventano ridondanti ma restano innocui: trovano `_bakeLock` già preso,
            // impostano `_pendingRebake`, e il rilancio successivo esce su `hasChanges`.
            this._pendingRebake = false;
            this.requestBake({ force: true });
        }
    }

    // FastReload (2026-05-02) — espone uno snapshot serializzabile dello stato
    // di bake corrente. Usato da IbexCore.saveAndExit per persistere in
    // session_settings.last_bake. Al reload, StackManager.loadFromConfig
    // ripristina `_lastBakedParams` + `_lastBakedNodeIds` da queste chiavi
    // → al primo syncAndBake `hasChanges` ritorna false → bake skippato →
    // utente vede preview salvato dal session precedente immediatamente.
    getLastBakeSnapshot() {
        return {
            params:   { ...(this._lastBakedParams || {}) },
            node_ids: Array.from(this._lastBakedNodeIds || []),
            targets:  Array.from(this._lastBakedTargets || []),
        };
    }

    // FastReload (2026-05-02) — pre-popola lo stato di bake al reload.
    // Chiamato da StackManager.loadFromConfig prima del primo syncAndBake.
    // Lo snapshot deve venire da session_settings.last_bake (popolato dal
    // saveAndExit precedente). Se assente, no-op (legacy / fresh project).
    restoreLastBakeSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return;
        if (snapshot.params && typeof snapshot.params === 'object') {
            this._lastBakedParams = { ...snapshot.params };
        }
        if (Array.isArray(snapshot.node_ids)) {
            this._lastBakedNodeIds = new Set(snapshot.node_ids.map(String));
        }
        if (Array.isArray(snapshot.targets)) {
            this._lastBakedTargets = new Set(snapshot.targets);
        }
    }

    get executor() { return this.stackMgr.executor; }
    get editor() { return this.stackMgr.editor; }
    get sceneMgr() { return this.stackMgr.executor.sceneMgr; }
    get graph() { return this.stackMgr.graph; }

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.force=false] — bypassa il check `hasChanges`,
     *   forza il bake anche se params/topology coincidono con l'ultimo run.
     *   Usato dal pulsante "Forza Bake" nell'header per ricalcolo manuale
     *   (es. dopo errore worker, cache invalidation, edge case dove l'utente
     *   sospetta uno stato visivo desync).
     */
    requestBake(opts = {}) {
        // T2Split 2026-07-29 — god-method spezzato in due:
        //   _computeBakePlan  (ex 420-569) → guardie + piano + arma lo stato
        //   _postBakeApply    (ex 571-873) → esegui il bake e applica
        // Il debounce resta identico: stesso campo timer, stesso delay 500ms,
        // e l'annullamento del timer precedente vive dentro _computeBakePlan,
        // dove era (ex :502).
        const plan = this._computeBakePlan(opts);
        if (!plan) return;

        this.debounceTimer = setTimeout(() => this._postBakeApply(
            plan.activeQueue, plan.allTargets, plan.snapshotMap, plan.bakeAction
        ), 500);
    }

    // ─────────────────────────────────────────────────────────────
    // T2Split 2026-07-29 — parte SINCRONA di requestBake (ex righe 420-569 del
    // file pre-refactor, md5 01add93976ce8cb51c5e2e763086c39e), VERBATIM.
    //
    // ⚠️ UNICA modifica al corpo: i CINQUE `return;` nudi delle guardie sono
    //    diventati `return null;` — il chiamante vede `null` e ritorna a sua
    //    volta. Enumerati e verificati: righe 445 · 447 · 484 · 498 · 500 del
    //    file originale. I TRE `return` annidati dentro `filterUI` e la
    //    callback di `.some()` (`return true` · `return filtered` · `return
    //    JSON.stringify(...)`) NON sono toccati: non sono uscite dal metodo.
    //
    // ⚠️ NON è una funzione pura, e il nome non lo dice: oltre a calcolare,
    //    ARMA lo stato — `this._bakeLock = true`, `_markProcessing`,
    //    `showWorkerStatus` — e annulla il timer di debounce in corso (la
    //    riga qui sotto, ex :502). Chiamarla «per vedere il piano»
    //    accenderebbe il lock e cancellerebbe un bake già schedulato.
    // ─────────────────────────────────────────────────────────────
    _computeBakePlan(opts) {
        const force = opts.force === true;
        const activeQueue = this.stackMgr.getQueueForBackend();

        // PyMeshLab_V17.5 Bug 2 fix — revert ai master al remove nodi DAG.
        // Calcola i target attualmente attivi dalla queue (+ target di tool con
        // edge entrante da un altro tool). I target che erano in _lastBakedTargets
        // ma non più nella queue sono "orfani": il DAG ha perso i loro tool →
        // preview/ lato server è stale → client vede ancora lo stato cleaned.
        // revertToMaster hot-swappa il master STL/DRC via serve_file?from=master.
        const currentTargets = new Set();
        activeQueue.forEach(q => { if (q.target) currentTargets.add(q.target); });
        const orphanTargets = new Set();
        this._lastBakedTargets.forEach(t => {
            if (!currentTargets.has(t)) orphanTargets.add(t);
        });
        if (orphanTargets.size > 0) {
            orphanTargets.forEach(t => this._lastBakedTargets.delete(t));
            // Anche _lastBakedParams va pulito per i nodi spariti (altrimenti
            // un re-add dello stesso tool-type non triggererà hasChanges).
            // Più semplice: reset completo (conservativo).
            this._lastBakedParams = {};
            this.revertToMaster(orphanTargets).catch(err =>
                console.warn('[BakeEngine] revertToMaster err:', err)
            );
            // Se la queue è completamente vuota, niente da bake-are: return dopo revert.
            if (!activeQueue.length) return null;
        }
        if (!activeQueue.length) return null;

        // V17.8: detect topology change — un nodo rimosso dal mezzo della
        // catena NON cambia i params dei nodi rimasti, ma cambia il risultato
        // della pipeline sul target. Il param-only check pre-V17.8 saltava
        // questi casi → POST mai inviato → mesh visualizzata stale.
        const currentNodeIds = new Set(activeQueue.map(q => String(q._nodeId)));
        let topologyChanged = false;
        if (currentNodeIds.size !== this._lastBakedNodeIds.size) {
            topologyChanged = true;
        } else {
            for (const id of this._lastBakedNodeIds) {
                if (!currentNodeIds.has(id)) { topologyChanged = true; break; }
            }
        }

        const hasChanges = topologyChanged || activeQueue.some(q => {
            const last = this._lastBakedParams[q._nodeId];
            if (!last) return true;
            // Confronta solo params UI. Escludi:
            //   - cavi iniettati `IN_*` (cambiano per dipendenze, non per UI)
            //   - `world_matrix` sintetizzata da flattenGraphForBackend
            //   - `_snapshot_node_id` metadata interno destructive nodes
            //     (FastReload 2026-05-02: senza questa esclusione, hasChanges
            //     ritornava sempre true al reload perché il save snapshot
            //     prende edNode.data.params (UI-only) mentre il check confronta
            //     con q.params che contiene _snapshot_node_id iniettato).
            const filterUI = (obj) => {
                const filtered = {};
                for (const [k, v] of Object.entries(obj)) {
                    if (k.startsWith('IN_') || k === 'world_matrix' || k === '_snapshot_node_id') continue;
                    filtered[k] = v;
                }
                return filtered;
            };
            return JSON.stringify(filterUI(q.params)) !== JSON.stringify(filterUI(last));
        });
        if (!hasChanges && !force) return null;
        // Force-bake: invalida lo stato salvato così tutti i nodi sono visti
        // come "cambiati" e la pipeline gira completa (server-side cache_pipeline
        // resterà comunque HIT se input + params coincidono — costo cap a ~3-5s).
        if (force) {
            this._lastBakedParams = {};
            this._lastBakedNodeIds = new Set();
        }

        // Fix 2a (Invariante 77): snapshot save in corso → rimanda il bake.
        // Il worker SAVE_SNAPSHOT deve finire di scrivere `_snap_{nodeId}.stl`
        // PRIMA che parta il preview_bake, altrimenti `_apply_snapshot` non lo
        // trova e fa passthrough del master. setSnapshotSavePending(false)
        // rilancerà direttamente requestBake() quando il flag viene cleared.
        if (this._snapshotSavePending) { this._pendingRebake = true; return null; }

        if (this._bakeLock) { this._pendingRebake = true; return null; }

        clearTimeout(this.debounceTimer);

        const allTargets = new Set();
        activeQueue.forEach(item => { if (item.target) allTargets.add(item.target); });

        // FIX V12.1: Includi target di TUTTI i tool del grafo
        if (this.graph && this.graph.nodes) {
            const graphEdges = this.graph.edges || [];
            this.graph.nodes
                .filter(n => n.type === 'tool')
                .forEach(node => {
                    const nodeEdges = graphEdges.filter(e => String(e.to_node) === String(node.id));
                    const targetEdge = nodeEdges.find(e => !e.role || !e.role.startsWith('IN_'));
                    if (targetEdge) {
                        // S3: propaga from_port per risolvere branch A/B dei nodi
                        // downstream dello split (targetEdge.from_port = 'OUT_GEO_A'|'_B').
                        const baseMesh = this.executor.resolveBaseMesh(targetEdge.from_mesh, this.graph, targetEdge.from_port);
                        if (baseMesh) allTargets.add(baseMesh);
                    }
                });
        }

        this._bakeLock = true;
        this._pendingRebake = false;

        // UX V15.0: ingranaggi (ora no-op dopo rimozione del widget DAG fluttuante).
        // Il toggle resta per retrocompatibilità; il feedback visivo primario
        // viene ora dalla classe .ibex-node-processing sui nodi coinvolti.
        document.getElementById('engine-gears')?.classList.add('is-calculating');

        // V16.1 DarkRedesign: marca i nodi attivi come "in elaborazione".
        // La strip colorata del nodo pulsa (CSS animation).
        this._markProcessing(activeQueue);

        if (this.sceneMgr) this.sceneMgr.render();

        // Snapshot dai params UI puri (Drawflow), non dalla queue arricchita
        const snapshotMap = {};
        activeQueue.forEach(q => {
            if (q._nodeId) {
                const key = String(q._nodeId);
                try {
                    const drawflowId = parseInt(q._nodeId, 10);
                    const edNode = this.editor.getNodeFromId(drawflowId);
                    if (edNode && edNode.data && edNode.data.params) {
                        snapshotMap[key] = JSON.parse(JSON.stringify(edNode.data.params));
                    } else {
                        snapshotMap[key] = JSON.parse(JSON.stringify(q.params));
                    }
                } catch (e) {
                    snapshotMap[key] = JSON.parse(JSON.stringify(q.params));
                }
            }
        });

        // Tier routing: se tutti i tool non-baked sono Tier 1 → fast_transform (Trimesh).
        // Se almeno uno è Tier 2 → preview_bake (Blender gestisce l'intera queue).
        const allTier1 = activeQueue.every(q => (q.tier || 2) === 1);
        const bakeAction = allTier1 ? 'fast_transform' : 'preview_bake';

        // Fix 3b (Invariante 78): mostra worker status bar con label contestuale.
        // Appare immediatamente al trigger bake (anche durante 500ms debounce);
        // se arriva un'altra requestBake() nel frattempo, il debounce resetta il
        // setTimeout ma il status bar resta visibile (label ricalcolato al prossimo
        // entry). hideWorkerStatus nel finally al termine del bake.
        const workerLabel = this._computeWorkerLabel(activeQueue);
        window.ibex?.uiMgr?.showWorkerStatus?.(workerLabel);


        // I quattro locali che la closure del debounce catturava (misurato:
        // residuo ∅ sugli altri otto locali di primo livello del metodo).
        return { activeQueue, allTargets, snapshotMap, bakeAction };
    }

    // ─────────────────────────────────────────────────────────────
    // T2Split 2026-07-29 — corpo della closure di debounce (ex righe 571-873),
    // «esegui il bake e applica il risultato». Resta `async`.
    //
    // I parametri sono ESATTAMENTE i locali che la closure catturava dalla
    // scope di requestBake, con gli STESSI nomi → il corpo non cambia.
    // Passarli per VALORE è sicuro perché lo schedule era l'ULTIMA istruzione
    // di requestBake: non esisteva codice post-schedule che potesse mutarli
    // fra lo scheduling e il fire.
    //
    // ⚠️ dedent MECCANICO di -4 (il corpo viveva a 12 spazi dentro l'arrow):
    //    verificato per costruzione, re-indentando +4 si riottiene l'originale
    //    carattere per carattere. Nessun altro cambiamento.
    // `this` era lessicale nell'arrow ⇒ è la stessa istanza qui nel metodo.
    // ─────────────────────────────────────────────────────────────
    async _postBakeApply(activeQueue, allTargets, snapshotMap, bakeAction) {
        try {
            // NonDestructive S4 — retry 429 con backoff esponenziale.
            //
            // Al loadFromConfig la catena di richieste (fetch manifest +
            // draco decoder + mesh.drc + pivot_manifest + bake POST) può
            // saturare il rate-limiter nginx. Osservato empiricamente che
            // 5×2s (10s totali) non bastava — il limite si ricarica su
            // finestre più lunghe. Strategia: backoff esponenziale fino a
            // ~90s totali. Se persiste, mostra notify e fail graceful
            // (l'utente può muovere uno slider per triggerare una nuova
            // bake quando il limite si sarà clearato).
            const backoff = [3000, 6000, 12000, 24000, 45000];  // max ~90s
            const MAX_ATTEMPTS = 6;
            let queueResp;
            let lastErr = null;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                const fd = new FormData();
                fd.append('id', window.ibex.config.projectId);
                fd.append('queue', JSON.stringify(activeQueue));
                fd.append('preview_id', Date.now());

                queueResp = await fetch(`/?action=${bakeAction}`, { method: 'POST', body: fd });
                if (queueResp.ok) break;
                if (queueResp.status !== 429) {
                    throw new Error(`HTTP ${queueResp.status}`);
                }
                lastErr = `HTTP 429 (tentativo ${attempt}/${MAX_ATTEMPTS})`;
                if (attempt >= MAX_ATTEMPTS) break;
                const wait = backoff[attempt - 1] || 60000;
                console.warn(`[BAKE] 429 su ${bakeAction}, retry ${attempt}/${MAX_ATTEMPTS} tra ${wait / 1000}s`);
                await new Promise(r => setTimeout(r, wait));
            }
            if (!queueResp.ok) {
                // Graceful fail — l'utente vede un hint e può riattivare la
                // pipeline modificando un valore (quando il rate limiter si è clearato).
                if (window.ibex?.uiMgr?.notify) {
                    window.ibex.uiMgr.notify(
                        'Server rate-limited. Muovi uno slider per riprovare.',
                        'warning'
                    );
                }
                throw new Error(lastErr || 'Bake rifiutato dopo retry');
            }

            const queueData = await queueResp.json();
            if (!queueData.queued) throw new Error(queueData.error || 'Bake non accettato');

            // Tier C V18.0: salva activeQueue per il poll handler (lookup
            // tier1Step nel progress message). Reset _tierC_swappedTargets
            // (popolato da _pollPreviewReady ad ogni progress message).
            this._lastActiveQueue = activeQueue;
            this._tierC_swappedTargets = new Set();

            const data = await this._pollPreviewReady();

            if (data.success) {
                // 1. Hot-swap geometria STL — SOLO target NON già swappati incrementalmente.
                //    Tier C: durante il poll, ogni progress message ha triggerato
                //    hot-swap della singola mesh + popolato _tierC_swappedTargets.
                //    Worker legacy (no progress messages) → Set vuoto → hot-swap full.
                const remainingTargets = Array.from(allTargets)
                    .filter(t => !this._tierC_swappedTargets.has(t));
                if (remainingTargets.length > 0) {
                    await this.hotSwapMeshes(remainingTargets);
                }

                // 2a. Tier 1: salva appliedMatFlat (Invariante 25: prima di syncPreview).
                //
                // V15.1 FIX (parenting lost post delta_sculpting): con più Tier 1 sullo
                // stesso target (es. fast_parenting + delta_sculpting), i tool non-
                // spaziali hanno world_matrix = identity. Il semplice forEach con
                // overwrite faceva vincere l'ULTIMO in coda (identity), azzerando il
                // parent transform salvato dal primo (Upper.worldMat) → doppia
                // trasformazione al render e mesh scollegata dal parent.
                //
                // Fix: per ogni target conserviamo l'ultimo world_matrix NON-identity
                // incontrato in coda topologica. Se tutti sono identity (caso: solo
                // delta_sculpting senza parenting), salviamo identity (il render userà
                // applyMat = worldMat × identity_inv = worldMat su vertici in scanner
                // coords, corretto).
                const _isIdentityMat = (arr) => {
                    if (!arr || arr.length !== 16) return false;
                    for (let i = 0; i < 16; i++) {
                        const expected = (i % 5 === 0) ? 1 : 0;
                        if (Math.abs(arr[i] - expected) > 1e-9) return false;
                    }
                    return true;
                };
                const _bestMatrixByTarget = new Map();
                activeQueue
                    .filter(q => (q.tier || 2) === 1 && q.params && q.params.world_matrix)
                    .forEach(q => {
                        const existing = _bestMatrixByTarget.get(q.target);
                        const isId = _isIdentityMat(q.params.world_matrix);
                        // Scrivi se: (a) non esiste ancora nulla per questo target,
                        // o (b) il nuovo matrix è NON-identity (rimpiazza una eventuale
                        // identity precedente). Non rimpiazzare mai una non-identity
                        // con una identity (caso bug V15.0).
                        if (!existing || (!isId && _isIdentityMat(existing))) {
                            _bestMatrixByTarget.set(q.target, q.params.world_matrix);
                        } else if (!isId) {
                            // Entrambe non-identity: vince l'ULTIMA (cumulativa downstream)
                            _bestMatrixByTarget.set(q.target, q.params.world_matrix);
                        }
                    });
                _bestMatrixByTarget.forEach((matrix, target) => {
                    const mesh = this.executor.findTargetMesh(target);
                    if (!mesh) return;

                    // V15.6 FIX: se sculpt è attivo sul target, NON aggiornare
                    // appliedMatFlat. hotSwapMeshes ha già skippato la geometria
                    // → i vertici restano in M_ft_old WS + strokes locali.
                    // appliedMatFlat DEVE restare = M_ft_old, così applyGraph():
                    //   applyMat = M_ft_new × M_ft_old_inv
                    // sposta correttamente i vertici stale da M_ft_old a M_ft_new.
                    // Se aggiornassimo appliedMatFlat = M_ft_new:
                    //   applyMat = M_ft_new × M_ft_new_inv = identity → Lower FROZEN.
                    const smCheck = window.ibex?.sculptMgr;
                    if (smCheck && smCheck.active && smCheck.targetMesh &&
                        smCheck.targetMesh.name === target) {
                        console.log(`[TIER1] appliedMatFlat SKIP sculpt: ${target} (preserva old per delta-corr corretta)`);
                        return;
                    }

                    mesh.userData.appliedMatFlat = matrix.slice();
                    console.log(`[TIER1] appliedMatFlat salvato: ${target} (id=${_isIdentityMat(matrix)})`);
                });

                // 2b. Tier 2: persist preview_baked_params nel Drawflow
                let persistCount = 0;
                const toolNodes = this.graph.nodes.filter(n => n.type === 'tool');

                toolNodes.forEach(node => {
                    // Tier 1 usa appliedMatFlat — non ha bisogno di preview_baked_params
                    if ((node.tier || 2) === 1) return;

                    const nodeKey = String(node.id);
                    let snapshot = snapshotMap[nodeKey];

                    // Fallback per tool senza snapshot (es. gn_parenting legacy)
                    if (!snapshot) {
                        try {
                            const fallbackId = parseInt(node.id, 10);
                            const fallbackNode = this.editor.getNodeFromId(fallbackId);
                            if (fallbackNode && fallbackNode.data && fallbackNode.data.params) {
                                snapshot = JSON.parse(JSON.stringify(fallbackNode.data.params));
                            } else {
                                snapshot = null;
                            }
                        } catch (e) {
                            snapshot = null;
                        }
                    }

                    // Bug #8 fix: tool senza params SRT → null (non {}).
                    // parentingBaked in applyGraph() controlla !== null && length > 0.
                    if (snapshot && Object.keys(snapshot).length === 0) {
                        snapshot = null;
                    }

                    try {
                        const drawflowId = parseInt(node.id, 10);
                        const edNode = this.editor.getNodeFromId(drawflowId);

                        if (!edNode) {
                            console.warn(`[PERSIST] Node ${drawflowId}: non trovato in Drawflow!`);
                            return;
                        }

                        edNode.data.preview_baked_params = snapshot !== null
                            ? JSON.parse(JSON.stringify(snapshot))
                            : null;
                        this.editor.updateNodeDataFromId(drawflowId, edNode.data);
                        persistCount++;

                        console.log(`[PERSIST] Node ${drawflowId}: preview_baked_params salvato`);
                    } catch (e) {
                        console.error(`[PERSIST] ERRORE su node ${node.id}:`, e);
                    }
                });

                console.log(`[PERSIST] ${persistCount}/${toolNodes.filter(n => (n.tier||2)===2).length} nodi Tier 2 aggiornati.`);
                Object.assign(this._lastBakedParams, snapshotMap);

                // PyMeshLab_V17.5 Bug 2 — popola _lastBakedTargets con ogni
                // target appena bakato (usato al prossimo requestBake per
                // detectare orfani da revertToMaster).
                allTargets.forEach(t => this._lastBakedTargets.add(t));

                // V17.8 — replace `_lastBakedNodeIds` con la queue appena
                // bakata. Al prossimo requestBake, se gli ID non coincidono
                // (nodo rimosso/aggiunto), `topologyChanged=true` → bake
                // forzato anche se i params sono invariati.
                this._lastBakedNodeIds = new Set(
                    activeQueue.map(q => String(q._nodeId))
                );

                // 3. syncPreview — extractDAG + applyGraph
                this.stackMgr.syncPreview();

                // 4. S3: auto-hide master se split attivo (mesh derivate in scena).
                if (this.sceneMgr?.updateSplitMasterVisibility && this.stackMgr?.graph) {
                    this.sceneMgr.updateSplitMasterVisibility(this.stackMgr.graph);
                }

                // DrawCurve V1.0 (2026-05-07/08): in modalità curva il worker
                // produce le 2 mesh derivate A/B SUL DISCO ma NON le carica
                // automaticamente in scena (a differenza di modalità brush
                // dove `SelectionMode.applySplit` le carica esplicitamente
                // via loader.load post-saveSplit). hotSwapMeshes opera solo
                // sui target nella queue — il target di split_topology è la
                // mesh master upstream, NON i 2 derivati. Senza un load
                // esplicito, l'utente vede la sola mesh master post-bake e
                // crede che il cut non sia avvenuto.
                //
                // Soluzione: chiama `_loadSplitDerivedMeshes` di IbexCore
                // (idempotente — skip se mesh già in scena) per caricare
                // i 2 file derivati `{stem}_snap_{nodeId}_[AB].stl` di ogni
                // nodo split nel DAG. Async ma fire-and-forget — il render
                // successivo li mostra in scena.
                if (window.ibex?._loadSplitDerivedMeshes) {
                    window.ibex._loadSplitDerivedMeshes()
                        .then(() => {
                            // Refresh meta DOPO che le mesh sono in scena —
                            // così `_refreshSplitNodesMetaPostBake` trova le
                            // mesh A/B e popola il template del nodo split.
                            this.stackMgr._refreshSplitNodesMetaPostBake?.();
                        })
                        .catch(e => console.warn('[BakeEngine] _loadSplitDerivedMeshes post-bake failed:', e));
                } else {
                    // Fallback: niente loader → solo refresh meta (le mesh
                    // probabilmente non saranno in scena ma il chiamante
                    // gestisce il caso "no derivate" silenziosamente).
                    this.stackMgr._refreshSplitNodesMetaPostBake?.();
                }

                // ArchDetect V1.1 (2026-05-12): post-bake fetch dei metadata
                // .crv.json per ogni nodo arch_detect nel DAG. Popola
                // `node.data.meta` con n_ctrl_points, arch_length_mm, ecc.
                // → label DAG si aggiorna ("Arcata · 50 pts · 77mm")
                // → inspector mostra i metadata se aperto sul nodo.
                if (window.ibex?.refreshArchDetectMetadata) {
                    window.ibex.refreshArchDetectMetadata()
                        .catch(e => console.warn('[BakeEngine] refreshArchDetectMetadata post-bake failed:', e));
                }
                // CurveDisplayName V14 (2026-05-14): post-bake re-show
                // anche degli overlay draw_curve. Le curve sono in LOCAL
                // space (CurveMode V2.13) → se la mesh upstream è ruotata
                // dal bake (Tier 1), serve refresh per riapplicare
                // mesh.matrixWorld al rendering 3D.
                if (window.ibex?._loadDrawCurveOverlays) {
                    window.ibex._loadDrawCurveOverlays()
                        .catch(e => console.warn('[BakeEngine] _loadDrawCurveOverlays post-bake failed:', e));
                }

                // 5. Refresh context inspector se aperto
                if (window.ibex?.contextInspector) window.ibex.contextInspector.refresh();

                if (this.sceneMgr) this.sceneMgr.render();
                console.log(`[IBEX] ✅ Hot-swap completo (${bakeAction}).`);

                // Fix 3c (Invariante 78): flash verde 1s sui nodi della queue
                // al success. Non è step-per-step (il worker batch-processa
                // l'intera queue), è un segnale atomico "bake completato".
                this._markDone(activeQueue);

            } else {
                console.warn('[IBEX] Bake error:', data.error);
                if (window.ibex && window.ibex.uiMgr) window.ibex.uiMgr.notify('Blender: ' + (data.error || 'Errore'), 'error');
                this._markError(activeQueue);
            }
        } catch (err) {
            console.error('[IBEX] Bake failed:', err);
            if (window.ibex && window.ibex.uiMgr) window.ibex.uiMgr.notify('Errore: ' + err.message, 'error');
            this._markError(activeQueue);
        } finally {
            this._bakeLock = false;

            // L7.1: rete di sicurezza — se il poll fosse uscito per una via
            // imprevista, qui il banner «bake lento» viene comunque spento.
            this._slowBakeClear();

            // UX V15.0: spegni gli ingranaggi (ora no-op) + V16.1 rimuovi
            // classe processing dai nodi.
            document.getElementById('engine-gears')?.classList.remove('is-calculating');
            this._clearProcessing();

            // Fix 3b (Invariante 78): nasconde la worker status bar.
            // Se c'è un _pendingRebake in coda, il rilancio qui sotto
            // tornerà a showWorkerStatus al prossimo giro.
            window.ibex?.uiMgr?.hideWorkerStatus?.();

            // Aggiorna outliner (Invariante Bug B preservato: la cattura
            // visualState non include più l'opacity-temporary perché non
            // viene mai modificata)
            if (window.ibex && window.ibex.outlinerMgr) window.ibex.outlinerMgr.update();
            if (this.sceneMgr) this.sceneMgr.render();

            if (this._pendingRebake) {
                this._pendingRebake = false;
                setTimeout(() => this.requestBake(), 100);
            }
        }
    }


    async hotSwapMeshes(targetNames) {
        if (!window.ibex || !window.ibex.loader || !window.ibex.sceneMgr) return;

        // ═══════════════════════════════════════════════════════════
        // V15.2 — Skip hot-swap sul target sculpt quando sculpt mode è attivo
        //
        // Causa radice del bug "strokes spariscono e ricompaiono":
        //   SculptMode._applyBrushLocal() modifica DIRETTAMENTE i vertici
        //   della geometry locale a ogni stroke (feedback immediato). Il
        //   worker bake-rebatte preview/Lower.stl in background. Se l'utente
        //   completa stroke N+1 mentre il bake con stroke [1..N] è in volo,
        //   hot-swap carica il disco (N strokes) e sostituisce la geometry
        //   locale (che ha N+1 strokes) → stroke N+1 SPARISCE. Poco dopo il
        //   bake successivo include N+1 e il successivo hot-swap lo riporta
        //   → stroke N+1 RICOMPARE. Ciclo disappear/reappear ogni 1.5-3s.
        //
        // Il check precedente (`sm.active && sm.dragging`) era troppo stretto:
        //   sm.dragging è true solo da mousedown a mouseup, NON tra strokes.
        //   Il bake race avviene tra strokes, quando sm.dragging=false.
        //
        // Fix: se sm.active, filtra OUT il target sculpt dalla lista hot-swap.
        // Gli altri target (Upper) vengono hot-swappati normalmente.
        // applyGraph() continua a seguire Upper grazie ad appliedMatFlat:
        //   applyMat = worldMat_new × appliedMat_old_inv
        // applicato a vertici Lower in "old WS + sculpt locale" produce
        // "new WS + sculpt locale" → parenting preservato senza bisogno di
        // ricaricare il disco.
        //
        // Quando l'utente esce da sculpt mode (exit()), il prossimo bake
        // triggererà hot-swap pieno sul target e sincronizzerà disco+local.
        // ═══════════════════════════════════════════════════════════
        const sm = window.ibex.sculptMgr;
        let filteredTargets = targetNames;
        if (sm && sm.active && sm.targetMesh && sm.targetMesh.name) {
            const sculptTargetName = sm.targetMesh.name;
            const originalLen = filteredTargets.length;
            filteredTargets = filteredTargets.filter(t => {
                const clean = t.startsWith('tool_output_') ? this.stackMgr.resolveBaseMesh(t) : t;
                return clean !== sculptTargetName;
            });
            if (filteredTargets.length < originalLen) {
                console.log(`[HOT-SWAP] skip sculpt target: ${sculptTargetName} (geometry locale preservata, ha gli strokes più recenti)`);
            }
        }

        if (filteredTargets.length === 0) return;

        // SnapshotKeyed S3 (2026-04-25): add-if-missing per mesh post-split.
        // Quando il target esiste già in scena → replace geometry (pattern legacy).
        // Quando il target NON esiste (es. Upper_snap_5_A.stl appena creato) →
        // load completo + sceneMgr.addMesh(). Questo è il meccanismo con cui
        // le mesh derivate dal nodo split appaiono nella scena al primo bake
        // post-applySplit. Senza questo, il target sarebbe silenziosamente
        // ignorato e l'utente non vedrebbe i 2 rami A/B.
        const results = await Promise.all(filteredTargets.map(async (name) => {
            const clean = name.startsWith('tool_output_') ? this.stackMgr.resolveBaseMesh(name) : name;
            const old = this.executor.findTargetMesh(clean);
            try {
                if (old) {
                    // Flow standard: replace geometry esistente.
                    const fresh = await window.ibex.loader.load({ path: clean, bustCache: true });
                    fresh.geometry.computeVertexNormals();
                    fresh.geometry.computeBoundingBox();
                    fresh.geometry.computeBoundingSphere();
                    return { name: clean, geometry: fresh.geometry, old, isNew: false };
                } else {
                    // S3: target assente → mesh derivata da split appena creata.
                    // Load completo (includes material matcap + pivot) e aggiungi in scena.
                    const fresh = await window.ibex.loader.load({ path: clean, bustCache: true });
                    return { name: clean, freshMesh: fresh, old: null, isNew: true };
                }
            } catch (err) {
                console.warn(`[IBEX] Hot-swap failed: ${clean}`, err);
                return null;
            }
        }));

        // V15.3 (Fix B): re-check sculpt state DOPO il Promise.all.
        // Il filter iniziale (sopra) valuta sm.active al momento della chiamata,
        // PRIMA dell'await. Se l'utente entra in sculpt mode DURANTE il fetch (~200ms)
        // e applica le prime pennellate via _applyBrushLocal (modifica diretta della
        // geometry), il replace sotto sovrascriverebbe quelle modifiche locali con
        // la geometry dal disco (che non le ha ancora). Risultato: strokes spariti.
        //
        // Questa seconda check blocca il replace per il target sculpt se sm.active
        // è true al momento del replace, anche se era false al momento del filter.
        // La fresh geometry viene comunque disposta per evitare memory leak.
        const smLate = window.ibex.sculptMgr;
        const lateSkipName = (smLate && smLate.active && smLate.targetMesh && smLate.targetMesh.name)
            ? smLate.targetMesh.name
            : null;

        results.forEach(r => {
            if (!r) return;

            // S3: gestione add-if-missing per mesh derivate da split.
            if (r.isNew) {
                if (lateSkipName && r.name === lateSkipName) {
                    console.log(`[HOT-SWAP] late skip add new mesh (sculpt attivato): ${r.name}`);
                    return;
                }
                // Aggiungi la nuova mesh alla scena. MeshLoader ha già calcolato
                // il pivot via BBox (fallback on-the-fly, S3-A3: non in
                // mesh_pivots.json).
                window.ibex.sceneMgr.addMesh(r.freshMesh);
                console.log(`[HOT-SWAP] added new mesh to scene: ${r.name}`);
                return;
            }

            if (!r.old) return;
            if (lateSkipName && r.name === lateSkipName) {
                console.log(`[HOT-SWAP] late skip (sculpt attivato durante fetch): ${r.name}`);
                if (r.geometry && typeof r.geometry.dispose === 'function') {
                    r.geometry.dispose();
                }
                return;
            }
            r.old.geometry.dispose();
            r.old.geometry = r.geometry;

            // ═══════════════════════════════════════════════════════════
            // SculptV2_S7 — invalidazione cache topologica post-hotswap.
            //
            // `SculptMode._brushSmooth` costruisce un adjacency (vert→neighbors)
            // cachato in `mesh.userData.vertNeighbors`, invalidato solo su
            // cambio di `N` (vertex count). Meshcleaner via `holes_fill` o
            // `triangle_fill+join_triangles` aggiunge FACCE ma non sempre verts
            // (N invariato, topologia cambiata) → cache stale → smooth tira i
            // verts verso vicini che non esistono più = mesh bucata in corrispondenza
            // dei fori appena chiusi. Fix: resetta qui, il prossimo _brushSmooth
            // ricostruisce su geometry fresca. Sentinel `vertNeighborsGeom`
            // permette anche il check "geometry reference swap" in SculptMode.
            // ═══════════════════════════════════════════════════════════
            r.old.userData.vertNeighbors     = null;
            r.old.userData.vertNeighborsN    = -1;
            r.old.userData.vertNeighborsGeom = null;

            // S4 Mod2: re-init IbexBridge se presente — dopo geometry replace
            // il MeshDynamic interno al bridge è stale (punta al vecchio
            // BufferGeometry). Ricostruisce MeshDynamic + Octree dalla nuova
            // geometria così il prossimo SculptMode.enter() sullo stesso mesh
            // parte dalla mesh post-bake (es. post-meshcleaner) e non dalla
            // geometria pre-bake.
            //
            // Skip quando sculpt è attivo sullo stesso mesh: in quel caso il
            // geometry replace non è stato eseguito (lateSkipName check sopra),
            // quindi non arriviamo qui — ma controlliamo comunque per robustezza.
            if (r.old.userData?.sculptgl) {
                const sm = window.ibex?.sculptMgr;
                const isSculptActiveOnThis = sm && sm.active && sm.targetMesh === r.old;
                if (!isSculptActiveOnThis) {
                    try {
                        r.old.userData.sculptgl.initFromThreeMesh(r.old);
                    } catch (err) {
                        console.warn(`[HOT-SWAP] sculptgl re-init failed on ${r.name}:`, err);
                    }
                }
            }

            // Pivot NON aggiornato dopo hotswap: il pivot originale scanner (da mesh_pivots.json)
            // deve restare invariato perché appliedMatFlat (Tier 1) e bakedMat (Tier 2) sono
            // codificati con quel pivot. Sovrascriverlo con il BBox AABB WS post-swap rompe
            // il delta correction in applyGraph():
            //   worldMat(curSRT, pivot_AABB_WS) ≠ appliedMatFlat(bakedSRT, pivot_scanner)
            //   anche quando curSRT == bakedSRT → jump visibile appena la mesh torna opaca.
            //
            // La formula buildPivotedMatrix(srt, P) gestisce già la posizione world corrente:
            //   worldMat × P = T_P × T_tx × Rx × T_negP × P = P + T_user
            // La rotazione avviene sempre attorno a (P + T_user), la posizione corrente.
            // Il pivot P è un riferimento matematico fisso in scanner space — non va aggiornato.
        });
    }

    // ═══════════════════════════════════════════════════════════
    // PyMeshLab_V17.5 Bug 2 fix — revertToMaster(targetsSet)
    //
    // Chiamato da requestBake() quando dei target sono "orfani" (erano
    // in _lastBakedTargets ma la queue corrente non li contiene più —
    // succede quando l'utente cancella dal DAG gli ultimi tool che
    // agivano su quei target). preview/ lato server è stale e il client
    // continua a vedere la mesh post-pipeline. Ricarica la geometria
    // master via serve_file ?from=master e la swappa in-place.
    //
    // Nessuna chiamata al worker: la preview/ lato server resta
    // invariata ma irrilevante — al prossimo bake sarà riscritta;
    // al SAVE_EXIT viene eliminata (invariante 28).
    //
    // Skip del target sculpt attivo (stesso pattern di hotSwapMeshes
    // V15.2/V15.3 — la geometry locale ha gli strokes più recenti).
    // ═══════════════════════════════════════════════════════════
    async revertToMaster(targetsSet) {
        if (!window.ibex || !window.ibex.loader || !window.ibex.sceneMgr) return;
        if (!targetsSet || targetsSet.size === 0) return;

        const sm = window.ibex.sculptMgr;
        const sculptTargetName = (sm && sm.active && sm.targetMesh && sm.targetMesh.name)
            ? sm.targetMesh.name : null;

        const targetList = Array.from(targetsSet).filter(t => t !== sculptTargetName);
        if (targetList.length === 0) return;

        // S3 (2026-04-25): split-aware revert. I target post-split hanno il
        // pattern `{stem}_snap_{nodeId}_[AB].stl` — sono mesh DERIVATE (non
        // master). Quando un orfano è così, non c'è un master a cui "tornare":
        // la mesh deve essere RIMOSSA dalla scena (+ dall'outliner). Il lazy
        // cleanup dei file `_snap_*.stl` avviene al save_exit (pattern esistente).
        const _SPLIT_TARGET_RX = /^.+_snap_[A-Za-z0-9_\-]+_[AB]\.stl$/i;
        const postSplitTargets = [];
        const masterTargets = [];
        for (const t of targetList) {
            const clean = t.startsWith('tool_output_') ? this.stackMgr.resolveBaseMesh(t) : t;
            if (_SPLIT_TARGET_RX.test(clean)) {
                postSplitTargets.push(clean);
            } else {
                masterTargets.push(clean);
            }
        }

        // Rimuovi le mesh derivate da split dalla scena.
        if (postSplitTargets.length > 0) {
            console.log(`[REVERT-MASTER] rimozione mesh post-split:`, postSplitTargets);
            for (const name of postSplitTargets) {
                const mesh = this.executor.findTargetMesh(name);
                if (mesh && window.ibex.sceneMgr?.group) {
                    if (mesh.geometry && typeof mesh.geometry.dispose === 'function') {
                        mesh.geometry.dispose();
                    }
                    window.ibex.sceneMgr.group.remove(mesh);
                }
            }
        }

        if (masterTargets.length === 0) {
            // Solo mesh post-split da rimuovere: sync UI e render finale.
            if (window.ibex.outlinerMgr) window.ibex.outlinerMgr.update();
            // S3: ora che le mesh derivate sono state rimosse, ri-mostra il
            // master se era stato auto-nascosto.
            if (this.sceneMgr?.updateSplitMasterVisibility && this.stackMgr?.graph) {
                this.sceneMgr.updateSplitMasterVisibility(this.stackMgr.graph);
            }
            this.stackMgr.syncPreview();
            if (this.sceneMgr) this.sceneMgr.render();
            return;
        }

        console.log(`[REVERT-MASTER] target orfani → master:`, masterTargets);

        const results = await Promise.all(masterTargets.map(async (name) => {
            const clean = name;  // già risolto sopra
            const old = this.executor.findTargetMesh(clean);
            if (!old) return null;
            try {
                const fresh = await window.ibex.loader.load({
                    path: clean, bustCache: true, fromMaster: true,
                });
                fresh.geometry.computeVertexNormals();
                fresh.geometry.computeBoundingBox();
                fresh.geometry.computeBoundingSphere();
                return { name: clean, geometry: fresh.geometry, old };
            } catch (err) {
                console.warn(`[REVERT-MASTER] failed: ${clean}`, err);
                return null;
            }
        }));

        // Re-check sculpt state dopo Promise.all (pattern hotSwapMeshes V15.3).
        const smLate = window.ibex.sculptMgr;
        const lateSkipName = (smLate && smLate.active && smLate.targetMesh && smLate.targetMesh.name)
            ? smLate.targetMesh.name : null;

        results.forEach(r => {
            if (!r || !r.old) return;
            if (lateSkipName && r.name === lateSkipName) {
                if (r.geometry && typeof r.geometry.dispose === 'function') r.geometry.dispose();
                return;
            }
            r.old.geometry.dispose();
            r.old.geometry = r.geometry;
            // Reset cache topologica (stessa logica hotSwapMeshes).
            r.old.userData.vertNeighbors     = null;
            r.old.userData.vertNeighborsN    = -1;
            r.old.userData.vertNeighborsGeom = null;
            // Invalida appliedMatFlat (master = scanner-space, niente matrice Tier 1 applicata).
            r.old.userData.appliedMatFlat    = null;

            // S4 Mod2: re-init IbexBridge se presente — stesso ragionamento di
            // hotSwapMeshes. Dopo revert al master, MeshDynamic deve riflettere
            // la geometria master (scanner-space), non la precedente post-pipeline.
            if (r.old.userData?.sculptgl) {
                const sm = window.ibex?.sculptMgr;
                const isSculptActiveOnThis = sm && sm.active && sm.targetMesh === r.old;
                if (!isSculptActiveOnThis) {
                    try {
                        r.old.userData.sculptgl.initFromThreeMesh(r.old);
                    } catch (err) {
                        console.warn(`[REVERT-MASTER] sculptgl re-init failed on ${r.name}:`, err);
                    }
                }
            }
        });

        // Re-apply grafo (eventuali tool rimasti agiscono in applyGraph su master).
        this.stackMgr.syncPreview();
        // S3: sincronizza visibility dei master (show se i loro split derivate
        // sono stati rimossi). Usa il graph corrente post-syncPreview.
        if (this.sceneMgr?.updateSplitMasterVisibility && this.stackMgr?.graph) {
            this.sceneMgr.updateSplitMasterVisibility(this.stackMgr.graph);
        }
        // ColorReady L11.3 (fix L1): questo ramo (masterTargets>0) sostituisce la geometry
        // (r.old.geometry = r.geometry) tenendo il material → è l'UNICO percorso di load/swap
        // che NON passava per outlinerMgr.update(). Con colorMode ON e material vertexColors=true,
        // la geometry master appena caricata può non avere l'attributo colore → mesh NERA
        // PERSISTENTE (non un flash). update() riconcilia il flag prima del render.
        if (window.ibex?.outlinerMgr) window.ibex.outlinerMgr.update();
        if (this.sceneMgr) this.sceneMgr.render();
    }

    async _pollPreviewReady(maxWaitMs = 300000) {
        // LONG-POLLING V16.0: il PHP checkPreview ora blocca su BLPOP 25s.
        // Una singola richiesta fetch può attendere fino a 25s che il worker
        // risponda. Zero polling, zero rate-limit nginx.
        //
        // Tier C V18.0 (2026-04-30): supporto progress messages per hot-swap
        // incrementale. Il worker emette N+1 messaggi sul response_channel:
        //   - N messaggi {progress:true, target:X, success:bool, error?}
        //     → uno per ogni sub-task MESH_PIPELINE completato. Hot-swap
        //     immediato della singola mesh + appliedMatFlat + syncPreview.
        //     Failure parziale (success:false) → notify rosso, mesh non swappata.
        //   - 1 messaggio finale {success:true} per chiudere il poll.
        //
        // Worker legacy (senza Tier C): emette solo {success:true} finale.
        // Il poll handler ritorna direttamente — _tierC_swappedTargets resta
        // vuoto → requestBake fa hot-swap full come fallback.
        //
        // On 429: backoff 2s. On errore rete: pausa 500ms e riprova.
        const id = window.ibex.config.projectId;
        const deadline = Date.now() + maxWaitMs;
        const BACKOFF_429_MS   = 2000;
        const NETWORK_RETRY_MS = 500;

        // 2026-07-14 — TIMEOUT PER SINGOLA RICHIESTA (AbortController).
        //
        // Prima di oggi la `fetch` non aveva alcun timeout. La scadenza (`deadline`)
        // è valutata SOLO tra un giro e l'altro del while: se una singola richiesta
        // non si risolve MAI (php-fpm saturo, upstream appeso, connessione morta a
        // metà), il while non torna mai a controllarla → questa funzione non ritorna
        // mai → il `finally` di requestBake non gira mai → `_bakeLock` resta true PER
        // SEMPRE. Conseguenza visibile: il bollino "calcolo in corso" resta acceso, e
        // — peggio — ogni bake successivo esce subito (`if (this._bakeLock) return`),
        // quindi muovere gli slider non produce più NULLA. L'app sembra morta mentre i
        // worker sono liberi e la coda è vuota.
        //
        // 30s > i 25s del BLPOP server-side (Inv. 48): una risposta legittima fa sempre
        // in tempo; una richiesta appesa viene abortita e il giro riparte (o scade).
        const FETCH_TIMEOUT_MS = 30000;

        // L7.1: da qui il bake è "in volo" → arma il timer di silenzio (60s).
        // Ogni progress lo ri-arma; entrambe le uscite della funzione lo spengono
        // (e requestBake lo rispegne nel suo finally, cintura e bretelle).
        this._slowBakeStart();

        while (Date.now() < deadline) {
            const ac  = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            const tid = ac ? setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS) : null;
            try {
                const resp = await fetch(`/?action=check_preview&id=${id}`,
                                         ac ? { signal: ac.signal } : undefined);
                if (resp.status === 429) {
                    await new Promise(r => setTimeout(r, BACKOFF_429_MS));
                    continue;
                }
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.pending) {
                        // BLPOP timed out server-side, rilanciamo subito
                        continue;
                    }
                    if (data.progress) {
                        // L7.1: avanzamento reale → via il banner, timer da capo.
                        this._slowBakeKick();
                        // Tier C progress message: hot-swap incrementale di
                        // una singola mesh appena pronta dal sub-task.
                        try {
                            await this._handleTierCProgress(data);
                        } catch (e) {
                            console.warn('[TIER C] progress handler error:', e);
                        }
                        continue;  // resta in attesa di altri progress / final
                    }
                    // Final response (success:true o success:false)
                    this._slowBakeClear();          // L7.1
                    return data;
                }
                // 5xx o altri: breve pausa e riprova
                await new Promise(r => setTimeout(r, NETWORK_RETRY_MS));
            } catch (e) {
                if (e?.name === 'AbortError') {
                    // Richiesta abortita dal nostro timeout: il server non ha
                    // risposto entro 30s (php-fpm saturo? upstream appeso?).
                    // NON è normale — va visto. Il giro riparte e la `deadline`
                    // torna a essere valutata: niente più blocco infinito.
                    console.warn('[BakeEngine] check_preview: nessuna risposta entro '
                                 + `${FETCH_TIMEOUT_MS}ms, riprovo`);
                    continue;
                }
                await new Promise(r => setTimeout(r, NETWORK_RETRY_MS));
            } finally {
                if (tid) clearTimeout(tid);   // vale anche per i `continue` e i `return` sopra
            }
        }
        this._slowBakeClear();                      // L7.1
        return { success: false, error: 'Timeout: il motore 3D non ha risposto entro 90 secondi.' };
    }

    // Tier C V18.0 (2026-04-30): handler per progress messages dal worker.
    // Chiamato da _pollPreviewReady quando arriva {progress:true, target, success, error?}.
    // Failure parziale (success:false) → notify rosso, mesh NON swappata
    //   (preview/{target}.stl mantiene versione precedente).
    // Success → hot-swap singola mesh + appliedMatFlat (Tier 1) + syncPreview.
    // Marca target come swappato in _tierC_swappedTargets per skippare
    // hot-swap full nel post-success di requestBake.
    async _handleTierCProgress(data) {
        const target = data.target;
        if (!target) return;

        if (!data.success) {
            // Sub-task fallito per questo target: notify, mesh non aggiornata
            const errMsg = data.error || 'errore sub-task';
            console.warn(`[TIER C] progress FAIL ${target}: ${errMsg}`);
            window.ibex?.uiMgr?.notify?.(`${target}: ${errMsg}`, 'error');
            // NON aggiungiamo a _tierC_swappedTargets — la mesh non è cambiata,
            // quindi requestBake post-success NON deve fare hot-swap (sarebbe
            // ridondante: la versione precedente è già visualizzata).
            // Però la marchiamo come "processata" per evitare hot-swap full
            // ridondante (la versione precedente NON è cambiata su disco):
            this._tierC_swappedTargets.add(target);
            return;
        }

        // Success: hot-swap singola mesh
        await this.hotSwapMeshes([target]);

        // Salva appliedMatFlat per Tier 1 step di questo target (Invariante 25:
        // PRIMA di syncPreview). Lookup nell'_lastActiveQueue salvato in requestBake.
        const _isIdMat = (a) => {
            if (!a || a.length !== 16) return false;
            for (let i = 0; i < 16; i++) {
                if (Math.abs(a[i] - (i % 5 === 0 ? 1 : 0)) > 1e-9) return false;
            }
            return true;
        };
        const tier1Steps = (this._lastActiveQueue || [])
            .filter(q => q.target === target && (q.tier || 2) === 1
                         && q.params && q.params.world_matrix);
        if (tier1Steps.length > 0) {
            // Stesso pattern V15.1 di requestBake: ultimo NON-identity vince
            let bestMat = null;
            for (const q of tier1Steps) {
                const m = q.params.world_matrix;
                const isId = _isIdMat(m);
                if (!bestMat) {
                    bestMat = m;
                } else if (!isId) {
                    bestMat = m;
                }
            }
            if (bestMat) {
                const mesh = this.executor.findTargetMesh(target);
                const sm = window.ibex?.sculptMgr;
                if (mesh && !(sm && sm.active && sm.targetMesh && sm.targetMesh.name === target)) {
                    mesh.userData.appliedMatFlat = bestMat.slice();
                }
            }
        }

        // Re-apply grafo per i tool downstream non-baked (su master)
        this.stackMgr.syncPreview();
        if (this.sceneMgr) this.sceneMgr.render();

        // Marca come swappato → requestBake post-success skippa hot-swap full
        this._tierC_swappedTargets.add(target);
        console.log(`[TIER C] hot-swap incrementale OK: ${target}`);
    }

    // applySidecarAttributes RIMOSSA — ibx_geo-pivot obsoleto

    // ═══════════════════════════════════════════════════════════════
    // D1 (DarkRedesign V16.1): classi stato nodi DAG
    // ═══════════════════════════════════════════════════════════════

    _markProcessing(queue) {
        if (!Array.isArray(queue)) return;
        queue.forEach(q => {
            if (!q || !q._nodeId) return;
            const el = document.getElementById('node-' + q._nodeId);
            if (el) el.classList.add('ibex-node-processing');
        });
    }

    _clearProcessing() {
        document.querySelectorAll('.drawflow-node.ibex-node-processing').forEach(el => {
            el.classList.remove('ibex-node-processing');
        });
    }

    _markError(queue, duration = 3000) {
        if (!Array.isArray(queue)) return;
        const nodeEls = [];
        queue.forEach(q => {
            if (!q || !q._nodeId) return;
            const el = document.getElementById('node-' + q._nodeId);
            if (el) {
                el.classList.add('ibex-node-error');
                nodeEls.push(el);
            }
        });
        setTimeout(() => {
            nodeEls.forEach(el => el.classList.remove('ibex-node-error'));
        }, duration);
    }

    // ═══════════════════════════════════════════════════════════════
    // Fix 3b/3c (Invariante 78) — Worker feedback helpers
    // ═══════════════════════════════════════════════════════════════

    // Label per worker status bar. Priorità: sculpt > Tier 2 > solo Tier 1.
    // Se il grafo ha un nodo `sculpt` attivo, "Applicando scolpitura..." vince
    // anche se ci sono altri tool — è l'operazione più vistosa per l'utente
    // e quella che spiega la presenza/assenza del `_sculpted.stl`.
    _computeWorkerLabel(queue) {
        if (!Array.isArray(queue) || queue.length === 0) return 'Calcolo in corso...';
        if (queue.some(q => q && q.tool === 'sculpt'))       return 'Applicando scolpitura...';
        if (queue.some(q => q && (q.tier || 2) === 2))       return 'Calcolo mesh in corso...';
        return 'Applicando trasformazioni...';
    }

    // Flash verde .ibex-node-done 1s a fine bake. Non è step-per-step
    // (il worker batch-processa l'intera queue), è un segnale atomico
    // "tutti i nodi di questo bake sono completati".
    _markDone(queue, duration = 1000) {
        if (!Array.isArray(queue)) return;
        const nodeEls = [];
        queue.forEach(q => {
            if (!q || !q._nodeId) return;
            const el = document.getElementById('node-' + q._nodeId);
            if (el) {
                el.classList.add('ibex-node-done');
                nodeEls.push(el);
            }
        });
        setTimeout(() => {
            nodeEls.forEach(el => el.classList.remove('ibex-node-done'));
        }, duration);
    }
}
