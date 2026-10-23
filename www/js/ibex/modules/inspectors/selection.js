// ═══════════════════════════════════════════════════════════════
// IBEX inspector · selection — GodSplit_29-7 (2026-07-29)
//
// Sezione + handler condivisi da `delete_topology`, `split_topology` e `topology_rebuild` (il `toolType` arriva come 2° argomento di build). Estratto dalle righe 836-911 (build) e 1806-1892 (bind): nell'originale i due blocchi erano separati da `_escapeHtml`, qui sono adiacenti — ogni blocco resta byte-identico.
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
    // Sezione selection per delete_topology / split_topology
    // ─────────────────────────────────────────────────────────────
    _buildSelectionSection(nodeId, toolType = 'delete') {
        const sel = window.ibex?.selectionMode;
        const isActive = !!(sel?.active && String(sel.targetNodeId) === String(nodeId));
        const brush    = sel?.brush || { mode: 'add', radius: 2.0 };
        const count    = isActive ? (sel.selection?.size || 0) : 0;
        const isSplit = (toolType === 'split');
        const isRebuild = (toolType === 'rebuild');
        const actionClass = isSplit
            ? 'ctx-selection-btn-split'
            : (isRebuild ? 'ctx-selection-btn-rebuild' : 'ctx-selection-btn-delete');
        const actionLabel = isSplit
            ? 'Separa selezione'
            : (isRebuild ? 'Ricostruisci' : 'Elimina selezione');

        if (!isActive) {
            return `
            <div class="ctx-selection">
                <button class="ctx-selection-enter-btn ctx-selection-btn-enter" data-node-id="${nodeId}" data-tool-type="${toolType}">
                    Seleziona zone
                </button>
            </div>`;
        }

        const modeCls = (m) => 'ctx-selection-btn ctx-selection-mode' + (brush.mode === m ? ' active' : '');
        const actionEnabled = count > 0;
        // V2.9 — 3 selection modes con SVG inline (Circle / Box / Lasso).
        const selModeNow = sel?._selMode || 'circle';
        const selModeCls = (m) => 'ctx-sel-mode-btn' + (selModeNow === m ? ' active' : '');
        const SVG_CIRCLE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg>`;
        const SVG_BOX    = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16"/></svg>`;
        const SVG_LASSO  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 6 L10 4 L18 7 L20 12 L16 17 L11 19 L7 17 L4 13 Z"/></svg>`;
        // V2.10 — toggle "Attraverso" (X-ray). Default OFF = solo superficie.
        const xrayOn = !!sel?._xray;

        return `
        <div class="ctx-selection">
            <div class="ctx-selection-title">
                <span>Selezione attiva</span>
                <button class="ctx-selection-exit-btn ctx-selection-btn-exit" data-node-id="${nodeId}">esci ×</button>
            </div>

            <div class="ctx-sel-mode-row">
                <button class="${selModeCls('circle')}" data-sel-mode="circle" title="Pennello circolare">${SVG_CIRCLE}</button>
                <button class="${selModeCls('box')}"    data-sel-mode="box"    title="Selezione rettangolare">${SVG_BOX}</button>
                <button class="${selModeCls('lasso')}"  data-sel-mode="lasso"  title="Selezione lazo">${SVG_LASSO}</button>
            </div>
            <label class="ctx-sel-xray-row" title="Se attivo, la selezione passa attraverso la mesh e prende anche le facce dietro">
                <input type="checkbox" class="ctx-sel-xray" ${xrayOn ? 'checked' : ''}>
                <span>Attraverso</span>
            </label>
            <div class="ctx-sel-hint">Shift = aggiungi · Ctrl = rimuovi</div>

            <div class="ctx-selection-btns">
                <button class="${modeCls('add')}"    data-mode="add">Aggiungi</button>
                <button class="${modeCls('remove')}" data-mode="remove">Togli</button>
            </div>

            <div class="ctx-sculpt-slider-row">
                <span>Raggio</span>
                <span class="ctx-sculpt-slider-val ctx-selection-radius-val">${brush.radius.toFixed(1)}</span>
            </div>
            <input type="range" min="0.3" max="15" step="0.1" value="${brush.radius}" class="ctx-sculpt-slider ctx-selection-radius">

            <div class="ctx-selection-count">${count} facce selezionate</div>

            <button class="${actionClass} ctx-selection-action ${actionEnabled ? 'ctx-selection-btn-enabled' : ''}"
                    data-node-id="${nodeId}"
                    data-tool-type="${toolType}"
                    ${actionEnabled ? '' : 'disabled'}>
                ${actionLabel}
            </button>
        </div>`;
    }

    _bindSelectionHandlers() {
        const root = this.currentContainer;
        if (!root) return;

        root.querySelectorAll('.ctx-selection-btn-enter').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const nodeId = btn.dataset.nodeId;
                const toolType = btn.dataset.toolType || 'delete';
                if (window.ibex?.selectionMode) window.ibex.selectionMode.enter(nodeId, toolType);
                this.refresh();
            };
        });

        root.querySelectorAll('.ctx-selection-btn-exit').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                if (window.ibex?.selectionMode) window.ibex.selectionMode.exit();
                this.refresh();
            };
        });

        // V2.9 — selection mode buttons (circle / box / lasso).
        root.querySelectorAll('.ctx-sel-mode-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const m = btn.dataset.selMode;
                if (window.ibex?.selectionMode?.setSelMode) {
                    window.ibex.selectionMode.setSelMode(m);
                }
                // Update active class inline (no full refresh per evitare di
                // perdere stato del slider raggio o focus su altri controlli).
                root.querySelectorAll('.ctx-sel-mode-btn').forEach(b => {
                    b.classList.toggle('active', b === btn);
                });
            };
        });

        // V2.10 — toggle Attraverso (X-ray).
        const xrayCb = root.querySelector('.ctx-sel-xray');
        if (xrayCb) {
            xrayCb.onchange = () => {
                if (window.ibex?.selectionMode?.setXRay) {
                    window.ibex.selectionMode.setXRay(xrayCb.checked);
                }
            };
        }

        root.querySelectorAll('.ctx-selection-mode').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const m = btn.dataset.mode;
                if (window.ibex?.selectionMode) window.ibex.selectionMode.setBrush({ mode: m });
                this.refresh();
            };
        });

        const rIn = root.querySelector('.ctx-selection-radius');
        if (rIn) {
            rIn.oninput = () => {
                const v = parseFloat(rIn.value);
                if (!isNaN(v)) {
                    if (window.ibex?.selectionMode) window.ibex.selectionMode.setBrush({ radius: v });
                    const lbl = root.querySelector('.ctx-selection-radius-val');
                    if (lbl) lbl.textContent = v.toFixed(1);
                }
            };
        }

        root.querySelectorAll('.ctx-selection-action').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                const toolType = btn.dataset.toolType || 'delete';
                if (window.ibex?.selectionMode) {
                    if (toolType === 'split') {
                        window.ibex.selectionMode.applySplit();
                    } else if (toolType === 'rebuild') {
                        window.ibex.selectionMode.applyRebuild();
                    } else {
                        window.ibex.selectionMode.applyDelete();
                    }
                }
                setTimeout(() => this.refresh(), 50);
            };
        });
    }
}

const impl = Impl.prototype;

export const build = impl._buildSelectionSection;
export const bind  = impl._bindSelectionHandlers;
