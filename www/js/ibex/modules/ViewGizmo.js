// ═══════════════════════════════════════════════════════════════
// IBEX ViewGizmo ViewGizmo_V4.3 — final clean style
//
// V4.3 (2026-05-04):
//   - Pallini POSITIVI riempiti, raggio 6px, con label X/Y/Z bianca dentro
//   - Pallini NEGATIVI VUOTI (solo bordo), raggio 4px — Blender-style.
//     Più leggeri, coerenti col peso visivo della linea sottile.
//   - Coerenza alpha tra linea e pallino: usato `rgba(...)` esplicito al posto
//     di `globalAlpha` (che dava resa diversa tra stroke e fill su alcuni
//     browser/setting). ALPHA_POS=1.0, ALPHA_NEG=0.55.
//   - Rimosse cornici di debug (rosso widget, verde canvas).
//   - Rimossi tutti i console.log diagnostici.
//   - Rimosso DOT centrale arancione di diagnostica.
//
// V4.2 (2026-05-04): diagnostic logs + visible debug borders.
// V4.1 (2026-05-04):
//   - Rimosso TUTTO il chrome del widget (no background, no border, no
//     shadow di default). Si vede SOLO il canvas con gli assi disegnati.
//   - Rimosso DPR scaling (canvas 1:1 px). Più semplice, niente bug
//     di transform persa. Su Retina leggermente blurry, accettabile.
//   - Aggiunto DIAGNOSTIC: dot arancione 3px sempre disegnato al centro.
//     Se vedi il dot ma non gli assi → bug 3D math/dati AXES.
//     Se NON vedi il dot → bug init canvas (ctx invalid).
//   - try/catch attorno a tick() con console.error per esporre errori.
//   - Allocazione fresh di Quaternion+Vector3 ogni frame (no _temp__
//     riuso che potrebbe avere stato condiviso bug).
//
// V4.0 (2026-05-04):
//   ABBANDONATO ViewHelper Three.js / integrazione main renderer dopo
//   3 tentativi falliti (V2.0 dedicated canvas, V3.0 setViewport override,
//   V3.1 manual WebGL render, V3.2 defensive state reset). Troppi punti
//   di fallimento (autoClear, render target, scissor, depth state, multi-
//   contesto WebGL, layout DOM vs canvas).
//   Approccio NUOVO: <canvas> 2D in DOM. Disegno 3 assi crossed manualmente
//   con CanvasRenderingContext2D ad ogni frame applicando l'inverso della
//   quaternion della camera ai vettori (1,0,0), (0,1,0), (0,0,1) e proiet-
//   tando in 2D. Sicuro come una calcolatrice — niente shader, niente GL.
//   Click su un asse → snap a vista cardinale corrispondente. Click in
//   zona vuota → toggle del menu collassabile (preset + viste salvate).
//
//   Trade-off accettati:
//     - Look "diagrammatico" (linee piatte) anziché 3D rendered (cube/sprite).
//       L'utente ha esplicitamente accettato "anche gli assi incrociati come
//       sul widget di Blender" — coerente.
//     - No depth-based opacity automatica. Lo replichiamo sortando per
//       distanza dalla camera + alpha 0.4 sui semi-assi negativi.
//
//   Click handling: hit-test sulle coordinate 2D dei circoli endpoint.
//   Tolleranza HIT_RADIUS (14px). Click fuori cerchi → toggle expand.
//
// V3.x (2026-05-04): tentativi WebGL falliti, archiviati nel git.
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
// T1Escape_29-7 — `_escapeHtml` locale collassato nell'util condiviso.
import { escapeHtml } from './dom-escape.js?v=T1Escape_29-7';

const GIZMO_SIZE_PX = 96;     // dimensione totale canvas (era 128)
const HIT_RADIUS    = 10;     // raggio hit-test endpoint per click
const RING_RADIUS   = 5;      // raggio cerchio asse positivo (riempito + label)
const RING_RADIUS_NEG = 3.5;  // raggio cerchio asse negativo (vuoto, bordo solo)
const AXIS_LINE_W   = 1.75;   // spessore linea asse
const AXIS_INSET    = 14;     // spazio dai bordi
const ALPHA_POS     = 1.0;    // alpha asse positivo
const ALPHA_NEG     = 0.55;   // alpha asse negativo (linea + bordo pallino)

// Helper: hex color → rgba string con alpha specifica
function rgba(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
}

// Preset 6 viste cardinali Z-up dental:
const PRESETS = [
    // [label, viewDir (target → camera), up]
    ['Sopra',     [ 0,  0,  1], [0, 1, 0]],   // 0
    ['Sotto',     [ 0,  0, -1], [0, -1, 0]],  // 1
    ['Fronte',    [ 0, -1,  0], [0, 0, 1]],   // 2
    ['Retro',     [ 0,  1,  0], [0, 0, 1]],   // 3
    ['Destra',    [ 1,  0,  0], [0, 0, 1]],   // 4
    ['Sinistra',  [-1,  0,  0], [0, 0, 1]],   // 5
    // P7: vista ¾ odontotecnica (destra-fronte-alto). SOLO append — gli
    // indici 0-5 sono contratto con AXES/_snapToClosest.
    ['3/4',       [ 1, -1, 0.7], [0, 0, 1]],  // 6
];

// Assi del gizmo: ogni voce mappa a un PRESET. Color Blender-like.
// `label` non vuoto = asse positivo (X/Y/Z), label vuoto = negativo (faded).
const AXES = [
    { dir: [ 1,  0,  0], color: '#C4302B', label: 'X', preset: 4 },  // +X = Destra
    { dir: [-1,  0,  0], color: '#C4302B', label: '',  preset: 5 },  // -X = Sinistra
    { dir: [ 0,  1,  0], color: '#1F8A4C', label: 'Y', preset: 3 },  // +Y = Retro
    { dir: [ 0, -1,  0], color: '#1F8A4C', label: '',  preset: 2 },  // -Y = Fronte
    { dir: [ 0,  0,  1], color: '#2A6FDB', label: 'Z', preset: 0 },  // +Z = Sopra
    { dir: [ 0,  0, -1], color: '#2A6FDB', label: '',  preset: 1 },  // -Z = Sotto
];

export class ViewGizmo {
    constructor(ibex) {
        this.ibex = ibex;
        this.sceneMgr = ibex.sceneMgr;
        this.camera = this.sceneMgr.camera;
        this.controls = this.sceneMgr.controls;

        // Build UI: canvas 2D + content collassabile
        this._buildUI();

        // Click handler sul canvas 2D
        this._gizmoCanvas.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            // Se clip mode è attiva, click sinistro sul widget ESCE dalla modalità
            // (escape route alternativa al bottone "Esci sezione" e ad Esc).
            if (this._clipActive) {
                e.stopPropagation();
                this._exitClipMode();
                return;
            }
            if (this._tryAxisClick(e)) {
                e.stopPropagation();
                return;
            }
            // No-axis click → toggle expand
            this._uiWrap.classList.toggle('expanded');
        });

        // Click fuori widget → collapse
        document.addEventListener('mousedown', (e) => {
            if (this._uiWrap.classList.contains('expanded') &&
                !this._uiWrap.contains(e.target)) {
                this._uiWrap.classList.remove('expanded');
            }
        });

        // ALT+B → toggle sezione box (Blender shortcut)
        document.addEventListener('keydown', (e) => {
            if (e.altKey && (e.key === 'b' || e.key === 'B')) {
                e.preventDefault();
                this.toggleClipBox();
            }
        });

        // Stato sezione box (clipping planes)
        this._clipActive = false;
        this._clipDrawing = false;

        // Saved views da session_settings (ManifestSoT V3.0)
        this.savedViews = [];
        const initialViews = this.ibex.config?.sessionSettings?.saved_views;
        if (Array.isArray(initialViews)) {
            this.savedViews = initialViews.filter(v => v && v.name && Array.isArray(v.position));
        }
        this._renderSavedViewsList();

    }

    // ─── Render loop hook (chiamato da SceneManager.render) ─────
    tick() {
        this._drawAxes2D();
    }

    // ─── 2D canvas drawing degli assi cross-shaped ──────────────
    _drawAxes2D() {
        const ctx = this._ctx;
        if (!ctx) return;
        const camera = this.camera;
        if (!camera) return;

        const size = GIZMO_SIZE_PX;
        const center = size / 2;
        const radius = center - AXIS_INSET;

        ctx.clearRect(0, 0, size, size);

        const q = new THREE.Quaternion().copy(camera.quaternion).invert();

        const items = AXES.map(ax => {
            const v = new THREE.Vector3(ax.dir[0], ax.dir[1], ax.dir[2]).applyQuaternion(q);
            return {
                ax,
                sx: center + v.x * radius,
                sy: center - v.y * radius,
                depth: v.z,
            };
        });

        // Sort back-to-front (depth crescente = più vicino → disegnato dopo)
        items.sort((a, b) => a.depth - b.depth);

        // Draw axes — usiamo rgba() esplicito (NO globalAlpha) per uniformare
        // la resa visiva tra stroke (linea) e fill (pallino).
        for (const it of items) {
            const isPositive = it.ax.label !== '';
            const a = isPositive ? ALPHA_POS : ALPHA_NEG;
            const color = rgba(it.ax.color, a);

            // Linea dal centro. Per gli assi NEGATIVI, accorciamo la linea
            // di RING_RADIUS_NEG lungo la sua direzione, così termina alla
            // CIRCONFERENZA del pallino vuoto (non al suo centro).
            let endX = it.sx;
            let endY = it.sy;
            if (!isPositive) {
                const dx = it.sx - center;
                const dy = it.sy - center;
                const len = Math.hypot(dx, dy);
                if (len > RING_RADIUS_NEG) {
                    const t = (len - RING_RADIUS_NEG) / len;
                    endX = center + dx * t;
                    endY = center + dy * t;
                }
            }

            ctx.strokeStyle = color;
            ctx.lineWidth = AXIS_LINE_W;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(center, center);
            ctx.lineTo(endX, endY);
            ctx.stroke();

            if (isPositive) {
                // Pallino positivo: pieno + label
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(it.sx, it.sy, RING_RADIUS, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 8px Ubuntu, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(it.ax.label, it.sx, it.sy + 0.5);
            } else {
                // Pallino negativo: solo bordo (Blender-style — leggero, coerente
                // con la sottigliezza della linea negativa)
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.25;
                ctx.beginPath();
                ctx.arc(it.sx, it.sy, RING_RADIUS_NEG, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }

    // ─── Hit-test click su un asse ──────────────────────────────
    _tryAxisClick(e) {
        const rect = this._gizmoCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const center = GIZMO_SIZE_PX / 2;
        const radius = center - AXIS_INSET;

        const q = new THREE.Quaternion().copy(this.camera.quaternion).invert();

        let closest = null;
        let closestDist = HIT_RADIUS;
        for (const ax of AXES) {
            const v = new THREE.Vector3(ax.dir[0], ax.dir[1], ax.dir[2]).applyQuaternion(q);
            const sx = center + v.x * radius;
            const sy = center - v.y * radius;
            const dist = Math.hypot(x - sx, y - sy);
            if (dist < closestDist) {
                closestDist = dist;
                closest = ax;
            }
        }

        if (closest) {
            this.applyPreset(closest.preset);
            return true;
        }
        return false;
    }

    // ─── UI: widget unico con canvas 2D + content collassabile ──
    _buildUI() {
        if (document.getElementById('ibex-view-gizmo-ui')) return;
        const wrap = document.createElement('div');
        wrap.id = 'ibex-view-gizmo-ui';

        // Canvas 2D dedicato (1:1, niente DPR scaling per semplicità).
        // Su retina sarà leggermente blurry ma è un trade-off accettabile
        // per evitare bug di transform persa.
        const cnv = document.createElement('canvas');
        cnv.width = GIZMO_SIZE_PX;
        cnv.height = GIZMO_SIZE_PX;
        cnv.style.width = GIZMO_SIZE_PX + 'px';
        cnv.style.height = GIZMO_SIZE_PX + 'px';
        cnv.style.display = 'block';
        cnv.style.cursor = 'pointer';
        cnv.className = 'ibex-vg-canvas';
        cnv.title = 'Click su un asse per ruotare la vista, click al centro per opzioni';
        this._gizmoCanvas = cnv;

        const ctx = cnv.getContext('2d');
        this._ctx = ctx;
        if (!ctx) console.error('[ViewGizmo] failed to get 2D context');

        wrap.appendChild(cnv);

        // Content collassabile (preset + helpers + clip box + saved views)
        const content = document.createElement('div');
        content.className = 'ibex-vg-content';
        content.innerHTML = `
            <div class="ibex-vg-preset-list">
                ${PRESETS.map((p, i) =>
                    `<button class="ibex-vg-preset-btn" data-preset-idx="${i}" title="Vista ${p[0]}">${p[0]}</button>`
                ).join('')}
            </div>
            <div class="ibex-vg-toggles-row">
                <button class="ibex-vg-toggle-btn active" data-toggle="grid" title="Mostra/nascondi griglia viewport">
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M2 6 L14 6 M2 10 L14 10 M6 2 L6 14 M10 2 L10 14"/>
                        <rect x="2" y="2" width="12" height="12" rx="0.5"/>
                    </svg>
                    <span>Griglia</span>
                </button>
                <button class="ibex-vg-toggle-btn active" data-toggle="axes" title="Mostra/nascondi assi viewport">
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                        <line x1="8" y1="14" x2="8" y2="3"/>
                        <line x1="3" y1="13" x2="14" y2="13"/>
                        <line x1="4" y1="12" x2="11" y2="5"/>
                    </svg>
                    <span>Assi</span>
                </button>
                <button class="ibex-vg-toggle-btn ibex-vg-fit-btn" data-action="fit" title="Inquadra tutto il modello (F)">
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M2 5V2h3 M11 2h3v3 M14 11v3h-3 M5 14H2v-3"/>
                    </svg>
                    <span>Inquadra</span>
                </button>
            </div>
            <div class="ibex-vg-clip-section">
                <button class="ibex-vg-clip-btn" title="Sezione box (ALT+B): trascina un rettangolo sulla viewport per ritagliare la scena">
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="9" height="9" stroke-dasharray="2 1.5"/><path d="M11 3 L14 6 L14 12 L11 12"/><path d="M5 3 L8 6 M11 12 L8 9 M11 6 L8 6 L8 9"/></svg>
                    <span>Sezione box</span>
                </button>
            </div>
            <div class="ibex-vg-saved-section">
                <div class="ibex-vg-saved-head">
                    <span class="ibex-vg-saved-label">Viste salvate</span>
                    <button class="ibex-vg-save-btn" title="Salva vista corrente">+ Salva</button>
                </div>
                <div class="ibex-vg-saved-list"></div>
            </div>
        `;
        wrap.appendChild(content);

        document.body.appendChild(wrap);
        this._uiWrap = wrap;

        // Bind preset buttons
        wrap.querySelectorAll('.ibex-vg-preset-btn').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.presetIdx, 10);
                this.applyPreset(idx);
            };
        });

        // Bind save button
        wrap.querySelector('.ibex-vg-save-btn').onclick = () => this._promptSaveCurrentView();

        // Bind clip box button
        wrap.querySelector('.ibex-vg-clip-btn').onclick = () => this.toggleClipBox();

        // Bind helper toggles (griglia/assi del viewport 3D — NON gli assi del widget)
        wrap.querySelectorAll('.ibex-vg-toggle-btn').forEach(btn => {
            btn.onclick = () => {
                const target = btn.dataset.toggle;
                const sm = this.sceneMgr;
                if (target === 'grid' && sm.gridHelper) {
                    sm.gridHelper.visible = !sm.gridHelper.visible;
                    btn.classList.toggle('active', sm.gridHelper.visible);
                } else if (target === 'axes' && sm.axesHelper) {
                    sm.axesHelper.visible = !sm.axesHelper.visible;
                    btn.classList.toggle('active', sm.axesHelper.visible);
                }
                sm.render();
            };
            // Sync iniziale con stato corrente
            const target = btn.dataset.toggle;
            const sm = this.sceneMgr;
            if (target === 'grid' && sm.gridHelper) {
                btn.classList.toggle('active', sm.gridHelper.visible);
            } else if (target === 'axes' && sm.axesHelper) {
                btn.classList.toggle('active', sm.axesHelper.visible);
            }
        });

        // UX-A batch2 — bind "Inquadra" (fit-all). Dopo il loop toggle così
        // sovrascrive l'onclick generico ereditato da .ibex-vg-toggle-btn.
        const _fitBtn = wrap.querySelector('.ibex-vg-fit-btn');
        if (_fitBtn) _fitBtn.onclick = () => this.fitAll();
    }

    _renderSavedViewsList() {
        if (!this._uiWrap) return;
        const list = this._uiWrap.querySelector('.ibex-vg-saved-list');
        if (!list) return;
        if (!this.savedViews.length) {
            list.innerHTML = `<div class="ibex-vg-saved-empty"><em>Nessuna vista salvata.</em></div>`;
            return;
        }
        list.innerHTML = this.savedViews.map((v, i) => `
            <div class="ibex-vg-saved-row" data-idx="${i}">
                <button class="ibex-vg-saved-recall" title="Vai a questa vista">${escapeHtml(v.name)}</button>
                <button class="ibex-vg-saved-rename" title="Rinomina">✏</button>
                <button class="ibex-vg-saved-delete" title="Elimina">🗑</button>
            </div>
        `).join('');
        list.querySelectorAll('.ibex-vg-saved-row').forEach(row => {
            const idx = parseInt(row.dataset.idx, 10);
            row.querySelector('.ibex-vg-saved-recall').onclick = () => this.recallView(idx);
            row.querySelector('.ibex-vg-saved-rename').onclick = () => this._promptRenameView(idx);
            row.querySelector('.ibex-vg-saved-delete').onclick = () => this._deleteView(idx);
        });
    }

    // ─── Preset application ─────────────────────────────────────
    applyPreset(idx) {
        const p = PRESETS[idx];
        if (!p) return;
        const [_, dir, up] = p;

        const target = this.controls.target.clone();
        const dist = this._computeFitDistance();
        const dirVec = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
        const newPos = target.clone().addScaledVector(dirVec, dist);

        this._animateTo(newPos, target, new THREE.Vector3(up[0], up[1], up[2]));
    }

    _computeFitDistance() {
        const sceneMgr = this.sceneMgr;
        const group = sceneMgr.group;
        if (!group || !group.children.length) return 100;
        const box = new THREE.Box3().setFromObject(group);
        if (box.isEmpty()) return 100;
        const size = box.getSize(new THREE.Vector3()).length();
        return size * 1.4;
    }

    // UX-A batch2 — Inquadra tutto: bbox scena → centro + distanza fov-aware,
    // direzione camera corrente preservata. View-only (nessun undo).
    fitAll() {
        const group = this.sceneMgr.group;
        if (!group || !group.children.length) return;
        const box = new THREE.Box3().setFromObject(group);
        if (box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const fov = (this.camera.fov || 45) * Math.PI / 180;
        let dist = (maxDim / 2) / Math.tan(fov / 2);
        dist *= 1.6;
        let dir = this.camera.position.clone().sub(this.controls.target);
        if (dir.lengthSq() < 1e-6) dir = new THREE.Vector3(0, -1, 0.3);
        dir.normalize();
        const newPos = center.clone().addScaledVector(dir, dist);
        this._animateTo(newPos, center, this.camera.up.clone());
    }

    _animateTo(targetPosition, targetLookAt, targetUp, duration = 500) {
        const startPos = this.camera.position.clone();
        const startTarget = this.controls.target.clone();
        const startUp = this.camera.up.clone();
        const t0 = performance.now();
        const ease = (t) => t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2;

        const step = () => {
            const elapsed = performance.now() - t0;
            const t = Math.min(1, elapsed / duration);
            const k = ease(t);
            this.camera.position.lerpVectors(startPos, targetPosition, k);
            this.controls.target.lerpVectors(startTarget, targetLookAt, k);
            this.camera.up.lerpVectors(startUp, targetUp, k).normalize();
            this.controls.update();
            if (t < 1) requestAnimationFrame(step);
        };
        step();
    }

    // ─── Sezione box (clipping planes 3D, stile Blender ALT+B) ──
    // Toggle: se attivo → esce dalla modalità clip (restore mouse + clear
    // planes). Se inattivo → entra in modalità clip persistente:
    //   • LEFT click+drag = disegna/ridisegna il rettangolo di clip
    //   • WHEEL button drag = ruota la camera (sostituisce LEFT default)
    //   • RIGHT button = pan (invariato)
    //   • Wheel scroll = zoom (invariato)
    // L'Esc esce dalla modalità in qualsiasi momento.
    toggleClipBox() {
        if (this._clipActive) {
            this._exitClipMode();
        } else {
            this._enterClipMode();
        }
        this._uiWrap.classList.remove('expanded');
    }

    _enterClipMode() {
        const renderer = this.sceneMgr.renderer;
        const canvas = renderer.domElement;
        const controls = this.controls;

        // Salva mouseButtons originali e riconfigura: LEFT disabilitato,
        // MIDDLE (rotellina) ruota.
        this._origMouseButtons = { ...controls.mouseButtons };
        controls.mouseButtons = {
            LEFT:   null,                 // disabilitato — LEFT è per ridisegnare clip
            MIDDLE: THREE.MOUSE.ROTATE,   // wheel button = orbit
            RIGHT:  this._origMouseButtons.RIGHT ?? THREE.MOUSE.PAN,
        };
        // Pezzo 2b: libera 1-dito/pen per il rect di sezione; 2-dita = pan/zoom.
        this._origTouches = { ...(controls.touches || {}) };
        controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_PAN };

        // Listener LEFT persistente sul canvas → avvia drag rect
        this._clipMouseDownHandler = (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (this._uiWrap.contains(e.target)) return;
            if (this._clipDragging) return;
            e.stopPropagation();
            e.preventDefault();
            try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
            this._startClipDrag(e);
        };
        canvas.addEventListener('pointerdown', this._clipMouseDownHandler, true);

        // Esc → esci dalla modalità
        this._clipKeyHandler = (e) => {
            if (e.key === 'Escape') this._exitClipMode();
        };
        window.addEventListener('keydown', this._clipKeyHandler);

        canvas.style.cursor = 'crosshair';
        this._uiWrap.classList.add('clip-mode'); // disabilita click sul gizmo
        this._clipActive = true;
        this._updateClipButtonState();

        this.ibex.uiMgr?.notify?.('Sezione attiva. LEFT trascina per ridisegnare · Rotellina per ruotare · Click sul widget / Esc per uscire.', 'info');
    }

    _exitClipMode() {
        const renderer = this.sceneMgr.renderer;
        const canvas = renderer.domElement;
        const controls = this.controls;

        // Restore mouseButtons originali
        if (this._origMouseButtons) {
            controls.mouseButtons = this._origMouseButtons;
            this._origMouseButtons = null;
        }
        // Pezzo 2b: ripristina touches
        if (this._origTouches) {
            controls.touches = this._origTouches;
            this._origTouches = null;
        }

        // Rimuovi handler persistenti
        if (this._clipMouseDownHandler) {
            canvas.removeEventListener('pointerdown', this._clipMouseDownHandler, true);
            this._clipMouseDownHandler = null;
        }
        if (this._clipKeyHandler) {
            window.removeEventListener('keydown', this._clipKeyHandler);
            this._clipKeyHandler = null;
        }

        // Cleanup overlay drag se ancora visibile
        if (this._clipOverlay) {
            this._clipOverlay.remove();
            this._clipOverlay = null;
        }
        this._clipDragging = false;

        canvas.style.cursor = '';
        this._uiWrap.classList.remove('clip-mode');
        renderer.clippingPlanes = [];
        this._clipActive = false;
        this._updateClipButtonState();
    }

    _startClipDrag(downEvent) {
        const sx = downEvent.clientX, sy = downEvent.clientY;
        this._clipDragging = true;

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; pointer-events: none; z-index: 60;
            border: 1px dashed #FF6037; background: rgba(255,96,55,0.08);
            left: ${sx}px; top: ${sy}px; width: 0px; height: 0px;
        `;
        document.body.appendChild(overlay);
        this._clipOverlay = overlay;

        const onMove = (e) => {
            const x = Math.min(sx, e.clientX);
            const y = Math.min(sy, e.clientY);
            const w = Math.abs(e.clientX - sx);
            const h = Math.abs(e.clientY - sy);
            overlay.style.left = x + 'px';
            overlay.style.top = y + 'px';
            overlay.style.width = w + 'px';
            overlay.style.height = h + 'px';
        };

        const onUp = (e) => {
            const ex = e.clientX, ey = e.clientY;
            overlay.remove();
            this._clipOverlay = null;
            this._clipDragging = false;
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            // Applica clip solo se rect significativo
            if (Math.abs(ex - sx) > 4 && Math.abs(ey - sy) > 4) {
                this._applyClipBoxFromRect(sx, sy, ex, ey);
            }
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
    }

    // Calcola 4 piani di clipping (left/right/top/bottom) dal rettangolo
    // schermo. I piani sono in WORLD SPACE (statici dopo l'applicazione →
    // la camera può orbitare e mostrare la box da angoli diversi, come Blender).
    _applyClipBoxFromRect(x1, y1, x2, y2) {
        const renderer = this.sceneMgr.renderer;
        const camera = this.camera;
        const rect = renderer.domElement.getBoundingClientRect();

        // Conversione client px → NDC [-1, 1]
        const nx1 = (Math.min(x1, x2) - rect.left) / rect.width * 2 - 1;
        const nx2 = (Math.max(x1, x2) - rect.left) / rect.width * 2 - 1;
        const ny1 = -((Math.max(y1, y2) - rect.top) / rect.height * 2 - 1); // flip Y
        const ny2 = -((Math.min(y1, y2) - rect.top) / rect.height * 2 - 1);

        // 4 corner del rect in NDC, alle profondità near (z=-1) e far (z=1)
        const cornersNear = [
            new THREE.Vector3(nx1, ny1, -1).unproject(camera), // BL
            new THREE.Vector3(nx2, ny1, -1).unproject(camera), // BR
            new THREE.Vector3(nx2, ny2, -1).unproject(camera), // TR
            new THREE.Vector3(nx1, ny2, -1).unproject(camera), // TL
        ];
        const cornersFar = [
            new THREE.Vector3(nx1, ny1,  1).unproject(camera),
            new THREE.Vector3(nx2, ny1,  1).unproject(camera),
            new THREE.Vector3(nx2, ny2,  1).unproject(camera),
            new THREE.Vector3(nx1, ny2,  1).unproject(camera),
        ];

        // Centro frustum (interior point per orientare le normali verso il dentro)
        const center = new THREE.Vector3()
            .add(cornersNear[0]).add(cornersNear[1])
            .add(cornersNear[2]).add(cornersNear[3])
            .add(cornersFar[0]).add(cornersFar[1])
            .add(cornersFar[2]).add(cornersFar[3])
            .multiplyScalar(1 / 8);

        // 4 piani laterali del frustum (left, right, bottom, top)
        const planes = [
            // LEFT: TL, BL, BL_far
            new THREE.Plane().setFromCoplanarPoints(cornersNear[3], cornersNear[0], cornersFar[0]),
            // RIGHT: BR, TR, TR_far
            new THREE.Plane().setFromCoplanarPoints(cornersNear[1], cornersNear[2], cornersFar[2]),
            // BOTTOM: BL, BR, BR_far
            new THREE.Plane().setFromCoplanarPoints(cornersNear[0], cornersNear[1], cornersFar[1]),
            // TOP: TR, TL, TL_far
            new THREE.Plane().setFromCoplanarPoints(cornersNear[2], cornersNear[3], cornersFar[3]),
        ];

        // Garantiamo che le normali puntino VERSO IL DENTRO (toward center)
        for (const plane of planes) {
            if (plane.distanceToPoint(center) < 0) plane.negate();
        }

        renderer.clippingPlanes = planes;
    }

    _updateClipButtonState() {
        const btn = this._uiWrap?.querySelector('.ibex-vg-clip-btn');
        if (!btn) return;
        const span = btn.querySelector('span');
        if (this._clipActive) {
            btn.classList.add('active');
            if (span) span.textContent = 'Esci sezione';
        } else {
            btn.classList.remove('active');
            if (span) span.textContent = 'Sezione box';
        }
    }

    // ─── Save / Recall / Rename / Delete ────────────────────────
    _promptSaveCurrentView() {
        const defaultName = `Vista ${this.savedViews.length + 1}`;
        const name = prompt('Nome della vista:', defaultName);
        if (name == null) return;
        const trimmed = String(name).trim();
        if (!trimmed) return;

        const view = {
            name: trimmed,
            position: this.camera.position.toArray(),
            target:   this.controls.target.toArray(),
            up:       this.camera.up.toArray(),
            created_at: Math.floor(Date.now() / 1000),
        };
        this.savedViews.push(view);
        this._renderSavedViewsList();
        this.ibex.uiMgr?.notify?.(`Vista "${trimmed}" salvata`, 'success');
    }

    recallView(idx) {
        const v = this.savedViews[idx];
        if (!v) return;
        const pos = new THREE.Vector3().fromArray(v.position);
        const tgt = new THREE.Vector3().fromArray(v.target);
        const up  = new THREE.Vector3().fromArray(v.up);
        this._animateTo(pos, tgt, up);
    }

    _promptRenameView(idx) {
        const v = this.savedViews[idx];
        if (!v) return;
        const newName = prompt('Nuovo nome:', v.name);
        if (newName == null) return;
        const trimmed = String(newName).trim();
        if (!trimmed) return;
        v.name = trimmed;
        this._renderSavedViewsList();
    }

    _deleteView(idx) {
        const v = this.savedViews[idx];
        if (!v) return;
        if (!confirm(`Eliminare la vista "${v.name}"?`)) return;
        this.savedViews.splice(idx, 1);
        this._renderSavedViewsList();
    }

    getSavedViewsForPersist() {
        return this.savedViews.map(v => ({ ...v }));
    }
}
