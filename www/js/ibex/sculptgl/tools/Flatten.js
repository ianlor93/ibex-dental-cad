// ═══════════════════════════════════════════════════════════════
// IBEX sculptgl/tools/Flatten.js SculptGL_S2_V1.4 — cache-bust SculptBase V1.5 (cleanup)
//
// V1.2 (2026-04-27): bump import SculptBase V1.2 → V1.3. Cache-bust cascata.
// Origine: /tmp/sculptgl/src/editing/tools/Flatten.js
//
// V1.1 (2026-04-27): sostituito il falloff hardcoded con
//   `SculptBase.computeFalloff(dist2, radiusSquared, type)`. Tipo letto da
//   `mesh.constructor.FALLOFF_TYPE`. Comportamento invariato con default.
//
// Modifiche rispetto all'originale:
//   - Import Tablet da '../stubs.js' (pressione constant 1.0)
// ═══════════════════════════════════════════════════════════════

import { Tablet } from '../stubs.js';
import SculptBase from './SculptBase.js?v=SculptGL_S2_V1.5';

class Flatten extends SculptBase {

    constructor(main) {
        super(main);

        this._radius = 50;
        this._intensity = 0.75;
        this._negative = true;
        this._culling = false;
        this._idAlpha = 0;
    }

    stroke(picking) {
        var iVertsInRadius = picking.getPickedVertices();
        var intensity = this._intensity * Tablet.getPressureIntensity();

        this._main.getStateManager().pushVertices(iVertsInRadius);
        iVertsInRadius = this.dynamicTopology(picking);

        var iVertsFront = this.getFrontVertices(iVertsInRadius, picking.getEyeDirection());
        if (this._culling)
            iVertsInRadius = iVertsFront;

        var aNormal = this.areaNormal(iVertsFront);
        if (!aNormal)
            return;
        var aCenter = this.areaCenter(iVertsFront);
        picking.updateAlpha(false);
        picking.setIdAlpha(this._idAlpha);
        this.flatten(iVertsInRadius, aNormal, aCenter, picking.getIntersectionPoint(), picking.getLocalRadius2(), intensity, picking);

        var mesh = this.getMesh();
        mesh.updateGeometry(mesh.getFacesFromVertices(iVertsInRadius), iVertsInRadius);
    }

    /** Flatten, projection of the sculpting vertex onto a plane defined by the barycenter and normals of all the sculpting vertices */
    flatten(iVertsInRadius, aNormal, aCenter, center, radiusSquared, intensity, picking) {
        var mesh = this.getMesh();
        var vAr = mesh.getVertices();
        var mAr = mesh.getMaterials();
        var radius = Math.sqrt(radiusSquared);
        var vProxy = vAr;  // _accumulate default true nel caller IBEX
        var cx = center[0];
        var cy = center[1];
        var cz = center[2];
        var ax = aCenter[0];
        var ay = aCenter[1];
        var az = aCenter[2];
        var anx = aNormal[0];
        var any = aNormal[1];
        var anz = aNormal[2];
        var comp = this._negative ? -1.0 : 1.0;
        // V1.1: falloff type letto una volta fuori dal loop.
        var falloffType = mesh.constructor.FALLOFF_TYPE || 'smooth';
        for (var i = 0, l = iVertsInRadius.length; i < l; ++i) {
            var ind = iVertsInRadius[i] * 3;
            var vx = vAr[ind];
            var vy = vAr[ind + 1];
            var vz = vAr[ind + 2];
            var distToPlane = (vx - ax) * anx + (vy - ay) * any + (vz - az) * anz;
            if (distToPlane * comp > 0.0)
                continue;
            var dx = vProxy[ind] - cx;
            var dy = vProxy[ind + 1] - cy;
            var dz = vProxy[ind + 2] - cz;
            var dist2 = dx * dx + dy * dy + dz * dz;
            if (dist2 >= radiusSquared)
                continue;
            var fallOff = SculptBase.computeFalloff(dist2, radiusSquared, falloffType);
            fallOff *= distToPlane * intensity * mAr[ind + 2] * picking.getAlpha(vx, vy, vz);
            vAr[ind] -= anx * fallOff;
            vAr[ind + 1] -= any * fallOff;
            vAr[ind + 2] -= anz * fallOff;
        }
    }
}

export default Flatten;
