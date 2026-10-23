// ═══════════════════════════════════════════════════════════════
// IBEX NodeBuilder CurveEditNoRename_V5.18 — spawn nodi al centro VISIBILE
//
// V5.18 (2026-05-14 CurveEditNoRename):
//   - curve_edit: RIMOSSO input rename (era V5.17 erroneo). Il nodo
//     editor di curva NON ha display name proprio — eredita dal producer
//     upstream (arch_detect / draw_curve). Mantenuti: socket reorder
//     (CRV top, GEO bottom) + strip blu.
//
// V5.17 (2026-05-14 CurveDisplayNameAll):
//   - curve_edit: socket reordered → IN_CRV_Curve (top, primario) +
//     IN_GEO_Mesh (bottom, opzionale per snap-on-surface). Mesh demoted
//     a referenza secondaria.
//   - Strip blu estesa a TUTTI i curve tools (arch_detect, draw_curve,
//     curve_edit) via `StackManager._refreshSculptNodeDOM CURVE_TOOLS set`.
//
// V5.16 (2026-05-14 CurveDisplayName):
//   Aggiunto template input editabile `.ibex-curve-output-name-input`
//   nei nodi produttori di curve (arch_detect, draw_curve). Storage
//   `node.data.curveDisplayName: null` (fallback al toolName). Pattern
//   speculare a SplitBranchRename V5.17 ma più semplice (singolo
//   output curva, non multi-branch A/B). Setter centralizzato
//   `StackManager.setCurveDisplayName(nodeId, name)`.
//
// V5.15 (2026-05-04 RightClickPan):
//   Fix bug "i nodi vengono importati lontano dalla vista": il fallback
//   coordinate quando l'utente clicca una `.tool-card` (no event drag) usava
//   `precanvas.getBoundingClientRect().width/2` come riferimento, ma il
//   precanvas È TRASFORMATO da Drawflow (post-zoom/pan) → la sua dimensione
//   non corrisponde al centro visibile del container. Esempio: se il canvas
//   è pannato a -2000px sull'asse X, precanvas.rect.left = -2000 ma rect.width
//   resta 1500px → la formula vecchia mette il nodo a px=750/zoom + offset
//   stale. Fix: helper module-level `_centerOfVisibleCanvas(editor)` che usa
//   `container.rect` come riferimento e replica esattamente il pattern di
//   `IbexCore.dropMeshToCanvas` (centro screen container → coord canvas via
//   `(clientX - precanvas.left) / zoom`). I 6 call site (addMeshNode +
//   addTool + 4 _add*Node) ora delegano all'helper unificato.
//
// V5.12 (2026-04-25, Obiettivi 1+2):
//   Obiettivo 1 — Rimosso il placeholder `.ibex-node-target-row` dal
//     template `addTool` (path generico tool Tier 1/Tier 2). La label
//     resta SOLO nei 3 template destructive (`_addSculptNode`,
//     `_addDeleteTopologyNode`, `_addSplitTopologyNode`) dove
//     `StackManager._refreshDestructiveNodeLabels` la popola col nome
//     del file snapshot prodotto (`{stem}_snap_{nodeId}` o
//     `{stem}_snap_{nodeId}_A + _B` per split). Sui tool generici la
//     label era ridondante (target = sempre la mesh root upstream).
//   Obiettivo 2 — `addMeshNode` aggiunge `node.data.displayName` accanto
//     a `meshName`. `meshName` è IMMUTABILE (identità keyed per file su
//     disco, manifest, worker); `displayName` è la stringa libera mostrata
//     nel title-box e modificabile via Outliner double-click. Inizialmente
//     coincidono (`meshName.replace(/\.stl$/i,'')`). OutlinerManager V12.5
//     aggiorna SOLO `displayName` al rename — il sistema interno continua
//     a usare `meshName` per la pipeline.
//
// V5.11 (2026-04-25, Obiettivo 2a):
//   - Aggiunto placeholder `<div class="ibex-node-target-row"><span
//     class="ibex-node-target-label">—</span></div>` SOTTO il `.title-box`
//     in tutti e 4 i template di nodi tool: `addTool` (catch-all generici),
//     `_addSculptNode`, `_addDeleteTopologyNode`, `_addSplitTopologyNode`.
//   - Lo span è popolato dinamicamente da
//     `StackManager._refreshAllNodeTargetLabels()` (chiamato a fine
//     `syncAndBake`) con lo stem del `step.target` risolto via
//     `flattenGraphForBackend`. Nodi non collegati o con target non
//     risolvibile mostrano `—`.
//   - Nodi `mesh` NON hanno questa label (il loro nome è già nel
//     `title-box` del template mesh, che mostra `cleanMeshName`).
//
// V5.10 (2026-04-25 post-deploy UX):
//   - Template `_addSplitTopologyNode` aggiunge blocco `.ibex-split-outputs`
//     con 2 righe (branch A/B) contenenti badge verde + name placeholder `—`.
//     I nomi vengono popolati dinamicamente da `StackManager._refreshSculptNodeDOM`
//     quando `meta.sculpted=true`, usando `{stem}_snap_{nodeId}_{A,B}` (senza .stl
//     per compattezza; il .stl è nel tooltip).
//
// V5.9 (2026-04-25, SnapshotKeyed Session 3) — nodo `split_topology` (multi-output)
//
// V5.9 (2026-04-25, SnapshotKeyed Session 3):
//   - Branch `toolId === 'split_topology'` → `_addSplitTopologyNode`.
//     Crea nodo con 2 output (`OUT_GEO_A` + `OUT_GEO_B`) tramite Drawflow
//     `addNode(..., numInputs=1, numOutputs=2, ...)`. I 2 port sono
//     posizionati nativamente da Drawflow in colonna; `_colorDrawflowPorts`
//     li colora entrambi via `outKeys`. Template bottone "Seleziona zone"
//     (chiama `selectionMode.enter(nodeId, 'split')`).
//
// V5.8 (2026-04-24, SnapshotKeyed Session 2) — nodo `delete_topology`
//
// V5.8 (2026-04-24, SnapshotKeyed Session 2):
//   - Branch dedicato per toolId === 'delete_topology': template senza
//     widgets UI (come sculpt), bottone "Seleziona zone" che attiva
//     SelectionMode. `data.destructive = true` hardcoded, `tier = 1`.
//     Pattern identico a `_addSculptNode`.
//
// V5.7 (2026-04-23, SnapshotKeyed Session 1) — propagazione flag `destructive`
//
// V5.7 (2026-04-23, SnapshotKeyed Session 1):
//   - `addTool` e `_addSculptNode` leggono `destructive` da gn_meta.json
//     (tramite stackMgr.gnManifest[toolId].destructive) e lo salvano in
//     `node.data.destructive`. StackManager.extractDAG lo porta nel
//     graph node, ToolExecutor.flattenGraphForBackend lo usa per decidere
//     se iniettare `_snapshot_node_id` nei params dello step.
//     Invariante S1-A2 opzione (a): propagazione via node.data.
//
// V5.6 (2026-04-22, Sculpt V2 Sessione 2):
//   - Branch dedicato per toolId === 'sculpt': template senza widgets UI
//     (il nodo è solo un "interruttore" nella pipeline + lancio sculpt mode).
//     data.meta = { sculpted, vertex_count, last_modified } inizializzato;
//     strip verde/grigia via classe .ibex-sculpt-node-modified (aggiornata
//     da StackManager.refreshSculptNode() in Sessione 4 al success del save).
//   - Nessun ramo legacy per delta_sculpting (già rimosso in Sessione 1).
//
// — Storico V5.5 / V5.4 / V5.3 / V5.2 / V5.1 / V5.0 —
//
// V5.4 (2026-04-22):
//   - Ripristino socket piccoli (10×10) richiesti dal prompt originale
//     nodi. Il bug "linea di connessione lontana dal click" NON era causato
//     dalle dimensioni dei socket: persiste anche con 20×20 default Drawflow.
//     La causa vera è strutturale (catena offsetParent del DAG overlay o
//     cache interna Drawflow) — da indagare con diagnostica DevTools.
//
// V5.3 (2026-04-22):
//   - Ripristinate dimensioni/coordinate Drawflow DEFAULT sui socket
//     (20×20, `left:-27px`, `right:-3px`, `top:2px`, position relative,
//     margin-bottom:5px, z-index:1). Drawflow calcola la posizione della
//     linea di connessione con una matematica interna allineata a questi
//     valori — qualunque override (7×7, 14×14, left:-4/-7) faceva drifta
//     la line start-position rispetto al cursore.
//   - `_colorDrawflowPorts` ora colora il `borderColor` (era `color`): il
//     socket appare come anello colorato sul tipo su centro bianco.
//
// V5.2 — Tentativo con `::after` (hit-area 20 + pallino visivo 8). Rotto
//        il calcolo line-start di Drawflow.
//
// V5.1 (2026-04-22):
//   - addMeshNode: rimosso SVG cubo, testo "RAW MESH", body collassato al
//     solo title-box con {meshName}. Body vuoto (socket sui bordi bastano).
//   - addTool: rimosso SVG cogwheel dal title-box; eliminato il blocco
//     duplicato socket-labels in cima al body ("⬢ Mesh | Trasformata ◆").
//     Restano solo i widget parametrici (gruppi collassabili) + bottone sculpt.
//   - Colori hardcoded aggiornati a palette ClinicalWhite:
//       · XYZ labels: #ff4444/#44ff44/#4488ff → #C4302B/#1F8A4C/#2A6FDB
//       · _getSocketColor: #1F8A4C/#f59e0b/#6b7280 → #1F8A4C/#D4860D/#A8A6A1
//       · Rimosso `color: #fff` legacy dal mesh name (body mesh non esiste più).
//   - _colorDrawflowPorts: applica il colore dot anche senza label di
//     riferimento (i label socket nel body sono stati rimossi; i dot
//     restano colorati per tipo via _getSocketColor).
//
// V5.0 (pre-ClinicalWhite): Rimosso inline style sculpt button.
// ═══════════════════════════════════════════════════════════════

// V5.13 RightClickPan (2026-05-04) — helper module-level per il fallback
// "no coord" usato da addTool/addMeshNode/_addSculptNode/_addDeleteTopology
// Node/_addSplitTopologyNode/_addExportNode. Pattern corretto: il centro
// VISIBILE del container DAG (#drawflow) in coordinate canvas. La formula
// pre-V5.13 (`precanvas.width/2 - canvas_x) / zoom`) era SBAGLIATA: usava
// la dimensione TRASFORMATA del precanvas (post-zoom/pan) come riferimento
// → spawn lontano dalla vista corrente. La formula nuova replica esattamente
// il pattern di IbexCore.dropMeshToCanvas (Cleanup storici 2026-04-30):
// container.rect.center → coord canvas via (clientX - precanvas.left)/zoom.
function _centerOfVisibleCanvas(editor) {
    const container = document.getElementById('drawflow');
    if (!container || !editor || !editor.precanvas) return { px: 300, py: 200 };
    const cRect = container.getBoundingClientRect();
    const pRect = editor.precanvas.getBoundingClientRect();
    const screenCenterX = cRect.left + cRect.width / 2;
    const screenCenterY = cRect.top + cRect.height / 2;
    const zoom = editor.zoom || 1;
    return {
        px: (screenCenterX - pRect.left) / zoom,
        py: (screenCenterY - pRect.top) / zoom,
    };
}

export class NodeBuilder {
    constructor(stackMgr) {
        this.stackMgr = stackMgr;
        
        window.toggleIbexGroup = (headerElement) => {
            const body = headerElement.nextElementSibling;
            const chev = headerElement.querySelector('.ibex-chev');
            if (body && chev) {
                body.classList.toggle('ibex-collapsed');
                chev.classList.toggle('ibex-chev-closed');
                
                const nodeEl = headerElement.closest('.drawflow-node');
                if (nodeEl && this.stackMgr.editor) {
                    const nodeId = nodeEl.id.replace('node-', '');
                    const toolNode = this.stackMgr.editor.getNodeFromId(nodeId);
                    if(toolNode && toolNode.data) {
                        this._colorDrawflowPorts(nodeId, toolNode.data.inPorts || [], toolNode.data.outPorts || [], toolNode.data.panelId);
                    }
                    this.stackMgr.editor.updateConnectionNodes(nodeEl.id);
                }
            }
        };
    }

    get editor() { return this.stackMgr.editor; }

    getAvailableMeshes() {
        if (!window.ibex || !window.ibex.sceneMgr || !window.ibex.sceneMgr.group) return [];
        return window.ibex.sceneMgr.group.children
            .filter(obj => obj.isMesh && obj.name && !obj.isGridHelper)
            .map(obj => obj.name);
    }

    addMeshNode(meshName, pos_x, pos_y) {
        if (!this.editor) return;

        let px = parseFloat(pos_x);
        let py = parseFloat(pos_y);
        if (isNaN(px) || isNaN(py)) {
            const c = _centerOfVisibleCanvas(this.editor);
            px = c.px; py = c.py;
        }
        const panelId = `mesh-${Math.random().toString(36).substr(2, 5)}`;

        // V5.12 — separazione meshName (identità immutabile, keyed file disco)
        // vs displayName (label libera UI). Al primo addNode i due coincidono;
        // l'utente può cambiarli via Outliner doppio click → solo displayName
        // viene aggiornato. Il title-box mostra `displayName`; il sistema
        // continua a usare `meshName` per pipeline/worker/snapshot/manifest.
        const cleanInitial = meshName.replace(/\.stl$/i, '');
        const html = `
            <div class="title-box"><span class="tt">${cleanInitial}</span></div>
            <div class="box"></div>
        `;

        const nodeId = this.editor.addNode('mesh', 0, 1, px, py, 'mesh', {
            meshName:    meshName,           // immutabile — identità file
            displayName: cleanInitial,        // libero — solo UI
            outPorts:    ['OUT_GEO_Mesh'],
            panelId:     panelId
        }, html);
        this._colorDrawflowPorts(nodeId, [], ['OUT_GEO_Mesh'], panelId);
    }

    addTool(config, pos_x, pos_y) {
        if (!this.editor) return;

        let toolId = typeof config === 'string' ? config : (config?.toolId || config?.id || "");
        if (!toolId) {
            console.error("IBEX: payload non valido per addTool", config);
            return;
        }

        // GodCollapse 2026-07-29 — le otto `if (toolId === 'X') { this._addXNode(); return; }`
        // sono diventate un lookup nel registro `NODE_SPECS` (in fondo al file).
        // Stessi 8 tool id, stessa posizione nel flusso di addTool, stesso `return`
        // che corto-circuita il path generico Tier 1/2 qui sotto.
        // ⚠️ `Object.hasOwn` e non `NODE_SPECS[toolId]` nudo: un toolId come
        // 'constructor' o 'toString' pescherebbe da Object.prototype e passerebbe
        // il test di verità. Le otto `===` originali non avevano il problema.
        if (Object.hasOwn(NODE_SPECS, toolId)) {
            this._addNode(NODE_SPECS[toolId], pos_x, pos_y);
            return;
        }
        
        // ═══════════════════════════════════════════════════════
        // 🟢 FIX CRITICO: params DEVE essere un Object {}, MAI un Array []
        //
        // Il PHP getCategorizedTools() può restituire params come []
        // (da json_decode di stringa vuota). Se Drawflow salva un Array,
        // le chiavi stringa (es. 'G1_Trasla_POS') non sopravvivono
        // alla serializzazione JSON → il backend riceve {}
        // ═══════════════════════════════════════════════════════
        let params = {};
        if (typeof config === 'object' && config.params && !Array.isArray(config.params)) {
            params = {...config.params};
        }

        let px = parseFloat(pos_x);
        let py = parseFloat(pos_y);
        if (isNaN(px) || isNaN(py)) {
            const c = _centerOfVisibleCanvas(this.editor);
            px = c.px; py = c.py;
        }

        const manifest = this.stackMgr.gnManifest || {};
        const toolMeta = manifest[toolId] || manifest[toolId.toLowerCase()] || {};
        // tier: 1 = FAST (Trimesh, no Blender), 2 = GN/PY (Blender)
        const tier = (toolMeta.tech_type === 'FAST') ? 1 : 2;
        // SnapshotKeyed S1: flag propagato in node.data.destructive per
        // ToolExecutor.flattenGraphForBackend (iniezione _snapshot_node_id).
        const destructive = !!toolMeta.destructive;
        const inPortsRaw = toolMeta.inputs !== undefined ? toolMeta.inputs : toolMeta;
        const outPortsRaw = toolMeta.outputs || {};
        
        const inKeys = Object.keys(inPortsRaw).filter(k => k.startsWith('IN_'));
        const outKeys = Object.keys(outPortsRaw).filter(k => k.startsWith('OUT_'));
        
        const numInputs = inKeys.length;
        const numOutputs = outKeys.length;

        const titleClean = (toolMeta.display_name || toolId.toUpperCase().replace('GN_', '').replace('FAST_', '').replace(/_/g, ' '));
        const panelId = `panel-${toolId}-${Math.random().toString(36).substr(2, 5)}`;

        const groups = { "_root": { title: "_root", items: [] } }; 
        
        Object.entries(inPortsRaw).forEach(([key, meta]) => {
            if (key.startsWith('IN_') || key.startsWith('OUT_') || key.startsWith('H_')) return; 
            
            if (params[key] === undefined) {
                params[key] = meta.default ?? (key.includes('_SCL') ? 1 : 0);
            }

            let groupKey = "_root";
            let groupTitle = "_root";
            const match = key.match(/^G(\d+)_(.+)/);
            
            if (match) {
                groupKey = `G${match[1]}`; 
                let cleanName = match[2].replace(/_(INT|PCT|POS|ROT|SCL|COL|VIS|STR|MENU|OBJ|COLLECT|MAT)$/, '');
                groupTitle = cleanName.replace(/_/g, ' '); 
            }

            if (!groups[groupKey]) groups[groupKey] = { title: groupTitle, items: [] };
            groups[groupKey].items.push({ key, meta });
        });

        let html = `
            <div class="title-box"><span class="tt">${titleClean}</span></div>
            <div class="box">
        `;

        // V5.1: il blocco "socket labels" in cima al body è stato rimosso
        // (duplicava l'informazione del colore/posizione dei pallini socket).
        // I tipi dei port vengono ora segnalati solo dai dot colorati sui bordi.

        const generateWidget = (key, meta) => {
            const ra = meta.isReadonly ? "ibex-readonly" : "";
            const value = params[key];
            const req = key.startsWith('REQ_') ? `<span class="ibex-req">*</span>` : '';
            const label = key.replace(/^(G\d+_|REQ_|H_|R_)/, '').replace(/_(INT|PCT|POS|ROT|SCL|COL|VIS|STR|MENU|OBJ|COLLECT|MAT)$/, '').replace(/_/g, ' ');

            if (meta.type === 'vector' || key.includes('_POS') || key.includes('_ROT') || key.includes('_SCL')) {
                const valX = Array.isArray(value) ? value[0] : (meta.default?.[0] || 0);
                const valY = Array.isArray(value) ? value[1] : (meta.default?.[1] || 0);
                const valZ = Array.isArray(value) ? value[2] : (meta.default?.[2] || 0);
                
                const onChangeStr = `const wrap = this.closest('.ibex-vector-group'); const inputs = wrap.querySelectorAll('input.ibex-vector-input'); const arr = [parseFloat(inputs[0].value)||0, parseFloat(inputs[1].value)||0, parseFloat(inputs[2].value)||0]; window.ibex.stackMgr.updateNodeData(this, '${key}', arr);`;

                return `
                    <div class="ibex-vector-group" data-key="${key}" style="margin-bottom: 4px;">
                        <div class="ibex-row ${ra}">
                            <span class="ibex-lbl" style="color:#C4302B; font-weight:bold;">X</span>
                            <div class="ibex-val-wrap">
                                <input type="number" data-key="${key}" class="ibex-num drag-input ibex-vector-input" step="${meta.step || 0.1}" value="${valX}" onchange="${onChangeStr}">
                            </div>
                        </div>
                        <div class="ibex-row ${ra}">
                            <span class="ibex-lbl" style="color:#1F8A4C; font-weight:bold;">Y</span>
                            <div class="ibex-val-wrap">
                                <input type="number" data-key="${key}" class="ibex-num drag-input ibex-vector-input" step="${meta.step || 0.1}" value="${valY}" onchange="${onChangeStr}">
                            </div>
                        </div>
                        <div class="ibex-row ${ra}">
                            <span class="ibex-lbl" style="color:#2A6FDB; font-weight:bold;">Z</span>
                            <div class="ibex-val-wrap">
                                <input type="number" data-key="${key}" class="ibex-num drag-input ibex-vector-input" step="${meta.step || 0.1}" value="${valZ}" onchange="${onChangeStr}">
                            </div>
                        </div>
                    </div>`;
            } else if (key.includes('_INT') || key.includes('_PCT') || meta.type === 'slider') {
                return `
                    <div class="ibex-row ${ra}">
                        <span class="ibex-lbl" title="${label}">${label}${req}</span>
                        <div class="ibex-val-wrap">
                            <input type="number" data-key="${key}" class="ibex-num drag-input" step="${meta.step || 0.1}" value="${value}" onchange="window.ibex.stackMgr.updateNodeData(this, '${key}', this.value)">
                        </div>
                    </div>`;
            } else if (meta.widgetType === 'select_obj' || meta.type === 'select_obj' || key.includes('_MAT') || key.includes('_MENU')) {
                return `
                    <div class="ibex-col ${ra}">
                        <span class="ibex-lbl" title="${label}">${label}${req}</span>
                        <select class="ibex-select drag-input" data-key="${key}" onchange="window.ibex.stackMgr.updateNodeData(this, '${key}', this.value)">
                            <option value="">— Seleziona —</option>
                        </select>
                    </div>`;
            } else if (key.includes('_VIS') || meta.type === 'checkbox' || meta.type === 'NodeSocketBool') {
                const checked = (value === true || value === 1 || value === 'true') ? "checked" : "";
                return `
                    <div class="ibex-row ${ra}">
                        <span class="ibex-lbl" title="${label}">${label}${req}</span>
                        <label class="ibex-toggle">
                            <input type="checkbox" data-key="${key}" class="drag-input" ${checked} onchange="window.ibex.stackMgr.updateNodeData(this, '${key}', this.checked)">
                            <div class="ibex-toggle-track"><div class="ibex-toggle-thumb"></div></div>
                        </label>
                    </div>`;
            } else if (meta.type === 'color' || key.includes('_COL')) {
                 return `
                    <div class="ibex-row ${ra}">
                        <span class="ibex-lbl" title="${label}">${label}${req}</span>
                        <input type="color" data-key="${key}" class="drag-input" value="${value || meta.default || '#ffffff'}" onchange="window.ibex.stackMgr.updateNodeData(this, '${key}', this.value)">
                    </div>`;
            } else {
                return `
                    <div class="ibex-row ${ra}">
                        <span class="ibex-lbl" title="${label}">${label}${req}</span>
                        <input type="text" data-key="${key}" class="ibex-num drag-input" value="${value || ''}" onchange="window.ibex.stackMgr.updateNodeData(this, '${key}', this.value)">
                    </div>`;
            }
        };

        if (groups["_root"].items.length > 0) {
            groups["_root"].items.forEach(item => { html += generateWidget(item.key, item.meta); });
        }

        Object.keys(groups).sort().forEach(groupKey => {
            if (groupKey === "_root") return;
            const groupInfo = groups[groupKey];
            html += `
                <div class="ibex-group">
                    <div class="ibex-group-head" onclick="window.toggleIbexGroup(this)">
                        <span class="ibex-chev ibex-chev-closed">▼</span>
                        <span>${groupInfo.title}</span>
                    </div>
                    <div class="ibex-group-body ibex-collapsed">
            `;
            groupInfo.items.forEach(item => { html += generateWidget(item.key, item.meta); });
            html += `</div></div>`;
        });

        // Sculpt V2 Sessione 1: delta_sculpting rimosso — nessun bottone sculpt legacy.
        // Il nuovo tool `sculpt` verrà aggiunto in Sessione 2 con un branch dedicato.

        html += `</div>`;

        const nodeId = this.editor.addNode('tool', numInputs, numOutputs, px, py, 'tool', {
            toolId: toolId,
            tier: tier,
            destructive: destructive,
            params: params,
            paramsConfig: inPortsRaw,
            inPorts: inKeys,
            outPorts: outKeys,
            panelId: panelId
        }, html);

        this._colorDrawflowPorts(nodeId, inKeys, outKeys, panelId);
    }

    // ─────────────────────────────────────────────────────────────
    // Preset DAG (2026-05-05) — spawn nodo da preset payload.
    // Riusa il path di addX (addTool / _addSculptNode / _addDeleteTopologyNode /
    // _addSplitTopologyNode / _addExportNode) selezionato in base a toolId,
    // con params predefiniti dal preset. Il sistema di routing è legato ai
    // toolId in StackManager.addTool (che internamente fa branch su
    // 'sculpt'/'delete_topology'/'split_topology'/'burn' e cade in
    // addTool generico altrimenti). Riusiamo quel branch.
    // Il nuovo nodeId Drawflow viene derivato via diff before/after di
    // editor.export() — addNode() di Drawflow non lo ritorna direttamente
    // attraverso addTool (assenza catturabile via wrapper in V1).
    // Ritorna il nodeId stringa del nodo creato, oppure null su errore
    // (es. toolId non più presente in gn_meta — preset stale).
    // ─────────────────────────────────────────────────────────────
    addToolFromPreset(toolId, params, px, py) {
        if (!this.editor) return null;
        const manifest = this.stackMgr?.gnManifest || {};
        // Tool preset-only "destructive" hanno entry in manifest? Sì
        // (sculpt/delete_topology/split_topology hanno tutte voce in
        // gn_meta.json con `destructive: true`). Mesh ed export_stl sono
        // esclusi a monte da extractPresetPayload (filter), ma defensive:
        if (toolId === 'burn') return null;
        if (!manifest[toolId]) {
            console.warn('[NodeBuilder] preset stale: toolId mancante in gn_meta', toolId);
            return null;
        }

        const before = new Set(Object.keys(this.editor.export()?.drawflow?.Home?.data || {}));

        // Dispatch sui costruttori dedicati per nodi che hanno template UI
        // custom (sculpt/delete/split/export) — addTool generico per Tier 1/2.
        // Pattern allineato a stackMgr.addTool (riga 1697 → nodeBuilder.addTool).
        try {
            if (toolId === 'sculpt') {
                this._addNode(NODE_SPECS.sculpt, px, py);
            } else if (toolId === 'delete_topology') {
                this._addNode(NODE_SPECS.delete_topology, px, py);
            } else if (toolId === 'split_topology') {
                this._addNode(NODE_SPECS.split_topology, px, py);
            } else {
                // Tool generici: addTool(config, x, y), config contiene toolId + params predefiniti
                this.addTool({ toolId, params }, px, py);
            }
        } catch (e) {
            console.warn('[NodeBuilder] addToolFromPreset spawn failed', toolId, e);
            return null;
        }

        const after = Object.keys(this.editor.export()?.drawflow?.Home?.data || {});
        const created = after.find(k => !before.has(k));
        if (created == null) return null;

        // Per i template custom (sculpt/delete/split) i params arrivano
        // attraverso `this._addSculptNode` etc., che NON accettano params
        // come argomento (sono nodi senza widget). Per coerenza, popolo
        // node.data.params manualmente se il template non l'ha fatto.
        if (toolId === 'sculpt' || toolId === 'delete_topology' || toolId === 'split_topology') {
            const node = this.editor.getNodeFromId(created);
            if (node?.data) {
                const newData = { ...node.data, params: { ...(node.data.params || {}), ...(params || {}) } };
                this.editor.updateNodeDataFromId(created, newData);
            }
        }
        return String(created);
    }

    // ─────────────────────────────────────────────────────────────
    // GodCollapse 2026-07-29 — COSTRUTTORE UNICO per gli 8 nodi a template
    // custom (sculpt · delete_topology · topology_rebuild · draw_curve ·
    // arch_detect · curve_edit · split_topology · burn).
    //
    // Lo scheletro qui sotto è VERBATIM da `_addSculptNode`, che era il
    // template degli 8 («Pattern identico a _addSculptNode» lo diceva il
    // codice stesso). Ogni punto in cui gli 8 builder differivano
    // è letto dal descrittore `spec`
    // (registro `NODE_SPECS`, in fondo al file). I descrittori sono SOLI
    // DATI: nessun ramo, nessuna closure, nessun calcolo.
    //
    // ⚠️ `structuredClone` non è cosmetico. Negli 8 builder originali `meta`,
    // `params` e `paramsConfig` erano object literal RICREATI a ogni chiamata.
    // Senza la copia, due nodi dello stesso tipo condividerebbero lo stesso
    // oggetto e una mutazione dell'uno (`updateSculptNodeMeta`, `setNodeParam`)
    // toccherebbe anche l'altro. La copia conserva la semantica «fresco a ogni
    // nodo». E `panelId` si assegna a una chiave GIÀ DICHIARATA nel
    // descrittore, così l'ORDINE delle chiavi di `data` resta quello originale.
    //
    // ⚠️ `return nodeId` è ora incondizionato. Prima lo faceva SOLO
    // `_addExportNode`: entrambi i dispatcher scartano il valore (`addTool` fa
    // `return;` nudo, `addToolFromPreset` esclude `burn` a monte e ricava l'id
    // dal diff di `editor.export()`) e non esiste un chiamante esterno →
    // unificare verso l'alto non è osservabile.
    // ─────────────────────────────────────────────────────────────
    _addNode(spec, pos_x, pos_y) {
        if (!this.editor) return;

        let px = parseFloat(pos_x);
        let py = parseFloat(pos_y);
        if (isNaN(px) || isNaN(py)) {
            const c = _centerOfVisibleCanvas(this.editor);
            px = c.px; py = c.py;
        }

        const panelId = `panel-${spec.panelSlug}-${Math.random().toString(36).substr(2, 5)}`;

        const data = structuredClone(spec.data);
        data.panelId = panelId;

        const nodeId = this.editor.addNode(
            'tool', spec.numInputs, spec.numOutputs, px, py, 'tool',
            data,
            spec.html
        );

        this._colorDrawflowPorts(nodeId, [...data.inPorts], [...data.outPorts], panelId);
        return nodeId;
    }

    _getSocketColor(portName) {
        if (portName.includes('_MTX_') || portName.includes('_VEC_')) return '#D4860D'; // AMBRA — Vettori/Matrici
        if (portName.includes('_GEO_')) return '#1F8A4C'; // VERDE — Geometria
        if (portName.includes('_CRV_')) return '#2A6FDB'; // BLU — Curva (DrawCurve V1.0)
        return '#A8A6A1'; // GRIGIO CHIARO — Valori (Float/Int/Bool)
    }

    _colorDrawflowPorts(nodeId, inKeys, outKeys, panelId) {
        setTimeout(() => {
            const nodeEl = document.getElementById(`node-${nodeId}`);
            if (!nodeEl) return;

            const getRelativeTop = (el, parent) => {
                let top = 0;
                while (el && el !== parent) {
                    top += el.offsetTop;
                    el = el.offsetParent;
                }
                return top;
            };

            const colorDot = (dot, type, index) => {
                if (!dot) return;

                // V5.3: socket usano dimensioni/coordinate default Drawflow
                // (20×20 con border 2px + background). Il colore del tipo va
                // sul `borderColor` — anello colorato su centro bianco.
                const keyName = (type === 'in' ? inKeys : outKeys)[index] || '';
                const color = this._getSocketColor(keyName);
                dot.style.borderColor = color;

                // NodeSkin V5.21 (legge .sock.filled): pallino PIENO del colore
                // tipo quando il socket ha ≥1 connessione, vuoto (surface via
                // CSS) quando libero. Stato letto dal grafo Drawflow.
                let connected = false;
                try {
                    const nd = this.editor?.getNodeFromId(nodeId);
                    const port = type === 'in'
                        ? nd?.inputs?.[`input_${index + 1}`]
                        : nd?.outputs?.[`output_${index + 1}`];
                    connected = !!(port?.connections?.length);
                } catch (e) { /* nodo non ancora nel grafo → resta vuoto */ }
                dot.style.background = connected ? color : '';

                const label = document.getElementById(`lbl-${panelId}-${type}-${index}`);
                if (label) {
                    const relativeTop = getRelativeTop(label, nodeEl) + (label.offsetHeight / 2) - 8;
                    dot.style.position = 'absolute';
                    dot.style.top = `${relativeTop}px`;
                }
            };

            const inputs = nodeEl.querySelectorAll('.inputs .input');
            inputs.forEach((dot, index) => colorDot(dot, 'in', index));

            const outputs = nodeEl.querySelectorAll('.outputs .output');
            outputs.forEach((dot, index) => colorDot(dot, 'out', index));

            if (this.editor) this.editor.updateConnectionNodes(`node-${nodeId}`);

        }, 50);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// NODE_SPECS — GodCollapse 2026-07-29
//
// Un descrittore per ciascuno degli 8 nodi a template custom. Sostituisce
// gli 8 metodi `_addXNode` (583 righe), che erano lo STESSO scheletro con
// dentro questi dati.
//
// 🔴 REGOLA: qui dentro SOLO DATI. Nessun `if`, nessuna funzione, nessun
// calcolo. Se un nodo futuro richiedesse logica propria, NON va infilata in
// un descrittore: o si estende `_addNode` con un punto di variazione
// dichiarativo, o quel nodo si tiene un costruttore suo.
//
// I campi mappano 1:1 sui punti-differenza censiti nel report:
//   panelSlug            → il pezzo variabile di `panel-<slug>-<random>`
//   numInputs/numOutputs → i 2 argomenti posizionali di `editor.addNode`
//   data                 → l'oggetto passato a Drawflow, chiavi NELL'ORDINE
//                          dell'originale; `panelId: null` è il segnaposto
//                          che `_addNode` riempie (assegnare a una chiave
//                          esistente non ne cambia la posizione)
//   html                 → il template del nodo, stringa COSTANTE: nessuno
//                          degli 8 conteneva interpolazioni (misurato, con
//                          controllo positivo su addMeshNode/addTool che
//                          invece ne hanno). Le closure `onclick` sono testo.
//
// ⚠️ Aggiungere un nodo qui lo rende automaticamente raggiungibile da
// `addTool` (lookup su `Object.hasOwn`). Per `addToolFromPreset` il dispatch
// resta esplicito sui 3 storici — vedi il commento lì.
// ═══════════════════════════════════════════════════════════════════════
const NODE_SPECS = {

    sculpt: {
        panelSlug:  'sculpt',
        numInputs:  1,
        numOutputs: 1,
        data: {
            toolId:       'sculpt',
            toolName:     'Scolpisci',
            tier:         1,
            destructive:  true,  // SnapshotKeyed S1: sculpt produce snapshot per nodeId
            params:       {},
            paramsConfig: {
                // paramsConfig minimo: solo i socket, così extractDAG può propagare
                // inPorts/outPorts correttamente. Nessuna entry G*_ → nessun widget.
                IN_GEO_Mesh:  { type: 'NodeSocketGeometry', is_port: true },
                OUT_GEO_Mesh: { type: 'NodeSocketGeometry', is_port: true }
            },
            inPorts:      ['IN_GEO_Mesh'],
            outPorts:     ['OUT_GEO_Mesh'],
            panelId:      null,
            meta:         { sculpted: false, vertex_count: 0, last_modified: 0 }
        },
        html: `
            <div class="title-box"><span class="tt">Scolpisci</span></div>
            <div class="ibex-node-target-row"><span class="ibex-node-target-label">—</span></div>
            <div class="box">
                <div class="ibex-sculpt-status" data-state="idle">
                    <span class="ibex-sculpt-label">Non ancora modificato</span>
                </div>
                <button class="ibex-sculpt-modify-btn" onclick="(function(btn){
                    const nodeEl = btn.closest('.drawflow-node');
                    if (!nodeEl) return;
                    const nodeId = nodeEl.id.replace('node-','');
                    if (window.ibex && window.ibex.sculptMgr) {
                        window.ibex.sculptMgr.enter(nodeId);
                    }
                })(this)">Modifica</button>
            </div>
        `,
    },

    delete_topology: {
        panelSlug:  'delete',
        numInputs:  1,
        numOutputs: 1,
        data: {
            toolId:       'delete_topology',
            toolName:     'Cancella Topologia',
            tier:         1,
            destructive:  true,   // SnapshotKeyed S1+S2: produce snapshot per nodeId
            params:       {},
            paramsConfig: {
                IN_GEO_Mesh:  { type: 'NodeSocketGeometry', is_port: true },
                OUT_GEO_Mesh: { type: 'NodeSocketGeometry', is_port: true }
            },
            inPorts:      ['IN_GEO_Mesh'],
            outPorts:     ['OUT_GEO_Mesh'],
            panelId:      null,
            meta:         { sculpted: false, vertex_count: 0, faces_deleted: 0, last_modified: 0 }
        },
        html: `
            <div class="title-box"><span class="tt">Cancella Topologia</span></div>
            <div class="ibex-node-target-row"><span class="ibex-node-target-label">—</span></div>
            <div class="box">
                <div class="ibex-sculpt-status" data-state="idle">
                    <span class="ibex-sculpt-label">Non ancora modificato</span>
                </div>
                <button class="ibex-sculpt-modify-btn" onclick="(function(btn){
                    const nodeEl = btn.closest('.drawflow-node');
                    if (!nodeEl) return;
                    const nodeId = nodeEl.id.replace('node-','');
                    if (window.ibex && window.ibex.selectionMode) {
                        window.ibex.selectionMode.enter(nodeId);
                    }
                })(this)">Seleziona zone</button>
            </div>
        `,
    },

    topology_rebuild: {
        panelSlug:  'rebuild',
        numInputs:  1,
        numOutputs: 1,
        data: {
            toolId:       'topology_rebuild',
            toolName:     'Ricostruisci Topologia',
            tier:         1,
            destructive:  true,
            params:       {},
            paramsConfig: {
                IN_GEO_Mesh:  { type: 'NodeSocketGeometry', is_port: true },
                OUT_GEO_Mesh: { type: 'NodeSocketGeometry', is_port: true }
            },
            inPorts:      ['IN_GEO_Mesh'],
            outPorts:     ['OUT_GEO_Mesh'],
            panelId:      null,
            meta:         { sculpted: false, vertex_count: 0, n_faces_selected: 0, last_modified: 0 }
        },
        html: `
            <div class="title-box"><span class="tt">Ricostruisci Topologia</span></div>
            <div class="ibex-node-target-row"><span class="ibex-node-target-label">—</span></div>
            <div class="box">
                <div class="ibex-sculpt-status" data-state="idle">
                    <span class="ibex-sculpt-label">Non ancora modificato</span>
                </div>
                <button class="ibex-sculpt-modify-btn" onclick="(function(btn){
                    const nodeEl = btn.closest('.drawflow-node');
                    if (!nodeEl) return;
                    const nodeId = nodeEl.id.replace('node-','');
                    if (window.ibex && window.ibex.selectionMode) {
                        window.ibex.selectionMode.enter(nodeId, 'rebuild');
                    }
                })(this)">Seleziona zona</button>
            </div>
        `,
    },

    draw_curve: {
        panelSlug:  'curve',
        numInputs:  1,
        numOutputs: 1,
        data: {
            toolId:       'draw_curve',
            toolName:     'Disegna Curva',
            tier:         1,
            destructive:  true,
            params:       {},
            paramsConfig: {
                IN_GEO_Mesh:    { type: 'NodeSocketGeometry', is_port: true },
                OUT_CRV_Curve:  { type: 'NodeSocketCurve',    is_port: true }
            },
            inPorts:      ['IN_GEO_Mesh'],
            outPorts:     ['OUT_CRV_Curve'],
            panelId:      null,
            meta: {
                sculpted: false,
                n_splines: 0,
                n_closed: 0,
                splines: [],   // datablock persistito per riapertura editing
                last_modified: 0
            },
            // V2.14 CurveDisplayName (2026-05-14): la curva prodotta è un oggetto
            // indipendente — null = usa il fallback toolName come label outliner.
            // Riempito da StackManager._refreshSculptNodeDOM.
            curveDisplayName: null
        },
        html: `
            <div class="title-box"><span class="tt">Disegna Curva</span></div>
            <div class="ibex-node-target-row"><span class="ibex-node-target-label">—</span></div>
            <div class="box">
                <div class="ibex-sculpt-status" data-state="idle">
                    <span class="ibex-sculpt-label">Nessuna curva disegnata</span>
                </div>
                <button class="ibex-sculpt-modify-btn" onclick="(function(btn){
                    const nodeEl = btn.closest('.drawflow-node');
                    if (!nodeEl) return;
                    const nodeId = nodeEl.id.replace('node-','');
                    if (window.ibex && window.ibex.curveMode) {
                        window.ibex.curveMode.enter(nodeId);
                    }
                })(this)">Disegna</button>
                <div class="ibex-curve-output">
                    <span class="ibex-curve-output-badge">CRV</span>
                    <input class="ibex-curve-output-name-input"
                           type="text"
                           title="Nome curva (modificabile)"
                           placeholder="Curva"
                           spellcheck="false"
                           autocomplete="off" />
                </div>
            </div>
        `,
    },

    arch_detect: {
        panelSlug:  'archdetect',
        numInputs:  1,
        numOutputs: 1,
        data: {
            toolId:       'arch_detect',
            toolName:     'Rileva Arco',
            tier:         1,
            destructive:  true,
            params:       {},
            paramsConfig: {
                IN_GEO_Mesh:    { type: 'NodeSocketGeometry', is_port: true },
                OUT_CRV_Curve:  { type: 'NodeSocketCurve',    is_port: true }
            },
            inPorts:      ['IN_GEO_Mesh'],
            outPorts:     ['OUT_CRV_Curve'],
            panelId:      null,
            meta: {
                detected:      false,
                n_ctrl_points: 0,
                arch_length_mm: 0,
                last_modified: 0
            },
            // V2.14 CurveDisplayName: pattern speculare a draw_curve.
            curveDisplayName: null
        },
        html: `
            <div class="title-box"><span class="tt">Rileva Arco</span></div>
            <div class="ibex-node-target-row"><span class="ibex-node-target-label">—</span></div>
            <div class="box">
                <div class="ibex-sculpt-status" data-state="idle">
                    <span class="ibex-sculpt-label">Calcolo automatico al bake</span>
                </div>
                <div class="ibex-curve-output">
                    <span class="ibex-curve-output-badge">CRV</span>
                    <input class="ibex-curve-output-name-input"
                           type="text"
                           title="Nome curva (modificabile)"
                           placeholder="Arco"
                           spellcheck="false"
                           autocomplete="off" />
                </div>
            </div>
        `,
    },

    curve_edit: {
        panelSlug:  'curveedit',
        numInputs:  2,
        numOutputs: 1,
        data: {
            toolId:       'curve_edit',
            toolName:     'Modifica Curva',
            tier:         1,
            destructive:  true,
            params:       {},
            // V5.17 (2026-05-14): CRV in input_1 (sopra), GEO in input_2 (sotto).
            // L'ordine in paramsConfig + inPorts determina visualmente top-to-bottom
            // in Drawflow + il mapping input_N -> inPorts[N-1] in extractDAG.
            paramsConfig: {
                IN_CRV_Curve:   { type: 'NodeSocketCurve',    is_port: true },
                IN_GEO_Mesh:    { type: 'NodeSocketGeometry', is_port: true },
                OUT_CRV_Curve:  { type: 'NodeSocketCurve',    is_port: true }
            },
            inPorts:      ['IN_CRV_Curve', 'IN_GEO_Mesh'],
            outPorts:     ['OUT_CRV_Curve'],
            panelId:      null,
            meta: {
                sculpted:      false,
                n_splines:     0,
                n_closed:      0,
                n_ctrl_points: 0,
                last_modified: 0
            }
            // V5.18: curve_edit NON ha curveDisplayName — il nome eredita
            // dal producer upstream (arch_detect / draw_curve).
        },
        html: `
            <div class="title-box"><span class="tt">Modifica Curva</span></div>
            <div class="ibex-node-target-row"><span class="ibex-node-target-label">—</span></div>
            <div class="box">
                <div class="ibex-sculpt-status" data-state="idle">
                    <span class="ibex-sculpt-label">Curva passthrough — non modificata</span>
                </div>
                <button class="ibex-sculpt-modify-btn" onclick="(function(btn){
                    const nodeEl = btn.closest('.drawflow-node');
                    if (!nodeEl) return;
                    const nodeId = nodeEl.id.replace('node-','');
                    if (window.ibex && window.ibex.curveEditMode) {
                        window.ibex.curveEditMode.enter(nodeId);
                    }
                })(this)">Modifica</button>
            </div>
        `,
    },

    split_topology: {
        panelSlug:  'split',
        numInputs:  2,
        numOutputs: 2,
        data: {
            toolId:       'split_topology',
            toolName:     'Separa Topologia',
            tier:         1,
            destructive:  true,
            params:       {},
            // DrawCurve V1.0 (2026-05-06): il nodo split ha 2 input — IN_GEO_Mesh
            // (mesh da tagliare) + IN_CRV_Curve (opzionale, datablock curva per
            // cut geodetico dual-mode). Senza curva collegata resta in brush mode.
            paramsConfig: {
                IN_GEO_Mesh:  { type: 'NodeSocketGeometry', is_port: true },
                IN_CRV_Curve: { type: 'NodeSocketCurve',    is_port: true },
                OUT_GEO_A:    { type: 'NodeSocketGeometry', is_port: true },
                OUT_GEO_B:    { type: 'NodeSocketGeometry', is_port: true }
            },
            inPorts:      ['IN_GEO_Mesh', 'IN_CRV_Curve'],
            outPorts:     ['OUT_GEO_A', 'OUT_GEO_B'],
            panelId:      null,
            meta:         { sculpted: false, faces_a: 0, faces_b: 0, last_modified: 0 },
            // Nomi custom utente dei branch: null = usa il filename derivato
            // come fallback; nome libero = override (Inv. 115).
            branchDisplayNames: { A: null, B: null }
        },
        html: `
            <div class="title-box"><span class="tt">Separa Topologia</span></div>
            <div class="ibex-node-target-row"><span class="ibex-node-target-label">—</span></div>
            <div class="box">
                <div class="ibex-sculpt-status" data-state="idle">
                    <span class="ibex-sculpt-label">Non ancora modificato</span>
                </div>
                <button class="ibex-sculpt-modify-btn" onclick="(function(btn){
                    const nodeEl = btn.closest('.drawflow-node');
                    if (!nodeEl) return;
                    const nodeId = nodeEl.id.replace('node-','');
                    if (window.ibex && window.ibex.selectionMode) {
                        window.ibex.selectionMode.enter(nodeId, 'split');
                    }
                })(this)">Seleziona zone</button>
                <div class="ibex-split-outputs">
                    <div class="ibex-split-out" data-branch="A">
                        <span class="ibex-split-out-badge">A</span>
                        <input class="ibex-split-out-name-input" data-branch="A"
                               type="text"
                               title="Nome branch A (modificabile)"
                               placeholder="—"
                               spellcheck="false"
                               autocomplete="off"
                               disabled />
                    </div>
                    <div class="ibex-split-out" data-branch="B">
                        <span class="ibex-split-out-badge">B</span>
                        <input class="ibex-split-out-name-input" data-branch="B"
                               type="text"
                               title="Nome branch B (modificabile)"
                               placeholder="—"
                               spellcheck="false"
                               autocomplete="off"
                               disabled />
                    </div>
                </div>
            </div>
        `,
    },

    burn: {
        panelSlug:  'export',
        numInputs:  1,
        numOutputs: 0,
        data: {
            toolId:       'burn',
            toolName:     'Burn',
            tier:         1,
            no_backend:   true,
            destructive:  false,
            params: {
                directory_path:    '',
                filename_override: ''
            },
            paramsConfig: {
                IN_GEO_Mesh: { type: 'NodeSocketGeometry', is_port: true }
            },
            inPorts:      ['IN_GEO_Mesh'],
            outPorts:     [],
            panelId:      null,
            meta:         { last_export_at: 0, last_export_path: '' }
        },
        html: `
            <div class="title-box"><span class="tt">Burn</span></div>
            <div class="box">
                <div class="ibex-export-row">
                    <label class="ibex-export-label">Cartella</label>
                    <button class="ibex-export-dir-btn" onclick="(function(btn){
                        const nodeEl = btn.closest('.drawflow-node');
                        if (!nodeEl) return;
                        const nodeId = nodeEl.id.replace('node-','');
                        if (window.ibex && window.ibex.exportPicker) {
                            window.ibex.exportPicker.openDirPicker(nodeId);
                        }
                    })(this)">— Scegli cartella —</button>
                </div>
                <div class="ibex-export-row">
                    <label class="ibex-export-label">Nome file</label>
                    <input class="ibex-export-filename" type="text" placeholder="auto"
                           data-key="filename_override"
                           onchange="(function(inp){
                               const nodeEl = inp.closest('.drawflow-node');
                               if (!nodeEl) return;
                               const nodeId = nodeEl.id.replace('node-','');
                               if (window.ibex?.stackMgr?.setNodeParam) {
                                   window.ibex.stackMgr.setNodeParam(nodeId, 'filename_override', inp.value, { sourceEl: inp });
                               }
                           })(this)" />
                </div>
                <div class="ibex-export-row">
                    <label class="ibex-export-label">Formato</label>
                    <select class="ibex-export-format" data-key="format_override"
                            title="OBJ e PLY sono formati di consegna: IBEX non li reimporta."
                            style="width:100%; padding:5px 8px; background:var(--ibex-surface); color:var(--ibex-text); border:1px solid var(--ibex-border); border-radius:3px; font-size:10px; font-family:'Ubuntu Mono', monospace; box-sizing:border-box; cursor:pointer;"
                            onchange="(function(sel){
                                const nodeEl = sel.closest('.drawflow-node');
                                if (!nodeEl) return;
                                const nodeId = nodeEl.id.replace('node-','');
                                if (window.ibex?.stackMgr?.setNodeParam) {
                                    window.ibex.stackMgr.setNodeParam(nodeId, 'format_override', sel.value, { sourceEl: sel });
                                }
                            })(this)">
                        <option value="stl">STL</option>
                        <option value="obj">OBJ</option>
                        <option value="ply">PLY</option>
                    </select>
                </div>
                <button class="ibex-export-btn" onclick="(function(btn){
                    const nodeEl = btn.closest('.drawflow-node');
                    if (!nodeEl) return;
                    const nodeId = nodeEl.id.replace('node-','');
                    if (window.ibex && window.ibex.exportPicker) {
                        window.ibex.exportPicker.execute(nodeId);
                    }
                })(this)">Burn</button>
                <div class="ibex-export-status" data-state="idle">nessun burn</div>
            </div>
        `,
    },

};
