// ═══════════════════════════════════════════════════════════════
// IBEX ExportPicker ExportNodeSTL_V1.1 — file browser modal + exec POST
//
// V1.1 (2026-05-03 fix UX): trasformato in vero FILE BROWSER.
//   - Mostra cartelle E file (con size + mtime), non solo cartelle.
//   - Click su cartella → naviga dentro (come prima).
//   - Click su file → autofill input "Nome file" + scroll a quel file
//     evidenziato (utile workflow overwrite).
//   - Bottone "↩ Su" sempre visibile per tornare al parent.
//   - Breadcrumb path interattivo + bottone esplicito "/ Home".
//   - Warning rosso se il filename inserito coincide con un file
//     esistente nella cartella corrente (sovrascriverà).
//
// Gestisce le 2 interazioni del nodo `export_stl`:
//   - openDirPicker(nodeId) — modal file browser lazy
//   - execute(nodeId)       — POST a /?action=export_node_stl + UI feedback
// ═══════════════════════════════════════════════════════════════

// T1Escape_29-7 — `_escapeHtml` locale collassato nell'util condiviso.
import { escapeHtml } from './dom-escape.js?v=T1Escape_29-7';

export class ExportPicker {
    constructor(ibex) {
        this.ibex = ibex;
        this._modalEl = null;
        this._currentNodeId = null;
        this._currentPath = '';
    }

    // ─── File browser modal ───────────────────────────────────────

    openDirPicker(nodeId) {
        this._currentNodeId = String(nodeId);
        const node = this.ibex.stackMgr?.editor?.getNodeFromId(parseInt(nodeId, 10));
        /* IBEX-27-7 radice — '/' è la SENTINELLA «radice scelta», non un path.
           Dentro il picker si naviga sempre con path relativi puliti: '' = radice. */
        const salvato   = node?.data?.params?.directory_path || '';
        const startPath = salvato === '/' ? '' : salvato;
        this._currentPath = startPath;
        this._buildModal();
        this._loadPath(startPath);
    }

    _buildModal() {
        if (this._modalEl) {
            this._modalEl.style.display = 'flex';
            return;
        }
        const wrap = document.createElement('div');
        wrap.id = 'ibex-export-picker-modal';
        wrap.style.cssText = `
            position:fixed; inset:0; z-index:10000;
            background:rgba(0,0,0,0.5);
            display:flex; align-items:center; justify-content:center;
            font:13px/1.4 'Ubuntu', sans-serif;`;
        wrap.innerHTML = `
            <div class="ibex-export-modal" style="
                background:#ffffff; color:#1a1a1a;
                width:560px; max-height:80vh;
                display:flex; flex-direction:column;
                border:1px solid #2a2a2a; border-radius:4px;
                box-shadow:0 8px 32px rgba(0,0,0,0.25);">
                <div style="padding:12px 16px; border-bottom:1px solid #E3E5E7;
                            display:flex; justify-content:space-between; align-items:center;">
                    <strong>Scegli cartella destinazione</strong>
                    <button class="ibex-export-modal-close" style="
                        background:transparent; border:0; font-size:18px;
                        cursor:pointer; color:#6E6B66;">✕</button>
                </div>
                <div style="display:flex; gap:8px; padding:8px 16px;
                            background:#F4F5F6; border-bottom:1px solid #E3E5E7;
                            align-items:center; flex-wrap:wrap;">
                    <button class="ibex-export-up-btn" style="
                        background:#fff; border:1px solid #A8A6A1; padding:4px 10px;
                        cursor:pointer; border-radius:3px; font-size:11px;
                        white-space:nowrap;">↩ Su</button>
                    <div class="ibex-export-breadcrumb" style="
                        font-family:'Ubuntu Mono', monospace;
                        font-size:11px; word-break:break-all; flex:1;
                        min-width:0;"></div>
                </div>
                <div class="ibex-export-tree" style="
                    flex:1; overflow:auto; padding:4px 0;
                    background:#fcfcfc; min-height:240px; max-height:50vh;"></div>
                <div style="padding:10px 16px; border-top:1px solid #E3E5E7;
                            display:flex; gap:8px; justify-content:space-between;
                            align-items:center; flex-wrap:wrap;">
                    <span class="ibex-export-modal-info" style="
                        font-size:11px; color:#6E6B66; flex:1; min-width:0;
                        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
                    <div style="display:flex; gap:8px;">
                        <button class="ibex-export-modal-cancel" style="
                            background:#fff; border:1px solid #A8A6A1;
                            padding:6px 14px; cursor:pointer; border-radius:2px;">
                            Annulla
                        </button>
                        <button class="ibex-export-modal-select" style="
                            background:#FF6037; color:white; border:0;
                            padding:6px 14px; cursor:pointer; border-radius:2px;
                            font-weight:600;">
                            Burn qui
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(wrap);
        this._modalEl = wrap;

        wrap.querySelector('.ibex-export-modal-close').onclick  = () => this._closeModal();
        wrap.querySelector('.ibex-export-modal-cancel').onclick = () => this._closeModal();
        wrap.querySelector('.ibex-export-modal-select').onclick = () => this._selectCurrent();
        wrap.querySelector('.ibex-export-up-btn').onclick       = () => this._navigateUp();
        wrap.onclick = (e) => { if (e.target === wrap) this._closeModal(); };
    }

    _closeModal() {
        if (this._modalEl) this._modalEl.style.display = 'none';
        this._currentNodeId = null;
    }

    _navigateUp() {
        if (!this._currentPath) return; // già root
        const parts = this._currentPath.split('/').filter(s => s);
        parts.pop();
        this._loadPath(parts.join('/'));
    }

    async _loadPath(relPath) {
        this._currentPath = (relPath && relPath !== '/') ? relPath : '';   // IBEX-27-7 radice
        if (!this._modalEl) return;
        const breadcrumb = this._modalEl.querySelector('.ibex-export-breadcrumb');
        const tree       = this._modalEl.querySelector('.ibex-export-tree');
        const upBtn      = this._modalEl.querySelector('.ibex-export-up-btn');
        const info       = this._modalEl.querySelector('.ibex-export-modal-info');

        // Up button disabilitato se siamo già alla root
        if (upBtn) {
            upBtn.disabled = !this._currentPath;
            upBtn.style.opacity = upBtn.disabled ? '0.4' : '1';
            upBtn.style.cursor  = upBtn.disabled ? 'default' : 'pointer';
        }

        // Breadcrumb cliccabile (segmenti separati con / rilegati al click)
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
        if (info) info.textContent = '';

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
            const dirs  = data.dirs  || [];
            const files = data.files || [];

            if (info) {
                info.textContent = `${dirs.length} cartelle, ${files.length} file`;
            }

            const targetFilename = this._getTargetFilename();
            const collidingFile  = targetFilename
                ? files.find(f => f.name.toLowerCase() === targetFilename.toLowerCase())
                : null;

            if (!dirs.length && !files.length) {
                tree.innerHTML = `<div style="padding:12px 16px; color:#6E6B66;">
                    <em>Cartella vuota.</em><br>
                    Clicca "Burn qui" per usare questa cartella come destinazione.
                </div>`;
                return;
            }

            // Renderer item: cartella verde + file grigio.
            // Cartelle prima, poi file.
            const itemHtml = (icon, name, sub, dataKind, dataName, extraStyle = '') => `
                <div class="ibex-export-tree-item"
                     data-kind="${dataKind}" data-name="${escapeHtml(dataName)}"
                     style="padding:6px 16px; cursor:pointer;
                            display:flex; align-items:center; gap:10px;
                            border-bottom:1px solid #f0f0f0;
                            ${extraStyle}">
                    <span style="font-size:14px; flex:0 0 18px;">${icon}</span>
                    <span style="flex:1; min-width:0; overflow:hidden;
                                 text-overflow:ellipsis; white-space:nowrap;">
                        ${escapeHtml(name)}
                    </span>
                    ${sub ? `<span style="font-size:10px; color:#6E6B66; flex:0 0 auto;">${sub}</span>` : ''}
                </div>`;

            const dirsHtml = dirs.map(d => itemHtml(
                '<span style="color:#FF6037;">📁</span>',
                d, '',
                'dir', d
            )).join('');

            const filesHtml = files.map(f => {
                const sizeKb = f.size > 1024 * 1024
                    ? (f.size / (1024 * 1024)).toFixed(1) + ' MB'
                    : Math.max(1, Math.round(f.size / 1024)) + ' KB';
                const isCollision = collidingFile && collidingFile.name === f.name;
                const extra = isCollision
                    ? 'background:rgba(196,48,43,0.08); border-left:3px solid #C4302B;'
                    : 'color:#555;';
                return itemHtml(
                    '<span style="opacity:0.7;">📄</span>',
                    f.name, sizeKb,
                    'file', f.name, extra
                );
            }).join('');

            tree.innerHTML = dirsHtml + filesHtml;

            tree.querySelectorAll('.ibex-export-tree-item').forEach(it => {
                const kind = it.dataset.kind;
                const name = it.dataset.name;
                it.onmouseenter = () => {
                    if (it.style.background === 'rgb(255, 245, 240)') return; // collision keep
                    it.style.background = '#F4F5F6';
                };
                it.onmouseleave = () => {
                    if (it.style.borderLeft && it.style.borderLeft.includes('rgb(220, 38, 38)')) {
                        it.style.background = 'rgba(196,48,43,0.08)';
                    } else {
                        it.style.background = '';
                    }
                };
                it.onclick = () => {
                    if (kind === 'dir') {
                        const newPath = relPath ? `${relPath}/${name}` : name;
                        this._loadPath(newPath);
                    } else if (kind === 'file') {
                        // Click file → autofill filename input + flash visual
                        this._fillFilenameFromExisting(name);
                        // Visual feedback: pulse di flash
                        const orig = it.style.background;
                        it.style.background = '#fde047';
                        setTimeout(() => { it.style.background = orig; }, 250);
                    }
                };
            });

            // Se c'è collision, scroll al file collidente
            if (collidingFile) {
                const node = tree.querySelector(`.ibex-export-tree-item[data-kind="file"][data-name="${this._escapeAttr(collidingFile.name)}"]`);
                if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        } catch (e) {
            tree.innerHTML = `<div style="padding:12px 16px; color:#C4302B;">
                Errore di rete: ${escapeHtml(e.message || String(e))}
            </div>`;
        }
    }

    _getTargetFilename() {
        if (!this._currentNodeId) return '';
        const inp = document.querySelector(`#node-${this._currentNodeId} .ibex-export-filename`);
        const v = (inp?.value || '').trim();
        if (!v) return '';
        return this._conEstensione(v, this._formatoDelNodo(this._currentNodeId));
    }

    _fillFilenameFromExisting(name) {
        if (!this._currentNodeId) return;
        // Centralizza via setNodeParam: aggiorna data.params + sync DOM nodo + inspector.
        if (this.ibex.stackMgr?.setNodeParam) {
            this.ibex.stackMgr.setNodeParam(this._currentNodeId, 'filename_override', name);
        }
        // Notify visiva
        if (this.ibex.uiMgr?.notify) {
            this.ibex.uiMgr.notify(`Nome file impostato a "${name}" (sovrascriverà il file esistente)`, 'warning');
        }
    }

    _selectCurrent() {
        if (!this._currentNodeId) return this._closeModal();
        const nodeId = this._currentNodeId;
        /* IBEX-27-7 radice — alla radice `_currentPath` è '', che però significa
           già «mai scelta». Si scrive '/' per dire «scelta: la principale». */
        const path = this._currentPath || '/';

        // setNodeParam centralizzato: aggiorna data.params + sync DOM
        // (button label nel nodo via _refreshSingleExportNode + widget
        // standard nell'inspector via _syncWidgetValue).
        if (this.ibex.stackMgr?.setNodeParam) {
            this.ibex.stackMgr.setNodeParam(nodeId, 'directory_path', path);
        }
        if (this.ibex.inspectorPanel?.refresh) this.ibex.inspectorPanel.refresh();

        this._closeModal();
    }

    // ─── Execute (POST export) ────────────────────────────────────

    async execute(nodeId) {
        nodeId = String(nodeId);
        const drawflowId = parseInt(nodeId, 10);
        const node = this.ibex.stackMgr.editor.getNodeFromId(drawflowId);
        if (!node) return this._notify('Nodo non trovato', 'error');

        const meshName = this._resolveMeshFromNode(nodeId);
        if (!meshName) {
            return this._notify('Collega una mesh al nodo Burn.', 'warning');
        }

        const params = node.data?.params || {};
        const dirPath = params.directory_path || '';
        const dirRel  = dirPath === '/' ? '' : dirPath;   // IBEX-27-7 radice
        /* IBEX-EXPORT-27-7 §B — il formato si legge dai PARAMS, mai dal DOM
           (al contrario del filename qui sotto, che legge il DOM perché
           `onchange` può non essere ancora scattato mentre l'utente digita).
           Un <select> emette `change` alla selezione: niente ritardo da
           recuperare, e il burn funziona anche con l'ispettore aperto e il
           nodo DAG non renderizzato. */
        const fmt = this._formatoDelNodo(nodeId);

        let filename = (params.filename_override || '').trim();
        const filenameInput = document.querySelector(`#node-${nodeId} .ibex-export-filename`);
        if (filenameInput) filename = (filenameInput.value || filename).trim();

        if (!filename) {
            const stem = meshName.replace(/\.stl$/i, '');
            const projectName = this.ibex.config?.projectName || 'project';
            const ts = new Date();
            const stamp = `${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}-${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}`;
            filename = `${projectName}_${stem}_${stamp}.${fmt}`;
        }
        filename = this._conEstensione(filename, fmt);

        if (filenameInput && filenameInput.value && filenameInput.value !== params.filename_override) {
            const data = { ...node.data };
            data.params = { ...(data.params || {}), filename_override: filenameInput.value };
            this.ibex.stackMgr.editor.updateNodeDataFromId(drawflowId, data);
        }

        const exportBtn = document.querySelector(`#node-${nodeId} .ibex-export-btn`);
        const statusEl  = document.querySelector(`#node-${nodeId} .ibex-export-status`);
        if (exportBtn) { exportBtn.disabled = true; exportBtn.textContent = 'Burn in corso…'; }
        if (statusEl)  { statusEl.dataset.state = 'busy'; statusEl.textContent = 'Burn in corso…'; }
        this.ibex.uiMgr?.showWorkerStatus?.('Burn in corso…');

        try {
            const fd = new FormData();
            fd.append('project_id', String(this.ibex.config.projectId));
            fd.append('mesh_name', meshName);
            fd.append('directory_path', dirRel);
            fd.append('filename', filename);
            fd.append('format', fmt);          // IBEX-EXPORT-27-7 §B — quinto campo

            const resp = await fetch('/?action=export_node_stl', {
                method: 'POST',
                body: fd
            });
            const data = await resp.json();

            if (!data.success) {
                if (statusEl) {
                    statusEl.dataset.state = 'error';
                    statusEl.textContent = `Errore: ${data.error || 'sconosciuto'}`;
                }
                this._notify(`Burn fallito: ${data.error || 'errore'}`, 'error');
                return;
            }

            const meta = { ...(node.data?.meta || {}) };
            meta.last_export_at   = data.timestamp || Math.floor(Date.now() / 1000);
            meta.last_export_path = data.path || '';
            const newData = { ...node.data, meta };
            this.ibex.stackMgr.editor.updateNodeDataFromId(drawflowId, newData);

            if (statusEl) {
                statusEl.dataset.state = 'ok';
                statusEl.textContent = `OK · ${data.path}`;
            }

            const sizeKb = Math.round((data.size || 0) / 1024);
            this._notify(`Burn: ~/${data.path} (${sizeKb} KB)`, 'success');
        } catch (e) {
            if (statusEl) {
                statusEl.dataset.state = 'error';
                statusEl.textContent = `Errore di rete: ${e.message || e}`;
            }
            this._notify(`Errore di rete: ${e.message || e}`, 'error');
        } finally {
            if (exportBtn) { exportBtn.disabled = false; exportBtn.textContent = 'Burn'; }
            this.ibex.uiMgr?.hideWorkerStatus?.();
        }
    }

    // ─── Helper ──────────────────────────────────────────────────

    /* IBEX-EXPORT-27-7 §B — formato di esportazione.
       Il backend accetta stl|obj|ply da L10.3 (whitelist server-side); qui si
       cabla l'ultimo metro. Il formato vive in `params.format_override`,
       assente ⇒ 'stl' ⇒ comportamento byte-identico a prima. */
    static get FORMATI() { return ['stl', 'obj', 'ply']; }

    _formatoDelNodo(nodeId) {
        const node = this.ibex.stackMgr?.editor?.getNodeFromId?.(parseInt(nodeId, 10));
        const f = String(node?.data?.params?.format_override || 'stl').toLowerCase();
        return ExportPicker.FORMATI.includes(f) ? f : 'stl';
    }

    /* Sostituisce l'estensione invece di appenderla: se l'utente ha scritto
       "pippo.stl" e poi ha scelto OBJ, il server rifiuterebbe "pippo.stl"
       (la sua regex è `^[A-Za-z0-9 _.\-()]+\.{fmt}$`). Lo strip/riappendi
       non introduce caratteri fuori da quella classe. */
    _conEstensione(nome, fmt) {
        const base = String(nome || '').trim().replace(/\.(stl|obj|ply)$/i, '');
        return base ? `${base}.${fmt}` : '';
    }

    _resolveMeshFromNode(nodeId) {
        try {
            const graph = this.ibex.stackMgr.extractDAG();
            const inEdges = (graph.edges || []).filter(e => String(e.to_node) === String(nodeId));
            const inEdge = inEdges.find(e => e.role === 'IN_GEO_Mesh') || inEdges[0];
            if (!inEdge) return null;
            return this.ibex.stackMgr.resolveBaseMesh(inEdge.from_mesh, inEdge.from_port);
        } catch (e) {
            console.warn('[ExportPicker] resolveMeshFromNode err:', e);
            return null;
        }
    }

    _notify(msg, type = 'info') {
        if (this.ibex.uiMgr?.notify) this.ibex.uiMgr.notify(msg, type);
        else console.log(`[Export ${type}] ${msg}`);
    }

    _escapeAttr(s) {
        return String(s).replace(/"/g, '&quot;');
    }
}
