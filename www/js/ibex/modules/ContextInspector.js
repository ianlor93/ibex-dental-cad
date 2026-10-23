// ═══════════════════════════════════════════════════════════════
// IBEX ContextInspector GodSplit_29-7 — dispatcher + registry per-tool
//
// GodSplit (2026-07-29): il god-object (2090 righe / 114 KB) è stato spezzato.
//   Le sezioni build+bind PER-TOOL sono migrate VERBATIM in `inspectors/*.js`
//   — sculpt · selection · drawCurve · curveEdit · archDetect · burn.
//   Qui restano SOLO il dispatcher (`renderInto` / `refresh` / `clear` /
//   `_buildHtml`) e le parti CONDIVISE fra tutti i tool: `_buildControls`
//   (il widget-generator parametrico), `_bindToolToggles`,
//   `_bindMuteHandlers`, `_bindMeshPropsHandlers`.
//   T1Escape (2026-07-29): `_escapeHtml` NON è più fra le parti condivise —
//   era una delle 4 copie byte-identiche ed è collassato in
//   `modules/dom-escape.js`. Questo file non ne aveva alcun chiamante:
//   l'unico era `inspectors/burn.js` via `this`, ora importa l'util.
//   Comportamento INVARIATO: stessi tool id, stessi argomenti, stesso ordine
//   di bind, stesso fallback a stringa vuota. Nessuna logica per-tool è stata
//   riscritta — i corpi migrati sono byte-identici.
//   ⚠️ CACHE-BUST A DUE LIVELLI: cambiare un `inspectors/*.js` richiede di
//   bumpare il `?v=` di QUEL modulo qui sotto **e** il `?v=` di
//   ContextInspector.js in IbexCore.js. Bumparne uno solo = il browser serve
//   la vecchia ContextInspector.js, che punta ancora al vecchio URL del
//   modulo → l'edit non arriva mai a schermo (lezione shell-vN).
//   ⚠️ Inv. 101: ogni `inspectors/*.js` ha UN SOLO import site — questo file.
//
// IBEX ContextInspector FaceOrient_V2.11 — Face Orientation overlay toggle
//
// V2.11 (2026-05-02): terzo bottone "Orient" nella row Shading, additivo
//   a Flat/Smooth (3 stati ortogonali). Click → swap mesh.material a
//   ShaderMaterial singleton via `window.ibex.loader.getOrientationMaterial()`.
//   Salva matcap precedente in `mesh.userData._matcapMaterial`. Toggle off
//   ripristina. Quando Orient è ON, click Flat/Smooth scrive `flatShading`
//   sul matcap di riferimento (invisibile finché Orient è ON, visibile non
//   appena toggle OFF). Persistenza in `outlinerMgr.visualState.faceOrientation`
//   (re-apply post hot-swap gestito da OutlinerManager V12.9).
//
// V2.10 (2026-04-25): aggiunta checkbox `.ctx-sel-xray-row` (label
//   "Attraverso") sotto la `.ctx-sel-mode-row`. Default unchecked =
//   solo superficie (front-facing). Checked = passa attraverso la
//   mesh (back-face + occluse incluse). Handler `onchange` chiama
//   `selectionMode.setXRay(checked)`. Tooltip esplicativo. Stato
//   `_xray` letto da `selectionMode._xray` per pre-set checkbox al
//   render.
//
// V2.9 (2026-04-25): `_buildSelectionSection` aggiunge una `.ctx-sel-mode-row`
//   con 3 bottoni SVG inline (Circle/Box/Lasso) sopra i bottoni Add/Remove
//   esistenti, + hint `.ctx-sel-hint` che mostra "Shift = aggiungi · Ctrl
//   = rimuovi". Click sui bottoni → `selectionMode.setSelMode(mode)` +
//   toggle classe `.active` inline (no full refresh — preserva slider
//   raggio + focus). Lo stato `_selMode` corrente è letto da
//   `selectionMode._selMode` per pre-selezionare il bottone giusto al render.
//
// V2.8 (2026-04-25): rename input + sezione proprietà mesh
//
// V2.8 (2026-04-25): aggiunti 2 elementi UI nell'inspector:
//   1) Header: l'`<div class="ctx-mesh-name">` statico è stato sostituito
//      con `<input class="ctx-mesh-rename-input">` editabile. Handler
//      `_bindMeshPropsHandlers`: focus → select all; blur/Enter →
//      `stackMgr.setMeshDisplayName(meshName, value)` se cambiato e non
//      vuoto; Escape → ripristina + blur. Rimosso lookup displayName
//      inline V2.7 → ora delega a `stackMgr.getMeshDisplayName`.
//   2) Sezione `.ctx-mesh-props` tra header e lista tool, con 3 row:
//      Visibilità (eye toggle btn), Opacità (slider 0-1 + label %),
//      Shading (btn flat/smooth toggle). Letture iniziali da
//      `mesh.material.opacity / mesh.material.flatShading / mesh.visible`
//      (con fallback `outlinerMgr.visualState[meshName]`).
//      Toggle visibility rispetta `userData.ibexSplitAutoHidden`:
//      se l'utente ri-mostra una mesh auto-hidden, rimuove il flag
//      (Inv. 88). Slider opacity sync outliner SOLO su `change`
//      (mouseup) — durante drag valori stale tollerabili.
//      Shading toggle scrive `material.flatShading + needsUpdate=true`
//      e persiste in `visualState.flatShading` (OutlinerManager V12.7
//      ri-applica il flag dopo hotSwapMeshes).
//
// V2.7 (2026-04-25 Obiettivo 2): displayName nel header (lookup inline,
//   sostituito da delega in V2.8).
//
// V2.7 (2026-04-25 Obiettivo 2): `_buildHtml(meshName)` cerca il primo
//   nodo mesh in Drawflow con `data.meshName === meshName` e usa il
//   suo `data.displayName` (se presente) come testo dell'header
//   `.ctx-mesh-name`. `meshName` resta la chiave interna passata al
//   filter `flattenGraphForBackend`. Fallback: stem `.stl`-stripped
//   (comportamento legacy). Nessun cambio al panel ↔ ContextInspector
//   protocol — `renderInto(container, meshName)` è invariato.
//
// V2.6 (2026-04-27): flood, lazy, falloff SVG, range tuning
//
// V2.6 (2026-04-27):
//   - Slider raggio: range `min=0.1 max=1.5 step=0.05` (era 0.3-15).
//   - Slider intensità: range `min=0.1 max=1 step=0.01` (era 0-2).
//   - Selettore falloff: 3 bottoni SVG inline (Smooth/Sharp/Cylinder).
//     Rimossi `linear` e `sphere` (bumpata SculptBase V1.3). SVG path
//     curvo/angolare/rettangolare, `stroke-width=1.5 currentColor`.
//   - Pulsante "Flood Fill" accanto alla checkbox Dyntopo — visibile SOLO
//     quando `brush.dyntopo === true`. Click → `sculptMgr.floodFill()`.
//   - Checkbox "Lazy" + slider "Raggio lazy" (0-1 step 0.05) — slider
//     visibile SOLO quando `brush.lazy === true` (pattern identico a
//     dyntopo detail).
//   - Handler bind: flood fill button, lazy checkbox, lazy radius slider.
//
// V2.5 (2026-04-27, post-session cleanup):
//   - Rimossi bottoni `Push` e `Pull` dalla row brush. Ora 5 bottoni
//     definitivi: `Inflate | Crease | Smooth | Flatten | Simplify`.
//   - Le istanze `push` e `pull` restano in SculptMode._brushInstances
//     come fallback / backward compat (sessioni legacy salvate con
//     `brush.type='push'` o `'pull'` continuano a funzionare via console
//     o via state restore — non esposte dall'UI).
//
// V2.4 (2026-04-27):
//   - Aggiunto bottone `Simplify` nella row brush (7 bottoni temporanei:
//     Push/Pull/Smooth/Flatten/Inflate/Crease/Simplify). Selettore Segno
//     resta visibile solo per inflate/crease (non per simplify).
//
// V2.3 (2026-04-27):
//   - Aggiunto bottone `Crease` nella row brush (6 bottoni temporaneamente:
//     Push/Pull/Smooth/Flatten/Inflate/Crease).
//   - Nuovo blocco `.ctx-sculpt-sign-row` con 2 bottoni `+` / `-` sotto la
//     row brush — visibile SOLO quando il brush attivo è inflate o crease.
//     Stato `active` segue `brush.sign` (+1 → `+`, -1 → `-`).
//   - Handler `setBrush({sign: +1})` / `setBrush({sign: -1})`.
//
// V2.2 (2026-04-27):
//   - `_buildSculptSection` aggiunge bottone `Inflate` nella row brush
//     (5 bottoni temporaneamente: Push/Pull/Smooth/Flatten/Inflate). La
//     row brush usa `flex-wrap` (CSS V2.2) per adattarsi a 192px. In
//     Obiettivo 3 arriva anche Crease, in Obiettivo 4 Simplify; a fine
//     sessione Push/Pull verranno rimossi e sostituiti da Inflate + sign.
//
// V2.1 (2026-04-27):
//   - `_buildSculptSection` aggiunge una riga "Falloff" con 4 bottoni
//     (Smooth / Linear / Sphere / Sharp) sotto gli slider. Il valore
//     viene sincronizzato via `brush.falloff` (default 'smooth'). Sempre
//     visibile quando sculpt è attivo, anche con brush=Smooth (no-op
//     interno per Smooth laplacian, ma coerenza UI).
//   - `_bindSculptHandlers` binda `.ctx-sculpt-falloff-btn` onclick →
//     `sculptMgr.setBrush({falloff: dataset.falloff})`.
//
// V2.0 (2026-04-27, InspectorPanel migration):
//   - RIMOSSA la logica popup-con-positioning (quadranti, clamp viewport,
//     click-outside dismiss, listener `ibex:mesh-contextmenu`): il popup
//     è stato sostituito dal panel laterale destro (`InspectorPanel`).
//   - RIMOSSO il DOM `#context-inspector` dal blade (era il contenitore
//     del popup). Questo modulo non possiede più un container proprio —
//     riceve dall'esterno il container dove dipingere via `renderInto`.
//   - NUOVA API pubblica:
//       · renderInto(container, meshName) — dipinge l'HTML dentro il
//         container passato + binda gli handler. Salva riferimento a
//         `currentContainer` + `currentMeshName` per refresh().
//       · refresh() — re-render nel container corrente (chiamato da
//         SculptMode/SelectionMode/BakeEngine quando lo stato cambia).
//       · clear() — resetta lo stato (chiamato da InspectorPanel.close).
//   - Mantenuto listener `ibex:selection-count-changed` per live count
//     update nel pannello selection (no full refresh → preserva focus).
//   - Tutti i bind handler ora scope-ano a `this.currentContainer`
//     (prima usavano `this.el`, il DOM del popup).
//   - La chiamata a `sceneMgr.selectMesh(meshName)` è stata RIMOSSA
//     da renderInto: la selezione è ora responsabilità di
//     `SceneManager._initSelectionPointer` (fonte unica di verità), che
//     chiama direttamente `inspectorPanel.openForMesh`.
//
// V1.8 — V1.0 — versioni precedenti (storico non incluso nel repository).
// ═══════════════════════════════════════════════════════════════

// ── Registry dei moduli-inspector per-tool (GodSplit 2026-07-29) ──────
// Ogni modulo espone `{ build, bind }` e va invocato con l'istanza
// ContextInspector come receiver, così dentro i corpi migrati `this` resta
// quello di prima (`this.currentContainer`, `this.refresh()`, i listener…).
import * as sculptInsp     from './inspectors/sculpt.js?v=GodSplit_29-7';
import * as selectionInsp  from './inspectors/selection.js?v=GodSplit_29-7';
import * as drawCurveInsp  from './inspectors/drawCurve.js?v=GodSplit_29-7';
import * as curveEditInsp  from './inspectors/curveEdit.js?v=GodSplit_29-7';
import * as archDetectInsp from './inspectors/archDetect.js?v=GodSplit_29-7';
import * as burnInsp       from './inspectors/burn.js?v=GodSplit_29-7-T1Escape_29-7';

/**
 * toolId → { mod, args? }. `args` sono gli argomenti EXTRA passati a `build`
 * dopo il nodeId: l'unico caso è `selection`, che pre-split riceveva
 * 'delete' / 'split' / 'rebuild' dai tre rami distinti dell'if/else.
 * Un toolId assente dal registry non ha sezione dedicata → stringa vuota,
 * esattamente come il fallthrough dell'if/else di prima.
 */
const INSPECTORS = {
    sculpt:           { mod: sculptInsp },
    delete_topology:  { mod: selectionInsp,  args: ['delete']  },
    split_topology:   { mod: selectionInsp,  args: ['split']   },
    topology_rebuild: { mod: selectionInsp,  args: ['rebuild'] },
    draw_curve:       { mod: drawCurveInsp },
    curve_edit:       { mod: curveEditInsp },
    arch_detect:      { mod: archDetectInsp },
    burn:             { mod: burnInsp },
};

/**
 * Ordine di bind, de-duplicato (selection compare UNA volta sola, come prima).
 * È IDENTICO alle sei chiamate esplicite che `renderInto` faceva pre-split:
 * sculpt · selection · burn · draw_curve · curve_edit · arch_detect.
 * I selettori dei sei bind sono disgiunti, quindi l'ordine non è
 * funzionalmente necessario — si conserva perché l'invarianza sia
 * DIMOSTRABILE e non soltanto probabile.
 */
const BIND_ORDER = [
    sculptInsp, selectionInsp, burnInsp, drawCurveInsp, curveEditInsp, archDetectInsp,
];

export class ContextInspector {
    constructor(stackMgr) {
        this.stackMgr = stackMgr;
        this.currentMeshName = null;
        this.currentContainer = null;

        // Live count update per SelectionMode (delete/split). Aggiorna il
        // contatore + stato disabled del bottone action senza full refresh
        // (preserva focus/stato interno).
        window.addEventListener('ibex:selection-count-changed', (e) => {
            const root = this.currentContainer;
            if (!root) return;
            const count = e.detail?.count ?? 0;
            const lbl = root.querySelector('.ctx-selection-count');
            if (lbl) lbl.textContent = `${count} facce selezionate`;
            const btn = root.querySelector('.ctx-selection-action');
            if (btn) {
                btn.disabled = (count === 0);
                btn.classList.toggle('ctx-selection-btn-enabled', count > 0);
            }
        });
    }

    /**
     * Dipinge il contenuto inspector per `meshName` dentro `container`.
     * Chiamato da InspectorPanel.openForMesh (e refresh).
     */
    renderInto(container, meshName) {
        if (!container) return;
        this.currentContainer = container;
        this.currentMeshName = meshName;
        container.innerHTML = this._buildHtml(meshName);
        this._bindToolToggles();
        if (this.stackMgr.bindDragInputs) this.stackMgr.bindDragInputs();
        // GodSplit 2026-07-29 — i sei bind per-tool vivono in `inspectors/*.js`.
        // Chiamati TUTTI e sempre, nello stesso ordine di prima: ognuno è già
        // un no-op se la sua sezione non è nel DOM (querySelectorAll vuota).
        BIND_ORDER.forEach(mod => mod.bind.call(this));
        // V2.8 — handler per rename input + sezione proprietà mesh.
        this._bindMeshPropsHandlers();
        // NodeMute (2026-05-05) — bottone Mute toggle nei `.ctx-tool-head`.
        this._bindMuteHandlers();
    }

    // NodeMute (2026-05-05) — handler per `.ctx-mute-btn` nell'inspector.
    // stopPropagation per evitare che il click triggeri il toggle expand
    // del `.ctx-tool-head` (gestito da `_bindToolToggles`).
    _bindMuteHandlers() {
        const root = this.currentContainer;
        if (!root) return;
        root.querySelectorAll('.ctx-mute-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const id = btn.dataset.nodeId;
                if (id && this.stackMgr.toggleNodeMute) {
                    this.stackMgr.toggleNodeMute(id);
                }
            };
        });
    }

    /**
     * Re-render nel container corrente (senza cambiare mesh). Chiamato da
     * SculptMode.enter/exit, SelectionMode.enter/exit, BakeEngine post-bake.
     *
     * UX (2026-05-04): preserva lo stato espanso/collasso delle tendine tool
     * tra refresh successivi. Senza, ogni hot-swap post-bake chiude tutte
     * le tendine espanse dall'utente — fastidioso durante editing continuo
     * (slider drag → bake → refresh → tendina chiusa → riapri → ripeti).
     */
    refresh() {
        if (!this.currentContainer || !this.currentMeshName) return;

        // Snapshot tendine espanse PRIMA del re-render (perse al innerHTML overwrite)
        const expandedNodeIds = new Set();
        this.currentContainer.querySelectorAll('.ctx-tool.expanded').forEach(el => {
            const id = el.dataset.nodeId;
            if (id) expandedNodeIds.add(String(id));
        });

        this.renderInto(this.currentContainer, this.currentMeshName);

        // Restore: re-applica `.expanded` ai nodi che lo erano. I nodeId
        // sono stabili tra refresh successivi sulla STESSA mesh; quando
        // l'utente cambia mesh, l'inspector chiama openForMesh (non
        // refresh) → il set non viene popolato e tutte le tendine partono
        // collassate per la nuova mesh — comportamento desiderato.
        if (expandedNodeIds.size > 0) {
            expandedNodeIds.forEach(id => {
                const el = this.currentContainer.querySelector(
                    `.ctx-tool[data-node-id="${CSS.escape(id)}"]`
                );
                if (el) el.classList.add('expanded');
            });
        }
    }

    /**
     * Reset dello stato. Chiamato da InspectorPanel.close (o toggle manuale
     * senza mesh). Non tocca il DOM del container — lo fa il chiamante.
     */
    clear() {
        this.currentContainer = null;
        this.currentMeshName = null;
    }

    _buildHtml(meshName) {
        const graph    = this.stackMgr.extractDAG();
        const executor = this.stackMgr.executor;

        const steps = executor.flattenGraphForBackend(graph)
            .filter(s => s.target === meshName);
        // V2.8 — delega al getter centralizzato `StackManager.getMeshDisplayName`
        // (lookup grafo + fallback stem). Sostituisce il lookup inline V2.7.
        const cleanMeshName = this.stackMgr.getMeshDisplayName?.(meshName)
            || String(meshName).replace(/\.stl$/i, '');

        // V2.8 — escape HTML per il value dell'input (display name può
        // contenere virgolette, ampersand, ecc. dato che è stringa libera).
        const escAttr = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const valueAttr = escAttr(cleanMeshName);
        const titleAttr = escAttr(meshName);
        const meshAttr  = escAttr(meshName);

        // V2.8 — sezione proprietà mesh tra header e ctx-body. Letture
        // visualState dirette dal SceneManager / OutlinerManager.
        const sceneMgr   = window.ibex?.sceneMgr;
        const outlinerMgr = window.ibex?.outlinerMgr;
        const meshObj = sceneMgr?.group?.children?.find(c => c.isMesh && c.name === meshName);
        const visState = outlinerMgr?.visualState?.[meshName] || {};
        const isVisible    = (meshObj?.visible !== undefined) ? !!meshObj.visible
                           : (visState.visible !== undefined ? !!visState.visible : true);
        const matObj       = meshObj?.material;
        const currentOpacity = (matObj?.transparent && typeof matObj?.opacity === 'number')
                             ? matObj.opacity
                             : (typeof visState.opacity === 'number' ? visState.opacity : 1);
        const flatShading  = (typeof matObj?.flatShading === 'boolean')
                           ? matObj.flatShading
                           : (typeof visState.flatShading === 'boolean' ? visState.flatShading : true);
        // V2.11 — toggle Face Orientation overlay (BLU front / ROSSO back via gl_FrontFacing)
        const faceOrientation = (typeof visState.faceOrientation === 'boolean')
                              ? visState.faceOrientation : false;

        const SVG_EYE_OPEN  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>`;
        const SVG_EYE_CLOSED = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"/></svg>`;
        const visIcon = isVisible ? SVG_EYE_OPEN : SVG_EYE_CLOSED;

        let html = `
            <div class="ctx-header">
                <span class="ctx-strip"></span>
                <input class="ctx-mesh-rename-input"
                       value="${valueAttr}"
                       data-mesh-name="${meshAttr}"
                       title="${titleAttr}"
                       spellcheck="false"
                       autocomplete="off" />
                <span class="ctx-type">mesh</span>
            </div>
            <div class="ctx-target" title="${meshAttr}">${meshAttr}</div>
            <div class="ctx-section">Proprietà</div>
            <div class="ctx-mesh-props" data-mesh-name="${meshAttr}">
                <div class="ctx-prop-row">
                    <span class="ctx-prop-label">Visibilità</span>
                    <button class="ctx-prop-vis-btn" data-mesh-name="${meshAttr}" title="Mostra/Nascondi mesh">${visIcon}</button>
                </div>
                <div class="ctx-prop-row">
                    <span class="ctx-prop-label">Opacità</span>
                    <input type="range" class="ctx-prop-opacity"
                           min="0" max="1" step="0.05"
                           value="${currentOpacity}"
                           data-mesh-name="${meshAttr}" />
                    <span class="ctx-prop-opacity-val">${Math.round(currentOpacity * 100)}%</span>
                </div>
                <div class="ctx-prop-row">
                    <span class="ctx-prop-label">Shading</span>
                    <div class="ctx-prop-shade-btns" data-mesh-name="${meshAttr}">
                        <button class="ctx-prop-shade-btn ${flatShading ? 'active' : ''}" data-shade="flat">Flat</button>
                        <button class="ctx-prop-shade-btn ${!flatShading ? 'active' : ''}" data-shade="smooth">Smooth</button>
                        <button class="ctx-prop-shade-btn ${faceOrientation ? 'active' : ''}" data-shade="orient" title="Face Orientation: BLU=normale fuori, ROSSO=invertita">Orient</button>
                    </div>
                </div>
            </div>
            <div class="ctx-section">Pipeline</div>
            <div class="ctx-body">
        `;

        // ExportNodeSTL (2026-05-03): scan separato per nodi `export_stl`
        // (e altri future no-backend tools). flattenGraphForBackend li
        // esclude perché non fanno bake — ma vanno mostrati nell'inspector
        // se collegati alla mesh corrente. Risolvo target via resolveBaseMesh
        // sull'edge IN_GEO_Mesh entrante.
        const exportSteps = [];
        if (graph?.nodes && graph?.edges) {
            graph.nodes.filter(n => n.toolId === 'burn').forEach(n => {
                const inEdges = graph.edges.filter(e => String(e.to_node) === String(n.id));
                const inEdge = inEdges.find(e => e.role === 'IN_GEO_Mesh') || inEdges[0];
                if (!inEdge) return;
                const target = executor.resolveBaseMesh(inEdge.from_mesh, graph, inEdge.from_port);
                if (target === meshName) {
                    exportSteps.push({ _nodeId: String(n.id), tool: 'burn' });
                }
            });
        }

        if (steps.length === 0 && exportSteps.length === 0) {
            html += `<div class="ctx-empty">Nessun tool su questa mesh</div>`;
            html += `</div>`;
            return html;
        }

        // Renderer condiviso per step pipeline + step "side-effect" (export)
        const renderToolEntry = (step, idx, nodeData) => {
            const toolName = (nodeData.toolName || step.tool || '').replace(/_/g, ' ');
            const controls = this._buildControls(step._nodeId, nodeData);
            // GodSplit 2026-07-29 — la catena if/else per-tool è diventata il
            // registry `INSPECTORS`: stessi tool id, stessi argomenti, stesso
            // fallback a '' per i tool senza sezione dedicata.
            const extraEntry   = INSPECTORS[step.tool];
            const extraSection = extraEntry
                ? extraEntry.mod.build.call(this, step._nodeId, ...(extraEntry.args || []))
                : '';
            // NodeMute (2026-05-05): bottone interruttore SVG per toggle bypass.
            // Escluso per export_stl (no_backend, niente da mutare). Stessa
            // icona del toggle inline sui nodi DAG (StackManager.muteToggleSvg).
            // Stato `.is-muted` mostra leva alzata (interruttore aperto, no
            // corrente passa) → worker fa passthrough.
            const muted = !!nodeData.muted;
            const showMute = step.tool !== 'burn';
            // Riusa l'SVG identico al toggle inline sui nodi DAG
            // (StackManager.muteToggleSvg è static).
            const muteSvg = (this.stackMgr?.constructor?.muteToggleSvg)
                ? this.stackMgr.constructor.muteToggleSvg()
                : '';
            const muteBtn = showMute
                ? `<button class="ctx-mute-btn ibex-mute-toggle ${muted ? 'is-muted' : ''}" data-node-id="${step._nodeId}" title="${muted ? 'Riattiva il nodo (esegue il calcolo)' : 'Bypass nodo (passthrough, salta il calcolo)'}">${muteSvg}</button>`
                : '';
            return `
                <div class="ctx-tool ${muted ? 'ctx-tool-muted' : ''}" data-node-id="${step._nodeId}">
                    <div class="ctx-tool-head">
                        <span class="ctx-tool-name">${idx}. ${toolName}</span>
                        ${muteBtn}
                        <span class="ctx-chev">▶</span>
                    </div>
                    <div class="ctx-tool-body">
                        ${controls || '<span style="font-size:10px; color: var(--ibex-text-3);">—</span>'}
                        ${extraSection}
                        ${showMute ? `<div class="ctx-foot"><button type="button" class="ctx-mute-btn ibex-mute-toggle ${muted ? 'is-muted' : ''}" data-node-id="${step._nodeId}" title="${muted ? 'Riattiva il nodo (esegue il calcolo)' : 'Bypass nodo (passthrough, salta il calcolo)'}">${muteSvg} Bypass</button></div>` : ''}
                    </div>
                </div>
            `;
        };

        let counter = 0;
        steps.forEach((step) => {
            const nodeData = this.stackMgr.editor.getNodeFromId(parseInt(step._nodeId))?.data;
            if (!nodeData) return;
            counter += 1;
            html += renderToolEntry(step, counter, nodeData);
        });

        // Export node(s) sempre alla fine (sono terminali del grafo)
        exportSteps.forEach((step) => {
            const nodeData = this.stackMgr.editor.getNodeFromId(parseInt(step._nodeId))?.data;
            if (!nodeData) return;
            counter += 1;
            html += renderToolEntry(step, counter, nodeData);
        });

        html += `</div>`;
        return html;
    }

    _bindToolToggles() {
        const root = this.currentContainer;
        if (!root) return;
        root.querySelectorAll('.ctx-tool-head').forEach(head => {
            head.onclick = (e) => {
                // Ignora click dentro controlli già espansi
                if (e.target.closest('input, select, button')) return;
                const tool = head.parentElement;
                tool.classList.toggle('expanded');
            };
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Widget parametrici (derivato da InspectorManager._buildControls)
    // ─────────────────────────────────────────────────────────────
    _buildControls(nodeId, nodeData) {
        const params       = nodeData.params       || {};
        const paramsConfig = nodeData.paramsConfig || {};
        const html = [];

        for (const [key, meta] of Object.entries(paramsConfig)) {
            if (key.startsWith('IN_') || key.startsWith('OUT_') || key.startsWith('H_')) continue;

            const val   = params[key] !== undefined ? params[key] : (meta.default ?? 0);
            const label = key
                .replace(/^(G\d+_|H_|R_|REQ_)/, '')
                .replace(/_(INT|PCT|POS|ROT|SCL|COL|VIS|STR|MENU|OBJ|COLLECT|MAT|FLT|BOL|ENUM)$/, '')
                .replace(/_/g, ' ');

            if (meta.type === 'vector' || key.includes('_POS') || key.includes('_ROT') || key.includes('_SCL')) {
                const v = Array.isArray(val) ? val : [meta.default?.[0] ?? 0, meta.default?.[1] ?? 0, meta.default?.[2] ?? 0];
                const axes = ['X', 'Y', 'Z'];
                const axisColors = ['#C4302B', '#1F8A4C', '#2A6FDB'];  // assi XYZ = palette DS (era Tailwind red/green/blue)

                html.push(`
                <div class="ctx-field">
                    <div class="ctx-fieldhead"><span class="ctx-lbl">${label}</span></div>
                    <div class="ibex-vector-group insp-vec-group" data-node-id="${nodeId}" data-key="${key}">
                        ${axes.map((axis, i) => `
                        <div style="display:flex; align-items:center; gap: 4px; padding: 2px 0;">
                            <span style="font-size: 9px; font-weight: 500; width: 10px; color: ${axisColors[i]};">${axis}</span>
                            <input type="number"
                                   class="ibex-num drag-input ibex-vector-input insp-input"
                                   style="width: 100%; min-width: 0; cursor: ew-resize;"
                                   data-node-id="${nodeId}" data-key="${key}"
                                   step="${meta.step ?? 0.1}"
                                   min="${meta.min ?? -1000}" max="${meta.max ?? 1000}"
                                   value="${v[i] ?? 0}"
                                   onchange="(function(input){
                                       const g = input.closest('.insp-vec-group');
                                       const ins = g.querySelectorAll('input.ibex-vector-input');
                                       const arr = [parseFloat(ins[0].value)||0, parseFloat(ins[1].value)||0, parseFloat(ins[2].value)||0];
                                       window.ibex.stackMgr.updateNodeDataById('${nodeId}', '${key}', arr);
                                   })(this)">
                        </div>`).join('')}
                    </div>
                </div>`);
            } else if (meta.type === 'segmented' && meta.options) {
                const opts = meta.options || [];
                if (opts.length <= 4) {
                    // Legge .ctx-seg: bottoni segmentati; il <select> nascosto resta
                    // il portatore del valore (data-node-id/data-key = target del
                    // sync nodo→inspector di StackManager._syncWidgetValue).
                    html.push(`
                    <div class="ctx-field">
                        <div class="ctx-fieldhead"><span class="ctx-lbl">${label}</span></div>
                        <select class="ibex-select" style="display:none"
                                data-node-id="${nodeId}" data-key="${key}"
                                onchange="window.ibex.stackMgr.updateNodeDataById('${nodeId}', '${key}', this.value)">
                            ${opts.map(o => `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`).join('')}
                        </select>
                        <div class="ctx-seg">
                            ${opts.map(o => `<button type="button" class="${o === val ? 'on' : ''}"
                                onclick="(function(btn){
                                    const f = btn.closest('.ctx-field');
                                    const sel = f.querySelector('select');
                                    sel.value = '${o}';
                                    f.querySelectorAll('.ctx-seg button').forEach(b => b.classList.toggle('on', b === btn));
                                    sel.dispatchEvent(new Event('change'));
                                })(this)">${o}</button>`).join('')}
                        </div>
                    </div>`);
                } else {
                    // Fallback dichiarato: >4 opzioni non stanno in 280px come seg
                    html.push(`
                    <div class="ctx-field">
                        <div class="ctx-fieldhead"><span class="ctx-lbl">${label}</span></div>
                        <select class="ibex-select"
                                data-node-id="${nodeId}" data-key="${key}"
                                onchange="window.ibex.stackMgr.updateNodeDataById('${nodeId}', '${key}', this.value)">
                            ${opts.map(o => `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`).join('')}
                        </select>
                    </div>`);
                }
            } else if (key.includes('_VIS') || meta.type === 'checkbox') {
                const isOn = (val === true || val === 1 || val === 'true');
                // Legge: boolean = .ctx-seg Sì/No (pattern "Tappa fori" del mock)
                html.push(`
                <div class="ctx-field">
                    <div class="ctx-fieldhead"><span class="ctx-lbl">${label}</span></div>
                    <div class="ctx-seg">
                        <button type="button" class="${isOn ? 'on' : ''}"
                            onclick="(function(btn){ btn.classList.add('on'); if(btn.nextElementSibling)btn.nextElementSibling.classList.remove('on'); window.ibex.stackMgr.updateNodeDataById('${nodeId}', '${key}', true); })(this)">Sì</button>
                        <button type="button" class="${!isOn ? 'on' : ''}"
                            onclick="(function(btn){ btn.classList.add('on'); if(btn.previousElementSibling)btn.previousElementSibling.classList.remove('on'); window.ibex.stackMgr.updateNodeDataById('${nodeId}', '${key}', false); })(this)">No</button>
                    </div>
                </div>`);
            } else {
                const dispVal = typeof val === 'number' ? val.toFixed(2) : val;
                // Legge .ctx-stepper: −/+ attorno all'input esistente. I bottoni
                // clampano su min/max e dispatchano 'change' → riusano il commit
                // path dell'input (label ctx-val + updateNodeDataById). L'input
                // mantiene .ibex-num.drag-input + data-* (contratto DragEngine).
                html.push(`
                <div class="ctx-field">
                    <div class="ctx-fieldhead">
                        <span class="ctx-lbl">${label}</span>
                        <span class="ctx-val" id="ctx-val-${nodeId}-${key}">${dispVal}</span>
                    </div>
                    <div class="ctx-stepper">
                        <button type="button" class="st"
                            onclick="(function(btn){
                                const inp = btn.parentElement.querySelector('input');
                                const st = parseFloat(inp.step) || 1;
                                const mn = parseFloat(inp.min), mx = parseFloat(inp.max);
                                let v = (parseFloat(inp.value) || 0) - st;
                                if (!isNaN(mn)) v = Math.max(mn, v);
                                inp.value = v;
                                inp.dispatchEvent(new Event('change'));
                            })(this)">−</button>
                        <input type="number"
                               class="ibex-num drag-input insp-input"
                               data-node-id="${nodeId}" data-key="${key}"
                               step="${meta.step ?? 0.1}"
                               min="${meta.min ?? -1000}" max="${meta.max ?? 1000}"
                               value="${val}"
                               onchange="(function(input){
                                   const el = document.getElementById('ctx-val-${nodeId}-${key}');
                                   if (el) el.textContent = parseFloat(input.value).toFixed(2);
                                   window.ibex.stackMgr.updateNodeDataById('${nodeId}', '${key}', input.value);
                               })(this)">
                        <button type="button" class="st"
                            onclick="(function(btn){
                                const inp = btn.parentElement.querySelector('input');
                                const st = parseFloat(inp.step) || 1;
                                const mn = parseFloat(inp.min), mx = parseFloat(inp.max);
                                let v = (parseFloat(inp.value) || 0) + st;
                                if (!isNaN(mx)) v = Math.min(mx, v);
                                inp.value = v;
                                inp.dispatchEvent(new Event('change'));
                            })(this)">+</button>
                    </div>
                </div>`);
            }
        }
        return html.join('');
    }

    // ═══════════════════════════════════════════════════════════════
    // V2.8 (2026-04-25) — Handler rename header + sezione proprietà mesh.
    //
    // Rename input: focus → select all, blur/Enter → setMeshDisplayName se
    // cambiato e non vuoto, Escape → ripristina + blur.
    // Visibility btn: toggle mesh.visible + visualState + flag split.
    // Opacity slider: oninput → mesh.material.opacity + visualState + label;
    //                 change → outlinerMgr.update() (sync sliding outliner).
    // Shading btns: toggle flatShading + needsUpdate=true + visualState.
    // ═══════════════════════════════════════════════════════════════
    _bindMeshPropsHandlers() {
        const root = this.currentContainer;
        if (!root) return;
        const sceneMgr    = window.ibex?.sceneMgr;
        const outlinerMgr = window.ibex?.outlinerMgr;
        const stackMgr    = window.ibex?.stackMgr;

        const findMesh = (meshName) => sceneMgr?.group?.children
            ?.find(c => c.isMesh && c.name === meshName) || null;
        const ensureVisualState = (meshName) => {
            if (!outlinerMgr) return null;
            outlinerMgr.visualState = outlinerMgr.visualState || {};
            if (!outlinerMgr.visualState[meshName]) {
                const m = findMesh(meshName);
                outlinerMgr.visualState[meshName] = {
                    visible: m?.visible !== false,
                    opacity: (m?.material?.transparent && typeof m.material?.opacity === 'number')
                              ? m.material.opacity : 1,
                    color: m?.material?.color?.getHex?.() ?? 0xffffff,
                    wireframe: !!m?.material?.wireframe,
                    flatShading: m?.material?.flatShading !== false
                };
            }
            return outlinerMgr.visualState[meshName];
        };

        // ─── Rename input ────────────────────────────────────────────
        const renameIn = root.querySelector('.ctx-mesh-rename-input');
        if (renameIn) {
            const meshName = renameIn.dataset.meshName;
            const initial = renameIn.value;
            renameIn.addEventListener('focus', () => renameIn.select());
            const commit = () => {
                const next = (renameIn.value || '').trim();
                if (!next) { renameIn.value = initial; return; }
                if (next === initial) return;
                if (stackMgr?.setMeshDisplayName) {
                    stackMgr.setMeshDisplayName(meshName, next);
                }
                // outlinerMgr riga viene aggiornata dal setter (refresh
                // InspectorPanel) + dal rename inline outliner se attivo.
                // Forziamo update qui per allineare la riga outliner che
                // legge `_getDisplayName` ad ogni `update()`.
                if (outlinerMgr?.update) outlinerMgr.update();
            };
            renameIn.addEventListener('blur', commit);
            renameIn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    renameIn.blur();   // triggera commit via blur
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    renameIn.value = initial;
                    renameIn.blur();
                }
            });
        }

        // ─── Visibilità ──────────────────────────────────────────────
        const visBtn = root.querySelector('.ctx-prop-vis-btn');
        if (visBtn) {
            const meshName = visBtn.dataset.meshName;
            visBtn.onclick = (e) => {
                e.stopPropagation();
                const mesh = findMesh(meshName);
                if (!mesh) return;
                const vs = ensureVisualState(meshName);
                const newVisible = !mesh.visible;
                mesh.visible = newVisible;
                if (vs) vs.visible = newVisible;
                // V2.8 (Inv. 88): se l'utente ri-mostra una mesh
                // auto-hidden dallo split, rimuovi il flag così il
                // prossimo updateSplitMasterVisibility la rispetta.
                if (newVisible && mesh.userData?.ibexSplitAutoHidden) {
                    delete mesh.userData.ibexSplitAutoHidden;
                }
                // Aggiorna icona inline (no full refresh per non perdere
                // focus su altri controlli).
                const open  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>`;
                const closed = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"/></svg>`;
                visBtn.innerHTML = newVisible ? open : closed;
                if (outlinerMgr?.update) outlinerMgr.update();
                if (sceneMgr?.render)    sceneMgr.render();
            };
        }

        // ─── Opacità ─────────────────────────────────────────────────
        const opacityIn  = root.querySelector('.ctx-prop-opacity');
        const opacityVal = root.querySelector('.ctx-prop-opacity-val');
        if (opacityIn) {
            const meshName = opacityIn.dataset.meshName;
            opacityIn.addEventListener('input', () => {
                const val = parseFloat(opacityIn.value);
                if (isNaN(val)) return;
                const mesh = findMesh(meshName);
                if (!mesh || !mesh.material) return;
                const vs = ensureVisualState(meshName);
                // V2.11 — se Orient è ON, scrivi opacity SUL matcap di riferimento
                // (per-mesh) invece che sullo ShaderMaterial singleton condiviso
                // (eviterebbe sovrascritture crociate fra mesh diverse).
                const target = (vs?.faceOrientation && mesh.userData._matcapMaterial)
                    ? mesh.userData._matcapMaterial
                    : mesh.material;
                target.transparent = true;
                target.opacity = val;
                if (vs) vs.opacity = val;
                if (opacityVal) opacityVal.textContent = `${Math.round(val * 100)}%`;
                if (sceneMgr?.render) sceneMgr.render();
                // Sync outliner SOLO su `change` (mouseup) — vedi listener sotto.
            });
            opacityIn.addEventListener('change', () => {
                if (outlinerMgr?.update) outlinerMgr.update();
            });
        }

        // ─── Shading flat/smooth + Face Orientation overlay (V2.11) ──
        // I 3 bottoni condividono la classe .ctx-prop-shade-btn ma con
        // semantiche diverse:
        //   - flat / smooth: mutuamente esclusivi, scrivono flatShading
        //   - orient: toggle indipendente, swap material a ShaderMaterial
        //     diagnostico (BLU front / ROSSO back).
        // Quando Orient è ON, flat/smooth scrivono sul matcap di
        // riferimento salvato (mesh.userData._matcapMaterial), così
        // l'utente prepara lo shading desiderato per il "ritorno".
        const shadeBtns = Array.from(root.querySelectorAll('.ctx-prop-shade-btn'));
        if (shadeBtns.length) {
            const wrap = root.querySelector('.ctx-prop-shade-btns');
            const meshName = wrap?.dataset?.meshName;
            const meshLoader = window.ibex?.loader;
            shadeBtns.forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    if (!meshName) return;
                    const mesh = findMesh(meshName);
                    if (!mesh || !mesh.material) return;
                    const shade = btn.dataset.shade;
                    const vs = ensureVisualState(meshName);

                    if (shade === 'orient') {
                        // Toggle indipendente: swap material ↔ matcap salvato
                        const isActive = btn.classList.contains('active');
                        if (!isActive) {
                            // Activate: salva matcap, swap a ShaderMaterial singleton
                            if (!meshLoader?.getOrientationMaterial) {
                                console.warn('[ContextInspector] meshLoader.getOrientationMaterial non disponibile');
                                return;
                            }
                            mesh.userData._matcapMaterial = mesh.material;
                            mesh.material = meshLoader.getOrientationMaterial();
                            btn.classList.add('active');
                        } else {
                            // Deactivate: ripristina matcap salvato
                            if (mesh.userData._matcapMaterial) {
                                mesh.material = mesh.userData._matcapMaterial;
                                delete mesh.userData._matcapMaterial;
                            }
                            btn.classList.remove('active');
                        }
                        if (vs) vs.faceOrientation = !isActive;
                        if (sceneMgr?.render) sceneMgr.render();
                        return;
                    }

                    // shade === 'flat' || 'smooth' (mutuamente esclusivi)
                    const flat = (shade === 'flat');
                    // Se Orient è ON, scrivi sul matcap di riferimento (invisibile
                    // finché Orient è ON, visibile non appena toggle OFF).
                    const target = (vs?.faceOrientation && mesh.userData._matcapMaterial)
                        ? mesh.userData._matcapMaterial
                        : mesh.material;
                    if (target) {
                        target.flatShading = flat;
                        target.needsUpdate = true;
                    }
                    if (vs) vs.flatShading = flat;
                    // Toggle .active SOLO fra flat e smooth — orient resta indipendente
                    shadeBtns.forEach(b => {
                        if (b.dataset.shade === 'flat' || b.dataset.shade === 'smooth') {
                            b.classList.toggle('active', b.dataset.shade === shade);
                        }
                    });
                    if (sceneMgr?.render) sceneMgr.render();
                };
            });
        }
    }
}
