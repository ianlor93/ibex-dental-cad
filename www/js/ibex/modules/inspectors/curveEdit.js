// ═══════════════════════════════════════════════════════════════
// IBEX inspector · curveEdit — GodSplit_29-7 (2026-07-29)
//
// Sezione + handler del tool `curve_edit`. Estratto dalle righe 1027-1350. Il listener live `ibex:curve-edit-changed` resta su `this._curveEditCountListener`, come prima.
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
    // curve_edit V1.0 (2026-05-12) — sezione inspector per nodo `curve_edit`
    //
    // 2 stati (analogo a _buildCurveSection di draw_curve):
    //   - non in editing: status del nodo (passthrough / N modificate) +
    //     bottone "Modifica curva" → entra in CurveEditMode
    //   - in editing (curveEditMode.active): controlli per spline attiva
    //     (cambia spline, add/delete, toggle cyclic) + "Salva e esci" / "Annulla"
    //     Hint: "Drag CP, click su segmento per inserire, Shift+click per rimuovere"
    // Listener `ibex:curve-edit-changed` aggiorna i contatori senza full refresh.
    // ─────────────────────────────────────────────────────────────
    _buildCurveEditSection(nodeId) {
        const cem = window.ibex?.curveEditMode;
        const isActive = !!(cem?.active && String(cem.targetNodeId) === String(nodeId));
        const node = window.ibex?.stackMgr?.editor?.getNodeFromId(parseInt(nodeId, 10));
        const meta = node?.data?.meta || {};

        if (!isActive) {
            const nClosed = meta.n_closed || 0;
            const nTotal  = meta.n_splines || 0;
            const nCp     = meta.n_ctrl_points || 0;
            const summary = nTotal > 0
                ? `<div class="ctx-curve-summary">Editato · ${nClosed} chiuse + ${nTotal - nClosed} aperte · ${nCp} CP</div>`
                : `<div class="ctx-curve-summary">Curva passthrough (non ancora modificata)</div>`;
            // Reset button visibile solo se utente ha già editato (nTotal > 0).
            // Click → DELETE del .crv.json server-side → al prossimo bake worker
            // copia fresh upstream (arch_detect output) cancellando edits utente.
            const resetBtn = nTotal > 0
                ? `<button class="ctx-curveedit-reset-btn" data-node-id="${nodeId}"
                          style="margin-top:6px;background:transparent;border:1px solid #C4302B;color:#C4302B;"
                          title="Cancella i tuoi edits e ri-sincronizza con l'arch_detect upstream">
                       Reset a curva originale
                   </button>`
                : '';
            return `
            <div class="ctx-curve">
                ${summary}
                <button class="ctx-curveedit-enter-btn" data-node-id="${nodeId}">
                    ${nTotal > 0 ? 'Modifica di nuovo' : 'Modifica curva'}
                </button>
                ${resetBtn}
            </div>`;
        }

        const sp = cem.splines[cem.activeSplineIdx] || { controlPoints: [], cyclic: false };
        const nPts = sp.controlPoints.length;
        const totalCp = cem.splines.reduce((a, s) => a + s.controlPoints.length, 0);
        const nSelected = cem.selectedCps ? cem.selectedCps.size : 0;
        const snapOn = !!cem.snapToSurface;
        // Fase 3 V2.4 — proportional editing state
        const propOn = !!cem.proportionalEdit;
        const propR  = Number(cem.proportionalRadius) || 5.0;
        // V2.4.2: rimossi bottoni "Chiudi curva" / "Nuova spline" / "Elimina spline" +
        // switcher splines (richiesta utente: il nodo curve_edit non crea/elimina
        // splines, opera solo sui CP della curva in input).

        // V2.0 Fase 2 — Sezione "Curvatura CP selezionati" visibile solo se ≥1 CP selezionato.
        // Bottoni Smooth (promote aligned, handles Bezier attivi) / Spigoli vivi (demote
        // vector, no handles) + Rimuovi CP. Count "X di N aligned" come info.
        let nSelAligned = 0;
        if (cem.splines) {
            for (const key of cem.selectedCps) {
                const [si, ci] = key.split(':').map(Number);
                const sp = cem.splines[si];
                if (sp && sp.handleTypes && sp.handleTypes[ci] === 'aligned') nSelAligned++;
            }
        }
        const selectionActionsBlock = nSelected > 0 ? `
            <div class="ctx-curve-status" style="margin-top:6px">
                <div class="ctx-curve-status-row">
                    <span>Con handles</span>
                    <span class="ctx-curveedit-aligned-info">${nSelAligned} / ${nSelected}</span>
                </div>
            </div>
            <div class="ctx-curve-btns" style="margin-top:6px">
                <button class="ctx-curve-btn ctx-curveedit-promote-aligned" data-node-id="${nodeId}"
                        title="Assegna handles Bezier ai CP selezionati. La curva tra i CP diventa smooth (continuità tangente, stile Blender). Gli handles si vedono sempre, anche quando il CP è deselezionato.">
                    Assegna handle
                </button>
                <button class="ctx-curve-btn ctx-curveedit-demote-vector" data-node-id="${nodeId}"
                        title="Rimuove gli handles Bezier dai CP selezionati. La curva torna a linea retta tra CP adiacenti.">
                    Rimuovi handle
                </button>
            </div>
            <div class="ctx-curve-btns" style="margin-top:6px">
                <button class="ctx-curve-btn ctx-curveedit-remove-selected" data-node-id="${nodeId}"
                        style="border:1px solid #C4302B;color:#C4302B;background:transparent"
                        title="Rimuove i CP selezionati dalla curva (min 2 CP per spline)">
                    Rimuovi ${nSelected} CP selez.
                </button>
            </div>` : '';

        return `
        <div class="ctx-curve">
            <div class="ctx-curve-title">
                <span>Editing curva (${totalCp} CP totali)</span>
            </div>
            <div class="ctx-curve-status">
                <div class="ctx-curve-status-row">
                    <span>CP totali</span>
                    <span class="ctx-curveedit-active-info">${nPts}${sp.cyclic ? ' · chiusa' : ''}</span>
                </div>
                <div class="ctx-curve-status-row">
                    <span>Selezionati</span>
                    <span class="ctx-curveedit-selected-info">${nSelected} / ${totalCp} CP</span>
                </div>
            </div>

            <div class="ctx-curve-modes" style="margin-top:6px">
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer"
                       title="ON: il CP segue la superficie della mesh (raycast, freeze se fuori mesh). OFF: drag libero su piano perpendicolare alla camera.">
                    <input type="checkbox" class="ctx-curveedit-snap-toggle" data-node-id="${nodeId}"
                           ${snapOn ? 'checked' : ''}>
                    <span>Snap a superficie</span>
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;margin-top:4px"
                       title="Proportional editing stile Blender: drag su 1 CP influenza tutti i CP nel raggio R con falloff smooth (decresce con la distanza along-curve). I CP selezionati si muovono al massimo. Scroll wheel durante drag = modifica R live.">
                    <input type="checkbox" class="ctx-curveedit-prop-toggle" data-node-id="${nodeId}"
                           ${propOn ? 'checked' : ''}>
                    <span>Proportional editing</span>
                </label>
                ${propOn ? `
                <div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px;padding-left:18px">
                    <span>Raggio</span>
                    <input type="range" class="ctx-curveedit-prop-radius" data-node-id="${nodeId}"
                           min="0.3" max="80" step="0.1" value="${propR.toFixed(1)}" style="flex:1">
                    <span class="ctx-curveedit-prop-radius-val">${propR.toFixed(1)} mm</span>
                </div>
                ` : ''}
            </div>

            <div class="ctx-curve-hint">
                Tap CP = aggiungi/togli selez · Tap segmento = inserisci CP · Drag CP = sposta · Tap area vuota = desel tutti${propOn ? ' · Wheel su drag = R live' : ''}
            </div>

            <div class="ctx-curve-btns" style="margin-top:6px">
                <button class="ctx-curve-btn ctx-curveedit-select-all" data-node-id="${nodeId}">Sel. tutti</button>
                <button class="ctx-curve-btn ctx-curveedit-deselect-all" data-node-id="${nodeId}" ${nSelected === 0 ? 'disabled' : ''}>Desel. tutti</button>
                <button class="ctx-curve-btn ctx-curveedit-invert-selection" data-node-id="${nodeId}">Inverti</button>
            </div>
            ${selectionActionsBlock}

            <div class="ctx-curve-btns" style="margin-top:6px">
                <button class="ctx-curve-btn ctx-curveedit-save-btn" data-node-id="${nodeId}" style="background:var(--ibex-geo,#1F8A4C);color:white;font-weight:500">Salva e esci</button>
                <button class="ctx-curve-btn ctx-curveedit-cancel-btn" data-node-id="${nodeId}">Annulla</button>
            </div>
        </div>`;
    }

    _bindCurveEditHandlers() {
        const root = this.currentContainer;
        if (!root) return;

        root.querySelectorAll('.ctx-curveedit-enter-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const nodeId = btn.dataset.nodeId;
                if (window.ibex?.curveEditMode) window.ibex.curveEditMode.enter(nodeId);
                // refresh deferred (enter è async — fetch curva)
                setTimeout(() => this.refresh(), 200);
            };
        });
        root.querySelectorAll('.ctx-curveedit-save-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                if (window.ibex?.curveEditMode) window.ibex.curveEditMode.exit({ save: true });
                setTimeout(() => this.refresh(), 50);
            };
        });
        root.querySelectorAll('.ctx-curveedit-reset-btn').forEach(btn => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                const nodeId = btn.dataset.nodeId;
                if (!confirm('Cancellerà i tuoi edits e tornerà alla curva calcolata da arch_detect. Procedere?')) return;
                const ok = await window.ibex?.curveEditMode?.resetCurve?.(nodeId);
                if (ok) {
                    window.ibex.uiMgr?.notify?.('Curva resettata. Verrà ricalcolata al prossimo bake.', 'success');
                    // Trigger bake per rinfrescare
                    window.ibex.stackMgr?.bakeEngine?.requestBake?.({ force: true });
                    // Aggiorna meta del nodo (n_splines=0 → bottone "Modifica curva")
                    window.ibex.stackMgr?.updateSculptNodeMeta?.(nodeId, {
                        n_splines: 0, n_closed: 0, n_ctrl_points: 0, last_modified: 0
                    });
                    setTimeout(() => this.refresh(), 100);
                }
            };
        });
        root.querySelectorAll('.ctx-curveedit-cancel-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                if (window.ibex?.curveEditMode) window.ibex.curveEditMode.exit({ save: false });
                setTimeout(() => this.refresh(), 50);
            };
        });
        // V2.4.2 (2026-05-13): rimossi listener `ctx-curveedit-cyclic` /
        // `ctx-curveedit-new-spline` / `ctx-curveedit-delete-spline` /
        // `ctx-curveedit-spline-btn`. I bottoni corrispondenti sono stati
        // eliminati dall'inspector — curve_edit non crea/elimina/chiude curve,
        // opera solo sui CP della curva in input.

        // V2.0 Fase 1: snap toggle + bottoni selezione (tablet-friendly, no shift/keyboard)
        root.querySelectorAll('.ctx-curveedit-snap-toggle').forEach(cb => {
            cb.onchange = (e) => {
                e.stopPropagation();
                window.ibex?.curveEditMode?.setSnapToSurface?.(cb.checked);
            };
        });
        // Fase 3 V2.4 — proportional editing toggle + slider Raggio
        root.querySelectorAll('.ctx-curveedit-prop-toggle').forEach(cb => {
            cb.onchange = (e) => {
                e.stopPropagation();
                window.ibex?.curveEditMode?.setProportionalEdit?.(cb.checked);
                // Refresh inspector per mostrare/nascondere slider Raggio
                setTimeout(() => this.refresh(), 30);
            };
        });
        root.querySelectorAll('.ctx-curveedit-prop-radius').forEach(sl => {
            sl.oninput = (e) => {
                e.stopPropagation();
                const v = parseFloat(sl.value);
                if (Number.isFinite(v)) {
                    window.ibex?.curveEditMode?.setProportionalRadius?.(v);
                    const lbl = sl.parentNode?.querySelector?.('.ctx-curveedit-prop-radius-val');
                    if (lbl) lbl.textContent = `${v.toFixed(1)} mm`;
                }
            };
        });
        root.querySelectorAll('.ctx-curveedit-select-all').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                window.ibex?.curveEditMode?.selectAllCps?.();
                // refresh count + abilita "Desel" via listener ibex:curve-edit-changed
            };
        });
        root.querySelectorAll('.ctx-curveedit-deselect-all').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                window.ibex?.curveEditMode?.deselectAllCps?.();
            };
        });
        root.querySelectorAll('.ctx-curveedit-invert-selection').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                window.ibex?.curveEditMode?.invertSelection?.();
            };
        });
        root.querySelectorAll('.ctx-curveedit-remove-selected').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                window.ibex?.curveEditMode?.removeSelectedCps?.();
                // dopo rimozione, selezione vuotata → block "Rimuovi N CP" sparisce
                // al prossimo refresh dispatchato dall'event ibex:curve-edit-changed
                setTimeout(() => this.refresh(), 30);
            };
        });
        // Fase 2 — bottoni Smooth (promote aligned) / Spigoli vivi (demote vector)
        root.querySelectorAll('.ctx-curveedit-promote-aligned').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                window.ibex?.curveEditMode?.promoteSelectionToAligned?.();
                setTimeout(() => this.refresh(), 30);
            };
        });
        root.querySelectorAll('.ctx-curveedit-demote-vector').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                window.ibex?.curveEditMode?.demoteSelectionToVector?.();
                setTimeout(() => this.refresh(), 30);
            };
        });

        // Live update via custom event (pattern parallelo a _bindCurveHandlers)
        if (!this._curveEditCountListener) {
            this._curveEditCountListener = (ev) => {
                if (!this.currentContainer) return;
                const det = ev.detail || {};
                // V2.4.2: status row semplificata — solo "X CP [· chiusa]"
                const info = this.currentContainer.querySelector('.ctx-curveedit-active-info');
                if (info) {
                    info.textContent = `${det.active_pts}${det.active_cyclic ? ' · chiusa' : ''}`;
                }
                const title = this.currentContainer.querySelector('.ctx-curve-title > span');
                if (title) {
                    title.textContent = `Editing curva (${det.total_pts || 0} CP totali)`;
                }
                // V2.0 Fase 1 — aggiorna count selezionati + stato bottoni dinamici
                const selInfo = this.currentContainer.querySelector('.ctx-curveedit-selected-info');
                if (selInfo) selInfo.textContent = `${det.n_selected || 0} / ${det.total_pts || 0} CP`;
                const deselBtn = this.currentContainer.querySelector('.ctx-curveedit-deselect-all');
                if (deselBtn) {
                    if ((det.n_selected || 0) === 0) deselBtn.setAttribute('disabled', '');
                    else deselBtn.removeAttribute('disabled');
                }
                // Show/hide blocco azioni selezione (Smooth + Spigoli + Rimuovi) via
                // full refresh (block intero che appare/sparisce in base a n_selected).
                const hasRemoveBlock = !!this.currentContainer.querySelector('.ctx-curveedit-remove-selected');
                const shouldHave = (det.n_selected || 0) > 0;
                if (hasRemoveBlock !== shouldHave) {
                    this.refresh();
                } else if (shouldHave) {
                    const removeBtn = this.currentContainer.querySelector('.ctx-curveedit-remove-selected');
                    if (removeBtn) removeBtn.textContent = `Rimuovi ${det.n_selected} CP selez.`;
                    // Aggiorna info "X / N aligned" (Fase 2)
                    const alignedInfo = this.currentContainer.querySelector('.ctx-curveedit-aligned-info');
                    if (alignedInfo) alignedInfo.textContent =
                        `${det.n_selected_aligned || 0} / ${det.n_selected}`;
                }
                // Fase 3 V2.4: sync slider raggio se cambiato via wheel scroll
                if (typeof det.proportional_radius === 'number') {
                    const slider = this.currentContainer.querySelector('.ctx-curveedit-prop-radius');
                    if (slider) {
                        const cur = parseFloat(slider.value);
                        if (!Number.isFinite(cur) || Math.abs(cur - det.proportional_radius) > 0.01) {
                            slider.value = det.proportional_radius.toFixed(1);
                            const lbl = slider.parentNode?.querySelector?.('.ctx-curveedit-prop-radius-val');
                            if (lbl) lbl.textContent = `${det.proportional_radius.toFixed(1)} mm`;
                        }
                    }
                }
            };
            window.addEventListener('ibex:curve-edit-changed', this._curveEditCountListener);
        }
    }
}

const impl = Impl.prototype;

export const build = impl._buildCurveEditSection;
export const bind  = impl._bindCurveEditHandlers;
