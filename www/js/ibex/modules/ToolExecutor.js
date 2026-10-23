import * as THREE from 'three';

// ═══════════════════════════════════════════════════════════════
// IBEX ToolExecutor SnapshotKeyed_S3_V17.2 (2026-04-25)
//
// V17.2 (SnapshotKeyed Session 3):
//   - `resolveBaseMesh` esteso per detectare nodi `split_topology` upstream.
//     Quando un tool downstream ha un edge `tool_output_{splitId}` con
//     `from_port` = 'OUT_GEO_A' o 'OUT_GEO_B', il target risolto NON è il
//     master (es. "Upper.stl") ma `{stem}_snap_{splitId}_{A|B}.stl`. I
//     nodi a valle dei branch A/B vedono come input la mesh split (non il
//     master originale). Invariante S3-NA4.
//
// V17.1 (SnapshotKeyed Session 1):
//   - flattenGraphForBackend ora inietta `_snapshot_node_id: nodeId` nei
//     params di ogni step il cui graph node ha `destructive === true`.
//     Il worker `_apply_snapshot` legge `params.get('_snapshot_node_id')`
//     per risolvere `{stem}_snap_{nodeId}.stl`. Invariante S1-A1/A2.
//
// V17.0 (NonDestructive_S1) — Bite-Safe (Pivot-Based Rotation)
//
// Contratto architetturale V13.0:
//   - INIT_PROJECT NON centra le mesh a (0,0,0). I vertici restano
//     nelle coordinate dello scanner per preservare il Bite.
//   - Ogni mesh ha userData.pivot = BBox center (da manifest o geometry).
//   - La rotazione avviene attorno al pivot con la formula:
//     M_local = T_pivot × M_user × T_neg_pivot
//   - Blender riceve la stessa matrice (row-major, nessun transpose).
//
// computeWorld:
//   Nodo radice:  worldMat = T_pivot × buildMatrixFromSRT(curSRT) × T_neg_pivot
//   Nodo figlio:  worldMat = parentWorldMat × childLocalMat
//
// mesh_state persistence:
//   - pivot e bakedMatrix vengono salvati in session_settings.mesh_state
//   - Al reload, il frontend li ripristina senza ricalcolarli
// ═══════════════════════════════════════════════════════════════

export class ToolExecutor {
    constructor(sceneManager) {
        this.sceneMgr = sceneManager;
        // V13.0: Stato persistente delle mesh (pivot + bakedMatrix)
        // Questo viene salvato in session_settings e ripristinato al reload.
        this.meshState = {};
    }

    resetScene() {
        if (!this.sceneMgr || !this.sceneMgr.group) return;
        this.sceneMgr.group.children.forEach(obj => {
            if (obj.isMesh && obj.name && !obj.isGridHelper) {
                obj.matrix.identity();
                obj.matrixAutoUpdate = false;
                obj.visible = true;
            }
        });
    }

    /**
     * Restituisce il pivot per una mesh. Priorità:
     * 1. meshState persistito (sopravvive ai reload)
     * 2. userData.pivot dalla geometry (calcolato da MeshLoader)
     * 3. Zero vector (fallback sicuro)
     */
    getPivot(meshName) {
        // 1. Stato persistito
        if (this.meshState[meshName] && this.meshState[meshName].pivot) {
            const p = this.meshState[meshName].pivot;
            return new THREE.Vector3(p[0], p[1], p[2]);
        }
        // 2. userData (dalla MeshLoader)
        const obj = this.findTargetMesh(meshName);
        if (obj && obj.userData && obj.userData.pivot) {
            // Salva nello state per persistenza
            const p = obj.userData.pivot;
            if (!this.meshState[meshName]) this.meshState[meshName] = {};
            this.meshState[meshName].pivot = [p.x, p.y, p.z];
            return p.clone();
        }
        // 3. Fallback
        return new THREE.Vector3();
    }

    /**
     * Costruisce la matrice locale con compensazione pivot.
     * M_local = T_pivot × M_user × T_neg_pivot
     * Questo fa sì che la rotazione avvenga attorno al centro geometrico
     * dell'oggetto anziché attorno all'origine world (0,0,0).
     */
    buildPivotedMatrix(srt, pivot) {
        const M_user = this.buildMatrixFromSRT(srt);
        if (!pivot || (pivot.x === 0 && pivot.y === 0 && pivot.z === 0)) {
            return M_user;
        }
        const Tp = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
        const Tnp = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
        // M_local = Tp × M_user × Tnp
        return new THREE.Matrix4().copy(Tp).multiply(M_user).multiply(Tnp);
    }

    topologicalSort(graph) {
        const nodes = graph.nodes.filter(n => n.type === 'tool');
        const idSet = new Set(nodes.map(n => String(n.id)));
        const inDeg = {}, adj = {};
        nodes.forEach(n => { const id = String(n.id); inDeg[id] = 0; adj[id] = []; });

        graph.edges.forEach(edge => {
            if (edge.from_mesh && edge.from_mesh.startsWith('tool_output_')) {
                const from = edge.from_mesh.replace('tool_output_', '');
                const to = String(edge.to_node);
                if (idSet.has(from) && idSet.has(to) && from !== to) {
                    adj[from].push(to);
                    inDeg[to]++;
                }
            }
        });

        const queue = Object.keys(inDeg).filter(id => inDeg[id] === 0);
        const sorted = [];
        while (queue.length > 0) {
            const id = queue.shift();
            const node = nodes.find(n => String(n.id) === id);
            if (node) sorted.push(node);
            (adj[id] || []).forEach(d => { inDeg[d]--; if (inDeg[d] === 0) queue.push(d); });
        }
        nodes.forEach(n => { if (!sorted.find(s => String(s.id) === String(n.id))) sorted.push(n); });
        return sorted;
    }

    extractSRT(paramsConfig, paramsData) {
        const srt = { tx:0, ty:0, tz:0, rx:0, ry:0, rz:0, sx:1, sy:1, sz:1 };
        if (!paramsConfig || !paramsData) return srt;

        for (const [key, config] of Object.entries(paramsConfig)) {
            if (key.startsWith('H_') || key.startsWith('IN_') || key.startsWith('OUT_')) continue;

            const label = (config.label || '').replace(/_LINK$/i, '');
            const group = (config.group || '').replace(/_LINK$/i, '');
            const rawVal = paramsData[key];
            if (rawVal === undefined || rawVal === null) continue;

            const isP = group.endsWith('_POS') || label.endsWith('_POS');
            const isR = group.endsWith('_ROT') || label.endsWith('_ROT');
            const isS = group.endsWith('_SCL') || label.endsWith('_SCL');

            if (Array.isArray(rawVal)) {
                if (isP) { srt.tx = rawVal[0]; srt.ty = rawVal[1]; srt.tz = rawVal[2]; }
                else if (isR) { srt.rx = rawVal[0]; srt.ry = rawVal[1]; srt.rz = rawVal[2]; }
                else if (isS) { srt.sx = rawVal[0]; srt.sy = rawVal[1]; srt.sz = rawVal[2]; }
                continue;
            }

            const val = parseFloat(rawVal);
            if (isNaN(val)) continue;

            if (isP) { if (label==='X') srt.tx=val; else if (label==='Y') srt.ty=val; else if (label==='Z') srt.tz=val; }
            else if (isR) { if (label==='X') srt.rx=val; else if (label==='Y') srt.ry=val; else if (label==='Z') srt.rz=val; }
            else if (isS) { if (label==='X') srt.sx=val; else if (label==='Y') srt.sy=val; else if (label==='Z') srt.sz=val; else { srt.sx=srt.sy=srt.sz=val; } }
        }
        return srt;
    }

    buildMatrixFromSRT(srt) {
        const T = new THREE.Matrix4().makeTranslation(srt.tx, srt.ty, srt.tz);
        const RX = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(srt.rx));
        const RY = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(srt.ry));
        const RZ = new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(srt.rz));
        const S = new THREE.Matrix4().makeScale(srt.sx, srt.sy, srt.sz);

        // Intrinsic ZYX = extrinsic XYZ (world-space):
        // ogni slider ruota sempre attorno al proprio asse mondo fisso.
        // M × p = T × (RZ × (RY × (RX × (S × p))))
        return new THREE.Matrix4()
            .premultiply(S)
            .premultiply(RX)
            .premultiply(RY)
            .premultiply(RZ)
            .premultiply(T);
    }

    // ═══════════════════════════════════════════════════════════
    // applyGraph — Bite-Safe (Pivot-Based)
    //
    // V13.0: La rotazione avviene attorno al BBox center (pivot),
    // non attorno all'origine. I vertici scanner non vengono mai spostati.
    //
    // M_local = T_pivot × M_user × T_neg_pivot
    //
    // Delta correction post-bake:
    //   - bakedMat set:          applyMat = worldMat × bakedMat_inv
    //   - parentingBaked:        applyMat = worldMat × parent.bakedMat_inv
    //   - altrimenti:            applyMat = worldMat
    // ═══════════════════════════════════════════════════════════
    applyGraph(graph, isPostBake = false) {
        this.resetScene();

        const sorted = this.topologicalSort(graph);

        const state = {};
        this.sceneMgr.group.children.forEach(obj => {
            if (obj.isMesh && obj.name && !obj.isGridHelper) {
                state[obj.name] = {
                    worldMat: new THREE.Matrix4(), // M_current assoluta (per parenting)
                    tier: 2,                       // 1=FAST (usa appliedMatFlat), 2=GN/PY (usa bakedMat)
                    bakedMat: null,                // M_baked se preview_baked_params ha SRT (solo Tier 2)
                    computed: false,
                    parent: null,
                    parentingBaked: false          // true solo per Tier 2 con parenting baked
                };
            }
        });

        // Passata 1: calcola M_current con pivot-compensation e identifica parentela
        sorted.forEach(tool => {
            const allEdges = graph.edges.filter(e => String(e.to_node) === String(tool.id));
            if (!allEdges.length) return;

            const targetEdge = this._findTargetEdge(allEdges);
            const targetName = this.resolveBaseMesh(targetEdge.from_mesh, graph, targetEdge.from_port);
            if (!state[targetName]) return;

            this.applyNonSpatial({ targets: [targetName], paramsConfig: tool.paramsConfig, params: tool.params });

            // V2.4.3 (2026-05-13) curve_transform fix: il nodo `curve_transform`
            // HA widget POS/ROT/SCL ma la trasformazione opera sulla CURVA
            // (datablock .crv.json), NON sulla mesh in scena. La world_matrix
            // viene comunque calcolata da computeToolWorld → mandata al worker
            // via flattenGraphForBackend per applicarla ai punti della curva.
            // Ma `applyGraph` (rendering Three.js della mesh) DEVE skippare
            // questo tool, altrimenti la mesh in scena si muove erroneamente
            // mentre la curva resta ferma (la curva viene aggiornata solo dopo
            // il bake worker, via _apply_curve_transform).
            //
            // Pattern speculare: arch_detect / draw_curve / curve_edit operano
            // anch'essi su curve ma NON hanno widget SRT → extractSRT identity
            // → no problema. curve_transform è l'unico caso con widget SRT che
            // NON deve toccare la mesh.
            const curSRT = this.extractSRT(tool.paramsConfig, tool.params);
            const pivot = this.getPivot(targetName);

            // V13.0: M_local = T_pivot × M_user × T_neg_pivot
            const M_current = this.buildPivotedMatrix(curSRT, pivot);

            // worldMat = M_current assoluta (non delta — serve a Passata 2 per il parenting)
            state[targetName].worldMat.multiply(M_current);
            state[targetName].tier = tool.tier || 2;

            // bakedMat: solo per Tier 2, e solo se preview_baked_params ha effettivi dati SRT.
            // Tier 1 usa appliedMatFlat (da userData) — non ha bisogno di bakedMat.
            if ((tool.tier || 2) === 2 && tool.preview_baked_params && Object.keys(tool.preview_baked_params).length > 0) {
                const bakedSRT = this.extractSRT(tool.paramsConfig, tool.preview_baked_params);
                state[targetName].bakedMat = this.buildPivotedMatrix(bakedSRT, pivot);
            }

            // Parentela via IN_MTX_ — il parent link serve sempre (Tier 1 e 2) per computeWorld.
            // parentingBaked è solo per Tier 2: indica che i vertici sono in WS del parent.
            const parentEdge = allEdges.find(e => e.role && e.role.startsWith('IN_MTX_'));
            if (parentEdge) {
                state[targetName].parent = this.resolveBaseMesh(parentEdge.from_mesh, graph, parentEdge.from_port);
                // Bug #8 fix: parentingBaked = true solo se preview_baked_params ha dati reali
                // (non {}) E solo per Tier 2. Tier 1 usa appliedMatFlat per la delta correction.
                if ((tool.tier || 2) === 2) {
                    state[targetName].parentingBaked = (tool.preview_baked_params !== null && Object.keys(tool.preview_baked_params).length > 0);
                }
            }
        });

        // Passata 2: risoluzione ricorsiva gerarchia con worldMat assolute
        const computeWorld = (name) => {
            const s = state[name];
            if (!s || s.computed) return s ? s.worldMat : new THREE.Matrix4();

            // FIX V12.2: Mark computed BEFORE recursing to prevent infinite loops
            // (guards against circular parent references or self-references)
            s.computed = true;

            if (s.parent && s.parent !== name && state[s.parent]) {
                const pWorld = computeWorld(s.parent);
                const childLocal = s.worldMat.clone();
                // worldMat figlio = M_parent_assoluta × M_child_local
                s.worldMat.multiplyMatrices(pWorld, childLocal);
            }

            return s.worldMat;
        };

        Object.keys(state).forEach(computeWorld);

        // Applica matrici a Three.js con delta correction al render time
        Object.entries(state).forEach(([name, s]) => {
            const obj = this.findTargetMesh(name);
            if (!obj) return;

            const parentState = s.parent ? state[s.parent] : null;
            let applyMat;

            // V16.3: Delta correction basato sullo STATO FISICO dei vertici,
            // non sul tier del tool. Priorità:
            //   1. appliedMatFlat (Tier 1 bake già avvenuto, vertici in WS)
            //   2. bakedMat (Tier 2 spaziale baked sul proprio tool)
            //   3. parentingBaked + parent.bakedMat (Tier 2 parenting legacy)
            //   4. Fallback: vertici in coord scanner (applyMat = worldMat)
            //
            // Il punto critico (Fix bug delta_sculpting post-parenting): se una catena
            // Tier 1 → Tier 2 (es. fast_parenting + delta_sculpting sullo stesso
            // mesh) ha vertici in WS da hotswap Tier 1, il delta correction DEVE
            // usare appliedMatFlat anche se l'ultimo tool è Tier 2 non-baked.
            // Precedentemente `s.tier` veniva sovrascritto ad ogni tool nel loop
            // di Pass 1 → quando delta_sculpting (tier 2) si aggiungeva dopo
            // fast_parenting (tier 1), il branch tier 1 non veniva mai preso,
            // finendo nel branch else finale con `applyMat = worldMat` applicato a
            // vertici WS → doppia trasformazione → mesh fuori posto.
            const flatArr = obj?.userData?.appliedMatFlat;
            if (flatArr && flatArr.length === 16) {
                // Vertici in WS post-hotswap Tier 1.
                // appliedMatFlat = worldMat.transpose().elements (row-major).
                // fromArray + transpose ricostruisce la THREE.Matrix4 column-major.
                const appliedMat = new THREE.Matrix4().fromArray(flatArr).transpose();
                applyMat = s.worldMat.clone().multiply(appliedMat.invert());
            } else if (s.bakedMat) {
                // Tier 2: vertici in World Space (baked dal proprio tool spaziale).
                applyMat = s.worldMat.clone().multiply(s.bakedMat.clone().invert());
            } else if (s.parentingBaked && parentState && parentState.bakedMat) {
                // Tier 2 parenting legacy (gn_parenting): vertici in WS del parent.
                applyMat = s.worldMat.clone().multiply(parentState.bakedMat.clone().invert());
            } else {
                // Vertici nelle coordinate scanner (nessun bake ancora).
                applyMat = s.worldMat.clone();
            }

            obj.matrix.copy(applyMat);
            obj.matrixAutoUpdate = false;
            obj.updateMatrixWorld(true);

            // DIAG V13.0: Log arricchito con pivot info
            if (isPostBake && obj.geometry) {
                obj.geometry.computeBoundingBox();
                const c = new THREE.Vector3();
                obj.geometry.boundingBox.getCenter(c);
                const pv = this.getPivot(name);
                console.log(`[PIVOT-DIAG] ${name}: bbox=(${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}) pivot=(${pv.x.toFixed(3)},${pv.y.toFixed(3)},${pv.z.toFixed(3)}) bakedMat=${s.bakedMat?'SET':'null'} parentingBaked=${s.parentingBaked} parent=${s.parent||'none'}`);
            }
        });

        if (this.sceneMgr) this.sceneMgr.render();
    }

    // ═══════════════════════════════════════════════════════════
    // Target identification — edge SENZA prefisso IN_ è il bersaglio
    // ═══════════════════════════════════════════════════════════
    _findTargetEdge(allEdges) {
        let targetEdge = allEdges.find(e => !e.role || !e.role.startsWith('IN_'));
        if (!targetEdge) targetEdge = allEdges.find(e => e.role && e.role.startsWith('IN_GEO_'));
        if (!targetEdge) targetEdge = allEdges[0];
        return targetEdge;
    }

    /**
     * Risale la catena di edge per trovare il target della mesh prodotta dal
     * nodo `id` (nel formato "tool_output_{nodeId}" o nome mesh base).
     *
     * S3 (2026-04-25): supporto nodi split_topology. Se l'edge chiamante ha
     * `from_port = 'OUT_GEO_A'` (o `_B`) e il nodo sorgente è uno split, il
     * target ritornato è `{stem}_snap_{splitId}_{A|B}.stl` invece del master.
     *
     * @param {string} id         — 'tool_output_X' oppure nome mesh base
     * @param {Object} graph      — grafo completo (nodes + edges)
     * @param {string|null} fromPort — nome socket di output del nodo `id`
     *                                 (es. 'OUT_GEO_A'). Null se non
     *                                 rilevante (mesh node / single-output).
     * @returns {string} Nome target (es. 'Upper.stl' o 'Upper_snap_5_A.stl')
     */
    resolveBaseMesh(id, graph, fromPort = null) {
        // Id non-tool_output: è già un nome mesh base, ritorna così com'è.
        if (!String(id).startsWith('tool_output_')) return id;

        const nodeId = id.replace('tool_output_', '');
        const thisNode = graph.nodes?.find(n => String(n.id) === nodeId);

        // S3: se il nodo corrente è split_topology + fromPort specifica un branch,
        // il target è {stem_master}_snap_{nodeId}_{A|B}.stl.
        if (thisNode?.toolId === 'split_topology' && fromPort) {
            const branch = (fromPort.endsWith('_A') ? 'A'
                         :  fromPort.endsWith('_B') ? 'B' : null);
            if (branch) {
                // Risali alla mesh base dell'input del split per ottenere lo stem.
                // L'input del split è IN_GEO_Mesh con 1 solo edge entrante.
                const inEdges = graph.edges.filter(e => String(e.to_node) === nodeId);
                const inEdge = inEdges.find(e => e.role === 'IN_GEO_Mesh')
                            || inEdges.find(e => !e.role || e.role === 'target')
                            || inEdges[0];
                if (inEdge) {
                    // Ricorsione con chain.from_port: se ci sono split nested
                    // (rari ma supportati), vengono risolti coerentemente.
                    const baseMesh = this.resolveBaseMesh(inEdge.from_mesh, graph, inEdge.from_port);
                    const stem = baseMesh.replace(/\.stl$/i, '');
                    return `${stem}_snap_${nodeId}_${branch}.stl`;
                }
            }
        }

        // Flow standard: risale la catena finché non trova un edge con
        // from_mesh non-tool_output_* (= mesh base / mesh node). Propaga il
        // from_port del ramo corrente per detectare eventuali split multi-livello.
        const direct = graph.edges.find(e => String(e.to_node) === nodeId && !e.from_mesh.startsWith('tool_output_'));
        if (direct) return direct.from_mesh;
        const chain = graph.edges.find(e => String(e.to_node) === nodeId && e.from_mesh.startsWith('tool_output_'));
        return chain ? this.resolveBaseMesh(chain.from_mesh, graph, chain.from_port) : id;
    }

    findTargetMesh(name) {
        if (!this.sceneMgr || !this.sceneMgr.group) return null;
        const clean = name.toLowerCase().replace(/\.(stl|obj|ply)$/, '').trim();
        for (const obj of this.sceneMgr.group.children) {
            if (obj.isMesh && obj.name) {
                if (obj.name.toLowerCase().replace(/\.(stl|obj|ply)$/, '').trim() === clean) return obj;
            }
        }
        return null;
    }

    applyNonSpatial(item) {
        if (!item.targets || !item.paramsConfig) return;
        for (const [key, config] of Object.entries(item.paramsConfig)) {
            const l = (config.label || '').replace(/_LINK$/i, '');
            const g = (config.group || '').replace(/_LINK$/i, '');
            if (l.endsWith('_COL') || g.endsWith('_COL')) {
                const hex = item.params[key];
                if (hex) item.targets.forEach(n => { const o = this.findTargetMesh(n); if (o && o.material && o.material.color) o.material.color.set(hex); });
            }
            if (l.endsWith('_VIS') || g.endsWith('_VIS')) {
                const v = item.params[key];
                item.targets.forEach(n => { const o = this.findTargetMesh(n); if (o) o.visible = (v === true || v === 'true'); });
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Serializzazione / Deserializzazione meshState
    // Usato da IbexCore per persistere in session_settings
    // ═══════════════════════════════════════════════════════════
    exportMeshState() {
        return JSON.parse(JSON.stringify(this.meshState));
    }

    importMeshState(state) {
        if (state && typeof state === 'object') {
            this.meshState = JSON.parse(JSON.stringify(state));
            console.log(`[ToolExecutor] meshState importato: ${Object.keys(this.meshState).length} mesh`);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // flattenGraphForBackend — Pivot-Based (V13.0)
    //
    // La matrice inviata a Blender è già in row-major.
    // Blender la legge direttamente senza transpose.
    // ═══════════════════════════════════════════════════════════
    flattenGraphForBackend(graph) {
        const sorted = this.topologicalSort(graph);
        const queue = [];

        // Accumulate world matrix with pivot compensation.
        // Mirrors buildPivotedMatrix() + computeWorld() in applyGraph().
        const computeToolWorld = (nodeId, visited = new Set()) => {
            if (visited.has(nodeId)) return new THREE.Matrix4(); // cycle guard
            visited.add(nodeId);

            const node = graph.nodes.find(n => String(n.id) === nodeId);
            if (!node) return new THREE.Matrix4();

            const srt = this.extractSRT(node.paramsConfig || {}, node.params || {});

            // Trova il target mesh di questo nodo per ottenerne il pivot
            const nodeEdges = graph.edges.filter(e => String(e.to_node) === nodeId);
            const targetEdge = this._findTargetEdge(nodeEdges);
            const targetName = targetEdge ? this.resolveBaseMesh(targetEdge.from_mesh, graph, targetEdge.from_port) : null;
            const pivot = targetName ? this.getPivot(targetName) : new THREE.Vector3();

            const localMat = this.buildPivotedMatrix(srt, pivot);

            const parentEdge = nodeEdges.find(e => e.role && e.role.startsWith('IN_MTX_'));
            if (parentEdge) {
                const parentNodeId = parentEdge.from_mesh.replace('tool_output_', '');
                const parentWorld = computeToolWorld(parentNodeId, visited);
                return new THREE.Matrix4().multiplyMatrices(parentWorld, localMat);
            }

            return localMat;
        };

        sorted.forEach(node => {
            const nodeId = String(node.id);
            const paramsConfig = node.paramsConfig || {};
            const params = node.params || {};
            const toolId = node.toolId || "";

            // ExportNodeSTL (2026-05-03): nodi `no_backend` (es. export_stl) sono
            // azioni I/O esplicite triggate dall'utente, NON parte della pipeline
            // di bake. Escludi dalla queue inviata al worker per evitare:
            //   - dispatch error "tool non Tier 1" (export_stl non è in TIER1_TOOLS)
            //   - un burn (consegna del file) eseguito ad ogni preview/fast bake
            if (node.noBackend === true) return;

            const allEdges = graph.edges.filter(e => String(e.to_node) === nodeId);
            if (!allEdges.length) return;

            const targetEdge = this._findTargetEdge(allEdges);
            const targetName = this.resolveBaseMesh(targetEdge.from_mesh, graph, targetEdge.from_port);

            const step = {
                _nodeId: nodeId,
                tool: toolId,
                target: targetName,
                tier: node.tier || 2,
                params: { ...params }
            };

            // SnapshotKeyed S1 (2026-04-23): per i nodi destructive (sculpt, futuri
            // delete_topology/split_topology), inietta `_snapshot_node_id` nei
            // params. Il worker lo legge per risolvere `{stem}_snap_{nodeId}.stl`.
            // Propagato via `node.destructive` (StackManager.extractDAG legge da
            // `node.data.destructive`, popolato da NodeBuilder leggendo il campo
            // `destructive: true` di gn_meta.json). Invariante S1-A1/A2.
            if (node.destructive === true) {
                step.params._snapshot_node_id = nodeId;
            }

            // NodeMute (2026-05-05): inietta `_muted` nei params se il nodo
            // è in stato bypass. Il worker `apply_tier1_queue` legge il flag
            // e fa passthrough invece del compute (skip cache lookup/save +
            // skip dispatch tool). Pattern Houdini bypass / Blender mute /
            // ComfyUI bypass. Persiste in `node.data.muted` (propagato da
            // StackManager.extractDAG come `node.muted`).
            if (node.muted === true) {
                step.params._muted = true;
            }

            // Iniezione cavi — skip targetEdge
            allEdges.filter(e => e !== targetEdge).forEach(edge => {
                if (edge.role.startsWith('IN_GEO_')) {
                    step.params[edge.role] = this.resolveBaseMesh(edge.from_mesh, graph, edge.from_port);
                }
                // draw_curve V1.0 (2026-05-06): cavo `IN_CRV_*` collegato.
                // Risolvo il nome del file `.crv.json` del nodo draw_curve
                // sorgente (filename relativo, il worker concatena active_path).
                // Filename pattern: `{stem_della_mesh_upstream_del_drawcurve}_snap_{drawCurveNodeId}.crv.json`.
                else if (edge.role.startsWith('IN_CRV_')) {
                    const drawCurveNodeId = String(edge.from_mesh).replace(/^tool_output_/, '');
                    // Trova la mesh che il draw_curve aveva come input
                    // (segue il suo IN_GEO_Mesh upstream).
                    const drawCurveMeshEdge = graph.edges.find(e2 =>
                        String(e2.to_node) === drawCurveNodeId && e2.role === 'IN_GEO_Mesh'
                    );
                    if (drawCurveMeshEdge) {
                        const upstreamMeshName = this.resolveBaseMesh(
                            drawCurveMeshEdge.from_mesh, graph, drawCurveMeshEdge.from_port
                        );
                        if (upstreamMeshName) {
                            const stem = String(upstreamMeshName).replace(/\.stl$/i, '');
                            // Filename relativo — il worker concatena active_path.
                            // Per gli stem con spazi (filename sanitizzato lato server),
                            // restano spazi qui. Pattern esistente IBEX.
                            step.params._curve_input_file_rel = `${stem}_snap_${drawCurveNodeId}.crv.json`;
                            step.params[edge.role] = step.params._curve_input_file_rel;
                        }
                    }
                }
                else if (edge.role.startsWith('IN_MTX_')) {
                    const sourceNodeId = edge.from_mesh.replace('tool_output_', '');
                    const worldMat = computeToolWorld(sourceNodeId);

                    // V13.1 Fix GN_Parenting Mismatch:
                    // In Blender, IN_MTX è applicata ai vertici LOCALI del child (Orig - Pivot_child)
                    // e poi Blender somma la Location del child (Pivot_child) per portarlo in World.
                    // Quindi Blender fa: World = Pivot_child + IN_MTX * (Orig - Pivot_child)
                    // Ma Three.js usa la matrice worldMat direttamente: World = worldMat * Orig
                    // 
                    // Per farli combaciare, dobbiamo creare una matrice M_GN (IN_MTX) tale che:
                    // Pivot_child + M_GN * (Orig - Pivot_child) = worldMat * Orig
                    // La matematica dimostra che M_GN = worldMat MA con l'ultima colonna (traslazione) 
                    // modificata a: T_GN = worldMat * Pivot_child - Pivot_child
                    
                    const pb = targetName ? this.getPivot(targetName) : new THREE.Vector3();
                    const pb_mapped = pb.clone().applyMatrix4(worldMat);
                    const t_gn = pb_mapped.clone().sub(pb);

                    let M_GN = worldMat.clone();
                    M_GN.setPosition(t_gn); // Sovrascrive SOLO la componente traslazione con T_GN
                    
                    // Converte a row-major per Blender (inversa della column-major di Three)
                    M_GN.transpose();
                    step.params[edge.role] = Array.from(M_GN.elements);
                }
                else if (edge.role.startsWith('IN_VEC_')) {
                    const sourceNodeId = edge.from_mesh.replace('tool_output_', '');
                    const sourceNode = graph.nodes.find(n => String(n.id) === sourceNodeId);
                    if (sourceNode) {
                        const srt = this.extractSRT(sourceNode.paramsConfig || {}, sourceNode.params || {});
                        step.params[edge.role] = [srt.tx, srt.ty, srt.tz];
                    } else {
                        step.params[edge.role] = [0, 0, 0];
                    }
                }
                else {
                    const refName = edge.from_mesh.startsWith('tool_output_')
                        ? this.resolveBaseMesh(edge.from_mesh, graph, edge.from_port) : edge.from_mesh;
                    step.params[edge.role] = refName;
                }
            });

            // Tier 1: inietta world_matrix (row-major) per il worker Trimesh.
            // Il worker usa questa matrice direttamente: mesh.apply_transform(mat).
            // Per fast_transform: è la worldMat del nodo stesso (con pivot compensation).
            // Per fast_parenting: è la worldMat del parent (computeToolWorld sale al parent).
            // Invariante 24: la matrice arriva già completa — il worker NON ricostruisce SRT.
            if ((node.tier || 2) === 1) {
                const worldMat = computeToolWorld(nodeId);
                // Three.js elements è column-major → trasponi per row-major
                step.params.world_matrix = Array.from(worldMat.clone().transpose().elements);
            }

            queue.push(step);
        });

        return queue;
    }
}