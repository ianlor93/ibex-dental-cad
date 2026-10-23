// ═══════════════════════════════════════════════════════════════
// IBEX InspectorPanel InspectorPanel_V1.0 — panel laterale destro
//
// Sostituisce il popup ContextInspector tasto-destro con un panel fisso
// sul bordo destro del viewport (sotto l'header, fino al fondo). Il DAG
// overlay si sovrappone al panel (z-index DAG=60, panel=55).
//
// Comportamento:
//   - Tab verticale (icona "proprietà" 3 righe) sempre visibile sul bordo
//     destro. Click sul tab → toggle open/close manuale.
//   - Click sinistro su mesh nel viewport → SceneManager chiama
//     openForMesh(mesh) → panel si apre + contenuto popolato.
//   - Click outliner → OutlinerManager chiama openForMesh(mesh) idem.
//   - Click sinistro nel vuoto → SceneManager chiama close() → panel si
//     chiude, tab resta visibile per riapertura manuale.
//   - Tab toggle senza selezione → panel si apre con messaggio
//     "Seleziona una mesh per iniziare".
//   - Resize via handle sul bordo sinistro (pointer events), min 180px
//     max 480px. Larghezza persistita in localStorage['ibex:inspector-w'].
//     Stato open/close NON persistito (richiesto A5).
//
// Il contenuto del panel è dipinto da ContextInspector.renderInto(content,
// meshName) — la logica di rendering dei tool/slider/sculpt/selection
// resta intatta dentro ContextInspector. Questo modulo è il contenitore.
// ═══════════════════════════════════════════════════════════════

export class InspectorPanel {
    constructor(ibex) {
        this.ibex = ibex;
        this.isOpen = false;
        this.currentMeshName = null;

        this._createDOM();
        this._restoreWidth();
        this._initTab();
        this._initResize();
        this._renderEmpty();
    }

    _createDOM() {
        const root = document.createElement('div');
        root.id = 'ibex-inspector-panel';
        root.className = 'ibex-inspector-panel';
        root.innerHTML = `
            <button id="ibex-inspector-tab" class="ibex-inspector-tab" title="Inspector">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 5h18M3 12h18M3 19h18"/>
                </svg>
            </button>
            <div class="ibex-inspector-resize-handle" id="ibex-inspector-resize"></div>
            <div class="ibex-inspector-content" id="ibex-inspector-content"></div>
        `;
        document.body.appendChild(root);
        this.root    = root;
        this.tab     = root.querySelector('#ibex-inspector-tab');
        this.handle  = root.querySelector('#ibex-inspector-resize');
        this.content = root.querySelector('#ibex-inspector-content');
    }

    _restoreWidth() {
        try {
            const saved = localStorage.getItem('ibex:inspector-w');
            if (saved) {
                const w = parseInt(saved, 10);
                if (!isNaN(w) && w >= 180 && w <= 480) {
                    document.documentElement.style.setProperty('--inspector-w', w + 'px');
                }
            }
        } catch (e) { /* quota / private mode: ignore */ }
    }

    _initTab() {
        this.tab.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });
    }

    _initResize() {
        let dragging = false, startX = 0, startW = 0;

        this.handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            const cs = getComputedStyle(document.documentElement);
            startW = parseInt(cs.getPropertyValue('--inspector-w'), 10) || 280;
            this.handle.classList.add('dragging');
            this.root.classList.add('resizing'); /* attiva transition:none su panel+gizmo durante il drag */
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            try { this.handle.setPointerCapture(e.pointerId); } catch (_) {}
        });

        this.handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            // Panel fisso a destra: trascinare l'handle verso sinistra → panel
            // più largo (newW = startW - dx; dx negativo se mouse va a sx).
            const dx = e.clientX - startX;
            const newW = Math.max(180, Math.min(480, startW - dx));
            document.documentElement.style.setProperty('--inspector-w', newW + 'px');
            if (this.ibex?.sceneMgr?.onResize) this.ibex.sceneMgr.onResize();
        });

        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            this.handle.classList.remove('dragging');
            this.root.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            try {
                if (e?.pointerId != null && this.handle.hasPointerCapture?.(e.pointerId)) {
                    this.handle.releasePointerCapture(e.pointerId);
                }
            } catch (_) {}
            try {
                const cs = getComputedStyle(document.documentElement);
                const w = parseInt(cs.getPropertyValue('--inspector-w'), 10) || 280;
                localStorage.setItem('ibex:inspector-w', String(w));
            } catch (_) {}
        };
        this.handle.addEventListener('pointerup', endDrag);
        this.handle.addEventListener('pointercancel', endDrag);
    }

    _renderEmpty() {
        this.content.innerHTML = '<div class="ibex-inspector-empty">Seleziona una mesh per iniziare</div>';
    }

    /**
     * Apre il panel e dipinge il contenuto per la mesh passata. Accetta sia
     * un THREE.Mesh sia una stringa (mesh.name). Chiamato da:
     *   - SceneManager._initSelectionPointer (click sinistro su mesh)
     *   - OutlinerManager (click su riga outliner)
     *   - toggle() quando c'è una selezione corrente
     */
    openForMesh(mesh) {
        const name = typeof mesh === 'string' ? mesh : (mesh?.name || null);
        if (!name) return;
        this.currentMeshName = name;
        const ctx = this.ibex?.contextInspector;
        if (ctx && typeof ctx.renderInto === 'function') {
            ctx.renderInto(this.content, name);
        }
        this.root.classList.add('ibex-inspector-open');
        this.isOpen = true;
    }

    /**
     * Chiude il panel. Resetta lo stato di ContextInspector (così refresh()
     * diventa no-op finché non si riapre). La tab resta visibile.
     */
    close() {
        this.currentMeshName = null;
        if (this.ibex?.contextInspector?.clear) this.ibex.contextInspector.clear();
        this._renderEmpty();
        this.root.classList.remove('ibex-inspector-open');
        this.isOpen = false;
    }

    /**
     * Toggle manuale via tab button. Se c'è una selezione corrente nella
     * scena, la riusa; altrimenti apre con empty state.
     */
    toggle() {
        if (this.isOpen) {
            this.close();
            return;
        }
        const selected = this.ibex?.sceneMgr?.selectedMeshName;
        if (selected) {
            this.openForMesh(selected);
        } else {
            this._renderEmpty();
            this.root.classList.add('ibex-inspector-open');
            this.isOpen = true;
        }
    }

    /**
     * Re-render del contenuto nella mesh corrente. No-op se il panel è
     * chiuso o non ha selezione. Utile come proxy se un chiamante vuole
     * forzare il refresh senza passare per ContextInspector.
     */
    refresh() {
        if (!this.currentMeshName) return;
        const ctx = this.ibex?.contextInspector;
        if (ctx && typeof ctx.renderInto === 'function') {
            ctx.renderInto(this.content, this.currentMeshName);
        }
    }
}
