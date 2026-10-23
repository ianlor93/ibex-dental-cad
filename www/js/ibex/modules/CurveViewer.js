import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

// ═══════════════════════════════════════════════════════════════
// IBEX CurveViewer CurveViewer_V1.0 (2026-05-12)
//
// Renderer 3D leggero per overlay curve dai datablock `.crv.json`.
// Gestione centralizzata indicizzata per nodeId: ogni nodo che produce
// curve (arch_detect, draw_curve, curve_edit) può chiamare:
//
//   ibex.curveViewer.showCurve(nodeId, splines, { color, withCP, mesh })
//   ibex.curveViewer.hideCurve(nodeId)
//   ibex.curveViewer.toggleCurve(nodeId, ...)
//
// `splines` è il payload del .crv.json (array di {control_points, cyclic}).
// `mesh` (opzionale): se passato, le control_points sono trasformate in
// world space usando mesh.matrixWorld (le curve sono persistite in local
// space — Inv. 117).
// ═══════════════════════════════════════════════════════════════

const _LINE_WIDTH_PX = 4;
const _CP_RADIUS_MM = 0.18;
const _DEFAULT_COLOR = 0x2A6FDB; // blu

export class CurveViewer {
    constructor(ibex) {
        this.ibex = ibex;
        // Map nodeId → { group: THREE.Group, splines, mesh, color }
        this._overlays = new Map();
    }

    /**
     * Mostra o aggiorna la curva per un nodeId.
     * @param {string|number} nodeId
     * @param {Array} splines   - [{ control_points: [[x,y,z],...], cyclic: bool }, ...]
     * @param {Object} options  - { color?, withCP?, mesh? }
     */
    showCurve(nodeId, splines, options = {}) {
        if (!this.ibex.sceneMgr) return;
        if (!Array.isArray(splines) || splines.length === 0) {
            this.hideCurve(nodeId);
            return;
        }
        // Pulisci overlay esistente per questo nodeId (se cambia il contenuto)
        this.hideCurve(nodeId);

        const color  = options.color || _DEFAULT_COLOR;
        const withCP = options.withCP === true;
        const mesh   = options.mesh || null;
        const matWorld = mesh && mesh.matrixWorld
            ? mesh.matrixWorld
            : new THREE.Matrix4(); // identity

        const group = new THREE.Group();
        group.name = `_ibex_curve_viewer_${nodeId}`;
        group.renderOrder = 998;

        const w = window.innerWidth;
        const h = window.innerHeight;

        for (let i = 0; i < splines.length; i++) {
            const sp = splines[i];
            const ptsLocal = (sp.control_points || []).map(p => new THREE.Vector3(p[0], p[1], p[2]));
            if (ptsLocal.length < 2) continue;

            // Local → world
            const ptsWorld = ptsLocal.map(p => p.clone().applyMatrix4(matWorld));
            if (sp.cyclic && ptsWorld.length >= 3) ptsWorld.push(ptsWorld[0].clone());

            const flat = new Float32Array(ptsWorld.length * 3);
            for (let j = 0; j < ptsWorld.length; j++) {
                flat[j*3]     = ptsWorld[j].x;
                flat[j*3 + 1] = ptsWorld[j].y;
                flat[j*3 + 2] = ptsWorld[j].z;
            }
            const geo = new LineGeometry();
            geo.setPositions(flat);
            const mat = new LineMaterial({
                color,
                linewidth: _LINE_WIDTH_PX,
                transparent: true,
                opacity: 0.85,
                depthTest: false,
                dashed: false,
                resolution: new THREE.Vector2(w, h),
            });
            const line = new Line2(geo, mat);
            line.renderOrder = 998;
            group.add(line);

            if (withCP) {
                const sphereGeo = new THREE.SphereGeometry(_CP_RADIUS_MM, 10, 10);
                const sphereMat = new THREE.MeshBasicMaterial({
                    color, depthTest: false, transparent: true, opacity: 0.8
                });
                for (const lp of ptsLocal) {
                    const wp = lp.clone().applyMatrix4(matWorld);
                    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
                    sphere.position.copy(wp);
                    sphere.renderOrder = 999;
                    group.add(sphere);
                }
            }
        }

        this.ibex.sceneMgr.scene.add(group);
        this._overlays.set(String(nodeId), { group, splines, mesh, color, withCP });
        this.ibex.sceneMgr.render?.();
        // V2.6: notifica outliner per renderizzare la curva come oggetto
        this.ibex.outlinerMgr?.update?.();
    }

    hideCurve(nodeId) {
        const key = String(nodeId);
        const entry = this._overlays.get(key);
        if (!entry) return;
        const scene = this.ibex.sceneMgr?.scene;
        if (scene && entry.group) {
            scene.remove(entry.group);
            entry.group.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
        }
        this._overlays.delete(key);
        this.ibex.sceneMgr?.render?.();
        // V2.6: rimuovi anche la riga corrispondente nell'outliner
        this.ibex.outlinerMgr?.update?.();
    }

    /**
     * Toggle: se è già visibile, hide; altrimenti show con i nuovi data.
     * Ritorna true se ora visibile, false se nascosta.
     */
    toggleCurve(nodeId, splines, options = {}) {
        if (this.isVisible(nodeId)) {
            this.hideCurve(nodeId);
            return false;
        }
        this.showCurve(nodeId, splines, options);
        return true;
    }

    isVisible(nodeId) {
        return this._overlays.has(String(nodeId));
    }

    /**
     * V2.6 (2026-05-13) — controllo visibility runtime per Outliner.
     * Toggle del `group.visible` (NON elimina overlay come hideCurve). Permette
     * mostrare/nascondere la curva senza distruggere lo state.
     */
    setOverlayVisible(nodeId, visible) {
        const entry = this._overlays.get(String(nodeId));
        if (!entry || !entry.group) return;
        entry.group.visible = !!visible;
        this.ibex.sceneMgr?.render?.();
    }

    isOverlayVisibleRuntime(nodeId) {
        const entry = this._overlays.get(String(nodeId));
        if (!entry || !entry.group) return false;
        return entry.group.visible !== false;
    }

    /**
     * V2.6 — Itera tutti gli overlay registrati. Usato da OutlinerManager
     * per renderizzare le curve come oggetti di prima classe nell'outliner.
     * Ritorna array di `{ nodeId, entry }`.
     */
    getOverlayEntries() {
        const out = [];
        for (const [nodeId, entry] of this._overlays.entries()) {
            out.push({ nodeId, entry });
        }
        return out;
    }

    hideAll() {
        for (const k of [...this._overlays.keys()]) {
            this.hideCurve(k);
        }
    }

    /**
     * Pause / resume rendering di una curva SENZA dispose. Più efficiente
     * di hideCurve+showCurve perché preserva geometry/material.
     * Usato da CurveEditMode per nascondere le curve upstream durante l'edit
     * (evita doppia curva sovrapposta — overlay arch_detect + curva in editing).
     */
    setEnabled(nodeId, enabled) {
        const entry = this._overlays.get(String(nodeId));
        if (!entry || !entry.group) return false;
        entry.group.visible = !!enabled;
        this.ibex.sceneMgr?.render?.();
        return true;
    }

    /**
     * Ritorna lista node ids attualmente in overlay (visible o nascosti via setEnabled).
     */
    getOverlayNodeIds() {
        return [...this._overlays.keys()];
    }

    /**
     * Ritorna lista node ids che hanno il group attualmente visible=true.
     */
    getVisibleNodeIds() {
        const out = [];
        for (const [k, entry] of this._overlays.entries()) {
            if (entry.group && entry.group.visible) out.push(k);
        }
        return out;
    }

    /**
     * Fetch helper: scarica un `.crv.json` da serve_file e ritorna il payload
     * parsato. Filename relativo all'active_path.
     */
    async fetchCurveFile(fileName) {
        if (!this.ibex.config?.projectId) {
            throw new Error('projectId non disponibile');
        }
        const url = `/?action=serve_file&project_id=${this.ibex.config.projectId}` +
                    `&file=${encodeURIComponent(fileName)}&t=${Date.now()}`;
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        return await resp.json();
    }
}
