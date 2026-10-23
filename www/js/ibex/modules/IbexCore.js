// --- IMPORT CON VERSIONING FORZATO (CACHE BUSTER: SculptV2_Session1) ---
import * as THREE            from 'three';
import {
    computeBoundsTree,
    disposeBoundsTree,
    acceleratedRaycast
} from 'three-mesh-bvh';

// Patch prototype UNA volta sola al bootstrap (invariante Sculpt V2).
// Da questo momento tutti i Raycaster di Three.js sono BVH-accelerati; ogni
// BufferGeometry espone computeBoundsTree()/disposeBoundsTree() usati da
// MeshLoader al load delle mesh e dal futuro SculptMode BVH.
if (!THREE.BufferGeometry.prototype.computeBoundsTree) {
    THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
    THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
    THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

import { SceneManager }      from './SceneManager.js?v=UXA2_V7.7-hires';
import { MeshLoader }        from './MeshLoader.js?v=ColorReady_V16.5';
import { StateManager }      from './StateManager.js?v=DeadCode_V4.9';
import { UIManager }         from './UIManager.js?v=ShellSync_V1.4';
import { ToolExecutor }      from './ToolExecutor.js?v=RollbackCurveTransform_V17.10';
import { OutlinerManager }   from './OutlinerManager.js?v=ColorReady_V14.4';
import { StackManager }      from './StackManager.js?v=BurnRename_L10.1-FormatSel_L10.4-RootDir_27-7-GodCollapse_29-7-T2Split_29-7-BakeSplit_29-7-P3H1_30-7';
import { ContextInspector }  from './ContextInspector.js?v=IbexInspector_V2.44-BurnRename_L10.1-FormatSel_L10.4-RootDir_27-7-GodSplit_29-7-T1Escape_29-7';
import { InspectorPanel }    from './InspectorPanel.js?v=InspectorPanel_V1.1';
import { SculptMode }        from './SculptMode.js?v=IbexDS_V2.19-T1Resolve_29-7';
import { SnapshotPersist }   from './SnapshotPersist.js?v=ResetCurveOpt_V1.8';
import { SelectionMode }     from './SelectionMode.js?v=Touch2b_V1.7-T1Resolve_29-7';
import { CurveMode }         from './CurveMode.js?v=IbexDS_V1.2-P3H1_30-7';
import { CurveEditMode }     from './CurveEditMode.js?v=IbexDS_V2.5-P3H1_30-7';
import { CurveViewer }       from './CurveViewer.js?v=IbexDS_V2.8';
import { ExportPicker }      from './ExportPicker.js?v=Palette_V1.4-BurnRename_L10.1-FormatSel_L10.4-RootDir_27-7-T1Escape_29-7-P3H1_30-7';
import { ImportPicker }      from './ImportPicker.js?v=Import_V1.0-T1Escape_29-7';
import { ViewGizmo }         from './ViewGizmo.js?v=Vista34_V4.12-T1Escape_29-7';
import { PresetSidebar }     from './PresetSidebar.js?v=PresetAdmin_V1.1';

// SculptGL_S1 — bridge infrastructure (import riservato per S2+; ex test harness rimosso).
// In S2+ il bridge sarà istanziato da SculptMode e attaccato a mesh.userData.sculptgl.
import { IbexBridge }        from '../sculptgl/IbexBridge.js?v=SculptGL_S1_V1.0';

export class IbexCore {
    constructor(config) {
        console.group("🧩 IBEX CORE (DarkRedesign V1 - BITE-SAFE V13.1)");
        this.config = config;

        // 🟢 ESPOSIZIONE GLOBALE (Sempre al primo posto)
        window.ibex = this;

        // 1. Core Systems
        this.sceneMgr = new SceneManager('viewport');
        this.loader = new MeshLoader(config.projectId, config.fileToken);
        this.stateMgr = new StateManager(config.projectId);

        // 2. Logic Modules
        this.uiMgr = new UIManager();
        this.executor = new ToolExecutor(this.sceneMgr);
        this.outlinerMgr = new OutlinerManager(this.sceneMgr);
        this.stackMgr = new StackManager(this.executor, this.outlinerMgr);
        this.contextInspector = new ContextInspector(this.stackMgr);
        this.inspectorPanel = new InspectorPanel(this);
        this.sculptMgr = new SculptMode(this);
        this.snapshotPersist = new SnapshotPersist(this);  // SnapshotKeyed S2 — generalizzato
        this.selectionMode = new SelectionMode(this);      // SnapshotKeyed S2 — nodo delete_topology
        this.curveMode = new CurveMode(this);              // DrawCurve V1.0 — nodo draw_curve
        this.curveEditMode = new CurveEditMode(this);      // CurveEdit V1.0 — nodo curve_edit (editor curve esistenti)
        this.curveViewer = new CurveViewer(this);          // CurveViewer V1.0 — overlay 3D curve per arch_detect / curve_edit / draw_curve
        this.exportPicker = new ExportPicker(this);        // ExportNodeSTL — modal + POST export
        this.importPicker = new ImportPicker(this);        // S5 «File → Importa mesh» — modal + POST import_files
        this.viewGizmo = new ViewGizmo(this);              // ViewGizmo — assi top-left + saved views
        this.sceneMgr.viewGizmo = this.viewGizmo;          // hook render loop tick()
        // Preset DAG (2026-05-05) — sidebar Preset (Privati/Pubblici).
        // Init differita: refresh chiamato dopo che StackManager è caricato.
        this.presetSidebar = new PresetSidebar(this.stackMgr, this.uiMgr);

        // Drop handler unico per canvas Drawflow — gestisce mesh (dalla sidebar
        // "Scena") e tool (dalla sidebar "Strumenti"). Naming legacy conservato
        // (`dropMeshToCanvas`) per compat con `ondrop=` nel partial stack.
        window.dropMeshToCanvas = (event) => {
            event.preventDefault();
            if (!this.stackMgr) return;

            const canvasEl = document.getElementById('drawflow');
            if (!canvasEl) return;
            const editor   = this.stackMgr.editor;
            const zoom     = (editor && editor.zoom) || 1;
            // 2026-04-30: usare precanvas.getBoundingClientRect() (NON
            // container.rect + canvas_x/y). Drawflow CSS non imposta
            // `transform-origin` su `.drawflow` → default `50% 50%`. A
            // zoom != 1, la formula `(client - container.left - canvas_x)
            // / zoom` sbaglia di `(1-zoom)*container_size/2` perché assume
            // origine 0,0. Il precanvas.rect post-transform incorpora già
            // sia il translate (canvas_x/y) sia lo shift da origine al
            // centro → `(client - precanvas.rect) / zoom` è corretto a
            // ogni zoom e ogni transform-origin. Stesso pattern usato
            // internamente da Drawflow per il context-menu delete.
            const precanvas = editor && editor.precanvas;
            const rect = precanvas
                ? precanvas.getBoundingClientRect()
                : canvasEl.getBoundingClientRect();
            const px = (event.clientX - rect.left) / zoom;
            const py = (event.clientY - rect.top)  / zoom;

            const type = event.dataTransfer.getData('ibex-type');

            if (type === 'tool') {
                try {
                    const toolJson = event.dataTransfer.getData('ibex-tool-json');
                    if (!toolJson) return;
                    const tool = JSON.parse(toolJson);
                    this.stackMgr.addTool(tool, px, py);
                } catch (err) {
                    console.warn('[IBEX] drop tool parse error:', err);
                }
                return;
            }

            // Preset DAG (2026-05-05) — drop di una preset-card dalla sidebar
            // sul canvas. Spawna i nodi del preset alle coord (drop + offset
            // relativi salvati nel preset). Connessioni interne ricreate.
            if (type === 'preset') {
                const presetId = event.dataTransfer.getData('ibex-preset-id');
                const presetNs = event.dataTransfer.getData('ibex-preset-ns') || 'private';
                if (presetId) {
                    this.stackMgr.spawnPreset(presetId, presetNs, px, py);
                }
                return;
            }

            // Default / retrocompat: mesh (text/plain da OutlinerManager)
            const meshName = event.dataTransfer.getData('ibex-mesh')
                          || event.dataTransfer.getData('text/plain');
            if (meshName) {
                this.stackMgr.addMeshNode(meshName, px, py);
            }
        };

        // 3. Init
        this.init();

        console.groupEnd();
    }

    init() {
        this.stateMgr.startPolling(
            () => this.loadAssets(),
            (err) => {
                console.error("Polling fail:", err);
                this.loadAssets();
            }
        );

        // Assicura che l'area Drawflow accetti il drop nativamente
        const canvasEl = document.getElementById('drawflow');
        if (canvasEl) {
            canvasEl.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            });
        }

        // Sessione 3: modal migrazione legacy (se il worker LOAD_PROJECT ha
        // attivato legacy_warning nel manifest v2.0 per mancanza originali).
        this._showLegacyWarningIfNeeded();

        // 2026-07-14 — Autosave + guard uscita.
        // Prima di oggi il DAG viveva SOLO nella memoria del browser: `saveSession`
        // era chiamato esclusivamente da Ctrl+S (StackManager:590). Un reload, un
        // crash o una scheda chiusa = tutto il lavoro perso, senza un avviso.
        this._initAutosave();

        // Preset DAG (2026-05-05) — popola sidebar Preset (Privati/Pubblici).
        // Init differita perché refresh fa fetch HTTP non bloccante.
        try { this.presetSidebar?.init?.(); } catch (e) {
            console.warn('[IBEX] presetSidebar init failed:', e);
        }
    }

    _showLegacyWarningIfNeeded() {
        if (!this.config?.legacyWarning) return;
        const modal = document.getElementById('ibex-legacy-modal');
        if (!modal) return;

        modal.classList.remove('hidden');

        const dismiss = () => {
            modal.classList.add('hidden');
            document.removeEventListener('keydown', onKey);
        };
        const onKey = (e) => { if (e.key === 'Escape') dismiss(); };

        const btn = document.getElementById('ibex-legacy-modal-dismiss');
        if (btn) btn.addEventListener('click', dismiss, { once: true });
        document.addEventListener('keydown', onKey);
    }

    async loadAssets() {
        const overlay = document.getElementById('loading-overlay');
        const msg = document.getElementById('loading-msg');
        if(msg) msg.innerText = "Caricamento Mesh...";

        const filesToLoad = this.config.inputFiles.map(f => (typeof f === 'object' && f.path) ? f.path : f);

        const meshResults = await Promise.all(
            filesToLoad.map(file => this.loader.load(file).catch(e => {
                console.error("Load err:", e);
                return null;
            }))
        );
        let loaded = 0;
        for (const mesh of meshResults) {
            if (mesh) { this.sceneMgr.addMesh(mesh); loaded++; }
        }

        // S2 «IBEX semplice» (2026-07-10): con 0 mesh ATTESE (progetto vuoto)
        // il boot è un successo — viewport+DAG partono, outliner vuoto.
        // Il ramo errore resta per il caso vero "N attese, 0 caricate".
        // resetCamera è 0-safe (box.isEmpty → origine).
        const expectedMeshes = (this.config.inputFiles || []).length;
        if (loaded > 0 || expectedMeshes === 0) {
            console.log("✅ Assets Loaded. Initializing UI...");
            this.sceneMgr.resetCamera();

            // FastReload (2026-05-02) — ripristina `appliedMatFlat` per ogni
            // mesh dal session_settings.last_bake.applied_matrices. DEVE
            // avvenire PRIMA di stackMgr.loadFromConfig (che a fine setTimeout
            // chiama syncAndBake → applyGraph). Senza questo step, applyGraph
            // branch Tier 1 trova `appliedMatFlat=null` → cade nel branch
            // legacy → applica `worldMat` su vertici già in WS dalla preview/
            // → doppia applicazione (Bug #4 storico, ora prevenuto via FastReload).
            const lastBakeAt = this.config.sessionSettings?.last_bake;
            if (lastBakeAt?.applied_matrices) {
                let restored = 0;
                for (const mesh of this.sceneMgr.group.children) {
                    const flat = lastBakeAt.applied_matrices[mesh.name];
                    if (Array.isArray(flat) && flat.length === 16) {
                        mesh.userData.appliedMatFlat = flat.slice();
                        restored++;
                    }
                }
                if (restored > 0) {
                    console.log(`[FastReload] appliedMatFlat ripristinato per ${restored}/${this.sceneMgr.group.children.length} mesh`);
                }
            }

            if (this.config.sessionSettings) {
                // V13.0: Ripristina mesh_state persistito (pivot + bakedMat)
                if (this.config.sessionSettings.mesh_state) {
                    this.executor.importMeshState(this.config.sessionSettings.mesh_state);
                }

                if (this.config.sessionSettings.visuals) {
                    this.outlinerMgr.loadVisuals(this.config.sessionSettings.visuals);
                } else {
                    this.outlinerMgr.update();
                }
                await this.stackMgr.loadFromConfig(this.config.sessionSettings);
            } else {
                this.outlinerMgr.update();
                await this.stackMgr.loadFromConfig(null);
            }

            // SnapshotKeyed S3 (2026-04-25, S3-NA2): scan DAG post-load per
            // caricare le mesh derivate da nodi split_topology. Per ogni nodo
            // split nel grafo, prova a caricare `{stem}_snap_{nodeId}_A.stl` e
            // `_B.stl`. Se il file non esiste sul server (404) → skip silenzioso
            // (nodo non ancora eseguito dall'utente).
            await this._loadSplitDerivedMeshes();

            // CurveDisplayName V14 (2026-05-14) — Curve come oggetti di prima
            // classe: al reopen del progetto, auto-show overlay per OGNI
            // nodo che produce curve (arch_detect + draw_curve) con
            // `.crv.json` disponibile su disco. Le curve compaiono subito
            // nell'outliner senza richiedere un bake. Pattern parallelo
            // a _loadSplitDerivedMeshes.
            try { await this.refreshArchDetectMetadata(); }
            catch (e) { console.warn('[IBEX] refreshArchDetectMetadata at load:', e); }
            try { await this._loadDrawCurveOverlays(); }
            catch (e) { console.warn('[IBEX] _loadDrawCurveOverlays at load:', e); }

            if (overlay) {
                overlay.style.opacity = '0';
                setTimeout(() => overlay.remove(), 500);
            }
        } else {
            if(msg) {
                msg.innerText = "ERRORE CARICAMENTO";
                msg.style.color = "var(--ibex-error, #C4302B)";
            }
        }
    }

    /**
     * SnapshotKeyed S3 (2026-04-25) — scan DAG post-loadFromConfig per caricare
     * le mesh derivate dai nodi `split_topology` nel DAG. Per ogni nodo split:
     *   1. Risolve lo stem del master (IN_GEO_Mesh upstream via stackMgr.resolveBaseMesh)
     *   2. Tenta il load di `{stem}_snap_{nodeId}_A.stl` e `_B.stl`
     *   3. Se 404 (nodo non ancora eseguito) → skip silenzioso
     *   4. Se success → sceneMgr.addMesh(fresh) — i 2 target compaiono in scena
     *      + outliner. Triggera anche auto-hide del master (SceneManager S3).
     *
     * Coerente con la scelta S3-NA2 opt (a): error handling via try/catch,
     * nessun registro dedicato sul server.
     */
    async _loadSplitDerivedMeshes() {
        if (!this.stackMgr?.editor) return;
        const graph = this.stackMgr.extractDAG();
        if (!graph?.nodes?.length) return;

        const splitNodes = graph.nodes.filter(n => n.toolId === 'split_topology');
        if (splitNodes.length === 0) return;

        console.log(`[IBEX] _loadSplitDerivedMeshes: ${splitNodes.length} nodi split nel DAG`);

        for (const n of splitNodes) {
            // Risali l'IN_GEO_Mesh per lo stem del master.
            const inEdges = graph.edges.filter(e => String(e.to_node) === String(n.id));
            const inEdge = inEdges.find(e => e.role === 'IN_GEO_Mesh')
                        || inEdges.find(e => !e.role || e.role === 'target')
                        || inEdges[0];
            if (!inEdge) continue;
            const masterName = this.stackMgr.resolveBaseMesh(inEdge.from_mesh, inEdge.from_port);
            if (!masterName || !masterName.toLowerCase().endsWith('.stl')) continue;
            const stem = masterName.replace(/\.stl$/i, '');

            for (const branch of ['A', 'B']) {
                const snapName = `${stem}_snap_${n.id}_${branch}.stl`;
                // Se la mesh è già in scena (caricata da un reload precedente),
                // skip (non duplicarla).
                if (this.executor.findTargetMesh(snapName)) continue;
                try {
                    // bustCache: true (DrawCurve V1.0 2026-05-08) — chiamato
                    // anche post-bake modalità curva, dove la mesh può essere
                    // stata rigenerata dal worker. Garantisce fresh fetch
                    // dal serve_file (priorità preview/) anche se il browser
                    // HTTP cache ha la vecchia versione.
                    const mesh = await this.loader.load({ path: snapName, bustCache: true });
                    this.sceneMgr.addMesh(mesh);
                    console.log(`[IBEX] _loadSplitDerivedMeshes: aggiunta ${snapName}`);
                } catch (err) {
                    // 404 (nodo non ancora eseguito) o errore load → skip.
                    console.log(`[IBEX] _loadSplitDerivedMeshes: skip ${snapName} (${err.message || err})`);
                }
            }
        }

        // Dopo il load delle mesh derivate, update outliner.
        if (this.outlinerMgr) this.outlinerMgr.update();
        // Auto-hide master con split attivo (S3-NA1 via SceneManager).
        if (this.sceneMgr?.updateSplitMasterVisibility) {
            this.sceneMgr.updateSplitMasterVisibility(graph);
        }
    }

    /**
     * CurveDisplayName V14 (2026-05-14) — Auto-show overlay curve per OGNI
     * nodo `draw_curve` con `.crv.json` su disco. Pattern parallelo a
     * `refreshArchDetectMetadata` ma minimal: i metadata UI di draw_curve
     * (n_splines, n_closed) sono già aggiornati da CurveMode.exit al save;
     * qui basta ri-mostrare l'overlay 3D per renderizzare la riga
     * nell'outliner. Chiamato al loadAssets post-reopen.
     */
    async _loadDrawCurveOverlays() {
        if (!this.stackMgr?.editor || !this.config?.projectId || !this.curveViewer) return;
        const graph = this.stackMgr.extractDAG();
        if (!graph?.nodes?.length) return;

        const drawCurveNodes = graph.nodes.filter(n => n.toolId === 'draw_curve');
        if (drawCurveNodes.length === 0) return;

        for (const n of drawCurveNodes) {
            const inEdge = graph.edges.find(e =>
                String(e.to_node) === String(n.id) && e.role === 'IN_GEO_Mesh'
            );
            if (!inEdge) continue;
            const targetName = this.stackMgr.resolveBaseMesh(inEdge.from_mesh, inEdge.from_port);
            if (!targetName) continue;
            const mesh = this.sceneMgr.group.children.find(c => c.isMesh && c.name === targetName);
            if (!mesh) continue;
            const stem = String(targetName).replace(/\.stl$/i, '');
            try {
                const data = await this.curveViewer.fetchCurveFile(`${stem}_snap_${n.id}.crv.json`);
                if (Array.isArray(data?.splines) && data.splines.length > 0) {
                    this.curveViewer.showCurve(n.id, data.splines, {
                        color: 0x2A6FDB, withCP: true, mesh
                    });
                }
            } catch (err) { /* 404 = nodo non ancora disegnato, skip */ }
        }
    }

    /**
     * Auto-fetch metadata dei nodi arch_detect post-bake.
     * Hook in BakeEngine success — scansiona il DAG, per ogni nodo arch_detect
     * fetcha il `.crv.json` corrispondente, popola `node.data.meta` con i
     * metadata (n_ctrl_points, arch_length_mm, pca_ratios, ...), refresh
     * label DAG + inspector se aperto sul nodo.
     *
     * Se `nodeId` è specificato, fetcha solo quel nodo (chiamato da
     * inspector "Aggiorna info"). Altrimenti scansiona tutti.
     *
     * Pattern parallelo a `_loadSplitDerivedMeshes`: best-effort, errore
     * 404 → skip silenzioso (nodo non ancora eseguito).
     */
    async refreshArchDetectMetadata(nodeId = null) {
        if (!this.stackMgr?.editor || !this.config?.projectId) return;
        const graph = this.stackMgr.extractDAG();
        if (!graph?.nodes?.length) return;

        const archNodes = graph.nodes.filter(n =>
            n.toolId === 'arch_detect' &&
            (nodeId == null || String(n.id) === String(nodeId))
        );
        if (archNodes.length === 0) return;

        for (const n of archNodes) {
            // Risolve stem del master mesh (IN_GEO_Mesh upstream)
            const inEdge = graph.edges.find(e =>
                String(e.to_node) === String(n.id) && e.role === 'IN_GEO_Mesh'
            );
            if (!inEdge) continue;
            const targetName = this.stackMgr.resolveBaseMesh(inEdge.from_mesh, inEdge.from_port);
            if (!targetName) continue;
            const stem = String(targetName).replace(/\.stl$/i, '');
            const crvFileName = `${stem}_snap_${n.id}.crv.json`;

            try {
                const url = `/?action=serve_file&project_id=${this.config.projectId}` +
                            `&file=${encodeURIComponent(crvFileName)}&t=${Date.now()}`;
                const resp = await fetch(url, { credentials: 'include' });
                if (!resp.ok) continue; // 404 = nodo non ancora eseguito
                const data = await resp.json();
                const md = data?.metadata || {};
                const splines = Array.isArray(data?.splines) ? data.splines : [];
                const totalCp = splines.reduce(
                    (a, s) => a + (Array.isArray(s.control_points) ? s.control_points.length : 0), 0);
                const nClosed = splines.filter(s => s.cyclic).length;

                // Aggiorna meta del nodo via updateSculptNodeMeta (refresha
                // label DAG automaticamente)
                this.stackMgr.updateSculptNodeMeta?.(String(n.id), {
                    sculpted:        true,
                    mesh_name:       targetName,
                    n_splines:       splines.length,
                    n_closed:        nClosed,
                    n_ctrl_points:   totalCp || (md.n_ctrl_points || 0),
                    arch_length_mm:  md.arch_length_mm || 0,
                    n_verts_input:   md.n_verts_input || 0,
                    n_verts_selected: md.n_verts_selected || 0,
                    n_verts_used_for_skeleton: md.n_verts_used_for_skeleton || 0,
                    curv_threshold:  md.curv_p70 || 0,
                    curv_clipped_outliers:   md.curv_clipped_outliers || 0,
                    curv_clipped_nonfinite:  md.curv_clipped_nonfinite || 0,
                    pca_eigenvalues: Array.isArray(md.pca_eigenvalues) ? md.pca_eigenvalues : null,
                    pca_ratio12:     Array.isArray(md.pca_ratios) ? md.pca_ratios[0] : null,
                    pca_ratio23:     Array.isArray(md.pca_ratios) ? md.pca_ratios[1] : null,
                    scalars_cache_hit: !!md.scalars_cache_hit,
                    // V1.8 (2026-05-12) — template fit + Z-offset metadata
                    template_used:      md.template_used || null,
                    template_requested: md.template_requested || null,
                    template_residual:  md.template_residual != null ? Number(md.template_residual) : null,
                    template_scales:    Array.isArray(md.template_scales) ? md.template_scales : null,
                    z_offset_mm:        md.z_offset_mm != null ? Number(md.z_offset_mm) : null,
                    elevation_sign:     md.elevation_sign != null ? Number(md.elevation_sign) : null,
                    last_modified:   Math.floor(Date.now() / 1000)
                });
                console.log(`[IBEX] refreshArchDetectMetadata: ${crvFileName} → ` +
                            `${totalCp} CP, ${(md.arch_length_mm||0).toFixed(1)}mm`);
            } catch (err) {
                console.log(`[IBEX] refreshArchDetectMetadata: skip ${crvFileName} (${err.message || err})`);
            }
        }

        // CurveDisplayName V14 (2026-05-14) — Le curve sono oggetti di prima
        // classe nell'outliner. Auto-show overlay per OGNI arch_detect node
        // con .crv.json disponibile su disco (non più condizionato a
        // `isVisible(n.id)`). L'utente può sempre nascondere la singola curva
        // dal toggle eye nella riga outliner, ma il default è "visibile".
        if (this.curveViewer) {
            for (const n of archNodes) {
                const inEdge = graph.edges.find(e =>
                    String(e.to_node) === String(n.id) && e.role === 'IN_GEO_Mesh'
                );
                if (!inEdge) continue;
                const targetName = this.stackMgr.resolveBaseMesh(inEdge.from_mesh, inEdge.from_port);
                if (!targetName) continue;
                const mesh = this.sceneMgr.group.children.find(c => c.isMesh && c.name === targetName);
                if (!mesh) continue;
                const stem = String(targetName).replace(/\.stl$/i, '');
                try {
                    const data = await this.curveViewer.fetchCurveFile(`${stem}_snap_${n.id}.crv.json`);
                    if (Array.isArray(data?.splines) && data.splines.length > 0) {
                        this.curveViewer.showCurve(n.id, data.splines, {
                            color: 0x2A6FDB, withCP: true, mesh
                        });
                    }
                } catch (err) { /* 404 = nodo non ancora eseguito, skip */ }
            }
        }
        // V13.0 (2026-05-13) — curve come oggetti di prima classe.
        // Refresha l'outliner perché possa renderizzare le curve come righe.
        // showCurve già chiama outlinerMgr.update internamente; questa è una
        // safety net se sono stati aggiornati metadata senza re-show.
        this.outlinerMgr?.update?.();
    }

    // Raccoglie lo stato completo di sessione (DAG + visuals + mesh_state +
    // last_bake + saved_views). Sorgente UNICA per saveAndExit (save_exit) e
    // saveSession (save senza uscire) → nessuna divergenza di payload.
    // ════════════════════════════════════════════════════════════════════
    // AUTOSAVE + GUARD USCITA (2026-07-14)
    //
    // Il "sono sporco?" NON è una lista di hook sulle mutazioni (aggiungi nodo,
    // collega, rinomina, muta, sposta slider…): quella lista si dimentica sempre
    // un caso, e il caso dimenticato è esattamente il lavoro che l'utente perde.
    // Usiamo invece l'IMPRONTA del payload che verrebbe salvato — `_collectSessionData()`
    // È già la fonte di verità di ciò che finisce su disco. Se la sua serializzazione
    // differisce dall'ultima salvata, c'è lavoro non salvato. Funziona anche per le
    // mutazioni che verranno aggiunte in futuro, senza toccare questo codice.
    // ════════════════════════════════════════════════════════════════════

    _sessionFingerprint() {
        try {
            return JSON.stringify(this._collectSessionData());
        } catch (e) {
            // Se non riusciamo a serializzare, meglio NON dichiarare "sporco":
            // un falso positivo qui significa un prompt di uscita a ogni reload.
            console.warn('[IBEX][autosave] fingerprint fallita:', e);
            return null;
        }
    }

    /** true se ci sono modifiche non ancora scritte su disco. */
    isDirty() {
        // Baseline non ancora acquisita (boot in corso) → mai "sporco":
        // un falso positivo bloccherebbe l'utente con un prompt inutile.
        if (this._savedFingerprint == null) return false;
        const fp = this._sessionFingerprint();
        if (fp == null) return false;
        return fp !== this._savedFingerprint;
    }

    /** Segna lo stato corrente come "salvato" (chiamato dopo ogni save riuscito). */
    _markSaved(fp) {
        this._savedFingerprint = (fp != null) ? fp : this._sessionFingerprint();
    }

    _initAutosave() {
        this._savedFingerprint  = null;   // null = baseline non ancora acquisita
        this._autosaveTimer     = null;
        this.AUTOSAVE_PERIOD_MS = 15000;

        // Baseline: aspetta che StackManager.loadFromConfig abbia importato il grafo
        // (import + setTimeout 200ms + primo syncAndBake). 2s è abbondante.
        setTimeout(() => {
            this._markSaved();
            console.log('[IBEX][autosave] baseline acquisita, autosave attivo');
        }, 2000);

        this._autosaveTimer = setInterval(() => this._autosaveTick(), this.AUTOSAVE_PERIOD_MS);

        // ── PRESENZA (heartbeat, 2026-07-22): scrive ibex:presence:{pid} su ibex-redis
        //    ogni ~30s finche' l'editor e' vivo (TTL 90s server). keepalive → il POST
        //    sopravvive al teardown. Il janitor NON la consuma ancora (predisposizione).
        const _beat = () => { try { fetch('/?action=heartbeat', { method:'POST', keepalive:true, headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'id='+encodeURIComponent(this.config.projectId) }).catch(()=>{}); } catch(e){} };
        _beat();
        this._heartbeatTimer = setInterval(_beat, 30000);
        const _stopBeat = () => { if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; } };
        window.addEventListener('pagehide', _stopBeat);
        window.addEventListener('beforeunload', _stopBeat);

        // Guard uscita: il browser mostra il suo dialog nativo ("modifiche non
        // salvate"). Non possiamo personalizzarne il testo (lo vietano i browser
        // da anni), ma possiamo impedire la chiusura silenziosa.
        window.addEventListener('beforeunload', (e) => {
            if (this._navigatingAway) return;   // salva&esci / bake&esci: già salvato
            if (!this.isDirty()) return;
            e.preventDefault();
            e.returnValue = '';   // richiesto da Chrome per attivare il dialog
            return '';
        });
    }

    async _autosaveTick() {
        if (this._savedFingerprint == null) return;   // baseline non pronta
        if (this._saveSessionInFlight) return;         // save già in volo

        // NON salvare a bake in corso: `last_bake` (matrici applicate) viene
        // aggiornato DENTRO il bake, dopo l'hot-swap. Fotografarlo a metà
        // scriverebbe nel manifest uno stato incoerente con `preview/` — ed è
        // proprio quella coerenza che regge il FastReload (Inv. 42).
        if (this.stackMgr?.bakeEngine?._bakeLock) return;

        const fp = this._sessionFingerprint();
        if (fp == null || fp === this._savedFingerprint) return;   // niente da salvare

        try {
            await this.saveSession({ silent: true, fingerprint: fp });
        } catch (e) {
            // Fallito: NON aggiorniamo la baseline → resta "sporco" → riproverà
            // al prossimo giro, e il guard di uscita continua a proteggere.
            console.warn('[IBEX][autosave] fallito, riprovo tra poco:', e);
        }
    }

    _collectSessionData() {
        const flatQueue = this.stackMgr.getQueueForBackend();
        const uiGraph   = this.stackMgr.getUIGraph();
        const meshState          = this.executor.exportMeshState();
        const toolExecutionOrder = flatQueue.map(q => q._nodeId);
        // SnapshotKeyed S1: nodi destructive attivi → lazy cleanup worker.
        const snapshotNodes      = this.stackMgr?.getSnapshotNodes?.() || [];
        // FastReload: appliedMatFlat per-mesh + snapshot BakeEngine.
        const appliedMatrices = {};
        const sceneMeshes = this.sceneMgr?.group?.children || [];
        for (const m of sceneMeshes) {
            const flat = m?.userData?.appliedMatFlat;
            if (Array.isArray(flat) && flat.length === 16) {
                appliedMatrices[m.name] = Array.from(flat);
            }
        }
        const bakeSnapshot = this.stackMgr?.bakeEngine?.getLastBakeSnapshot?.()
                         || { params: {}, node_ids: [], targets: [] };
        const savedViews = this.viewGizmo?.getSavedViewsForPersist?.() || [];
        return {
            stack:                flatQueue,
            ui_graph:             uiGraph,
            visuals:              this.outlinerMgr.gatherVisuals(),
            mesh_state:           meshState,
            tool_execution_order: toolExecutionOrder,
            snapshot_nodes:       snapshotNodes,
            saved_views:          savedViews,
            last_bake: {
                params:           bakeSnapshot.params,
                node_ids:         bakeSnapshot.node_ids,
                targets:          bakeSnapshot.targets,
                applied_matrices: appliedMatrices,
            },
        };
    }

    // S6 (Q4, 2026-07-10) — uscita embed-aware post-salvataggio:
    //   · embed (scheda shell NC): postMessage 'ibex-close-tab' al parent con
    //     TARGET ORIGIN esplicito (solo la shell NC può riceverlo); la shell
    //     risolve la scheda via e.source e la chiude. Il campo `redirect`
    //     del PHP viene ignorato (navigherebbe l'iframe sulla vecchia dashboard).
    //   · standalone: → lobby NC (ibex_workspace).
    _exitAfterSave() {
        // Uscita VOLUTA (salva&esci / bake&esci): il lavoro è appena stato scritto
        // dal POST che ci ha portati qui. Senza questo flag il guard `beforeunload`
        // sparerebbe il popup "modifiche non salvate" proprio a chi ha appena salvato
        // — l'app litigherebbe con sé stessa.
        this._navigatingAway = true;

        const cfg = window.IBEX_CONFIG || {};
        if (cfg.nextcloudOrigin && document.documentElement.getAttribute('data-embed') === '1'
            && window.parent && window.parent !== window) {
            try {
                window.parent.postMessage({ type: 'ibex-close-tab' },
                    cfg.nextcloudOrigin);
                return;
            } catch (e) { /* fallback sotto */ }
        }
        if (cfg.lobbyUrl) window.location.href = cfg.lobbyUrl;
    }

    async saveAndExit() {
        if (window.ibex && window.ibex.uiMgr) {
            window.ibex.uiMgr.notify("Salvataggio in corso...", "info");
        }
        const sessionData = this._collectSessionData();
        const fd = new FormData();
        fd.append('id',           this.config.projectId);
        fd.append('session_data', JSON.stringify(sessionData));
        // IBX2 (2026-07-21): SCREENSHOT del canvas editor (matcap) → allegato al save;
        // il worker lo incastona nel segmento thumb dell'IBX2. Best-effort.
        try { const _tb = await this.sceneMgr.captureThumbnail(); if (_tb) fd.append('thumbnail', _tb, 'thumb.png'); } catch (_e) {}

        try {
            const resp = await fetch('/?action=save_exit', { method: 'POST', body: fd });
            const data = await resp.json();
            if (data.success) {
                this._exitAfterSave();
            } else {
                alert("Errore Server: " + (data.error || "Unknown"));
            }
        } catch (e) {
            alert("Errore connessione: " + e.message);
        }
    }

    // UX-A — Salva senza uscire: POSTa lo stesso payload di saveAndExit a
    // `save_session` (che ora scrive il manifest, SoT). Nessun redirect; toast.
    // opts.silent      → nessun toast "Salvato" (usato dall'autosave)
    // opts.fingerprint → impronta già calcolata dal chiamante (evita di riserializzare)
    async saveSession(opts = {}) {
        if (this._saveSessionInFlight) return;
        this._saveSessionInFlight = true;
        const silent = !!opts.silent;
        const sessionData = this._collectSessionData();
        // L'impronta va presa dallo STESSO payload che stiamo per inviare, non
        // ricalcolata dopo: se l'utente modifica qualcosa mentre il POST è in volo,
        // ri-fotografare a posteriori marcherebbe come "salvata" una modifica che
        // il server non ha mai visto → lavoro perso in silenzio.
        const fp = (opts.fingerprint != null) ? opts.fingerprint : (() => {
            try { return JSON.stringify(sessionData); } catch (e) { return null; }
        })();
        const fd = new FormData();
        fd.append('id',           this.config.projectId);
        fd.append('session_data', JSON.stringify(sessionData));
        try {
            const resp = await fetch('/?action=save_session', { method: 'POST', body: fd });
            const data = await resp.json();
            if (data && data.success) {
                this._markSaved(fp);            // ← baseline aggiornata SOLO su successo
                if (silent) console.log('[IBEX][autosave] sessione salvata');
                else window.ibex?.uiMgr?.notify?.('Salvato', 'info');
            } else {
                // NON aggiorniamo la baseline → resta "sporco" → il guard di uscita
                // continua a proteggere e l'autosave riprova.
                if (!silent) window.ibex?.uiMgr?.notify?.('Salvataggio fallito', 'error');
                else console.warn('[IBEX][autosave] il server ha rifiutato il salvataggio');
            }
        } catch (e) {
            if (!silent) window.ibex?.uiMgr?.notify?.('Salvataggio fallito: ' + e.message, 'error');
            else console.warn('[IBEX][autosave] errore di rete:', e.message);
        } finally {
            this._saveSessionInFlight = false;
        }
    }

    async bakeAndExit() {
        const flatQueue = this.stackMgr.getQueueForBackend();
        const uiGraph = this.stackMgr.getUIGraph();

        if (flatQueue.length === 0) return alert("Stack vuoto. Applica almeno uno strumento prima del Bake.");

        if(window.ibex && window.ibex.uiMgr) window.ibex.uiMgr.notify("Salvataggio in corso...", "info");

        // V13.0: Salva mesh_state (pivot + bakedMat) e ordine esecuzione
        const meshState = this.executor.exportMeshState();
        const toolExecutionOrder = flatQueue.map(q => q._nodeId);

        const sessionData = {
            stack: flatQueue,
            ui_graph: uiGraph,
            visuals: this.outlinerMgr.gatherVisuals(),
            mesh_state: meshState,
            tool_execution_order: toolExecutionOrder
        };

        const fd = new FormData();
        fd.append('id', this.config.projectId);
        fd.append('session_data', JSON.stringify(sessionData));
        // IBX2 (2026-07-21): screenshot del canvas editor → il worker lo incastona nell'IBX2 baked.
        try { const _tb = await this.sceneMgr.captureThumbnail(); if (_tb) fd.append('thumbnail', _tb, 'thumb.png'); } catch (_e) {}

        try {
            const resp = await fetch('/?action=bake_project', { method: 'POST', body: fd });
            const data = await resp.json();
            if (data.success) {
                this._exitAfterSave();  // S6 (Q4): embed-aware, come saveAndExit
            } else {
                alert("Errore Server: " + (data.error || "Unknown"));
            }
        } catch (e) { alert("Errore connessione: " + e.message); }
    }
}
