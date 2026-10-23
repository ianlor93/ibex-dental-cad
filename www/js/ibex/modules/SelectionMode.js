import * as THREE from 'three';
// T1Resolve_29-7 — `_resolveTargetMesh` collassato nell'util condiviso (era ×2, byte-identico a SculptMode).
import { resolveTargetMesh } from './mesh-resolve.js?v=T1Resolve_29-7';

// ═══════════════════════════════════════════════════════════════
// IBEX SelectionMode DagSync_V1.4 — toggle "Attraverso" (xray) + front-facing
//
// V1.4 (2026-04-25): nuovo flag `_xray` (default false = "solo superficie")
//   con toggle UI nell'inspector. Cambia comportamento di tutte e 3 le
//   modalità (circle / box / lasso):
//     - `_xray = false` (default): filtro front-facing — `dot(face.normal,
//       camera_to_face) < 0`. Solo facce rivolte verso la camera.
//     - `_xray = true`:  nessun filtro, comportamento V1.3 (passa attraverso
//       la mesh, prende anche back-face e occluse).
//   Il filtro front-facing è O(1) per face (1 cross product + 1 dot product
//   in world space). Costo trascurabile vs scan O(N_face) o
//   O(N_face × N_lazo) già esistente. Toggle persiste tra exit/enter.
//   Helper `_faceFrontFacing(a, b, c, posAttr, worldMat, camPos)` module
//   level — riusabile da circle/box/lasso.
//
// V1.3 (2026-04-25): 3 selection modes accumulativi + modifier keys.
//   `_selMode ∈ {'circle','box','lasso'}` — UI buttons in ContextInspector.
//   La selezione `Set<faceIndex>` resta unica: tutte le modalità si
//   accumulano sulla stessa selezione. Modifier keys override del
//   `brush.mode` UI per quel singolo evento:
//     - Shift premuto → mode='add' (override)
//     - Ctrl/Cmd premuto → mode='remove' (override)
//     - Default → brush.mode UI ('add' o 'remove' come selezionato)
//
//   X-RAY default ON per tutte e 3 le modalità: la selezione include
//   facce frontali e retrostanti senza distinzione (no depth filter).
//
//   Modalità:
//     - circle (default): brush sfera 3D via boundsTree.shapecast,
//       cursor 3D ring rosso, drag continuo aggiorna selezione.
//     - box: rettangolo 2D screen-space, scan O(N_face) centroide
//       proiettato in NDC, applicato al mouseup. Overlay DOM `<div>`
//       con border arancione + bg traslucido durante drag.
//     - lasso: poligono 2D arbitrario screen-space, scan O(N_face ×
//       N_lazo) point-in-polygon al mouseup. Overlay DOM `<svg>` con
//       polyline. Throttling distanza min 4px tra punti (riduce 300+
//       sample → ~50, costo polygon-in ~50ms su 100k face).
//
//   Bug fix: `_onMouseDown` non fa più early-return su `!hit`. Setta
//   `dragging=true` sempre. Senza, il primo click fuori mesh
//   bloccava lo stroke anche entrando successivamente sulla mesh.
//
// V1.2 (2026-04-25, post-deploy fix):
//   - `applySplit` al success del `saveSplit`, carica ESPLICITAMENTE le 2
//     mesh derivate `_snap_{nodeId}_A/B.stl` via `loader.load` + `sceneMgr
//     .addMesh`. Senza questo, se nessun nodo downstream è collegato ai
//     port A/B, la queue del bake non contiene i target → hotSwapMeshes
//     non li carica → l'utente non vede le mesh nonostante il worker le
//     abbia prodotte. Dopo il load, triggera updateSplitMasterVisibility
//     (auto-hide master) + outliner.update + syncAndBake.
//
// V1.1 (2026-04-25, SnapshotKeyed Session 3):
//   - `enter(nodeId, toolType)` accetta toolType ∈ {'delete','split'}
//     (default 'delete' per backward compat).
//   - Nuovo `applySplit()`: selezione → branch A, complemento → branch B.
//     Costruisce 2 BufferGeometry con position SHARED + index distinto,
//     entrambe computeVertexNormals + computeBoundsTree. Chiama
//     `snapshotPersist.saveSplit(mesh, nodeId, geomA, geomB)` fire-and-forget.
//     Al success BakeEngine caricherà le 2 mesh nella scena (vedi BakeEngine
//     S3 — `hotSwapMeshes` extended con add-if-missing + loader.load).
//   - ContextInspector render bottone verde "Separa selezione" invece di
//     "Elimina selezione" quando `toolType === 'split'`.
//
// V1.0 (2026-04-24) — SnapshotKeyed Session 2: modalità interattiva per il nodo
// `delete_topology`. Pattern mutuato da SculptMode V5.9 BVH:
//   - raycast BVH firstHitOnly (O(log n))
//   - shapecast sphere vs bounds+triangle per raccolta facce nel brush
//   - cursor ring 3D orientato alla normale di superficie hit
//   - OrbitControls reconfigure: LEFT=brush, MIDDLE=rotate, RIGHT=pan
//   - NO auto-save on exit: il delete è esplicito via applyDelete()
//
// State management:
//   - this._selection: Set<faceIndex>  (ephemeral, reset ad ogni enter — S2-A10)
//   - this.brush = { radius, mode: 'add'|'remove' }
//   - highlight overlay: THREE.Mesh rosso trasparente con subset triangoli selezionati
//     attaccato come child della targetMesh (S2-A1 opzione a: eredita matrixWorld)
//
// Flow delete:
//   1. enter(nodeId) → resolve target, init cursor + highlight overlay vuoto
//   2. user trascina → shapecast raccoglie faceIndex → aggiunge/rimuove da Set
//      → rebuild highlight overlay (index filtrato)
//   3. ContextInspector mostra contatore "N facce selezionate" + bottone "Elimina"
//   4. applyDelete() → nuova index attribute escludendo faces selezionate →
//      computeVertexNormals + computeBoundsTree (rebuild, non refit — topology changed) +
//      reset userData.vertNeighbors cache (hotSwap pattern) +
//      snapshotPersist.save(mesh, nodeId, 'delete_topology') +
//      updateSculptNodeMeta(...) → exit()
//
// API pubblica (preservata stile SculptMode):
//   enter(nodeId), exit(), setBrush(partial),
//   applyDelete(),
//   active, targetNodeId, targetMesh, brush, selection, dragging
// ═══════════════════════════════════════════════════════════════

const DEFAULT_BRUSH = Object.freeze({
    radius: 2.0,   // mm (local space). Range UI 0.3-15.
    mode:   'add'  // 'add' | 'remove'
});

export class SelectionMode {
    constructor(ibex) {
        this.ibex = ibex;
        this.active = false;
        this.targetNodeId = null;
        this.targetMesh = null;
        this.toolType = 'delete';   // 'delete' | 'split' (S3)
        this.brush = { ...DEFAULT_BRUSH };

        this.selection = new Set();  // faceIndex selezionate
        this.dragging = false;

        // V1.3 — modalità di selezione (accumulative). UI in ContextInspector.
        this._selMode = 'circle';   // 'circle' | 'box' | 'lasso'
        this._shapeOrigin = null;   // {x,y} canvas-local — origine box/lazo
        this._shapePoints = [];     // [{x,y}] canvas-local — vertici lazo
        this._shapeOverlay = null;  // DOM container z:56, lazy init
        this._shapeBoxEl = null;    // <div> rettangolo box
        this._shapeLassoSvg = null; // <svg> per polyline lazo
        this._shapeLassoPoly = null; // <polyline>

        // V1.4 — toggle "Attraverso" (X-ray). Default false = solo superficie
        // (front-facing test). Persiste tra exit/enter (preferenza workflow).
        this._xray = false;

        this._initCursor();
        this._initHighlight();

        this._raycaster = new THREE.Raycaster();
        this._raycaster.firstHitOnly = true;  // acceleratedRaycast early-exit
        this._mouse = new THREE.Vector2();

        this._tmpVec    = new THREE.Vector3();
        this._tmpCenter = new THREE.Vector3();
        this._tmpMat    = new THREE.Matrix4();
        this._faceSet   = new Set();  // riuso scratch per _applyBrush

        this._prevMouseButtons = null;
        this._prevTouches = null;

        this._boundDown  = this._onMouseDown.bind(this);
        this._boundMove  = this._onMouseMove.bind(this);
        this._boundUp    = this._onMouseUp.bind(this);
        this._boundLeave = this._onMouseLeave.bind(this);
    }

    // ─────────────────────────────────────────────────────────────
    // V1.3 — Modalità selezione (UI button row)
    // ─────────────────────────────────────────────────────────────
    setSelMode(mode) {
        if (!['circle', 'box', 'lasso'].includes(mode)) return;
        this._selMode = mode;
        // Cursor 3D ring solo per circle. Box/lasso → CSS crosshair.
        if (this.cursorMesh) this.cursorMesh.visible = (mode === 'circle');
        const canvas = this.ibex.sceneMgr?.renderer?.domElement;
        if (canvas) {
            canvas.style.cursor = (mode === 'circle') ? 'none' : 'crosshair';
        }
        // Eventuale overlay attivo da modalità precedente — nascondi.
        this._hideShapeOverlay();
        if (this.ibex.sceneMgr?.render) this.ibex.sceneMgr.render();
    }

    // V1.4 — toggle "Attraverso" (X-ray). Default false = solo superficie
    // (front-facing). True = passa attraverso la mesh (back-face + occluse).
    // Persistente tra exit/enter come preferenza workflow.
    setXRay(on) {
        this._xray = !!on;
    }

    // ─────────────────────────────────────────────────────────────
    // Entry / Exit
    // ─────────────────────────────────────────────────────────────

    enter(nodeId, toolType = 'delete') {
        if (this.active) {
            console.warn('[SELECTION] già attivo — exit prima di re-entrare');
            return;
        }
        const mesh = this._resolveTargetMesh(nodeId);
        if (!mesh) {
            const label = toolType === 'split' ? 'Separa Topologia' : 'Cancella Topologia';
            alert(`Collega prima una mesh al socket IN_GEO_Mesh del nodo ${label}`);
            return;
        }
        if (!mesh.geometry.boundsTree) {
            if (typeof mesh.geometry.computeBoundsTree === 'function') {
                mesh.geometry.computeBoundsTree();
            } else {
                alert('three-mesh-bvh non disponibile — reload pagina');
                return;
            }
        }

        this.active = true;
        this.targetNodeId = nodeId;
        this.targetMesh = mesh;
        this.toolType = (toolType === 'split') ? 'split' : 'delete';
        // S2-A10: selezione ephemeral — reset ad ogni enter.
        this.selection = new Set();

        // Reconfigure OrbitControls (stesso pattern SculptMode)
        const ctrl = this.ibex.sceneMgr?.controls;
        if (ctrl) {
            this._prevMouseButtons = { ...(ctrl.mouseButtons || {}) };
            ctrl.mouseButtons = {
                LEFT:   null,
                MIDDLE: THREE.MOUSE.ROTATE,
                RIGHT:  THREE.MOUSE.PAN
            };
            // Pezzo 2b: libera 1-dito/pen per la selezione; 2-dita = pan/zoom.
            this._prevTouches = { ...(ctrl.touches || {}) };
            ctrl.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_PAN };
        }

        // Highlight overlay come CHILD di targetMesh — eredita matrixWorld del
        // parent (S2-A1 opzione a). Three.js propaga updateMatrixWorld(true)
        // anche con matrixAutoUpdate=false sul parent.
        mesh.add(this.highlightMesh);
        this.highlightMesh.visible = false;
        this._rebuildHighlightGeometry();

        mesh.add(this.cursorMesh);
        this.cursorMesh.visible = false;

        const canvas = this.ibex.sceneMgr.renderer.domElement;
        canvas.addEventListener('pointerdown',   this._boundDown);
        canvas.addEventListener('pointermove',   this._boundMove);
        canvas.addEventListener('pointerup',     this._boundUp);
        canvas.addEventListener('pointercancel', this._boundLeave);
        // V1.3 — cursor CSS coerente con _selMode preservato tra exit/enter.
        canvas.style.cursor = (this._selMode === 'circle') ? 'none' : 'crosshair';

        if (this.ibex.contextInspector) this.ibex.contextInspector.refresh();
        if (this.ibex.sceneMgr?.deselectMesh) this.ibex.sceneMgr.deselectMesh();

        this.ibex.sceneMgr.render();
        console.log(`[SELECTION] ENTER node ${nodeId} target=${mesh.name} tool=${this.toolType} brush=${this.brush.mode} r=${this.brush.radius}`);
    }

    exit() {
        if (!this.active) return;
        this.dragging = false;

        const ctrl = this.ibex.sceneMgr?.controls;
        if (ctrl && this._prevMouseButtons) {
            ctrl.mouseButtons = this._prevMouseButtons;
            this._prevMouseButtons = null;
        }
        if (ctrl && this._prevTouches) {
            ctrl.touches = this._prevTouches;
            this._prevTouches = null;
        }
        if (this.cursorMesh?.parent) this.cursorMesh.parent.remove(this.cursorMesh);
        if (this.highlightMesh?.parent) this.highlightMesh.parent.remove(this.highlightMesh);

        // V1.3 — cleanup overlay 2D + cursor CSS al exit (autoexit applyDelete
        // o exit manuale). Senza questo, dopo applyDelete in box/lasso mode
        // il cursore restava 'crosshair' finché next enter.
        this._hideShapeOverlay();
        this._shapeOrigin = null;
        this._shapePoints = [];

        const canvas = this.ibex.sceneMgr?.renderer?.domElement;
        if (canvas) {
            canvas.removeEventListener('pointerdown',   this._boundDown);
            canvas.removeEventListener('pointermove',   this._boundMove);
            canvas.removeEventListener('pointerup',     this._boundUp);
            canvas.removeEventListener('pointercancel', this._boundLeave);
            canvas.style.cursor = '';  // ripristina cursor default
        }

        console.log(`[SELECTION] EXIT node ${this.targetNodeId} (selection.size=${this.selection.size})`);

        this.active = false;
        this.targetNodeId = null;
        this.targetMesh = null;
        this.selection = new Set();  // discard ephemeral selection

        if (this.ibex.contextInspector) this.ibex.contextInspector.refresh();
        this.ibex.sceneMgr?.render();
    }

    setBrush(partial) {
        Object.assign(this.brush, partial || {});
        this._updateCursorScale();
        if (this.ibex.sceneMgr) this.ibex.sceneMgr.render();
    }

    // ─────────────────────────────────────────────────────────────
    // applyDelete — rimuove le facce selezionate e salva snapshot
    //
    // Flow:
    //   1. costruisce new index Uint32Array escludendo 3*N elementi per ogni
    //      faccia in this.selection
    //   2. geometry.setIndex(newIndex)
    //   3. computeVertexNormals (per STLExporter flat shading)
    //   4. computeBoundsTree REBUILD (non refit — topology changed, S2-A2)
    //   5. reset userData.vertNeighbors/N/Geom (sculpt adjacency cache)
    //   6. snapshotPersist.save(mesh, nodeId, 'delete_topology') fire-and-forget
    //   7. updateSculptNodeMeta con faces_deleted + vertex_count
    //   8. exit()
    // ─────────────────────────────────────────────────────────────
    async applyDelete() {
        if (!this.active || !this.targetMesh) return;
        if (this.selection.size === 0) {
            this.ibex.uiMgr?.notify?.('Nessuna zona selezionata.', 'warning');
            return;
        }

        const mesh = this.targetMesh;
        const nodeId = this.targetNodeId;
        const geom = mesh.geometry;
        const oldIndex = geom.index;
        if (!oldIndex) {
            this.ibex.uiMgr?.notify?.('Mesh senza index attribute — delete non supportato.', 'error');
            return;
        }

        const deletedFaces = this.selection.size;
        const oldFaceCount = oldIndex.count / 3;
        const newFaceCount = oldFaceCount - deletedFaces;

        // Costruisce new index filtrando faceIndex in this.selection.
        // Usa Uint32Array per supportare mesh con >65k verts (comune su scanner dentale).
        const newIndexArr = new Uint32Array(newFaceCount * 3);
        let w = 0;
        const oldArr = oldIndex.array;
        for (let f = 0; f < oldFaceCount; f++) {
            if (this.selection.has(f)) continue;
            const off = f * 3;
            newIndexArr[w++] = oldArr[off];
            newIndexArr[w++] = oldArr[off + 1];
            newIndexArr[w++] = oldArr[off + 2];
        }
        geom.setIndex(new THREE.BufferAttribute(newIndexArr, 1));

        // Ricompute normals per STL export
        geom.computeVertexNormals();

        // BVH rebuild (non refit — topology changed, S2-A2)
        if (typeof geom.computeBoundsTree === 'function') {
            geom.computeBoundsTree();
        }

        // Invalida cache adjacency SculptMode (geometry reference invariato ma
        // topology cambiata: stesso pattern di BakeEngine.hotSwapMeshes post-meshcleaner).
        mesh.userData.vertNeighbors     = null;
        mesh.userData.vertNeighborsN    = -1;
        mesh.userData.vertNeighborsGeom = null;

        console.log(`[SELECTION] applyDelete: ${deletedFaces} facce rimosse (${oldFaceCount} → ${newFaceCount})`);

        this.ibex.uiMgr?.notify?.(`${deletedFaces} facce eliminate…`, 'info');

        // Persistenza fire-and-forget via SnapshotPersist (identica pattern SculptMode)
        if (this.ibex.snapshotPersist) {
            this.ibex.snapshotPersist.save(mesh, nodeId, 'delete_topology')
                .then(res => {
                    if (res.ok) {
                        const vc = geom.attributes.position.count;
                        this.ibex.uiMgr?.notify?.(
                            `Cancella Topologia: ${deletedFaces} facce eliminate (${(res.size / 1024).toFixed(0)} KB)`,
                            'success');
                        this.ibex.stackMgr?.updateSculptNodeMeta?.(nodeId, {
                            sculpted:       true,
                            mesh_name:      res.mesh_name || mesh.name,
                            vertex_count:   vc,
                            faces_deleted:  deletedFaces,
                            last_modified:  Math.floor(Date.now() / 1000)
                        });
                    } else {
                        this.ibex.uiMgr?.notify?.(
                            `Errore salvataggio snapshot: ${res.error || 'unknown'}`, 'error');
                        console.warn('[SELECTION] save failed:', res);
                    }
                })
                .catch(e => {
                    this.ibex.uiMgr?.notify?.(
                        `Errore salvataggio snapshot: ${e.message || e}`, 'error');
                    console.error('[SELECTION] save exception:', e);
                });
        }

        // Exit automaticamente — il delete è definitivo (niente undo in-mode)
        this.exit();
    }

    // ─────────────────────────────────────────────────────────────
    // applyRebuild (topology_rebuild V1.0, 2026-05-05) — invia mesh + selection
    // al worker che esegue auto-detect close_hole/bridge bmesh in-process.
    //
    // Diversamente da applyDelete (mesh modificata client-side via setIndex)
    // e applySplit (geometry A+B costruite client-side con position SHARED),
    // applyRebuild NON modifica la mesh client-side. La mesh corrente è
    // serializzata as-is (snapshot post-Tier 1 upstream) e affiancata al file
    // `.sel.json` con i face indices selezionati. Il worker carica entrambi
    // e produce la mesh ricostruita; al success, il prossimo bake (auto via
    // syncAndBake) carica il risultato dal disco e fa hot-swap della mesh.
    //
    // Nessun preview client-side della rebuild (sarebbe complesso replicare
    // bmesh in JS). Il delay tra "Ricostruisci" e visualizzazione = ~1-3s
    // (worker bmesh è veloce su selezioni piccole).
    // ─────────────────────────────────────────────────────────────
    async applyRebuild() {
        if (!this.active || !this.targetMesh) return;
        if (this.selection.size === 0) {
            this.ibex.uiMgr?.notify?.('Nessuna zona selezionata.', 'warning');
            return;
        }

        const mesh = this.targetMesh;
        const nodeId = this.targetNodeId;
        const faceIndices = Array.from(this.selection);
        const nFaces = faceIndices.length;

        this.ibex.uiMgr?.notify?.(`Ricostruzione topologia su ${nFaces} facce…`, 'info');

        if (this.ibex.snapshotPersist?.saveWithSelection) {
            this.ibex.snapshotPersist.saveWithSelection(mesh, nodeId, 'topology_rebuild', faceIndices)
                .then(res => {
                    if (res.ok) {
                        const vc = mesh.geometry.attributes.position.count;
                        this.ibex.uiMgr?.notify?.(
                            `Ricostruisci Topologia: salvata selezione di ${nFaces} facce (${(res.size / 1024).toFixed(0)} KB)`,
                            'success');
                        this.ibex.stackMgr?.updateSculptNodeMeta?.(nodeId, {
                            sculpted:        true,
                            mesh_name:       res.mesh_name || mesh.name,
                            vertex_count:    vc,
                            n_faces_selected: nFaces,
                            last_modified:   Math.floor(Date.now() / 1000)
                        });
                        // Force bake: il worker `_apply_topology_rebuild` ha
                        // bisogno di girare per produrre la mesh ricostruita.
                        // Il `setSnapshotSavePending(false)` (finally di
                        // saveWithSelection) rilancia un requestBake() ma
                        // hasChanges è false (params del nodo invariati,
                        // _snapshot_node_id escluso da filterUI). Senza force,
                        // il bake è skippato → la mesh in scena resta originale.
                        // force:true invalida _lastBakedParams → hasChanges true
                        // → POST → bake → hot-swap della mesh ricostruita.
                        this.ibex.stackMgr?.bakeEngine?.requestBake?.({ force: true });
                    } else {
                        this.ibex.uiMgr?.notify?.(
                            `Errore salvataggio ricostruzione: ${res.error || 'unknown'}`, 'error');
                        console.warn('[SELECTION] saveWithSelection failed:', res);
                    }
                })
                .catch(e => {
                    this.ibex.uiMgr?.notify?.(
                        `Errore salvataggio ricostruzione: ${e.message || e}`, 'error');
                    console.error('[SELECTION] saveWithSelection exception:', e);
                });
        }

        // Exit automatico (la rebuild è asincrona; l'utente vede il risultato
        // dopo che il bake successivo completa).
        this.exit();
    }

    // ─────────────────────────────────────────────────────────────
    // applySplit (SnapshotKeyed S3, 2026-04-25) — separa la mesh in A+B
    //
    // Flow:
    //   1. Selezione corrente → branch A (facce selezionate)
    //      Complemento        → branch B (facce non selezionate)
    //   2. Costruisce 2 BufferGeometry con position SHARED (stesso buffer del
    //      master — zero-alloc verts) e index distinto per ognuno.
    //   3. computeVertexNormals + computeBoundsTree su entrambe (per sculpt
    //      downstream).
    //   4. `snapshotPersist.saveSplit(mesh, nodeId, geomA, geomB)` fire-and-forget.
    //      Il worker scrive 2 file `_snap_{nodeId}_A.stl` e `_B.stl`, applica
    //      trimesh.remove_unreferenced_vertices (rimuove i verts orfani del
    //      position SHARED che nel branch A non sono referenziati, e viceversa).
    //   5. Al success, `stackMgr.updateSculptNodeMeta(nodeId, {sculpted, ...})`
    //      + triggera syncAndBake per caricare le 2 nuove mesh nella scena
    //      (via BakeEngine.hotSwapMeshes add-if-missing S3).
    //   6. Auto-exit.
    //
    // Nota: NON modifichiamo la geometry della mesh master lato client. Il
    // master resta intatto; il frontend aggiunge 2 mesh nuove alla scena
    // quando detectate via SceneManager.updateSplitMasterVisibility o loader.
    // ─────────────────────────────────────────────────────────────
    async applySplit() {
        if (!this.active || !this.targetMesh) return;
        if (this.selection.size === 0) {
            this.ibex.uiMgr?.notify?.('Nessuna zona selezionata.', 'warning');
            return;
        }

        const mesh = this.targetMesh;
        const nodeId = this.targetNodeId;
        const geom = mesh.geometry;
        const oldIndex = geom.index;
        if (!oldIndex) {
            this.ibex.uiMgr?.notify?.('Mesh senza index attribute — split non supportato.', 'error');
            return;
        }

        const oldFaceCount = oldIndex.count / 3;
        const sizeA = this.selection.size;
        const sizeB = oldFaceCount - sizeA;

        if (sizeA === 0 || sizeB === 0) {
            this.ibex.uiMgr?.notify?.(
                `Split inutile: branch ${sizeA === 0 ? 'A' : 'B'} vuoto. Seleziona almeno una faccia e ne lascia almeno una.`,
                'warning');
            return;
        }

        // Costruisci 2 index Uint32Array distinti a partire dall'oldIndex.
        // `IndexA` = facce selezionate, `IndexB` = complemento.
        const indexA = new Uint32Array(sizeA * 3);
        const indexB = new Uint32Array(sizeB * 3);
        const oldArr = oldIndex.array;
        let wa = 0, wb = 0;
        for (let f = 0; f < oldFaceCount; f++) {
            const off = f * 3;
            if (this.selection.has(f)) {
                indexA[wa++] = oldArr[off];
                indexA[wa++] = oldArr[off + 1];
                indexA[wa++] = oldArr[off + 2];
            } else {
                indexB[wb++] = oldArr[off];
                indexB[wb++] = oldArr[off + 1];
                indexB[wb++] = oldArr[off + 2];
            }
        }

        // Costruisci 2 BufferGeometry con position SHARED dal master + index distinto.
        // Il worker farà remove_unreferenced_vertices post-save per pulire gli orfani.
        const buildBranchGeom = (idxArr) => {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', geom.attributes.position);  // shared ref
            if (geom.attributes.normal) g.setAttribute('normal', geom.attributes.normal);
            g.setIndex(new THREE.BufferAttribute(idxArr, 1));
            g.computeVertexNormals();
            g.computeBoundingBox();
            g.computeBoundingSphere();
            if (typeof g.computeBoundsTree === 'function') g.computeBoundsTree();
            return g;
        };
        const geomA = buildBranchGeom(indexA);
        const geomB = buildBranchGeom(indexB);

        console.log(`[SELECTION] applySplit: ${sizeA} facce in A, ${sizeB} facce in B (tot ${oldFaceCount})`);
        this.ibex.uiMgr?.notify?.(`Separazione ${sizeA}/${sizeB} facce…`, 'info');

        if (!this.ibex.snapshotPersist) {
            this.ibex.uiMgr?.notify?.('snapshotPersist non disponibile', 'error');
            this.exit();
            return;
        }

        this.ibex.snapshotPersist.saveSplit(mesh, nodeId, geomA, geomB)
            .then(async res => {
                if (res.ok) {
                    const bA = res.branches?.find(b => b.branch === 'A');
                    const bB = res.branches?.find(b => b.branch === 'B');
                    const sizeKB = ((bA?.size || 0) + (bB?.size || 0)) / 1024;
                    this.ibex.uiMgr?.notify?.(
                        `Separa Topologia: A=${bA?.mesh_name || '?'} · B=${bB?.mesh_name || '?'} (${sizeKB.toFixed(0)} KB)`,
                        'success');
                    this.ibex.stackMgr?.updateSculptNodeMeta?.(nodeId, {
                        sculpted:       true,
                        mesh_name:      mesh.name,
                        faces_a:        sizeA,
                        faces_b:        sizeB,
                        last_modified:  Math.floor(Date.now() / 1000)
                    });

                    // S3 fix (2026-04-25 post-deploy): carica esplicitamente
                    // le 2 mesh derivate nella scena. Senza questo step, se il
                    // nodo split NON ha downstream collegati ai port A/B, la
                    // queue del bake non contiene i target _snap_X_A/B.stl →
                    // hotSwapMeshes non li carica → l'utente non vede le mesh
                    // nonostante il worker le abbia prodotte. Carichiamo subito
                    // dai nomi nella response del SAVE_SPLIT.
                    for (const b of (res.branches || [])) {
                        if (!b.mesh_name) continue;
                        if (this.ibex.executor?.findTargetMesh?.(b.mesh_name)) continue;
                        try {
                            const freshMesh = await this.ibex.loader.load({
                                path: b.mesh_name, bustCache: true
                            });
                            this.ibex.sceneMgr.addMesh(freshMesh);
                            console.log(`[SELECTION] split: aggiunta mesh ${b.mesh_name} alla scena`);
                        } catch (e) {
                            console.warn(`[SELECTION] split: load ${b.mesh_name} fallito:`, e);
                        }
                    }

                    // Auto-hide master se split attivo (vedi SceneManager S3).
                    if (this.ibex.sceneMgr?.updateSplitMasterVisibility && this.ibex.stackMgr?.graph) {
                        this.ibex.sceneMgr.updateSplitMasterVisibility(this.ibex.stackMgr.graph);
                    }

                    // Update outliner con le nuove mesh.
                    if (this.ibex.outlinerMgr) this.ibex.outlinerMgr.update();

                    // Triggera syncAndBake per aggiornare eventuali pipeline
                    // downstream (se l'utente ha collegato A/B prima dell'applySplit).
                    this.ibex.stackMgr?.syncAndBake?.();
                } else {
                    this.ibex.uiMgr?.notify?.(
                        `Errore salvataggio split: ${res.error || 'unknown'}`, 'error');
                    console.warn('[SELECTION] saveSplit failed:', res);
                }
            })
            .catch(e => {
                this.ibex.uiMgr?.notify?.(
                    `Errore salvataggio split: ${e.message || e}`, 'error');
                console.error('[SELECTION] saveSplit exception:', e);
            });

        // Auto-exit immediato (il salvataggio è fire-and-forget).
        this.exit();
    }

    // ─────────────────────────────────────────────────────────────
    // Mouse handlers
    // ─────────────────────────────────────────────────────────────

    _onMouseDown(e) {
        if (!this.active) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;  // pen/touch: button 0/-1, non filtrare
        e.preventDefault();
        try { this.ibex.sceneMgr.renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
        // V1.3 — dragging=true SEMPRE (no early-return su !hit). Bug fix:
        // pre-V1.3 il primo click fuori dalla mesh bloccava lo stroke anche
        // quando l'utente entrava sulla mesh durante il drag.
        this.dragging = true;

        if (this._selMode === 'box' || this._selMode === 'lasso') {
            const canvas = this.ibex.sceneMgr.renderer.domElement;
            const rect = canvas.getBoundingClientRect();
            const lx = e.clientX - rect.left;
            const ly = e.clientY - rect.top;
            this._shapeOrigin = { x: lx, y: ly };
            this._shapePoints = [{ x: lx, y: ly }];
            this._showShapeOverlay();
            this._updateShapeOverlay();
            return;  // box/lasso operano al mouseup, no raycast immediato
        }

        // circle: raycast immediato + applica se hit valido
        const hit = this._raycast(e);
        if (hit) this._applyBrush(hit, e);
        this.ibex.sceneMgr.render();
    }

    _onMouseMove(e) {
        if (!this.active) return;

        // Box/Lasso durante drag: aggiornano solo l'overlay 2D.
        if (this.dragging && (this._selMode === 'box' || this._selMode === 'lasso')) {
            const canvas = this.ibex.sceneMgr.renderer.domElement;
            const rect = canvas.getBoundingClientRect();
            const lx = e.clientX - rect.left;
            const ly = e.clientY - rect.top;
            if (this._selMode === 'lasso') {
                // Throttle: distanza minima 4px tra punti consecutivi
                // (riduce 300+ sample → ~50 senza perdita visiva).
                const last = this._shapePoints[this._shapePoints.length - 1];
                if (!last || (lx - last.x) ** 2 + (ly - last.y) ** 2 >= 16) {
                    this._shapePoints.push({ x: lx, y: ly });
                }
            } else {
                // box: aggiorna SOLO il punto finale corrente
                this._shapePoints[1] = { x: lx, y: ly };
            }
            this._updateShapeOverlay();
            return;
        }

        // Circle: comportamento V1.2 (cursor 3D segue, applica brush durante drag).
        const hit = this._raycast(e);
        if (hit) {
            this.cursorMesh.visible = true;
            const invMat = this._tmpMat.copy(this.targetMesh.matrixWorld).invert();
            this.cursorMesh.position.copy(hit.point).applyMatrix4(invMat);
            const localNrm = this._tmpVec.copy(hit.face.normal).normalize();
            const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNrm);
            this.cursorMesh.quaternion.copy(q);
            if (this.dragging) this._applyBrush(hit, e);
        } else {
            this.cursorMesh.visible = false;
        }
        this.ibex.sceneMgr.render();
    }

    _onMouseUp(e) {
        if (!this.active || !this.dragging) return;

        // Box: applica selezione al rilascio.
        if (this._selMode === 'box') {
            const p1 = this._shapeOrigin;
            const p2 = this._shapePoints[1] || p1;
            if (p1 && p2) this._selectByBox(p1, p2, e);
            this._hideShapeOverlay();
        }
        // Lasso: applica selezione (skip silenzioso se < 3 punti — D1).
        else if (this._selMode === 'lasso') {
            if (this._shapePoints.length >= 3) {
                this._selectByLasso(this._shapePoints, e);
            }
            this._hideShapeOverlay();
        }

        this.dragging = false;
        this._shapeOrigin = null;
        this._shapePoints = [];
    }

    _onMouseLeave(_e) {
        this.cursorMesh.visible = false;
        this.dragging = false;
        // V1.3 — cleanup overlay box/lazo se mouse esce dal canvas durante drag.
        this._hideShapeOverlay();
        this._shapeOrigin = null;
        this._shapePoints = [];
        this.ibex.sceneMgr.render();
    }

    // ─────────────────────────────────────────────────────────────
    // Brush application: raccoglie facce nella sfera del brush, aggiorna
    // this.selection in base al mode ('add' | 'remove'), rebuild highlight.
    // ─────────────────────────────────────────────────────────────

    _raycast(evt) {
        if (!this.targetMesh) return null;
        const canvas = this.ibex.sceneMgr.renderer.domElement;
        const rect = canvas.getBoundingClientRect();
        this._mouse.x =  ((evt.clientX - rect.left) / rect.width)  * 2 - 1;
        this._mouse.y = -((evt.clientY - rect.top)  / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._mouse, this.ibex.sceneMgr.camera);
        const hits = this._raycaster.intersectObject(this.targetMesh, false);
        return hits[0] || null;
    }

    /**
     * V1.3 — risolve la mode effettiva tenendo conto dei modifier keys.
     *   Shift premuto      → 'add'    (override)
     *   Ctrl/Cmd premuto   → 'remove' (override)
     *   Default            → brush.mode UI
     * Shift trumpa Ctrl/Cmd se entrambi premuti.
     */
    _resolveMode(e) {
        if (e?.shiftKey) return 'add';
        if (e?.ctrlKey || e?.metaKey) return 'remove';
        return this.brush.mode;
    }

    _applyBrush(hit, evt) {
        const mesh = this.targetMesh;
        const geom = mesh.geometry;
        if (!geom.boundsTree) return;

        // Transform hit.point da world → local (BVH + indici operano in local)
        const matrixWorldInv = this._tmpMat.copy(mesh.matrixWorld).invert();
        const localCenter = this._tmpCenter.copy(hit.point).applyMatrix4(matrixWorldInv);

        const r = this.brush.radius;
        const mode = this._resolveMode(evt);

        // Raccogli faceIndex intersecati dalla sfera
        const faceSet = this._faceSet;
        faceSet.clear();
        geom.boundsTree.shapecast({
            intersectsBounds: (box) => _sphereBoxIntersect(localCenter, r, box),
            intersectsTriangle: (_tri, triIndex) => {
                faceSet.add(triIndex);
                return false;  // continue traversal
            }
        });

        if (faceSet.size === 0) return;

        // V1.4 — filtro front-facing se _xray=false (solo superficie).
        // Riusa la geometry del target per leggere a/b/c di ogni faccia.
        const xray = this._xray;
        const posAttr = geom.attributes.position;
        const idxArr  = geom.index.array;
        const camPos  = this.ibex.sceneMgr.camera.position;
        const worldMat = mesh.matrixWorld;

        // Applica mode (add | remove)
        let changed = false;
        if (mode === 'remove') {
            for (const fi of faceSet) {
                if (!xray) {
                    const o = fi * 3;
                    if (!_faceFrontFacing(idxArr[o], idxArr[o+1], idxArr[o+2],
                                          posAttr, worldMat, camPos)) continue;
                }
                if (this.selection.delete(fi)) changed = true;
            }
        } else {  // add
            for (const fi of faceSet) {
                if (!xray) {
                    const o = fi * 3;
                    if (!_faceFrontFacing(idxArr[o], idxArr[o+1], idxArr[o+2],
                                          posAttr, worldMat, camPos)) continue;
                }
                if (!this.selection.has(fi)) {
                    this.selection.add(fi);
                    changed = true;
                }
            }
        }

        if (changed) {
            this._rebuildHighlightGeometry();
            this._notifySelectionChange();
        }
    }

    // ─────────────────────────────────────────────────────────────
    // V1.3 — Selezione box (rettangolo screen-space)
    //
    // p1, p2 sono punti canvas-local (dom). Calcola il rettangolo NDC
    // normalizzato; per ogni faccia proietta il centroide in NDC e testa
    // se cade dentro il rect. X-RAY default: include tutto nel volume,
    // anche back-facing e occluso.
    // ─────────────────────────────────────────────────────────────
    _selectByBox(p1, p2, evt) {
        const mesh = this.targetMesh;
        const geom = mesh?.geometry;
        if (!geom || !geom.attributes.position || !geom.index) return;

        const canvas = this.ibex.sceneMgr.renderer.domElement;
        const cam    = this.ibex.sceneMgr.camera;
        const rect   = canvas.getBoundingClientRect();

        // NDC bounds del rettangolo (Y screen flip)
        const xMin = Math.min(p1.x, p2.x), xMax = Math.max(p1.x, p2.x);
        const yMin = Math.min(p1.y, p2.y), yMax = Math.max(p1.y, p2.y);
        const ndcXMin = (xMin / rect.width)  * 2 - 1;
        const ndcXMax = (xMax / rect.width)  * 2 - 1;
        const ndcYMax = -((yMin / rect.height) * 2 - 1);
        const ndcYMin = -((yMax / rect.height) * 2 - 1);

        const mode = this._resolveMode(evt);
        const posAttr = geom.attributes.position;
        const idxArr  = geom.index.array;
        const worldMat = mesh.matrixWorld;
        const tmpV = new THREE.Vector3();
        const nF = idxArr.length / 3;
        const xray = this._xray;
        const camPos = cam.position;

        let changed = 0;
        for (let f = 0; f < nF; f++) {
            const o = f * 3;
            const a = idxArr[o], b = idxArr[o + 1], c = idxArr[o + 2];
            // centroide in local
            const cx = (posAttr.getX(a) + posAttr.getX(b) + posAttr.getX(c)) / 3;
            const cy = (posAttr.getY(a) + posAttr.getY(b) + posAttr.getY(c)) / 3;
            const cz = (posAttr.getZ(a) + posAttr.getZ(b) + posAttr.getZ(c)) / 3;
            tmpV.set(cx, cy, cz).applyMatrix4(worldMat).project(cam);
            // Skip facce dietro la camera (project ritorna z > 1)
            if (tmpV.z < -1 || tmpV.z > 1) continue;
            if (tmpV.x < ndcXMin || tmpV.x > ndcXMax) continue;
            if (tmpV.y < ndcYMin || tmpV.y > ndcYMax) continue;

            // V1.4 — front-facing filter se xray=false (solo superficie).
            if (!xray && !_faceFrontFacing(a, b, c, posAttr, worldMat, camPos)) continue;

            if (mode === 'remove') {
                if (this.selection.delete(f)) changed++;
            } else {
                if (!this.selection.has(f)) { this.selection.add(f); changed++; }
            }
        }

        if (changed > 0) {
            this._rebuildHighlightGeometry();
            this._notifySelectionChange();
            this.ibex.sceneMgr.render();
        }
    }

    // ─────────────────────────────────────────────────────────────
    // V1.3 — Selezione lazo (poligono screen-space)
    //
    // points: array {x,y} canvas-local. Per ogni faccia proietta il
    // centroide in canvas-pixel e testa point-in-polygon (even-odd
    // ray casting). X-RAY default come box. Costo O(N_face × N_points)
    // ma il throttling 4px in _onMouseMove limita N_points a ~50.
    // ─────────────────────────────────────────────────────────────
    _selectByLasso(points, evt) {
        const mesh = this.targetMesh;
        const geom = mesh?.geometry;
        if (!geom || !geom.attributes.position || !geom.index) return;
        if (!points || points.length < 3) return;  // skip silenzioso (D1)

        const canvas = this.ibex.sceneMgr.renderer.domElement;
        const cam    = this.ibex.sceneMgr.camera;
        const rect   = canvas.getBoundingClientRect();
        const halfW  = rect.width / 2;
        const halfH  = rect.height / 2;

        const mode = this._resolveMode(evt);
        const posAttr = geom.attributes.position;
        const idxArr  = geom.index.array;
        const worldMat = mesh.matrixWorld;
        const tmpV = new THREE.Vector3();
        const nF = idxArr.length / 3;
        const xray = this._xray;
        const camPos = cam.position;

        let changed = 0;
        for (let f = 0; f < nF; f++) {
            const o = f * 3;
            const a = idxArr[o], b = idxArr[o + 1], c = idxArr[o + 2];
            const cx = (posAttr.getX(a) + posAttr.getX(b) + posAttr.getX(c)) / 3;
            const cy = (posAttr.getY(a) + posAttr.getY(b) + posAttr.getY(c)) / 3;
            const cz = (posAttr.getZ(a) + posAttr.getZ(b) + posAttr.getZ(c)) / 3;
            tmpV.set(cx, cy, cz).applyMatrix4(worldMat).project(cam);
            if (tmpV.z < -1 || tmpV.z > 1) continue;

            // NDC → canvas-pixel
            const px = (tmpV.x + 1) * halfW;
            const py = (-tmpV.y + 1) * halfH;
            if (!_pointInPolygon(px, py, points)) continue;

            // V1.4 — front-facing filter se xray=false (solo superficie).
            if (!xray && !_faceFrontFacing(a, b, c, posAttr, worldMat, camPos)) continue;

            if (mode === 'remove') {
                if (this.selection.delete(f)) changed++;
            } else {
                if (!this.selection.has(f)) { this.selection.add(f); changed++; }
            }
        }

        if (changed > 0) {
            this._rebuildHighlightGeometry();
            this._notifySelectionChange();
            this.ibex.sceneMgr.render();
        }
    }

    // ─────────────────────────────────────────────────────────────
    // V1.3 — Overlay DOM per box/lasso (z-index 56, sopra inspector
    // panel z:55, sotto DAG z:60). Lazy init al primo show.
    // ─────────────────────────────────────────────────────────────
    _ensureShapeOverlay() {
        if (this._shapeOverlay) return;
        const overlay = document.createElement('div');
        overlay.id = 'ibex-selection-shape-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:56;display:none;';

        const boxEl = document.createElement('div');
        boxEl.style.cssText = 'position:absolute;border:1.5px solid #FF6037;background:rgba(255,96,55,0.08);box-sizing:border-box;display:none;';
        overlay.appendChild(boxEl);

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.style.cssText = 'position:absolute;inset:0;display:none;';
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        poly.setAttribute('fill', 'rgba(255,96,55,0.08)');
        poly.setAttribute('stroke', '#FF6037');
        poly.setAttribute('stroke-width', '1.5');
        poly.setAttribute('stroke-linejoin', 'round');
        poly.setAttribute('stroke-linecap', 'round');
        svg.appendChild(poly);
        overlay.appendChild(svg);

        document.body.appendChild(overlay);
        this._shapeOverlay = overlay;
        this._shapeBoxEl = boxEl;
        this._shapeLassoSvg = svg;
        this._shapeLassoPoly = poly;
    }

    _showShapeOverlay() {
        this._ensureShapeOverlay();
        this._shapeOverlay.style.display = 'block';
        if (this._selMode === 'box') {
            this._shapeBoxEl.style.display = 'block';
            this._shapeLassoSvg.style.display = 'none';
        } else if (this._selMode === 'lasso') {
            this._shapeLassoSvg.style.display = 'block';
            this._shapeBoxEl.style.display = 'none';
        }
    }

    _hideShapeOverlay() {
        if (!this._shapeOverlay) return;
        this._shapeOverlay.style.display = 'none';
        this._shapeBoxEl.style.display = 'none';
        this._shapeLassoSvg.style.display = 'none';
        this._shapeLassoPoly.setAttribute('points', '');
    }

    _updateShapeOverlay() {
        if (!this._shapeOverlay) return;
        const canvas = this.ibex.sceneMgr.renderer.domElement;
        const rect = canvas.getBoundingClientRect();
        if (this._selMode === 'box' && this._shapeOrigin && this._shapePoints[1]) {
            const p1 = this._shapeOrigin;
            const p2 = this._shapePoints[1];
            const x = Math.min(p1.x, p2.x) + rect.left;
            const y = Math.min(p1.y, p2.y) + rect.top;
            const w = Math.abs(p2.x - p1.x);
            const h = Math.abs(p2.y - p1.y);
            const el = this._shapeBoxEl;
            el.style.left = `${x}px`;
            el.style.top  = `${y}px`;
            el.style.width  = `${w}px`;
            el.style.height = `${h}px`;
        } else if (this._selMode === 'lasso' && this._shapePoints.length) {
            // Punti canvas-local → screen-absolute (overlay è position:fixed)
            const pts = this._shapePoints
                .map(p => `${p.x + rect.left},${p.y + rect.top}`)
                .join(' ');
            this._shapeLassoPoly.setAttribute('points', pts);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Highlight overlay management
    //
    // La highlightMesh è child della targetMesh (S2-A1 opzione a).
    // La sua geometry è un subset dei triangoli selezionati, rebuild
    // on-demand ad ogni modifica di this.selection.
    //
    // Ottimizzazione: per selezioni grandi (>10k facce), il rebuild completo
    // a ogni sample può essere lento. Throttle via requestAnimationFrame se
    // necessario — non fatto in V1 (mesh dentale tipica ~200k face, selezione
    // realistica pochi %).
    // ─────────────────────────────────────────────────────────────
    _rebuildHighlightGeometry() {
        if (!this.targetMesh) return;
        const geom = this.targetMesh.geometry;
        const posAttr = geom.attributes.position;
        const oldIndex = geom.index;
        if (!posAttr || !oldIndex) return;

        if (this.selection.size === 0) {
            this.highlightMesh.visible = false;
            return;
        }

        // Nuovo index attribute con solo i triangoli selezionati
        const newIndexArr = new Uint32Array(this.selection.size * 3);
        const oldArr = oldIndex.array;
        let w = 0;
        for (const fi of this.selection) {
            const off = fi * 3;
            newIndexArr[w++] = oldArr[off];
            newIndexArr[w++] = oldArr[off + 1];
            newIndexArr[w++] = oldArr[off + 2];
        }

        // Riusa la stessa position buffer della targetMesh — zero alloc verts.
        // Only index differs → highlight mesh ha geometry separata con shared position.
        const hlGeom = this.highlightMesh.geometry;
        hlGeom.setAttribute('position', posAttr);  // shared reference, NOT copy
        hlGeom.setIndex(new THREE.BufferAttribute(newIndexArr, 1));
        hlGeom.computeBoundingBox();
        hlGeom.computeBoundingSphere();

        this.highlightMesh.visible = true;
    }

    _notifySelectionChange() {
        // ContextInspector.refresh() è troppo aggressivo (rebuild full HTML) —
        // qui aggiorniamo solo il contatore via dispatch custom event.
        window.dispatchEvent(new CustomEvent('ibex:selection-count-changed', {
            detail: { count: this.selection.size }
        }));
    }

    // ─────────────────────────────────────────────────────────────
    // Target mesh resolution (stesso pattern SculptMode)
    // ─────────────────────────────────────────────────────────────
    // T1Resolve_29-7 — delega all'util condiviso (era ×2 byte-identico con SculptMode).
    _resolveTargetMesh(nodeId) { return resolveTargetMesh(this.ibex, nodeId); }

    // ─────────────────────────────────────────────────────────────
    // Cursor (ring 3D rosso, renderOrder alto per superare highlight)
    // ─────────────────────────────────────────────────────────────
    _initCursor() {
        const geo = new THREE.RingGeometry(0.9, 1.0, 32);
        const mat = new THREE.MeshBasicMaterial({
            color:       0xC4302B,
            transparent: true,
            opacity:     0.85,
            side:        THREE.DoubleSide,
            depthTest:   false
        });
        this.cursorMesh = new THREE.Mesh(geo, mat);
        this.cursorMesh.renderOrder = 1000;
        this._updateCursorScale();
    }

    _updateCursorScale() {
        if (!this.cursorMesh) return;
        const r = this.brush.radius;
        this.cursorMesh.scale.set(r, r, r);
    }

    _initHighlight() {
        // Geometry vuota iniziale; position/index impostati on-demand in _rebuildHighlightGeometry
        const hlGeom = new THREE.BufferGeometry();
        const hlMat = new THREE.MeshBasicMaterial({
            color:        0xC4302B,
            transparent:  true,
            opacity:      0.4,
            side:         THREE.DoubleSide,
            depthTest:    false,
            depthWrite:   false,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits:  -1
        });
        this.highlightMesh = new THREE.Mesh(hlGeom, hlMat);
        this.highlightMesh.renderOrder = 999;
        this.highlightMesh.visible = false;
        this.highlightMesh.name = '__selection_highlight__';
    }
}

// ═══════════════════════════════════════════════════════════════
// V1.4 — Helper: face front-facing test in world space.
//
// `dot(face.normal, camera→centroide) < 0` ⟺ la normale ha componente
// VERSO la camera ⟺ faccia visibile (front-facing). Usa cross product
// dei 2 edge in local + transformDirection con `worldMat` (rotation only,
// no translation per le normali). Per matrici rigide / uniform scale,
// la matrice normale = rotation part di worldMat — sufficiente.
// ═══════════════════════════════════════════════════════════════
function _faceFrontFacing(ai, bi, ci, posAttr, worldMat, camPos) {
    const ax = posAttr.getX(ai), ay = posAttr.getY(ai), az = posAttr.getZ(ai);
    const bx = posAttr.getX(bi), by = posAttr.getY(bi), bz = posAttr.getZ(bi);
    const cx = posAttr.getX(ci), cy = posAttr.getY(ci), cz = posAttr.getZ(ci);

    // Normale in local: (b - a) × (c - a)
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nlx = e1y * e2z - e1z * e2y;
    const nly = e1z * e2x - e1x * e2z;
    const nlz = e1x * e2y - e1y * e2x;

    // Trasforma normale in world via rotation part di worldMat (col-major).
    const m = worldMat.elements;
    const wnx = m[0] * nlx + m[4] * nly + m[8]  * nlz;
    const wny = m[1] * nlx + m[5] * nly + m[9]  * nlz;
    const wnz = m[2] * nlx + m[6] * nly + m[10] * nlz;

    // Centroide in world via worldMat completa (incluso translation).
    const ccx = (ax + bx + cx) / 3;
    const ccy = (ay + by + cy) / 3;
    const ccz = (az + bz + cz) / 3;
    const wcx = m[0] * ccx + m[4] * ccy + m[8]  * ccz + m[12];
    const wcy = m[1] * ccx + m[5] * ccy + m[9]  * ccz + m[13];
    const wcz = m[2] * ccx + m[6] * ccy + m[10] * ccz + m[14];

    // Vista: direzione cam → centroide.
    const dx = wcx - camPos.x;
    const dy = wcy - camPos.y;
    const dz = wcz - camPos.z;

    // Front-facing: la normale punta VERSO la camera (componente opposta
    // alla direzione di vista) ⟺ dot(n, view) < 0.
    return (wnx * dx + wny * dy + wnz * dz) < 0;
}

// ═══════════════════════════════════════════════════════════════
// V1.3 — Helper: point-in-polygon (even-odd ray casting).
// `polygon` = array di {x, y}, polygon[N-1] → polygon[0] è chiusura
// implicita. Restituisce true se (px, py) cade dentro.
// ═══════════════════════════════════════════════════════════════
function _pointInPolygon(px, py, polygon) {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        if (((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// ═══════════════════════════════════════════════════════════════
// Helper: sphere-box intersection (identico a SculptMode)
// ═══════════════════════════════════════════════════════════════
function _sphereBoxIntersect(center, radius, box) {
    const r2 = radius * radius;
    let dmin = 0;
    if      (center.x < box.min.x) dmin += (box.min.x - center.x) ** 2;
    else if (center.x > box.max.x) dmin += (center.x - box.max.x) ** 2;
    if      (center.y < box.min.y) dmin += (box.min.y - center.y) ** 2;
    else if (center.y > box.max.y) dmin += (center.y - box.max.y) ** 2;
    if      (center.z < box.min.z) dmin += (box.min.z - center.z) ** 2;
    else if (center.z > box.max.z) dmin += (center.z - box.max.z) ** 2;
    return dmin <= r2;
}
