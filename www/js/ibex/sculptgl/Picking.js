// ═══════════════════════════════════════════════════════════════
// IBEX sculptgl/Picking.js — SculptGL_S2_V1.0
//
// Adapter Picking: interfaccia SculptGL.Picking (chiamata da SculptBase) che
// sotto il cofano usa:
//   - `intersectionMouseMesh` → Three.js Raycaster con BVH (firstHitOnly)
//     per trovare hit.point world; poi converte a local-space MeshDynamic.
//   - `pickVerticesInSphere(rLocal2)` → Octree SculptGL (mesh.intersectSphere)
//     invariato (A5 — Picking SculptGL autoritativo durante sculpt).
//   - `updateLocalAndWorldRadius2()` → semantica IBEX (mm): rLocal2 = radius²
//     direttamente, indipendente dal zoom camera (A2).
//
// Rimosso rispetto all'originale:
//   - Symmetry (`_xSym`, `mirrorPoint`, ecc.)
//   - Alpha brush textures (`_alpha*`, `ALPHAS`, `initAlpha`, `updateAlpha`,
//     `setIdAlpha`, `getAlpha`) → `getAlpha` ritorna sempre 1.0; gli altri
//     sono no-op.
//   - `intersectionRayMesh` (path Octree ray) non più usato — raycast via
//     Three.js BVH.
//   - `pickVerticesInSphereTopological` (variant topologico non usato dai
//     brush base in S2).
//   - `polyLerp` / `computePickedNormal` mantenuto ma semplificato.
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import Utils from './Utils.js';

const _TMP_V      = new THREE.Vector3();
const _TMP_V2     = new THREE.Vector3();
const _TMP_MAT    = new THREE.Matrix4();
const _TMP_MOUSE  = new THREE.Vector2();
const _TMP_HITS   = [];

class Picking {

    constructor(main) {
        this._main = main;                 // IbexMainAdapter (settato dopo, lazy)
        this._mesh = null;                 // MeshDynamic SculptGL selezionata
        this._pickedFace = -1;
        this._pickedVertices = [];
        this._interPoint = [0.0, 0.0, 0.0];
        this._rLocal2 = 0.0;
        this._rWorld2 = 0.0;
        this._eyeDir = [0.0, 0.0, 0.0];
        this._pickedNormal = [0.0, 0.0, 0.0];

        // Raycaster Three.js (BVH accelerated via prototype patch in IbexCore)
        this._raycaster = new THREE.Raycaster();
        this._raycaster.firstHitOnly = true;
    }

    // ─────────────────────────────────────────────────────────────
    // Stato — API compatibile con SculptGL.Picking
    // ─────────────────────────────────────────────────────────────
    getMesh()              { return this._mesh; }
    setLocalRadius2(r)     { this._rLocal2 = r; }
    getLocalRadius2()      { return this._rLocal2; }
    getLocalRadius()       { return Math.sqrt(this._rLocal2); }
    getWorldRadius2()      { return this._rWorld2; }
    getWorldRadius()       { return Math.sqrt(this._rWorld2); }
    setIntersectionPoint(p){ this._interPoint = p; }
    getEyeDirection()      { return this._eyeDir; }
    getIntersectionPoint() { return this._interPoint; }
    getPickedVertices()    { return this._pickedVertices; }
    getPickedFace()        { return this._pickedFace; }
    getPickedNormal()      { return this._pickedNormal; }

    // Alpha brush API — no-op / constant 1.0 (no stylus + no brush alpha in IBEX)
    setIdAlpha(_id)           {}
    updateAlpha(_keepOrigin)  {}
    initAlpha()               { this.computePickedNormal(); }
    getAlpha(_x, _y, _z)      { return 1.0; }

    // ─────────────────────────────────────────────────────────────
    // Intersezioni — usa Three.js BVH + converte a local MeshDynamic
    // ─────────────────────────────────────────────────────────────

    /**
     * API originale: `intersectionMouseMeshes(meshes?, mouseX?, mouseY?)`.
     * IBEX ha 1 sola mesh sculpt attiva (A7) — il `main.setOrUnsetMesh` la fornisce.
     */
    intersectionMouseMeshes() {
        const threeMesh = this._main.getThreeMesh();
        if (!threeMesh) { this._mesh = null; this._pickedFace = -1; return false; }
        return this.intersectionMouseMesh(this._main.getMesh());
    }

    /**
     * Raycast Three.js → hit.point world → conversione local MeshDynamic.
     * Popola: _interPoint (local), _pickedFace (face index MeshDynamic),
     * _eyeDir (ray direction local), _rLocal2/_rWorld2, _pickedNormal.
     *
     * @param {MeshDynamic} meshDyn  SculptGL (può essere omesso, default: _main.getMesh())
     * @param {number}      mouseX   pixel X in canvas-local coords
     * @param {number}      mouseY   pixel Y in canvas-local coords
     * @returns {boolean} true se c'è hit
     */
    intersectionMouseMesh(meshDyn, mouseX, mouseY) {
        if (meshDyn === undefined) meshDyn = this._main.getMesh();
        if (mouseX === undefined)  mouseX  = this._main._mouseX;
        if (mouseY === undefined)  mouseY  = this._main._mouseY;

        const threeMesh = this._main.getThreeMesh();
        if (!threeMesh || !meshDyn) {
            this._mesh = null;
            this._pickedFace = -1;
            this._rLocal2 = 0.0;
            return false;
        }

        // NDC
        const canvas = this._main.getCanvas();
        const w = canvas.clientWidth  || canvas.width;
        const h = canvas.clientHeight || canvas.height;
        _TMP_MOUSE.x =  (mouseX / w) * 2 - 1;
        _TMP_MOUSE.y = -(mouseY / h) * 2 + 1;
        const camera = this._main.getThreeCamera();
        this._raycaster.setFromCamera(_TMP_MOUSE, camera);

        _TMP_HITS.length = 0;
        this._raycaster.intersectObject(threeMesh, false, _TMP_HITS);
        if (_TMP_HITS.length === 0) {
            this._mesh = null;
            this._pickedFace = -1;
            this._rLocal2 = 0.0;
            return false;
        }
        const hit = _TMP_HITS[0];

        // hit.point è world; converti a local-space MeshDynamic (che coincide
        // con geometry local-space Three.js: nessuna trasformazione applicata
        // al sync, vedi IbexBridge).
        _TMP_MAT.copy(threeMesh.matrixWorld).invert();
        _TMP_V.copy(hit.point).applyMatrix4(_TMP_MAT);
        this._interPoint[0] = _TMP_V.x;
        this._interPoint[1] = _TMP_V.y;
        this._interPoint[2] = _TMP_V.z;

        // hit.faceIndex corrisponde all'indice del triangolo in geometry.index,
        // che post-syncToThree è uguale all'indice del face in _facesABCD
        // (MeshDynamic è solo-triangoli, 1 face = 1 triangolo).
        this._pickedFace = hit.faceIndex;
        this._mesh = meshDyn;

        // eyeDir in local-space: world direction → inverse rotation via
        // transformDirection (ignora traslazione).
        _TMP_V2.copy(hit.point).sub(camera.position).normalize();
        _TMP_V2.transformDirection(_TMP_MAT).normalize();
        this._eyeDir[0] = _TMP_V2.x;
        this._eyeDir[1] = _TMP_V2.y;
        this._eyeDir[2] = _TMP_V2.z;

        this.updateLocalAndWorldRadius2();
        return true;
    }

    /**
     * Find all the vertices inside the sphere.
     *
     * Strategia via Three.js BVH (boundsTree.shapecast) invece dell'Octree
     * SculptGL. Motivo: l'Octree SculptGL viene aggiornato incrementalmente
     * via updateOctreeRemove+updateOctreeAdd dopo ogni sample → può
     * degradare su drag lunghi (face centers fuori dai bounds dei leaf,
     * `addFace` fails e reinserisce nel vecchio leaf). Dopo ~N sample il
     * `intersectSphere` restituisce face incomplete → pickedVertices vuoto
     * → brush "muto" (il sintomo "drag che si ferma a metà").
     *
     * Three.js BVH invece è `refit()` a ogni `adapter.render()` post-sync
     * (O(log n), ricalcola bounds dalle position correnti). Sempre coerente
     * con la geometria corrente → shapecast sempre affidabile.
     *
     * Fallback: se il boundsTree non è disponibile (edge case transitorio),
     * usa l'Octree SculptGL come prima.
     */
    pickVerticesInSphere(rLocal2) {
        const meshDyn = this._mesh;
        if (!meshDyn) { this._pickedVertices = new Uint32Array(0); return this._pickedVertices; }

        const threeMesh = this._main.getThreeMesh();
        const geom      = threeMesh?.geometry;
        const boundsTree = geom?.boundsTree;

        const vAr = meshDyn.getVertices();
        const vertSculptFlags = meshDyn.getVerticesSculptFlags();
        const inter = this.getIntersectionPoint();
        const itx = inter[0], ity = inter[1], itz = inter[2];
        const sculptFlag = ++Utils.SCULPT_FLAG;

        if (boundsTree && typeof boundsTree.shapecast === 'function') {
            // Path primario: BVH Three.js (coerente con geometry corrente via refit)
            const indexAttr = geom.index;
            const centerArr = inter;
            const radius = Math.sqrt(rLocal2);
            const collectedVerts = new Set();

            boundsTree.shapecast({
                intersectsBounds: (box) => _sphereBoxIntersect(centerArr, radius, box),
                intersectsTriangle: (_tri, triIndex) => {
                    const off = triIndex * 3;
                    collectedVerts.add(indexAttr ? indexAttr.getX(off)     : off);
                    collectedVerts.add(indexAttr ? indexAttr.getX(off + 1) : off + 1);
                    collectedVerts.add(indexAttr ? indexAttr.getX(off + 2) : off + 2);
                    return false;
                }
            });

            const out = new Uint32Array(collectedVerts.size);
            let acc = 0;
            for (const ind of collectedVerts) {
                const j = ind * 3;
                const dx = itx - vAr[j];
                const dy = ity - vAr[j + 1];
                const dz = itz - vAr[j + 2];
                if ((dx * dx + dy * dy + dz * dz) < rLocal2) {
                    vertSculptFlags[ind] = sculptFlag;
                    out[acc++] = ind;
                }
            }
            this._pickedVertices = new Uint32Array(out.subarray(0, acc));
            return this._pickedVertices;
        }

        // Fallback Octree SculptGL (se BVH non disponibile)
        var iFacesInCells = meshDyn.intersectSphere(inter, rLocal2, true);
        var iVerts = meshDyn.getVerticesFromFaces(iFacesInCells);
        var nbVerts = iVerts.length;

        var pickedVertices = new Uint32Array(Utils.getMemory(4 * nbVerts), 0, nbVerts);
        var acc = 0;
        for (var i = 0; i < nbVerts; ++i) {
            var ind = iVerts[i];
            var j = ind * 3;
            var dx = itx - vAr[j];
            var dy = ity - vAr[j + 1];
            var dz = itz - vAr[j + 2];
            if ((dx * dx + dy * dy + dz * dz) < rLocal2) {
                vertSculptFlags[ind] = sculptFlag;
                pickedVertices[acc++] = ind;
            }
        }

        this._pickedVertices = new Uint32Array(pickedVertices.subarray(0, acc));
        return this._pickedVertices;
    }

    /**
     * Semantica IBEX (A2): radius è in mm LOCAL SPACE (scanner).
     * La mesh Three.js ha matrixWorld identity nell'adapter (SculptGL slave
     * opera su local coords di BufferGeometry, che sono gli stessi di IBEX
     * mesh pre-matrix). Quindi local == world per il brush.
     *   rLocal2 = rWorld2 = brush.radius²
     */
    updateLocalAndWorldRadius2() {
        if (!this._mesh) return;
        const brush = this._main.getSculptManager().getCurrentTool();
        const r = brush._radius;
        const r2 = r * r;
        this._rLocal2 = r2;
        this._rWorld2 = r2;
    }

    /** Compute picked normal via baricentric interpolation over face vertex normals */
    computePickedNormal() {
        if (!this._mesh || this._pickedFace < 0) return;
        return this._polyLerp(this._mesh.getNormals(), this._pickedNormal);
    }

    _polyLerp(vField, out) {
        const mesh = this._mesh;
        const vAr = mesh.getVertices();
        const fAr = mesh.getFaces();
        const id  = this._pickedFace * 4;
        const iv1 = fAr[id]     * 3;
        const iv2 = fAr[id + 1] * 3;
        const iv3 = fAr[id + 2] * 3;

        const inter = this._interPoint;
        const d1 = Math.sqrt((inter[0]-vAr[iv1])**2 + (inter[1]-vAr[iv1+1])**2 + (inter[2]-vAr[iv1+2])**2);
        const d2 = Math.sqrt((inter[0]-vAr[iv2])**2 + (inter[1]-vAr[iv2+1])**2 + (inter[2]-vAr[iv2+2])**2);
        const d3 = Math.sqrt((inter[0]-vAr[iv3])**2 + (inter[1]-vAr[iv3+1])**2 + (inter[2]-vAr[iv3+2])**2);
        const len1 = d1 > 1e-9 ? 1.0 / d1 : 1e9;
        const len2 = d2 > 1e-9 ? 1.0 / d2 : 1e9;
        const len3 = d3 > 1e-9 ? 1.0 / d3 : 1e9;

        const inv = 1.0 / (len1 + len2 + len3);
        out[0] = (vField[iv1] * len1 + vField[iv2] * len2 + vField[iv3] * len3) * inv;
        out[1] = (vField[iv1 + 1] * len1 + vField[iv2 + 1] * len2 + vField[iv3 + 1] * len3) * inv;
        out[2] = (vField[iv1 + 2] * len1 + vField[iv2 + 2] * len2 + vField[iv3 + 2] * len3) * inv;

        const ln = out[0]*out[0] + out[1]*out[1] + out[2]*out[2];
        if (ln > 0) {
            const n = 1.0 / Math.sqrt(ln);
            out[0] *= n; out[1] *= n; out[2] *= n;
        }
        return out;
    }
}

export default Picking;

// ═══════════════════════════════════════════════════════════════
// Helper: sphere-box intersection in local space (squared distance)
// Usato da boundsTree.shapecast.intersectsBounds come early-out.
// `center` è un array [x,y,z] (da _interPoint), `box` è THREE.Box3.
// ═══════════════════════════════════════════════════════════════
function _sphereBoxIntersect(center, radius, box) {
    const r2 = radius * radius;
    const cx = center[0], cy = center[1], cz = center[2];
    let dmin = 0;
    if      (cx < box.min.x) dmin += (box.min.x - cx) ** 2;
    else if (cx > box.max.x) dmin += (cx - box.max.x) ** 2;
    if      (cy < box.min.y) dmin += (box.min.y - cy) ** 2;
    else if (cy > box.max.y) dmin += (cy - box.max.y) ** 2;
    if      (cz < box.min.z) dmin += (box.min.z - cz) ** 2;
    else if (cz > box.max.z) dmin += (cz - box.max.z) ** 2;
    return dmin <= r2;
}
