// ═══════════════════════════════════════════════════════════════
// IBEX sculptgl/tools/Crease.js SculptGL_S4_V1.3 — cache-bust SculptBase V1.5 (cleanup)
//
// V1.1 (2026-04-27): bump import SculptBase V1.2 → V1.3. Cache-bust cascata.
//
// V1.0: porting da SculptGL (MIT, stephomi)
// Origine: /tmp/sculptgl/src/editing/tools/Crease.js
//
// Porting 1:1 rispetto all'originale, con 3 modifiche minime:
//   - Import `Tablet` da `'../stubs.js'` (pressione constant 1.0, come gli
//     altri tool IBEX).
//   - Import `SculptBase` con cache-bust `?v=SculptGL_S2_V1.2`.
//   - Falloff hardcoded `3t⁴-4t³+1` sostituito con
//     `SculptBase.computeFalloff(dist2, radiusSquared, type)`, type letto
//     da `mesh.constructor.FALLOFF_TYPE` → coerente con Brush/Flatten V1.1
//     e con il selettore UI del Obiettivo 1.
//
// Comportamento geometrico:
//   Crease applica DUE displacement sommati su ogni vert nel raggio:
//     (1) Pinch radiale: vert tirati verso il centro del brush
//         (`dx = center - vert` × fallOff × deformIntensity).
//     (2) Brush normale: displacement lungo la normale del punto di hit
//         con falloff a potenza 5 (`pow(fallOff, 5) * brushFactor`) → il
//         centro del brush si alza/affonda MOLTO di più del bordo.
//   Risultato: una "trincea" stretta (scavata o in rilievo a seconda di
//   `_negative`). Ideale per solchi sottili, spigoli, dettagli.
//
// `_negative` semantics (IBEX, allineato agli altri brush):
//   - false → brushFactor positivo → centro in rilievo (cresta)
//   - true  → brushFactor negativo → centro affondato (scavo)
//   NB: `_negative` inverte SOLO il brushFactor (componente normale).
//   Il pinch radiale resta invariato (vert sempre convergenti al centro).
// ═══════════════════════════════════════════════════════════════

import { Tablet } from '../stubs.js';
import SculptBase from './SculptBase.js?v=SculptGL_S2_V1.5';

class Crease extends SculptBase {

    constructor(main) {
        super(main);

        this._radius = 25;
        this._intensity = 0.75;
        this._negative = true;      // default SculptGL: scavo
        this._culling = false;
        this._idAlpha = 0;
        this._lockPosition = false; // passato a picking.updateAlpha (harmless se false)
    }

    stroke(picking) {
        var iVertsInRadius = picking.getPickedVertices();
        var intensity = this._intensity * Tablet.getPressureIntensity();

        this.updateProxy(iVertsInRadius);
        // undo-redo (no-op in IBEX: StateManager stub)
        this._main.getStateManager().pushVertices(iVertsInRadius);
        iVertsInRadius = this.dynamicTopology(picking);

        if (this._culling)
            iVertsInRadius = this.getFrontVertices(iVertsInRadius, picking.getEyeDirection());

        picking.updateAlpha(this._lockPosition);
        picking.setIdAlpha(this._idAlpha);
        this.crease(iVertsInRadius, picking.getPickedNormal(), picking.getIntersectionPoint(),
                    picking.getLocalRadius2(), intensity, picking);

        var mesh = this.getMesh();
        mesh.updateGeometry(mesh.getFacesFromVertices(iVertsInRadius), iVertsInRadius);
    }

    /** Pinch radiale + brush normale con falloff^5 (SculptGL "pinch+brush-like"). */
    crease(iVertsInRadius, aNormal, center, radiusSquared, intensity, picking) {
        var mesh = this.getMesh();
        var vAr = mesh.getVertices();
        var mAr = mesh.getMaterials();
        var vProxy = mesh.getVerticesProxy();
        var radius = Math.sqrt(radiusSquared);
        var cx = center[0];
        var cy = center[1];
        var cz = center[2];
        var anx = aNormal[0];
        var any = aNormal[1];
        var anz = aNormal[2];
        var deformIntensity = intensity * 0.07;
        var brushFactor = deformIntensity * radius;
        if (this._negative)
            brushFactor = -brushFactor;
        var falloffType = mesh.constructor.FALLOFF_TYPE || 'smooth';
        for (var i = 0, l = iVertsInRadius.length; i < l; ++i) {
            var ind = iVertsInRadius[i] * 3;
            var dx = cx - vProxy[ind];
            var dy = cy - vProxy[ind + 1];
            var dz = cz - vProxy[ind + 2];
            var dist2 = dx * dx + dy * dy + dz * dz;
            if (dist2 >= radiusSquared)
                continue;
            var vx = vAr[ind];
            var vy = vAr[ind + 1];
            var vz = vAr[ind + 2];
            var fallOff = SculptBase.computeFalloff(dist2, radiusSquared, falloffType);
            fallOff *= mAr[ind + 2] * picking.getAlpha(vx, vy, vz);
            // brushModifier = falloff^5 × brushFactor (lungo normale, molto
            // concentrato al centro). Pinch radiale: dx/dy/dz × (fallOff × deformIntensity).
            var brushModifier = Math.pow(fallOff, 5) * brushFactor;
            fallOff *= deformIntensity;
            vAr[ind]     = vx + dx * fallOff + anx * brushModifier;
            vAr[ind + 1] = vy + dy * fallOff + any * brushModifier;
            vAr[ind + 2] = vz + dz * fallOff + anz * brushModifier;
        }
    }
}

export default Crease;
