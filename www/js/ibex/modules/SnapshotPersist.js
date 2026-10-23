import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

// ═══════════════════════════════════════════════════════════════
// IBEX SnapshotPersist SnapshotKeyed_S4_V1.4 — world matrix incorporata
//
// V1.4 (2026-04-26, SnapshotKeyed Session 4):
//   - `save(mesh, nodeId, toolId)` e `saveSplit(...)` ora clonano la geometry
//     e applicano `mesh.matrixWorld` ai vertici PRIMA della serializzazione.
//     Il file snapshot è quindi in WORLD-SPACE (incorpora le trasformazioni
//     Tier 1 upstream — fast_transform, fast_parenting). Il worker
//     `_apply_snapshot` copia lo snapshot sopra l'output della pipeline
//     Tier 1 upstream, ma ora i 2 sono allineati (entrambi WS).
//   - Risolve la "limitazione nota" dell'Invariante 77b: un nodo sculpt
//     downstream di fast_transform non perde più la rotazione upstream al
//     save. Il warning `_checkSculptPosition` resta come informativo (pipeline
//     con sculpt dopo Tier 1 upstream è ora pienamente supportata).
//   - La vecchia strategia `tempMesh identity + updateMatrixWorld(true)`
//     garantiva scanner-space ma scartava le matrici upstream. Sostituita
//     con `clone + applyMatrix4(mesh.matrixWorld)` — zero alloc sul position
//     originale della mesh master (clone separato, modifiche isolate).
//
// V1.1 (2026-04-25, SnapshotKeyed Session 3):
//   - Nuovo metodo `saveSplit(mesh, nodeId, geometryA, geometryB)` per il
//     nodo `split_topology`. Serializza 2 tempMesh con le 2 geometry locali
//     (branch A e B), POST a /?action=save_split con `stl_blob_a` +
//     `stl_blob_b`. Il worker SAVE_SPLIT scrive i 2 file
//     `{stem}_snap_{nodeId}_A.stl` e `_B.stl` in active_path.
//
// V1.0 (2026-04-24) — SnapshotPersist SnapshotKeyed_S2_V1.0 persistenza generica
//
// Generalizzazione di SculptPersist (SnapshotKeyed Session 2, 2026-04-24).
// Tutti i tool `destructive: true` (gn_meta.json) salvano la mesh modificata
// via save(mesh, nodeId, toolId). Il server scrive
// `{active_path}/{stem}_snap_{nodeId}.stl` (stesso path per qualsiasi toolId).
//
// Invariante S2-A6: `tool_id` è solo diagnostico (log worker/PHP). Il naming
// file dipende SOLO da (stem, nodeId). Lo stem deriva dal basename del
// `src_path` corrente al momento del bake — NON dal master (invariante RT-4).
//
// Contratto:
//   save(mesh, nodeId, toolId) -> Promise<{ok, error?, size?, mesh_name?, nodeId?, tool_id?}>
//
// Interno:
//   1. bakeEngine.setSnapshotSavePending(true) — gate il prossimo requestBake
//      finché il file non è su disco (Invariante 77 ereditata da S1).
//   2. uiMgr.showWorkerStatus('Salvando snapshot...') — feedback UI.
//   3. Clone tempMesh con matrixWorld = identity → STLExporter({binary:true})
//      garantisce STL in SCANNER-SPACE (niente doppia applicazione matrici
//      quando il bake successivo ri-applica Tier 1 upstream).
//   4. POST /?action=save_snapshot → PHP saveSnapshot() → Redis SAVE_SNAPSHOT
//      → worker scrive file, compress Draco, cleanup verts orfani via trimesh,
//      risponde via Redis snapshot_resp_{uid}_{pid} (blPop 30s PHP side).
//   5. finally: setSnapshotSavePending(false) (rilancia requestBake pending
//      se c'era), hideWorkerStatus.
// ═══════════════════════════════════════════════════════════════

export class SnapshotPersist {
    constructor(ibex) {
        this.ibex = ibex;
        this.exporter = new STLExporter();
    }

    /**
     * Serializza mesh (scanner-space via tempMesh identity) e POST al worker.
     *
     * @param {THREE.Mesh} mesh      — mesh con BufferGeometry modificata
     * @param {string|number} nodeId — ID Drawflow del nodo destructive
     * @param {string} toolId        — 'sculpt' | 'delete_topology' | ...
     * @returns {Promise<{ok, error?, mesh_name?, size?, nodeId?, tool_id?}>}
     */
    async save(mesh, nodeId, toolId) {
        if (!mesh || !mesh.geometry) {
            return { ok: false, error: 'mesh invalida' };
        }
        if (!mesh.name) {
            return { ok: false, error: 'mesh.name mancante' };
        }
        const projectId = this.ibex?.config?.projectId;
        if (!projectId) {
            return { ok: false, error: 'projectId mancante' };
        }

        // Invariante 77 ereditata: gate il prossimo requestBake finché il file
        // non è stato scritto e compresso sul disco. Se requestBake parte prima,
        // `_apply_snapshot` non trova il file → passthrough master → snapshot
        // scartato visivamente.
        const bakeEngine = this.ibex?.stackMgr?.bakeEngine;
        bakeEngine?.setSnapshotSavePending?.(true);

        // Feedback UI durante serializzazione + POST + worker blPop.
        const uiMgr = this.ibex?.uiMgr;
        uiMgr?.showWorkerStatus?.('Salvando snapshot...');

        try {
            // V1.4 (S4): export WORLD-SPACE via geometry.clone() + applyMatrix4.
            //
            // Strategia: invece di resettare matrixWorld a identity (che dava
            // scanner-space ma scartava le trasformazioni upstream), cloniamo
            // la geometry e applichiamo `mesh.matrixWorld` ai vertici. Lo
            // snapshot include quindi TUTTE le trasformazioni upstream
            // (fast_transform, fast_parenting, ecc.). Il worker `_apply_snapshot`
            // copia lo snapshot sopra l'output della pipeline Tier 1 upstream —
            // entrambi in WS, quindi allineati visivamente.
            //
            // Il clone della geometry è necessario: `applyMatrix4` mutate i
            // BufferAttribute position in place. Senza clone, modificheremmo
            // la mesh originale in scena corrompendone il rendering.
            let stlBuffer;
            try {
                const clonedGeom = mesh.geometry.clone();
                clonedGeom.applyMatrix4(mesh.matrixWorld);
                const tempMesh = new THREE.Mesh(clonedGeom, mesh.material);
                // tempMesh non-parentato → matrixWorld = identity by default.
                // STLExporter.parse applica matrixWorld (identity) a vertici
                // già trasformati nel clone. Export = vertici world-space.
                stlBuffer = this.exporter.parse(tempMesh, { binary: true });
            } catch (e) {
                return { ok: false, error: `serializzazione STL fallita: ${e.message || e}` };
            }

            const blob = new Blob([stlBuffer], { type: 'application/sla' });
            const fd = new FormData();
            fd.append('id', String(projectId));
            fd.append('mesh_name', mesh.name);
            if (nodeId !== undefined && nodeId !== null) {
                fd.append('node_id', String(nodeId));
            }
            if (toolId !== undefined && toolId !== null) {
                fd.append('tool_id', String(toolId));
            }
            fd.append('stl_blob', blob, mesh.name);

            try {
                const resp = await fetch('/?action=save_snapshot', {
                    method: 'POST',
                    body: fd,
                    credentials: 'same-origin'
                });
                if (!resp.ok) {
                    return { ok: false, error: `HTTP ${resp.status}` };
                }
                const data = await resp.json();
                if (data.success) {
                    return {
                        ok: true,
                        mesh_name: data.mesh_name,
                        size: data.size,
                        nodeId: data.node_id || nodeId,
                        tool_id: data.tool_id || toolId
                    };
                }
                return { ok: false, error: data.error || 'errore worker' };
            } catch (e) {
                return { ok: false, error: `network: ${e.message || e}` };
            }
        } finally {
            uiMgr?.hideWorkerStatus?.();
            bakeEngine?.setSnapshotSavePending?.(false);
        }
    }

    /**
     * topology_rebuild V1.0 (2026-05-05) — variante di `save()` che include un
     * file collaterale `.sel.json` con la lista degli indici di facce selezionate.
     * POST identico a `save()` ma con campo aggiuntivo `selection_blob`.
     * Il PHP scrive 2 tmp files; il worker SAVE_SNAPSHOT li rinomina insieme.
     *
     * @param {THREE.Mesh}    mesh         — mesh con BufferGeometry corrente
     * @param {string|number} nodeId       — ID Drawflow del nodo destructive
     * @param {string}        toolId       — 'topology_rebuild' (validato server-side)
     * @param {number[]}      faceIndices  — array di indici facce della selezione
     * @returns {Promise<{ok, error?, ...}>}
     */
    async saveWithSelection(mesh, nodeId, toolId, faceIndices) {
        if (!mesh || !mesh.geometry) return { ok: false, error: 'mesh invalida' };
        if (!mesh.name) return { ok: false, error: 'mesh.name mancante' };
        if (!nodeId) return { ok: false, error: 'nodeId mancante' };
        if (!Array.isArray(faceIndices) || faceIndices.length === 0) {
            return { ok: false, error: 'face indices vuoti o non validi' };
        }
        const projectId = this.ibex?.config?.projectId;
        if (!projectId) return { ok: false, error: 'projectId mancante' };

        const bakeEngine = this.ibex?.stackMgr?.bakeEngine;
        bakeEngine?.setSnapshotSavePending?.(true);

        const uiMgr = this.ibex?.uiMgr;
        uiMgr?.showWorkerStatus?.('Salvando ricostruzione...');

        try {
            // Export mesh in WS (stessa strategia di `save()` V1.4):
            // clone geometry + applyMatrix4(mesh.matrixWorld) → STL incorpora
            // le trasformazioni Tier 1 upstream. CRITICO: il file .sel.json
            // contiene face indices che si riferiscono a QUESTA mesh esportata,
            // quindi il worker `topology_rebuild.apply` deve ricevere lo stesso
            // ordine triangoli (garantito da STLExporter binary + trimesh
            // process=False — Inv. 43).
            let stlBuffer;
            try {
                const clonedGeom = mesh.geometry.clone();
                clonedGeom.applyMatrix4(mesh.matrixWorld);
                const tempMesh = new THREE.Mesh(clonedGeom, mesh.material);
                stlBuffer = this.exporter.parse(tempMesh, { binary: true });
            } catch (e) {
                return { ok: false, error: `serializzazione STL fallita: ${e.message || e}` };
            }

            // Sanitize face indices: solo interi non-negativi, dedupe
            const cleanSet = new Set();
            for (const fi of faceIndices) {
                const n = parseInt(fi, 10);
                if (Number.isInteger(n) && n >= 0) cleanSet.add(n);
            }
            const cleanArr = Array.from(cleanSet).sort((a, b) => a - b);
            if (cleanArr.length === 0) {
                return { ok: false, error: 'face indices tutti invalidi post-cleanup' };
            }
            const selJson = JSON.stringify({ face_indices: cleanArr });

            const stlBlob = new Blob([stlBuffer], { type: 'application/sla' });
            const selBlob = new Blob([selJson], { type: 'application/json' });
            const fd = new FormData();
            fd.append('id', String(projectId));
            fd.append('mesh_name', mesh.name);
            fd.append('node_id', String(nodeId));
            fd.append('tool_id', String(toolId || 'topology_rebuild'));
            fd.append('stl_blob', stlBlob, mesh.name);
            fd.append('selection_blob', selBlob, 'selection.json');

            try {
                const resp = await fetch('/?action=save_snapshot', {
                    method: 'POST',
                    body: fd,
                    credentials: 'same-origin'
                });
                if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
                const data = await resp.json();
                if (data.success) {
                    return {
                        ok: true,
                        mesh_name: data.mesh_name,
                        size: data.size,
                        nodeId: data.node_id || nodeId,
                        tool_id: data.tool_id || toolId,
                        n_faces_selected: cleanArr.length
                    };
                }
                return { ok: false, error: data.error || 'errore worker' };
            } catch (e) {
                return { ok: false, error: `network: ${e.message || e}` };
            }
        } finally {
            uiMgr?.hideWorkerStatus?.();
            bakeEngine?.setSnapshotSavePending?.(false);
        }
    }

    /**
     * draw_curve V1.0 (2026-05-06) — variante di `save()` per il nodo
     * `draw_curve`. Salva mesh in WS (passthrough, nessuna modifica) +
     * file collaterale `.crv.json` con il datablock di N splines.
     * POST identico a `saveWithSelection` ma con campo `curve_blob` (JSON
     * con schema `{splines: [{control_points, cyclic}, ...]}`).
     *
     * @param {THREE.Mesh}    mesh    — mesh per snap reference (passthrough)
     * @param {string|number} nodeId  — ID del nodo draw_curve
     * @param {Array}         splines — [{control_points: [[x,y,z], ...], cyclic: bool}]
     */
    async saveCurve(mesh, nodeId, splines, options = {}) {
        const userEdited = options.userEdited !== false; // default true
        if (!mesh || !mesh.geometry) return { ok: false, error: 'mesh invalida' };
        if (!mesh.name) return { ok: false, error: 'mesh.name mancante' };
        if (!nodeId) return { ok: false, error: 'nodeId mancante' };
        if (!Array.isArray(splines)) return { ok: false, error: 'splines non array' };
        const projectId = this.ibex?.config?.projectId;
        if (!projectId) return { ok: false, error: 'projectId mancante' };

        const bakeEngine = this.ibex?.stackMgr?.bakeEngine;
        bakeEngine?.setSnapshotSavePending?.(true);

        const uiMgr = this.ibex?.uiMgr;
        uiMgr?.showWorkerStatus?.('Salvando curva...');

        try {
            // Mesh export WS (passthrough — la curva è in coord LOCALE della
            // mesh, salvata come riferimento. Il worker `_apply_draw_curve`
            // copia la mesh come-è. Lo snapshot mesh garantisce coerenza file
            // su disco con il pattern destructive standard).
            let stlBuffer;
            try {
                const clonedGeom = mesh.geometry.clone();
                clonedGeom.applyMatrix4(mesh.matrixWorld);
                const tempMesh = new THREE.Mesh(clonedGeom, mesh.material);
                stlBuffer = this.exporter.parse(tempMesh, { binary: true });
            } catch (e) {
                return { ok: false, error: `serializzazione STL fallita: ${e.message || e}` };
            }

            // Sanitize splines: solo control_points array di [x,y,z], cyclic bool
            const cleanSplines = [];
            for (const sp of splines) {
                if (!sp || !Array.isArray(sp.control_points)) continue;
                const pts = [];
                for (const cp of sp.control_points) {
                    if (Array.isArray(cp) && cp.length === 3 &&
                        cp.every(v => typeof v === 'number' && Number.isFinite(v))) {
                        pts.push([cp[0], cp[1], cp[2]]);
                    }
                }
                if (pts.length >= 2) {
                    cleanSplines.push({
                        control_points: pts,
                        cyclic: !!sp.cyclic
                    });
                }
            }
            if (cleanSplines.length === 0) {
                // Datablock vuoto: salviamo comunque (utente può aver
                // cancellato tutte le splines). Il consumer skipperà.
            }
            // Marker `user_edited` distingue un save genuino dell'utente da
            // una copia stale dell'upstream. Worker `_apply_curve_edit` preserva
            // SOLO i file con user_edited=true; altrimenti ricopia da arch_detect.
            // Reset curva: chiamato con options.userEdited=false → user_edited=false
            // → worker al prossimo bake ricopia upstream (cancella edits utente).
            const curveJson = JSON.stringify({
                splines: cleanSplines,
                metadata: {
                    user_edited: userEdited,
                    saved_at: Math.floor(Date.now() / 1000)
                }
            });

            const stlBlob = new Blob([stlBuffer], { type: 'application/sla' });
            const curveBlob = new Blob([curveJson], { type: 'application/json' });
            const fd = new FormData();
            fd.append('id', String(projectId));
            fd.append('mesh_name', mesh.name);
            fd.append('node_id', String(nodeId));
            fd.append('tool_id', 'draw_curve');
            fd.append('stl_blob', stlBlob, mesh.name);
            fd.append('curve_blob', curveBlob, 'curve.json');

            try {
                const resp = await fetch('/?action=save_snapshot', {
                    method: 'POST',
                    body: fd,
                    credentials: 'same-origin'
                });
                if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
                const data = await resp.json();
                if (data.success) {
                    return {
                        ok: true,
                        mesh_name: data.mesh_name,
                        size: data.size,
                        nodeId: data.node_id || nodeId,
                        n_splines: cleanSplines.length
                    };
                }
                return { ok: false, error: data.error || 'errore worker' };
            } catch (e) {
                return { ok: false, error: `network: ${e.message || e}` };
            }
        } finally {
            uiMgr?.hideWorkerStatus?.();
            bakeEngine?.setSnapshotSavePending?.(false);
        }
    }

    /**
     * Persistenza multi-output per il nodo `split_topology` (SnapshotKeyed S3).
     * Serializza 2 BufferGeometry distinte (branch A e B) come STL binari
     * scanner-space e POST al server che scrive 2 file
     * `{stem}_snap_{nodeId}_A.stl` + `_B.stl`.
     *
     * @param {THREE.Mesh}         mesh       — mesh master (usata per material + mesh.name)
     * @param {string|number}      nodeId     — ID Drawflow del nodo split
     * @param {THREE.BufferGeometry} geometryA — geometry branch A (facce selezionate)
     * @param {THREE.BufferGeometry} geometryB — geometry branch B (complemento)
     * @returns {Promise<{ok, error?, mesh_name?, node_id?, branches?: [{branch, mesh_name, size}]}>}
     */
    async saveSplit(mesh, nodeId, geometryA, geometryB) {
        if (!mesh || !mesh.name) return { ok: false, error: 'mesh invalida o senza name' };
        if (!geometryA || !geometryB) return { ok: false, error: 'geometry A/B mancanti' };
        if (!nodeId) return { ok: false, error: 'nodeId mancante' };
        const projectId = this.ibex?.config?.projectId;
        if (!projectId) return { ok: false, error: 'projectId mancante' };

        const bakeEngine = this.ibex?.stackMgr?.bakeEngine;
        bakeEngine?.setSnapshotSavePending?.(true);

        const uiMgr = this.ibex?.uiMgr;
        uiMgr?.showWorkerStatus?.('Salvando split...');

        try {
            // V1.4 (S4): export WORLD-SPACE per entrambi i branch A/B —
            // stessa strategia di `save()` (clone + applyMatrix4(matrixWorld)).
            // CRITICO: `geometryA`/`geometryB` hanno `position` SHARED col master
            // (SelectionMode.applySplit riusa il position buffer, solo l'index
            // è distinto per ogni branch). Chiamare `applyMatrix4` direttamente
            // modificherebbe il position del master (e dell'altro branch!),
            // corrompendo rendering + serializzazione successiva. Quindi
            // `clone()` su entrambe prima dell'applyMatrix.
            let stlA, stlB;
            try {
                const clonedA = geometryA.clone();
                clonedA.applyMatrix4(mesh.matrixWorld);
                const tempA = new THREE.Mesh(clonedA, mesh.material);
                stlA = this.exporter.parse(tempA, { binary: true });

                const clonedB = geometryB.clone();
                clonedB.applyMatrix4(mesh.matrixWorld);
                const tempB = new THREE.Mesh(clonedB, mesh.material);
                stlB = this.exporter.parse(tempB, { binary: true });
            } catch (e) {
                return { ok: false, error: `serializzazione STL split fallita: ${e.message || e}` };
            }

            const blobA = new Blob([stlA], { type: 'application/sla' });
            const blobB = new Blob([stlB], { type: 'application/sla' });
            const fd = new FormData();
            fd.append('id', String(projectId));
            fd.append('mesh_name', mesh.name);
            fd.append('node_id', String(nodeId));
            fd.append('tool_id', 'split_topology');
            fd.append('stl_blob_a', blobA, mesh.name);
            fd.append('stl_blob_b', blobB, mesh.name);

            try {
                const resp = await fetch('/?action=save_split', {
                    method: 'POST',
                    body: fd,
                    credentials: 'same-origin'
                });
                if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
                const data = await resp.json();
                if (data.success) {
                    return {
                        ok: true,
                        mesh_name: data.mesh_name,
                        node_id: data.node_id || String(nodeId),
                        branches: data.branches || []
                    };
                }
                return { ok: false, error: data.error || 'errore worker' };
            } catch (e) {
                return { ok: false, error: `network: ${e.message || e}` };
            }
        } finally {
            uiMgr?.hideWorkerStatus?.();
            bakeEngine?.setSnapshotSavePending?.(false);
        }
    }
}
