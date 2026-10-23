// ═══════════════════════════════════════════════════════════════
// IBEX sculptgl/tools/SculptBase.js SculptGL_S2_V1.5 — cleanup diag logs
// Origine: /tmp/sculptgl/src/editing/tools/SculptBase.js
//
// V1.5 (2026-04-27): rimossi i 4 console.log diagnostici introdotti in V1.4
//   ([DYNTOPO STROKE], [DYNTOPO CLASS CHECK], [PRE-DYNTOPO], [POST-DYNTOPO]).
//   I log hanno svolto il loro ruolo identificando il bug ESM "duplicazione
//   classe MeshDynamic" risolto da SculptMode V2.17 (vedi header SculptMode +
//   §18 invariante 101 + Cleanup storici 2026-04-27).
//
// V1.4 (2026-04-27): aggiunti console.log diagnostici TEMPORANEI in
//   `dynamicTopology` per debug Simplify/dyntopo. Tag: [DYNTOPO STROKE],
//   [DYNTOPO CLASS CHECK], [PRE-DYNTOPO], [POST-DYNTOPO]. Output in produzione
//   ha esposto: scrittura `MeshDynamic.TARGET_EDGE_LEN = 0.3` da SculptMode →
//   lettura `mesh.constructor.TARGET_EDGE_LEN = 0.5` da dynamicTopology, cioè
//   2 classi distinte di stesso nome con storage statico disgiunto. Causa: ESM
//   trattava `?v=SculptGL_S1_V1.2` (SculptMode) e bare URL (IbexBridge) come
//   moduli separati. Fix: import bare in entrambi.
//
// V1.3 (2026-04-27):
//   - `computeFalloff`: rimossi i rami `linear` e `sphere` (cos). Aggiunto
//     `cylinder` (lineare, = ex-linear). UI finale a 3 tipi:
//       smooth   → 3t⁴ - 4t³ + 1 (C¹ smoothstep, U-curve)
//       sharp    → (1 - t)²       (quadratico inverso, V-curve)
//       cylinder → 1 - t          (lineare, attenuazione costante)
//     Default case rimane `smooth`. Migrazione valori legacy salvati:
//     `'linear' → 'cylinder'`, `'sphere' → 'smooth'` avviene in
//     SculptMode.enter() (V2.12) per preservare highlight UI coerente.
//
// V1.2 (2026-04-27): falloff centralizzato via `computeFalloff(dist2, r2, type)`
//   + `MeshDynamic.FALLOFF_TYPE`. 4 rami: smooth, linear, sphere, sharp.
// V1.1 (TARGET_EDGE_LEN): dynamicTopology usa mesh.constructor.TARGET_EDGE_LEN.
//
// Modifiche rispetto all'originale:
//   - Rimosso SYMMETRY: `pickingSym` parametri in `makeStroke` → un solo
//     `picking`. Rimosso anche il controllo `main.getSculptManager().getSymmetry()`.
//   - Rimosso CONTINUOUS UPDATE: `updateContinuous` + `preUpdate` + callback
//     `_cbContinuous` + `_lockPosition`.
//   - Rimosso `updateSculptLock` (lock position mode).
//   - `updateMeshBuffers` → no-op (il sync a Three.js lo fa SculptMode
//     dopo la chiamata a `sculptStroke`). A3.
//   - `end()` rimosso — `balanceOctree` viene invocato da SculptMode alla
//     fine del finalizeStroke se serve.
//   - Mantenuto INVARIATO: stroke spacing (A4), `dynamicTopology` (sarà
//     attivato in S3 via brush params), `laplacianSmooth`, `getFrontVertices`,
//     `areaNormal`, `areaCenter`, `updateProxy`, mask filtering.
// ═══════════════════════════════════════════════════════════════

import { Enums } from '../stubs.js';
import Utils from '../Utils.js';

class SculptBase {

    constructor(main) {
        this._main = main;
        this._lastMouseX = 0.0;
        this._lastMouseY = 0.0;
    }

    setToolMesh(mesh) {
        this._forceToolMesh = mesh;
    }

    getMesh() {
        return this._forceToolMesh || this._main.getMesh();
    }

    start(ctrl) {
        var main = this._main;
        var picking = main.getPicking();

        if (!picking.intersectionMouseMeshes())
            return false;

        var mesh = main.setOrUnsetMesh(picking.getMesh(), ctrl);
        if (!mesh)
            return false;

        picking.initAlpha();

        this.pushState();
        this._lastMouseX = main._mouseX;
        this._lastMouseY = main._mouseY;
        this.startSculpt();

        return true;
    }

    pushState() {
        this._main.getStateManager().pushStateGeometry(this.getMesh());
    }

    startSculpt() {
        this.sculptStroke();
    }

    update(_continuous) {
        this.sculptStroke();
    }

    sculptStroke() {
        var main = this._main;
        var picking = main.getPicking();

        var dx = main._mouseX - this._lastMouseX;
        var dy = main._mouseY - this._lastMouseY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var minSpacing = 0.15 * this._radius * main.getPixelRatio();

        if (dist <= minSpacing)
            return;

        var step = 1.0 / Math.floor(dist / minSpacing);
        dx *= step;
        dy *= step;
        var mouseX = this._lastMouseX + dx;
        var mouseY = this._lastMouseY + dy;

        for (var i = step; i <= 1.0; i += step) {
            if (!this.makeStroke(mouseX, mouseY, picking))
                break;
            mouseX += dx;
            mouseY += dy;
        }

        this.updateRender();

        this._lastMouseX = main._mouseX;
        this._lastMouseY = main._mouseY;
    }

    updateRender() {
        this.updateMeshBuffers();
        this._main.render();
    }

    makeStroke(mouseX, mouseY, picking) {
        var mesh = this.getMesh();
        picking.intersectionMouseMesh(mesh, mouseX, mouseY);
        var pick1 = picking.getMesh();
        if (pick1) {
            picking.pickVerticesInSphere(picking.getLocalRadius2());
            picking.computePickedNormal();
        }
        // In SculptGL originale: se dynTopo attivo, raccoglie picking e stroke
        // insieme. Noi attivamo dyntopo in S3 tramite il brush stesso — il
        // flow resta identico: stroke() riceve picking e fa il lavoro.
        if (pick1) this.stroke(picking, false);
        return !!pick1;
    }

    updateMeshBuffers() {
        // No-op: il sync a Three.js BufferGeometry viene fatto da SculptMode
        // dopo ogni chiamata a sculptStroke (strategia A3 — sync per-mousemove).
    }

    /** Return the vertices that point toward the camera */
    getFrontVertices(iVertsInRadius, eyeDir) {
        var nbVertsSelected = iVertsInRadius.length;
        var iVertsFront = new Uint32Array(Utils.getMemory(4 * nbVertsSelected), 0, nbVertsSelected);
        var acc = 0;
        var nAr = this.getMesh().getNormals();
        var eyeX = eyeDir[0];
        var eyeY = eyeDir[1];
        var eyeZ = eyeDir[2];
        for (var i = 0; i < nbVertsSelected; ++i) {
            var id = iVertsInRadius[i];
            var j = id * 3;
            if ((nAr[j] * eyeX + nAr[j + 1] * eyeY + nAr[j + 2] * eyeZ) <= 0.0)
                iVertsFront[acc++] = id;
        }
        return new Uint32Array(iVertsFront.subarray(0, acc));
    }

    /** Compute average normal of a group of vertices with culling */
    areaNormal(iVerts) {
        var mesh = this.getMesh();
        var nAr = mesh.getNormals();
        var mAr = mesh.getMaterials();
        var anx = 0.0;
        var any = 0.0;
        var anz = 0.0;
        for (var i = 0, l = iVerts.length; i < l; ++i) {
            var ind = iVerts[i] * 3;
            var f = mAr[ind + 2];
            anx += nAr[ind] * f;
            any += nAr[ind + 1] * f;
            anz += nAr[ind + 2] * f;
        }
        var len = Math.sqrt(anx * anx + any * any + anz * anz);
        if (len === 0.0)
            return;
        len = 1.0 / len;
        return [anx * len, any * len, anz * len];
    }

    /** Compute average center of a group of vertices (with culling) */
    areaCenter(iVerts) {
        var mesh = this.getMesh();
        var vAr = mesh.getVertices();
        var mAr = mesh.getMaterials();
        var nbVerts = iVerts.length;
        var ax = 0.0;
        var ay = 0.0;
        var az = 0.0;
        var acc = 0;
        for (var i = 0; i < nbVerts; ++i) {
            var ind = iVerts[i] * 3;
            var f = mAr[ind + 2];
            acc += f;
            ax += vAr[ind] * f;
            ay += vAr[ind + 1] * f;
            az += vAr[ind + 2] * f;
        }
        return [ax / acc, ay / acc, az / acc];
    }

    /** Updates the vertices original coords that are sculpted for the first time in this stroke */
    updateProxy(iVerts) {
        var mesh = this.getMesh();
        var vAr = mesh.getVertices();
        var vProxy = mesh.getVerticesProxy();
        if (vAr === vProxy)
            return;
        var vertStateFlags = mesh.getVerticesStateFlags();
        var stateFlag = Utils.STATE_FLAG;
        for (var i = 0, l = iVerts.length; i < l; ++i) {
            var id = iVerts[i];
            if (vertStateFlags[id] !== stateFlag) {
                var ind = id * 3;
                vProxy[ind] = vAr[ind];
                vProxy[ind + 1] = vAr[ind + 1];
                vProxy[ind + 2] = vAr[ind + 2];
            }
        }
    }

    /** Laplacian smooth. Special rule for vertex on the edge of the mesh. */
    laplacianSmooth(iVerts, smoothVerts, vField) {
        var mesh = this.getMesh();
        var vrvStartCount = mesh.getVerticesRingVertStartCount();
        var vertRingVert = mesh.getVerticesRingVert();
        var ringVerts = vertRingVert instanceof Array ? vertRingVert : null;
        var vertOnEdge = mesh.getVerticesOnEdge();
        var vAr = vField || mesh.getVertices();
        var nbVerts = iVerts.length;

        for (var i = 0; i < nbVerts; ++i) {
            var i3 = i * 3;
            var id = iVerts[i];

            var start, end;
            if (ringVerts) {
                vertRingVert = ringVerts[id];
                start = 0;
                end = vertRingVert.length;
            } else {
                start = vrvStartCount[id * 2];
                end = start + vrvStartCount[id * 2 + 1];
            }

            var idv = 0;
            var vcount = end - start;
            if (vcount <= 2) {
                idv = id * 3;
                smoothVerts[i3] = vAr[idv];
                smoothVerts[i3 + 1] = vAr[idv + 1];
                smoothVerts[i3 + 2] = vAr[idv + 2];
                continue;
            }

            var avx = 0.0;
            var avy = 0.0;
            var avz = 0.0;
            var j = 0;

            if (vertOnEdge[id] === 1) {
                var nbVertEdge = 0;
                for (j = start; j < end; ++j) {
                    idv = vertRingVert[j];
                    if (vertOnEdge[idv] === 1) {
                        idv *= 3;
                        avx += vAr[idv];
                        avy += vAr[idv + 1];
                        avz += vAr[idv + 2];
                        ++nbVertEdge;
                    }
                }

                if (nbVertEdge >= 2) {
                    smoothVerts[i3] = avx / nbVertEdge;
                    smoothVerts[i3 + 1] = avy / nbVertEdge;
                    smoothVerts[i3 + 2] = avz / nbVertEdge;
                    continue;
                }
                avx = avy = avz = 0.0;
            }

            for (j = start; j < end; ++j) {
                idv = vertRingVert[j] * 3;
                avx += vAr[idv];
                avy += vAr[idv + 1];
                avz += vAr[idv + 2];
            }

            smoothVerts[i3] = avx / vcount;
            smoothVerts[i3 + 1] = avy / vcount;
            smoothVerts[i3 + 2] = avz / vcount;
        }
    }

    dynamicTopology(picking) {
        var mesh = this.getMesh();
        var iVerts = picking.getPickedVertices();
        if (!mesh.isDynamic)
            return iVerts;

        var subFactor = mesh.getSubdivisionFactor();
        var decFactor = mesh.getDecimationFactor();
        if (subFactor === 0.0 && decFactor === 0.0)
            return iVerts;

        if (iVerts.length === 0) {
            iVerts = mesh.getVerticesFromFaces([picking.getPickedFace()]);
            this._main.getStateManager().pushVertices(iVerts);
        }

        var iFaces = mesh.getFacesFromVertices(iVerts);
        var radius2 = picking.getLocalRadius2();
        var center = picking.getIntersectionPoint();
        // IBEX deviazione da SculptGL: soglie split/collapse derivano da
        // MeshDynamic.TARGET_EDGE_LEN (mm) invece che dal radius brush. Accesso
        // via prototype chain (mesh.constructor.TARGET_EDGE_LEN) — indipendente
        // dall'identità URL del modulo MeshDynamic caricato dall'importer.
        var targetEdge = mesh.constructor.TARGET_EDGE_LEN;
        var d2Max = targetEdge * targetEdge;
        var d2Min = d2Max * 0.25; // collapse quando edge < target/2

        this._main.getStateManager().pushFaces(iFaces);
        if (subFactor)
            iFaces = mesh.subdivide(iFaces, center, radius2, d2Max, this._main.getStateManager());
        if (decFactor)
            iFaces = mesh.decimate(iFaces, center, radius2, d2Min, this._main.getStateManager());
        iVerts = mesh.getVerticesFromFaces(iFaces);

        var nbVerts = iVerts.length;
        var sculptFlag = Utils.SCULPT_FLAG;
        var vscf = mesh.getVerticesSculptFlags();
        var iVertsInRadius = new Uint32Array(Utils.getMemory(nbVerts * 4), 0, nbVerts);
        var acc = 0;
        for (var i = 0; i < nbVerts; ++i) {
            var iVert = iVerts[i];
            if (vscf[iVert] === sculptFlag)
                iVertsInRadius[acc++] = iVert;
        }

        iVertsInRadius = new Uint32Array(iVertsInRadius.subarray(0, acc));
        mesh.updateTopology(iFaces, iVerts);
        mesh.updateGeometry(iFaces, iVerts);

        return iVertsInRadius;
    }

    getUnmaskedVertices() {
        return this.filterMaskedVertices(0.0, Infinity);
    }

    getMaskedVertices() {
        return this.filterMaskedVertices(-Infinity, 1.0);
    }

    filterMaskedVertices(lowerBound = -Infinity, upperBound = Infinity) {
        var mesh = this.getMesh();
        var mAr = mesh.getMaterials();
        var nbVertices = mesh.getNbVertices();
        var cleaned = new Uint32Array(Utils.getMemory(4 * nbVertices), 0, nbVertices);
        var acc = 0;
        for (var i = 0; i < nbVertices; ++i) {
            var mask = mAr[i * 3 + 2];
            if (mask > lowerBound && mask < upperBound)
                cleaned[acc++] = i;
        }
        return new Uint32Array(cleaned.subarray(0, acc));
    }

    getScreenRadius() {
        return (this._radius || 1) * this._main.getPixelRatio();
    }

    // ─────────────────────────────────────────────────────────────
    // Falloff radiale centralizzato (V1.2)
    //
    // Input: dist² (non normalizzata), radius² (quadrato del raggio brush),
    //        type (string: 'smooth' | 'linear' | 'sphere' | 'sharp').
    // Output: scalar in [0, 1]. Chiamato da Brush.brush, Flatten.flatten,
    //         Crease.crease, Inflate.inflate dentro il loop per vert.
    //
    // Curve:
    //   smooth (default, identica a SculptGL originale):
    //     f(t) = 3t⁴ − 4t³ + 1           t = sqrt(dist²/radius²)
    //     C¹ smoothstep, f(0)=1, f(1)=0, derivata nulla agli estremi.
    //   linear:
    //     f(t) = 1 − t
    //     Decrescita lineare.
    //   sphere (coseno):
    //     f(t) = cos(t · π/2)
    //     Più morbido ai bordi, pieno al centro.
    //   sharp (quadratico inverso):
    //     f(t) = (1 − t)²
    //     Molto concentrato al centro, cala rapidamente.
    //
    // `t` non viene clampato: il caller DEVE garantire `dist² < radius²`
    // (check `if (dist2 >= radius2) continue;` nel loop chiamante).
    // ─────────────────────────────────────────────────────────────
    static computeFalloff(dist2, radius2, type) {
        const t = Math.sqrt(dist2 / radius2);
        switch (type) {
            case 'cylinder':
                return 1 - t;       // lineare / cilindro
            case 'sharp': {
                const u = 1 - t;
                return u * u;       // V-curve, quadratico inverso
            }
            case 'smooth':
            default: {
                const t2 = t * t;
                return 3 * t2 * t2 - 4 * t2 * t + 1;  // U-curve, smoothstep
            }
        }
    }
}

export default SculptBase;
