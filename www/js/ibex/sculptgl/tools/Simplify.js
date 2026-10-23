// ═══════════════════════════════════════════════════════════════
// IBEX sculptgl/tools/Simplify.js SculptGL_S4_V1.7 — cache-bust SculptBase V1.5 (cleanup)
//
// V1.5 (2026-04-27, fix "funziona solo una volta"):
//   Riscrittura completa di `stroke()`. Rimossa tutta la logica custom
//   (calcolo `allFaces`, filter curvature, `strengthFactor` modulato,
//   chiamata diretta a `mesh.decimate`) e sostituita con una semplice
//   chiamata a `dynamicTopology(picking)` — esattamente come fanno
//   Brush/Inflate/Flatten/Crease.
//
//   Causa del bug V1.4: `mesh.decimate` chiamato direttamente su `iFaces`
//   pre-filtrati per curvatura era idempotente — dopo il primo stroke
//   gli edge < target/2 erano già stati collassati e i passaggi successivi
//   non avevano più lavoro da fare. La mesh sembrava "stabilizzata" e
//   ulteriori passaggi del brush erano no-op.
//
//   Fix V1.5: `dynamicTopology(picking)` viene chiamato fresh ad ogni
//   mousemove. Il picking BVH ricalcola `iVerts` dal raggio attuale,
//   `iFaces` viene riderivato dal nuovo set, e `mesh.decimate` opera
//   sul set aggiornato. Se la zona è già "stabilizzata" (no edge corti)
//   il decimate è no-op localmente, MA appena il brush entra in una
//   zona ancora densa il decimate riprende. Comportamento coerente con
//   gli altri brush.
//
//   Filter curvature rimosso: era un'ottimizzazione pensata per preservare
//   dettaglio clinico, ma:
//   (a) introduceva il bug "scarta tutto" su normali rumorose (V1.1→V1.2)
//   (b) la safety fallback "no filter" lo neutralizzava nel 90% dei casi
//   (c) Simplify per design è distruttivo — semplifica TUTTO nel raggio.
//   L'utente controlla COSA semplificare via radius brush + posizione
//   mouse, non via filter automatico.
//
//   Conseguenza UX: lo slider Intensità diventa **no-op** per Simplify
//   (dynamicTopology non legge `_intensity`, solo `TARGET_EDGE_LEN`).
//   Coerente con il pattern Smooth (no-op per falloff). Il controllo
//   effettivo passa allo slider Detail (mm) → soglia collapse `target/2`.
//
// V1.4 (2026-04-27): bump import SculptBase V1.2 → V1.3. Cache-bust cascata.
// V1.3 (2026-04-27): strength-aware d2Min + filter curvature avgDot.
// V1.2 (2026-04-27): avgDot + safety fallback. Strength ignored (bug).
// V1.1 (2026-04-27): minDot (troppo stretto, filter killava tutto).
// V1.0 (2026-04-27): decimation diretta, nessun filtro curvatura.
// ═══════════════════════════════════════════════════════════════

import SculptBase from './SculptBase.js?v=SculptGL_S2_V1.5';

class Simplify extends SculptBase {

    constructor(main) {
        super(main);

        this._radius = 25;
        this._intensity = 1.0;  // unused (dynamicTopology non legge intensity)
        this._idAlpha = 0;
    }

    /**
     * Decimation pura nel raggio del brush via `dynamicTopology(picking)`.
     * Pattern identico a Brush/Inflate/Flatten/Crease. Stato globale
     * MeshDynamic atteso (impostato da SculptMode._applyDyntopoConfig per
     * type='simplify'):
     *   - SUBDIVISION_FACTOR = 0  → no split
     *   - DECIMATION_FACTOR  = 75 → collapse aggressivo
     *   - TARGET_EDGE_LEN    = brush.dyntopoDetail (o 0.5mm default)
     *
     * `dynamicTopology` calcola d2Min = target² × 0.25 hardcoded → collassa
     * edge < target/2. Nessun displacement.
     */
    stroke(picking) {
        this._main.getStateManager().pushVertices(picking.getPickedVertices());
        this.dynamicTopology(picking);
    }
}

export default Simplify;
