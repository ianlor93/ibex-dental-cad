// ═══════════════════════════════════════════════════════════════
// IBEX ImportPicker Import_V1.0 — «File → Importa mesh» (S5, 2026-07-10)
//
// File browser modal su storage Nextcloud dell'utente (riusa l'endpoint
// list_nextcloud_dirs del tree picker export). Divergenze da ExportPicker:
//   - MULTI-SELECT di FILE .stl (Set di relative path); le cartelle sono
//     solo navigazione.
//   - Filtro client .stl (il server ri-valida comunque: estensione,
//     realpath sandbox, whitelist basename).
//   - Conferma → POST /?action=import_files {id, files[]} → il worker
//     accoda IMPORT_FILES (copia in active_path + scene.blend update).
//   - Successo → checkpoint sessione (ibexSaveSession) + soft-reload:
//     location.reload() cieco — status DB 'queued' fa atterrare l'editor
//     sulla loading page con meta-refresh finché il worker non finisce.
//     (check_status NON è usabile: determineStatus vede scene.blend e
//     risponde 'ready' subito — vedi recon S5.)
//   - Zero accoppiamento con nodi DAG (nessun nodeId).
// ═══════════════════════════════════════════════════════════════

// T1Escape_29-7 — `_escapeHtml` locale collassato nell'util condiviso.
import { escapeHtml } from './dom-escape.js?v=T1Escape_29-7';

export class ImportPicker {
    constructor(ibex) {
        this.ibex = ibex;
        this._modalEl = null;
        this._currentPath = '';
        this._selected = new Set();   // relative path (es. "Scansioni/Upper.stl")
        this._busy = false;
    }

    // ─── API pubblica ─────────────────────────────────────────────

    open() {
        this._selected.clear();
        this._busy = false;
        this._currentPath = '';
        this._buildModal();
        this._updateFooter();
        this._loadPath('');
    }

    // ─── Modal ───────────────────────────────────────────────────

    _buildModal() {
        if (this._modalEl) {
            this._modalEl.style.display = 'flex';
            return;
        }
        const wrap = document.createElement('div');
        wrap.id = 'ibex-import-picker-modal';
        wrap.style.cssText = `
            position:fixed; inset:0; z-index:10000;
            background:rgba(0,0,0,0.5);
            display:flex; align-items:center; justify-content:center;
            font:13px/1.4 'Ubuntu', sans-serif;`;
        wrap.innerHTML = `
            <div class="ibex-import-modal" style="
                background:#ffffff; color:#1a1a1a;
                width:560px; max-height:80vh;
                display:flex; flex-direction:column;
                border:1px solid #2a2a2a; border-radius:4px;
                box-shadow:0 8px 32px rgba(0,0,0,0.25);">
                <div style="padding:12px 16px; border-bottom:1px solid #E3E5E7;
                            display:flex; justify-content:space-between; align-items:center;">
                    <strong>Importa mesh da Nextcloud</strong>
                    <button class="ibex-import-modal-close" style="
                        background:transparent; border:0; font-size:18px;
                        cursor:pointer; color:#6E6B66;">✕</button>
                </div>
                <div style="display:flex; gap:8px; padding:8px 16px;
                            background:#F4F5F6; border-bottom:1px solid #E3E5E7;
                            align-items:center; flex-wrap:wrap;">
                    <button class="ibex-import-up-btn" style="
                        background:#fff; border:1px solid #A8A6A1; padding:4px 10px;
                        cursor:pointer; border-radius:3px; font-size:11px;
                        white-space:nowrap;">↩ Su</button>
                    <div class="ibex-import-breadcrumb" style="
                        font-family:'Ubuntu Mono', monospace;
                        font-size:11px; word-break:break-all; flex:1;
                        min-width:0;"></div>
                </div>
                <div class="ibex-import-tree" style="
                    flex:1; overflow:auto; padding:4px 0;
                    background:#fcfcfc; min-height:240px; max-height:50vh;"></div>
                <div style="padding:10px 16px; border-top:1px solid #E3E5E7;
                            display:flex; gap:8px; justify-content:space-between;
                            align-items:center; flex-wrap:wrap;">
                    <span class="ibex-import-modal-info" style="
                        font-size:11px; color:#6E6B66; flex:1; min-width:0;
                        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
                    <div style="display:flex; gap:8px;">
                        <button class="ibex-import-modal-cancel" style="
                            background:#fff; border:1px solid #A8A6A1;
                            padding:6px 14px; cursor:pointer; border-radius:2px;">
                            Annulla
                        </button>
                        <button class="ibex-import-modal-confirm" disabled style="
                            background:#FF6037; color:white; border:0;
                            padding:6px 14px; cursor:pointer; border-radius:2px;
                            font-weight:600; opacity:0.5;">
                            Importa
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(wrap);
        this._modalEl = wrap;

        wrap.querySelector('.ibex-import-modal-close').onclick   = () => this._closeModal();
        wrap.querySelector('.ibex-import-modal-cancel').onclick  = () => this._closeModal();
        wrap.querySelector('.ibex-import-modal-confirm').onclick = () => this._confirm();
        wrap.querySelector('.ibex-import-up-btn').onclick        = () => this._navigateUp();
        wrap.onclick = (e) => { if (e.target === wrap) this._closeModal(); };
    }

    _closeModal() {
        if (this._busy) return; // niente chiusura durante il POST
        if (this._modalEl) this._modalEl.style.display = 'none';
    }

    _navigateUp() {
        if (!this._currentPath) return;
        const parts = this._currentPath.split('/').filter(s => s);
        parts.pop();
        this._loadPath(parts.join('/'));
    }

    // ─── Navigazione + render ────────────────────────────────────

    async _loadPath(relPath) {
        this._currentPath = relPath || '';
        if (!this._modalEl) return;
        const breadcrumb = this._modalEl.querySelector('.ibex-import-breadcrumb');
        const tree       = this._modalEl.querySelector('.ibex-import-tree');
        const upBtn      = this._modalEl.querySelector('.ibex-import-up-btn');

        if (upBtn) {
            upBtn.disabled = !this._currentPath;
            upBtn.style.opacity = upBtn.disabled ? '0.4' : '1';
            upBtn.style.cursor  = upBtn.disabled ? 'default' : 'pointer';
        }

        const segs = (relPath || '').split('/').filter(s => s);
        const parts = ['<a href="#" data-path="" style="color:#FF6037; text-decoration:none;">📂 ~/Nextcloud/files</a>'];
        let acc = '';
        segs.forEach((seg) => {
            acc = acc ? acc + '/' + seg : seg;
            parts.push(`<span style="color:#A8A6A1;"> / </span>`);
            parts.push(`<a href="#" data-path="${escapeHtml(acc)}" style="color:#FF6037; text-decoration:none;">${escapeHtml(seg)}</a>`);
        });
        breadcrumb.innerHTML = parts.join('');
        breadcrumb.querySelectorAll('a').forEach(a => {
            a.onclick = (e) => { e.preventDefault(); this._loadPath(a.dataset.path || ''); };
        });

        tree.innerHTML = '<div style="padding:12px 16px; color:#6E6B66;">Caricamento...</div>';

        try {
            const url = `/?action=list_nextcloud_dirs&path=${encodeURIComponent(relPath || '')}`;
            const resp = await fetch(url);
            const data = await resp.json();
            if (!resp.ok || data.error) {
                tree.innerHTML = `<div style="padding:12px 16px; color:#C4302B;">
                    Errore: ${escapeHtml(data.error || ('HTTP ' + resp.status))}
                </div>`;
                return;
            }
            const dirs = data.dirs || [];
            const stls = (data.files || []).filter(f => /\.stl$/i.test(f.name));

            if (!dirs.length && !stls.length) {
                tree.innerHTML = `<div style="padding:12px 16px; color:#6E6B66;">
                    <em>Nessuna cartella né file STL qui.</em>
                </div>`;
                this._updateFooter();
                return;
            }

            const itemHtml = (icon, name, sub, dataKind, dataRel, checked) => `
                <div class="ibex-import-tree-item"
                     data-kind="${dataKind}" data-rel="${escapeHtml(dataRel)}"
                     style="padding:6px 16px; cursor:pointer;
                            display:flex; align-items:center; gap:10px;
                            border-bottom:1px solid #f0f0f0;
                            ${checked ? 'background:rgba(255,96,55,0.08);' : ''}">
                    <span class="ibex-import-check" style="font-size:13px; flex:0 0 18px;
                          color:${checked ? '#FF6037' : '#D2D5D8'};">${dataKind === 'file' ? (checked ? '☑' : '☐') : ''}</span>
                    <span style="font-size:14px; flex:0 0 18px;">${icon}</span>
                    <span style="flex:1; min-width:0; overflow:hidden;
                                 text-overflow:ellipsis; white-space:nowrap;">
                        ${escapeHtml(name)}
                    </span>
                    ${sub ? `<span style="font-size:10px; color:#6E6B66; flex:0 0 auto;">${sub}</span>` : ''}
                </div>`;

            const dirsHtml = dirs.map(d => {
                const rel = relPath ? `${relPath}/${d}` : d;
                return itemHtml('<span style="color:#FF6037;">📁</span>', d, '', 'dir', rel, false);
            }).join('');

            const filesHtml = stls.map(f => {
                const rel = relPath ? `${relPath}/${f.name}` : f.name;
                const sizeKb = f.size > 1024 * 1024
                    ? (f.size / (1024 * 1024)).toFixed(1) + ' MB'
                    : Math.max(1, Math.round(f.size / 1024)) + ' KB';
                return itemHtml('<span style="opacity:0.7;">📄</span>', f.name, sizeKb,
                                'file', rel, this._selected.has(rel));
            }).join('');

            tree.innerHTML = dirsHtml + filesHtml;

            tree.querySelectorAll('.ibex-import-tree-item').forEach(it => {
                const kind = it.dataset.kind;
                const rel  = it.dataset.rel;
                it.onmouseenter = () => { if (!this._selected.has(rel)) it.style.background = '#F4F5F6'; };
                it.onmouseleave = () => { it.style.background = this._selected.has(rel) ? 'rgba(255,96,55,0.08)' : ''; };
                it.onclick = () => {
                    if (kind === 'dir') {
                        this._loadPath(rel);
                        return;
                    }
                    // toggle selezione file
                    if (this._selected.has(rel)) this._selected.delete(rel);
                    else this._selected.add(rel);
                    const on = this._selected.has(rel);
                    const chk = it.querySelector('.ibex-import-check');
                    if (chk) { chk.textContent = on ? '☑' : '☐'; chk.style.color = on ? '#FF6037' : '#D2D5D8'; }
                    it.style.background = on ? 'rgba(255,96,55,0.08)' : '';
                    this._updateFooter();
                };
            });

            this._updateFooter();
        } catch (e) {
            tree.innerHTML = `<div style="padding:12px 16px; color:#C4302B;">
                Errore di rete: ${escapeHtml(e.message || String(e))}
            </div>`;
        }
    }

    _updateFooter() {
        if (!this._modalEl) return;
        const info    = this._modalEl.querySelector('.ibex-import-modal-info');
        const confirm = this._modalEl.querySelector('.ibex-import-modal-confirm');
        const n = this._selected.size;
        if (info) info.textContent = n ? `${n} file selezionat${n === 1 ? 'o' : 'i'}` : 'Seleziona uno o più file STL';
        if (confirm) {
            confirm.disabled = (n === 0 || this._busy);
            confirm.style.opacity = confirm.disabled ? '0.5' : '1';
            confirm.textContent = this._busy ? 'Importando...' : (n ? `Importa ${n} file` : 'Importa');
        }
    }

    // ─── Conferma → POST import_files → soft-reload ──────────────

    async _confirm() {
        if (this._busy || !this._selected.size) return;
        this._busy = true;
        this._updateFooter();
        this.ibex.uiMgr?.showWorkerStatus?.('Import mesh in corso...');

        try {
            const fd = new FormData();
            fd.append('id', String(this.ibex.config.projectId));
            this._selected.forEach(rel => fd.append('files[]', rel));

            const resp = await fetch('/?action=import_files', { method: 'POST', body: fd });
            const data = await resp.json();

            if (!data.success) {
                this._busy = false;
                this._updateFooter();
                this.ibex.uiMgr?.hideWorkerStatus?.();
                this._notify(`Import fallito: ${data.error || 'errore sconosciuto'}`, 'error');
                return;
            }

            // Checkpoint sessione (best-effort) PRIMA del reload: DAG/visuals
            // correnti finiscono nel manifest, il reload non li perde.
            try { if (window.ibexSaveSession) window.ibexSaveSession(); } catch (e) {}

            this._notify(`Import di ${data.count} file avviato — ricarico l'editor...`, 'success');
            // Soft-reload cieco: status DB 'queued' → editor() mostra la
            // loading page con meta-refresh finché IMPORT_FILES non chiude.
            setTimeout(() => { location.reload(); }, 300);
        } catch (e) {
            this._busy = false;
            this._updateFooter();
            this.ibex.uiMgr?.hideWorkerStatus?.();
            this._notify(`Errore di rete: ${e.message || e}`, 'error');
        }
    }

    // ─── Helper ──────────────────────────────────────────────────

    _notify(msg, type = 'info') {
        if (this.ibex.uiMgr?.notify) this.ibex.uiMgr.notify(msg, type);
        else console.log(`[Import ${type}] ${msg}`);
    }
}
