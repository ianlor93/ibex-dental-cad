import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

// ═══════════════════════════════════════════════════════════════
// IBEX CurveEditMode CurveEdit_V1.0 (2026-05-12)
//
// Editor full-feature di curve `.crv.json` provenienti da arch_detect /
// draw_curve / altri produttori CRV upstream. Pattern parallelo a CurveMode
// (draw_curve) ma carica la curva esistente invece di disegnarla da zero.
//
// Operazioni supportate (V1.0):
//   - Click sinistro su CP (sphere) + drag → riposiziona CP con snap to
//     surface (raycast su mesh upstream durante move)
//   - Click sinistro su segmento spline (zone interpolata) → INSERT nuovo
//     CP nel mezzo del segmento più vicino
//   - SHIFT+click sinistro su CP → REMOVE CP
//   - Bottoni inspector: cambia spline attiva, add nuova spline, delete
//     spline attiva, toggle cyclic
//
// Schema `.crv.json` (compatibile con draw_curve / arch_detect):
//   {
//     "splines": [{ "control_points": [[x,y,z], ...], "cyclic": bool }, ...]
//   }
//
// Coordinate: control_points sono in LOCAL space della targetMesh.
// Persistiti come tali → resilient a Tier 1 trasformazioni upstream.
//
// Flow utente:
//   1. Click "Modifica Curva" nel nodo curve_edit → enter(nodeId)
//   2. Fetch `_snap_{nodeId}.crv.json` da server (worker garantisce che
//      esista — al primo bake il worker copia upstream curve in questo file)
//   3. Render splines + control points come overlay 3D
//   4. Edita: drag CP, click su spline (insert), shift+click (remove)
//   5. "Conferma" → save snapshot + force bake + exit
//   6. "Annulla" → exit senza save
// ═══════════════════════════════════════════════════════════════

const _SPLINE_COLORS = [
    0x2A6FDB, // blu (default)
    0xec4899, // rosa
    0x14b8a6, // teal
    0xf59e0b, // ambra
    0x3b82f6, // blu
];
const _CTRL_POINT_RADIUS_MM = 0.20;
const _CTRL_POINT_RADIUS_MM_HOVER = 0.28;
const _CTRL_POINT_COLOR = 0x2A6FDB;
const _CTRL_POINT_COLOR_HOVER = 0xFFCC44;   // ambra hover
const _CTRL_POINT_COLOR_DRAG = 0xFF6037;    // accent IBEX durante drag
const _CTRL_POINT_COLOR_SELECTED = 0xFF6037; // accent IBEX permanente per CP selezionati (Fase 1 tap-based)
const _LINE_WIDTH_PX = 4;
const _DRAG_THRESHOLD_PX = 4;

// Fase 2 — Handles Bezier (vector / aligned)
// Init tangent: handle_right = CP + (CP_next - CP_prev) / _HANDLE_INIT_DIVISOR.
//   _HANDLE_INIT_DIVISOR=6 → Catmull-Rom→Bezier classic (handle corti, smooth blando)
//   _HANDLE_INIT_DIVISOR=3 → handle 2× più lunghi, bulge molto più visibile
//                            (preferito per UX: l'effetto del promote è percepibile
//                             a colpo d'occhio anche su pochi CP promossi)
const _HANDLE_INIT_DIVISOR = 3;
const _HANDLE_RADIUS_MM = 0.32;             // raddoppiato vs V2.1 (era 0.16) per visibilità
const _HANDLE_COLOR = 0x60a5fa;             // blu chiaro (distinto da CP blu/arancio)
const _HANDLE_COLOR_DRAG = 0xFF6037;        // accent IBEX durante drag handle
const _HANDLE_LINE_COLOR = 0x60a5fa;        // linea tratteggiata CP↔handle
const _HANDLE_LINE_WIDTH_PX = 3.0;          // bumped vs V2.1 (era 2.0)
const _HANDLE_DASH_MM = 1.2;                // pattern tratteggio CP↔handle (in mm world)
const _HANDLE_GAP_MM  = 0.6;
const _BEZIER_SAMPLES_PER_SEG = 24;         // densità rendering curva Bezier (visuale)

// Fase 3 (V2.4 ProportionalEdit) — Blender O-mode style proportional editing
//   - distanza along-curve (arc-length lungo la spline) — preserva topologia 1D
//   - selezione ortogonale: CP selezionati = factor 1.0 (override), altri = falloff(d/R)
//   - solo falloff 'smooth' (Hermite C¹) in V1
//   - scroll wheel durante drag = modifica R live (pattern Blender)
const _PROP_RING_COLOR = 0xFF6037;          // arancione IBEX accent per ring overlay
const _PROP_RING_OPACITY = 0.35;
const _PROP_RING_SEGMENTS = 64;
const _PROP_RADIUS_DEFAULT = 5.0;           // mm — scala dentale tipica
const _PROP_RADIUS_MIN = 0.3;
const _PROP_RADIUS_MAX = 80.0;
const _PROP_WHEEL_FACTOR = 1.12;            // scroll-up moltiplica R per questo (×1.12 = +12%)

/** Falloff Hermite C¹ — Blender 'smooth' default. t ∈ [0,1], result ∈ [0,1]. */
function _propFalloffSmooth(t) {
    if (t <= 0) return 1.0;
    if (t >= 1) return 0.0;
    return 2 * t * t * t - 3 * t * t + 1;
}

export class CurveEditMode {
    constructor(ibex) {
        this.ibex = ibex;
        this.active = false;
        this.targetNodeId = null;
        this.targetMesh = null;

        // Datablock: stessa struttura di CurveMode
        this.splines = [];          // [{ controlPoints: [Vector3], cyclic: bool }]
        this.activeSplineIdx = -1;

        // Three.js helpers
        this._overlayGroup = null;
        this._splineLines = [];
        this._ctrlPointMeshes = [];   // [{ mesh, splineIdx, cpIdx }]
        this._raycaster = new THREE.Raycaster();
        this._raycaster.firstHitOnly = true;
        this._mouseNDC = new THREE.Vector2();

        // Drag / interaction state (V2.0 tap-based tablet-first)
        // _dragMode: null | 'cp' | 'pending_tap_void_on_mesh' | 'pending_tap_off_mesh'
        //   'cp'                       = dragging un CP (singolo o gruppo selezionato)
        //   'pending_tap_void_on_mesh' = mousedown su mesh in area vuota (no CP/segmento);
        //                                se l'utente non drag-a oltre soglia, in mouseup
        //                                la logica = "tap su void mesh" = deseleziona tutti.
        //                                Se invece drag-a oltre soglia → modal-pass-through
        //                                a OrbitControls (sceneMgr ruota la camera).
        //   'pending_tap_off_mesh'     = mousedown fuori mesh (raycast fallito) — usato
        //                                solo per skip totale logica curve_edit.
        this._dragMode = null;
        this._dragCpRef = null;            // { splineIdx, cpIdx } — CP che ha iniziato il drag
        this._dragInitialPositions = null; // Map<"s:c", Vector3> — pos LOCAL iniziali dei CP selezionati
        this._dragAnchorWorld = null;      // Vector3 — punto world iniziale (delta calc reference)
        this._dragStartClient = { x: 0, y: 0 };
        this._mousedownClient = { x: 0, y: 0 };
        this._dragHoveredMesh = null;      // sphere mesh attualmente in drag (visuale)
        this._hoveredMesh = null;          // sphere mesh sotto cursore (no drag)

        // V2.0 multi-selezione tap-based: ogni CP è identificato da string "splineIdx:cpIdx"
        // — Set è il backing store, _renderSplines applica colore _CTRL_POINT_COLOR_SELECTED
        //   ai CP la cui key è in selectedCps.
        this.selectedCps = new Set();

        // Fase 2 — Handle Bezier rendering meshes (ricostruite ad ogni _renderSplines):
        //   _handlePointMeshes[i] = { mesh, splineIdx, cpIdx, side: 'left'|'right' }
        //   _handleLineSegments  = THREE.Line objects (le linee tratteggiate CP↔handle)
        this._handlePointMeshes = [];
        this._handleLineSegments = [];

        // Fase 2 — Drag handle state. Quando l'utente fa drag su un handle sphere:
        //   _dragMode = 'handle'
        //   _dragHandleRef = { splineIdx, cpIdx, side }
        // Movimento single-axis (non massa): handle drag muove solo quel handle.
        // Se tipo CP === 'aligned', l'handle opposto viene mirrorato attorno al CP.
        this._dragHandleRef = null;

        // Fase 3 (V2.4) — Proportional editing (Blender O-mode)
        //   proportionalEdit       = true: drag CP influenza i CP vicini via falloff
        //   proportionalRadius     = R in mm (along-curve distance)
        //   _proportionalDistances = Map<key, d> popolato al drag start per ogni CP
        //                            della spline-anchor (CP di altre splines = Infinity)
        //   _proportionalRingMesh  = overlay cerchio nel viewport durante drag attivo
        this.proportionalEdit = false;
        this.proportionalRadius = _PROP_RADIUS_DEFAULT;
        this._proportionalDistances = null;
        this._proportionalRingMesh = null;
        this._onWheel = this._onWheel.bind(this);

        // V2.0 snap-to-surface toggle (default OFF per Fase 1, scelta utente).
        // OFF → drag CP usa _viewPlane (piano perpendicolare alla camera passante per
        //       la posizione CORRENTE del CP all'inizio del drag).
        // ON  → drag CP usa raycast sulla targetMesh (comportamento V1.0).
        this.snapToSurface = false;

        // Scratch view plane per drag senza snap. Re-inizializzato all'inizio di ogni drag.
        this._viewPlane = new THREE.Plane();
        this._tmpVec3 = new THREE.Vector3();
        this._tmpVec3b = new THREE.Vector3();

        // V2.0 — Pointer events (NON mousedown/mousemove/mouseup) per intercettare
        // PRIMA di Three.js OrbitControls che usa pointerdown internamente.
        // Registrazione in CAPTURE phase ({capture:true}) → handler arriva prima
        // dei listener OrbitControls (registrati in bubble phase). Quando vogliamo
        // fermare OrbitControls (drag CP, insert) chiamiamo stopPropagation.
        // Quando vogliamo passare a OrbitControls (orbit camera su area vuota)
        // NON chiamiamo stopPropagation → evento bubbling raggiunge OrbitControls.
        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerUp   = this._onPointerUp.bind(this);
        // PointerId del drag corrente (per setPointerCapture → mousemove robust)
        this._capturedPointerId = null;

        this._modifiedSession = false;
    }

    // ─────────────────────────────────────────────────────────────
    // enter — inizio modalità edit
    // ─────────────────────────────────────────────────────────────
    async enter(nodeId) {
        if (this.active) this.exit({ save: false });
        if (!this.ibex.sceneMgr || !this.ibex.stackMgr) return;

        const stackMgr = this.ibex.stackMgr;
        const editor = stackMgr.editor;
        if (!editor) return;
        const node = editor.getNodeFromId(parseInt(nodeId, 10));
        if (!node || node.data?.toolId !== 'curve_edit') {
            this.ibex.uiMgr?.notify?.('Nodo non valido per CurveEditMode', 'error');
            return;
        }

        // Risolvi target mesh via edge IN_GEO_Mesh upstream
        const graph = stackMgr.extractDAG();
        const inMeshEdge = graph.edges.find(e =>
            String(e.to_node) === String(nodeId) && e.role === 'IN_GEO_Mesh'
        );
        if (!inMeshEdge) {
            this.ibex.uiMgr?.notify?.('Collega prima una mesh al nodo Modifica Curva', 'warning');
            return;
        }
        const targetName = stackMgr.resolveBaseMesh(inMeshEdge.from_mesh, inMeshEdge.from_port);
        if (!targetName) return;
        const mesh = this.ibex.sceneMgr.group.children.find(c => c.isMesh && c.name === targetName);
        if (!mesh) {
            this.ibex.uiMgr?.notify?.(`Mesh ${targetName} non trovata in scena`, 'error');
            return;
        }

        // Verifica che esista una curva upstream collegata (IN_CRV_Curve).
        // Se manca, l'utente non ha collegato il nodo correttamente.
        const inCrvEdge = graph.edges.find(e =>
            String(e.to_node) === String(nodeId) && e.role === 'IN_CRV_Curve'
        );
        if (!inCrvEdge) {
            this.ibex.uiMgr?.notify?.(
                'Collega una curva (es. da Rileva Arco) al nodo Modifica Curva',
                'warning');
            return;
        }

        // Fetch curva da server: `_snap_{thisNodeId}.crv.json` (il worker
        // garantisce che esista al primo bake — copia dell'upstream se utente
        // non ha ancora editato).
        const stem = String(targetName).replace(/\.stl$/i, '');
        const crvFileName = `${stem}_snap_${nodeId}.crv.json`;
        let crvData = null;
        try {
            const resp = await fetch(
                `/?action=serve_file&project_id=${this.ibex.config.projectId}` +
                `&file=${encodeURIComponent(crvFileName)}&t=${Date.now()}`,
                { credentials: 'include' }
            );
            if (!resp.ok) {
                this.ibex.uiMgr?.notify?.(
                    `Curva ${crvFileName} non trovata sul server (HTTP ${resp.status}). ` +
                    `Triggera un bake prima di editare.`,
                    'warning');
                return;
            }
            crvData = await resp.json();
        } catch (e) {
            this.ibex.uiMgr?.notify?.(`Errore fetch curva: ${e.message || e}`, 'error');
            return;
        }

        // Parse splines
        const rawSplines = Array.isArray(crvData?.splines) ? crvData.splines : [];
        if (rawSplines.length === 0) {
            this.ibex.uiMgr?.notify?.('La curva upstream è vuota — nessuna spline da editare', 'warning');
            return;
        }
        // Fase 2: schema esteso con handle_types/handles_left/handles_right.
        // Backward compat: vecchi .crv.json senza questi campi → tutti i CP
        // vengono trattati come tipo 'vector' (= no handles, linea retta tra CP).
        this.splines = rawSplines.map(s => {
            const cps = (s.control_points || []).map(p => new THREE.Vector3(p[0], p[1], p[2]));
            const n = cps.length;
            const types = Array.isArray(s.handle_types) && s.handle_types.length === n
                ? s.handle_types.slice()
                : new Array(n).fill('vector');
            const parsePt = (p) => (p && p.length === 3)
                ? new THREE.Vector3(p[0], p[1], p[2]) : null;
            const hLeft  = Array.isArray(s.handles_left)
                ? s.handles_left.map(parsePt) : new Array(n).fill(null);
            const hRight = Array.isArray(s.handles_right)
                ? s.handles_right.map(parsePt) : new Array(n).fill(null);
            // Pad / truncate a length n per coerenza
            while (hLeft.length  < n) hLeft.push(null);
            while (hRight.length < n) hRight.push(null);
            hLeft.length  = n;
            hRight.length = n;
            types.length  = n;
            return {
                controlPoints: cps,
                handleTypes:   types,
                handlesLeft:   hLeft,
                handlesRight:  hRight,
                cyclic: !!s.cyclic
            };
        });
        this.activeSplineIdx = 0;

        this.active = true;
        this.targetNodeId = nodeId;
        this.targetMesh = mesh;
        this._modifiedSession = false;

        // V2.0 reset state tap-based per nuova sessione edit
        this.selectedCps.clear();
        this.snapToSurface = false;     // default OFF (drag su view-plane)
        this._dragMode = null;
        this._dragCpRef = null;
        this._dragInitialPositions = null;
        this._dragAnchorWorld = null;

        // V2.4 reset state proportional editing
        this.proportionalEdit = false;
        this.proportionalRadius = _PROP_RADIUS_DEFAULT;
        this._proportionalDistances = null;
        this._dragLastDeltaLocal = null;
        this._clearProportionalRingOverlay();

        // Pause CurveViewer overlays per evitare doppia curva sovrapposta
        // (arch_detect / draw_curve upstream + curva in editing renderizzata
        // direttamente da CurveEditMode via _renderSplines).
        // Salva quali erano visible per ripristinare in exit.
        this._pausedCurveOverlays = [];
        const cv = this.ibex.curveViewer;
        if (cv && typeof cv.getVisibleNodeIds === 'function') {
            this._pausedCurveOverlays = cv.getVisibleNodeIds();
            for (const id of this._pausedCurveOverlays) {
                cv.setEnabled(id, false);
            }
        }

        // Bind listener
        const dom = this.ibex.sceneMgr.renderer.domElement;
        // V2.0 — pointer events in CAPTURE phase per intercettare prima di OrbitControls.
        // Note: pointermove/pointerup NON necessitano capture (vivono coerenti con
        // il pointerdown intercettato).
        dom.addEventListener('pointerdown', this._onPointerDown, true);
        dom.addEventListener('pointermove', this._onPointerMove);
        dom.addEventListener('pointerup',   this._onPointerUp);
        dom.addEventListener('pointercancel', this._onPointerUp);  // touch cancel = mouseup

        // V2.4 — wheel listener (capture, passive:false) per modificare R live durante
        // drag con proportional editing ON (pattern Blender). Quando proportionalEdit
        // OFF o drag non attivo, evento pass-through a OrbitControls (zoom).
        dom.addEventListener('wheel', this._onWheel, { capture: true, passive: false });

        this.ibex.sceneMgr.deselectMesh?.();
        this._renderSplines();

        console.log(`[CURVE-EDIT] ENTER node ${nodeId} target=${targetName} ` +
                    `splines=${this.splines.length} cps_total=${this.splines.reduce(
                        (a,s) => a + s.controlPoints.length, 0)} ` +
                    `paused_overlays=${this._pausedCurveOverlays.length}`);

        this.ibex.contextInspector?.refresh?.();
    }

    // ─────────────────────────────────────────────────────────────
    // exit — fine modalità con opzione save
    // ─────────────────────────────────────────────────────────────
    exit({ save = true } = {}) {
        if (!this.active) return;
        const dom = this.ibex.sceneMgr?.renderer?.domElement;
        if (dom) {
            dom.removeEventListener('pointerdown', this._onPointerDown, true);
            dom.removeEventListener('pointermove', this._onPointerMove);
            dom.removeEventListener('pointerup',   this._onPointerUp);
            dom.removeEventListener('pointercancel', this._onPointerUp);
            dom.removeEventListener('wheel', this._onWheel, { capture: true });
            if (this._capturedPointerId !== null) {
                try { dom.releasePointerCapture(this._capturedPointerId); } catch (e) {}
                this._capturedPointerId = null;
            }
        }

        const meshSnapshot = this.targetMesh;
        const nodeIdSnapshot = this.targetNodeId;
        // Fase 2 — serializza schema esteso. Handle types/positions arrivano
        // sul disco; il worker e split_topology_via_curves.py li leggono per
        // upsampling Bezier. Vecchi consumer che non li leggono → backward
        // compat tramite control_points (sempre presente).
        const ptToArr = (p) => (p && p.isVector3) ? [p.x, p.y, p.z] : null;
        const splinesSnapshot = this.splines.map(s => ({
            control_points: s.controlPoints.map(p => [p.x, p.y, p.z]),
            handle_types:   Array.isArray(s.handleTypes) ? s.handleTypes.slice() : null,
            handles_left:   Array.isArray(s.handlesLeft)  ? s.handlesLeft.map(ptToArr)  : null,
            handles_right:  Array.isArray(s.handlesRight) ? s.handlesRight.map(ptToArr) : null,
            cyclic: s.cyclic
        }));
        const wasModified = this._modifiedSession;

        this._clearVisualization();

        // Resume CurveViewer overlays che erano stati pausati in enter().
        // NB: se l'utente ha salvato modifiche, il nuovo .crv.json verrà
        // ri-fetchato al prossimo bake — quindi la curva ri-mostrata qui
        // potrebbe essere ancora la "vecchia" (pre-edit). Verrà aggiornata
        // dal flow standard di refresh post-bake.
        const cv = this.ibex.curveViewer;
        if (cv && typeof cv.setEnabled === 'function' && Array.isArray(this._pausedCurveOverlays)) {
            for (const id of this._pausedCurveOverlays) {
                cv.setEnabled(id, true);
            }
        }
        this._pausedCurveOverlays = null;

        this.active = false;
        this.targetNodeId = null;
        this.targetMesh = null;
        this.splines = [];
        this.activeSplineIdx = -1;
        this._modifiedSession = false;
        this._dragging = false;
        this._dragCpRef = null;
        this._hoveredMesh = null;
        this._dragHoveredMesh = null;

        console.log(`[CURVE-EDIT] EXIT save=${save} modified=${wasModified} splines=${splinesSnapshot.length}`);

        if (save && wasModified && meshSnapshot && nodeIdSnapshot && this.ibex.snapshotPersist?.saveCurve) {
            this.ibex.snapshotPersist.saveCurve(meshSnapshot, nodeIdSnapshot, splinesSnapshot)
                .then(res => {
                    if (res.ok) {
                        const nClosed = splinesSnapshot.filter(s => s.cyclic).length;
                        const nOpen   = splinesSnapshot.length - nClosed;
                        const nCp     = splinesSnapshot.reduce((a, s) => a + s.control_points.length, 0);
                        this.ibex.uiMgr?.notify?.(
                            `Modifica Curva: ${nClosed} chiuse + ${nOpen} aperte (${nCp} CP totali)`,
                            'success');
                        this.ibex.stackMgr?.updateSculptNodeMeta?.(nodeIdSnapshot, {
                            sculpted:        true,
                            mesh_name:       res.mesh_name || meshSnapshot.name,
                            n_splines:       splinesSnapshot.length,
                            n_closed:        nClosed,
                            n_ctrl_points:   nCp,
                            last_modified:   Math.floor(Date.now() / 1000)
                        });
                        // Force bake — pattern arch_detect/draw_curve: il file .crv.json
                        // non cambia params del nodo → hasChanges=false → senza force
                        // il bake è skippato → consumer downstream non riceve la nuova curva.
                        this.ibex.stackMgr?.bakeEngine?.requestBake?.({ force: true });
                    } else {
                        this.ibex.uiMgr?.notify?.(`Errore save curve: ${res.error}`, 'error');
                    }
                })
                .catch(e => {
                    this.ibex.uiMgr?.notify?.(`Errore save curve: ${e.message || e}`, 'error');
                });
        }

        this.ibex.contextInspector?.refresh?.();
    }

    // ─────────────────────────────────────────────────────────────
    // Mouse handlers
    // ─────────────────────────────────────────────────────────────
    _onPointerDown(e) {
        if (!this.active || !this.targetMesh) return;
        if (e.button !== 0) return;
        // Solo mouse left + touch primary + pen primary. Pointer secondari / right
        // button → lascia pass-through totale a OrbitControls (pan / orbit).
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // Skip se il click è su UI
        if (e.target && e.target.closest('.ibex-inspector-panel')) return;
        if (e.target && e.target.closest('#dag-overlay')) return;

        this._mousedownClient = { x: e.clientX, y: e.clientY };
        this._dragStartClient = { x: e.clientX, y: e.clientY };

        // ─── PRIORITÀ 0 (Fase 2): hit su un HANDLE sphere ──────────
        // Gli handle hanno priorità sui CP perché sono visivamente sopra
        // (il _raycaster ritorna il primo hit, ma testiamo separatamente
        // gli handle meshes che sono un set distinto).
        const handleHit = this._raycastHandle(e);
        if (handleHit) {
            this._dragMode = 'handle';
            this._dragHandleRef = {
                splineIdx: handleHit.splineIdx,
                cpIdx:     handleHit.cpIdx,
                side:      handleHit.side
            };
            try {
                e.target?.setPointerCapture?.(e.pointerId);
                this._capturedPointerId = e.pointerId;
            } catch (err) { /* silently ignore */ }
            // Init view plane per drag handle (snap toggle si applica anche qui)
            const sp = this.splines[handleHit.splineIdx];
            const handle = sp && (handleHit.side === 'left'
                ? sp.handlesLeft[handleHit.cpIdx]
                : sp.handlesRight[handleHit.cpIdx]);
            if (handle) {
                this._dragAnchorWorld = handle.clone().applyMatrix4(this.targetMesh.matrixWorld);
                if (!this.snapToSurface) {
                    const camDir = this._tmpVec3;
                    this.ibex.sceneMgr.camera.getWorldDirection(camDir);
                    this._viewPlane.setFromNormalAndCoplanarPoint(camDir, this._dragAnchorWorld);
                }
            }
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            return;
        }

        // ─── PRIORITÀ 1: hit su un CP sphere ───────────────────────
        // V2.0 tap-based: niente shift+click. La rimozione CP è solo via
        // bottone inspector "Rimuovi CP selezionati" (vincolo tablet).
        // Pattern:
        //   - CP nella selezione + drag  → drag massa (tutti i selezionati)
        //   - CP nella selezione, no drag → mouseup farà toggle-remove
        //   - CP non in selezione + drag  → deseleziona tutti, seleziona
        //                                   questo, drag solo lui
        //   - CP non in selezione, no drag → mouseup farà toggle-add
        const cpHit = this._raycastCp(e);
        if (cpHit) {
            const key = this._cpKey(cpHit.splineIdx, cpHit.cpIdx);
            const wasSelected = this.selectedCps.has(key);

            // Switch active spline (visual feedback splines colorate)
            if (this.activeSplineIdx !== cpHit.splineIdx) {
                this.activeSplineIdx = cpHit.splineIdx;
            }

            if (!wasSelected) {
                // Click su CP NON selezionato: pulisci selezione + seleziona
                // solo questo. Comportamento Blender: drag su unselected =
                // implicit deselect+select.
                this.selectedCps.clear();
                this.selectedCps.add(key);
            }
            // Se wasSelected: tieni la selezione esistente (per drag massa)
            // — l'eventuale toggle-remove avviene SOLO se non c'è drag (mouseup).

            this._dragMode = 'cp';
            this._dragCpRef = { splineIdx: cpHit.splineIdx, cpIdx: cpHit.cpIdx, wasSelected };
            this._dragHoveredMesh = cpHit.mesh;
            this._renderSplines();   // refresh colori selezione

            // V2.0 — Pointer capture: garantisce che pointermove arrivi qui
            // anche se il pointer esce dai bounds del canvas. Critico per
            // tablet (touch può uscire dal viewport durante drag).
            try {
                e.target?.setPointerCapture?.(e.pointerId);
                this._capturedPointerId = e.pointerId;
            } catch (err) { /* silently ignore */ }

            // FERMA OrbitControls: stopPropagation impedisce al pointerdown
            // di raggiungere il listener OrbitControls (registrato in bubble).
            // stopImmediatePropagation per safety (altri capture listener stessa fase).
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            return;
        }

        // ─── PRIORITÀ 2: hit su un segmento spline → insert CP ─────
        const segHit = this._raycastSegment(e);
        if (segHit) {
            this._insertCp(segHit.splineIdx, segHit.insertAt, segHit.point);
            // Auto-select il CP appena inserito (= ultimo dei CP del segmento)
            // così l'utente può subito vederlo highlighted.
            this.selectedCps.clear();
            this.selectedCps.add(this._cpKey(segHit.splineIdx, segHit.insertAt));
            this._renderSplines();
            // NB: niente _dragMode → pointermove successivo NON è drag-cp
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            return;
        }

        // ─── PRIORITÀ 3: hit su area mesh (no CP, no segmento) ─────
        // Pending tap: se l'utente non fa drag, mouseup deseleziona tutto.
        // Se l'utente fa drag, pass-through OrbitControls (camera orbit).
        const rect = this.ibex.sceneMgr.renderer.domElement.getBoundingClientRect();
        this._mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._mouseNDC, this.ibex.sceneMgr.camera);
        const surfHits = this._raycaster.intersectObject(this.targetMesh, false);
        if (surfHits.length) {
            this._dragMode = 'pending_tap_void_on_mesh';
            // NB: niente preventDefault — lascia che OrbitControls riceva
            // l'evento (potrebbe diventare orbit se drag).
            return;
        }

        // ─── PRIORITÀ 4: fuori mesh → pass-through totale OrbitControls ────
        this._dragMode = 'pending_tap_off_mesh';
        // Nessun preventDefault, nessun cambio stato curva.
    }

    _onPointerMove(e) {
        if (!this.active || !this.targetMesh) return;

        // ─── Caso A0 (Fase 2): drag HANDLE ─────────────────────────
        if (this._dragMode === 'handle' && this._dragHandleRef) {
            const ref = this._dragHandleRef;
            const sp = this.splines[ref.splineIdx];
            if (!sp) return;
            const cp = sp.controlPoints[ref.cpIdx];
            if (!cp) return;

            // World point corrente del mouse (snap on/off)
            const newWorld = this._screenToWorldPoint(e);
            if (!newWorld) {
                // snap ON, raycast fail → freeze
                e.preventDefault();
                return;
            }

            // World → LOCAL (uso applyMatrix4 con full inverse: per gli handle
            // serve la traslazione, non solo direzione)
            const invMat = new THREE.Matrix4().copy(this.targetMesh.matrixWorld).invert();
            const newLocal = newWorld.clone().applyMatrix4(invMat);

            // Applica al handle corrente
            if (ref.side === 'left') {
                sp.handlesLeft[ref.cpIdx] = newLocal.clone();
            } else {
                sp.handlesRight[ref.cpIdx] = newLocal.clone();
            }

            // Se tipo CP === 'aligned' → l'handle opposto è MIRROR attorno al CP:
            //   handle_other = 2*CP - handle_dragged
            // Conserva length originale dell'opposto se diverso (Blender 'aligned')?
            //   Per V1 semplificato: mirror puro (length=length nuovo handle).
            //   Trade-off accettato — l'utente può promuovere a 'free' in V2 future.
            if (sp.handleTypes[ref.cpIdx] === 'aligned') {
                const otherSide = ref.side === 'left' ? 'right' : 'left';
                const mirrored = cp.clone().multiplyScalar(2).sub(newLocal);
                if (otherSide === 'left') {
                    sp.handlesLeft[ref.cpIdx] = mirrored;
                } else {
                    sp.handlesRight[ref.cpIdx] = mirrored;
                }
            }

            this._modifiedSession = true;
            this._renderSplines();
            e.preventDefault();
            return;
        }

        // ─── Caso A: drag CP attivo (massa o single) ───────────────
        if (this._dragMode === 'cp' && this._dragCpRef) {
            const dx = e.clientX - this._dragStartClient.x;
            const dy = e.clientY - this._dragStartClient.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < _DRAG_THRESHOLD_PX * _DRAG_THRESHOLD_PX) return;

            // Lazy init delle posizioni iniziali al primo movimento oltre threshold.
            // _dragInitialPositions = Map<key, { cp, hL, hR }> (snapshot LOCAL).
            // _dragAnchorWorld     = world point iniziale del CP che ha iniziato drag.
            // Fase 2: salviamo anche handlesLeft/Right perché shift-ano col CP.
            // Fase 3 (V2.4): se proportionalEdit ON, snapshot TUTTI i CP (non solo
            // selezionati) + pre-calc distanze along-curve dal CP anchor.
            if (!this._dragInitialPositions) {
                this._dragInitialPositions = new Map();
                // V2.4: scope = selezione se proportional OFF; altrimenti TUTTA la curva
                //       (servono snapshot pos iniziali per i CP nel raggio R).
                const allKeys = this.proportionalEdit
                    ? this._allCpKeys()
                    : Array.from(this.selectedCps);
                for (const key of allKeys) {
                    const [si, ci] = key.split(':').map(Number);
                    const sp = this.splines[si];
                    if (sp && sp.controlPoints[ci]) {
                        this._dragInitialPositions.set(key, {
                            cp: sp.controlPoints[ci].clone(),
                            hL: sp.handlesLeft && sp.handlesLeft[ci]
                                ? sp.handlesLeft[ci].clone() : null,
                            hR: sp.handlesRight && sp.handlesRight[ci]
                                ? sp.handlesRight[ci].clone() : null
                        });
                    }
                }
                if (this.proportionalEdit) {
                    this._computeProportionalDistances(
                        this._dragCpRef.splineIdx, this._dragCpRef.cpIdx);
                }
                const dragSp = this.splines[this._dragCpRef.splineIdx];
                const dragCpLocal = dragSp?.controlPoints[this._dragCpRef.cpIdx];
                if (dragCpLocal) {
                    this._dragAnchorWorld = dragCpLocal.clone().applyMatrix4(this.targetMesh.matrixWorld);
                    // Init view plane normale = camera direction, passante per anchor
                    if (!this.snapToSurface) {
                        const camDir = this._tmpVec3;
                        this.ibex.sceneMgr.camera.getWorldDirection(camDir);
                        this._viewPlane.setFromNormalAndCoplanarPoint(camDir, this._dragAnchorWorld);
                    }
                }
                // Flag drag effettivamente avvenuto: in mouseup NON si farà toggle-remove
                this._dragCpRef.draggedEffective = true;
            }

            // Calcola world point corrente del mouse (snap on/off)
            const newAnchorWorld = this._screenToWorldPoint(e);
            if (!newAnchorWorld) {
                // Snap ON ma raycast fallito → freeze (comportamento V1.0 preservato)
                e.preventDefault();
                return;
            }

            // V2.4 FIX (2026-05-13) — calcolo delta in LOCAL space preservando MAGNITUDE.
            // Bug V2.3: usavo Vector3.transformDirection(invRot) che PER DESIGN normalizza
            // il vettore output → deltaLocal aveva sempre |v|=1 → movimento CP "limitato"
            // a ~1mm a prescindere dallo spostamento mouse. Sintomo segnalato dall'utente.
            // Fix: applyMatrix4 (full inverse) a entrambi i punti, sottrazione in LOCAL.
            // Per matrixWorld con solo translation (caso IBEX V13.0 Bite-Safe identity),
            // questo è equivalente a deltaWorld. Per rotation/scale lo gestisce
            // correttamente preservando la magnitude (a differenza di transformDirection).
            const invMat = new THREE.Matrix4().copy(this.targetMesh.matrixWorld).invert();
            const initAnchorLocal = this._dragAnchorWorld.clone().applyMatrix4(invMat);
            const newAnchorLocal = newAnchorWorld.clone().applyMatrix4(invMat);
            const deltaLocal = newAnchorLocal.sub(initAnchorLocal);

            // V2.4 — branch:
            //   proportional ON  → _applyProportionalDelta itera TUTTI i CP e
            //                      applica delta * factor (1.0 se selezionato,
            //                      smooth(d/R) se non selezionato + nel raggio).
            //                      Ring overlay aggiornato automaticamente.
            //   proportional OFF → loop multi-select drag come V2.3 (selezione
            //                      esplicita = factor 1.0 uniforme).
            this._dragLastDeltaLocal = deltaLocal.clone();
            if (this.proportionalEdit) {
                this._applyProportionalDelta(deltaLocal);
            } else {
                for (const [key, initRef] of this._dragInitialPositions) {
                    const [si, ci] = key.split(':').map(Number);
                    const sp = this.splines[si];
                    if (!sp || !sp.controlPoints[ci]) continue;
                    sp.controlPoints[ci].copy(initRef.cp).add(deltaLocal);
                    if (initRef.hL && sp.handlesLeft) {
                        sp.handlesLeft[ci] = initRef.hL.clone().add(deltaLocal);
                    }
                    if (initRef.hR && sp.handlesRight) {
                        sp.handlesRight[ci] = initRef.hR.clone().add(deltaLocal);
                    }
                }
                this._modifiedSession = true;
                this._renderSplines();
            }
            e.preventDefault();
            return;
        }

        // ─── Caso B: pending_tap_void_on_mesh → se drag oltre soglia,
        //              annulla pending (OrbitControls orbiterà la view) ─
        if (this._dragMode === 'pending_tap_void_on_mesh') {
            const dx = e.clientX - this._dragStartClient.x;
            const dy = e.clientY - this._dragStartClient.y;
            if ((dx * dx + dy * dy) > (_DRAG_THRESHOLD_PX * _DRAG_THRESHOLD_PX)) {
                // L'utente sta ruotando la view → tap → "drag camera"
                // → annulla il pending tap (mouseup non farà deseleziona-tutto).
                this._dragMode = 'pending_tap_off_mesh';
            }
            return;
        }

        // ─── Caso C: nessun drag → hover detection ─────────────────
        const cpHit = this._raycastCp(e);
        if (cpHit) {
            if (this._hoveredMesh !== cpHit.mesh) {
                // Ripristina visual del precedente rispettando lo stato selected
                if (this._hoveredMesh) {
                    const prev = this._ctrlPointMeshes.find(c => c.mesh === this._hoveredMesh);
                    if (prev) {
                        const prevKey = this._cpKey(prev.splineIdx, prev.cpIdx);
                        this._setCpVisual(this._hoveredMesh,
                            this.selectedCps.has(prevKey) ? 'selected' : 'normal');
                    }
                }
                this._setCpVisual(cpHit.mesh, 'hover');
                this._hoveredMesh = cpHit.mesh;
                this.ibex.sceneMgr.renderer.domElement.style.cursor = 'grab';
            }
        } else if (this._hoveredMesh) {
            const prev = this._ctrlPointMeshes.find(c => c.mesh === this._hoveredMesh);
            if (prev) {
                const prevKey = this._cpKey(prev.splineIdx, prev.cpIdx);
                this._setCpVisual(this._hoveredMesh,
                    this.selectedCps.has(prevKey) ? 'selected' : 'normal');
            }
            this._hoveredMesh = null;
            this.ibex.sceneMgr.renderer.domElement.style.cursor = '';
        }
    }

    _onPointerUp(e) {
        if (!this.active) return;

        // Release pointer capture se attivo
        if (this._capturedPointerId !== null) {
            try { e.target?.releasePointerCapture?.(this._capturedPointerId); } catch (err) {}
            this._capturedPointerId = null;
        }

        const mode = this._dragMode;
        const ref = this._dragCpRef;

        // ─── Drag HANDLE appena terminato (Fase 2) ─────────────────
        if (mode === 'handle' && this._dragHandleRef) {
            this._dispatchCountChanged();
            this._dragMode = null;
            this._dragHandleRef = null;
            this._dragAnchorWorld = null;
            this.ibex.sceneMgr.renderer.domElement.style.cursor = '';
            return;
        }

        // ─── Drag CP appena terminato ──────────────────────────────
        if (mode === 'cp' && ref) {
            const didDrag = !!ref.draggedEffective;
            if (!didDrag) {
                // Mouse non si è mosso oltre threshold → TAP singolo su CP
                // Pattern tablet-first: toggle add/remove.
                //   - wasSelected=true  → era già selezionato → REMOVE
                //   - wasSelected=false → non era selezionato → ADD (già fatto in mousedown)
                const key = this._cpKey(ref.splineIdx, ref.cpIdx);
                if (ref.wasSelected) {
                    this.selectedCps.delete(key);
                }
                // (Se wasSelected=false, in mousedown abbiamo già fatto clear+add
                //  → niente altro da fare qui.)
                this._renderSplines();
                this._dispatchCountChanged();
            } else {
                // Era un vero drag — refresh stats (n CP toccati, ecc.)
                this._dispatchCountChanged();
            }
            this._dragMode = null;
            this._dragCpRef = null;
            this._dragInitialPositions = null;
            this._dragAnchorWorld = null;
            // V2.4: cleanup state proportional
            this._proportionalDistances = null;
            this._dragLastDeltaLocal = null;
            this._clearProportionalRingOverlay();
            this.ibex.sceneMgr.renderer.domElement.style.cursor = '';
            return;
        }

        // ─── Pending tap su void mesh: nessun drag → DESELEZIONA TUTTI ───
        if (mode === 'pending_tap_void_on_mesh') {
            if (this.selectedCps.size > 0) {
                this.selectedCps.clear();
                this._renderSplines();
                this._dispatchCountChanged();
            }
            this._dragMode = null;
            return;
        }

        // pending_tap_off_mesh o stato sconosciuto → reset silenzioso
        this._dragMode = null;
        this._dragCpRef = null;
        this._dragInitialPositions = null;
        this._dragAnchorWorld = null;
        this._proportionalDistances = null;
        this._dragLastDeltaLocal = null;
        this._clearProportionalRingOverlay();
    }

    // ─────────────────────────────────────────────────────────────
    // V2.0 — Selection helpers (tap-based, tablet-friendly)
    // ─────────────────────────────────────────────────────────────
    _cpKey(splineIdx, cpIdx) {
        return `${splineIdx}:${cpIdx}`;
    }

    _isCpSelected(splineIdx, cpIdx) {
        return this.selectedCps.has(this._cpKey(splineIdx, cpIdx));
    }

    /** V2.4 — Iterator helper: tutte le keys CP di tutte le splines. */
    _allCpKeys() {
        const out = [];
        for (let si = 0; si < this.splines.length; si++) {
            const sp = this.splines[si];
            for (let ci = 0; ci < sp.controlPoints.length; ci++) {
                out.push(this._cpKey(si, ci));
            }
        }
        return out;
    }

    /**
     * Schermo (clientX/Y) → world point per drag CP.
     * - snapToSurface ON  → raycast su targetMesh; ritorna null se no hit (freeze)
     * - snapToSurface OFF → intersezione con this._viewPlane (init in mousemove)
     *                       Mai null: il piano è inifinito, intersezione sempre garantita
     *                       a meno che il ray sia parallelo al piano (camera mai allineata,
     *                       caso teorico impossibile in pratica).
     */
    _screenToWorldPoint(e) {
        const rect = this.ibex.sceneMgr.renderer.domElement.getBoundingClientRect();
        this._mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._mouseNDC, this.ibex.sceneMgr.camera);

        if (this.snapToSurface) {
            const hits = this._raycaster.intersectObject(this.targetMesh, false);
            if (!hits.length) return null;
            return hits[0].point.clone();
        }
        // View-plane drag: piano normale = camera direction, passante per
        // _dragAnchorWorld (la posizione corrente del CP all'inizio drag).
        const intersectPoint = this._tmpVec3b;
        const hit = this._raycaster.ray.intersectPlane(this._viewPlane, intersectPoint);
        if (!hit) return this._dragAnchorWorld ? this._dragAnchorWorld.clone() : null;
        return intersectPoint.clone();
    }

    // ─────────────────────────────────────────────────────────────
    // V2.0 — API pubblica per ContextInspector (bottoni selezione)
    // ─────────────────────────────────────────────────────────────
    setSnapToSurface(on) {
        this.snapToSurface = !!on;
    }

    selectAllCps() {
        this.selectedCps.clear();
        for (let si = 0; si < this.splines.length; si++) {
            const sp = this.splines[si];
            for (let ci = 0; ci < sp.controlPoints.length; ci++) {
                this.selectedCps.add(this._cpKey(si, ci));
            }
        }
        this._renderSplines();
        this._dispatchCountChanged();
    }

    deselectAllCps() {
        if (this.selectedCps.size === 0) return;
        this.selectedCps.clear();
        this._renderSplines();
        this._dispatchCountChanged();
    }

    invertSelection() {
        const newSel = new Set();
        for (let si = 0; si < this.splines.length; si++) {
            const sp = this.splines[si];
            for (let ci = 0; ci < sp.controlPoints.length; ci++) {
                const key = this._cpKey(si, ci);
                if (!this.selectedCps.has(key)) newSel.add(key);
            }
        }
        this.selectedCps = newSel;
        this._renderSplines();
        this._dispatchCountChanged();
    }

    // ─────────────────────────────────────────────────────────────
    // Fase 2 — Handles Bezier (promote / demote / Bezier eval)
    // ─────────────────────────────────────────────────────────────
    /**
     * Promuove i CP selezionati a tipo 'aligned' (handles bezier attivi).
     * Inizializza handles left/right con tangente Catmull-Rom-like:
     *   tangent = (CP_next - CP_prev) / |CP_next - CP_prev|
     *   handle_left  = CP - tangent * (segLen_prev * 0.33)
     *   handle_right = CP + tangent * (segLen_next * 0.33)
     * In modo che la curva Bezier risultante sia visivamente identica
     * alla polyline lineare al promote (niente "jump" al click).
     */
    promoteSelectionToAligned() {
        if (this.selectedCps.size === 0) {
            this.ibex.uiMgr?.notify?.('Nessun CP selezionato', 'warning');
            return;
        }
        let n = 0;
        for (const key of this.selectedCps) {
            const [si, ci] = key.split(':').map(Number);
            const sp = this.splines[si];
            if (!sp) continue;
            if (sp.handleTypes[ci] === 'aligned') continue;
            this._initHandlesForCp(sp, ci);
            sp.handleTypes[ci] = 'aligned';
            n++;
        }
        if (n > 0) {
            this._modifiedSession = true;
            this._renderSplines();
            this._dispatchCountChanged();
            console.log(`[CURVE-EDIT] PROMOTE ${n} CP → aligned`);
        }
    }

    /**
     * Demote i CP selezionati a tipo 'vector' (rimuove handles).
     * I segmenti adiacenti tornano a linea retta tra CP consecutivi.
     */
    demoteSelectionToVector() {
        if (this.selectedCps.size === 0) {
            this.ibex.uiMgr?.notify?.('Nessun CP selezionato', 'warning');
            return;
        }
        let n = 0;
        for (const key of this.selectedCps) {
            const [si, ci] = key.split(':').map(Number);
            const sp = this.splines[si];
            if (!sp) continue;
            if (sp.handleTypes[ci] === 'vector') continue;
            sp.handlesLeft[ci]  = null;
            sp.handlesRight[ci] = null;
            sp.handleTypes[ci] = 'vector';
            n++;
        }
        if (n > 0) {
            this._modifiedSession = true;
            this._renderSplines();
            this._dispatchCountChanged();
            console.log(`[CURVE-EDIT] DEMOTE ${n} CP → vector`);
        }
    }

    /**
     * Inizializza handlesLeft/Right per il CP `ci` di `sp` seguendo la pendenza
     * locale della curva (Catmull-Rom → Bezier conversion, stile Blender).
     *
     * Formula classica Catmull-Rom→Bezier:
     *   handle_right[i] = CP[i] + (CP[i+1] - CP[i-1]) / 6
     *   handle_left[i]  = CP[i] - (CP[i+1] - CP[i-1]) / 6
     *
     * Risultato: gli handle sono SIMMETRICI rispetto al CP (= tipo 'aligned'
     * per natura) e la tangente segue la pendenza locale della polyline,
     * passando per CP[i-1] e CP[i+1] con interpolazione C1-continua.
     *
     * Edge cases (CP estremi aperti):
     *   - ci=0:    usa direzione (CP[1] - CP[0]) come tangente; left=mirror right
     *   - ci=last: usa direzione (CP[last] - CP[last-1]) come tangente; right=mirror left
     *   - Spline ciclica: wrap-around standard (CP[-1] = CP[n-1])
     */
    _initHandlesForCp(sp, ci) {
        const cp = sp.controlPoints[ci];
        const n = sp.controlPoints.length;
        if (!cp || n < 2) {
            sp.handlesLeft[ci]  = cp ? cp.clone() : null;
            sp.handlesRight[ci] = cp ? cp.clone() : null;
            return;
        }
        const prev = sp.cyclic
            ? sp.controlPoints[(ci - 1 + n) % n]
            : (ci > 0 ? sp.controlPoints[ci - 1] : null);
        const next = sp.cyclic
            ? sp.controlPoints[(ci + 1) % n]
            : (ci < n - 1 ? sp.controlPoints[ci + 1] : null);

        // Tangente vettoriale (NON solo direzione — la LUNGHEZZA conta per
        // determinare l'ampiezza dell'handle).
        // Formula Catmull-Rom→Bezier classic: (CP_next - CP_prev) / 6.
        // IBEX usa _HANDLE_INIT_DIVISOR=3 (2× più lungo del Catmull-Rom puro)
        // per UX: il bulge della curva Bezier è VISIBILE anche su 1 solo CP
        // promosso. L'utente può sempre rimpicciolire l'handle drag-ando.
        let tangentVec;
        const D = _HANDLE_INIT_DIVISOR;
        if (prev && next) {
            // CP interno
            tangentVec = next.clone().sub(prev).multiplyScalar(1 / D);
        } else if (next) {
            // CP estremo iniziale (aperto): tangente = direzione verso next
            tangentVec = next.clone().sub(cp).multiplyScalar(1 / (D / 2));
        } else if (prev) {
            // CP estremo finale (aperto): tangente = direzione da prev
            tangentVec = cp.clone().sub(prev).multiplyScalar(1 / (D / 2));
        } else {
            // Caso degenere
            sp.handlesLeft[ci]  = cp.clone();
            sp.handlesRight[ci] = cp.clone();
            return;
        }

        // Pattern Blender 'aligned': handle_right = CP + tangent
        //                            handle_left  = CP − tangent  (mirror)
        sp.handlesLeft[ci]  = cp.clone().sub(tangentVec);
        sp.handlesRight[ci] = cp.clone().add(tangentVec);
    }

    /**
     * Evaluator Bezier cubica del segmento tra CP_i e CP_{i+1} (in spline `sp`).
     * Punti di controllo:
     *   P0 = CP_i
     *   P1 = handles_right[i]  (se null → P1 = P0, degenera a linea retta)
     *   P2 = handles_left[i+1] (se null → P2 = P3, degenera a linea retta)
     *   P3 = CP_{i+1}
     * Se BOTH handles non null → curva Bezier; altrimenti → linea retta.
     */
    _evalBezierSegment(sp, i, samples) {
        const n = sp.controlPoints.length;
        const i2 = sp.cyclic ? ((i + 1) % n) : (i + 1);
        if (i2 >= n && !sp.cyclic) return [];
        const P0 = sp.controlPoints[i];
        const P3 = sp.controlPoints[i2];
        const P1 = sp.handlesRight[i] || P0;
        const P2 = sp.handlesLeft[i2] || P3;
        // Se nessun handle attivo → linea retta (samples=2)
        const useBezier = (sp.handleTypes[i] === 'aligned' || sp.handleTypes[i2] === 'aligned')
                          && (sp.handlesRight[i] || sp.handlesLeft[i2]);
        const N = useBezier ? samples : 2;
        const pts = [];
        for (let s = 0; s < N; s++) {
            const t = s / (N - 1);
            const omt = 1 - t;
            // B(t) = (1-t)³ P0 + 3(1-t)²t P1 + 3(1-t)t² P2 + t³ P3
            const w0 = omt * omt * omt;
            const w1 = 3 * omt * omt * t;
            const w2 = 3 * omt * t * t;
            const w3 = t * t * t;
            const px = w0 * P0.x + w1 * P1.x + w2 * P2.x + w3 * P3.x;
            const py = w0 * P0.y + w1 * P1.y + w2 * P2.y + w3 * P3.y;
            const pz = w0 * P0.z + w1 * P1.z + w2 * P2.z + w3 * P3.z;
            pts.push(new THREE.Vector3(px, py, pz));
        }
        return pts;
    }

    // ─────────────────────────────────────────────────────────────
    // Fase 3 (V2.4) — Proportional editing (Blender O-mode)
    // ─────────────────────────────────────────────────────────────
    /** API pubblica per ContextInspector. */
    setProportionalEdit(on) {
        this.proportionalEdit = !!on;
        // Se attivo durante un drag, mostra subito il ring
        if (this._dragMode === 'cp' && this._dragAnchorWorld) {
            this._updateProportionalRingOverlay();
        } else if (!this.proportionalEdit) {
            this._clearProportionalRingOverlay();
        }
    }
    setProportionalRadius(mm) {
        const r = Math.max(_PROP_RADIUS_MIN, Math.min(_PROP_RADIUS_MAX, Number(mm) || _PROP_RADIUS_DEFAULT));
        this.proportionalRadius = r;
        if (this._dragMode === 'cp' && this.proportionalEdit) {
            this._updateProportionalRingOverlay();
            this._applyProportionalDeltaFromCache();
        }
    }

    /**
     * Pre-calcola distanze along-curve da `anchorCpIdx` per ogni CP della spline
     * `anchorSplineIdx`. CP di altre splines: distance = Infinity (mai mossi).
     * Cumlen calcolato in LOCAL space su distanze euclidee tra CP consecutivi.
     * Per spline cicliche: distance = min(forward, backward) (wrap-around).
     * Risultato salvato in this._proportionalDistances (Map<"si:ci", d>).
     */
    _computeProportionalDistances(anchorSplineIdx, anchorCpIdx) {
        this._proportionalDistances = new Map();
        for (let si = 0; si < this.splines.length; si++) {
            const sp = this.splines[si];
            if (si !== anchorSplineIdx) {
                // CP di altre splines: distance infinita → mai influenzati
                for (let ci = 0; ci < sp.controlPoints.length; ci++) {
                    this._proportionalDistances.set(this._cpKey(si, ci), Infinity);
                }
                continue;
            }
            const n = sp.controlPoints.length;
            if (n < 2) {
                this._proportionalDistances.set(this._cpKey(si, anchorCpIdx), 0);
                continue;
            }
            // Cumlen lungo la polyline (LOCAL space, distanza euclidea tra CP consec.)
            // Per spline cicliche includiamo l'edge n-1 → 0 in coda.
            const cumlen = new Array(n + 1);
            cumlen[0] = 0;
            for (let i = 0; i < n; i++) {
                const i2 = (i + 1) % n;
                if (!sp.cyclic && i === n - 1) {
                    cumlen[i + 1] = cumlen[i];  // no edge wrap-around per spline aperta
                } else {
                    cumlen[i + 1] = cumlen[i] + sp.controlPoints[i].distanceTo(sp.controlPoints[i2]);
                }
            }
            const totalLen = cumlen[n];
            const anchorPos = cumlen[anchorCpIdx];
            for (let ci = 0; ci < n; ci++) {
                const cpPos = cumlen[ci];
                const diff = Math.abs(cpPos - anchorPos);
                let d = diff;
                if (sp.cyclic && totalLen > 0) {
                    // Wrap-around: prendi il path più corto
                    d = Math.min(diff, totalLen - diff);
                }
                this._proportionalDistances.set(this._cpKey(si, ci), d);
            }
        }
    }

    /**
     * Applica delta proporzionale a tutti i CP della curva, usando le distanze
     * pre-calcolate + il delta LOCAL corrente. Chiamato sia da `_onPointerMove`
     * (drag mouse) sia da `_onWheel` / `setProportionalRadius` (R cambia → ri-applica
     * delta con nuovo R, senza dover muovere il mouse).
     *
     * Salva l'ultimo delta_local applicato in this._dragLastDeltaLocal per supportare
     * il caso "scroll R" durante drag fermo.
     */
    _applyProportionalDeltaFromCache() {
        if (!this._dragInitialPositions || !this._proportionalDistances) return;
        if (!this._dragLastDeltaLocal) return;  // mai mosso il mouse → niente da fare
        this._applyProportionalDelta(this._dragLastDeltaLocal);
    }

    /**
     * Implementazione effettiva: per ogni CP nel snapshot iniziale, calcola
     * il factor di influenza (1.0 se selezionato OR factor smooth(d/R) se non
     * selezionato), applica delta_local * factor a CP + handles.
     */
    _applyProportionalDelta(deltaLocal) {
        const R = this.proportionalRadius;
        for (const [key, initRef] of this._dragInitialPositions) {
            const [si, ci] = key.split(':').map(Number);
            const sp = this.splines[si];
            if (!sp || !sp.controlPoints[ci]) continue;
            let factor;
            if (this.selectedCps.has(key)) {
                // CP selezionato → muove con factor pieno (override Blender-like)
                factor = 1.0;
            } else if (this.proportionalEdit) {
                const d = this._proportionalDistances?.get(key);
                if (d === undefined || d === Infinity || d > R) {
                    factor = 0;
                } else {
                    factor = _propFalloffSmooth(d / R);
                }
            } else {
                factor = 0;
            }
            if (factor <= 0) {
                // CP non influenzato → ripristina pos iniziale (necessario perché
                // il render precedente potrebbe averlo spostato con R diverso)
                sp.controlPoints[ci].copy(initRef.cp);
                if (initRef.hL && sp.handlesLeft)  sp.handlesLeft[ci]  = initRef.hL.clone();
                if (initRef.hR && sp.handlesRight) sp.handlesRight[ci] = initRef.hR.clone();
            } else {
                const scaled = deltaLocal.clone().multiplyScalar(factor);
                sp.controlPoints[ci].copy(initRef.cp).add(scaled);
                if (initRef.hL && sp.handlesLeft) {
                    sp.handlesLeft[ci] = initRef.hL.clone().add(scaled);
                }
                if (initRef.hR && sp.handlesRight) {
                    sp.handlesRight[ci] = initRef.hR.clone().add(scaled);
                }
            }
        }
        this._modifiedSession = true;
        this._renderSplines();
        // ringMesh viene aggiunto al _overlayGroup dentro _renderSplines via
        // _updateProportionalRingOverlay (chiamato dopo)
        this._updateProportionalRingOverlay();
    }

    /**
     * Disegna/aggiorna il cerchio overlay attorno al CP anchor durante drag.
     * Cerchio orientato alla camera (`lookAt`), raggio = proportionalRadius mm.
     */
    _updateProportionalRingOverlay() {
        this._clearProportionalRingOverlay();
        if (!this.proportionalEdit) return;
        if (this._dragMode !== 'cp') return;
        if (!this._dragAnchorWorld) return;
        if (!this._overlayGroup) return;
        const R = this.proportionalRadius;
        // RingGeometry — cerchio piatto sottile (R, R*1.03), orientato camera
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(R * 0.97, R, _PROP_RING_SEGMENTS),
            new THREE.MeshBasicMaterial({
                color: _PROP_RING_COLOR,
                transparent: true,
                opacity: _PROP_RING_OPACITY,
                side: THREE.DoubleSide,
                depthTest: false
            })
        );
        ring.position.copy(this._dragAnchorWorld);
        ring.lookAt(this.ibex.sceneMgr.camera.position);
        ring.renderOrder = 998;
        this._overlayGroup.add(ring);
        this._proportionalRingMesh = ring;
        this.ibex.sceneMgr.render?.();
    }

    _clearProportionalRingOverlay() {
        if (this._proportionalRingMesh) {
            const parent = this._proportionalRingMesh.parent;
            if (parent) parent.remove(this._proportionalRingMesh);
            if (this._proportionalRingMesh.geometry) this._proportionalRingMesh.geometry.dispose();
            if (this._proportionalRingMesh.material) this._proportionalRingMesh.material.dispose();
            this._proportionalRingMesh = null;
        }
    }

    /**
     * Wheel handler: durante drag CP con proportional editing ON, modifica R
     * live (zoom proporzionale). Senza proportional edit attivo o senza drag
     * → pass-through a OrbitControls (zoom camera default).
     */
    _onWheel(e) {
        if (!this.active) return;
        if (!this.proportionalEdit) return;
        if (this._dragMode !== 'cp') return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        const factor = e.deltaY < 0 ? _PROP_WHEEL_FACTOR : (1 / _PROP_WHEEL_FACTOR);
        this.setProportionalRadius(this.proportionalRadius * factor);
        // Notifica inspector per refresh slider value
        this._dispatchCountChanged();
    }

    /**
     * Rimuove i CP attualmente selezionati. Skip se rimarrebbero < 2 CP
     * in una spline (curva degenere). Selezione svuotata post-rimozione.
     */
    removeSelectedCps() {
        if (this.selectedCps.size === 0) return;
        // Raggruppa per splineIdx, ordina indici desc (rimuovere dall'alto)
        const bySpline = new Map();
        for (const key of this.selectedCps) {
            const [si, ci] = key.split(':').map(Number);
            if (!bySpline.has(si)) bySpline.set(si, []);
            bySpline.get(si).push(ci);
        }
        let totalRemoved = 0;
        for (const [si, idxs] of bySpline) {
            const sp = this.splines[si];
            if (!sp) continue;
            const after = sp.controlPoints.length - idxs.length;
            if (after < 2) {
                this.ibex.uiMgr?.notify?.(
                    `Spline #${si + 1}: impossibile rimuovere ${idxs.length} CP (resterebbero solo ${after} CP, minimo 2)`,
                    'warning');
                continue;
            }
            // Rimuovi dagli indici alti ai bassi per non invalidare i successivi
            idxs.sort((a, b) => b - a);
            for (const ci of idxs) {
                sp.controlPoints.splice(ci, 1);
                // Fase 2: rimuovi anche gli array paralleli per mantenere coerenza length
                if (sp.handleTypes)  sp.handleTypes.splice(ci, 1);
                if (sp.handlesLeft)  sp.handlesLeft.splice(ci, 1);
                if (sp.handlesRight) sp.handlesRight.splice(ci, 1);
                totalRemoved++;
            }
        }
        if (totalRemoved > 0) {
            this.selectedCps.clear();
            this._modifiedSession = true;
            this._renderSplines();
            this._dispatchCountChanged();
            console.log(`[CURVE-EDIT] REMOVE ${totalRemoved} CP (selezione svuotata)`);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Raycast helpers
    // ─────────────────────────────────────────────────────────────
    _raycastCp(e) {
        // Cerca hit su _ctrlPointMeshes (spheres)
        if (!this._ctrlPointMeshes.length) return null;
        const rect = this.ibex.sceneMgr.renderer.domElement.getBoundingClientRect();
        this._mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._mouseNDC, this.ibex.sceneMgr.camera);
        const meshList = this._ctrlPointMeshes.map(c => c.mesh);
        const hits = this._raycaster.intersectObjects(meshList, false);
        if (!hits.length) return null;
        const hitMesh = hits[0].object;
        const ref = this._ctrlPointMeshes.find(c => c.mesh === hitMesh);
        if (!ref) return null;
        return { ...ref };
    }

    /**
     * Fase 2 — Raycast su handle spheres. Ritorna { splineIdx, cpIdx, side, mesh }
     * o null. Gli handle spheres esistono solo per CP aligned+selected (vedi
     * _renderSplines C). Quindi non possono esserci falsi positivi di handle
     * orfani in scena.
     */
    _raycastHandle(e) {
        if (!this._handlePointMeshes.length) return null;
        const rect = this.ibex.sceneMgr.renderer.domElement.getBoundingClientRect();
        this._mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._mouseNDC, this.ibex.sceneMgr.camera);
        const meshList = this._handlePointMeshes.map(c => c.mesh);
        const hits = this._raycaster.intersectObjects(meshList, false);
        if (!hits.length) return null;
        const hitMesh = hits[0].object;
        const ref = this._handlePointMeshes.find(c => c.mesh === hitMesh);
        if (!ref) return null;
        return { ...ref };
    }

    _raycastSegment(e) {
        // Trova il segmento di spline più vicino al ray. Per ogni spline,
        // iteriamo le coppie consecutive (CP_i, CP_i+1) in world space,
        // calcoliamo la distanza punto-segmento minima dal ray.
        // Insertion point = midpoint del segmento (in local) → snap-to-surface
        // post-insert via raycast.
        if (!this.splines.length) return null;

        const rect = this.ibex.sceneMgr.renderer.domElement.getBoundingClientRect();
        this._mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._mouseNDC, this.ibex.sceneMgr.camera);

        // Prima raycast su targetMesh per ottenere un punto 3D sulla superficie
        const surfHits = this._raycaster.intersectObject(this.targetMesh, false);
        if (!surfHits.length) return null;
        const surfPoint = surfHits[0].point.clone();   // world

        // Trova il segmento più vicino al surfPoint nel piano 3D
        const matWorld = this.targetMesh.matrixWorld;
        let best = null;
        const SEG_INSERT_THRESHOLD_MM = 1.5;   // 1.5mm dalla curva per inserire

        for (let si = 0; si < this.splines.length; si++) {
            const sp = this.splines[si];
            const pts = sp.controlPoints;
            if (pts.length < 2) continue;
            const nSeg = sp.cyclic ? pts.length : pts.length - 1;
            for (let i = 0; i < nSeg; i++) {
                const i2 = (i + 1) % pts.length;
                const A = pts[i].clone().applyMatrix4(matWorld);
                const B = pts[i2].clone().applyMatrix4(matWorld);
                const AB = B.clone().sub(A);
                const lenSq = AB.lengthSq();
                if (lenSq < 1e-9) continue;
                // proietta surfPoint su AB
                const t = surfPoint.clone().sub(A).dot(AB) / lenSq;
                if (t < 0 || t > 1) continue; // fuori dal segmento
                const proj = A.clone().add(AB.multiplyScalar(t));
                const dist = proj.distanceTo(surfPoint);
                if (dist > SEG_INSERT_THRESHOLD_MM) continue;
                if (!best || dist < best.dist) {
                    best = {
                        splineIdx: si,
                        insertAt: i + 1,  // insert tra i e i+1 → idx = i+1
                        point: surfPoint.clone(),
                        dist
                    };
                }
            }
        }
        return best;
    }

    // ─────────────────────────────────────────────────────────────
    // Mutazioni CP
    // ─────────────────────────────────────────────────────────────
    _insertCp(splineIdx, insertAt, worldPoint) {
        const sp = this.splines[splineIdx];
        if (!sp) return;
        const inv = new THREE.Matrix4().copy(this.targetMesh.matrixWorld).invert();
        const localPoint = worldPoint.clone().applyMatrix4(inv);
        sp.controlPoints.splice(insertAt, 0, localPoint);
        // Fase 2: mantieni coerenza array paralleli — nuovo CP è tipo 'vector'
        // (handles null). L'utente può promuoverlo a aligned dopo.
        if (sp.handleTypes)  sp.handleTypes.splice(insertAt, 0, 'vector');
        if (sp.handlesLeft)  sp.handlesLeft.splice(insertAt, 0, null);
        if (sp.handlesRight) sp.handlesRight.splice(insertAt, 0, null);
        this._modifiedSession = true;
        if (this.activeSplineIdx !== splineIdx) this.activeSplineIdx = splineIdx;
        this._renderSplines();
        this._dispatchCountChanged();
        console.log(`[CURVE-EDIT] INSERT cp in spline ${splineIdx} at idx ${insertAt} → ${sp.controlPoints.length} CPs`);
    }

    _removeCp(splineIdx, cpIdx) {
        const sp = this.splines[splineIdx];
        if (!sp) return;
        if (sp.controlPoints.length <= 2) {
            this.ibex.uiMgr?.notify?.(
                'Una spline deve avere almeno 2 control points', 'warning');
            return;
        }
        sp.controlPoints.splice(cpIdx, 1);
        if (sp.handleTypes)  sp.handleTypes.splice(cpIdx, 1);
        if (sp.handlesLeft)  sp.handlesLeft.splice(cpIdx, 1);
        if (sp.handlesRight) sp.handlesRight.splice(cpIdx, 1);
        this._modifiedSession = true;
        this._renderSplines();
        this._dispatchCountChanged();
        console.log(`[CURVE-EDIT] REMOVE cp in spline ${splineIdx} idx ${cpIdx} → ${sp.controlPoints.length} CPs`);
    }

    // ─────────────────────────────────────────────────────────────
    // API pubbliche per ContextInspector
    // ─────────────────────────────────────────────────────────────
    setActiveSpline(idx) {
        if (idx < 0 || idx >= this.splines.length) return;
        this.activeSplineIdx = idx;
        this._renderSplines();
        this._dispatchCountChanged();
    }

    addNewSpline() {
        // Fase 2: inizializza array paralleli vuoti per consistenza schema
        this.splines.push({
            controlPoints: [],
            handleTypes: [],
            handlesLeft: [],
            handlesRight: [],
            cyclic: false
        });
        this.activeSplineIdx = this.splines.length - 1;
        this._modifiedSession = true;
        this._renderSplines();
        this._dispatchCountChanged();
    }

    deleteActiveSpline() {
        if (this.activeSplineIdx < 0 || this.splines.length <= 1) {
            this.ibex.uiMgr?.notify?.(
                'Servono almeno 2 splines per cancellarne una', 'warning');
            return;
        }
        this.splines.splice(this.activeSplineIdx, 1);
        this.activeSplineIdx = Math.min(this.activeSplineIdx, this.splines.length - 1);
        this._modifiedSession = true;
        this._renderSplines();
        this._dispatchCountChanged();
    }

    toggleActiveCyclic() {
        const sp = this.splines[this.activeSplineIdx];
        if (!sp) return;
        if (sp.controlPoints.length < 3 && !sp.cyclic) {
            this.ibex.uiMgr?.notify?.('Servono almeno 3 punti per chiudere', 'warning');
            return;
        }
        sp.cyclic = !sp.cyclic;
        this._modifiedSession = true;
        this._renderSplines();
        this._dispatchCountChanged();
    }

    // ─────────────────────────────────────────────────────────────
    // Rendering (pattern identico a CurveMode V1.1, con varianti di colore
    // per CP hover/drag)
    // ─────────────────────────────────────────────────────────────
    _renderSplines() {
        this._clearVisualization();
        if (!this.targetMesh) return;
        const scene = this.ibex.sceneMgr.scene;

        const matWorld = this.targetMesh.matrixWorld;
        const overlayGroup = new THREE.Group();
        overlayGroup.name = '_ibex_curve_edit_overlay';
        overlayGroup.renderOrder = 999;

        const w = window.innerWidth;
        const h = window.innerHeight;

        for (let i = 0; i < this.splines.length; i++) {
            const sp = this.splines[i];
            const isActive = (i === this.activeSplineIdx);
            const color = _SPLINE_COLORS[i % _SPLINE_COLORS.length];

            // ─── A) Linea spline: Bezier eval segmento-per-segmento ───
            // Per ogni segmento da CP_i a CP_{i+1}:
            //   - se entrambi sono 'vector' (no handles) → linea retta (2 pts)
            //   - altrimenti → curva Bezier evaluata a N samples (visualmente smooth)
            if (sp.controlPoints.length >= 2) {
                const allPts = [];
                const nCp = sp.controlPoints.length;
                const nSeg = sp.cyclic ? nCp : nCp - 1;
                for (let segIdx = 0; segIdx < nSeg; segIdx++) {
                    const segPts = this._evalBezierSegment(sp, segIdx, _BEZIER_SAMPLES_PER_SEG);
                    if (!segPts.length) continue;
                    // Skip first pt se non è il primo segmento (continuità senza duplicati)
                    const startK = (allPts.length === 0) ? 0 : 1;
                    for (let k = startK; k < segPts.length; k++) {
                        allPts.push(segPts[k].applyMatrix4(matWorld));
                    }
                }
                if (allPts.length >= 2) {
                    const flat = new Float32Array(allPts.length * 3);
                    for (let j = 0; j < allPts.length; j++) {
                        flat[j*3]     = allPts[j].x;
                        flat[j*3 + 1] = allPts[j].y;
                        flat[j*3 + 2] = allPts[j].z;
                    }
                    const geo = new LineGeometry();
                    geo.setPositions(flat);
                    const mat = new LineMaterial({
                        color, linewidth: _LINE_WIDTH_PX,
                        transparent: true,
                        opacity: isActive ? 0.95 : 0.55,
                        depthTest: false,
                        dashed: false,
                        resolution: new THREE.Vector2(w, h),
                    });
                    const line = new Line2(geo, mat);
                    line.renderOrder = 999;
                    overlayGroup.add(line);
                    this._splineLines.push(line);
                }
            }

            // ─── B) CP sphere (selezione highlight via colore SELECTED) ───
            const sphereGeo = new THREE.SphereGeometry(_CTRL_POINT_RADIUS_MM, 12, 12);
            const hoverScale = _CTRL_POINT_RADIUS_MM_HOVER / _CTRL_POINT_RADIUS_MM;
            for (let cpIdx = 0; cpIdx < sp.controlPoints.length; cpIdx++) {
                const lp = sp.controlPoints[cpIdx];
                const wp = lp.clone().applyMatrix4(matWorld);
                const cpKey = this._cpKey(i, cpIdx);
                const isSelected = this.selectedCps.has(cpKey);
                const baseColor = isSelected
                    ? _CTRL_POINT_COLOR_SELECTED
                    : (isActive ? _CTRL_POINT_COLOR : color);
                const sphereMat = new THREE.MeshBasicMaterial({
                    color: baseColor,
                    depthTest: false,
                    transparent: true,
                    opacity: isSelected ? 1.0 : (isActive ? 0.95 : 0.55)
                });
                const sphere = new THREE.Mesh(sphereGeo, sphereMat);
                sphere.position.copy(wp);
                if (isSelected) sphere.scale.setScalar(hoverScale);
                sphere.renderOrder = 1000;
                overlayGroup.add(sphere);
                this._ctrlPointMeshes.push({ mesh: sphere, splineIdx: i, cpIdx });

                // ─── C) Handle spheres + linee tratteggiate per CP aligned ─
                // Pattern Blender: gli handle si mostrano SEMPRE quando il CP
                // è di tipo bezier (aligned), anche se non selezionato. La
                // selezione cambia il colore/scala ma non la VISIBILITÀ.
                const isAligned = sp.handleTypes && sp.handleTypes[cpIdx] === 'aligned';
                if (isAligned) {
                    const handleGeo = new THREE.SphereGeometry(_HANDLE_RADIUS_MM, 10, 10);
                    for (const side of ['left', 'right']) {
                        const h = side === 'left'
                            ? sp.handlesLeft[cpIdx]
                            : sp.handlesRight[cpIdx];
                        if (!h) continue;
                        const hWp = h.clone().applyMatrix4(matWorld);
                        const hMat = new THREE.MeshBasicMaterial({
                            color: _HANDLE_COLOR,
                            depthTest: false,
                            transparent: true,
                            opacity: 0.95
                        });
                        const hSphere = new THREE.Mesh(handleGeo, hMat);
                        hSphere.position.copy(hWp);
                        hSphere.renderOrder = 1000;
                        overlayGroup.add(hSphere);
                        this._handlePointMeshes.push({
                            mesh: hSphere, splineIdx: i, cpIdx, side
                        });
                        // Linea tratteggiata CP ↔ handle (THREE.Line standard
                        // con LineDashedMaterial: niente Line2/LineMaterial per
                        // semplicità — i tratteggi su Line2 richiedono
                        // computeLineDistances + uniforms più complessi).
                        const lineGeo = new THREE.BufferGeometry();
                        lineGeo.setAttribute('position', new THREE.BufferAttribute(
                            new Float32Array([wp.x, wp.y, wp.z, hWp.x, hWp.y, hWp.z]), 3));
                        const lineMat = new THREE.LineDashedMaterial({
                            color: _HANDLE_LINE_COLOR,
                            linewidth: _HANDLE_LINE_WIDTH_PX,
                            dashSize: _HANDLE_DASH_MM,
                            gapSize:  _HANDLE_GAP_MM,
                            transparent: true,
                            opacity: 0.85,
                            depthTest: false
                        });
                        const line = new THREE.Line(lineGeo, lineMat);
                        line.computeLineDistances();
                        line.renderOrder = 999;
                        overlayGroup.add(line);
                        this._handleLineSegments.push(line);
                    }
                }
            }
        }
        scene.add(overlayGroup);
        this._overlayGroup = overlayGroup;
        this.ibex.sceneMgr.render?.();
    }

    _setCpVisual(mesh, state) {
        if (!mesh || !mesh.material) return;
        switch (state) {
            case 'hover':
                mesh.material.color.setHex(_CTRL_POINT_COLOR_HOVER);
                mesh.scale.setScalar(_CTRL_POINT_RADIUS_MM_HOVER / _CTRL_POINT_RADIUS_MM);
                break;
            case 'drag':
                mesh.material.color.setHex(_CTRL_POINT_COLOR_DRAG);
                mesh.scale.setScalar(_CTRL_POINT_RADIUS_MM_HOVER / _CTRL_POINT_RADIUS_MM);
                break;
            case 'selected':
                // V2.0 stato permanente per CP nella multi-selezione tap-based
                mesh.material.color.setHex(_CTRL_POINT_COLOR_SELECTED);
                mesh.scale.setScalar(_CTRL_POINT_RADIUS_MM_HOVER / _CTRL_POINT_RADIUS_MM);
                break;
            case 'normal':
            default: {
                // restore default colour based on active spline
                const ref = this._ctrlPointMeshes.find(c => c.mesh === mesh);
                if (ref) {
                    const isActive = (ref.splineIdx === this.activeSplineIdx);
                    mesh.material.color.setHex(
                        isActive ? _CTRL_POINT_COLOR
                                 : _SPLINE_COLORS[ref.splineIdx % _SPLINE_COLORS.length]);
                }
                mesh.scale.setScalar(1.0);
                break;
            }
        }
        this.ibex.sceneMgr.render?.();
    }

    _clearVisualization() {
        const scene = this.ibex.sceneMgr?.scene;
        if (this._overlayGroup && scene) {
            scene.remove(this._overlayGroup);
            this._overlayGroup.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
        }
        this._overlayGroup = null;
        this._splineLines = [];
        this._ctrlPointMeshes = [];
        // Fase 2: pulisci anche handle meshes / linee tratteggiate
        this._handlePointMeshes = [];
        this._handleLineSegments = [];
        // Fase 3: ringMesh è figlio di _overlayGroup → già disposto sopra; clear ref
        this._proportionalRingMesh = null;
    }

    _dispatchCountChanged() {
        try {
            const sp = this.splines[this.activeSplineIdx];
            // Fase 2: conta quanti dei CP SELEZIONATI sono di tipo aligned
            // (per stato bottoni "Smooth" / "Spigoli vivi" inspector).
            let nSelAligned = 0;
            for (const key of this.selectedCps) {
                const [si, ci] = key.split(':').map(Number);
                const s = this.splines[si];
                if (s && s.handleTypes && s.handleTypes[ci] === 'aligned') {
                    nSelAligned++;
                }
            }
            window.dispatchEvent(new CustomEvent('ibex:curve-edit-changed', {
                detail: {
                    n_splines:        this.splines.length,
                    active_idx:       this.activeSplineIdx,
                    active_pts:       sp ? sp.controlPoints.length : 0,
                    active_cyclic:    sp ? sp.cyclic : false,
                    total_pts:        this.splines.reduce((a,s) => a + s.controlPoints.length, 0),
                    n_selected:       this.selectedCps.size,
                    n_selected_aligned: nSelAligned,
                    // Fase 3 V2.4
                    proportional_edit:   !!this.proportionalEdit,
                    proportional_radius: Number(this.proportionalRadius) || _PROP_RADIUS_DEFAULT
                }
            }));
        } catch (e) { /* non-critical */ }
    }

    /**
     * Reset curva: cancella gli edits utente e ri-sincronizza con la curva
     * calcolata da arch_detect upstream. Sovrascrive `_snap_X.crv.json` con
     * un payload con `metadata.user_edited = false` → worker al prossimo bake
     * vede il flag false → ricopia upstream (arch_detect output) cancellando.
     *
     * Returns: Promise<boolean> true se reset salvato, false su errore.
     */
    async resetCurve(nodeId) {
        if (this.active) this.exit({ save: false });
        if (!nodeId) return false;
        const stackMgr = this.ibex.stackMgr;
        const editor = stackMgr?.editor;
        if (!editor) return false;

        // Risolvi targetMesh via IN_GEO_Mesh upstream
        const graph = stackMgr.extractDAG();
        const inMeshEdge = graph.edges.find(e =>
            String(e.to_node) === String(nodeId) && e.role === 'IN_GEO_Mesh'
        );
        if (!inMeshEdge) {
            this.ibex.uiMgr?.notify?.('Mesh non collegata al nodo Modifica Curva', 'warning');
            return false;
        }
        const targetName = stackMgr.resolveBaseMesh(inMeshEdge.from_mesh, inMeshEdge.from_port);
        const mesh = this.ibex.sceneMgr.group.children.find(c => c.isMesh && c.name === targetName);
        if (!mesh) {
            this.ibex.uiMgr?.notify?.(`Mesh ${targetName} non trovata in scena`, 'error');
            return false;
        }

        // Salva un payload con user_edited=false. splines vuoto OK (verrà
        // ri-popolato da upstream copy al prossimo bake).
        try {
            const res = await this.ibex.snapshotPersist.saveCurve(
                mesh, nodeId, [], { userEdited: false }
            );
            if (res?.ok) {
                console.log(`[CURVE-EDIT] RESET node=${nodeId} target=${targetName} OK`);
                return true;
            }
            this.ibex.uiMgr?.notify?.(`Reset curva fallito: ${res?.error || 'errore sconosciuto'}`, 'error');
            return false;
        } catch (e) {
            this.ibex.uiMgr?.notify?.(`Reset curva eccezione: ${e.message || e}`, 'error');
            return false;
        }
    }
}
