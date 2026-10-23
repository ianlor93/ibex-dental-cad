// ═══════════════════════════════════════════════════════════════
// IBEX UIManager NonDestructive_S5_V1.1 — + worker status bar
//
// V1.1 (2026-04-22, sessione reload-atomico/sculpt-race/worker-feedback):
//   - Fix 3b (Invariante 78): showWorkerStatus(label) + hideWorkerStatus().
//     API per mostrare/nascondere `#ibex-worker-status` nell'header con
//     label contestuale. Chiamati da BakeEngine prima/dopo ogni POST bake
//     e da SculptPersist prima/dopo POST save_sculpt.
//
// DarkRedesign_V1.0:
//   Dopo il redesign i pannelli laterali sono docked (non più fluttuanti):
//   initDraggables e makeWidgetDraggable sono no-op per Toolbar/Outliner/DAG/Inspector.
//   Manteniamo il wrapper .widget-wrapper generico per eventuali popup futuri.
// ═══════════════════════════════════════════════════════════════

export class UIManager {
    constructor() {
        console.log("🎨 UIManager: NonDestructive_S5_V1.1 initialized.");

        // Toggle legacy — compat: alcuni onclick nei partials chiamano
        // ancora window.toggleWidget(id). No-op per pannelli docked.
        window.toggleWidget = () => {};
    }

    notify(message, type = 'info') {
        if (typeof window.notify === 'function') {
            window.notify(message, type);
        } else {
            console.log(`[NOTIFY] ${message}`);
        }
    }

    // Fix 3b (Invariante 78): worker status bar nell'header.
    // Label contestuali possibili (fonte: BakeEngine._computeWorkerLabel):
    //   · "Applicando trasformazioni..." — pipeline solo Tier 1 non-sculpt
    //   · "Calcolo mesh in corso..."     — pipeline con Tier 2 (Blender)
    //   · "Applicando scolpitura..."     — pipeline con nodo sculpt
    //   · "Salvando scolpitura..."       — SculptPersist.save()
    //
    // Il DOM element `#ibex-worker-status` vive in header.blade.php; se non
    // c'è (test/pagine senza header) i metodi sono no-op.
    // 2026-07-14 — NOTIFICA ALLA SHELL NC.
    //
    // In embed, l'editor vive in un iframe dentro la shell Nextcloud (ibex_workspace),
    // che disegna un PROPRIO indicatore "calcolo in corso" a partire dal campo `worker`
    // di `ibexSendState()` (scripts.blade.php:502-522).
    //
    // Prima di oggi `ibexSendState()` era chiamata SOLO al load, su richiesta della
    // shell, e — decisivo — in coda a `mbRun()`, cioè subito dopo un comando del menu.
    // MAI quando il bollino cambiava. Risultato:
    //   · "Forza bake" (comando di menu) → il bake accende il bollino, `mbRun` fotografa
    //     lo stato UN ISTANTE DOPO e manda `worker:true` alla shell. Il bake finisce,
    //     il bollino si spegne DENTRO l'iframe → ma nessuno avvisa la shell → il suo
    //     indicatore resta acceso PER SEMPRE.
    //   · slider (non passa da `mbRun`) → la shell non viene MAI informata →
    //     l'indicatore non compare affatto.
    // Sintomo per l'utente: "il bollino si accende solo col Forza bake e poi si incanta".
    //
    // La fonte di verità è questa coppia di metodi: sono gli UNICI che toccano
    // `#ibex-worker-status`. Chi cambia lo stato ha il dovere di annunciarlo.
    _notifyShell() {
        try { window.ibexSendState?.(); } catch (e) { /* standalone: la funzione non esiste */ }
    }

    showWorkerStatus(label) {
        const el = document.getElementById('ibex-worker-status');
        if (!el) return;
        const lbl = el.querySelector('.ibex-worker-label');
        if (lbl && typeof label === 'string') lbl.textContent = label;
        el.style.display = 'inline-flex';
        this._notifyShell();
    }

    hideWorkerStatus() {
        const el = document.getElementById('ibex-worker-status');
        if (!el) return;
        el.style.display = 'none';
        this._notifyShell();
    }

    // Filtro ricerca strumenti (chiamato da toolbar.blade.php oninput).
    // Durante search non vuota, espande automaticamente le categorie che
    // contengono risultati (rimuove .collapsed) — altrimenti l'utente non
    // vedrebbe i match dentro categorie chiuse.
    filterTools(query) {
        const q = (query || '').toLowerCase().trim();

        document.querySelectorAll('.tool-card').forEach(card => {
            const name = (card.innerText || '').toLowerCase();
            const match = !q || name.includes(q);
            card.style.display = match ? '' : 'none';
        });

        // Nascondi categorie senza risultati + auto-expand quelle con match
        document.querySelectorAll('.tool-category').forEach(cat => {
            const cards = cat.querySelectorAll('.tool-card');
            const anyVisible = Array.from(cards).some(c => c.style.display !== 'none');
            cat.style.display = (!q || anyVisible) ? '' : 'none';
            if (q && anyVisible) {
                cat.classList.remove('collapsed');
            }
        });
    }

    // S8 (2026-07-10): initUniversalDropZone RIMOSSA — zero call-site; il
    // commento che la legava a dropMeshToCanvas era stale (il drag reale è
    // HTML5 nativo: OutlinerManager dragstart → ondrop stack.blade →
    // IbexCore.dropMeshToCanvas).
}
