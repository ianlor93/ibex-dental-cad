// ═══════════════════════════════════════════════════════════════
// IBEX inspector · burn — GodSplit_29-7 (2026-07-29)
//
// Sezione + handler del nodo `burn` (ex export_stl). Estratto dalle righe 1694-1798. `build` usa `escapeHtml` — dal 29/7 (T1Escape) NON più `this._escapeHtml` del dispatcher, ma l'util condiviso `../dom-escape.js` (stessa funzione, importata invece che ereditata dal receiver).
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

// T1Escape_29-7 — l'escape non è più un helper del dispatcher: arriva
// dall'util condiviso (stesso token `?v=` degli altri 3 import site,
// Inv. 101 — stesso URL assoluto ⇒ un solo modulo ESM).
import { escapeHtml } from '../dom-escape.js?v=T1Escape_29-7';

class Impl {
    // ─────────────────────────────────────────────────────────────
    // ExportNodeSTL (2026-05-03) — sezione inspector per nodo `export_stl`
    // Mirror dei controlli del nodo DAG: bottone directory (apre tree picker),
    // input filename, bottone Esporta. Mostra status ultimo export se presente.
    // ─────────────────────────────────────────────────────────────
    _buildExportSection(nodeId) {
        const node = window.ibex?.stackMgr?.editor?.getNodeFromId(parseInt(nodeId, 10));
        const params = node?.data?.params || {};
        const meta = node?.data?.meta || {};
        const dirPath = params.directory_path || '';
        const filenameOverride = params.filename_override || '';
        /* IBEX-EXPORT-27-7 §B — formato di esportazione. Qui il `selected`
           SERVE, perché l'ispettore si ri-renderizza da zero a ogni apertura
           (a differenza del nodo DAG, che viene toppato da
           _refreshSingleExportNode). */
        const formatoCorrente = (() => {
            const f = String(params.format_override || 'stl').toLowerCase();
            return ['stl', 'obj', 'ply'].includes(f) ? f : 'stl';
        })();

        // IBEX-27-7 radice — '/' = radice scelta, '' = mai scelta. Testo
        // IDENTICO al gemello in StackManager._refreshSingleExportNode (Inv. 123).
        const dirLabel = dirPath === '/' ? '📁 / — cartella principale'
                       : dirPath ? `📁 ${escapeHtml(dirPath)}`
                       : '📁 — Scegli cartella —';

        let statusHtml = '<div class="ctx-export-status" data-state="idle">nessun burn</div>';
        if (meta.last_export_at && meta.last_export_path) {
            const dt = new Date(meta.last_export_at * 1000);
            const dts = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
            statusHtml = `<div class="ctx-export-status" data-state="ok">
                <strong>Ultimo burn:</strong> ${dts}<br>
                ~/${escapeHtml(meta.last_export_path)}
            </div>`;
        }

        return `<div class="ctx-export-row">
            <label class="ctx-export-label">Cartella destinazione</label>
            <button class="ctx-export-dir-btn" data-node-id="${nodeId}">${dirLabel}</button>
        </div>
        <div class="ctx-export-row">
            <label class="ctx-export-label">Nome file (opzionale)</label>
            <input class="ctx-export-filename" type="text"
                   data-node-id="${nodeId}" data-key="filename_override"
                   placeholder="auto" value="${escapeHtml(filenameOverride)}">
        </div>
        <div class="ctx-export-row">
            <label class="ctx-export-label">Formato</label>
            <select class="ctx-export-format" data-node-id="${nodeId}" data-key="format_override"
                    title="OBJ e PLY sono formati di consegna: IBEX non li reimporta."
                    style="width:100%; padding:5px 8px; background:var(--ibex-surface); color:var(--ibex-text); border:1px solid var(--ibex-border); border-radius:3px; font-size:10px; font-family:'Ubuntu Mono', monospace; box-sizing:border-box; cursor:pointer;">
                <option value="stl"${formatoCorrente === 'stl' ? ' selected' : ''}>STL</option>
                <option value="obj"${formatoCorrente === 'obj' ? ' selected' : ''}>OBJ</option>
                <option value="ply"${formatoCorrente === 'ply' ? ' selected' : ''}>PLY</option>
            </select>
        </div>
        <button class="ctx-export-btn" data-node-id="${nodeId}">Burn</button>
        ${statusHtml}`;
    }

    _bindExportHandlers() {
        const root = this.currentContainer;
        if (!root) return;

        root.querySelectorAll('.ctx-export-dir-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const nodeId = btn.dataset.nodeId;
                if (window.ibex?.exportPicker) window.ibex.exportPicker.openDirPicker(nodeId);
            };
        });

        root.querySelectorAll('.ctx-export-filename').forEach(inp => {
            inp.onchange = (e) => {
                e.stopPropagation();
                const nodeId = inp.dataset.nodeId;
                if (window.ibex?.stackMgr?.setNodeParam) {
                    // Setter centralizzato: aggiorna data.params + sync DOM
                    // bidirezionale (nodo DAG + altri widget inspector).
                    // skip sourceEl per non interferire col cursore di chi sta digitando.
                    window.ibex.stackMgr.setNodeParam(nodeId, 'filename_override', inp.value || '', { sourceEl: inp });
                }
            };
        });

        // IBEX-EXPORT-27-7 §B — gemello del selettore formato (Inv. 123).
        root.querySelectorAll('.ctx-export-format').forEach(sel => {
            sel.onchange = (e) => {
                e.stopPropagation();
                const nodeId = sel.dataset.nodeId;
                if (window.ibex?.stackMgr?.setNodeParam) {
                    window.ibex.stackMgr.setNodeParam(nodeId, 'format_override', sel.value || 'stl', { sourceEl: sel });
                }
            };
        });

        root.querySelectorAll('.ctx-export-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const nodeId = btn.dataset.nodeId;
                if (window.ibex?.exportPicker) window.ibex.exportPicker.execute(nodeId);
            };
        });
    }
}

const impl = Impl.prototype;

export const build = impl._buildExportSection;
export const bind  = impl._bindExportHandlers;
