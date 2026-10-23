// ═══════════════════════════════════════════════════════════════
// IBEX sculptgl/tools/Inflate.js SculptGL_S4_V1.4 — cache-bust SculptBase V1.5 (cleanup)
//
// V1.2 (2026-04-27): bump import SculptBase V1.2 → V1.3. Cache-bust cascata.
// V1.1 (2026-04-27): blend vs area normal
//
// V1.1 (2026-04-27, fix rugosità):
//   Il V1.0 puro "per-vertex normal" causava "zone rugose" su scansioni
//   dentali: le normali di vert adiacenti divergono di qualche grado per
//   micro-rumore di scansione / dettaglio fine; spostando ciascun vert
//   lungo la propria normale le divergenze si AMPLIFICANO ad ogni stroke
//   → superficie sempre più frattalata.
//
//   Fix: blend pesato tra normale per-vertex (60%) e area normal smoothata
//   (40%, media pesata delle normali del cluster via `SculptBase.areaNormal`).
//   Il 40% di smooth attenua il rumore high-frequency ma lascia l'Inflate
//   seguire la curvatura globale della superficie (diverso da Brush che usa
//   area=100% e non segue la curvatura affatto).
//
//   Blend:
//     blend = 0.6   → 60% per-vertex + 40% area smoothata
//     risultato = normalize(blend * nPerVertex + (1-blend) * nArea)
//
// V1.0: Nuovo brush Inflate — displacement lungo la normale PER-VERTEX di
//   ogni vert colpito, letta da `mesh.getNormals()`. Versione "pura" che
//   ha causato rugosità in produzione. Superata da V1.1.
//
//   `_negative = false` → gonfia (vert si espandono lungo +normale).
//   `_negative = true`  → contrae (vert si ritirano lungo -normale).
//
//   Falloff via `SculptBase.computeFalloff(dist2, radius2, type)` (V1.2):
//   type letto da `mesh.constructor.FALLOFF_TYPE`. Dyntopo via
//   `SculptBase.dynamicTopology(picking)`, stesso pattern di Brush.
//
// Differenza architetturale con Brush:
//   Brush:   vAr[ind] = vx + aNormal * fallOff              ← UNA normale fissa (hit)
//   Inflate: vAr[ind] = vx + blend(nPerVert, nArea) * fallOff  ← ibrido smoothato
// ═══════════════════════════════════════════════════════════════

import { Tablet } from '../stubs.js';
import SculptBase from './SculptBase.js?v=SculptGL_S2_V1.5';

class Inflate extends SculptBase {

    constructor(main) {
        super(main);

        this._radius = 50;
        this._intensity = 0.5;
        this._negative = false;
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

        // V1.1: area normal (media pesata delle normali dei front-vert,
        // normalizzata). Usata per blend con per-vertex normal nel loop
        // displacement → attenua la rugosità da amplificazione del rumore.
        var aNormal = this.areaNormal(iVertsFront);
        if (!aNormal) return;

        this.inflate(iVertsInRadius, aNormal, picking.getIntersectionPoint(), r2, intensity, picking);

        var mesh = this.getMesh();
        mesh.updateGeometry(mesh.getFacesFromVertices(iVertsInRadius), iVertsInRadius);
    }

    /**
     * Displacement lungo una normale BLEND tra per-vertex e area smoothata.
     * V1.1: aNormal passata dal caller (stroke), calcolata con
     * `SculptBase.areaNormal(iVertsFront)` — media pesata delle normali
     * del cluster visibile, normalizzata. Blend 60% per-vert + 40% area.
     */
    inflate(iVertsInRadius, aNormal, center, radiusSquared, intensity, picking) {
        var mesh = this.getMesh();
        var vAr = mesh.getVertices();
        var nAr = mesh.getNormals();
        var mAr = mesh.getMaterials();
        var vProxy = this._accumulate ? vAr : mesh.getVerticesProxy();
        var radius = Math.sqrt(radiusSquared);
        var deformIntensity = intensity * radius * 0.1;
        if (this._negative)
            deformIntensity = -deformIntensity;
        var cx = center[0];
        var cy = center[1];
        var cz = center[2];
        // Area normal (smoothata, costante nel loop)
        var anx = aNormal[0];
        var any = aNormal[1];
        var anz = aNormal[2];
        // V1.1: blend factor per-vertex normal vs area normal smoothata.
        //   BLEND = 0.0 → 100% area (= Brush behavior, nessuna curvatura)
        //   BLEND = 1.0 → 100% per-vertex (rugoso, V1.0 originale)
        //   BLEND = 0.6 → compromesso: segue la curvatura, attenua il rumore
        var BLEND = 0.6;
        var INV_BLEND = 1.0 - BLEND;
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
            // Blend pesato tra normale per-vertex e area normal, poi normalizza.
            var pnx = nAr[ind];
            var pny = nAr[ind + 1];
            var pnz = nAr[ind + 2];
            var bnx = BLEND * pnx + INV_BLEND * anx;
            var bny = BLEND * pny + INV_BLEND * any;
            var bnz = BLEND * pnz + INV_BLEND * anz;
            var blen2 = bnx * bnx + bny * bny + bnz * bnz;
            if (blen2 > 0) {
                var invBlen = 1.0 / Math.sqrt(blen2);
                bnx *= invBlen;
                bny *= invBlen;
                bnz *= invBlen;
            } else {
                // Edge case: normali opposte (superficie attraversata dal
                // brush). Fallback ad area normal pura.
                bnx = anx;
                bny = any;
                bnz = anz;
            }
            var fallOff = SculptBase.computeFalloff(dist2, radiusSquared, falloffType);
            fallOff *= mAr[ind + 2] * deformIntensity * picking.getAlpha(vx, vy, vz);
            vAr[ind]     = vx + bnx * fallOff;
            vAr[ind + 1] = vy + bny * fallOff;
            vAr[ind + 2] = vz + bnz * fallOff;
        }
    }
}

export default Inflate;
