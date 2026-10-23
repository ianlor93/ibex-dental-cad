// ═══════════════════════════════════════════════════════════════
// IBEX PresetSidebar Preset_V1.0 (2026-05-05)
//
// Renderizza la sidebar "Preset" sotto la Toolbar nel DAG.
// 2 tab: "Privati" (utente NC) / "Pubblici" (pool curato admin).
// Lista popolata via GET ?action=list_presets al boot + dopo save/delete.
// Cards draggable: dragstart imposta `dataTransfer['ibex-type']='preset'`,
// `[ibex-preset-id]`, `[ibex-preset-ns]` → IbexCore.dropMeshToCanvas
// riconosce il type → StackManager.spawnPreset.
// Tab Pubblici: cards SENZA bottone delete (read-only per l'utente).
// ═══════════════════════════════════════════════════════════════

export class PresetSidebar {
    constructor(stackMgr, uiMgr) {
        this.stackMgr = stackMgr;
        this.uiMgr    = uiMgr;
        this._initialized = false;
        // V1.1 (2026-05-05) — admin flag esposto da listPresets endpoint.
        // Membri del gruppo NC "Amministrazione" possono salvare nel pool
        // pubblico (logic_preset/) e cancellare preset pubblici altrui.
        this.isAdmin = false;
    }

    async init() {
        if (this._initialized) return;
        this._initialized = true;
        this._bindTabs();
        await this.refresh();
    }

    _bindTabs() {
        const tabs = document.querySelectorAll('.ibex-preset-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const target = tab.dataset.tab;
                tabs.forEach(t => t.classList.toggle('is-active', t === tab));
                document.querySelectorAll('.ibex-preset-list').forEach(list => {
                    list.classList.toggle('hidden', list.dataset.namespace !== target);
                });
            });
        });
    }

    async refresh() {
        let data;
        try {
            const r = await fetch('/?action=list_presets');
            data = await r.json();
        } catch (err) {
            console.warn('[PresetSidebar] refresh failed', err);
            return;
        }
        if (!data || data.success === false) {
            console.warn('[PresetSidebar] refresh response error', data);
            return;
        }
        this.isAdmin = !!data.is_admin;
        this._renderList('private', Array.isArray(data.private) ? data.private : []);
        this._renderList('public',  Array.isArray(data.public)  ? data.public  : []);
        // Notifica il modal salva preset così può mostrare/nascondere
        // la checkbox "Pubblica come admin".
        const adminRow = document.getElementById('ibex-preset-admin-row');
        if (adminRow) adminRow.classList.toggle('hidden', !this.isAdmin);
    }

    _renderList(ns, items) {
        const el = document.getElementById(`ibex-preset-list-${ns}`);
        if (!el) return;
        el.innerHTML = '';
        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'ibex-preset-empty';
            empty.textContent = ns === 'private'
                ? 'Nessun preset privato. Seleziona dei nodi col marquee e salva.'
                : 'Nessun preset pubblico disponibile';
            el.appendChild(empty);
            return;
        }
        for (const it of items) {
            el.appendChild(this._buildCard(it, ns));
        }
    }

    _buildCard(item, ns) {
        const card = document.createElement('div');
        card.className = 'ibex-preset-card';
        card.draggable = true;
        card.dataset.id = item.id;
        card.dataset.ns = ns;

        const name = document.createElement('div');
        name.className = 'ibex-preset-card-name';
        name.textContent = item.name || item.id;
        card.appendChild(name);

        if (item.description) {
            const desc = document.createElement('div');
            desc.className = 'ibex-preset-card-desc';
            desc.textContent = item.description;
            card.appendChild(desc);
        }

        if (typeof item.node_count === 'number' && item.node_count > 0) {
            const meta = document.createElement('div');
            meta.className = 'ibex-preset-card-meta';
            meta.textContent = `${item.node_count} ${item.node_count === 1 ? 'nodo' : 'nodi'}`;
            card.appendChild(meta);
        }

        // Delete button — sempre per privati (proprietario), per pubblici
        // SOLO se l'utente è admin (gruppo Amministrazione NC).
        const canDelete = (ns === 'private') || (ns === 'public' && this.isAdmin);
        if (canDelete) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'ibex-preset-card-delete';
            del.title = ns === 'public'
                ? 'Elimina preset pubblico (admin)'
                : 'Elimina preset';
            del.textContent = '×';
            del.addEventListener('mousedown', (e) => e.stopPropagation()); // no drag
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this._deletePreset(item.id, item.name, ns);
            });
            card.appendChild(del);
        }

        // Drag handler — protocollo coerente con tool/mesh existing
        card.addEventListener('dragstart', (ev) => {
            try {
                ev.dataTransfer.setData('ibex-type',     'preset');
                ev.dataTransfer.setData('ibex-preset-id', item.id);
                ev.dataTransfer.setData('ibex-preset-ns', ns);
                ev.dataTransfer.effectAllowed = 'copy';
            } catch (e) { /* silent */ }
        });

        return card;
    }

    async _deletePreset(id, name, namespace = 'private') {
        const label = namespace === 'public' ? 'preset PUBBLICO' : 'preset';
        const ok = confirm(`Eliminare il ${label} "${name || id}"?\nL'azione è irreversibile.`);
        if (!ok) return;
        try {
            const fd = new URLSearchParams();
            fd.set('id', id);
            fd.set('namespace', namespace);
            const r = await fetch('/?action=delete_preset', {
                method: 'POST',
                body: fd,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });
            const data = await r.json();
            if (!data || data.success !== true) {
                throw new Error(data?.error || 'eliminazione fallita');
            }
            this.uiMgr?.notify?.(`Preset "${name || id}" eliminato`, 'success');
            await this.refresh();
        } catch (err) {
            this.uiMgr?.notify?.('Errore: ' + (err.message || err), 'error');
        }
    }
}
