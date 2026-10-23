// ═══════════════════════════════════════════════════════════════
// IBEX inspector · archDetect — GodSplit_29-7 (2026-07-29)
//
// Sezione + handler del tool `arch_detect`, più il suo helper privato `_fetchArchDetectCurve`. Estratto dalle righe 1352-1692.
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
    // arch_detect V1.0 (2026-05-12) — sezione inspector per nodo `arch_detect`
    //
    // Mostra metadata calcolati dal worker (n_ctrl_points, arch_length_mm,
    // pca_ratios, n_verts_selected, curv_threshold) + 2 azioni:
    //   - "Mostra/Nascondi curva": toggle overlay 3D viewport via CurveViewer
    //   - "Ricalcola": incrementa `params._recompute_seq` → worker invalida
    //     cache `.crv.json` → bake parte automaticamente → metadata fresh
    //
    // Metadata fetch:
    //   1. Lettura iniziale da `node.data.meta` (popolato post-bake da
    //      IbexCore._refreshArchDetectMetadata, hook su BakeEngine success)
    //   2. Bottone "Aggiorna info" che fa fetch immediato del .crv.json
    //   3. Se metadata assenti (nessun bake ancora) → mostra "in attesa di bake"
    // ─────────────────────────────────────────────────────────────
    _buildArchDetectSection(nodeId) {
        const node = window.ibex?.stackMgr?.editor?.getNodeFromId(parseInt(nodeId, 10));
        const meta = node?.data?.meta || {};
        const params = node?.data?.params || {};
        const cv = window.ibex?.curveViewer;
        const isVisible = cv ? cv.isVisible(nodeId) : false;

        const hasData = !!meta.arch_length_mm || !!meta.n_ctrl_points;

        // Params attuali (V2.2 — adherence/trim hardcoded backend, NON UI)
        const zOffset = params._z_offset_mm != null ? Number(params._z_offset_mm) : 5.0;
        const tmplChoice = params._template || 'auto';
        const smoothSig = params._smoothness_sigma != null ? Number(params._smoothness_sigma) : 4.0;
        const extMm = params._extension_mm != null ? Number(params._extension_mm) : 18.0;
        // V2.12 PlanarZWorld: planarizza curva in Z world (default true).
        const planarZWorld = params._planarize_z_world != null ? !!params._planarize_z_world : true;
        // V2.13 AlignToWorldXY: ruota curva per allineare apex a +Y world (default true).
        const alignWorldXY = params._align_world_xy != null ? !!params._align_world_xy : true;

        let metadataHtml = '';
        if (hasData) {
            const len = (meta.arch_length_mm || 0).toFixed(1);
            const cps = meta.n_ctrl_points || 0;
            const ratio12 = meta.pca_ratio12 ? meta.pca_ratio12.toFixed(2) : '—';
            const ratio23 = meta.pca_ratio23 ? meta.pca_ratio23.toFixed(2) : '—';
            const nSel = meta.n_verts_selected || 0;
            const tmplUsed = meta.template_used || '—';
            const tmplResidual = meta.template_residual != null ? meta.template_residual.toFixed(1) : '—';
            metadataHtml = `
            <div class="ctx-archdetect-metadata">
                <div class="ctx-archdetect-row"><span>Control points</span><span class="ctx-archdetect-val">${cps}</span></div>
                <div class="ctx-archdetect-row"><span>Arch length</span><span class="ctx-archdetect-val">${len} mm</span></div>
                <div class="ctx-archdetect-row"><span>Verts selected</span><span class="ctx-archdetect-val">${nSel}</span></div>
                <div class="ctx-archdetect-row"><span>Template fit</span><span class="ctx-archdetect-val">${tmplUsed}</span></div>
                <div class="ctx-archdetect-row"><span>Fit residual</span><span class="ctx-archdetect-val">${tmplResidual}</span></div>
                <div class="ctx-archdetect-row"><span>PCA ratios</span><span class="ctx-archdetect-val">${ratio12} / ${ratio23}</span></div>
            </div>`;
        } else {
            metadataHtml = `<div class="ctx-archdetect-empty">Curva non ancora calcolata.<br>Triggera un bake per visualizzare i metadata.</div>`;
        }

        // V2.5: 10 template ortodontici preformati labiali (filo apparecchio fisso)
        // Raggruppati per produttore. Backward compat: alias storici (ovoid/square/
        // tapered/narrow) accettati lato worker, ma non più nel dropdown.
        const tmplLabels = {
            'auto':           'Auto (best fit)',
            // Trueform / Mathieu / G&H
            'europa_1':       'Europa I  (MBT Ovoid)',
            'europa_2':       'Europa II  (Damon)',
            'trueform_1':     'Trueform I  (Roth / MBT Square)',
            'trueform_2':     'Trueform II',
            'standard_form':  'Standard Form',
            // GAC/Dentsply Bioform (wide → tapered)
            'bioform_1':      'Bioform I',
            'bioform_2':      'Bioform II',
            'bioform_3':      'Bioform III  (MBT Tapered)',
            'bioform_4':      'Bioform IV',
            'bioform_5':      'Bioform V',
            // Fallback
            'skeleton':       'Skeleton (raw)'
        };
        // Group structure: each group is [label, [option_keys...]]
        const tmplGroups = [
            [null, ['auto']],
            ['Trueform / Europa / Standard', ['europa_1', 'europa_2', 'trueform_1', 'trueform_2', 'standard_form']],
            ['Bioform (wide → tapered)', ['bioform_1', 'bioform_2', 'bioform_3', 'bioform_4', 'bioform_5']],
            [null, ['skeleton']],
        ];
        // V2.5 alias resolution: se progetti vecchi hanno tmplChoice=ovoid/square/
        // tapered/narrow, mappa al nuovo nome per il selected sync UI.
        const aliasMap = { 'ovoid': 'europa_1', 'square': 'trueform_1', 'tapered': 'bioform_3', 'narrow': 'bioform_5' };
        const tmplChoiceResolved = aliasMap[tmplChoice] || tmplChoice;
        const optHtml = (k) => `<option value="${k}"${k === tmplChoiceResolved ? ' selected' : ''}>${tmplLabels[k]}</option>`;
        const tmplOpts = tmplGroups.map(([label, keys]) => {
            if (!label) return keys.map(optHtml).join('');
            return `<optgroup label="${label}">${keys.map(optHtml).join('')}</optgroup>`;
        }).join('');

        return `
        <div class="ctx-archdetect">
            ${metadataHtml}
            <div class="ctx-archdetect-controls">
                <div class="ctx-archdetect-control-row">
                    <label class="ctx-archdetect-label">Template ortodontico</label>
                    <select class="ctx-archdetect-template-select" data-node-id="${nodeId}">
                        ${tmplOpts}
                    </select>
                </div>
                <div class="ctx-archdetect-control-row">
                    <label class="ctx-archdetect-label">Elevazione (mm) <span class="ctx-archdetect-val ctx-archdetect-zoffset-val">${zOffset.toFixed(1)}</span></label>
                    <input class="ctx-archdetect-slider ctx-archdetect-zoffset-slider" type="range" min="0" max="15" step="0.5" value="${zOffset}" data-node-id="${nodeId}">
                </div>
                <div class="ctx-archdetect-control-row">
                    <label class="ctx-archdetect-label">Ampiezza <span class="ctx-archdetect-val ctx-archdetect-smooth-val">${smoothSig.toFixed(1)}</span></label>
                    <input class="ctx-archdetect-slider ctx-archdetect-smooth-slider" type="range" min="0" max="8" step="0.5" value="${smoothSig}" data-node-id="${nodeId}" title="Controlla l'ampiezza dell'arco rilevato. Valori alti = arco più ampio e regolare (smoothing forte del ridge skeleton). Valori bassi = arco più stretto e aderente al ridge dentale (smoothing ridotto).">
                </div>
                <!-- V2.10 (2026-05-13): slider Prolungamento RIMOSSO.
                     Con V2.9 EllipseFit l'estensione laterale è determinata
                     automaticamente dal BBox della scansione: i rami dell'ellisse
                     terminano ai bordi della mesh, niente più parametro manuale. -->
                <div class="ctx-archdetect-control-row">
                    <label class="ctx-archdetect-checkbox-label" title="Se ON: tutti i CP della curva sono alla stessa altezza Z world (planare orizzontale). Se OFF: curva inclinata lungo l'asse PCA della scansione (può apparire ruotata se il modello è importato storto).">
                        <input type="checkbox" class="ctx-archdetect-planar-checkbox" data-node-id="${nodeId}" ${planarZWorld ? 'checked' : ''}>
                        Curva planare (Z world)
                    </label>
                </div>
                <div class="ctx-archdetect-control-row">
                    <label class="ctx-archdetect-checkbox-label" title="Se ON: ruota la curva attorno a Z world per allineare la corda (linea tra le 2 estremità) all'asse X world. Rotazione minima ≤90° → la curva mantiene il suo orientamento naturale di scansione, solo raddrizzata. Se OFF: orientamento PCA grezzo, può apparire ruotata se il modello è importato storto.">
                        <input type="checkbox" class="ctx-archdetect-align-checkbox" data-node-id="${nodeId}" ${alignWorldXY ? 'checked' : ''}>
                        Allinea curva ad assi world
                    </label>
                </div>
            </div>
            <div class="ctx-archdetect-btns">
                <button class="ctx-archdetect-toggle-btn ${isVisible ? 'is-visible' : ''}" data-node-id="${nodeId}" ${hasData ? '' : 'disabled'}>
                    ${isVisible ? 'Nascondi curva' : 'Mostra curva'}
                </button>
                <button class="ctx-archdetect-refresh-btn" data-node-id="${nodeId}">Aggiorna info</button>
                <button class="ctx-archdetect-recompute-btn" data-node-id="${nodeId}">Ricalcola</button>
            </div>
        </div>`;
    }

    _bindArchDetectHandlers() {
        const root = this.currentContainer;
        if (!root) return;

        // Toggle visualizzazione curva
        root.querySelectorAll('.ctx-archdetect-toggle-btn').forEach(btn => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                const nodeId = btn.dataset.nodeId;
                const cv = window.ibex?.curveViewer;
                if (!cv) return;

                if (cv.isVisible(nodeId)) {
                    cv.hideCurve(nodeId);
                    btn.classList.remove('is-visible');
                    btn.textContent = 'Mostra curva';
                } else {
                    // Risolvi mesh upstream + fetch .crv.json
                    const result = await this._fetchArchDetectCurve(nodeId);
                    if (!result) return;
                    cv.showCurve(nodeId, result.splines, {
                        color: 0x2A6FDB,
                        withCP: true,
                        mesh: result.mesh
                    });
                    btn.classList.add('is-visible');
                    btn.textContent = 'Nascondi curva';
                }
            };
        });

        // Aggiorna info: fetch metadata fresh + refresh sezione
        root.querySelectorAll('.ctx-archdetect-refresh-btn').forEach(btn => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                const nodeId = btn.dataset.nodeId;
                btn.textContent = 'Caricando...';
                btn.disabled = true;
                try {
                    await window.ibex?.refreshArchDetectMetadata?.(nodeId);
                    this.refresh();
                } catch (err) {
                    window.ibex?.uiMgr?.notify?.(`Errore fetch metadata: ${err.message || err}`, 'error');
                    btn.textContent = 'Aggiorna info';
                    btn.disabled = false;
                }
            };
        });

        // Ricalcola: incrementa _recompute_seq + force bake
        root.querySelectorAll('.ctx-archdetect-recompute-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const nodeId = btn.dataset.nodeId;
                const editor = window.ibex?.stackMgr?.editor;
                if (!editor) return;
                const node = editor.getNodeFromId(parseInt(nodeId, 10));
                if (!node) return;
                const params = { ...(node.data?.params || {}) };
                const prevSeq = parseInt(params._recompute_seq || 0, 10) || 0;
                params._recompute_seq = prevSeq + 1;
                node.data.params = params;
                try { editor.updateNodeDataFromId(parseInt(nodeId, 10), node.data); } catch (e) {}
                // Force bake (hasChanges troverà il diff naturalmente)
                window.ibex?.stackMgr?.bakeEngine?.requestBake?.({ force: true });
                btn.textContent = 'Ricalcolo in corso...';
                btn.disabled = true;
                window.ibex?.uiMgr?.notify?.('Ricalcolo arcata in corso...', 'info');
            };
        });

        // V1.8: Z-offset slider — update value + trigger bake on change (mouseup)
        root.querySelectorAll('.ctx-archdetect-zoffset-slider').forEach(slider => {
            const valEl = root.querySelector('.ctx-archdetect-zoffset-val');
            slider.oninput = (e) => {
                if (valEl) valEl.textContent = parseFloat(e.target.value).toFixed(1);
            };
            slider.onchange = (e) => {
                e.stopPropagation();
                const nodeId = slider.dataset.nodeId;
                const editor = window.ibex?.stackMgr?.editor;
                if (!editor) return;
                const node = editor.getNodeFromId(parseInt(nodeId, 10));
                if (!node) return;
                const params = { ...(node.data?.params || {}) };
                params._z_offset_mm = parseFloat(slider.value);
                node.data.params = params;
                try { editor.updateNodeDataFromId(parseInt(nodeId, 10), node.data); } catch (err) {}
                // hasChanges troverà il diff naturalmente → bake parte → cache
                // params-aware invalida e ricalcola
                window.ibex?.stackMgr?.bakeEngine?.requestBake?.({});
            };
        });

        // V1.8: Template dropdown — change triggera bake
        root.querySelectorAll('.ctx-archdetect-template-select').forEach(sel => {
            sel.onchange = (e) => {
                e.stopPropagation();
                const nodeId = sel.dataset.nodeId;
                const editor = window.ibex?.stackMgr?.editor;
                if (!editor) return;
                const node = editor.getNodeFromId(parseInt(nodeId, 10));
                if (!node) return;
                const params = { ...(node.data?.params || {}) };
                params._template = sel.value;
                node.data.params = params;
                try { editor.updateNodeDataFromId(parseInt(nodeId, 10), node.data); } catch (err) {}
                window.ibex?.stackMgr?.bakeEngine?.requestBake?.({});
            };
        });

        // V2.1: Helper generico per slider con bake-on-change
        const _bindSlider = (cls, paramKey, valSelector, fmt, multiplier = 1.0) => {
            root.querySelectorAll('.' + cls).forEach(slider => {
                const valEl = root.querySelector('.' + valSelector);
                slider.oninput = (e) => {
                    if (valEl) valEl.textContent = fmt(parseFloat(e.target.value));
                };
                slider.onchange = (e) => {
                    e.stopPropagation();
                    const nodeId = slider.dataset.nodeId;
                    const editor = window.ibex?.stackMgr?.editor;
                    if (!editor) return;
                    const node = editor.getNodeFromId(parseInt(nodeId, 10));
                    if (!node) return;
                    const params = { ...(node.data?.params || {}) };
                    params[paramKey] = parseFloat(slider.value) * multiplier;
                    node.data.params = params;
                    try { editor.updateNodeDataFromId(parseInt(nodeId, 10), node.data); } catch (err) {}
                    window.ibex?.stackMgr?.bakeEngine?.requestBake?.({});
                };
            });
        };
        _bindSlider('ctx-archdetect-smooth-slider', '_smoothness_sigma', 'ctx-archdetect-smooth-val',
                    (v) => v.toFixed(1));
        // V2.10: bind 'ctx-archdetect-ext-slider' RIMOSSO (slider obsoleto).

        // V2.12 PlanarZWorld checkbox
        root.querySelectorAll('.ctx-archdetect-planar-checkbox').forEach(cb => {
            cb.onchange = (e) => {
                e.stopPropagation();
                const nodeId = parseInt(cb.dataset.nodeId, 10);
                window.ibex?.stackMgr?.setNodeParam?.(nodeId, '_planarize_z_world', cb.checked);
                const node = window.ibex?.stackMgr?.editor?.getNodeFromId?.(nodeId);
                if (node) {
                    const seq = (node.data?.params?._recompute_seq || 0) + 1;
                    window.ibex.stackMgr.setNodeParam(nodeId, '_recompute_seq', seq);
                }
                window.ibex?.stackMgr?.bakeEngine?.requestBake?.({});
            };
        });
        // V2.13 AlignToWorldXY checkbox
        root.querySelectorAll('.ctx-archdetect-align-checkbox').forEach(cb => {
            cb.onchange = (e) => {
                e.stopPropagation();
                const nodeId = parseInt(cb.dataset.nodeId, 10);
                window.ibex?.stackMgr?.setNodeParam?.(nodeId, '_align_world_xy', cb.checked);
                const node = window.ibex?.stackMgr?.editor?.getNodeFromId?.(nodeId);
                if (node) {
                    const seq = (node.data?.params?._recompute_seq || 0) + 1;
                    window.ibex.stackMgr.setNodeParam(nodeId, '_recompute_seq', seq);
                }
                window.ibex?.stackMgr?.bakeEngine?.requestBake?.({});
            };
        });
    }

    /**
     * Fetch `.crv.json` di un nodo arch_detect + risolve mesh upstream
     * per matrixWorld. Ritorna { splines, mesh } o null se fallisce.
     */
    async _fetchArchDetectCurve(nodeId) {
        const stackMgr = window.ibex?.stackMgr;
        const sceneMgr = window.ibex?.sceneMgr;
        if (!stackMgr || !sceneMgr) return null;

        const graph = stackMgr.extractDAG();
        const inMeshEdge = graph.edges.find(e =>
            String(e.to_node) === String(nodeId) && e.role === 'IN_GEO_Mesh'
        );
        if (!inMeshEdge) {
            window.ibex?.uiMgr?.notify?.('Nodo non collegato a una mesh', 'warning');
            return null;
        }
        const targetName = stackMgr.resolveBaseMesh(inMeshEdge.from_mesh, inMeshEdge.from_port);
        if (!targetName) return null;
        const mesh = sceneMgr.group.children.find(c => c.isMesh && c.name === targetName);
        if (!mesh) return null;

        const stem = String(targetName).replace(/\.stl$/i, '');
        const crvFileName = `${stem}_snap_${nodeId}.crv.json`;
        try {
            const data = await window.ibex.curveViewer.fetchCurveFile(crvFileName);
            return {
                splines: Array.isArray(data?.splines) ? data.splines : [],
                mesh
            };
        } catch (err) {
            window.ibex?.uiMgr?.notify?.(`Curva non disponibile: ${err.message || err}`, 'warning');
            return null;
        }
    }
}

const impl = Impl.prototype;

export const build = impl._buildArchDetectSection;

/**
 * L'UNICA deviazione dell'intero split, e non tocca una riga del corpo.
 *
 * Il corpo VERBATIM di `_bindArchDetectHandlers` chiama
 * `this._fetchArchDetectCurve(nodeId)` — un helper che prima viveva sul
 * prototype di ContextInspector e ora vive qui. Invece di riscrivere quella
 * riga, lo installiamo una volta sola sull'istanza: idempotente, guardato,
 * e semanticamente identico (il corpo di `_fetchArchDetectCurve` non usa
 * `this` — legge tutto da `window.ibex.*`).
 */
export function bind() {
    if (typeof this._fetchArchDetectCurve !== 'function') {
        this._fetchArchDetectCurve = impl._fetchArchDetectCurve;
    }
    return impl._bindArchDetectHandlers.call(this);
}
