// ═══════════════════════════════════════════════════════════════
// IBEX inspector · drawCurve — GodSplit_29-7 (2026-07-29)
//
// Sezione + handler del tool `draw_curve`. Estratto dalle righe 913-1025. Il listener live `ibex:curve-count-changed` resta registrato una volta sola via `this._curveCountListener` sull'istanza, come prima.
//
// RELOCAZIONE VERBATIM: il corpo dentro `class Impl` è byte-identico
// all'originale (commenti e righe vuote inclusi). Un corpo di classe non
// vuole virgole fra i metodi → l'estratto entra così com'è, senza che una
// sola riga di logica per-tool sia stata riscritta.
// Sorgente: ContextInspector.js pre-split, md5 38c6947fb47da1a0287867b106608698.
//
// CONTRATTO: `{ build, bind }`. Entrambe vanno chiamate con l'istanza
// ContextInspector come receiver (`mod.build.call(ctx, …)`): dentro il
// corpo `this` resta esattamente ciò che era prima dello split
// (`this.currentContainer`, `this.refresh()`, i listener di istanza…).
//
// ⚠️ Inv. 101 (identità ESM via URL canonico): questo file ha UN SOLO
// import site — ContextInspector.js. Un secondo import dovrà usare un URL
// byte-identico, o si materializzano due moduli ESM distinti.
// ═══════════════════════════════════════════════════════════════

class Impl {
    // ─────────────────────────────────────────────────────────────
    // draw_curve V1.0 (2026-05-06) — sezione inspector per nodo `draw_curve`
    //
    // 2 stati:
    //   - non in editing: bottone "Disegna curva" → entra in CurveMode
    //   - in editing (curveMode.active): controlli "Chiudi curva" / "Nuova
    //     curva" / "Annulla ultimo punto" / "Esci". Status curve attive.
    // Listener `ibex:curve-count-changed` aggiorna i contatori senza full refresh.
    // ─────────────────────────────────────────────────────────────
    _buildCurveSection(nodeId) {
        const cm = window.ibex?.curveMode;
        const isActive = !!(cm?.active && String(cm.targetNodeId) === String(nodeId));
        const node = window.ibex?.stackMgr?.editor?.getNodeFromId(parseInt(nodeId, 10));
        const meta = node?.data?.meta || {};

        if (!isActive) {
            const nClosed = meta.n_closed || 0;
            const nTotal  = meta.n_splines || 0;
            const summary = nTotal > 0
                ? `<div class="ctx-curve-summary">${nClosed} chiuse + ${nTotal - nClosed} aperte salvate</div>`
                : '';
            return `
            <div class="ctx-curve">
                ${summary}
                <button class="ctx-curve-enter-btn" data-node-id="${nodeId}">
                    ${nTotal > 0 ? 'Modifica curve' : 'Disegna curva'}
                </button>
            </div>`;
        }

        const sp = cm.splines[cm.activeSplineIdx] || { controlPoints: [], cyclic: false };
        const nPts = sp.controlPoints.length;
        const totalSplines = cm.splines.length;
        return `
        <div class="ctx-curve">
            <div class="ctx-curve-title">
                <span>Editing curva</span>
                <button class="ctx-curve-exit-btn" data-node-id="${nodeId}">esci ×</button>
            </div>
            <div class="ctx-curve-status">
                <div class="ctx-curve-status-row">
                    <span>Curva attiva</span>
                    <span class="ctx-curve-active-info">#${cm.activeSplineIdx + 1}/${totalSplines} · ${nPts} punti${sp.cyclic ? ' · chiusa' : ''}</span>
                </div>
            </div>
            <div class="ctx-curve-hint">Click sulla mesh = aggiungi punto</div>
            <div class="ctx-curve-btns">
                <button class="ctx-curve-btn ctx-curve-cyclic" data-node-id="${nodeId}">${sp.cyclic ? 'Apri curva' : 'Chiudi curva'}</button>
                <button class="ctx-curve-btn ctx-curve-undo" data-node-id="${nodeId}" ${nPts === 0 ? 'disabled' : ''}>Annulla ultimo punto</button>
                <button class="ctx-curve-btn ctx-curve-new" data-node-id="${nodeId}">Nuova curva</button>
            </div>
        </div>`;
    }

    _bindCurveHandlers() {
        const root = this.currentContainer;
        if (!root) return;

        root.querySelectorAll('.ctx-curve-enter-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const nodeId = btn.dataset.nodeId;
                if (window.ibex?.curveMode) window.ibex.curveMode.enter(nodeId);
                setTimeout(() => this.refresh(), 50);
            };
        });
        root.querySelectorAll('.ctx-curve-exit-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                if (window.ibex?.curveMode) window.ibex.curveMode.exit();
                setTimeout(() => this.refresh(), 50);
            };
        });
        root.querySelectorAll('.ctx-curve-cyclic').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                if (window.ibex?.curveMode) window.ibex.curveMode.toggleCyclic();
            };
        });
        root.querySelectorAll('.ctx-curve-undo').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                if (window.ibex?.curveMode) window.ibex.curveMode.undoLastPoint();
            };
        });
        root.querySelectorAll('.ctx-curve-new').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                if (window.ibex?.curveMode) window.ibex.curveMode.newSpline();
            };
        });

        // Live update contatori senza full refresh (preserva focus altri controlli)
        if (!this._curveCountListener) {
            this._curveCountListener = (ev) => {
                if (!this.currentContainer) return;
                const det = ev.detail || {};
                const info = this.currentContainer.querySelector('.ctx-curve-active-info');
                if (info) {
                    info.textContent = `#${det.active_idx + 1}/${det.n_splines} · ${det.active_pts} punti${det.active_cyclic ? ' · chiusa' : ''}`;
                }
                const cyclicBtn = this.currentContainer.querySelector('.ctx-curve-cyclic');
                if (cyclicBtn) cyclicBtn.textContent = det.active_cyclic ? 'Apri curva' : 'Chiudi curva';
                const undoBtn = this.currentContainer.querySelector('.ctx-curve-undo');
                if (undoBtn) {
                    if (det.active_pts === 0) undoBtn.setAttribute('disabled', '');
                    else undoBtn.removeAttribute('disabled');
                }
            };
            window.addEventListener('ibex:curve-count-changed', this._curveCountListener);
        }
    }
}

const impl = Impl.prototype;

export const build = impl._buildCurveSection;
export const bind  = impl._bindCurveHandlers;
