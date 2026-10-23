// ═══════════════════════════════════════════════════════════════
// IBEX sculptgl/tools/Brush.js SculptGL_S2_V1.4 — cache-bust SculptBase V1.5 (cleanup)
//
// V1.2 (2026-04-27): bump import SculptBase V1.2 → V1.3 (3 tipi falloff:
//   smooth/sharp/cylinder, rimossi linear/sphere). Nessun cambio logica —
//   solo cascata cache-bust per forzare browser a ricaricare SculptBase.
// Origine: /tmp/sculptgl/src/editing/tools/Brush.js
//
// V1.1 (2026-04-27): sostituito il falloff hardcoded `3t⁴-4t³+1` con
//   `SculptBase.computeFalloff(dist2, radiusSquared, type)`. Il tipo viene
//   letto da `mesh.constructor.FALLOFF_TYPE` (MeshDynamic static, default
//   'smooth' → identico al precedente). Comportamento push/pull invariato
//   con FALLOFF_TYPE='smooth' (default). Altri tipi: 'linear', 'sphere',
//   'sharp' — vedi SculptBase.computeFalloff.
//
// Modifiche rispetto all'originale:
//   - Import Tablet da '../stubs.js' (pressione constant 1.0)
//   - Import Flatten da './Flatten.js' — usato in clay mode
//   - `_clay: false` di default (A6): push/pull usano il pattern "brush
//     lungo area-normal senza clay offset"; il clay mode resta opzionale
//     in S3+ via toggle user. Semplifica Sessione 2.
// ═══════════════════════════════════════════════════════════════

import { vec3 } from 'gl-matrix';
import { Tablet } from '../stubs.js';
import SculptBase from './SculptBase.js?v=SculptGL_S2_V1.5';
import Flatten from './Flatten.js';

class Brush extends SculptBase {

    constructor(main) {
        super(main);

        this._radius = 50;
        this._intensity = 0.5;
        this._negative = false;
        this._clay = false;   // IBEX default: no clay (A6 — push/pull semplici)
        this._culling = false;
        this._accumulate = true;
        this._idAlpha = 0;
    }

    stroke(picking) {
        var iVertsInRadius = picking.getPickedVertices();
        var intensity = this._intensity * Tablet.getPressureIntensity();

        if (!this._accumulate)
            this.updateProxy(iVertsInRadius);
        this._main.getStateManager().pushVertices(iVertsInRadius);
        iVertsInRadius = this.dynamicTopology(picking);

        var iVertsFront = this.getFrontVertices(iVertsInRadius, picking.getEyeDirection());
        if (this._culling)
            iVertsInRadius = iVertsFront;

        var r2 = picking.getLocalRadius2();
        picking.updateAlpha(false);
        picking.setIdAlpha(this._idAlpha);

        if (!this._clay) {
            this.brush(iVertsInRadius, picking.getPickedNormal(), picking.getIntersectionPoint(), r2, intensity, picking);
        } else {
            var aNormal = this.areaNormal(iVertsFront);
            if (!aNormal)
                return;
            var aCenter = this.areaCenter(iVertsFront);
            var off = Math.sqrt(r2) * 0.1;
            vec3.scaleAndAdd(aCenter, aCenter, aNormal, this._negative ? -off : off);
            Flatten.prototype.flatten.call(this, iVertsInRadius, aNormal, aCenter, picking.getIntersectionPoint(), r2, intensity, picking);
        }

        var mesh = this.getMesh();
        mesh.updateGeometry(mesh.getFacesFromVertices(iVertsInRadius), iVertsInRadius);
    }

    brush(iVertsInRadius, aNormal, center, radiusSquared, intensity, picking) {
        var mesh = this.getMesh();
        var vAr = mesh.getVertices();
        var mAr = mesh.getMaterials();
        var vProxy = this._accumulate ? vAr : mesh.getVerticesProxy();
        var radius = Math.sqrt(radiusSquared);
        var deformIntensityBrush = intensity * radius * 0.1;
        if (this._negative)
            deformIntensityBrush = -deformIntensityBrush;
        var cx = center[0];
        var cy = center[1];
        var cz = center[2];
        var anx = aNormal[0];
        var any = aNormal[1];
        var anz = aNormal[2];
        // V1.1: falloff type letto una volta fuori dal loop (hot path).
        var falloffType = mesh.constructor.FALLOFF_TYPE || 'smooth';
        for (var i = 0, l = iVertsInRadius.length; i < l; ++i) {
            var ind = iVertsInRadius[i] * 3;
            var dx = vProxy[ind] - cx;
            var dy = vProxy[ind + 1] - cy;
            var dz = vProxy[ind + 2] - cz;
            var dist2 = dx * dx + dy * dy + dz * dz;
            if (dist2 >= radiusSquared)
                continue;
            var vx = vAr[ind];
            var vy = vAr[ind + 1];
            var vz = vAr[ind + 2];
            var fallOff = SculptBase.computeFalloff(dist2, radiusSquared, falloffType);
            fallOff *= mAr[ind + 2] * deformIntensityBrush * picking.getAlpha(vx, vy, vz);
            vAr[ind] = vx + anx * fallOff;
            vAr[ind + 1] = vy + any * fallOff;
            vAr[ind + 2] = vz + anz * fallOff;
        }
    }
}

export default Brush;
