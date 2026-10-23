// ═══════════════════════════════════════════════════════════════
// IBEX inspector · sculpt — GodSplit_29-7 (2026-07-29)
//
// Sezione + handler del tool `sculpt`. Estratto dalle righe 586-834.
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
    // Sezione sculpt per tool === 'sculpt'
    // ─────────────────────────────────────────────────────────────
    _buildSculptSection(nodeId) {
        const sculpt   = window.ibex?.sculptMgr;
        const isActive = !!(sculpt?.active && String(sculpt.targetNodeId) === String(nodeId));
        const brush    = sculpt?.brush || { type: 'push', radius: 2.0, strength: 0.3, dyntopo: false };

        if (!isActive) {
            return `
            <div class="ctx-sculpt">
                <button class="ctx-sculpt-enter-btn ctx-sculpt-btn-enter" data-node-id="${nodeId}">
                    Entra in sculpt
                </button>
            </div>`;
        }

        const btnCls = (t) => 'ctx-sculpt-btn ctx-sculpt-btype' + (brush.type === t ? ' active' : '');
        const falloffCls = (f) => 'ctx-sculpt-falloff-btn' + ((brush.falloff || 'smooth') === f ? ' active' : '');
        const dyntopoChecked = brush.dyntopo ? 'checked' : '';
        const detailVal = (brush.dyntopoDetail != null)
            ? brush.dyntopoDetail
            : (brush.radius / 4);
        // V2.3: sign selector +/- — visibile solo per inflate/crease.
        const signVisible = (brush.type === 'inflate' || brush.type === 'crease');
        const currentSign = (brush.sign != null) ? brush.sign : +1;
        const signCls = (s) => 'ctx-sculpt-sign-btn' + (currentSign === s ? ' active' : '');
        const signBlock = signVisible ? `
            <div class="ctx-sculpt-sign-row">
                <span class="ctx-sculpt-sign-label">Segno</span>
                <div class="ctx-sculpt-sign-btns">
                    <button class="${signCls(+1)}" data-sign="1">+</button>
                    <button class="${signCls(-1)}" data-sign="-1">−</button>
                </div>
            </div>` : '';
        return `
        <div class="ctx-sculpt">
            <div class="ctx-sculpt-title">
                <span>Sculpt attivo</span>
                <button class="ctx-sculpt-exit-btn ctx-sculpt-btn-exit" data-node-id="${nodeId}">esci ×</button>
            </div>

            <div class="ctx-sculpt-btns">
                <button class="${btnCls('inflate')}"  data-brush-type="inflate">Inflate</button>
                <button class="${btnCls('crease')}"   data-brush-type="crease">Crease</button>
                <button class="${btnCls('smooth')}"   data-brush-type="smooth">Smooth</button>
                <button class="${btnCls('flatten')}"  data-brush-type="flatten">Flatten</button>
                <button class="${btnCls('simplify')}" data-brush-type="simplify">Simplify</button>
            </div>

            ${signBlock}

            <div class="ctx-sculpt-falloff-row">
                <span class="ctx-sculpt-falloff-label">Falloff</span>
                <div class="ctx-sculpt-falloff-btns">
                    <button class="${falloffCls('smooth')}" data-falloff="smooth" title="Smooth (U)">
                        <svg width="28" height="18" viewBox="0 0 28 18" xmlns="http://www.w3.org/2000/svg">
                            <path d="M2,2 C2,16 26,16 26,2"
                                  stroke="currentColor" stroke-width="1.5" fill="none"
                                  stroke-linecap="round"/>
                        </svg>
                    </button>
                    <button class="${falloffCls('sharp')}" data-falloff="sharp" title="Sharp (V)">
                        <svg width="28" height="18" viewBox="0 0 28 18" xmlns="http://www.w3.org/2000/svg">
                            <path d="M2,16 L14,2 L26,16"
                                  stroke="currentColor" stroke-width="1.5" fill="none"
                                  stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                    <button class="${falloffCls('cylinder')}" data-falloff="cylinder" title="Cylinder (lineare)">
                        <svg width="28" height="18" viewBox="0 0 28 18" xmlns="http://www.w3.org/2000/svg">
                            <path d="M2,2 L26,2 L26,16 L2,16 Z"
                                  stroke="currentColor" stroke-width="1.5" fill="none"/>
                        </svg>
                    </button>
                </div>
            </div>

            <div class="ctx-sculpt-slider-row">
                <span>Raggio</span>
                <span class="ctx-sculpt-slider-val ctx-sculpt-radius-val">${brush.radius.toFixed(2)}</span>
            </div>
            <input type="range" min="0.1" max="1.5" step="0.05" value="${brush.radius}" class="ctx-sculpt-slider ctx-sculpt-radius">

            <div class="ctx-sculpt-slider-row">
                <span>Intensità</span>
                <span class="ctx-sculpt-slider-val ctx-sculpt-strength-val">${brush.strength.toFixed(2)}</span>
            </div>
            <input type="range" min="0.1" max="1" step="0.01" value="${brush.strength}" class="ctx-sculpt-slider ctx-sculpt-strength">

            <label class="ctx-sculpt-dyntopo-row" title="Ridistribuisce la topologia localmente (edge split + collapse).">
                <input type="checkbox" class="ctx-sculpt-dyntopo" ${dyntopoChecked}>
                <span>Dyntopo</span>
                ${brush.dyntopo ? '<button class="ctx-sculpt-flood-btn" title="Applica il target a tutta la mesh">Flood</button>' : ''}
            </label>

            <div class="ctx-sculpt-slider-row ctx-sculpt-dyntopo-detail-row">
                <span>Detail (mm)</span>
                <span class="ctx-sculpt-slider-val ctx-sculpt-dyntopo-detail-val">${detailVal.toFixed(2)}</span>
            </div>
            <input type="range" min="0.05" max="5" step="0.05" value="${detailVal}" class="ctx-sculpt-slider ctx-sculpt-dyntopo-detail">

            <label class="ctx-sculpt-lazy-row" title="Ritardo elastico del brush — il cursore tira il segugio con un filo invisibile.">
                <input type="checkbox" class="ctx-sculpt-lazy" ${brush.lazy ? 'checked' : ''}>
                <span>Lazy</span>
            </label>
            ${brush.lazy ? `
            <div class="ctx-sculpt-slider-row ctx-sculpt-lazy-radius-row">
                <span>Raggio lazy</span>
                <span class="ctx-sculpt-slider-val ctx-sculpt-lazy-radius-val">${(brush.lazyRadius ?? 0.5).toFixed(2)}</span>
            </div>
            <input type="range" min="0" max="1" step="0.05" value="${brush.lazyRadius ?? 0.5}" class="ctx-sculpt-slider ctx-sculpt-lazy-radius">
            ` : ''}
        </div>`;
    }

    _bindSculptHandlers() {
        const root = this.currentContainer;
        if (!root) return;

        root.querySelectorAll('.ctx-sculpt-btn-enter').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const nodeId = btn.dataset.nodeId;
                if (window.ibex?.sculptMgr) window.ibex.sculptMgr.enter(nodeId);
                this.refresh();
            };
        });

        root.querySelectorAll('.ctx-sculpt-btn-exit').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                if (window.ibex?.sculptMgr) window.ibex.sculptMgr.exit();
                this.refresh();
            };
        });

        root.querySelectorAll('.ctx-sculpt-btype').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const t = btn.dataset.brushType;
                if (window.ibex?.sculptMgr) window.ibex.sculptMgr.setBrush({ type: t });
                this.refresh();
            };
        });

        // V2.1: falloff selector (Smooth/Linear/Sphere/Sharp)
        root.querySelectorAll('.ctx-sculpt-falloff-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const f = btn.dataset.falloff;
                if (window.ibex?.sculptMgr) window.ibex.sculptMgr.setBrush({ falloff: f });
                this.refresh();
            };
        });

        // V2.3: sign selector +/- (inflate/crease)
        root.querySelectorAll('.ctx-sculpt-sign-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const s = parseInt(btn.dataset.sign, 10);
                if (window.ibex?.sculptMgr) window.ibex.sculptMgr.setBrush({ sign: s });
                this.refresh();
            };
        });

        const rIn = root.querySelector('.ctx-sculpt-radius');
        if (rIn) {
            rIn.oninput = () => {
                const v = parseFloat(rIn.value);
                if (!isNaN(v)) {
                    if (window.ibex?.sculptMgr) window.ibex.sculptMgr.setBrush({ radius: v });
                    const lbl = root.querySelector('.ctx-sculpt-radius-val');
                    if (lbl) lbl.textContent = v.toFixed(1);
                }
            };
        }

        const sIn = root.querySelector('.ctx-sculpt-strength');
        if (sIn) {
            sIn.oninput = () => {
                const v = parseFloat(sIn.value);
                if (!isNaN(v)) {
                    if (window.ibex?.sculptMgr) window.ibex.sculptMgr.setBrush({ strength: v });
                    const lbl = root.querySelector('.ctx-sculpt-strength-val');
                    if (lbl) lbl.textContent = v.toFixed(2);
                }
            };
        }

        const dynIn = root.querySelector('.ctx-sculpt-dyntopo');
        if (dynIn) {
            dynIn.onchange = () => {
                if (window.ibex?.sculptMgr) {
                    window.ibex.sculptMgr.setBrush({ dyntopo: !!dynIn.checked });
                }
            };
        }

        const detIn = root.querySelector('.ctx-sculpt-dyntopo-detail');
        if (detIn) {
            detIn.oninput = () => {
                const v = parseFloat(detIn.value);
                if (!isNaN(v)) {
                    if (window.ibex?.sculptMgr) {
                        window.ibex.sculptMgr.setBrush({ dyntopoDetail: v });
                    }
                    const lbl = root.querySelector('.ctx-sculpt-dyntopo-detail-val');
                    if (lbl) lbl.textContent = v.toFixed(2);
                }
            };
        }

        // V2.6: Flood Fill button (visibile solo se dyntopo=true)
        const floodBtn = root.querySelector('.ctx-sculpt-flood-btn');
        if (floodBtn) {
            floodBtn.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();  // bottone in <label> — evita toggle checkbox
                if (window.ibex?.sculptMgr) window.ibex.sculptMgr.floodFill();
            };
        }

        // V2.6: Lazy checkbox
        const lazyIn = root.querySelector('.ctx-sculpt-lazy');
        if (lazyIn) {
            lazyIn.onchange = () => {
                if (window.ibex?.sculptMgr) {
                    window.ibex.sculptMgr.setBrush({ lazy: !!lazyIn.checked });
                }
                this.refresh(); // mostra/nasconde il slider Lazy Radius
            };
        }

        // V2.6: Lazy Radius slider (visibile solo se lazy=true)
        const lazyRIn = root.querySelector('.ctx-sculpt-lazy-radius');
        if (lazyRIn) {
            lazyRIn.oninput = () => {
                const v = parseFloat(lazyRIn.value);
                if (!isNaN(v)) {
                    if (window.ibex?.sculptMgr) {
                        window.ibex.sculptMgr.setBrush({ lazyRadius: v });
                    }
                    const lbl = root.querySelector('.ctx-sculpt-lazy-radius-val');
                    if (lbl) lbl.textContent = v.toFixed(2);
                }
            };
        }
    }
}

const impl = Impl.prototype;

export const build = impl._buildSculptSection;
export const bind  = impl._bindSculptHandlers;
