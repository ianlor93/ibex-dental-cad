// ═══════════════════════════════════════════════════════════════
// IBEX sculptgl/IbexBridge.js — SculptGL_S1_V1.0
//
// Bridge bidirezionale tra Three.js BufferGeometry e SculptGL MeshDynamic.
//
// Strategia "Three.js primary, SculptGL slave" (vedi sessione planning A3/A5):
// durante lo sculpt, MeshDynamic è source of truth per geometria/topologia;
// dopo ogni mousemove IbexBridge.syncToThree() copia i typed array SculptGL
// nel BufferGeometry Three.js (position/normal/index + needsUpdate=true).
// BVH Three.js stale durante stroke → rebuild a mouseup in SculptMode.
//
// Sessione 1: bridge infrastructure + verifica round-trip.
// Sessione 2-3: brush + dyntopo userà questo bridge.
// Sessione 4: BakeEngine.hotSwapMeshes chiamerà initFromThreeMesh per rebuild.
//
// API:
//   initFromThreeMesh(threeMesh) → costruisce MeshDynamic dai dati del mesh
//   syncToThree()                → SculptGL → BufferGeometry (position/normal/index)
//   toBufferGeometry()           → crea BufferGeometry standalone da MeshDynamic
//                                  (usato dal test harness S1 e come difensivo)
//   getMeshDynamic()             → ritorna la MeshDynamic interna
//
// Attenzione `Mesh.OPTIMIZE`:
//   L'originale SculptGL fa reordering dei vertici via optimizePreTransform
//   (cache locality GPU) nel Mesh.init(). Questo cambierebbe l'ordine di
//   `_verticesXYZ` rispetto al `position.array` Three.js di origine →
//   syncToThree produrrebbe geometria visivamente identica MA con vertex
//   indices rimappati. Per mantenere la corrispondenza 1:1 con la
//   BufferGeometry Three.js source, IbexBridge disabilita Mesh.OPTIMIZE
//   alla prima initFromThreeMesh e lo ripristina al suo valore originale
//   a fine init (idempotente).
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import Mesh from './Mesh.js';
import MeshDynamic from './MeshDynamic.js';
import TransformDataFactory from './TransformData.js';
import createMeshData from './MeshData.js';
import Utils from './Utils.js';

export class IbexBridge {
    constructor() {
        this._meshDynamic = null;
        this._threeMesh   = null;
    }

    /**
     * Costruisce una MeshDynamic a partire da una THREE.Mesh esistente.
     * La MeshDynamic mantiene i vertici nello stesso ordine del BufferGeometry
     * source (Mesh.OPTIMIZE disabilitato temporaneamente — vedi nota sopra).
     *
     * @param {THREE.Mesh} threeMesh
     * @returns {MeshDynamic}
     */
    initFromThreeMesh(threeMesh) {
        if (!threeMesh || !threeMesh.geometry) {
            throw new Error('IbexBridge.initFromThreeMesh: threeMesh invalido');
        }
        const geom = threeMesh.geometry;
        const posAttr = geom.attributes.position;
        const idxAttr = geom.index;
        if (!posAttr) throw new Error('IbexBridge: geometry senza position attribute');

        const nbV = posAttr.count;
        // Copia positions in un Float32Array standalone (MeshDynamic mutate)
        const positions = new Float32Array(nbV * 3);
        if (posAttr.array instanceof Float32Array) {
            positions.set(posAttr.array.subarray(0, nbV * 3));
        } else {
            for (let i = 0; i < nbV * 3; i++) positions[i] = posAttr.array[i];
        }

        // Deriva i triangoli flat (Uint32Array) — indexed o non-indexed
        let trianglesFlat, nbT;
        if (idxAttr) {
            nbT = idxAttr.count / 3;
            // Normalizza in Uint32Array (può essere Uint16 o Uint32)
            trianglesFlat = new Uint32Array(nbT * 3);
            if (idxAttr.array instanceof Uint32Array) {
                trianglesFlat.set(idxAttr.array.subarray(0, nbT * 3));
            } else {
                for (let i = 0; i < nbT * 3; i++) trianglesFlat[i] = idxAttr.array[i];
            }
        } else {
            // Non-indexed: ogni tripletta di posizioni è un triangolo
            nbT = nbV / 3;
            trianglesFlat = new Uint32Array(nbV);
            for (let i = 0; i < nbV; i++) trianglesFlat[i] = i;
        }

        // _facesABCD quad-or-tri: 4-tuple con d=TRI_INDEX per triangoli
        const fAr = new Uint32Array(nbT * 4);
        for (let i = 0; i < nbT; i++) {
            const i3 = i * 3;
            const i4 = i * 4;
            fAr[i4]     = trianglesFlat[i3];
            fAr[i4 + 1] = trianglesFlat[i3 + 1];
            fAr[i4 + 2] = trianglesFlat[i3 + 2];
            fAr[i4 + 3] = Utils.TRI_INDEX;
        }

        // Seed Mesh: contenitore temporaneo per passare dati a MeshDynamic.
        // MeshDynamic.initFromMesh copia vertices/colors/materials e chiama
        // setFacesFromMesh che legge mesh.getTriangles() → dobbiamo popolare
        // _meshData._trianglesABC prima.
        const meshSeed = new Mesh();
        meshSeed._meshData = createMeshData();
        meshSeed._transformData = TransformDataFactory();
        meshSeed.setVertices(positions);
        meshSeed.setFaces(fAr);
        meshSeed.setNbVertices(nbV);
        meshSeed.setNbFaces(nbT);
        meshSeed._meshData._trianglesABC = trianglesFlat;
        // Inizializza colors/materials a default (altrimenti MeshDynamic.initFromMesh
        // chiama mesh.getColors() su null → crash).
        meshSeed.initColorsAndMaterials();

        // Disabilita Mesh.OPTIMIZE per preservare l'ordine vertici/facce del
        // BufferGeometry source → indici MeshDynamic coincidono con quelli Three.js.
        const savedOptimize = Mesh.OPTIMIZE;
        Mesh.OPTIMIZE = false;
        let meshDyn;
        try {
            meshDyn = new MeshDynamic(meshSeed);
            // MeshDynamic costruttore: initFromMesh → init() → initTopology →
            // initFaceRings → optimize (no-op con OPTIMIZE=false) → initEdges →
            // initVertexRings → initRenderTriangles → updateGeometry
            // → updateFacesAabbAndNormal + updateVerticesNormal + computeOctree
        } finally {
            Mesh.OPTIMIZE = savedOptimize;
        }

        this._meshDynamic = meshDyn;
        this._threeMesh   = threeMesh;
        return meshDyn;
    }

    /**
     * Copia lo stato corrente di MeshDynamic nel BufferGeometry Three.js.
     * Gestisce i casi:
     *   (a) count invariato → copy in-place + needsUpdate
     *   (b) count cambiato (post-dyntopo) → ricrea BufferAttribute
     * Invalida il boundsTree (BVH three-mesh-bvh) — rebuild lasciato al caller.
     */
    syncToThree() {
        if (!this._meshDynamic || !this._threeMesh) return;
        const meshDyn = this._meshDynamic;
        const geom    = this._threeMesh.geometry;

        const nbV = meshDyn.getNbVertices();
        const nbT = meshDyn.getNbTriangles();

        const verts = meshDyn.getVertices();  // Float32Array, over-allocated
        const norms = meshDyn.getNormals();   // Float32Array, over-allocated
        const tris  = meshDyn.getTriangles(); // Uint32Array, over-allocated

        // Position
        const posAttr = geom.attributes.position;
        if (posAttr && posAttr.count === nbV) {
            posAttr.array.set(verts.subarray(0, nbV * 3));
            posAttr.needsUpdate = true;
        } else {
            const arr = new Float32Array(nbV * 3);
            arr.set(verts.subarray(0, nbV * 3));
            geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        }

        // Normal
        const normAttr = geom.attributes.normal;
        if (normAttr && normAttr.count === nbV) {
            normAttr.array.set(norms.subarray(0, nbV * 3));
            normAttr.needsUpdate = true;
        } else {
            const arr = new Float32Array(nbV * 3);
            arr.set(norms.subarray(0, nbV * 3));
            geom.setAttribute('normal', new THREE.BufferAttribute(arr, 3));
        }

        // Index
        const idxAttr = geom.index;
        if (idxAttr && idxAttr.count === nbT * 3) {
            // idxAttr.array può essere Uint16 o Uint32. Se Uint16 ma tris
            // contiene indici > 65535 (mesh post-dyntopo molto dense),
            // abbiamo overflow silenzioso. Fallback difensivo: ricrea sempre
            // con Uint32 se il count matcha ma il typed array è Uint16.
            if (idxAttr.array instanceof Uint32Array) {
                idxAttr.array.set(tris.subarray(0, nbT * 3));
                idxAttr.needsUpdate = true;
            } else {
                const arr = new Uint32Array(nbT * 3);
                arr.set(tris.subarray(0, nbT * 3));
                geom.setIndex(new THREE.BufferAttribute(arr, 1));
            }
        } else {
            const arr = new Uint32Array(nbT * 3);
            arr.set(tris.subarray(0, nbT * 3));
            geom.setIndex(new THREE.BufferAttribute(arr, 1));
        }

        // BVH three-mesh-bvh: invalidato dal sync. Rebuild a mouseup
        // lato SculptMode (S2+). Qui non tocchiamo boundsTree per non
        // forzare un rebuild O(N log N) per-mousemove.
    }

    /**
     * Crea un BufferGeometry standalone da MeshDynamic.
     * Usato come difensivo / verifica S1. Non necessario in S2+ (syncToThree
     * mantiene la BufferGeometry Three.js direttamente allineata).
     */
    toBufferGeometry() {
        if (!this._meshDynamic) return null;
        const meshDyn = this._meshDynamic;
        const nbV = meshDyn.getNbVertices();
        const nbT = meshDyn.getNbTriangles();

        const g = new THREE.BufferGeometry();

        const posArr = new Float32Array(nbV * 3);
        posArr.set(meshDyn.getVertices().subarray(0, nbV * 3));
        g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));

        const nrmArr = new Float32Array(nbV * 3);
        nrmArr.set(meshDyn.getNormals().subarray(0, nbV * 3));
        g.setAttribute('normal', new THREE.BufferAttribute(nrmArr, 3));

        const idxArr = new Uint32Array(nbT * 3);
        idxArr.set(meshDyn.getTriangles().subarray(0, nbT * 3));
        g.setIndex(new THREE.BufferAttribute(idxArr, 1));

        return g;
    }

    getMeshDynamic() {
        return this._meshDynamic;
    }

    getThreeMesh() {
        return this._threeMesh;
    }
}
