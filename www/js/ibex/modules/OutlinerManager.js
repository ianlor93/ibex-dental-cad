// ═══════════════════════════════════════════════════════════════
// IBEX OutlinerManager CollapsibleSections_V14.0
//   - V14.0 (2026-05-14 CollapsibleSections): outliner diviso in 2
//     sezioni collassabili (Mesh + Curve). Ogni sezione ha header con
//     chevron + label + count badge, body collassabile. Stato
//     `collapsed/expanded` persistito in `localStorage` per chiave
//     (`ibex:outliner:meshes-collapsed`, `ibex:outliner:curves-collapsed`).
//     Mesh sez sempre presente, Curve sez con placeholder "Nessuna
//     curva" se vuota.
//   - V13.1 (2026-05-14 CurveDisplayName): la riga curva nell'outliner
//     usa `StackManager.getCurveDisplayName(nodeId)` per il label e
//     supporta dblclick → rinomina inline (`_startCurveRename`).
//     Scrive su `node.data.curveDisplayName` via `setCurveDisplayName`.
//   - V13.0 (2026-05-13 FirstClassOutliner): curve come oggetti di
//     prima classe. Iter `CurveViewer.getOverlayEntries()` → riga blu
//     con eye toggle. Aggiornata da showCurve/hideCurve.
//   - V12.9 (2026-05-02): + visualState.faceOrientation (bool, default false).
//     Re-apply post hot-swap: se true, swap mesh.material a singleton
//     ShaderMaterial via window.ibex.loader.getOrientationMaterial().
//     Salva matcap fresh in mesh.userData._matcapMaterial come riferimento.
//     flatShading scrive sul _matcapMaterial quando Orient ON (lo
//     ShaderMaterial non ha semantica flatShading).
//   - V12.8: VertexNormalsHelper toggle (linee 1D dai centroidi face).
//     Affiancato da V12.9 Face Orientation overlay (tinta uniforme face).
//   - V12.7 (2026-04-25):
//     · `_getDisplayName(meshName)` ora delega a
//       `StackManager.getMeshDisplayName(meshName)` (rimossa duplicazione
//       del lookup nel grafo Drawflow). Fallback locale solo se stackMgr
//       non disponibile (edge case pre-init).
//     · `visualState[name]` aggiunto campo `flatShading: bool`. Inizializzato
//       da `obj.material.flatShading` al primo update; ri-applicato in
//       `update()` se differisce dallo stato corrente del material (con
//       `needsUpdate=true` per recompile shader). Sopravvive ai bake:
//       BakeEngine.hotSwapMeshes ricrea il material via MeshLoader (default
//       `flatShading: true`); il primo update post-swap rilegge il
//       visualState salvato e riapplica il flag corretto.
//   - V12.6 (2026-04-25): `_applyDisplayRename` ridotto a una sola riga
//     che delega al setter centralizzato `StackManager.setMeshDisplayName(
//     meshName, newDisplay)`. Il setter scrive nel grafo, aggiorna i
//     title-box DOM dei nodi DAG, refresha InspectorPanel se aperto.
//     La riga outliner viene aggiornata localmente dal `finalize` di
//     `_startRename` via `nameSpan.innerText` (closure capture, no
//     doppio update). Eliminata la compat `.ibex-lbl` legacy (template
//     attuale usa solo `.title-box` da V5.12).
//   - V12.5 (2026-04-25): cosmetic-safe rename. Doppio click sul nome mesh
//     aggiorna SOLO `node.data.displayName` (label libera UI), MAI
//     `mesh.name` Three.js né `node.data.meshName` (identità immutabile,
//     keyed per file disco / manifest / worker / snapshot).
//     Helper `_getDisplayName(meshName)` cerca il primo nodo mesh
//     con `data.meshName === meshName` e ritorna `data.displayName`
//     (fallback: stem `.stl`-stripped). Nessuna validazione path-unsafe.
//     Persistenza automatica via `editor.export()` →
//     `session_settings.ui_graph` al save_exit.
//   - V12.4 (2026-04-27): click sulla riga outliner oltre a selectMesh
//     chiama anche `inspectorPanel.openForMesh(mesh)` — stesso flusso del
//     click sinistro nel viewport (coerenza UX, richiesta A2).
//   - V12.3: doppio click sul nome mesh → rinomina inline.
//     Validazione: nuovo nome non vuoto, senza caratteri `/ \ .`.
//     Suffisso `.stl` gestito automaticamente (hidden all'utente).
//     Enter/blur salva, Escape annulla. NON persiste in DB (solo in-memory).
//   - V12.2: dragstart con `ibex-type=mesh` + `ibex-mesh=<name>`.
//   - V12.1: dot indicator, click selezione, listener selection-changed.
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';

export class OutlinerManager {
    constructor(sceneManager) {
        this.sceneMgr = sceneManager;
        this.visualState = {};

        // ColorReady L11.2 (2026-07-24): toggle GLOBALE colore scansione (MatCap ↔ colore
        // per-vertice), non per-mesh. Default OFF. Non vive nel visualState (che è per-mesh
        // e per-progetto in session.visuals): è una preferenza di DISPLAY globale sul modello
        // del tema L6 → persistita in localStorage['ibex_ws:color'], applicata via
        // window.ibexApplyColor (scripts.blade.php) che setta questo flag e chiama update().
        this.colorMode = false;

        // Aggiorna la classe .selected quando SceneManager cambia selezione
        // (senza rebuild completo dell'outliner).
        window.addEventListener('ibex:selection-changed', (e) => {
            const selected = e.detail?.meshName || null;
            document.querySelectorAll('.outliner-item').forEach(item => {
                item.classList.toggle('selected', item.dataset.meshName === selected);
            });
        });
    }

    update() {
        let container = document.getElementById('outliner');
        
        if (!container) {
            const panel = document.getElementById('outliner-panel');
            if (panel) {
                container = panel.querySelector('.panel-content');
                if (container) {
                    let wrapper = container.querySelector('.outliner-list-wrapper');
                    if (!wrapper) {
                        wrapper = document.createElement('div');
                        wrapper.className = 'outliner-list-wrapper custom-scroll';
                        wrapper.id = 'outliner-fallback'; 
                        container.appendChild(wrapper);
                    }
                    container = wrapper;
                }
            }
        }

        if (!container) {
            console.warn("⚠️ OutlinerManager: Nessun contenitore trovato.");
            return;
        }

        container.innerHTML = '';
        if (!this.sceneMgr || !this.sceneMgr.group) return;

        const objects = [];
        this.sceneMgr.group.children.forEach(obj => {
            if (obj.isMesh && obj.name && !obj.isGridHelper) {
                objects.push(obj);
            }
        });

        // CollapsibleSections V14.0 (2026-05-14) — outliner diviso in 2
        // sezioni collassabili (Mesh + Curve). Ogni sezione ha header con
        // chevron + label + count, body collassabile, stato persistito in
        // localStorage. Le mesh vengono renderizzate nella sezione "Mesh",
        // le curve (CurveViewer overlays) nella sezione "Curve".
        const curveCount = (() => {
            const cv = window.ibex?.curveViewer;
            if (!cv || typeof cv.getOverlayEntries !== 'function') return 0;
            try { return cv.getOverlayEntries().length || 0; } catch (e) { return 0; }
        })();

        if (objects.length === 0 && curveCount === 0) {
            container.innerHTML = '<div class="outliner-empty outliner-empty--lg">Nessun oggetto nella scena.</div>';
            return;
        }

        const buildSection = (id, label, count, storageKey) => {
            const section = document.createElement('div');
            section.className = 'outliner-section';
            section.dataset.section = id;
            // Stato collassato persistito (default expanded)
            const stored = localStorage.getItem(storageKey);
            if (stored === '1') section.classList.add('collapsed');

            const header = document.createElement('div');
            header.className = 'outliner-section-header';
            header.innerHTML = `
                <svg class="outliner-section-chevron" viewBox="0 0 16 16" fill="none"
                     stroke="currentColor" stroke-width="1.75"
                     stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 6 L8 10 L12 6"/>
                </svg>
                <span class="outliner-section-label">${label}</span>
                <span class="outliner-section-count">${count}</span>
            `;
            header.onclick = () => {
                const wasCollapsed = section.classList.toggle('collapsed');
                localStorage.setItem(storageKey, wasCollapsed ? '1' : '0');
            };

            const body = document.createElement('div');
            body.className = 'outliner-section-body';

            section.appendChild(header);
            section.appendChild(body);
            container.appendChild(section);
            return body;
        };

        const meshBody  = buildSection('meshes', 'Mesh', objects.length,
                                       'ibex:outliner:meshes-collapsed');
        const curveBody = buildSection('curves', 'Curve', curveCount,
                                       'ibex:outliner:curves-collapsed');

        if (objects.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'outliner-empty';
            empty.style.fontStyle = 'italic';
            empty.innerText = 'Nessuna mesh';
            meshBody.appendChild(empty);
        }

        objects.forEach(obj => {
            // 🟢 FIX CRITICO: Inizializza visualState prima di qualsiasi manipolazione
            if (!this.visualState[obj.name]) {
                this.visualState[obj.name] = {
                    visible: obj.visible,
                    opacity: obj.material && obj.material.transparent ? obj.material.opacity : 1,
                    color: obj.material ? obj.material.color.getHex() : 0xffffff,
                    wireframe: obj.material ? obj.material.wireframe : false,
                    // V12.7 — persiste flatShading nel visualState così sopravvive
                    // ai bake (BakeEngine.hotSwapMeshes ricrea il material via
                    // MeshLoader → flatShading default true; outlinerMgr.update()
                    // post-swap ri-applica lo stato salvato).
                    flatShading: obj.material ? (obj.material.flatShading !== false) : true,
                    // V12.8 — toggle visualizzazione VertexNormals (debug normali
                    // per identificare face flipped o winding inconsistente).
                    normalsVisible: false,
                    // V12.9 — toggle Face Orientation overlay (ShaderMaterial
                    // gl_FrontFacing: BLU=normale fuori, ROSSO=invertita). Sopravvive
                    // a hot-swap (BakeEngine ricrea material; update() qui sotto
                    // ri-attiva l'overlay leggendo questo flag).
                    faceOrientation: false
                };
            }

            const state = this.visualState[obj.name];
            if (obj.material) {
                // V12.9 — re-apply Face Orientation overlay PRIMA di flatShading.
                // BakeEngine.hotSwapMeshes ricrea material via MeshLoader (default
                // MeshMatcapMaterial fresh). Se visualState.faceOrientation=true,
                // ri-swap a ShaderMaterial singleton e salva il fresh matcap come
                // riferimento. Idempotente: skip se material è già il singleton.
                const meshLoader = window.ibex?.loader;
                if (state.faceOrientation && meshLoader?.getOrientationMaterial) {
                    const orientMat = meshLoader.getOrientationMaterial();
                    if (obj.material !== orientMat) {
                        obj.userData._matcapMaterial = obj.material;
                        obj.material = orientMat;
                    }
                }
                // V12.9 — wireframe/opacity/transparent/flatShading sono per-mesh.
                // Se Orient è ON, il material attivo è il singleton ShaderMaterial
                // condiviso fra tutte le mesh: scriverli lì creerebbe sovrascritture
                // crociate (es. opacity di Upper applicata a Lower). Quindi quando
                // Orient è ON, applichiamo SEMPRE al matcap di riferimento salvato
                // in mesh.userData._matcapMaterial (per-mesh).
                const propTarget = (state.faceOrientation && obj.userData._matcapMaterial)
                    ? obj.userData._matcapMaterial
                    : obj.material;
                if (propTarget) {
                    propTarget.wireframe = state.wireframe;
                    if (state.opacity < 1) {
                        propTarget.transparent = true;
                        propTarget.opacity = state.opacity;
                    }
                }
                // V12.7 — ri-applica flatShading se differisce. Cambio richiede
                // `needsUpdate=true` per recompile shader (Three.js usa define
                // FLAT_SHADED in compile-time).
                if (typeof state.flatShading === 'boolean'
                    && propTarget && propTarget.flatShading !== state.flatShading) {
                    propTarget.flatShading = state.flatShading;
                    propTarget.needsUpdate = true;
                }

                // ColorReady L11.2 (2026-07-24) — riconcilia il toggle globale `colorMode`
                // sul MATCAP DI RIFERIMENTO (propTarget), esattamente come flatShading:
                //   · Orient ON  → obj.material è lo ShaderMaterial singleton, ma propTarget
                //     è il matcap salvato in userData → gli scriviamo il flag così che al
                //     ritorno del matcap (Orient OFF, che chiama render() non update()) il
                //     colore sia già corretto. `isMeshMatcapMaterial` esclude comunque lo
                //     ShaderMaterial dell'Orient.
                //   · SculptMode attivo → il matcap "ceramica" È un MeshMatcapMaterial, quindi
                //     `isMeshMatcapMaterial` NON basta a proteggerlo (correzione al brief):
                //     lo escludiamo esplicitamente con !sculptMgr.active. Precedenza finale:
                //     faceOrientation > SculptMode > colorMode (recon §4.3).
                // `want` è gated sull'attributo REALE di QUESTA mesh → oggi (nessun colore)
                // è sempre false → no-op, nessuna mesh nera. USE_COLOR è compile-time (come
                // FLAT_SHADED) → serve needsUpdate per ricompilare lo shader.
                if (propTarget && propTarget.isMeshMatcapMaterial
                    && !window.ibex?.sculptMgr?.active) {
                    // ColorReady L11.3: `want` richiede l'attributo colore REALE E ALLINEATO
                    // (count == position.count). Il count-check è difensivo: dopo dyntopo/sculpt
                    // (L11.5) il buffer colore può restare corto/stale → con vertexColors=true
                    // WebGL leggerebbe oltre l'array → macchie nere/garbage. Disallineato →
                    // want=false → matcap pulito, mai garbage.
                    const _col = obj.geometry?.attributes?.color;
                    const _pos = obj.geometry?.attributes?.position;
                    const want = !!this.colorMode && !!_col && !!_pos && _col.count === _pos.count;
                    if (propTarget.vertexColors !== want) {
                        propTarget.vertexColors = want;
                        propTarget.needsUpdate = true;
                    }
                }
            }
            obj.visible = state.visible;

            // V12.8 — re-applica stato normals visibility post-update (sopravvive
            // a hotSwap perché helper viene rigenerato dalla geometry corrente).
            this._applyNormalsState(obj, state.normalsVisible);

            const item = document.createElement('div');
            item.className = 'outliner-item';
            item.setAttribute('draggable', 'true');
            item.dataset.meshName = obj.name;

            item.ondragstart = (e) => {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('text/plain', obj.name); // legacy
                e.dataTransfer.setData('ibex-type', 'mesh');
                e.dataTransfer.setData('ibex-mesh', obj.name);
                item.classList.add('is-dragging');
            };
            item.ondragend = () => {
                item.classList.remove('is-dragging');
            };

            // Click sulla riga (escludendo pulsanti interni) → seleziona mesh
            // + apre il panel laterale (coerenza col click sinistro viewport).
            item.onclick = (e) => {
                if (e.target.closest('button, input')) return;
                if (this.sceneMgr && typeof this.sceneMgr.selectMesh === 'function') {
                    this.sceneMgr.selectMesh(obj.name);
                }
                const panel = window.ibex?.inspectorPanel;
                if (panel && typeof panel.openForMesh === 'function') {
                    panel.openForMesh(obj);
                }
            };

            // Classe .selected riflette lo stato corrente del SceneManager
            if (this.sceneMgr && this.sceneMgr.selectedMeshName === obj.name) {
                item.classList.add('selected');
            }

            const leftBox = document.createElement('div');
            leftBox.className = 'outliner-left';

            const dot = document.createElement('span');
            dot.className = 'ibex-mesh-dot';

            const visBtn = document.createElement('button');
            visBtn.className = 'outliner-btn';
            visBtn.innerHTML = state.visible
                ? `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>`
                : `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"></path></svg>`;
            visBtn.onclick = (e) => {
                e.stopPropagation();
                // Recupera l'oggetto fresco per l'Hot-Swap
                const freshObj = this.sceneMgr.group.children.find(c => c.isMesh && c.name === obj.name);
                if (freshObj) {
                    freshObj.visible = !freshObj.visible;
                    this.visualState[obj.name].visible = freshObj.visible;
                    this.update();
                    this.sceneMgr.render();
                }
            };

            const nameSpan = document.createElement('span');
            nameSpan.className = 'outliner-name';
            // V12.5 — mostra `displayName` libero (modificabile via dblclick).
            // `obj.name` (= mesh.name Three.js) resta IDENTITÀ IMMUTABILE.
            nameSpan.innerText = this._getDisplayName(obj.name);
            nameSpan.style.cursor = 'text';
            nameSpan.title = 'Doppio click per rinominare';

            // Doppio click → rinomina inline (V12.3)
            nameSpan.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this._startRename(item, nameSpan, obj.name);
            });

            leftBox.appendChild(dot);
            leftBox.appendChild(visBtn);
            leftBox.appendChild(nameSpan);

            const toolsBox = document.createElement('div');
            toolsBox.className = 'outliner-tools';

            const wireBtn = document.createElement('button');
            wireBtn.className = 'outliner-btn';
            wireBtn.title = 'Wireframe';
            const wireOff = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"></path><path stroke-linecap="round" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M4 12h16M12 4v16\"></path></svg>`;
            const wireOn = `<svg style=\"color:var(--ibex-accent)\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z\"></path><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M4 12h16M12 4v16M8 4v16M16 4v16M4 8h16M4 16h16\"></path></svg>`;
            
            wireBtn.innerHTML = state.wireframe ? wireOn : wireOff;
            
            wireBtn.onclick = (e) => {
                e.stopPropagation();
                const freshObj = this.sceneMgr.group.children.find(c => c.isMesh && c.name === obj.name);
                if (freshObj && freshObj.material) {
                    freshObj.material.wireframe = !freshObj.material.wireframe;
                    this.visualState[obj.name].wireframe = freshObj.material.wireframe;
                    wireBtn.innerHTML = freshObj.material.wireframe ? wireOn : wireOff;
                    this.sceneMgr.render();
                }
            };

            const opacityWrap = document.createElement('div');
            opacityWrap.className = 'outliner-opacity';
            opacityWrap.title = 'Opacità';
            const opacityInput = document.createElement('input');
            opacityInput.type = 'range';
            opacityInput.min = '0';
            opacityInput.max = '1';
            opacityInput.step = '0.05';
            opacityInput.value = state.opacity;
            opacityInput.className = '';
            
            opacityInput.oninput = (e) => {
                const val = parseFloat(e.target.value);
                const freshObj = this.sceneMgr.group.children.find(c => c.isMesh && c.name === obj.name);
                if (freshObj && freshObj.material) {
                    freshObj.material.transparent = true;
                    freshObj.material.opacity = val;
                    // 🟢 FIX CRITICO: Garanzia che lo stato visivo sia indicizzato
                    if (!this.visualState[obj.name]) {
                         this.visualState[obj.name] = { opacity: 1 };
                    }
                    this.visualState[obj.name].opacity = val;
                    this.sceneMgr.render();
                }
            };
            
            opacityWrap.appendChild(opacityInput);

            // V12.8 — Toggle Normali (debug winding/flip face)
            const normBtn = document.createElement('button');
            normBtn.className = 'outliner-btn';
            normBtn.title = 'Mostra/Nascondi Normali (debug)';
            // Icona freccia ↗ stile "vector arrow"
            normBtn.innerHTML = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 17L17 7M17 7H9M17 7v8"></path></svg>`;
            normBtn.onclick = (e) => {
                e.stopPropagation();
                const freshObj = this.sceneMgr.group.children.find(c => c.isMesh && c.name === obj.name);
                if (freshObj) {
                    const newState = !this.visualState[obj.name].normalsVisible;
                    this.visualState[obj.name].normalsVisible = newState;
                    this._applyNormalsState(freshObj, newState);
                    normBtn.className = 'outliner-btn';
                    this.sceneMgr.render();
                }
            };

            toolsBox.appendChild(opacityWrap);
            toolsBox.appendChild(normBtn);
            toolsBox.appendChild(wireBtn);

            item.appendChild(leftBox);
            item.appendChild(toolsBox);
            meshBody.appendChild(item);
        });

        // ─────────────────────────────────────────────────────────────
        // V13.0 (2026-05-13) — Curve come oggetti di prima classe.
        // Renderizza una riga nell'outliner per ogni overlay CurveViewer
        // attualmente registrato. La riga ha: dot blu + visibility toggle
        // + nome derivato dal node producer (arch_detect, draw_curve, ecc).
        // Toggle eye → CurveViewer.setOverlayVisible (group.visible).
        // ─────────────────────────────────────────────────────────────
        const curveViewer = window.ibex?.curveViewer;
        if (curveViewer && typeof curveViewer.getOverlayEntries === 'function') {
            const entries = curveViewer.getOverlayEntries();
            const stackMgr = window.ibex?.stackMgr;
            // V14.0 CollapsibleSections: placeholder se la sezione curve è
            // vuota (mai entrato il loop sotto).
            if (entries.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'outliner-empty';
                empty.style.fontStyle = 'italic';
                empty.innerText = 'Nessuna curva';
                curveBody.appendChild(empty);
            }
            for (const { nodeId, entry } of entries) {
                if (!entry || !entry.group) continue;
                // V13.1 CurveDisplayName (2026-05-14): delega a
                // StackManager.getCurveDisplayName che gestisce sia il
                // custom name (`node.data.curveDisplayName`) sia il
                // fallback al `toolName`.
                let dispName = `Curva (nodo ${nodeId})`;
                if (stackMgr?.getCurveDisplayName) {
                    const fromMgr = stackMgr.getCurveDisplayName(nodeId);
                    if (fromMgr) dispName = fromMgr;
                }
                const isVisible = entry.group.visible !== false;

                const cItem = document.createElement('div');
                cItem.className = 'outliner-item outliner-item--curve';
                cItem.dataset.curveNodeId = String(nodeId);

                const cLeftBox = document.createElement('div');
                cLeftBox.className = 'outliner-left';

                const cDot = document.createElement('span');
                cDot.className = 'ibex-mesh-dot';
                cDot.style.background = '#2A6FDB';  // blu curva

                const cVisBtn = document.createElement('button');
                cVisBtn.className = 'outliner-btn';
                cVisBtn.title = 'Mostra/nascondi curva';
                cVisBtn.innerHTML = isVisible
                    ? `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>`
                    : `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"></path></svg>`;
                cVisBtn.onclick = (e) => {
                    e.stopPropagation();
                    const newVis = !entry.group.visible;
                    curveViewer.setOverlayVisible(nodeId, newVis);
                    this.update();
                };

                const cName = document.createElement('span');
                cName.className = 'outliner-name';
                cName.innerText = dispName;
                cName.title = 'Doppio click per rinominare';
                cName.style.cursor = 'text';

                // V13.1 CurveDisplayName: dblclick → rinomina inline.
                cName.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    this._startCurveRename(cName, nodeId);
                });

                cLeftBox.appendChild(cDot);
                cLeftBox.appendChild(cVisBtn);
                cLeftBox.appendChild(cName);
                cItem.appendChild(cLeftBox);
                curveBody.appendChild(cItem);
            }
        }
    }

    /**
     * V13.1 CurveDisplayName (2026-05-14) — sostituisce il nameSpan con
     * un <input> inline, pre-selezionato. Enter/blur commit, Escape revert.
     * Pattern speculare a `_startRename` per le mesh, ma scrive su
     * `node.data.curveDisplayName` via `StackManager.setCurveDisplayName`.
     */
    _startCurveRename(nameSpan, nodeId) {
        const stackMgr = window.ibex?.stackMgr;
        if (!stackMgr?.setCurveDisplayName) return;
        const currentDisplay = stackMgr.getCurveDisplayName(nodeId);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentDisplay;
        input.className = nameSpan.className;
        input.style.cssText = `
            border: 1px solid #2A6FDB;
            background: transparent;
            padding: 0;
            margin: 0;
            font: inherit;
            color: inherit;
            outline: none;
            width: 100%;
            min-width: 0;
            box-sizing: border-box;
        `;

        nameSpan.replaceWith(input);
        input.focus();
        input.select();

        let done = false;
        const finalize = (save) => {
            if (done) return;
            done = true;

            let newDisplay = save ? (input.value || '').trim() : currentDisplay;
            if (!newDisplay || !newDisplay.length) newDisplay = '';  // null reset

            if (save && newDisplay !== currentDisplay) {
                stackMgr.setCurveDisplayName(nodeId, newDisplay || null);
                nameSpan.innerText = newDisplay || stackMgr.getCurveDisplayName(nodeId);
            } else {
                nameSpan.innerText = currentDisplay;
            }
            input.replaceWith(nameSpan);
        };

        input.addEventListener('blur', () => finalize(true));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')      { e.preventDefault(); input.blur(); }
            else if (e.key === 'Escape') { e.preventDefault(); finalize(false); }
        });
    }

    /**
     * V12.8 — Applica/rimuove VertexNormalsHelper su una mesh.
     * Helper salvato in mesh.userData.normalsHelper. Sopravvive a hotSwap perché
     * `update()` ricostruisce l'helper dalla geometry corrente quando ri-applicato.
     * Lunghezza freccia adattiva al BBox mesh (~2% diagonale per visibilità).
     */
    _applyNormalsState(mesh, visible) {
        if (!mesh || !mesh.geometry) return;
        // Rimuovi helper esistente (sempre, per evitare duplicati al rebuild)
        const existing = mesh.userData.normalsHelper;
        if (existing) {
            if (existing.parent) existing.parent.remove(existing);
            if (existing.geometry) existing.geometry.dispose();
            if (existing.material) existing.material.dispose();
            mesh.userData.normalsHelper = null;
        }
        if (!visible) return;
        try {
            // Calcola normali se mancano
            if (!mesh.geometry.attributes.normal) {
                mesh.geometry.computeVertexNormals();
            }
            // Lunghezza freccia: 2% diagonale BBox (≈ 1-2mm su scansione dentale)
            mesh.geometry.computeBoundingBox();
            const bb = mesh.geometry.boundingBox;
            const diag = bb ? bb.getSize(new THREE.Vector3()).length() : 10;
            const arrowLen = Math.max(0.3, diag * 0.02);
            const helper = new VertexNormalsHelper(mesh, arrowLen, 0xFF6037);
            helper.name = '__normals_helper__' + mesh.name;
            // Add to scene root (sibling di mesh, non child — così non eredita material)
            const scene = this.sceneMgr && this.sceneMgr.scene;
            if (scene) {
                scene.add(helper);
                mesh.userData.normalsHelper = helper;
            }
        } catch (e) {
            console.warn('[OutlinerManager] _applyNormalsState fallito:', e);
        }
    }

    loadVisuals(data) {
        if (!data) return;
        this.visualState = data;
        this.update();
    }

    gatherVisuals() {
        return this.visualState;
    }

    // ─────────────────────────────────────────────────────────────
    // V12.3: Rinomina mesh inline (doppio click sul nome nell'outliner)
    // ─────────────────────────────────────────────────────────────

    /**
     * Sostituisce il nameSpan con un <input> inline, pre-selezionato.
     * Enter/blur salva (se valido), Escape annulla.
     *
     * TODO: persistere il nuovo nome in `session_settings` al prossimo
     * save_exit (attualmente solo in-memory per la sessione corrente).
     */
    _startRename(item, nameSpan, fullName) {
        // V12.5: cosmetic-safe rename — `meshName` è IDENTITÀ IMMUTABILE
        // (file su disco, manifest, worker, snapshot keyed). L'utente può
        // editare solo il `displayName` (label libera UI). Il valore di
        // partenza è il displayName corrente del primo nodo mesh associato
        // al `meshName` (fallback: stem del meshName senza .stl).
        const meshName = fullName;  // immutabile (= mesh.name Three.js)
        const currentDisplay = this._getDisplayName(meshName);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentDisplay;
        input.className = nameSpan.className;
        input.style.cssText = `
            border: 1px solid var(--ibex-accent);
            background: transparent;
            padding: 0;
            margin: 0;
            font: inherit;
            color: inherit;
            outline: none;
            width: 100%;
            min-width: 0;
            box-sizing: border-box;
        `;

        nameSpan.replaceWith(input);
        input.focus();
        input.select();

        let done = false;
        const finalize = (save) => {
            if (done) return;
            done = true;

            let newDisplay = save ? (input.value || '').trim() : currentDisplay;
            // Permetti tutti i caratteri non-controllo: è solo una label UI.
            // Vietiamo solo stringa vuota.
            if (!newDisplay || !newDisplay.length) newDisplay = currentDisplay;

            if (newDisplay !== currentDisplay) {
                this._applyDisplayRename(meshName, newDisplay);
                nameSpan.innerText = newDisplay;
            } else {
                nameSpan.innerText = currentDisplay;
            }
            input.replaceWith(nameSpan);
        };

        input.addEventListener('blur', () => finalize(true));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')      { e.preventDefault(); input.blur(); }
            else if (e.key === 'Escape') { e.preventDefault(); finalize(false); }
        });
    }

    /**
     * V12.7 — delega al getter centralizzato `StackManager.getMeshDisplayName`
     * (DagSync V3.19). Mantenuto come metodo per compatibilità con i call
     * site interni (riga outliner + rename inline).
     */
    _getDisplayName(meshName) {
        const stackMgr = window.ibex?.stackMgr;
        if (stackMgr?.getMeshDisplayName) {
            return stackMgr.getMeshDisplayName(meshName);
        }
        // Fallback se stackMgr non disponibile (pre-init, edge case test).
        return String(meshName).replace(/\.stl$/i, '');
    }

    /**
     * V12.6 — cosmetic-safe rename: delega completamente al setter
     * centralizzato `StackManager.setMeshDisplayName(meshName, newDisplay)`
     * (scrive grafo, aggiorna title-box DOM nodi DAG, refresha
     * InspectorPanel se aperto). La riga outliner viene aggiornata
     * localmente dal `finalize` di `_startRename` via
     * `nameSpan.innerText = newDisplay` (no doppio update qui).
     */
    _applyDisplayRename(meshName, newDisplay) {
        window.ibex?.stackMgr?.setMeshDisplayName?.(meshName, newDisplay);
    }
}