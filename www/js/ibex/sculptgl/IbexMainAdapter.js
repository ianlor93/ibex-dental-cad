// ═══════════════════════════════════════════════════════════════
// IBEX sculptgl/IbexMainAdapter.js — SculptGL_S2_V1.0
//
// Adapter per il pattern `_main` di SculptGL. SculptBase + brush accedono
// al "main application" via `this._main.xxx()` — questo adapter espone
// quell'interfaccia mappata su IBEX (SceneManager, BakeEngine, ecc.).
//
// API esposta (tutte le chiamate effettive dai moduli portati):
//   getMesh()              → MeshDynamic attiva (da IbexBridge)
//   getMeshes()            → [MeshDynamic] (per intersectionMouseMeshes)
//   getThreeMesh()         → THREE.Mesh (per raycast Picking)
//   getThreeCamera()       → THREE.Camera IBEX
//   getCanvas()            → renderer.domElement IBEX (per pixel→NDC)
//   getPicking()           → Picking istanza
//   getPickingSymmetry()   → null (no symmetry)
//   getSculptManager()     → { getSymmetry:()=>false, getCurrentTool:()=>brush }
//   getStateManager()      → StateManager stub (no-op, A9)
//   setOrUnsetMesh(m,c)    → identity pass-through (una sola mesh sculpt attiva)
//   setCanvasCursor(c)     → no-op (cursor gestito da SculptMode)
//   getPixelRatio()        → renderer.getPixelRatio()
//   render()               → sceneMgr.render()
//
// Mouse state: `_mouseX/_mouseY` in canvas-local pixels, aggiornati da
// SculptMode._onMouseDown/Move prima di ogni chiamata a start/update.
// `_action = 1` (SCULPT_EDIT) per compatibilità con SculptBase.preUpdate
// (anche se preUpdate è stato rimosso, lascio il campo per robustezza).
// ═══════════════════════════════════════════════════════════════

import { StateManager } from './stubs.js';

export class IbexMainAdapter {
    constructor(ibex, bridge) {
        this._ibex   = ibex;
        this._bridge = bridge;

        this._currentBrush   = null;     // SculptBase subclass — setato da SculptMode
        this._pickingInstance = null;    // Picking — setato da SculptMode

        this._mouseX = 0;
        this._mouseY = 0;
        this._action = 1;                // SCULPT_EDIT

        this._stateManagerStub = new StateManager();
    }

    // ─── Mesh accessors ──────────────────────────────────────────
    getMesh()       { return this._bridge.getMeshDynamic(); }
    getMeshes()     { const m = this.getMesh(); return m ? [m] : []; }
    getThreeMesh()  { return this._bridge.getThreeMesh(); }

    // ─── Scene accessors (Three.js side) ─────────────────────────
    getThreeCamera() { return this._ibex.sceneMgr.camera; }
    getCanvas()      { return this._ibex.sceneMgr.renderer.domElement; }
    /**
     * SculptGL originale usa `_radius` in pixel screen; `sculptStroke` calcola
     *   `minSpacing = 0.15 * this._radius * main.getPixelRatio()`
     * che con _radius in px e devicePixelRatio=2 → ~15 px di spacing, matchato
     * con `dist` (pixel).
     *
     * IBEX ha `_radius` in MM LOCAL (A2). Per produrre `minSpacing` in pixel
     * che matcha `dist` (pixel), quindi: converti mm→px con un fattore di
     * scala approssimativo del viewport. Empirico: con camera IBEX a ~300mm
     * di distanza dalla mesh 60mm (default post-resetCamera), la scala è
     * 15-30 px/mm. Usiamo 30 px/mm × devicePixelRatio come compromesso:
     *   r=2mm  → minSpacing = 0.15 * 2 * 30 ≈ 9 px   (drag fluido)
     *   r=15mm → minSpacing = 0.15 * 15 * 30 ≈ 67 px (~10 sample/600px)
     *
     * Questo è un workaround empirico dell'unit mismatch mm-vs-pixel di
     * SculptBase.sculptStroke. Una soluzione "corretta" richiederebbe la
     * proiezione inversa del raggio brush (radius_mm → radius_pixels via
     * camera.project), ma richiederebbe chiamare project per-mousemove
     * (overhead) e non è necessaria per l'uso clinico di IBEX.
     */
    getPixelRatio()  {
        const r = this._ibex.sceneMgr?.renderer;
        const devRatio = (r && r.getPixelRatio) ? r.getPixelRatio() : 1;
        return 30 * devRatio;
    }

    /**
     * Chiamato da SculptBase.updateRender alla fine di ogni sculptStroke,
     * e direttamente da SculptMode._onMouseDown/_onMouseMove.
     *
     * Flow:
     *   1. Read prevCount (pre-sync)
     *   2. bridge.syncToThree()           — copia MeshDynamic → BufferGeometry
     *   3. Read curCount (post-sync)
     *   4a. S2 (no dyntopo) count invariato → geom.boundsTree.refit() O(log n)
     *   4b. S3 (dyntopo) count cambiato    → geom.computeBoundsTree() O(N log N)
     *       + invalida userData.vertNeighbors* (cache Laplacian legacy V5.17,
     *         difensivo per moduli esterni che leggono la mesh post-exit)
     *   5. sceneMgr.render()              — EffectComposer renderer loop
     *
     * Costi:
     *   - sync ~0.5ms (100k verts)
     *   - refit ~2-5ms
     *   - rebuild ~50-200ms (100k verts) — scatta solo su sample con dyntopo
     *     che produce split/collapse
     *   - render ~15-20ms
     *
     * Dyntopo rebuild è il costo maggiore. Per brush r=2mm + subFactor=0.75,
     * solo i sample dove la topology locale viene modificata pagano il
     * rebuild (tipicamente N < M/10 samples con M = mousemove events).
     */
    render() {
        const threeMesh = this._bridge?.getThreeMesh?.();
        const geom      = threeMesh?.geometry;
        const prevCount = geom?.attributes?.position?.count ?? 0;

        if (this._bridge) this._bridge.syncToThree();

        if (geom) {
            const curCount = geom.attributes?.position?.count ?? 0;
            const topologyChanged = (curCount !== prevCount);

            if (topologyChanged) {
                // S3 dyntopo: rebuild full del BVH (refit non può gestire count change)
                if (typeof geom.computeBoundsTree === 'function') {
                    geom.computeBoundsTree();
                }
                // Invalida cache adjacency (difensivo — nessun modulo IBEX le
                // legge durante sculpt attivo, ma lascio per coerenza con V5.17)
                if (threeMesh.userData) {
                    threeMesh.userData.vertNeighbors     = null;
                    threeMesh.userData.vertNeighborsN    = -1;
                    threeMesh.userData.vertNeighborsGeom = null;
                }
            } else if (geom.boundsTree && typeof geom.boundsTree.refit === 'function') {
                // S2 path: refit incrementale O(log n)
                geom.boundsTree.refit();
            }
        }

        this._ibex.sceneMgr?.render?.();
    }

    // ─── SculptGL plugin stubs ────────────────────────────────────
    getPicking()          { return this._pickingInstance; }
    getPickingSymmetry()  { return null; }

    getSculptManager() {
        // Lazy singleton per evitare nuova allocazione ad ogni chiamata.
        if (!this._sculptMgrStub) {
            const self = this;
            this._sculptMgrStub = {
                getSymmetry:    () => false,
                getCurrentTool: () => self._currentBrush
            };
        }
        return this._sculptMgrStub;
    }

    getStateManager() { return this._stateManagerStub; }

    /**
     * SculptBase.start() chiama `main.setOrUnsetMesh(picking.getMesh(), ctrl)`
     * per confermare/rigettare la mesh target. Nel nostro flow c'è una sola
     * mesh attiva (quella in sculpt) — ritorna sempre quella.
     */
    setOrUnsetMesh(mesh, _ctrl) { return mesh || this.getMesh(); }

    /** Aggiorna il cursor CSS del canvas. No-op: SculptMode gestisce il cursor
     *  custom (ring 3D) e non cambia il cursor CSS. */
    setCanvasCursor(_cursor) {}
}

export default IbexMainAdapter;
