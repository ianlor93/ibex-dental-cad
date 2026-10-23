import * as THREE from 'three';
// V1.1 (2026-05-08): import Line2 + LineMaterial per supportare linewidth >1px.
// `LineBasicMaterial.linewidth` è ignorato da WebGL (spec) e cade sempre
// a 1px. Line2 usa instanced quads + shader custom → pixel-precise.
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

// ═══════════════════════════════════════════════════════════════
// IBEX CurveMode DrawCurve_V1.0 — editor curve Bezier sulla mesh
//
// Pattern parallelo a SelectionMode ma per disegno curve invece di selezione
// facce. La modalità "draw_curve" è per il nodo `draw_curve` (Tier 1
// destructive). Output: file collaterale `.crv.json` con un datablock
// di N splines (ognuna con control points + flag cyclic), allineato a
// Blender GN dove una "Curve" è una collezione di N splines indipendenti.
//
// Schema persistenza (.crv.json):
//   {
//     "splines": [
//       { "control_points": [[x,y,z], ...], "cyclic": bool },
//       ...
//     ]
//   }
//
// V1.0: handles Bezier auto-calcolati (Catmull-Rom interpolation),
// no edit dei handles. V2 prevista: handle drag, point drag, undo.
//
// Flow utente:
//   1. Click su "Disegna" nel nodo → enter(nodeId)
//   2. Click sulla mesh → add control point alla spline attiva
//   3. "Chiudi curva" → cyclic=true sulla spline attiva
//   4. "Nuova curva" → committa l'attiva, ne crea una nuova vuota
//   5. "Esci" → snapshot save .crv.json + exit
//
// Visualizzazione:
//   - Spline completate (committate o cyclic): linea solida magenta
//   - Spline attiva (in editing): linea tratteggiata, color palette
//     ciclica per debug "1 curva o 2 sovrapposte?"
//   - Control points: piccole sfere magenta (raggio = 0.4mm)
// ═══════════════════════════════════════════════════════════════

// Palette ciclica per multi-spline durante edit (debug-friendly)
const _SPLINE_COLORS = [
    0x2A6FDB, // blu (default)
    0xec4899, // rosa
    0x14b8a6, // teal
    0xf59e0b, // ambra
    0x3b82f6, // blu
];
// V1.1 (2026-05-08): CP raggio ridotto da 0.4mm a 0.15mm (era troppo
// invasivo visivamente, oscurava la mesh).
const _CTRL_POINT_RADIUS_MM = 0.15;
const _CTRL_POINT_COLOR = 0x2A6FDB;
// V1.1 (2026-05-08): line width in pixel (Line2/LineMaterial-based).
// 4px = +2 rispetto al precedente render WebGL nativo (che era de-facto 1px).
const _LINE_WIDTH_PX = 4;

export class CurveMode {
    constructor(ibex) {
        this.ibex = ibex;
        this.active = false;
        this.targetNodeId = null;
        this.targetMesh = null;

        // Datablock: lista di splines, ognuna con control points + cyclic
        this.splines = [];     // [{ controlPoints: [Vector3], cyclic: bool }]
        this.activeSplineIdx = -1;

        // Three.js helpers per rendering
        this._raycaster = new THREE.Raycaster();
        this._raycaster.firstHitOnly = true;
        this._mouseNDC = new THREE.Vector2();

        // Bind handler permanenti (riferimento per add/remove listener)
        this._onMouseDown = this._onMouseDown.bind(this);

        this._modifiedSession = false;
    }

    // ─────────────────────────────────────────────────────────────
    // enter — inizio modalità draw curve per un nodo
    //
    // 1. Risolve target mesh dal nodo (IN_GEO_Mesh upstream)
    // 2. Carica splines esistenti dal nodo (se l'utente sta editando un
    //    draw_curve già usato in passato — meta.splines persistito)
    // 3. Bind listener click viewport
    // 4. Render iniziale delle splines (se presenti)
    // ─────────────────────────────────────────────────────────────
    enter(nodeId) {
        if (this.active) this.exit();
        if (!this.ibex.sceneMgr || !this.ibex.stackMgr) return;

        const stackMgr = this.ibex.stackMgr;
        const editor = stackMgr.editor;
        if (!editor) return;
        const node = editor.getNodeFromId(parseInt(nodeId, 10));
        if (!node || node.data?.toolId !== 'draw_curve') {
            this.ibex.uiMgr?.notify?.('Nodo non valido per CurveMode', 'error');
            return;
        }

        // Risolvi target mesh via edge IN_GEO_Mesh upstream
        const graph = stackMgr.extractDAG();
        const inEdge = graph.edges.find(e =>
            String(e.to_node) === String(nodeId) && e.role === 'IN_GEO_Mesh'
        );
        if (!inEdge) {
            this.ibex.uiMgr?.notify?.('Collega prima una mesh al nodo Disegna Curva', 'warning');
            return;
        }
        const targetName = stackMgr.resolveBaseMesh(inEdge.from_mesh, inEdge.from_port);
        if (!targetName) return;
        const mesh = this.ibex.sceneMgr.group.children.find(c => c.isMesh && c.name === targetName);
        if (!mesh) {
            this.ibex.uiMgr?.notify?.(`Mesh ${targetName} non trovata in scena`, 'error');
            return;
        }

        this.active = true;
        this.targetNodeId = nodeId;
        this.targetMesh = mesh;

        // Carica splines esistenti dal meta del nodo
        const savedSplines = node.data?.meta?.splines;
        if (Array.isArray(savedSplines) && savedSplines.length > 0) {
            this.splines = savedSplines.map(s => ({
                controlPoints: (s.control_points || []).map(p => new THREE.Vector3(p[0], p[1], p[2])),
                cyclic: !!s.cyclic
            }));
            this.activeSplineIdx = this.splines.length - 1;
        } else {
            // Inizializza con 1 spline vuota
            this.splines = [{ controlPoints: [], cyclic: false }];
            this.activeSplineIdx = 0;
        }

        // Bind click sulla mesh
        const dom = this.ibex.sceneMgr.renderer.domElement;
        dom.addEventListener('mousedown', this._onMouseDown);

        // Disabilita selezione mesh (no outline durante edit)
        this.ibex.sceneMgr.deselectMesh?.();

        // Rendering iniziale
        this._renderSplines();
        this._modifiedSession = false;

        console.log(`[CURVE] ENTER node ${nodeId} target=${targetName} splines=${this.splines.length}`);

        // Refresh inspector (lo mostra in modalità "edit attivo")
        this.ibex.contextInspector?.refresh?.();
    }

    // ─────────────────────────────────────────────────────────────
    // exit — fine modalità + save snapshot
    // ─────────────────────────────────────────────────────────────
    exit() {
        if (!this.active) return;
        const dom = this.ibex.sceneMgr?.renderer?.domElement;
        if (dom) dom.removeEventListener('mousedown', this._onMouseDown);

        const meshSnapshot = this.targetMesh;
        const nodeIdSnapshot = this.targetNodeId;
        const splinesSnapshot = this.splines.map(s => ({
            control_points: s.controlPoints.map(p => [p.x, p.y, p.z]),
            cyclic: s.cyclic
        }));
        const wasModified = this._modifiedSession;

        // Cleanup viewport overlay
        this._clearVisualization();

        this.active = false;
        this.targetNodeId = null;
        this.targetMesh = null;
        this.splines = [];
        this.activeSplineIdx = -1;
        this._modifiedSession = false;

        console.log(`[CURVE] EXIT (modified=${wasModified}, splines=${splinesSnapshot.length})`);

        // Persist solo se modificato
        if (wasModified && meshSnapshot && nodeIdSnapshot && this.ibex.snapshotPersist?.saveCurve) {
            this.ibex.snapshotPersist.saveCurve(meshSnapshot, nodeIdSnapshot, splinesSnapshot)
                .then(res => {
                    if (res.ok) {
                        const nClosed = splinesSnapshot.filter(s => s.cyclic).length;
                        const nOpen   = splinesSnapshot.length - nClosed;
                        this.ibex.uiMgr?.notify?.(
                            `Disegna Curva: ${nClosed} chiuse + ${nOpen} aperte salvate`,
                            'success');
                        this.ibex.stackMgr?.updateSculptNodeMeta?.(nodeIdSnapshot, {
                            sculpted:        true,
                            mesh_name:       res.mesh_name || meshSnapshot.name,
                            n_splines:       splinesSnapshot.length,
                            n_closed:        nClosed,
                            splines:         splinesSnapshot, // persiste per riapertura editing
                            last_modified:   Math.floor(Date.now() / 1000)
                        });
                        // Force bake (pattern topology_rebuild Inv. 116): il file
                        // .crv.json non cambia params del nodo → hasChanges=false →
                        // senza force il bake è skippato → consumer downstream non
                        // riceve la nuova curva.
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
    // Click handlers — add control point con snap to surface
    // ─────────────────────────────────────────────────────────────
    _onMouseDown(e) {
        if (!this.active || !this.targetMesh) return;
        if (e.button !== 0) return; // solo click sinistro
        // Skip se il click è su un elemento UI (es. inspector)
        if (e.target && e.target.closest('.ibex-inspector-panel')) return;
        if (e.target && e.target.closest('#dag-overlay')) return;

        const rect = this.ibex.sceneMgr.renderer.domElement.getBoundingClientRect();
        this._mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        this._raycaster.setFromCamera(this._mouseNDC, this.ibex.sceneMgr.camera);
        const hits = this._raycaster.intersectObject(this.targetMesh, false);
        if (!hits.length) return; // click nel vuoto, no add

        const hitPoint = hits[0].point.clone(); // world coord

        // Aggiungi control point alla spline attiva
        if (this.activeSplineIdx < 0 || this.activeSplineIdx >= this.splines.length) {
            this.splines.push({ controlPoints: [], cyclic: false });
            this.activeSplineIdx = this.splines.length - 1;
        }
        // Convert in local coord della targetMesh (matrixWorld inverse)
        // così se la mesh viene trasformata downstream (Tier 1), la curva
        // resta vincolata alla superficie.
        const inv = new THREE.Matrix4().copy(this.targetMesh.matrixWorld).invert();
        const localPoint = hitPoint.clone().applyMatrix4(inv);
        this.splines[this.activeSplineIdx].controlPoints.push(localPoint);

        this._modifiedSession = true;
        this._renderSplines();

        // Notify count update (UI inspector)
        try {
            window.dispatchEvent(new CustomEvent('ibex:curve-count-changed', {
                detail: {
                    n_splines:    this.splines.length,
                    active_idx:   this.activeSplineIdx,
                    active_pts:   this.splines[this.activeSplineIdx]?.controlPoints?.length || 0,
                    active_cyclic: this.splines[this.activeSplineIdx]?.cyclic || false
                }
            }));
        } catch (err) {}
    }

    // ─────────────────────────────────────────────────────────────
    // Toggle cyclic della spline attiva
    // ─────────────────────────────────────────────────────────────
    toggleCyclic() {
        if (!this.active || this.activeSplineIdx < 0) return;
        const sp = this.splines[this.activeSplineIdx];
        if (!sp) return;
        if (sp.controlPoints.length < 3 && !sp.cyclic) {
            this.ibex.uiMgr?.notify?.('Servono almeno 3 punti per chiudere la curva', 'warning');
            return;
        }
        sp.cyclic = !sp.cyclic;
        this._modifiedSession = true;
        this._renderSplines();
        try {
            window.dispatchEvent(new CustomEvent('ibex:curve-count-changed', {
                detail: {
                    n_splines:    this.splines.length,
                    active_idx:   this.activeSplineIdx,
                    active_pts:   sp.controlPoints.length,
                    active_cyclic: sp.cyclic
                }
            }));
        } catch (err) {}
    }

    // ─────────────────────────────────────────────────────────────
    // Committa la spline attiva e inizia una nuova vuota
    // ─────────────────────────────────────────────────────────────
    newSpline() {
        if (!this.active) return;
        const cur = this.splines[this.activeSplineIdx];
        if (cur && cur.controlPoints.length === 0) {
            this.ibex.uiMgr?.notify?.('La curva attiva è vuota — aggiungi almeno 1 punto prima di iniziarne una nuova', 'warning');
            return;
        }
        this.splines.push({ controlPoints: [], cyclic: false });
        this.activeSplineIdx = this.splines.length - 1;
        this._modifiedSession = true;
        this._renderSplines();
        try {
            window.dispatchEvent(new CustomEvent('ibex:curve-count-changed', {
                detail: {
                    n_splines:    this.splines.length,
                    active_idx:   this.activeSplineIdx,
                    active_pts:   0,
                    active_cyclic: false
                }
            }));
        } catch (err) {}
    }

    // ─────────────────────────────────────────────────────────────
    // Rimuovi ultimo control point della spline attiva (undo light)
    // ─────────────────────────────────────────────────────────────
    undoLastPoint() {
        if (!this.active || this.activeSplineIdx < 0) return;
        const sp = this.splines[this.activeSplineIdx];
        if (!sp || sp.controlPoints.length === 0) return;
        sp.controlPoints.pop();
        this._modifiedSession = true;
        this._renderSplines();
        try {
            window.dispatchEvent(new CustomEvent('ibex:curve-count-changed', {
                detail: {
                    n_splines:    this.splines.length,
                    active_idx:   this.activeSplineIdx,
                    active_pts:   sp.controlPoints.length,
                    active_cyclic: sp.cyclic
                }
            }));
        } catch (err) {}
    }

    // ─────────────────────────────────────────────────────────────
    // Rendering: 3D overlay delle splines + control points
    // ─────────────────────────────────────────────────────────────
    _renderSplines() {
        this._clearVisualization();
        if (!this.targetMesh) return;
        const scene = this.ibex.sceneMgr.scene;

        const matWorld = this.targetMesh.matrixWorld;
        const splineGroup = new THREE.Group();
        splineGroup.name = '_ibex_curve_overlay';
        splineGroup.renderOrder = 999;

        // Una linea per spline + sfere per control points
        for (let i = 0; i < this.splines.length; i++) {
            const sp = this.splines[i];
            const isActive = (i === this.activeSplineIdx);
            const color = _SPLINE_COLORS[i % _SPLINE_COLORS.length];

            // Linea della spline (worldcoord = local × matrixWorld) — V1.1
            // usa Line2/LineMaterial per linewidth >1px (vs LineBasicMaterial
            // che WebGL ignora e rende sempre a 1px).
            if (sp.controlPoints.length >= 2) {
                const pts = sp.controlPoints.map(p => p.clone().applyMatrix4(matWorld));
                if (sp.cyclic && pts.length >= 3) pts.push(pts[0].clone());
                // LineGeometry.setPositions richiede un array piatto [x,y,z,...]
                const flat = new Float32Array(pts.length * 3);
                for (let i = 0; i < pts.length; i++) {
                    flat[i*3]     = pts[i].x;
                    flat[i*3 + 1] = pts[i].y;
                    flat[i*3 + 2] = pts[i].z;
                }
                const geo = new LineGeometry();
                geo.setPositions(flat);
                // Resolution: viewport size in pixel — necessaria per shader
                // che converte mondo→schermo. Aggiornato anche al resize via
                // SceneManager ma settiamo subito il valore corrente.
                const w = window.innerWidth;
                const h = window.innerHeight;
                const mat = new LineMaterial({
                    color, linewidth: _LINE_WIDTH_PX,
                    transparent: true,
                    opacity: isActive ? 0.95 : 0.85,
                    depthTest: false,
                    dashed: isActive,
                    dashSize: 0.5,
                    gapSize: 0.3,
                    resolution: new THREE.Vector2(w, h),
                });
                const line = new Line2(geo, mat);
                if (isActive) line.computeLineDistances();
                line.renderOrder = 999;
                splineGroup.add(line);
            }

            // Control points (sfere)
            const sphereGeo = new THREE.SphereGeometry(_CTRL_POINT_RADIUS_MM, 8, 8);
            const sphereMat = new THREE.MeshBasicMaterial({
                color: isActive ? _CTRL_POINT_COLOR : color,
                depthTest: false, transparent: true, opacity: 0.95
            });
            for (const lp of sp.controlPoints) {
                const wp = lp.clone().applyMatrix4(matWorld);
                const sphere = new THREE.Mesh(sphereGeo, sphereMat);
                sphere.position.copy(wp);
                sphere.renderOrder = 1000;
                splineGroup.add(sphere);
            }
        }
        scene.add(splineGroup);
        this._overlayGroup = splineGroup;
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
    }
}
