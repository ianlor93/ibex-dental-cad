import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// ═══════════════════════════════════════════════════════════════
// IBEX MeshLoader FaceOrient_V16.3 — + getOrientationMaterial() singleton
//   Aggiunge metodo per ottenere lo ShaderMaterial Face Orientation (BLU
//   front-facing / ROSSO back-facing via gl_FrontFacing). Toggle UI in
//   ContextInspector row Shading. Usato come strumento diagnostico per
//   identificare face flipped (es. zona piena Upper modelgenerator).
// Base: PyMeshLab_V16.2 — fromMaster option (serve_file ?from=master)
//   Usato da BakeEngine.revertToMaster al remove di tool dal DAG per tornare
//   allo stato scanner-space senza toccare preview/ lato server.
// V16.1: BVH — MatCap "Clinical White" + three-mesh-bvh + flat shading
//
// V16.1 (2026-04-22, Sculpt V2 Sessione 3 post-feedback):
//   - material.flatShading = true. Richiesta esplicita dell'utente: "shade flat".
//     Il matcap ora calcola via normali face-uniform (dFdx/dFdy nel shader),
//     eliminando l'effetto smooth interpolato. Look "Meshmixer base".
//
// V16.0 (2026-04-22, Sculpt V2 Sessione 1):
//   - Dopo computeVertexNormals/computeBoundingBox chiamo
//     geometry.computeBoundsTree() (guard su prototype patchato in IbexCore).
//     Abilita raycast BVH-accelerato su tutte le mesh caricate + shapecast
//     che SculptMode V5.0 userà in Sessione 3.
//
// V15.1 (2026-04-22):
//   - Cache-bust bump. Specifiche numeriche invariate rispetto a V15.0.
//
// V15.0 (2026-04-22):
//   - Struttura prescritta (specifiche esplicite dell'utente):
//     1. Clip circolare (raggio 255, centro 256,256)
//     2. Fill base #f2f1ef
//     3. Highlight radial centrato (97,82) — luce a 45° dall'alto-sinistra
//     4. Ombra radial centrata (397,410) — basso-destra
//     5. Rim scuro radial dal centro (141→255), alpha 0→0.22
//
// V14.6 — Grigio chiarissimo verticale. Scartato.
// V14.5 — Bianco puro uniforme. Mesh piatte senza chiaroscuro.
// V14.4 — Gradiente verticale Meshmixer-like. Scartato (#7a bottom troppo scuro).
// V14.3 — Troppo chiaro (#ffffff → #c8). Mesh bianche su bianco = invisibili.
// V14.2 — Troppo scuro (bordi #4a). Mesh "nere" sulle normali laterali.
// V14.1 — Ceramica (bordi #c0). Ancora percepito cromato.
//
// Contratto architetturale V14.0:
//   - Path primario: DRACOLoader richiede Upper.drc (8-12x < Upper.stl).
//   - Fallback automatico a STL per progetti legacy (senza .drc).
//   - mesh.name è SEMPRE "Upper.stl" anche se il file servito è .drc
//     (backward compat con tutto il sistema di lookup mesh).
//   - mesh_pivots.json usa chiavi .stl → cleanName dal path originale.
//   - NESSUN geometry.translate — i vertici restano come li ha lo scanner.
//   - Bite-Safe V13.0 invariato: nessuna modifica alle coordinate operative.
// ═══════════════════════════════════════════════════════════════

export class MeshLoader {
    constructor(projectId, token) {
        this.projectId = projectId;
        this.token = token;
        this.loader = new STLLoader();
        this.dracoLoader = new DRACOLoader();
        this.dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/');
        // ColorReady L11.2 (2026-07-24): il .drc porterà il colore per-vertice come
        // uint8 0-255 (verificato server-side L11.1: DracoPy.encode accetta SOLO uint8;
        // float32 → AssertionError). Istruiamo il decoder a restituire l'attributo COLOR
        // come Uint8Array → three imposta attribute.normalized=true → getX/setXYZ applicano
        // denormalize e _assignVertexColorSpace fa sRGB→Linear sui valori 0..1 corretti.
        // 🔴 MAI lasciare il default 'Float32Array' qui: Draco reinterpreterebbe i byte come
        // float 0..255 con normalized=false → mesh BIANCHE bruciate (recon L11.0 §2.3).
        // Inerte finché nessun .drc porta COLOR (il canale colore arriva in L11.3).
        this.dracoLoader.defaultAttributeTypes.color = 'Uint8Array';
        this.dracoLoader.preload();        // Pre-fetch WASM decoder in parallelo con tutto il resto
        this.matcapTexture = this.createProceduralMatCap();
        this._pivotManifest = null;        // Cache del manifest pivot
        this._pivotManifestPromise = null; // Dedup per chiamate concorrenti
    }

    /**
     * MatCap procedurale "Clinical White" — luce a 45° dall'alto-sinistra.
     * Struttura esattamente come da specifiche:
     *   1. Clip circolare (raggio 255, centro 256,256)
     *   2. Fill base #f2f1ef
     *   3. Highlight radial (97,82; 1→184; alpha 0.98→0)
     *   4. Ombra radial (397,410; 51→307; alpha 0.32→0)
     *   5. Rim scuro radial (256,256; 141→255; alpha 0→0.22)
     */
    createProceduralMatCap() {
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');

        // 1. Clip circolare — applicato PRIMA di ogni altro disegno
        ctx.beginPath();
        ctx.arc(256, 256, 255, 0, Math.PI * 2);
        ctx.clip();

        // 2. Fill base
        ctx.fillStyle = '#f2f1ef';
        ctx.fillRect(0, 0, size, size);

        // 3. Highlight luce (alto-sinistra, ~38% del raggio)
        const hl = ctx.createRadialGradient(97, 82, 1, 97, 82, 184);
        hl.addColorStop(0, 'rgba(255,255,255,0.98)');
        hl.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = hl;
        ctx.fillRect(0, 0, size, size);

        // 4. Ombra opposta (basso-destra)
        const sh = ctx.createRadialGradient(397, 410, 51, 397, 410, 307);
        sh.addColorStop(0, 'rgba(0,0,0,0.32)');
        sh.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = sh;
        ctx.fillRect(0, 0, size, size);

        // 5. Rim scuro sul bordo (dal centro verso i bordi)
        const rim = ctx.createRadialGradient(256, 256, 141, 256, 256, 255);
        rim.addColorStop(0, 'rgba(0,0,0,0)');
        rim.addColorStop(1, 'rgba(0,0,0,0.22)');
        ctx.fillStyle = rim;
        ctx.fillRect(0, 0, size, size);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        return texture;
    }

    /**
     * Carica il manifest dei pivot generato da Blender INIT_PROJECT.
     * Il manifest è un JSON { "filename.stl": [x, y, z], ... }
     */
    async loadPivotManifest() {
        if (this._pivotManifest) return this._pivotManifest;
        // Dedup: se c'è già una fetch in corso (chiamate parallele da loadAssets),
        // attende la stessa Promise invece di lanciare un'altra richiesta di rete.
        if (!this._pivotManifestPromise) {
            const url = `/?action=serve_file&project_id=${this.projectId}&file=mesh_pivots.json`;
            this._pivotManifestPromise = fetch(url, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            }).then(resp => {
                if (resp.ok) return resp.json();
                console.warn('[MeshLoader] mesh_pivots.json non trovato — fallback a BBox center');
                return {};
            }).catch(e => {
                console.warn('[MeshLoader] Errore caricamento pivot manifest:', e);
                return {};
            });
        }
        this._pivotManifest = await this._pivotManifestPromise;
        console.log(`[MeshLoader] Pivot manifest caricato: ${Object.keys(this._pivotManifest).length} mesh`);
        return this._pivotManifest;
    }

    async load(options) {
        const path       = (typeof options === 'string') ? options : options.path;
        const bustCache  = (typeof options === 'object')  ? (options.bustCache === true) : false;
        // fromMaster: se true, aggiunge &from=master all'URL serve_file, che skippa
        // la priority su preview/ e serve direttamente i master scanner-space da
        // active/. Usato da BakeEngine.revertToMaster quando i nodi tool vengono
        // rimossi dal DAG e serve ripristinare visivamente lo stato iniziale.
        const fromMaster = (typeof options === 'object')  ? (options.fromMaster === true) : false;
        // cleanName è SEMPRE il nome .stl (es. "Upper.stl") — usato per tutti i lookup mesh.
        // Invariato anche quando il file servito è .drc (backward compat con tutto il sistema).
        const cleanName = path.split('/').pop();
        const cacheBust = bustCache ? `&t=${Date.now()}` : '';
        const fromQ     = fromMaster ? `&from=master` : '';

        // Richiede Upper.drc (8-12x più piccolo di Upper.stl)
        const drcPath = path.replace(/\.stl$/i, '.drc');
        const drcUrl  = `/?action=serve_file&project_id=${this.projectId}&file=${encodeURIComponent(drcPath)}${cacheBust}${fromQ}`;

        let geometry = null;

        try {
            // Path primario: DRACOLoader (nativo, gestisce il fetch internamente)
            geometry = await new Promise((resolve, reject) =>
                this.dracoLoader.load(drcUrl, resolve, undefined, reject)
            );
            console.log(`[MeshLoader] ${cleanName}: caricato via Draco`);
        } catch (dracoErr) {
            // Fallback STL per progetti legacy (senza .drc) o errori transitori
            console.warn(`[MeshLoader] Draco fallback → STL per ${cleanName}:`, dracoErr?.message || dracoErr);
            const stlUrl  = `/?action=serve_file&project_id=${this.projectId}&file=${encodeURIComponent(path)}${cacheBust}${fromQ}`;
            const resp    = await fetch(stlUrl, { headers: { 'Authorization': `Bearer ${this.token}` } });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} per ${cleanName}`);
            geometry = this.loader.parse(await resp.arrayBuffer());
            console.log(`[MeshLoader] ${cleanName}: caricato via STL fallback`);
        }

        geometry.computeVertexNormals();
        geometry.computeBoundingBox();

        // Sculpt V2 Sessione 1: BVH per raycast accelerato + shapecast.
        // Guard sul prototype perché IbexCore patcha una sola volta al bootstrap;
        // se MeshLoader fosse istanziato in un contesto senza la patch, evita il crash.
        if (typeof geometry.computeBoundsTree === 'function') {
            geometry.computeBoundsTree();
        }

        // Sculpt V2 Sessione 3 (post-feedback): flatShading: true — shade FLAT
        // come richiesto dall'utente. Il matcap viene ora calcolato con normali
        // face-uniform (derivata via dFdx/dFdy nel fragment shader), eliminando
        // l'effetto smooth interpolato e rispecchiando l'aspetto "Meshmixer base".
        const material = new THREE.MeshMatcapMaterial({
            color: 0xffffff, matcap: this.matcapTexture, side: THREE.DoubleSide, flatShading: true,
            // ColorReady L11.2: colore per-vertice SOLO se l'attributo esiste DAVVERO su
            // QUESTA mesh. Il define USE_COLOR dipende dal materiale, non dalla geometria:
            // 🔴 un `vertexColors:true` fisso senza attributes.color → WebGL fornisce il
            // default (0,0,0) → mesh NERA (recon L11.0 §2.4).
            // ColorReady L11.3 (fix L2): il materiale nasce coerente col toggle GLOBALE
            // (colorMode), non solo con la presenza dell'attributo → evita 1 frame di colore
            // al full-load quando colorMode è OFF (il rAF continuo lo renderebbe visibile
            // prima che update() riconcili). Stessa formula del gate di update().
            vertexColors: !!geometry.attributes.color && !!window.ibex?.outlinerMgr?.colorMode
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = cleanName;   // "Upper.stl" — SEMPRE .stl, anche se caricato da .drc

        // V14.0: Pivot dal manifest Blender (priorità) o BBox center (fallback).
        // mesh_pivots.json usa chiavi .stl → cleanName è già corretto.
        // NON modifica i vertici — serve solo a ToolExecutor per la formula
        // M_local = T_pivot × M_user × T_neg_pivot
        const manifest = await this.loadPivotManifest();
        if (manifest[cleanName]) {
            const p = manifest[cleanName];
            mesh.userData.pivot = new THREE.Vector3(p[0], p[1], p[2]);
            console.log(`[MeshLoader] ${cleanName}: pivot da manifest [${p[0].toFixed(2)}, ${p[1].toFixed(2)}, ${p[2].toFixed(2)}]`);
        } else {
            // Fallback: calcola dal BBox della geometry (utile per mesh post-bake)
            const center = new THREE.Vector3();
            geometry.boundingBox.getCenter(center);
            mesh.userData.pivot = center;
            console.log(`[MeshLoader] ${cleanName}: pivot da BBox [${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}]`);
        }

        return mesh;
    }

    /**
     * Ricalcola il pivot dal BBox della geometria corrente dopo un hot-swap.
     * Bug RC-1 fix: dopo hotSwapMeshes(), la geometria cambia (vertici in WS),
     * quindi il pivot salvato in userData diventa stale.
     * API pubblica di MeshLoader; attualmente 0 chiamanti (NON chiamato da BakeEngine).
     * NON chiamare dopo hotSwap: il pivot scanner resta fisso (Inv. 31/§20), altrimenti jump.
     *
     * @param {THREE.Mesh} mesh - Il mesh di cui aggiornare il pivot
     * @returns {THREE.Vector3|null} Il nuovo pivot (BBox center), o null se fallisce
     */
    recomputePivot(mesh) {
        if (!mesh || !mesh.geometry) return null;
        mesh.geometry.computeBoundingBox();
        const center = new THREE.Vector3();
        mesh.geometry.boundingBox.getCenter(center);
        mesh.userData.pivot = center.clone();
        return center;
    }

    /**
     * V16.3 — Face Orientation overlay material (Blender-style).
     * Singleton lazy: shared fra TUTTE le mesh, costo memoria zero.
     * Uso: ContextInspector toggle "Orient" + OutlinerManager re-apply
     * post hot-swap. BLU = normale verso esterno (winding corretta),
     * ROSSO = normale invertita. Strumento diagnostico per identificare
     * face flipped (es. zona piena Upper post-modelgenerator hollow).
     */
    getOrientationMaterial() {
        if (this._orientationMaterial) return this._orientationMaterial;
        this._orientationMaterial = new THREE.ShaderMaterial({
            side: THREE.DoubleSide,
            depthWrite: true,                       // compat OutlinePass NormalBlending (SceneManager V7.4)
            depthTest: true,
            vertexShader: `
                void main() {
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                void main() {
                    if (gl_FrontFacing) {
                        gl_FragColor = vec4(0.20, 0.45, 0.95, 1.0);  // blu Blender ~#3373F2
                    } else {
                        gl_FragColor = vec4(0.95, 0.20, 0.20, 1.0);  // rosso Blender ~#F23333
                    }
                }
            `,
        });
        return this._orientationMaterial;
    }
}