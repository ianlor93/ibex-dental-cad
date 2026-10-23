import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass }    from 'three/addons/postprocessing/OutlinePass.js';

// ═══════════════════════════════════════════════════════════════
// IBEX SceneManager InspectorPanel_V7.4 — click sinistro seleziona mesh
//
// V7.4 (2026-04-27, InspectorPanel):
//   - Selezione mesh via CLICK SINISTRO (non più tasto destro):
//     `pointerdown`/`pointerup` con threshold dist<8px + dt<300ms per
//     distinguere click da drag OrbitControls. Hit → selectMesh +
//     inspectorPanel.openForMesh. No hit → deselectMesh + panel.close.
//     Guard: skip se sculptMgr.active o selectionMode.active (mouse gestito
//     da loro).
//   - Rimossi listener `contextmenu` e `mousedown` del tasto destro:
//     il ContextInspector popup è stato sostituito dal panel laterale
//     (InspectorPanel). Rimossa anche la logica `_rightDownPos`.
//   - Rimosso `_projectMeshCenterToScreen` (serviva solo al positioning
//     del popup, non più necessario — il panel è fisso sul bordo destro).
//   - OutlinePass: edgeThickness 1.0 → 1.5 + hiddenEdgeColor #000000 →
//     #FF6037 (outline arancione uniforme anche sulle zone occluse).
//     `edgeStrength 3.0 → 1.0` + `overlayMaterial.blending = NormalBlending`
//     (era AdditiveBlending default): l'outline non viene più SOMMATO al
//     viewport ma sovrapposto con alpha piatta → pastello #FF6037 reale,
//     niente effetto glow/illuminato.
//
// V7.3 (2026-04-25, SnapshotKeyed Session 3):
//   - Nuovo `updateSplitMasterVisibility(graph)`: per ogni nodo
//     `split_topology` nel DAG, se le 2 mesh derivate
//     `{stem}_snap_{nodeId}_A.stl` e `_B.stl` sono presenti in scena,
//     nasconde automaticamente la mesh master (`visible = false`). Quando
//     il nodo split viene rimosso (BakeEngine.revertToMaster rimuove le
//     2 mesh derivate), questa stessa funzione ri-show il master. S3-NA1.
//   - Chiamata: IbexCore._loadSplitDerivedMeshes (post-load) + BakeEngine
//     (post-hotSwapMeshes) + requestBake post-syncPreview.
//   - Outliner NON è nascosto (l'utente può toggle manualmente la visibility).
//
// V7.2 (2026-04-22):
//   - scene.background = 0xF4F5F6 (bianco + 1% grigio neutro).
//
// V7.1 (2026-04-22):
//   - scene.background = 0xffffff (bianco puro), fog disabilitata.
//     Il tono "beige" percepito era fog residua + cache browser.
//
// V7.0 (2026-04-22):
//   - Palette chiara: scene.background / fog = 0xf5f5f3 (Clinical Light)
//   - Grid helper con colori light-friendly (0xD2D5D8, 0xE3E5E7)
//   - _projectMeshCenterToScreen() ora usa Box3.setFromObject(mesh) — AABB
//     world direttamente, più robusto della combinazione geometry.boundingBox
//     + matrixWorld manuale.
//
// V6.2 (2026-04-21):
//   - EffectComposer + RenderPass + OutlinePass (#FF6037, edgeStrength 3).
//   - render() ora chiama composer.render() (non renderer.render).
//   - onResize() aggiorna anche composer e outlinePass.
//   - selectMesh(name) / deselectMesh(): popolano outlinePass.selectedObjects
//     e dispatch 'ibex:selection-changed' (ascoltato da OutlinerManager V12.1).
//   - Durante SculptMode (sculptMgr.active), selectMesh è no-op → outline
//     sparisce per non interferire con il brush (invariante DR-9 / 59).
//
// V6.1 (2026-04-21):
//   - Nell'evento ibex:mesh-contextmenu aggiunto detail.meshScreenCenter
//     (centro boundingBox world proiettato in pixel schermo). Permette al
//     ContextInspector di posizionare il menu nel quadrante OPPOSTO rispetto
//     al centro mesh (invariante DR-8 → 58).
//
// V6.0 (2026-04-21):
//   - scene.background + fog → palette scura (#0a0a0a) allineata al redesign
//   - Raycaster: RIMOSSO listener dblclick. AGGIUNTO listener contextmenu
//     che distingue "click" (≤5px di movimento) da "pan OrbitControls"
//     (> 5px). Sul click, preventDefault del menu browser + dispatch evento
//     custom ibex:mesh-contextmenu.
// ═══════════════════════════════════════════════════════════════

export class SceneManager {
    constructor(canvasId) {
        console.log("🏥 SceneManager: ViewGizmo V7.5 (tick integrato)");

        const container = document.getElementById(canvasId);
        if (!container) return;

        // 1. Scene — bianco + 1% grigio neutro, no fog
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xF4F5F6);
        this.scene.fog = null;

        // 2. Camera (Z-UP CONFIGURATION)
        const aspect = container.clientWidth / container.clientHeight;
        this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 10000);
        this.camera.up.set(0, 0, 1);
        this.camera.position.set(0, -400, 100);

        // 3. Renderer
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            preserveDrawingBuffer: true,
            powerPreference: "high-performance"
        });
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;

        container.innerHTML = '';
        container.appendChild(this.renderer.domElement);

        // 4. Lights (bilanciate per sfondo scuro — leggermente più forti)
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambient);

        const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
        dirLight.position.set(100, -200, 300);
        this.scene.add(dirLight);

        const fillLight = new THREE.DirectionalLight(0xeef2ff, 0.45);
        fillLight.position.set(-100, -50, 50);
        this.scene.add(fillLight);

        // 5. Group (container mesh)
        this.group = new THREE.Group();
        this.scene.add(this.group);

        // 6. Helpers (grid + axes, colori light-friendly)
        this.gridHelper = new THREE.GridHelper(400, 40, 0xD2D5D8, 0xE3E5E7);
        this.gridHelper.rotation.x = Math.PI / 2;
        this.scene.add(this.gridHelper);

        this.axesHelper = new THREE.AxesHelper(150);
        this.scene.add(this.axesHelper);

        // 7. Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;

        // 8. EffectComposer + OutlinePass (mesh selezionata, DR-9 / 59)
        this.composer = new EffectComposer(this.renderer);
        this.composer.setPixelRatio(this.renderer.getPixelRatio());
        this.composer.setSize(container.clientWidth, container.clientHeight);
        this.composer.addPass(new RenderPass(this.scene, this.camera));

        this.outlinePass = new OutlinePass(
            new THREE.Vector2(container.clientWidth, container.clientHeight),
            this.scene,
            this.camera
        );
        this.outlinePass.edgeStrength    = 1.0;
        this.outlinePass.edgeThickness   = 1.5;
        this.outlinePass.edgeGlow        = 0;
        this.outlinePass.pulsePeriod     = 0;
        this.outlinePass.visibleEdgeColor.set('#FF6037');
        this.outlinePass.hiddenEdgeColor.set('#FF6037');
        // V7.4: OutlinePass default compone con AdditiveBlending → l'outline
        // viene SOMMATO al viewport (effetto "illuminato"/glow). Forziamo
        // NormalBlending: alpha-blend piatto → colore arancione pastello vero
        // (#FF6037 non saturato da additive overshoot). edgeStrength=1.0 per
        // non scalare il colore oltre [0,1].
        if (this.outlinePass.overlayMaterial) {
            this.outlinePass.overlayMaterial.blending    = THREE.NormalBlending;
            this.outlinePass.overlayMaterial.needsUpdate = true;
        }
        this.composer.addPass(this.outlinePass);

        this.selectedMeshName = null;

        // 9. Loop
        this.onResize = this.onResize.bind(this);
        window.addEventListener('resize', this.onResize);
        this.animate = this.animate.bind(this);
        this.animate();

        // 10. Selezione mesh — click sinistro breve (pointer events)
        this._initSelectionPointer();
    }

    /**
     * Selezione mesh con click sinistro: distingue click (dist<8px & dt<300ms)
     * da drag OrbitControls. Hit mesh → selectMesh + inspectorPanel.openForMesh;
     * no hit → deselectMesh + inspectorPanel.close.
     *
     * Guard: se sculpt o selection mode sono attivi, il click è gestito da loro
     * (mouse dedicato al brush). InspectorPanel resta aperto se era aperto.
     *
     * Previene di intercettare click su elementi UI che possono finire sopra il
     * canvas (il dag-overlay non è un sibling del canvas ma un figlio del body
     * con pointer-events che bloccano; il panel laterale idem).
     */
    _initSelectionPointer() {
        this._raycaster = new THREE.Raycaster();
        this._raycaster.firstHitOnly = true; // BVH early-exit (invariante 62)
        this._mouse = new THREE.Vector2();

        this._pointerDownPos = null;
        this._pointerDownTime = 0;

        const canvas = this.renderer.domElement;
        const CLICK_DIST = 8;
        const CLICK_DT   = 300;

        canvas.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            this._pointerDownPos = { x: e.clientX, y: e.clientY };
            this._pointerDownTime = Date.now();
        });

        canvas.addEventListener('pointerup', (e) => {
            if (e.button !== 0) return;
            if (!this._pointerDownPos) return;

            const dx = e.clientX - this._pointerDownPos.x;
            const dy = e.clientY - this._pointerDownPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const dt = Date.now() - this._pointerDownTime;
            this._pointerDownPos = null;

            if (dist >= CLICK_DIST || dt >= CLICK_DT) return; // drag, non click

            // Guard: brush mode attivo → il click appartiene al brush
            const ibex = window.ibex;
            if (ibex?.sculptMgr?.active || ibex?.selectionMode?.active) return;

            const rect = canvas.getBoundingClientRect();
            this._mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
            this._mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
            this._raycaster.setFromCamera(this._mouse, this.camera);
            const hits = this._raycaster.intersectObjects(this.group.children, false);

            if (hits.length > 0 && hits[0].object.isMesh && hits[0].object.name) {
                const mesh = hits[0].object;
                this.selectMesh(mesh.name);
                ibex?.inspectorPanel?.openForMesh(mesh);
            } else {
                this.deselectMesh();
                ibex?.inspectorPanel?.close();
            }
        });
    }

    addMesh(mesh) {
        this.group.add(mesh);
        this.render();
    }

    resetCamera() {
        const box = new THREE.Box3().setFromObject(this.group);
        const center = box.isEmpty() ? new THREE.Vector3(0,0,0) : box.getCenter(new THREE.Vector3());

        this.camera.position.set(center.x, center.y - 300, center.z + 50);
        this.camera.lookAt(center);
        this.controls.target.copy(center);
        this.controls.update();
    }

    toggleGrid(btnElement) {
        if (!this.gridHelper) return;
        this.gridHelper.visible = !this.gridHelper.visible;
        if (btnElement) {
            btnElement.style.opacity = this.gridHelper.visible ? '1' : '0.45';
        }
        this.render();
    }

    toggleAxes(btnElement) {
        if (!this.axesHelper) return;
        this.axesHelper.visible = !this.axesHelper.visible;
        if (btnElement) {
            btnElement.style.opacity = this.axesHelper.visible ? '1' : '0.45';
        }
        this.render();
    }

    onResize() {
        const container = this.renderer.domElement.parentElement;
        const w = container.clientWidth;
        const h = container.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        if (this.composer)    this.composer.setSize(w, h);
        if (this.outlinePass) this.outlinePass.setSize(w, h);
    }

    render() {
        if (this.composer) this.composer.render();
        else               this.renderer.render(this.scene, this.camera);
        // ViewGizmo overlay (top-left) — renderizzato dopo la scena principale
        // così appare sopra a tutto. Tick interno aggiorna anche l'animazione
        // di transizione tra viste (helper.animating).
        if (this.viewGizmo) this.viewGizmo.tick();
    }
    /**
     * Thumbnail IBX2 (2026-07-21) — SCREENSHOT del canvas reale dell'editor: rende
     * il gruppo mesh (matcap "Clinical White") a size×size con la stessa camera che
     * l'utente sta guardando (angolo corrente) inquadrata sul bounding box, fondo
     * #F4F5F6, SENZA griglia/gizmo/outline. È ciò che IBEX mostra — non un render
     * ri-elaborato. Ritorna una Promise<Blob PNG> o null (best-effort). La chiama
     * saveAndExit/bakeAndExit prima del POST; il worker la incastona nell'IBX2.
     */
    captureThumbnail(size = 1024) {
        try {
            if (!this.group || !this.renderer) return Promise.resolve(null);
            const box = new THREE.Box3();
            this.group.children.forEach(c => { if (c.visible) box.expandByObject(c); });
            if (box.isEmpty()) return Promise.resolve(null);
            const center = box.getCenter(new THREE.Vector3());
            const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
            const fovDeg = this.camera.fov || 45;
            const dir = new THREE.Vector3(); this.camera.getWorldDirection(dir);   // verso dove guarda
            const dist = (radius / Math.sin(THREE.MathUtils.degToRad(fovDeg) / 2)) * 1.18;
            const cam = new THREE.PerspectiveCamera(fovDeg, 1, 0.1, 1e6);
            cam.up.set(0, 0, 1);
            cam.position.copy(center).addScaledVector(dir, -dist);   // stessa angolazione, inquadrato
            cam.lookAt(center); cam.updateProjectionMatrix();

            const gV = this.gridHelper ? this.gridHelper.visible : null;
            const aV = this.axesHelper ? this.axesHelper.visible : null;
            if (this.gridHelper) this.gridHelper.visible = false;
            if (this.axesHelper) this.axesHelper.visible = false;

            const rt = new THREE.WebGLRenderTarget(size, size, { samples: 4 });  // MSAA 4× → bordi netti
            const prevT = this.renderer.getRenderTarget();
            const prevC = this.renderer.getClearColor(new THREE.Color());
            const prevA = this.renderer.getClearAlpha();
            this.renderer.setRenderTarget(rt);
            this.renderer.setClearColor(0xF4F5F6, 1);
            this.renderer.clear();
            this.renderer.render(this.scene, cam);              // renderer diretto: niente outline/gizmo
            const buf = new Uint8Array(size * size * 4);
            this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
            this.renderer.setRenderTarget(prevT);
            this.renderer.setClearColor(prevC, prevA);
            if (this.gridHelper) this.gridHelper.visible = gV;
            if (this.axesHelper) this.axesHelper.visible = aV;
            rt.dispose();

            const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
            const ctx = cv.getContext('2d');
            const img = ctx.createImageData(size, size);
            const row = size * 4;
            for (let y = 0; y < size; y++) {                    // flip Y (WebGL bottom-up → top-down)
                img.data.set(buf.subarray((size - 1 - y) * row, (size - y) * row), y * row);
            }
            ctx.putImageData(img, 0, 0);
            return new Promise(res => cv.toBlob(b => res(b), 'image/png'));
        } catch (e) {
            console.warn('[thumb] capture fallita', e);
            return Promise.resolve(null);
        }
    }
    animate() {
        requestAnimationFrame(this.animate);
        this.controls.update();
        // Forza re-render continuo durante animazione gizmo (transizione viste)
        // perché OrbitControls.update() potrebbe non triggerare cambio camera.
        if (this.viewGizmo?.helper?.animating) {
            // niente da fare: render() viene chiamato sotto comunque
        }
        this.render();
    }

    // ═══════════════════════════════════════════════════════════════
    // Selezione mesh (DR-9 / invariante 59)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Seleziona una mesh per nome. Applica outline arancione via OutlinePass
     * e dispatch 'ibex:selection-changed' per sincronizzare UI (outliner).
     * No-op durante SculptMode: l'outline interferirebbe col brush.
     */
    selectMesh(meshName) {
        const sm = window.ibex && window.ibex.sculptMgr;
        if (sm && sm.active) return;

        this.selectedMeshName = meshName || null;
        const mesh = meshName
            ? this.group.children.find(c => c.isMesh && c.name === meshName)
            : null;
        if (this.outlinePass) {
            this.outlinePass.selectedObjects = mesh ? [mesh] : [];
        }
        window.dispatchEvent(new CustomEvent('ibex:selection-changed', {
            detail: { meshName: this.selectedMeshName }
        }));
        this.render();
    }

    deselectMesh() {
        this.selectedMeshName = null;
        if (this.outlinePass) this.outlinePass.selectedObjects = [];
        window.dispatchEvent(new CustomEvent('ibex:selection-changed', {
            detail: { meshName: null }
        }));
        this.render();
    }

    // UX-A batch2 — Isola: nascondi tutte le mesh tranne `meshName` (toggle).
    // View-only (nessun undo). Persiste via outlinerMgr.visualState così update()
    // non lo annulla; salva la mappa di visibilità per ripristinarla al toggle off.
    toggleIsolate(meshName) {
        if (!meshName) return;
        const om = window.ibex?.outlinerMgr;
        const meshes = this.group.children.filter(c => c.isMesh && c.name && !c.isGridHelper);
        if (this._isolatedMesh) {
            // OFF — ripristina la visibilità salvata
            const saved = this._isolateSaved || {};
            meshes.forEach(m => {
                const vis = (m.name in saved) ? saved[m.name] : true;
                m.visible = vis;
                if (om?.visualState?.[m.name]) om.visualState[m.name].visible = vis;
            });
            this._isolatedMesh = null;
            this._isolateSaved = null;
        } else {
            // ON — salva e isola
            this._isolateSaved = {};
            meshes.forEach(m => {
                this._isolateSaved[m.name] = m.visible;
                const on = (m.name === meshName);
                m.visible = on;
                if (om?.visualState?.[m.name]) om.visualState[m.name].visible = on;
            });
            this._isolatedMesh = meshName;
        }
        try { om?.update?.(); } catch (e) { /* non critico */ }
        this.render();
    }

    // ═══════════════════════════════════════════════════════════════
    // SnapshotKeyed S3 (2026-04-25, S3-NA1) — auto-hide master post-split.
    //
    // Per ogni nodo `split_topology` nel DAG:
    //   1. Risolvi il master (IN_GEO_Mesh upstream) via resolveBaseMesh
    //   2. Verifica se le 2 mesh derivate `{stem}_snap_{nodeId}_A/B.stl`
    //      sono presenti in scena
    //   3. Se entrambe presenti → master.visible = false (split attivo)
    //      Se mancano (nodo non ancora eseguito) → master.visible = true
    //
    // Mesh master non-splitate (nessun nodo split nel DAG che la consuma)
    // restano sempre visibili.
    //
    // Outliner NON è nascosto: l'utente può ri-abilitare manualmente la
    // visibility tramite il toggle (OutlinerManager.visualState). In quel
    // caso il prossimo update rispetterà la scelta dell'utente — finché
    // non ri-chiamiamo updateSplitMasterVisibility che sovrascrive. Questo
    // è intenzionale: il comportamento automatico predomina finché il DAG
    // non cambia.
    // ═══════════════════════════════════════════════════════════════
    updateSplitMasterVisibility(graph) {
        if (!graph?.nodes || !this.group) return;

        const stackMgr = window.ibex?.stackMgr;
        if (!stackMgr) return;

        // Costruisci set dei master name che devono essere nascosti (split
        // attivo = nodo split nel DAG + entrambe le mesh derivate A/B in scena).
        const hiddenMasters = new Set();
        const splitNodes = graph.nodes.filter(n => n.toolId === 'split_topology');

        for (const n of splitNodes) {
            const inEdges = graph.edges.filter(e => String(e.to_node) === String(n.id));
            const inEdge = inEdges.find(e => e.role === 'IN_GEO_Mesh')
                        || inEdges.find(e => !e.role || e.role === 'target')
                        || inEdges[0];
            if (!inEdge) continue;
            const masterName = stackMgr.resolveBaseMesh(inEdge.from_mesh, inEdge.from_port);
            if (!masterName || !masterName.toLowerCase().endsWith('.stl')) continue;

            const stem = masterName.replace(/\.stl$/i, '');
            const meshA = this.group.children.find(c => c.isMesh && c.name === `${stem}_snap_${n.id}_A.stl`);
            const meshB = this.group.children.find(c => c.isMesh && c.name === `${stem}_snap_${n.id}_B.stl`);

            if (meshA && meshB) {
                hiddenMasters.add(masterName);
            }
        }

        // Sincronizza visibility su TUTTE le mesh della scena. Identifico i
        // "master" come mesh che NON matchano il pattern `_snap_X_[AB].stl`
        // (le derivate restano sempre con la loro visibility corrente, non le
        // tocco). Uso `userData.ibexSplitAutoHidden` come flag per distinguere
        // un auto-hide nostro da un toggle manuale dell'utente (outliner) —
        // se la mesh era `visible=false` E non è nel set hidden corrente E
        // NON ha il flag → è un toggle utente, rispettalo. Viceversa, se era
        // auto-nascosta e non serve più nasconderla → riaccendila.
        const _SPLIT_DERIVED_RX = /^.+_snap_[A-Za-z0-9_\-]+_[AB]\.stl$/i;

        let changedCount = 0;
        this.group.children.forEach(c => {
            if (!c.isMesh || !c.name) return;
            if (_SPLIT_DERIVED_RX.test(c.name)) return; // è una mesh derivata, skip

            const shouldHide = hiddenMasters.has(c.name);
            const wasAutoHidden = c.userData?.ibexSplitAutoHidden === true;

            if (shouldHide && c.visible) {
                c.visible = false;
                c.userData.ibexSplitAutoHidden = true;
                changedCount++;
                console.log(`[SceneManager] auto-hide master ${c.name} (split attivo)`);
            } else if (!shouldHide && !c.visible && wasAutoHidden) {
                // Era nascosta da noi, ora non serve più → ripristina.
                c.visible = true;
                delete c.userData.ibexSplitAutoHidden;
                changedCount++;
                console.log(`[SceneManager] auto-show master ${c.name} (split rimosso)`);
            }
        });

        if (changedCount > 0) {
            this.render();
            if (window.ibex?.outlinerMgr) window.ibex.outlinerMgr.update();
        }
    }
}
