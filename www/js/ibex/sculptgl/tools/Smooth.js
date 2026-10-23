// ═══════════════════════════════════════════════════════════════
// IBEX sculptgl/tools/Smooth.js SculptGL_S3_V1.4 — cache-bust SculptBase V1.5 (cleanup)
//
// V1.2 (2026-04-27): bump import SculptBase V1.1 → V1.3. Cache-bust cascata.
// (Smooth.js non usa computeFalloff — laplacian puro — ma cache-bust serve
// per coerenza del modulo importato.)
//
// Porting da SculptGL (MIT, stephomi)
// Origine: /tmp/sculptgl/src/editing/tools/Smooth.js
//
// Sostituisce lo stub S1. Porting 1:1 tranne import Tablet da '../stubs.js'.
//
// Usato da:
//   - SculptMode.js (brush type === 'smooth')
//   - Subdivision.js (post-split smoothTangent sui nuovi verts)
// ═══════════════════════════════════════════════════════════════

import Utils from '../Utils.js';
import { Tablet } from '../stubs.js';
import SculptBase from './SculptBase.js?v=SculptGL_S2_V1.5';

class Smooth extends SculptBase {

    constructor(main) {
        super(main);

        this._radius = 50;
        this._intensity = 0.75;
        this._culling = false;
        this._tangent = false;
        this._idAlpha = 0;
    }

    stroke(picking) {
        var iVertsInRadius = picking.getPickedVertices();
        var intensity = this._intensity * Tablet.getPressureIntensity();

        this._main.getStateManager().pushVertices(iVertsInRadius);

        // IBEX S3 deviazione da SculptGL originale: Smooth chiama dynamicTopology
        // (split only, DECIMATION_FACTOR=0 → evita chain collapse/tombstone=fori,
        // gestito da SculptMode._applyDyntopoConfig con check brush.type).
        // SculptBase.dynamicTopology early-returns se subFactor=0 → no dyntopo
        // quando l'utente non l'ha attivato. Quindi il flag user-facing `dyntopo`
        // controlla effettivamente l'attivazione.
        iVertsInRadius = this.dynamicTopology(picking);

        if (this._culling)
            iVertsInRadius = this.getFrontVertices(iVertsInRadius, picking.getEyeDirection());

        picking.updateAlpha(false);
        picking.setIdAlpha(this._idAlpha);
        if (this._tangent) this.smoothTangent(iVertsInRadius, intensity, picking);
        else this.smooth(iVertsInRadius, intensity, picking);

        var mesh = this.getMesh();
        mesh.updateGeometry(mesh.getFacesFromVertices(iVertsInRadius), iVertsInRadius);
    }

    /** Smooth a group of vertices. New position is given by simple averaging */
    smooth(iVerts, intensity, picking) {
        var mesh = this.getMesh();
        var vAr = mesh.getVertices();
        var mAr = mesh.getMaterials();
        var nbVerts = iVerts.length;

        var smoothVerts = new Float32Array(Utils.getMemory(nbVerts * 4 * 3), 0, nbVerts * 3);
        this.laplacianSmooth(iVerts, smoothVerts);

        for (var i = 0; i < nbVerts; ++i) {
            var ind = iVerts[i] * 3;
            var vx = vAr[ind];
            var vy = vAr[ind + 1];
            var vz = vAr[ind + 2];
            var i3 = i * 3;
            var mIntensity = intensity * mAr[ind + 2];
            if (picking)
                mIntensity *= picking.getAlpha(vx, vy, vz);
            var intComp = 1.0 - mIntensity;
            vAr[ind] = vx * intComp + smoothVerts[i3] * mIntensity;
            vAr[ind + 1] = vy * intComp + smoothVerts[i3 + 1] * mIntensity;
            vAr[ind + 2] = vz * intComp + smoothVerts[i3 + 2] * mIntensity;
        }
    }

    /** Smooth a group of vertices. Reproject the position on each vertex normals plane */
    smoothTangent(iVerts, intensity, picking) {
        var mesh = this.getMesh();
        var vAr = mesh.getVertices();
        var mAr = mesh.getMaterials();
        var nAr = mesh.getNormals();
        var nbVerts = iVerts.length;

        var smoothVerts = new Float32Array(Utils.getMemory(nbVerts * 4 * 3), 0, nbVerts * 3);
        this.laplacianSmooth(iVerts, smoothVerts);

        for (var i = 0; i < nbVerts; ++i) {
            var ind = iVerts[i] * 3;
            var vx = vAr[ind];
            var vy = vAr[ind + 1];
            var vz = vAr[ind + 2];
            var nx = nAr[ind];
            var ny = nAr[ind + 1];
            var nz = nAr[ind + 2];
            var len = nx * nx + ny * ny + nz * nz;
            if (len === 0.0)
                continue;
            len = 1.0 / Math.sqrt(len);
            nx *= len;
            ny *= len;
            nz *= len;
            var i3 = i * 3;
            var smx = smoothVerts[i3];
            var smy = smoothVerts[i3 + 1];
            var smz = smoothVerts[i3 + 2];
            var dot = nx * (smx - vx) + ny * (smy - vy) + nz * (smz - vz);
            var mIntensity = intensity * mAr[ind + 2];
            if (picking)
                mIntensity *= picking.getAlpha(vx, vy, vz);
            vAr[ind] = vx + (smx - nx * dot - vx) * mIntensity;
            vAr[ind + 1] = vy + (smy - ny * dot - vy) * mIntensity;
            vAr[ind + 2] = vz + (smz - nz * dot - vz) * mIntensity;
        }
    }

    /** Smooth a group of vertices along their normals */
    smoothAlongNormals(iVerts, intensity, picking) {
        var mesh = this.getMesh();
        var vAr = mesh.getVertices();
        var mAr = mesh.getMaterials();
        var nAr = mesh.getNormals();
        var nbVerts = iVerts.length;

        var smoothVerts = new Float32Array(Utils.getMemory(nbVerts * 4 * 3), 0, nbVerts * 3);
        this.laplacianSmooth(iVerts, smoothVerts);

        for (var i = 0; i < nbVerts; ++i) {
            var ind = iVerts[i] * 3;
            var vx = vAr[ind];
            var vy = vAr[ind + 1];
            var vz = vAr[ind + 2];
            var nx = nAr[ind];
            var ny = nAr[ind + 1];
            var nz = nAr[ind + 2];
            var i3 = i * 3;
            var len = 1.0 / ((nx * nx + ny * ny + nz * nz));
            var dot = nx * (smoothVerts[i3] - vx) + ny * (smoothVerts[i3 + 1] - vy) + nz * (smoothVerts[i3 + 2] - vz);
            dot *= len * intensity * mAr[ind + 2];
            if (picking)
                dot *= picking.getAlpha(vx, vy, vz);
            vAr[ind] = vx + nx * dot;
            vAr[ind + 1] = vy + ny * dot;
            vAr[ind + 2] = vz + nz * dot;
        }
    }
}

export default Smooth;
