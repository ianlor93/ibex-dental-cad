<?php try { ?>
<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <script>/* Config runtime (IbexConfig): unica fonte del JS per origine Nextcloud e lobby. */
    window.IBEX_CONFIG = <?= json_encode(['nextcloudOrigin' => \App\Core\IbexConfig::nextcloudOrigin(), 'lobbyUrl' => \App\Core\IbexConfig::lobbyUrl()], JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES) ?>;</script>
    <script>/* Shell-embed + tema (IBEX.zip v2): ?embed=1 -> header nel chrome; tema da ?theme / localStorage (sync shell) */
    try{ var _p=new URLSearchParams(location.search);
         if(_p.get('embed')==='1') document.documentElement.setAttribute('data-embed','1');
         var _t=_p.get('theme')||localStorage.getItem('ibex_ws:theme');
         if(_t==='dark') document.documentElement.setAttribute('data-theme','dark'); }catch(e){}</script>
    <title>IBEX Editor</title>
    <link rel="icon" href="/static/logo/favicon.svg">
    <link rel="stylesheet" href="/static/css/ibex-fonts.css">
    <!-- S6 (2026-07-10): Drawflow PINNATO @0.0.60 — unpinned = floating latest,
         un tag upstream cambierebbe il motore delle connessioni per tutti senza commit. -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/jerosoler/Drawflow@0.0.60/dist/drawflow.min.css">
    <script src="https://cdn.jsdelivr.net/gh/jerosoler/Drawflow@0.0.60/dist/drawflow.min.js"></script>
    <script type="importmap"> { "imports": { "three": "https://unpkg.com/three@0.160.0/build/three.module.js", "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/", "three-mesh-bvh": "https://unpkg.com/three-mesh-bvh@0.7.8/build/index.module.js", "gl-matrix": "https://esm.sh/gl-matrix@3.4.3" } } </script>

    <style>
        /* ═══════════════════════════════════════════════════════════
           IBEX — Dark Redesign V2 (Fase B+C+D)
           Palette, tipografia, Drawflow, pannelli docked, DAG overlay
           ═══════════════════════════════════════════════════════════ */

        /* ─── P7 S4 — mini-reset proprio (sostituisce il preflight della
           CDN Tailwind rimossa). Il border-reset universale è load-bearing:
           tutto il CSS dell'app è stato scritto assumendo bordi a zero.
           `.hidden` SENZA !important e PRIMA delle regole ID: #dag-overlay
           deve continuare a vincere sul display (nascosto solo via
           opacity/visibility — Inv.52, MAI display:none). ─── */
        *, *::before, *::after { box-sizing: border-box; border-width: 0; border-style: solid; border-color: var(--ibex-border); }
        html { -webkit-text-size-adjust: 100%; }
        body { margin: 0; }
        h1, h2, h3, h4, h5, h6, p, figure, blockquote, dl, dd { margin: 0; }
        ul, ol { list-style: none; margin: 0; padding: 0; }
        button, input, optgroup, select, textarea { font-family: inherit; font-size: 100%; line-height: inherit; color: inherit; margin: 0; padding: 0; }
        button, select { text-transform: none; }
        button { background-color: transparent; background-image: none; }
        img, svg, video, canvas { display: block; vertical-align: middle; }
        a { color: inherit; text-decoration: inherit; }
        .hidden { display: none; }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }

        :root {
            /* Palette Enamel DS — token map allineato al Design System ufficiale
               (palette app interamente fredda, niente avorio/warm). */
            --ibex-bg:            #F4F5F6;   /* tint di sfondo — viewport, canvas DAG, fill input, hover */
            --ibex-surface:       #FFFFFF;   /* header / pannelli / nodi — bianco */
            --ibex-surface-2:     #F4F5F6;   /* barre titolo nodo, head/side DAG */
            --ibex-border:        #E3E5E7;   /* hairline fredda (= --line app) */
            --ibex-border-strong: #D2D5D8;   /* bordo forte freddo */
            --ibex-accent:        #FF6037;   /* Outrageous Orange — usato come arma */
            --ibex-accent-hover:  #E85530;   /* hover CTA: 10% più scuro, mai più chiaro */
            --ibex-accent-dim:    rgba(255,96,55,0.12);  /* hover/selezione debole */
            --ibex-text:          #0B0B0C;   /* ink */
            --ibex-text-2:        #6E6B66;   /* mute */
            --ibex-text-3:        #A8A6A1;   /* muted / disabled */
            --ibex-geo:           #1F8A4C;   /* socket geometria — success DS */
            --ibex-mtx:           #D4860D;   /* socket matrice/vettore — warn DS (mostarda) */
            --ibex-crv:           #2A6FDB;   /* socket curva — blu (era viola pre-Enamel) */
            --ibex-error:         #C4302B;
            --ibex-success:       #1F8A4C;
            --btn-ink-bg:         #0B0B0C;   /* CTA primario "ink" (Salva & esci) */
            --btn-ink-fg:         #FFFFFF;
            --btn-ink-hover:      #2B2A29;

            /* Scala DS */
            --r-card:  4px;
            --r-input: 6px;
            --r-pill:  9999px;
            --shadow-card: 0 1px 2px rgb(0 0 0 / .05);
            --shadow-lift: 0 4px 12px rgb(0 0 0 / .08);
            --dur-1: 160ms;
            --dur-2: 240ms;
            --ease:  cubic-bezier(.2, .8, .2, 1);

            /* Dimensioni dinamiche (aggiornate via JS drag resize) */
            --dag-h:           320px;
            --dag-sidebar-w:   240px;  /* larghezza sidebar DAG (Scena + Strumenti) */
        }

        /* ─── TEMA SCURO (IBEX.zip, verbatim da Editor reale) — propagato da Shell via
           localStorage 'ibex_ws:theme' / postMessage ibex-theme / ?theme=dark ─── */
        :root[data-theme="dark"] {
            --ibex-bg:#121315; --ibex-surface:#1B1D1F; --ibex-surface-2:#202325;
            --ibex-border:#2A2D30; --ibex-border-strong:#3A3E42;
            --ibex-accent:#FF6F4A; --ibex-accent-hover:#FF835F; --ibex-accent-dim:rgba(255,111,74,.18);
            --ibex-text:#F3F2F0; --ibex-text-2:#9A968F; --ibex-text-3:#67645F;
            --ibex-geo:#3FBE74; --ibex-mtx:#E9A52E; --ibex-crv:#5B92F0;
            --ibex-error:#F0796F; --ibex-success:#3FBE74;
            --btn-ink-bg:#F3F2F0; --btn-ink-fg:#121315; --btn-ink-hover:#DAD8D3;
            --shadow-card:0 1px 2px rgb(0 0 0 / .4); --shadow-lift:0 6px 16px rgb(0 0 0 / .5);
        }
        #ibex-header, #dag-panel, .ibex-inspector-panel { transition: background-color var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease); }

        html, body {
            height: 100%;
            margin: 0;
            background: var(--ibex-bg);
            overflow: hidden;
        }
        body {
            font-family: 'Ubuntu', system-ui, -apple-system, sans-serif;
            font-size: 13px;
            font-weight: 400;
            color: var(--ibex-text);
            line-height: 1.4;
        }

        /* ─── Viewport a schermo intero (niente pannelli laterali) ─ */
        /* NB: inset PRIMA, poi longhand; sovrascrive Tailwind "inset-0" via !important */
        #viewport {
            position: fixed !important;
            inset: auto !important;
            top:    64px !important;
            left:   0 !important;
            right:  0 !important;
            bottom: 0 !important;
            width:  auto !important;
            height: auto !important;
            /* P7 de-Tailwind: ex utility vive z-0 / outline-none / touch-none */
            z-index: 0;
            outline: none;
            touch-action: none;
        }
        /* P7: colonna standard dei pannelli sidebar DAG (ex utility flex/h-full) */
        .dag-pane-col { display: flex; flex-direction: column; height: 100%; position: relative; width: 100%; overflow: hidden; }
        /* P7: sizing canvas Drawflow in regole ID (ex flex-1 w-full h-full relative — Inv.61) */
        #drawflow { flex: 1; width: 100%; height: 100%; position: relative; }
        #outliner { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
        .tools-empty { font-size: 10px; padding: 8px; text-align: center; text-transform: uppercase; letter-spacing: .1em; font-weight: 500; }

        /* ─── DAG sidebar integrata (meshes + tools) ────────────── */
        #dag-sidebar {
            width: var(--dag-sidebar-w);
            flex: none;
            background: var(--ibex-surface);
            border-right: 1px solid var(--ibex-border);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        /* Handle di resize della sidebar (bordo destro).
           Figlio di #dag-panel (absolute inset:0) — coordinate calcolate dal
           bordo del panel. `top:32px` salta l'header; `left:var(--dag-sidebar-w)`
           posiziona sul bordo destro della sidebar. */
        .ibex-sidebar-resize {
            position: absolute;
            top: 32px;
            bottom: 0;
            left: var(--dag-sidebar-w);
            width: 4px;
            margin-left: -2px;
            cursor: ew-resize;
            z-index: 10;
            background: transparent;
            transition: background 0.15s;
        }
        .ibex-sidebar-resize:hover,
        .ibex-sidebar-resize.active {
            background: var(--ibex-accent);
            opacity: 0.35;
        }
        /* Proporzioni sezioni = legge Editor reale (outliner 34% / tools flessibile / presets 30%) */
        #dag-sidebar-meshes {
            flex: none;
            max-height: 34%;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            border-bottom: 1px solid var(--ibex-border);
        }
        #dag-sidebar-tools {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            min-height: 0;
            border-bottom: 1px solid var(--ibex-border);
        }
        /* Preset DAG (2026-05-05) — terza sezione sidebar sotto Toolbar */
        #dag-sidebar-presets {
            flex: none;
            max-height: 30%;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            min-height: 0;
        }
        #dag-sidebar-presets.collapsed {
            flex: none !important;
            max-height: 26px !important;
            min-height: 26px !important;
            height: 26px;
        }
        #dag-sidebar-presets.collapsed .dag-sidebar-body { display: none; }
        #dag-sidebar-presets.collapsed .dag-sidebar-chevron { transform: rotate(-90deg); }

        .ibex-preset-tabs {
            display: flex;
            border-bottom: 1px solid var(--ibex-border);
            background: var(--ibex-surface-2);
            flex-shrink: 0;
        }
        .ibex-preset-tab {
            flex: 1;
            padding: 6px 8px;
            font-size: 10px;
            font-weight: 500;
            color: var(--ibex-text-2);
            background: transparent;
            border: none;
            border-right: 1px solid var(--ibex-border);
            cursor: pointer;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            transition: all 0.12s;
        }
        .ibex-preset-tab:last-child { border-right: none; }
        .ibex-preset-tab:hover { color: var(--ibex-accent); }
        .ibex-preset-tab.is-active {
            color: var(--ibex-accent);
            background: var(--ibex-surface);
            box-shadow: inset 0 -2px 0 var(--ibex-accent);
        }
        .ibex-preset-list {
            flex: 1;
            overflow-y: auto;
            padding: 6px;
            background: var(--ibex-surface);
        }
        .ibex-preset-list.hidden { display: none; }
        .ibex-preset-empty {
            padding: 16px 12px;
            text-align: center;
            color: var(--ibex-text-3);
            font-size: 10px;
            font-style: italic;
        }
        .ibex-preset-card {
            position: relative;
            padding: 8px 10px;
            margin-bottom: 4px;
            background: var(--ibex-surface-2);
            border: 1px solid var(--ibex-border);
            border-radius: 4px;
            cursor: grab;
            user-select: none;
            transition: border-color 0.12s, transform 0.12s;
        }
        .ibex-preset-card:hover {
            border-color: var(--ibex-accent);
        }
        .ibex-preset-card:active {
            cursor: grabbing;
        }
        .ibex-preset-card-name {
            font-size: 11px;
            font-weight: 500;
            color: var(--ibex-text);
            margin-bottom: 2px;
            padding-right: 22px; /* spazio per delete btn */
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .ibex-preset-card-meta {
            font-size: 9px;
            color: var(--ibex-text-3);
        }
        .ibex-preset-card-desc {
            font-size: 10px;
            color: var(--ibex-text-2);
            margin-top: 3px;
            line-height: 1.35;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }
        .ibex-preset-card-delete {
            position: absolute;
            top: 6px;
            right: 6px;
            width: 16px;
            height: 16px;
            padding: 0;
            font-size: 11px;
            line-height: 1;
            color: var(--ibex-text-3);
            background: transparent;
            border: 1px solid transparent;
            border-radius: 3px;
            cursor: pointer;
            transition: all 0.12s;
        }
        .ibex-preset-card:hover .ibex-preset-card-delete {
            color: var(--ibex-text-2);
        }
        .ibex-preset-card-delete:hover {
            color: var(--ibex-error);
            border-color: var(--ibex-error);
        }
        .dag-sidebar-header {
            flex: none;
            height: 26px;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 0 10px;
            font-size: 9px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.12em;
            color: var(--ibex-text-2);
            background: var(--ibex-surface-2);
            border-bottom: 1px solid var(--ibex-border);
            cursor: pointer;
            user-select: none;
            transition: background 0.12s;
        }
        .dag-sidebar-header:hover { background: var(--ibex-surface); color: var(--ibex-accent); }
        .dag-sidebar-chevron {
            width: 10px;
            height: 10px;
            flex-shrink: 0;
            transition: transform 0.15s ease;
        }
        /* Sezione collassata: solo header visibile, body nascosto */
        #dag-sidebar-meshes.collapsed,
        #dag-sidebar-tools.collapsed {
            flex: none !important;
            max-height: 26px !important;
            min-height: 26px !important;
            height: 26px;
            border-bottom: 1px solid var(--ibex-border);
        }
        #dag-sidebar-meshes.collapsed .dag-sidebar-body,
        #dag-sidebar-tools.collapsed .dag-sidebar-body {
            display: none;
        }
        #dag-sidebar-meshes.collapsed .dag-sidebar-chevron,
        #dag-sidebar-tools.collapsed .dag-sidebar-chevron {
            transform: rotate(-90deg);
        }
        /* Preset section: altre regole sotto specifiche per #dag-sidebar-presets */

        /* Sottogruppi (categorie tools) collassabili dentro la Toolbar */
        .tool-category-header {
            display: flex;
            align-items: center;
            gap: 5px;
            color: var(--ibex-text-3);
            font-weight: 500;
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: .12em;
            padding-bottom: 6px;
            margin-bottom: 8px;
            border-bottom: 1px solid var(--ibex-border);
            cursor: pointer;
            user-select: none;
            transition: color 0.12s, border-color 0.12s;
        }
        .tool-category-body { display: flex; flex-direction: column; gap: 4px; }
        /* Search + lista tool (legge Editor reale) — sostituiscono gli inline style del partial */
        .tool-search-wrap { padding: 8px 10px; border-bottom: 1px solid var(--ibex-border); background: var(--ibex-surface); flex: none; position: relative; }
        .tool-search-wrap svg { position: absolute; left: 18px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--ibex-text-3); pointer-events: none; }
        .tool-search-wrap input { width: 100%; padding: 6px 8px 6px 28px; font-size: 12px; background: var(--ibex-bg); border: 1px solid var(--ibex-border); border-radius: 3px; color: var(--ibex-text); outline: none; transition: border-color .15s; }
        .tool-search-wrap input:focus { border-color: var(--ibex-accent); }
        .tools-list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 12px; }
        /* Tool card (legge Editor reale) */
        .tool-card { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: var(--ibex-surface-2); border: 1px solid var(--ibex-border); border-radius: 3px; cursor: pointer; transition: border-color .12s; }
        .tool-card:hover { border-color: var(--ibex-accent); }
        .tool-card .tname { font-size: 11px; color: var(--ibex-text); letter-spacing: .01em; }
        .tool-card .tadd { font-size: 14px; color: var(--ibex-text-3); }
        /* Zoom canvas DAG (legge Editor reale) */
        .dag-zoom { position: absolute; top: 12px; right: 12px; z-index: 50; display: flex; flex-direction: column; gap: 1px; padding: 4px; background: var(--ibex-surface-2); border: 1px solid var(--ibex-border); border-radius: 3px; }
        .dag-zoom button { width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: var(--ibex-text-2); border-radius: 2px; font-size: 9px; font-weight: 500; cursor: pointer; transition: background .12s, color .12s; }
        .dag-zoom button:hover { background: var(--ibex-bg); color: var(--ibex-accent); }
        .dag-zoom button svg { width: 15px; height: 15px; }
        .tool-category-header:hover {
            color: var(--ibex-accent);
            border-bottom-color: var(--ibex-accent);
        }
        .tool-category-chevron {
            width: 9px;
            height: 9px;
            flex-shrink: 0;
            transition: transform 0.15s ease;
        }
        .tool-category.collapsed .tool-category-chevron {
            transform: rotate(-90deg);
        }
        .tool-category.collapsed .tool-category-body {
            display: none;
        }
        .tool-category.collapsed .tool-category-header {
            margin-bottom: 0;
        }
        #dag-canvas {
            flex: 1;
            position: relative;
            overflow: hidden;
            min-width: 0;
            touch-action: none; /* TOUCH FIX (2026-06-28): niente scroll-hijack del browser → il touchmove scorre → editor.mouse_x/y avanzano → elementFromPoint trova il socket di destinazione (cavi nuovi agganciano su touch) */
        }

        /* ─── Drawflow .parent-node click pass-through (2026-04-30) ───
           Drawflow wrappa ciascun nodo in <div class="parent-node">. Il
           wrapper ha solo `position: relative` (default block) → finisce
           per coprire un'area larga, intercettando i click su area
           apparentemente "vuota". `parent-node` NON è in nessun `case`
           dello `switch` di Drawflow `click()` → fall-through →
           `editor_selected` resta false → niente pan.

           Fix: il wrapper diventa trasparente agli eventi; i figli
           (`.drawflow-node`, `.drawflow-delete`, ecc.) ripristinano
           `pointer-events: auto` per restare cliccabili. I click su
           area vuota arrivano alla precanvas (`.drawflow`) →
           classList[0]==='drawflow' → editor_selected=true → pan ✓ */
        #drawflow .parent-node { pointer-events: none; }
        #drawflow .parent-node > * { pointer-events: auto; }

        /* ─── Mesh dot indicator (outliner items) ─────────────────── */
        .ibex-mesh-dot {
            display: inline-block;
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--ibex-text-3);
            margin-right: 6px;
            flex-shrink: 0;
            transition: background 0.15s;
        }
        .outliner-item.selected .ibex-mesh-dot { background: var(--ibex-accent); }
        .outliner-item.selected {
            border-left: 2px solid var(--ibex-accent) !important;
            background: var(--ibex-accent-dim) !important;
            padding-left: 6px !important;
        }
        .outliner-item.selected span { color: var(--ibex-accent) !important; }

        /* ─── Drawflow canvas ─────────────────────────────────── */
        .drawflow,
        .drawflow .parent-node { background: transparent !important; }

        /* ─── Drawflow nodi (ClinicalWhite V5.1) ─────────────────── */
        .drawflow .drawflow-node {
            width: 180px;
            background: var(--ibex-surface);
            border: 1px solid var(--ibex-border);
            border-radius: 4px;
            box-shadow: 0 1px 4px rgba(0,0,0,0.08);
            color: var(--ibex-text);
            padding: 0;
            font-family: 'Ubuntu', system-ui, sans-serif;
            font-size: 11px;
            font-weight: 400;
            position: relative;
            z-index: 10;
            cursor: grab; /* legge .dnode */
        }
        /* user-select solo su testata/target (legge): MAI sull'intero nodo (input selezionabili) */
        .drawflow .drawflow-node .title-box,
        .drawflow .drawflow-node .ibex-node-target-row { user-select: none; -webkit-user-select: none; }

        /* Accent strip verticale 2px sul bordo sinistro del nodo.
           Default grigio tenue (tool); arancione solo per nodi mesh. */
        .drawflow .drawflow-node::before {
            content: '';
            position: absolute;
            left: 0; top: 0; bottom: 0;
            width: 2px;
            border-radius: 4px 0 0 4px;
            background: var(--ibex-text-3);
            pointer-events: none;
        }
        .drawflow .drawflow-node.mesh::before { background: var(--ibex-accent); }

        /* Nodo selezionato */
        .drawflow .drawflow-node.selected {
            border-color: rgba(255,96,55,0.6);
            box-shadow: 0 0 0 1px rgba(255,96,55,0.2);
        }
        .drawflow .drawflow-node.selected::before { background: var(--ibex-accent); }

        /* Preset DAG (2026-05-05) — multi-select via marquee.
           Box-shadow accent più marcato + strip arancione. Distinto da
           `.selected` (single-select Drawflow nativo) che ha border-color. */
        .drawflow .drawflow-node.ibex-multi-selected {
            box-shadow: 0 0 0 2px var(--ibex-accent);
        }
        .drawflow .drawflow-node.ibex-multi-selected::before {
            background: var(--ibex-accent);
        }

        /* NodeMute (2026-05-05) — Houdini bypass / Blender mute pattern.
           Nodo "spento": opacity ridotta + strip grigia + pattern diagonale
           sull'header per segnalare visivamente che il worker fa passthrough
           (non esegue il calcolo). I controlli (input, button) restano
           cliccabili per consentire la riattivazione e il fine-tuning. */
        .drawflow .drawflow-node.ibex-node-muted {
            opacity: 0.45;
            filter: grayscale(0.6);
        }
        .drawflow .drawflow-node.ibex-node-muted::before {
            background: var(--ibex-text-3) !important;
        }
        .drawflow .drawflow-node.ibex-node-muted .title-box {
            background: repeating-linear-gradient(
                45deg,
                transparent,
                transparent 4px,
                rgba(0,0,0,0.06) 4px,
                rgba(0,0,0,0.06) 8px
            );
        }
        .drawflow .drawflow-node.ibex-node-muted.selected {
            opacity: 0.7;
        }

        /* Title-box (header nodo) — flex per allineare titolo + toggle Mute (M) a destra */
        .drawflow .drawflow-node .title-box {
            padding: 7px 10px;
            background: var(--ibex-surface-2);
            border-bottom: 1px solid var(--ibex-border);
            border-radius: 4px 4px 0 0;
            font-size: 11px;
            font-weight: 500;
            color: var(--ibex-text);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
        }
        /* .tt = testata legge (.dnode-title .tt): titolo con ellipsis, toggle sempre visibile */
        .drawflow .drawflow-node .title-box .tt {
            flex: 1; min-width: 0;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }

        /* NodeMute (2026-05-05) — toggle interruttore SVG inline.
           Stato CHIUSO (default, non muted): linea orizzontale tra i 2 cerchi
           = circuito attivo, il worker ESEGUE il compute.
           Stato APERTO (`.is-muted`): leva alzata e disconnessa = bypass,
           il worker SALTA il compute (passthrough). Stesse classi su
           toggle nei nodi DAG e nel ContextInspector (.ctx-mute-btn). */
        .ibex-mute-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            padding: 2px 4px;
            color: var(--ibex-text-2);
            background: transparent;
            border: 1px solid var(--ibex-border);
            border-radius: 3px;
            cursor: pointer;
            user-select: none;
            transition: color 0.12s, border-color 0.12s, background 0.12s;
            flex-shrink: 0;
            line-height: 0; /* evita extra spazio sotto SVG inline */
        }
        .ibex-mute-toggle:hover {
            color: var(--ibex-accent);
            border-color: var(--ibex-accent);
        }
        /* Dimensioni px FISSE sull'SVG (no width:100% / height:auto, che possono
           dilatare l'icona se il container flex ha vincoli inconsistenti). */
        .ibex-mute-toggle .ibex-mute-icon {
            width: 18px;
            height: 10px;
            display: block;
            flex-shrink: 0;
        }
        /* Switch tra le due icone via stato `.is-muted` */
        .ibex-mute-toggle .icon-open    { display: none; }
        .ibex-mute-toggle .icon-closed  { display: block; }
        .ibex-mute-toggle.is-muted .icon-closed { display: none; }
        .ibex-mute-toggle.is-muted .icon-open   { display: block; }
        /* Stato attivo (muted): accent arancione per evidenziare il bypass attivo */
        .ibex-mute-toggle.is-muted {
            color: var(--ibex-accent);
            border-color: var(--ibex-accent);
            background: rgba(255,96,55,0.08);
        }
        .ibex-mute-toggle.is-muted:hover {
            background: rgba(255,96,55,0.18);
        }
        /* ContextInspector: rimuovo padding/text styling extra del bottone
           per consentire all'SVG di occupare lo spazio coerente al DAG. */
        .ctx-mute-btn.ibex-mute-toggle {
            font-size: 0; /* niente fallback testo */
            padding: 0 3px;
            letter-spacing: 0;
            text-transform: none;
        }

        /* DagSync V5.11 (Obiettivo 2a) — target label sotto il title-box.
           Mostra lo stem (senza .stl) della mesh target del nodo tool.
           Popolata da StackManager._refreshAllNodeTargetLabels(). */
        .drawflow .drawflow-node .ibex-node-target-row {
            padding: 3px 10px 4px;
            border-bottom: 1px solid var(--ibex-border);
            background: var(--ibex-surface);
        }
        .drawflow .drawflow-node .ibex-node-target-label {
            font-size: 9px;
            color: var(--ibex-text-3);
            margin-top: 2px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 160px;
            display: block;
            font-family: 'Ubuntu Mono', monospace;
        }

        /* DagSync V3.12 (Obiettivo 2b) — highlight nodi correlati alla mesh
           selezionata nel viewport. Bordo sinistro accent + tint background.
           NON interferisce con la strip ::before esistente in cima al nodo. */
        .drawflow .drawflow-node.ibex-node-mesh-selected {
            border-left: 3px solid var(--ibex-accent);
            background: rgba(255,96,55,0.04);
        }

        /* Body nodo */
        .drawflow .drawflow-node .box {
            padding: 8px 10px;
            display: flex; flex-direction: column; gap: 5px;
        }
        .drawflow .drawflow-node label,
        .drawflow .drawflow-node .input-group {
            display: flex; justify-content: space-between; align-items: center;
            font-size: 10px;
            color: var(--ibex-text-2);
            font-weight: 400;
            text-transform: none;
            letter-spacing: 0;
        }

        /* Input numerici e testuali nei nodi */
        .drawflow .drawflow-node input[type="number"],
        .drawflow .drawflow-node input[type="text"] {
            width: 66px;
            background: var(--ibex-bg);
            border: 1px solid var(--ibex-border);
            color: var(--ibex-text);
            padding: 3px 6px;
            border-radius: 2px;
            text-align: right;
            outline: none;
            font-family: 'Ubuntu Mono', ui-monospace, monospace;
            font-size: 11px;
            font-weight: 400;
            transition: border-color 0.15s;
        }
        .drawflow .drawflow-node input[type="text"] { text-align: left; }
        .drawflow .drawflow-node input:focus { border-color: var(--ibex-accent); }

        /* Socket piccoli ed eleganti — 10×10 centrati sul bordo del nodo */
        .drawflow .drawflow-node .inputs .input,
        .drawflow .drawflow-node .outputs .output {
            position: relative;
            width: 10px;
            height: 10px;
            background: var(--ibex-surface);
            border: 1.5px solid var(--ibex-text-3);
            border-radius: 50%;
            box-sizing: border-box;
            cursor: crosshair;
            transition: border-color 0.15s, background 0.15s;
        }
        .drawflow .drawflow-node .inputs .input  { left:  -5px; top: 2px; }
        .drawflow .drawflow-node .outputs .output { right: -5px; top: 2px; }

        /* Connessioni (D2 — colore iniettato via classe per tipo socket) */
        .drawflow .connection .main-path {
            stroke: var(--ibex-text-3);
            stroke-width: 1.5px;
            fill: none;
        }
        .drawflow .connection.conn-geo .main-path { stroke: var(--ibex-geo); }
        .drawflow .connection.conn-mtx .main-path { stroke: var(--ibex-mtx); }
        .drawflow .connection.conn-vec .main-path { stroke: var(--ibex-mtx); }
        .drawflow .connection.conn-crv .main-path { stroke: var(--ibex-crv); }
        .drawflow .connection.selected .main-path {
            stroke-width: 2px;
            stroke: var(--ibex-accent);
        }

        /* V3.40 (2026-05-05) — feedback hover sulla connection per
           discoverability del "Alt+click rimuove" / dblclick rimuove.
           Cursor pointer + highlight stroke al passaggio del mouse. */
        .drawflow .connection { cursor: pointer; }
        .drawflow .connection:hover .main-path {
            stroke-width: 3px;
            filter: brightness(1.2);
        }

        /* V3.40 — bottone X tondo rosso in alto-sinistra del nodo per cancellarlo.
           Visibile SOLO quando il nodo è selezionato (Drawflow nativo applica
           la classe `.selected` al click sx). Posizionato 8px fuori dal bordo
           per non sovrapporsi al contenuto del nodo. Skippato per mesh source. */
        .drawflow .drawflow-node {
            overflow: visible; /* permette al bottone di sporgere fuori dal nodo */
        }
        .drawflow .drawflow-node .ibex-node-delete-btn {
            position: absolute;
            top: -8px;
            left: -8px;
            width: 16px;
            height: 16px;
            background: #C4302B;
            color: #ffffff;
            border-radius: 50%;
            display: none;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 5;
            transition: background 0.12s, transform 0.12s;
            box-shadow: 0 1px 3px rgba(0,0,0,0.25);
            user-select: none;
        }
        .drawflow .drawflow-node.selected .ibex-node-delete-btn {
            display: inline-flex;
        }
        .drawflow .drawflow-node .ibex-node-delete-btn:hover {
            background: #A8221F;
            transform: scale(1.15);
        }
        .drawflow .drawflow-node .ibex-node-delete-btn svg {
            display: block;
        }

        /* Stati nodo runtime (D1) */
        .drawflow .drawflow-node.ibex-node-processing::before {
            animation: ibex-strip-pulse 1s ease-in-out infinite;
        }
        @keyframes ibex-strip-pulse {
            0%, 100% { opacity: 1; }
            50%      { opacity: 0.2; }
        }
        .drawflow .drawflow-node.ibex-node-error          { border-color: var(--ibex-error); }
        .drawflow .drawflow-node.ibex-node-error::before  { background: var(--ibex-error); }

        /* Fix 3c (Invariante 78): flash verde 1s a fine bake.
           Tutti i nodi della queue ricevono .ibex-node-done dopo il success
           di hotSwapMeshes; BakeEngine._markDone li rimuove dopo 1s. */
        .drawflow .drawflow-node.ibex-node-done::before {
            background: var(--ibex-geo) !important;
            animation: ibex-strip-done 1s ease-out;
        }
        @keyframes ibex-strip-done {
            0%   { opacity: 1; }
            100% { opacity: 0.4; }
        }

        /* Fix 3a (Invariante 78): worker status bar nell'header. */
        #ibex-worker-status {
            font-family: 'Ubuntu Mono', monospace;
        }
        .ibex-worker-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--ibex-accent);
            animation: ibex-worker-dot-pulse 1s ease-in-out infinite;
            flex-shrink: 0;
        }
        @keyframes ibex-worker-dot-pulse {
            0%, 100% { opacity: 1; }
            50%      { opacity: 0.3; }
        }
        .ibex-worker-label {
            font-size: 11px;
            color: var(--ibex-text-2);
            white-space: nowrap;
            letter-spacing: 0.02em;
        }

        /* ─── Classi .ibex-* ──────────────────────────────────── */
        .ibex-group { margin: 2px 0; }
        .ibex-group-head {
            display: flex; align-items: center; gap: 5px;
            font-size: 11px;
            font-weight: 400;
            color: var(--ibex-text-2);
            padding: 3px 0;
            cursor: pointer;
            border-bottom: 1px solid var(--ibex-border);
            margin-bottom: 4px;
            user-select: none;
        }
        .ibex-group-head:hover { color: var(--ibex-text); }
        .ibex-chev {
            font-size: 8px;
            transition: transform 0.15s;
            display: inline-block;
            color: var(--ibex-text-3);
        }
        .ibex-chev-closed { transform: rotate(-90deg); }
        .ibex-group-body { padding: 4px 0 2px; }
        .ibex-group-body.ibex-collapsed { display: none; }

        .ibex-row {
            display: flex; justify-content: space-between; align-items: center;
            padding: 3px 4px; margin: 1px 0;
            border-radius: 2px;
        }
        .ibex-col {
            display: flex; flex-direction: column; gap: 3px;
            padding: 3px 4px; margin: 1px 0;
        }
        .ibex-obj-row {
            display: flex; flex-direction: column; gap: 4px;
            padding: 6px; margin: 3px 0;
            background: var(--ibex-surface-2);
            border-radius: 3px;
            border: 1px solid var(--ibex-border);
        }

        .ibex-lbl {
            font-size: 10px; /* metrica legge (.dnode-row) */
            font-weight: 300;
            color: var(--ibex-text-2);
            max-width: 84px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            flex-shrink: 0;
        }
        .ibex-lbl-obj { color: var(--ibex-geo); font-size: 10px; }
        .ibex-req     { color: var(--ibex-accent); margin-left: 2px; }

        .ibex-port-dot {
            display: inline-block;
            width: 5px; height: 5px;
            background: var(--ibex-accent);
            border-radius: 50%;
            margin-right: 4px;
            vertical-align: middle;
        }
        .ibex-val-wrap { display: flex; align-items: center; gap: 3px; }
        .ibex-unit {
            font-size: 8px;
            color: var(--ibex-text-3);
            font-weight: 500;
        }

        .ibex-num {
            width: 66px; /* metrica legge (.dnode-row input) */
            background: var(--ibex-bg);
            border: 1px solid var(--ibex-border);
            color: var(--ibex-text);
            padding: 3px 6px;
            border-radius: 2px;
            text-align: right;
            outline: none;
            font-family: 'Ubuntu Mono', ui-monospace, monospace;
            font-size: 11px;
            font-weight: 400;
            cursor: ew-resize;
            transition: border-color 0.15s;
        }
        .ibex-num:focus { border-color: var(--ibex-accent); outline: none; }

        .ibex-text,
        .ibex-select {
            width: 100%;
            background: var(--ibex-bg);
            border: 1px solid var(--ibex-border);
            color: var(--ibex-text);
            padding: 4px 6px;
            border-radius: 2px;
            font-size: 11px;
            outline: none;
            font-family: 'Ubuntu', sans-serif;
        }
        .ibex-text:focus, .ibex-select:focus { border-color: var(--ibex-accent); }

        /* Toggle */
        .ibex-toggle { position: relative; cursor: pointer; display: flex; align-items: center; }
        .ibex-toggle input { display: none; }
        .ibex-toggle-track {
            width: 28px; height: 14px;
            background: var(--ibex-border-strong);
            border-radius: 7px;
            position: relative;
            transition: background 0.15s;
        }
        .ibex-toggle input:checked + .ibex-toggle-track { background: var(--ibex-accent); }
        .ibex-toggle-thumb {
            position: absolute; top: 2px; left: 2px;
            width: 10px; height: 10px;
            background: var(--ibex-text);
            border-radius: 50%;
            transition: transform 0.15s;
        }
        .ibex-toggle input:checked + .ibex-toggle-track .ibex-toggle-thumb { transform: translateX(14px); }

        .ibex-readonly { opacity: 0.45; pointer-events: none; }

        .drawflow-node input,
        .drawflow-node select,
        .drawflow-node button { touch-action: none; }

        /* Sculpt V2 Sessione 2 — nodo `sculpt` non-distruttivo.
           Strip verticale del nodo: grigia (tool default) quando non ancora
           modificato; verde quando meta.sculpted=true (classe aggiunta da
           StackManager.refreshSculptNode in Sessione 4). */
        .drawflow .drawflow-node.ibex-sculpt-node-modified::before {
            background: var(--ibex-geo) !important;
        }
        /* draw_curve V1.0 (2026-05-06): strip viola coerente con socket CRV,
           NON verde — il nodo NON modifica la mesh (output curva separato). */
        .drawflow .drawflow-node.ibex-curve-node-configured::before {
            background: var(--ibex-crv) !important;
        }
        .drawflow .drawflow-node.ibex-curve-node-configured .ibex-sculpt-status[data-state="modified"] {
            color: var(--ibex-crv);
        }
        .drawflow .drawflow-node.ibex-curve-node-configured .ibex-sculpt-modify-btn {
            border-color: var(--ibex-crv);
            color: var(--ibex-crv);
        }
        .drawflow .drawflow-node.ibex-curve-node-configured .ibex-sculpt-modify-btn:hover {
            background: var(--ibex-crv);
            color: #ffffff;
        }
        .ibex-sculpt-status {
            padding: 6px 4px 4px 4px;
            text-align: center;
            font-size: 10px;
            color: var(--ibex-text-2);
        }
        .ibex-sculpt-status[data-state="modified"] {
            color: var(--ibex-geo);
            font-weight: 500;
        }
        .ibex-sculpt-modify-btn {
            width: 100%;
            margin-top: 4px;
            padding: 6px 10px;
            background: var(--ibex-surface-2);
            color: var(--ibex-text);
            border: 1px solid var(--ibex-border);
            border-radius: 3px;
            font-size: 10px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            cursor: pointer;
            font-family: 'Ubuntu', sans-serif;
            transition: background 0.15s, border-color 0.15s;
        }
        .ibex-sculpt-modify-btn:hover {
            background: var(--ibex-accent-dim);
            border-color: var(--ibex-accent);
        }

        /* ─── ExportNodeSTL (2026-05-03) — node body + inspector mirror ─── */
        .ibex-export-row {
            display: flex; flex-direction: column;
            gap: 2px; margin-bottom: 6px; padding: 0 4px;
        }
        .ibex-export-label {
            font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;
            color: var(--ibex-text-3);
        }
        .ibex-export-dir-btn {
            width: 100%; padding: 5px 8px;
            background: var(--ibex-surface-2); color: var(--ibex-text);
            border: 1px solid var(--ibex-border); border-radius: 3px;
            font-size: 10px; font-family: 'Ubuntu Mono', monospace;
            text-align: left; cursor: pointer; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap;
            transition: border-color 0.15s, background 0.15s;
        }
        .ibex-export-dir-btn:hover {
            border-color: var(--ibex-accent);
            background: var(--ibex-accent-dim);
        }
        .ibex-export-filename {
            width: 100%; padding: 5px 8px;
            background: var(--ibex-surface); color: var(--ibex-text);
            border: 1px solid var(--ibex-border); border-radius: 3px;
            font-size: 10px; font-family: 'Ubuntu Mono', monospace;
            box-sizing: border-box;
        }
        .ibex-export-filename:focus {
            outline: none; border-color: var(--ibex-accent);
        }
        .ibex-export-btn {
            width: 100%; margin-top: 6px; padding: 6px 10px;
            background: var(--ibex-accent); color: white;
            border: 1px solid var(--ibex-accent); border-radius: 3px;
            font-size: 10px; font-weight: 600;
            text-transform: uppercase; letter-spacing: 0.08em;
            cursor: pointer; font-family: 'Ubuntu', sans-serif;
            transition: background 0.15s, border-color 0.15s;
        }
        .ibex-export-btn:hover { background: #E85530; }
        .ibex-export-btn:disabled {
            background: var(--ibex-border-strong); color: var(--ibex-text-3);
            border-color: var(--ibex-border); cursor: wait;
        }
        .ibex-export-status {
            margin-top: 6px; padding: 6px 4px;
            text-align: center; font-size: 10px;
            color: var(--ibex-text-2);
        }
        .ibex-export-status[data-state="ok"]    { color: #1F8A4C; }
        .ibex-export-status[data-state="error"] { color: #C4302B; }
        .ibex-export-status[data-state="busy"]  { color: var(--ibex-accent); font-style: italic; }

        /* ContextInspector mirror */
        .ctx-export-row {
            display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px;
        }
        .ctx-export-label {
            font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;
            color: var(--ibex-text-3);
        }
        .ctx-export-dir-btn {
            width: 100%; padding: 5px 8px;
            background: var(--ibex-surface-2); color: var(--ibex-text);
            border: 1px solid var(--ibex-border); border-radius: 3px;
            font-size: 11px; font-family: 'Ubuntu Mono', monospace;
            text-align: left; cursor: pointer; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap;
        }
        .ctx-export-dir-btn:hover {
            border-color: var(--ibex-accent); background: var(--ibex-accent-dim);
        }
        .ctx-export-filename {
            width: 100%; padding: 5px 8px;
            background: var(--ibex-surface); color: var(--ibex-text);
            border: 1px solid var(--ibex-border); border-radius: 3px;
            font-size: 11px; font-family: 'Ubuntu Mono', monospace;
            box-sizing: border-box;
        }
        .ctx-export-filename:focus { outline: none; border-color: var(--ibex-accent); }
        .ctx-export-btn {
            width: 100%; margin-top: 6px; padding: 7px 10px;
            background: var(--ibex-accent); color: white;
            border: 1px solid var(--ibex-accent); border-radius: 3px;
            font-size: 11px; font-weight: 600;
            text-transform: uppercase; letter-spacing: 0.08em;
            cursor: pointer; font-family: 'Ubuntu', sans-serif;
        }
        .ctx-export-btn:hover { background: #E85530; }
        .ctx-export-status {
            margin-top: 8px; padding: 8px;
            background: var(--ibex-surface-2); border-radius: 3px;
            font-size: 11px; line-height: 1.5; text-align: left;
            color: var(--ibex-text-2);
        }
        .ctx-export-status[data-state="ok"] { color: var(--ibex-text); }
        .ctx-export-status[data-state="ok"] strong { color: #1F8A4C; }

        /* Sculpt V2 Sessione 1 — nodi legacy delta_sculpting (rimosso).
           Overlay rosso + bottone "Elimina nodo" unico sul nodo.
           La classe .ibex-sculpt-enter-btn del vecchio sculpt è stata rimossa;
           il nuovo nodo `sculpt` avrà uno stile dedicato in Sessione 2. */
        .drawflow .drawflow-node.ibex-node-legacy-deleted {
            border-color: var(--ibex-error);
            box-shadow: 0 0 0 1px var(--ibex-error);
            opacity: 0.9;
        }
        .drawflow .drawflow-node.ibex-node-legacy-deleted::before {
            background: var(--ibex-error) !important;
        }
        .ibex-legacy-msg {
            color: var(--ibex-error);
            font-size: 10px;
            font-weight: 500;
            text-align: center;
            padding: 8px 4px;
            letter-spacing: 0.05em;
        }
        .ibex-legacy-delete {
            width: 100%;
            margin-top: 4px;
            padding: 6px 10px;
            background: var(--ibex-error);
            color: #fff;
            border: none;
            border-radius: 3px;
            font-size: 10px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            cursor: pointer;
            font-family: 'Ubuntu', sans-serif;
        }
        .ibex-legacy-delete:hover { filter: brightness(1.1); }

        /* ─── Pattern puntini canvas DAG ───────────────────────── */
        .bg-dotted-pattern {
            background-color: var(--ibex-bg);
            background-image: radial-gradient(var(--ibex-surface-2) 1.4px, transparent 1.4px);
            background-size: 20px 20px;
        }

        /* ─── Engine gears + testata panel (legge Editor reale) ── */
        .dag-head-tools { display: flex; align-items: center; gap: 10px; }
        #engine-gears { display: flex; align-items: center; gap: 1px; color: var(--ibex-text-3); }
        @keyframes gear-spin         { 100% { transform: rotate( 360deg); } }
        @keyframes gear-spin-reverse { 100% { transform: rotate(-360deg); } }
        #engine-gears .gear { transition: color 0.2s ease; color: var(--ibex-text-3); }
        #engine-gears.is-calculating .gear-cw  { animation: gear-spin         1.5s linear infinite; color: var(--ibex-accent) !important; }
        #engine-gears.is-calculating .gear-ccw { animation: gear-spin-reverse 1.5s linear infinite; color: var(--ibex-accent) !important; }

        /* ─── DAG overlay dal basso (C2) ───────────────────────── */
        #dag-overlay {
            position: fixed;
            left: 0; right: 0; bottom: 0;
            height: var(--dag-h);
            z-index: 60;
            transition: opacity 0.2s ease;
        }
        /* Nascondo con opacity + visibility (NON transform): così il rect del
           canvas Drawflow è sempre quello vero, altrimenti Drawflow cachea
           al start() una posizione off-screen e le connessioni partono ~10cm
           sotto il click. */
        #dag-overlay.hidden {
            opacity: 0;
            visibility: hidden;
            pointer-events: none;
        }
        /* Durante il drag resize, disattivo le transition per ridimensionamento fluido */
        #dag-overlay.resizing { transition: none !important; }

        #dag-backdrop {
            position: fixed;
            /* legge: l'header resta scoperto dal backdrop (razionale dell'header-lit);
               in embed torna a 0 via override :root[data-embed] */
            left: 0; right: 0; top: 64px; bottom: var(--dag-h);
            background: rgba(0,0,0,0.55);
            z-index: -1;
            pointer-events: auto;
            transition: opacity 0.2s ease;
        }
        #dag-overlay.hidden #dag-backdrop {
            opacity: 0;
            pointer-events: none;
        }
        #dag-panel {
            position: absolute;
            inset: 0;
            background: var(--ibex-surface);
            border-top: 1px solid var(--ibex-accent);
            display: flex;
            flex-direction: column;
        }
        #dag-header {
            height: 32px;
            padding: 0 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: var(--ibex-surface-2);
            border-bottom: 1px solid var(--ibex-border);
            flex: none;
        }
        #dag-title {
            font-size: 9px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.15em;
            color: var(--ibex-text-2);
        }
        #dag-close-btn {
            background: transparent;
            border: none;
            color: var(--ibex-text-3);
            font-size: 10px;
            text-transform: lowercase;
            cursor: pointer;
            padding: 2px 8px;
            transition: color 0.15s;
            font-family: 'Ubuntu', sans-serif;
        }
        #dag-close-btn:hover { color: var(--ibex-accent); }
        #dag-body {
            flex: 1;
            display: flex;
            flex-direction: row;
            min-height: 0;
            overflow: hidden;
            /* NB: volutamente SENZA position:relative — riduce di 1 la catena
               offsetParent del #drawflow (Drawflow calcola le posizioni SVG
               delle connessioni risalendo il DOM; troppi livelli position
               causavano drift). L'handle sidebar ora è figlio di #dag-panel. */
        }

        /* Handle di resize dell'overlay DAG (striscia 4px sul bordo superiore) */
        #dag-resize-handle {
            position: absolute;
            top: -2px; left: 0; right: 0;
            height: 6px;
            cursor: ns-resize;
            background: transparent;
            z-index: 3;
            transition: background 0.15s;
        }
        #dag-resize-handle:hover,
        #dag-resize-handle.active {
            background: var(--ibex-accent);
            opacity: 0.35;
        }

        /* ═══════════════════════════════════════════════════════════
           HEADER REDESIGN (2026-05-04) — commercial-grade modern
           ─────────────────────────────────────────────────────────── */
        /* ═══ Header TARGET (menu-bar) — Pezzo 2 menubar, 2026-07-08 (da ibex/Editor reale.html).
           Riporta l'header sulle CLASSI REALI (#ibex-header + .ibex-header-left/right +
           .ibex-project-* + .menubar/.mb__*). Rimuove i .hd-* (Pezzo 1) e il .vp-tooldock (2a):
           fit/sezione ora in Visualizza. Token gia' nel :root. Sopravvivono: zoom-unlock + responsive. */
        #ibex-header {
            position: fixed; top: 0; left: 0; width: 100%; height: 64px; z-index: 50;
            display: flex; align-items: center; justify-content: space-between;
            padding: 0 16px; background: var(--ibex-surface); border-bottom: 1px solid var(--ibex-border);
        }
        /* header-lit a DAG aperto (legge: underline accent; l'app toggla la classe su body) */
        body.dag-open #ibex-header { box-shadow: inset 0 -2px 0 var(--ibex-accent); }
        .ibex-header-left { display: flex; align-items: center; gap: 10px; height: 100%; flex: 1; min-width: 0; }
        .ibex-header-right { display: flex; align-items: center; gap: 12px; height: 100%; }
        #ibex-header-exit {
            display: inline-flex; align-items: center; justify-content: center;
            width: 34px; height: 34px; border-radius: var(--r-pill); flex: none;
            color: var(--ibex-text-2); background: transparent; border: none; cursor: pointer;
            transition: color var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
        }
        #ibex-header-exit:hover { color: var(--ibex-text); background: var(--ibex-bg); }
        #ibex-header-exit svg { width: 18px; height: 18px; display: block; }
        .ibex-project-identity { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: none; }
        .ibex-project-name-row { display: flex; align-items: center; gap: 8px; }
        #ibex-project-name-input {
            font-size: 14px; font-weight: 500; color: var(--ibex-text);
            border: none; background: transparent; outline: none; font-family: inherit;
            padding: 2px 4px; border-radius: 4px; width: clamp(110px, 16vw, 200px);
            transition: background var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease);
        }
        #ibex-project-name-input:hover { background: var(--ibex-bg); }
        #ibex-project-name-input:focus { background: var(--ibex-bg); box-shadow: inset 0 0 0 1px var(--ibex-accent); }
        #ibex-project-name-input.saving { background: var(--ibex-bg); box-shadow: inset 0 0 0 1px var(--ibex-accent); }
        #ibex-project-name-input.error { background: rgba(196,48,43,0.08); box-shadow: inset 0 0 0 1px var(--ibex-error); }
        .ibex-project-status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ibex-success); flex: none; }
        .ibex-project-status-dot.dirty { background: var(--ibex-accent); }
        .ibex-project-brand { font-size: 11px; color: var(--ibex-text-3); letter-spacing: 0.06em; text-transform: lowercase; padding-left: 4px; white-space: nowrap; }
        .ibex-header-divider { width: 1px; height: 26px; background: var(--ibex-border); flex: none; }
        .ibex-header-pill { display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px; border-radius: var(--r-pill); background: var(--ibex-bg); border: 1px solid var(--ibex-border); }
        .ibex-worker-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ibex-accent); animation: ibex-worker-dot-pulse 1s infinite; flex: none; }
        .ibex-worker-label { font-size: 11px; color: var(--ibex-text-2); white-space: nowrap; }

        /* ─── MENU BAR (verbatim da Editor reale.html) ─── */
        .menubar { display: flex; align-items: center; gap: 1px; height: 100%; }
        .mb { position: relative; height: 100%; display: flex; align-items: center; }
        .mb__btn { height: 40px; padding: 0 12px; border: none; background: transparent; font-family: inherit; font-size: 14px; font-weight: 400; color: var(--ibex-text-2); border-radius: var(--r-card); display: inline-flex; align-items: center; cursor: pointer; transition: background .16s var(--ease), color .16s var(--ease); }
        .mb__btn:hover { background: var(--ibex-bg); color: var(--ibex-text); }
        .mb.is-open > .mb__btn { background: var(--ibex-bg); color: var(--ibex-text); }
        .mb__pop { position: absolute; top: calc(100% + 2px); left: 0; min-width: 248px; background: var(--ibex-surface); border: 1px solid var(--ibex-border); border-radius: 6px; box-shadow: var(--shadow-lift); padding: 6px; display: none; z-index: 80; }
        .mb.is-open > .mb__pop { display: block; animation: mbpop .16s var(--ease); }
        @keyframes mbpop { from { transform: translateY(-4px); } to { transform: none; } }
        .mb__item { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 8px 10px; border: none; background: transparent; border-radius: 4px; color: var(--ibex-text); font-family: inherit; font-size: 13px; text-align: left; cursor: pointer; transition: background .16s var(--ease); }
        .mb__item:hover { background: var(--ibex-bg); }
        .mb__item .ic { width: 16px; height: 16px; flex: none; color: var(--ibex-text-2); display: inline-flex; }
        .mb__item .ic svg { width: 16px; height: 16px; }
        .mb__item .lb { flex: 1; white-space: nowrap; }
        .mb__item .sc { font-family: 'Ubuntu Mono', monospace; font-size: 11px; color: var(--ibex-text-3); padding-left: 24px; letter-spacing: .02em; }
        .mb__item .chev { width: 14px; height: 14px; flex: none; color: var(--ibex-text-3); display: inline-flex; }
        .mb__item .chev svg { width: 14px; height: 14px; }
        .mb__item .tick { width: 16px; height: 16px; flex: none; color: var(--ibex-accent); display: inline-flex; opacity: 0; }
        .mb__item .tick svg { width: 16px; height: 16px; }
        .mb__item.is-checked .tick { opacity: 1; }
        .mb__item[aria-disabled="true"] { color: var(--ibex-text-3); pointer-events: none; }
        .mb__item[aria-disabled="true"] .sc { color: var(--ibex-text-3); }
        .mb__sep { height: 1px; margin: 6px 8px; background: var(--ibex-border); }
        .mb__sub { position: relative; }
        .mb__sub > .mb__pop { top: -7px; left: calc(100% + 3px); min-width: 180px; }
        .mb__sub:hover > .mb__pop, .mb__sub.is-open > .mb__pop { display: block; }
        .mb-scrim { position: fixed; inset: 0; z-index: 70; display: none; }
        .mb-scrim.is-on { display: block; }
        .quickbar { display: flex; align-items: center; gap: 2px; height: 100%; margin-left: 8px; min-width: 0; overflow: hidden; }
        .mb-burger { display: none; }

        /* ─── RESPONSIVE menu-bar: <=1000px collassa in "☰" (dropdown a colonna) ─── */
        @media (max-width: 1000px) {
            .mb-burger { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: var(--r-pill); flex: none; color: var(--ibex-text-2); background: transparent; border: none; cursor: pointer; }
            .mb-burger:hover { color: var(--ibex-text); background: var(--ibex-bg); }
            .mb-burger svg { width: 20px; height: 20px; }
            .menubar { position: absolute; top: 64px; left: 8px; flex-direction: column; align-items: stretch; gap: 2px; height: auto; padding: 6px; min-width: 230px; background: var(--ibex-surface); border: 1px solid var(--ibex-border); border-radius: 8px; box-shadow: var(--shadow-lift); z-index: 80; display: none; }
            .menubar.is-mobile-open { display: flex; }
            .menubar .mb { height: auto; width: 100%; }
            .menubar .mb__btn { height: 36px; width: 100%; }
            .menubar .mb.is-open > .mb__pop { position: static; box-shadow: none; border: none; padding: 0 0 6px 12px; min-width: 0; }
            .menubar .mb__sub > .mb__pop { position: static; box-shadow: none; border: none; }
            .ibex-project-brand { display: none; }
        }
        @media (max-width: 560px) { #ibex-project-name-input { width: clamp(80px, 30vw, 140px); } }

        /* [Pezzo 2 menubar] Il .vp-tooldock (2a) e' stato RIMOSSO: fit/sezione ora in Visualizza. */

        /* ─── SHELL-EMBED (IBEX.zip v2): con ?embed=1 l'header (menubar+quickbar) vive nel
           chrome della finestra-shell ibex_workspace; l'editor nasconde il proprio. ─── */
        :root[data-embed="1"] #ibex-header { display: none !important; }
        :root[data-embed="1"] #viewport { top: 0 !important; }
        :root[data-embed="1"] #ibex-view-gizmo-ui { top: 10px; }
        /* Richiesta Lorenzo 2026-07-09: in scheda il PANNELLO resta flush col chrome
           (niente vuoto) ma il CONTENUTO parte più in basso — offset via --insp-embed-top. */
        :root[data-embed="1"] .ibex-inspector-panel { top: 0; }
        :root[data-embed="1"] .ibex-inspector-content { top: var(--insp-embed-top, 12px); }
        :root[data-embed="1"] #dag-backdrop { top: 0; }

        /* ═══════════════════════════════════════════════════════════
           ViewGizmo V4.1 (2026-05-04) — canvas 2D PULITO (no chrome)
           Default: SOLO il canvas degli assi visibile, niente background
           né border né shadow. Trasparente sopra al viewport 3D.
           Quando expanded, il content sotto ha il proprio chrome.
           Z-index 51 — sopra header (z:50) come difesa.
           ─────────────────────────────────────────────────────────── */
        #ibex-view-gizmo-ui {
            position: fixed;
            top: 76px;            /* sotto l'header 64px (Pezzo 2a: era top:64 left:12) */
            right: 16px;
            transition: right .2s ease; /* gizmo-follow legge (slide con l'inspector) */
            left: auto;
            width: 96px;
            z-index: 51;
            font-family: 'Ubuntu', sans-serif;
            display: flex;
            flex-direction: column;
            /* Pezzo 2a: chrome a card v2 (era "no chrome"). Canvas invariato (96px) -> hit-test/preset intatti. */
            background: var(--ibex-surface);
            border: 1px solid var(--ibex-border);
            border-radius: var(--r-card);
            box-shadow: var(--shadow-card);
        }

        /* Canvas 2D del gizmo: trasparente, mostra solo gli assi disegnati */
        .ibex-vg-canvas {
            display: block;
            width: 96px;
            height: 96px;
            cursor: pointer;
            background: transparent;
        }

        /* Content collassabile: nascosto di default. Quando .expanded,
           si mostra con il proprio chrome (background + border + shadow). */
        .ibex-vg-content {
            display: none;
            background: var(--ibex-surface);
            border: 1px solid var(--ibex-border);
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.10);
            margin-top: 4px;
        }
        #ibex-view-gizmo-ui.expanded .ibex-vg-content {
            display: block;
        }

        /* In clip-mode il gizmo canvas resta cliccabile: LEFT click = esci sezione */

        .ibex-vg-preset-list {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 2px;
            padding: 4px;
            border-bottom: 1px solid var(--ibex-border);
        }
        .ibex-vg-preset-btn {
            background: transparent;
            color: var(--ibex-text-2);
            border: 1px solid var(--ibex-border);
            border-radius: 3px;
            padding: 4px 1px;
            font-size: 8px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.02em;
            cursor: pointer;
            font-family: 'Ubuntu', sans-serif;
            transition: all 0.12s;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .ibex-vg-preset-btn:hover {
            border-color: var(--ibex-accent);
            color: var(--ibex-accent);
            background: var(--ibex-accent-dim, rgba(255,96,55,0.08));
        }

        /* Sezione toggles helper viewport (griglia / assi del 3D — NON del widget) */
        .ibex-vg-toggles-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 2px;
            padding: 4px;
            border-bottom: 1px solid var(--ibex-border);
        }
        .ibex-vg-toggle-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 3px;
            background: transparent;
            color: var(--ibex-text-3);
            border: 1px solid var(--ibex-border);
            border-radius: 3px;
            padding: 4px 1px;
            font-size: 8px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.02em;
            cursor: pointer;
            font-family: 'Ubuntu', sans-serif;
            transition: all 0.12s;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .ibex-vg-toggle-btn:hover {
            border-color: var(--ibex-accent);
            color: var(--ibex-accent);
        }
        .ibex-vg-toggle-btn.active {
            color: var(--ibex-accent);
            border-color: var(--ibex-accent);
            background: var(--ibex-accent-dim, rgba(255,96,55,0.08));
        }
        .ibex-vg-toggle-btn svg {
            flex-shrink: 0;
        }

        /* Sezione clip box (sezione 3D stile Blender ALT+B) */
        .ibex-vg-clip-section {
            padding: 4px;
            border-bottom: 1px solid var(--ibex-border);
        }
        .ibex-vg-clip-btn {
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            background: transparent;
            color: var(--ibex-text-2);
            border: 1px solid var(--ibex-border);
            border-radius: 3px;
            padding: 5px 3px;
            font-size: 8px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.03em;
            cursor: pointer;
            font-family: 'Ubuntu', sans-serif;
            transition: all 0.12s;
        }
        .ibex-vg-clip-btn:hover {
            border-color: var(--ibex-accent);
            color: var(--ibex-accent);
            background: var(--ibex-accent-dim, rgba(255,96,55,0.08));
        }
        .ibex-vg-clip-btn.active {
            background: var(--ibex-accent);
            color: #ffffff;
            border-color: var(--ibex-accent);
        }
        .ibex-vg-clip-btn.active:hover {
            background: var(--ibex-accent);
            opacity: 0.9;
        }
        .ibex-vg-clip-btn svg {
            flex-shrink: 0;
        }

        .ibex-vg-saved-section {
            display: flex;
            flex-direction: column;
        }
        .ibex-vg-saved-head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 6px;
            border-bottom: 1px solid var(--ibex-border);
            background: var(--ibex-surface-2);
        }
        .ibex-vg-saved-label {
            font-size: 7px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--ibex-text-3);
        }
        .ibex-vg-save-btn {
            background: transparent;
            color: var(--ibex-accent);
            border: 1px solid var(--ibex-accent);
            border-radius: 3px;
            padding: 1px 4px;
            font-size: 7px;
            font-weight: 600;
            text-transform: uppercase;
            cursor: pointer;
            font-family: 'Ubuntu', sans-serif;
            transition: all 0.12s;
        }
        .ibex-vg-save-btn:hover {
            background: var(--ibex-accent-dim, rgba(255,96,55,0.08));
        }
        .ibex-vg-saved-list {
            max-height: 140px;
            overflow-y: auto;
            padding: 2px;
        }
        .ibex-vg-saved-empty {
            padding: 5px 3px;
            text-align: center;
            font-size: 8px;
            color: var(--ibex-text-3);
        }
        .ibex-vg-saved-row {
            display: flex;
            align-items: center;
            gap: 1px;
            padding: 1px 0;
        }
        .ibex-vg-saved-recall {
            flex: 1;
            min-width: 0;
            background: transparent;
            color: var(--ibex-text);
            border: 1px solid transparent;
            border-radius: 2px;
            padding: 2px 4px;
            font-size: 9px;
            text-align: left;
            cursor: pointer;
            font-family: 'Ubuntu', sans-serif;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            transition: all 0.12s;
        }
        .ibex-vg-saved-recall:hover {
            background: var(--ibex-surface-2);
            border-color: var(--ibex-border);
        }
        .ibex-vg-saved-rename, .ibex-vg-saved-delete {
            background: transparent;
            color: var(--ibex-text-3);
            border: 0;
            padding: 1px 2px;
            font-size: 9px;
            cursor: pointer;
            transition: color 0.12s;
        }
        .ibex-vg-saved-rename:hover { color: var(--ibex-accent); }
        .ibex-vg-saved-delete:hover { color: var(--ibex-error); }

        /* ─── Inspector Panel laterale destro (InspectorPanel_V1.0) ───
           Sostituisce il vecchio popup #context-inspector. Panel fisso sul
           bordo destro (sotto header), con tab SVG sempre visibile e handle
           di resize sul bordo sinistro. Il DAG overlay (z:60) si sovrappone
           al panel (z:55) quando aperto — comportamento voluto (A3). */
        :root { --inspector-w: 280px; }

        .ibex-inspector-panel {
            position: fixed;
            top: 64px; /* sotto l'header */
            right: 0;
            bottom: 0;
            width: var(--inspector-w);
            background: var(--ibex-surface);
            border-left: 1px solid var(--ibex-border);
            transform: translateX(100%);
            transition: transform 200ms ease;
            z-index: 55; /* sopra viewport (0), sotto DAG (60) */
            box-shadow: -2px 0 8px rgba(0,0,0,0.08);
            font-family: 'Ubuntu', sans-serif;
            color: var(--ibex-text);
            font-size: 11px;
        }
        .ibex-inspector-panel.ibex-inspector-open { transform: translateX(0); }

        /* Durante resize drag: disabilita transition per feedback immediato. */
        .ibex-inspector-panel.resizing { transition: none !important; }

        .ibex-inspector-tab {
            position: absolute;
            left: -36px;
            top: 50%;
            transform: translateY(-50%);
            width: 36px;
            height: 56px;
            background: var(--ibex-surface);
            border: 1px solid var(--ibex-border);
            border-right: none;
            border-radius: 4px 0 0 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--ibex-text-2);
            transition: color 160ms, background 160ms;
            padding: 0;
        }
        .ibex-inspector-tab:hover {
            color: var(--ibex-accent);
            background: var(--ibex-bg);
        }
        .ibex-inspector-tab svg { width: 16px; height: 16px; }
        .ibex-inspector-tab:focus { outline: none; }

        .ibex-inspector-resize-handle {
            position: absolute;
            left: 0;
            top: 0;
            bottom: 0;
            width: 4px;
            cursor: ew-resize;
            background: transparent;
            transition: background 150ms;
            z-index: 2;
        }
        .ibex-inspector-resize-handle:hover,
        .ibex-inspector-resize-handle.dragging { background: var(--ibex-accent); }

        .ibex-inspector-content {
            position: absolute;
            left: 4px; /* lascia spazio al resize handle */
            right: 0;
            top: 0;
            bottom: 0;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 0; /* legge: righe full-bleed, gutter 14px per-riga */
        }

        .ibex-inspector-empty {
            padding: 48px 16px;
            text-align: center;
            color: var(--ibex-text-3);
            font-size: 11px;
            line-height: 1.5;
        }

        .ctx-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 11px 14px;
            border-bottom: 1px solid var(--ibex-border);
            flex: none;
        }
        /* DagSync V2.8 — input editabile per il rename mesh nell'header
           inspector. Sostituisce `.ctx-mesh-name` (rimossa). Aspetto
           identico al testo statico precedente; in focus mostra
           border-bottom accent per feedback editing. */
        .ctx-mesh-rename-input {
            /* ruolo .ctx-title della legge: titolo 13px ink, ellipsis */
            background: transparent;
            border: none;
            border-bottom: 1px solid transparent;
            outline: none;
            flex: 1;
            min-width: 0;
            color: var(--ibex-text);
            font-size: 13px;
            font-weight: 500;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            font-family: inherit;
            cursor: text;
            padding: 0;
            transition: border-bottom-color 150ms;
        }
        .ctx-mesh-rename-input:focus {
            border-bottom-color: var(--ibex-accent);
        }

        /* DagSync V2.8 — sezione proprietà mesh (Visibilità / Opacità /
           Shading) tra header e ctx-body. */
        .ctx-mesh-props {
            padding: 8px 14px;
            border-bottom: 1px solid var(--ibex-border);
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .ctx-prop-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .ctx-prop-label {
            font-size: 9px;
            color: var(--ibex-text-2);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            width: 52px;
            flex-shrink: 0;
        }
        .ctx-prop-opacity {
            flex: 1;
            height: 2px;
            accent-color: var(--ibex-accent);
        }
        .ctx-prop-opacity-val {
            font-size: 9px;
            color: var(--ibex-text-2);
            width: 28px;
            text-align: right;
            font-family: 'Ubuntu Mono', monospace;
        }
        .ctx-prop-vis-btn {
            background: none;
            border: none;
            cursor: pointer;
            color: var(--ibex-text-2);
            padding: 2px;
            display: flex;
            align-items: center;
            transition: color 150ms;
        }
        .ctx-prop-vis-btn:hover { color: var(--ibex-accent); }
        .ctx-prop-shade-btns {
            display: flex;
            gap: 2px;
            margin-left: auto;
        }
        .ctx-prop-shade-btn {
            font-size: 9px;
            padding: 2px 8px;
            border: 1px solid var(--ibex-border);
            border-radius: 2px;
            background: var(--ibex-surface-2);
            color: var(--ibex-text-2);
            cursor: pointer;
            font-family: inherit;
            transition: background 150ms, color 150ms, border-color 150ms;
        }
        .ctx-prop-shade-btn:hover {
            color: var(--ibex-text);
        }
        .ctx-prop-shade-btn.active {
            background: var(--ibex-accent);
            color: white;
            border-color: var(--ibex-accent);
        }

        .ctx-divider {
            height: 1px;
            background: var(--ibex-accent);
            opacity: 0.5;
            margin-top: 6px;
        }
        .ctx-body {
            padding: 0; /* legge: righe full-bleed */
            flex: 1;
            overflow: auto;
        }
        .ctx-empty {
            padding: 16px 10px;
            text-align: center;
            font-size: 10px;
            color: var(--ibex-text-3);
        }

        .ctx-tool {
            /* legge: riga full-bleed con separatore, non card */
            border: none;
            border-bottom: 1px solid var(--ibex-border);
            border-radius: 0;
            margin: 0;
            overflow: hidden;
            background: var(--ibex-surface);
        }
        .ctx-tool-head {
            padding: 8px 14px;
            background: var(--ibex-surface-2);
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
            color: var(--ibex-text);
            font-size: 10px;
            font-weight: 400;
            transition: background 0.15s;
            gap: 6px;
        }
        .ctx-tool-head:hover { background: var(--ibex-bg); }

        /* NodeMute — bottone Mute/Riattiva nel ctx-tool-head + stato `.ctx-tool-muted` */
        .ctx-mute-btn {
            font-size: 9px;
            font-weight: 500;
            padding: 2px 7px;
            border-radius: 3px;
            border: 1px solid var(--ibex-border);
            background: transparent;
            color: var(--ibex-text-2);
            cursor: pointer;
            transition: all 0.12s;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            user-select: none;
        }
        .ctx-mute-btn:hover {
            border-color: var(--ibex-accent);
            color: var(--ibex-accent);
        }
        .ctx-mute-btn.is-muted {
            background: var(--ibex-text-3);
            color: var(--ibex-surface);
            border-color: var(--ibex-text-3);
        }
        .ctx-mute-btn.is-muted:hover {
            background: var(--ibex-accent);
            border-color: var(--ibex-accent);
        }
        .ctx-tool.ctx-tool-muted .ctx-tool-name {
            opacity: 0.5;
            text-decoration: line-through;
        }
        .ctx-tool.ctx-tool-muted .ctx-tool-body {
            opacity: 0.6;
        }
        .ctx-tool-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            text-transform: lowercase;
        }
        .ctx-chev {
            font-size: 8px;
            color: var(--ibex-text-3);
            transition: transform 0.15s;
            flex-shrink: 0;
        }
        .ctx-tool.expanded .ctx-chev { transform: rotate(90deg); }
        .ctx-tool-body {
            padding: 6px 14px 10px;
            display: none;
            background: var(--ibex-surface);
            border-top: 1px solid var(--ibex-border);
        }
        .ctx-tool.expanded .ctx-tool-body { display: block; }

        /* ── Vocabolario legge Editor reale (:270-297) — verbatim, token-driven.
           Le classi sono inerti finché il markup (sub-deploy C) non le usa. ── */
        .ctx-strip{width:3px;height:18px;border-radius:2px;background:var(--ibex-geo);flex:none}
        .ctx-title{font-size:13px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .ctx-type{font-family:'Ubuntu Mono',monospace;font-size:9px;padding:2px 7px;border-radius:3px;border:1px solid var(--ibex-border);color:var(--ibex-text-2);flex:none}
        .ctx-target{padding:7px 14px;border-bottom:1px solid var(--ibex-border);font-family:'Ubuntu Mono',monospace;font-size:10px;color:var(--ibex-text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .ctx-section{padding:8px 14px 4px;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:.1em;color:var(--ibex-text-3)}
        .ctx-field{padding:6px 14px 10px;display:flex;flex-direction:column;gap:7px}
        .ctx-fieldhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
        .ctx-lbl{font-size:12px;color:var(--ibex-text-2)}
        .ctx-val{font-family:'Ubuntu Mono',monospace;font-size:13px;color:var(--ibex-text)}
        .ctx-val .u{color:var(--ibex-text-3);font-size:10px;margin-left:2px}
        .ctx-stepper{display:flex;gap:6px}
        .ctx-stepper .st{width:34px;height:34px;flex:none;border:1px solid var(--ibex-border);background:var(--ibex-surface);border-radius:var(--r-input);color:var(--ibex-text);font-size:18px;line-height:1;display:grid;place-items:center;cursor:pointer;transition:border-color .15s,background .15s}
        .ctx-stepper .st:hover{border-color:var(--ibex-text);background:var(--ibex-bg)}
        .ctx-stepper input{flex:1;min-width:0;height:34px;background:var(--ibex-bg);border:1px solid var(--ibex-border);color:var(--ibex-text);padding:0 8px;border-radius:var(--r-input);text-align:center;outline:none;font-family:'Ubuntu Mono',monospace;font-size:13px}
        .ctx-stepper input:focus{border-color:var(--ibex-accent)}
        .ctx-seg{display:flex;width:100%;border:1px solid var(--ibex-border);border-radius:var(--r-input);overflow:hidden}
        .ctx-seg button{flex:1;height:34px;border:none;background:var(--ibex-surface);color:var(--ibex-text-2);font-family:inherit;font-size:12px;cursor:pointer;border-right:1px solid var(--ibex-border);transition:background .15s,color .15s}
        .ctx-seg button:last-child{border-right:none}
        .ctx-seg button.on{background:var(--ibex-text);color:var(--ibex-surface)}
        .ctx-foot{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--ibex-border);margin-top:4px}
        .ctx-foot button{flex:1;height:34px;border-radius:var(--r-pill);border:1px solid var(--ibex-border);background:transparent;font-family:inherit;font-size:12px;font-weight:500;color:var(--ibex-text);display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;transition:border-color .15s,color .15s}
        .ctx-foot button:hover{border-color:var(--ibex-text)}
        .ctx-foot .danger{color:var(--ibex-error)}
        .ctx-foot .danger:hover{border-color:var(--ibex-error)}
        .ctx-foot svg{width:14px;height:14px}
        /* dentro l'accordion per-tool il gutter 14px lo dà già .ctx-tool-body */
        .ctx-tool-body .ctx-field, .ctx-tool-body .ctx-foot { padding-left: 0; padding-right: 0; }

        /* Gizmo-follow (legge, adattata all'id app): il ViewGizmo scivola a
           sinistra quando l'inspector è aperto; niente easing durante il drag. */
        body:has(#ibex-inspector-panel.ibex-inspector-open) #ibex-view-gizmo-ui { right: calc(var(--inspector-w) + 16px); }
        body:has(#ibex-inspector-panel.resizing) #ibex-view-gizmo-ui { transition: none; }

        /* Sezione sculpt */
        .ctx-sculpt {
            padding: 8px;
            border-top: 1px solid var(--ibex-border);
            background: var(--ibex-surface-2);
        }
        .ctx-sculpt-title {
            color: var(--ibex-accent);
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            margin-bottom: 6px;
            font-weight: 500;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .ctx-sculpt-btns {
            display: flex;
            flex-wrap: wrap;    /* V2.2 (Obiettivo 2/4): 5+ bottoni a 192px */
            gap: 2px;
            margin-bottom: 8px;
        }
        /* V2.2: a 5+ bottoni flex:1 rende ciascuno troppo stretto — fisso
           min-width per evitare il collasso del testo. A 192px panel con
           padding, 5 bottoni a 55-60px entrano in 2 righe. */
        .ctx-sculpt-btns .ctx-sculpt-btn { min-width: 56px; }
        .ctx-sculpt-btn {
            flex: 1;
            padding: 5px 4px;
            font-size: 9px;
            text-transform: uppercase;
            background: var(--ibex-surface-2);
            color: var(--ibex-text-2);
            border: 1px solid var(--ibex-border);
            border-radius: 2px;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.15s;
            font-family: 'Ubuntu', sans-serif;
        }
        .ctx-sculpt-btn.active {
            background: var(--ibex-accent);
            color: var(--ibex-text);
            border-color: var(--ibex-accent);
        }
        .ctx-sculpt-btn:hover:not(.active) {
            border-color: var(--ibex-accent);
            color: var(--ibex-accent);
        }
        .ctx-sculpt-slider-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 9px;
            color: var(--ibex-text-2);
            margin-bottom: 2px;
        }
        .ctx-sculpt-slider-val { color: var(--ibex-accent); font-family: 'Ubuntu Mono', monospace; }
        .ctx-sculpt-slider {
            width: 100%;
            accent-color: var(--ibex-accent);
            margin-bottom: 8px;
        }
        .ctx-sculpt-enter-btn {
            width: 100%;
            padding: 6px;
            background: var(--ibex-accent);
            color: var(--ibex-text);
            border: none;
            border-radius: 2px;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            cursor: pointer;
            font-weight: 500;
            font-family: 'Ubuntu', sans-serif;
            transition: background 0.15s;
        }
        .ctx-sculpt-enter-btn:hover { background: #E85530; }
        .ctx-sculpt-exit-btn {
            background: transparent;
            color: var(--ibex-text-3);
            border: none;
            font-size: 10px;
            cursor: pointer;
            padding: 2px 4px;
            font-family: 'Ubuntu', sans-serif;
        }
        .ctx-sculpt-exit-btn:hover { color: var(--ibex-accent); }

        /* V2.3 (2026-04-27) — selettore +/- (Obiettivo 3/4). Compatto:
           label "Segno" + 2 bottoni `+` / `−` affiancati. Visibile solo
           quando il brush attivo è inflate o crease. */
        .ctx-sculpt-sign-row {
            margin-top: 6px;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .ctx-sculpt-sign-label {
            font-size: 9px;
            color: var(--ibex-text-2);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            flex: none;
        }
        .ctx-sculpt-sign-btns {
            display: flex;
            gap: 3px;
            flex: 1;
        }
        .ctx-sculpt-sign-btn {
            flex: 1;
            padding: 3px 0;
            font-size: 12px;
            font-weight: 600;
            line-height: 1;
            background: var(--ibex-surface-2);
            color: var(--ibex-text-2);
            border: 1px solid var(--ibex-border);
            border-radius: 2px;
            cursor: pointer;
            transition: all 0.12s;
            font-family: 'Ubuntu Mono', monospace;
        }
        .ctx-sculpt-sign-btn.active {
            background: var(--ibex-accent);
            color: var(--ibex-text);
            border-color: var(--ibex-accent);
        }
        .ctx-sculpt-sign-btn:hover:not(.active) {
            border-color: var(--ibex-accent);
            color: var(--ibex-accent);
        }

        /* V2.7 (2026-04-27) — selettore falloff (Obiettivo 1/4). Riga con
           label + 4 bottoni compatti (Smooth/Linear/Sphere/Sharp). Sempre
           visibile; no-op per brush Smooth (laplacian puro). */
        .ctx-sculpt-falloff-row {
            margin-top: 8px;
            padding-top: 6px;
            border-top: 1px solid var(--ibex-border);
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-bottom: 8px;
        }
        .ctx-sculpt-falloff-label {
            font-size: 9px;
            color: var(--ibex-text-2);
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .ctx-sculpt-falloff-btns {
            display: flex;
            gap: 2px;
        }
        /* V2.6 (2026-04-27): bottoni falloff con icona SVG inline (3 tipi:
           Smooth U / Sharp V / Cylinder rettangolo). Dimensione fissa 36px
           per allineamento + flex:0 0 auto per evitare stretch. SVG usa
           `currentColor` su `stroke` → colora dal color del bottone. */
        .ctx-sculpt-falloff-btn {
            flex: 0 0 auto;
            width: 36px;
            padding: 3px 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: var(--ibex-surface-2);
            color: var(--ibex-text-2);
            border: 1px solid var(--ibex-border);
            border-radius: 2px;
            cursor: pointer;
            transition: all 0.12s;
            font-family: 'Ubuntu', sans-serif;
        }
        .ctx-sculpt-falloff-btn svg { display: block; }
        .ctx-sculpt-falloff-btn.active {
            background: var(--ibex-accent);
            color: var(--ibex-text);
            border-color: var(--ibex-accent);
        }
        .ctx-sculpt-falloff-btn:hover:not(.active) {
            border-color: var(--ibex-accent);
            color: var(--ibex-accent);
        }

        /* DagSync V2.9 / V1.3 — 3 selection modes (Circle / Box / Lasso).
           Pattern visivo identico a `.ctx-sculpt-falloff-btn` per coerenza
           UI. Il bottone `.active` ha background accent, hover accent border. */
        .ctx-sel-mode-row {
            display: flex;
            gap: 4px;
            margin-bottom: 6px;
        }
        .ctx-sel-mode-btn {
            flex: 0 0 auto;
            width: 36px;
            padding: 3px 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: var(--ibex-surface-2);
            color: var(--ibex-text-2);
            border: 1px solid var(--ibex-border);
            border-radius: 2px;
            cursor: pointer;
            transition: all 0.12s;
            font-family: 'Ubuntu', sans-serif;
        }
        .ctx-sel-mode-btn svg { display: block; }
        .ctx-sel-mode-btn.active {
            background: var(--ibex-accent);
            color: var(--ibex-text);
            border-color: var(--ibex-accent);
        }
        .ctx-sel-mode-btn:hover:not(.active) {
            border-color: var(--ibex-accent);
            color: var(--ibex-accent);
        }
        .ctx-sel-hint {
            font-size: 9px;
            color: var(--ibex-text-3);
            margin-bottom: 6px;
            font-family: 'Ubuntu Mono', monospace;
            letter-spacing: 0.02em;
        }

        /* DagSync V2.10 — toggle "Attraverso" (X-ray). Pattern simile alla
           checkbox dyntopo. Default off = solo superficie front-facing. */
        .ctx-sel-xray-row {
            display: flex;
            align-items: center;
            gap: 6px;
            margin: 4px 0 6px 0;
            padding: 0;
            font-size: 10px;
            color: var(--ibex-text-2);
            cursor: pointer;
            user-select: none;
        }
        .ctx-sel-xray-row input[type="checkbox"] {
            accent-color: var(--ibex-accent);
            cursor: pointer;
            margin: 0;
        }
        .ctx-sel-xray-row:hover { color: var(--ibex-text); }

        /* S4 (2026-04-26) — checkbox Dyntopo nel pannello sculpt.
           Sempre cliccabile (S4-A7). Skip silenzioso lato SculptMode se brush=smooth. */
        .ctx-sculpt-dyntopo-row {
            display: flex; align-items: center; gap: 6px;
            margin-top: 8px; padding-top: 6px;
            border-top: 1px solid var(--ibex-border);
            font-size: 10px; color: var(--ibex-text-2);
            cursor: pointer; user-select: none;
        }
        .ctx-sculpt-dyntopo-row input[type="checkbox"] {
            accent-color: var(--ibex-accent);
            cursor: pointer;
        }
        .ctx-sculpt-dyntopo-row:hover { color: var(--ibex-text); }

        /* V2.6 (2026-04-27): pulsante "Flood" accanto a checkbox Dyntopo.
           Applica il target edge len a tutta la mesh in un colpo solo. */
        .ctx-sculpt-flood-btn {
            margin-left: auto;      /* push to right end of dyntopo row */
            padding: 3px 8px;
            font-size: 9px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            background: var(--ibex-accent);
            color: var(--ibex-text);
            border: 1px solid var(--ibex-accent);
            border-radius: 2px;
            cursor: pointer;
            font-family: 'Ubuntu', sans-serif;
            transition: background 0.12s;
        }
        .ctx-sculpt-flood-btn:hover { background: #E85530; border-color: #E85530; }

        /* V2.6 (2026-04-27): checkbox Lazy (pattern identico a Dyntopo). */
        .ctx-sculpt-lazy-row {
            display: flex; align-items: center; gap: 6px;
            margin-top: 6px;
            font-size: 10px; color: var(--ibex-text-2);
            cursor: pointer; user-select: none;
        }
        .ctx-sculpt-lazy-row input[type="checkbox"] {
            accent-color: var(--ibex-accent);
            cursor: pointer;
        }
        .ctx-sculpt-lazy-row:hover { color: var(--ibex-text); }

        /* ─── SnapshotKeyed S2: Selection controls (delete_topology) ─────────
           Riusa gran parte dei pattern .ctx-sculpt-* (slider, slider-row, slider-val).
           Classi proprietarie qui per le differenze semantiche (mode add/remove,
           bottone delete rosso, contatore facce). */
        .ctx-selection {
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--ibex-border);
        }
        .ctx-selection-title {
            display: flex; justify-content: space-between; align-items: center;
            font-size: 10px; color: var(--ibex-text-2); text-transform: uppercase;
            letter-spacing: 0.05em; margin-bottom: 6px;
        }
        .ctx-selection-btns {
            display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 6px;
        }
        .ctx-selection-btn {
            background: var(--ibex-surface-2); color: var(--ibex-text-2);
            border: 1px solid var(--ibex-border); border-radius: 3px;
            padding: 4px 0; font-size: 10px; cursor: pointer;
            font-family: 'Ubuntu', sans-serif; transition: all 0.12s;
        }
        .ctx-selection-btn.active {
            background: #C4302B; color: #ffffff; border-color: #C4302B;
        }
        .ctx-selection-btn:hover:not(.active) {
            border-color: #C4302B; color: var(--ibex-text);
        }
        .ctx-selection-count {
            font-size: 10px; color: var(--ibex-text-2); text-align: center;
            padding: 6px 0 4px; font-family: 'Ubuntu Mono', monospace;
        }
        .ctx-selection-btn-delete {
            display: block; width: 100%;
            background: var(--ibex-border-strong); color: var(--ibex-text-3);
            border: 1px solid var(--ibex-border); border-radius: 3px;
            padding: 6px 0; font-size: 11px; font-weight: 500;
            font-family: 'Ubuntu', sans-serif;
            cursor: not-allowed;
            transition: all 0.12s;
        }
        .ctx-selection-btn-delete.ctx-selection-btn-enabled {
            background: #C4302B; color: #ffffff; border-color: #C4302B;
            cursor: pointer;
        }
        .ctx-selection-btn-delete.ctx-selection-btn-enabled:hover {
            background: #A8221F; border-color: #A8221F;
        }
        /* SnapshotKeyed S3 (post-deploy UX) — blocco output names nel nodo split_topology.
           Due righe (branch A/B) con badge verde + nome file (senza .stl per compattezza).
           Visibile sempre (placeholder "—" se non ancora eseguito). */
        .ibex-split-outputs {
            margin-top: 6px;
            padding-top: 6px;
            border-top: 1px dashed var(--ibex-border);
            display: flex; flex-direction: column; gap: 3px;
        }
        .ibex-split-out {
            display: flex; align-items: center; gap: 5px;
            font-size: 9px; font-family: 'Ubuntu Mono', monospace;
            color: var(--ibex-text-2);
        }
        .ibex-split-out-badge {
            display: inline-block;
            width: 14px; height: 14px; line-height: 14px;
            text-align: center; font-weight: 600;
            border-radius: 2px;
            background: #1F8A4C; color: #ffffff;
            font-family: 'Ubuntu', sans-serif; font-size: 9px;
        }
        .ibex-split-out-name {
            flex: 1; min-width: 0;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        /* SplitBranchRename (2026-05-05) — input editabili per i nomi
           branch A/B nel nodo split_topology. Same look del .ibex-split-out-name
           (read-only) ma editabile, focus accent arancione, disabled grayed. */
        .ibex-split-out-name-input {
            flex: 1; min-width: 0;
            background: transparent;
            border: 1px solid transparent;
            border-radius: 2px;
            padding: 1px 4px;
            font-size: 9px; font-family: 'Ubuntu Mono', monospace;
            color: var(--ibex-text-2);
            outline: none;
            cursor: text;
        }
        .ibex-split-out-name-input::placeholder {
            color: var(--ibex-text-3);
            opacity: 0.7;
        }
        .ibex-split-out-name-input:hover:not(:disabled) {
            border-color: var(--ibex-border);
        }
        .ibex-split-out-name-input:focus {
            border-color: var(--ibex-accent);
            background: var(--ibex-surface);
            color: var(--ibex-text);
        }
        .ibex-split-out-name-input:disabled {
            cursor: not-allowed;
            color: var(--ibex-text-3);
        }

        /* CurveDisplayName V5.16 (2026-05-14) — output curva con input
           editabile per il display name. Same look del split-output ma
           con accent viola CRV (#2A6FDB) sul badge. Sempre enabled (il
           nome è libero anche pre-bake — è solo una label UI). */
        .ibex-curve-output {
            margin-top: 6px;
            padding-top: 6px;
            border-top: 1px dashed var(--ibex-border);
            display: flex; align-items: center; gap: 5px;
        }
        .ibex-curve-output-badge {
            display: inline-block;
            width: 26px; height: 14px; line-height: 14px;
            text-align: center; font-weight: 600;
            border-radius: 2px;
            background: #2A6FDB; color: #ffffff;
            font-family: 'Ubuntu', sans-serif; font-size: 9px;
        }
        .ibex-curve-output-name-input {
            flex: 1; min-width: 0;
            background: transparent;
            border: 1px solid transparent;
            border-radius: 2px;
            padding: 1px 4px;
            font-size: 9px; font-family: 'Ubuntu Mono', monospace;
            color: var(--ibex-text-2);
            outline: none;
            cursor: text;
        }
        .ibex-curve-output-name-input::placeholder {
            color: var(--ibex-text-3);
            opacity: 0.7;
        }
        .ibex-curve-output-name-input:hover {
            border-color: var(--ibex-border);
        }
        .ibex-curve-output-name-input:focus {
            border-color: #2A6FDB;
            background: var(--ibex-surface);
            color: var(--ibex-text);
        }

        /* SnapshotKeyed S3 — bottone "Separa selezione" verde (S3 Extra utente). */
        .ctx-selection-btn-split {
            display: block; width: 100%;
            background: var(--ibex-border-strong); color: var(--ibex-text-3);
            border: 1px solid var(--ibex-border); border-radius: 3px;
            padding: 6px 0; font-size: 11px; font-weight: 500;
            font-family: 'Ubuntu', sans-serif;
            cursor: not-allowed;
            transition: all 0.12s;
        }
        .ctx-selection-btn-split.ctx-selection-btn-enabled {
            background: #1F8A4C; color: #ffffff; border-color: #1F8A4C;
            cursor: pointer;
        }
        .ctx-selection-btn-split.ctx-selection-btn-enabled:hover {
            background: #186E3C; border-color: #186E3C;
        }
        /* topology_rebuild V1.0 (2026-05-05) — bottone "Ricostruisci" blu accent
           medicale (distinto da delete=rosso, split=verde, sculpt-flow neutro). */
        .ctx-selection-btn-rebuild {
            display: block; width: 100%;
            background: var(--ibex-border-strong); color: var(--ibex-text-3);
            border: 1px solid var(--ibex-border); border-radius: 3px;
            padding: 6px 0; font-size: 11px; font-weight: 500;
            font-family: 'Ubuntu', sans-serif;
            cursor: not-allowed;
            transition: all 0.12s;
        }
        .ctx-selection-btn-rebuild.ctx-selection-btn-enabled {
            background: #2A6FDB; color: #ffffff; border-color: #2A6FDB;
            cursor: pointer;
        }
        .ctx-selection-btn-rebuild.ctx-selection-btn-enabled:hover {
            background: #1E5BC0; border-color: #1E5BC0;
        }

        /* draw_curve V1.0 (2026-05-06) — sezione curva nell'inspector */
        .ctx-curve {
            display: flex; flex-direction: column; gap: 6px;
        }
        .ctx-curve-summary {
            font-size: 10px; color: var(--ibex-text-2);
            font-family: 'Ubuntu Mono', monospace;
            padding: 4px 6px;
            background: var(--ibex-surface-2);
            border-radius: 3px;
        }
        .ctx-curve-enter-btn {
            display: block; width: 100%;
            background: var(--ibex-crv); color: #ffffff;
            border: none; border-radius: 3px;
            padding: 6px 0; font-size: 11px; font-weight: 500;
            font-family: 'Ubuntu', sans-serif; cursor: pointer;
            transition: background 0.12s;
        }
        .ctx-curve-enter-btn:hover { background: #1E5BC0; }
        .ctx-curve-title {
            display: flex; justify-content: space-between; align-items: center;
            font-size: 10px; font-weight: 600;
            color: var(--ibex-text);
        }
        .ctx-curve-exit-btn {
            background: transparent; border: none; cursor: pointer;
            color: var(--ibex-text-2); font-size: 10px;
            font-family: 'Ubuntu', sans-serif;
        }
        .ctx-curve-exit-btn:hover { color: var(--ibex-text); }
        .ctx-curve-status {
            background: var(--ibex-surface-2);
            border-radius: 3px; padding: 4px 6px;
        }
        .ctx-curve-status-row {
            display: flex; justify-content: space-between;
            font-size: 9px; font-family: 'Ubuntu Mono', monospace;
            color: var(--ibex-text-2);
        }
        .ctx-curve-active-info {
            color: var(--ibex-crv); font-weight: 600;
        }
        .ctx-curve-hint {
            font-size: 9px; color: var(--ibex-text-3);
            font-style: italic; text-align: center;
            font-family: 'Ubuntu Mono', monospace;
        }
        .ctx-curve-btns {
            display: flex; flex-direction: column; gap: 3px;
        }
        .ctx-curve-btn {
            background: var(--ibex-surface-2); color: var(--ibex-text);
            border: 1px solid var(--ibex-border); border-radius: 3px;
            padding: 4px 0; font-size: 10px;
            font-family: 'Ubuntu', sans-serif; cursor: pointer;
            transition: all 0.12s;
        }
        .ctx-curve-btn:hover:not(:disabled) {
            background: var(--ibex-crv); color: #ffffff; border-color: var(--ibex-crv);
        }
        .ctx-curve-btn:disabled {
            cursor: not-allowed; opacity: 0.5;
        }
        .ctx-curve-cyclic { font-weight: 500; }
        .ctx-curve-new { font-weight: 500; }

        /* curve_edit V1.0 (2026-05-12) — controlli specifici per CurveEditMode */
        .ctx-curveedit-enter-btn {
            display: block; width: 100%;
            background: var(--ibex-crv, #2A6FDB); color: #ffffff;
            border: none; border-radius: 3px;
            padding: 6px 0; font-size: 11px; font-weight: 500;
            font-family: 'Ubuntu', sans-serif; cursor: pointer;
            transition: background 0.12s;
        }
        .ctx-curveedit-enter-btn:hover { background: #1E5BC0; }
        .ctx-curveedit-splines-row {
            display: flex; align-items: center; gap: 4px;
            font-size: 9px; color: var(--ibex-text-2);
            font-family: 'Ubuntu Mono', monospace;
            flex-wrap: wrap;
        }
        .ctx-curveedit-spline-btn {
            background: var(--ibex-surface-2); color: var(--ibex-text-2);
            border: 1px solid var(--ibex-border);
            border-radius: 3px;
            padding: 2px 6px; font-size: 9px; min-width: 24px;
            font-family: 'Ubuntu Mono', monospace; cursor: pointer;
        }
        .ctx-curveedit-spline-btn:hover {
            border-color: var(--ibex-crv, #2A6FDB);
        }
        .ctx-curveedit-spline-active {
            background: var(--ibex-crv, #2A6FDB); color: white;
            border-color: var(--ibex-crv, #2A6FDB);
        }
        .ctx-curveedit-active-info {
            color: var(--ibex-crv, #2A6FDB); font-weight: 600;
        }
        .ctx-curveedit-save-btn:hover:not(:disabled) {
            background: #186E3C !important;  /* darker green */
            border-color: #186E3C !important;
        }
        .ctx-curveedit-cancel-btn:hover:not(:disabled) {
            background: #C4302B; color: white; border-color: #C4302B;
        }

        /* arch_detect V1.1 (2026-05-12) — sezione inspector metadata + actions */
        .ctx-archdetect {
            display: flex; flex-direction: column; gap: 6px;
        }
        .ctx-archdetect-metadata {
            display: flex; flex-direction: column; gap: 2px;
            padding: 6px 8px;
            background: var(--ibex-surface-2);
            border-radius: 3px;
            border-left: 2px solid var(--ibex-crv, #2A6FDB);
        }
        .ctx-archdetect-row {
            display: flex; justify-content: space-between; align-items: center;
            font-size: 9px; color: var(--ibex-text-2);
            font-family: 'Ubuntu Mono', monospace;
            line-height: 1.5;
        }
        .ctx-archdetect-val {
            color: var(--ibex-text); font-weight: 600;
        }
        .ctx-archdetect-empty {
            font-size: 10px; color: var(--ibex-text-3);
            font-style: italic; text-align: center;
            padding: 8px;
            background: var(--ibex-surface-2);
            border-radius: 3px;
            font-family: 'Ubuntu', sans-serif;
            line-height: 1.5;
        }
        .ctx-archdetect-btns {
            display: flex; flex-direction: column; gap: 3px;
        }
        .ctx-archdetect-toggle-btn,
        .ctx-archdetect-refresh-btn,
        .ctx-archdetect-recompute-btn {
            background: var(--ibex-surface-2); color: var(--ibex-text);
            border: 1px solid var(--ibex-border); border-radius: 3px;
            padding: 5px 0; font-size: 10px;
            font-family: 'Ubuntu', sans-serif; cursor: pointer;
            transition: all 0.12s;
        }
        .ctx-archdetect-toggle-btn:hover:not(:disabled),
        .ctx-archdetect-refresh-btn:hover:not(:disabled) {
            background: var(--ibex-crv, #2A6FDB); color: white;
            border-color: var(--ibex-crv, #2A6FDB);
        }
        .ctx-archdetect-toggle-btn.is-visible {
            background: var(--ibex-crv, #2A6FDB); color: white;
            border-color: var(--ibex-crv, #2A6FDB);
        }
        .ctx-archdetect-toggle-btn:disabled,
        .ctx-archdetect-recompute-btn:disabled {
            cursor: not-allowed; opacity: 0.5;
        }
        .ctx-archdetect-recompute-btn:hover:not(:disabled) {
            background: #FF6037; color: white; border-color: #FF6037;
        }

        /* arch_detect V1.8 — controlli template + Z-offset */
        .ctx-archdetect-controls {
            display: flex; flex-direction: column; gap: 6px;
            padding: 6px 4px;
        }
        .ctx-archdetect-control-row {
            display: flex; flex-direction: column; gap: 3px;
        }
        .ctx-archdetect-label {
            display: flex; justify-content: space-between; align-items: center;
            font-size: 9px; color: var(--ibex-text-2);
            font-family: 'Ubuntu', sans-serif;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }
        .ctx-archdetect-zoffset-val {
            color: var(--ibex-crv, #2A6FDB); font-weight: 700;
            font-family: 'Ubuntu Mono', monospace;
            font-size: 10px;
        }
        .ctx-archdetect-template-select {
            width: 100%;
            background: var(--ibex-bg);
            color: var(--ibex-text);
            border: 1px solid var(--ibex-border);
            border-radius: 3px;
            padding: 4px 6px;
            font-size: 10px;
            font-family: 'Ubuntu', sans-serif;
            cursor: pointer;
        }
        .ctx-archdetect-template-select:focus {
            outline: none;
            border-color: var(--ibex-crv, #2A6FDB);
        }
        .ctx-archdetect-zoffset-slider,
        .ctx-archdetect-slider {
            width: 100%;
            accent-color: var(--ibex-crv, #2A6FDB);
            height: 4px;
        }
        /* Cross-browser: forza colore track/thumb anche dove accent-color non basta */
        .ctx-archdetect-slider::-webkit-slider-thumb {
            background: var(--ibex-crv, #2A6FDB);
        }
        .ctx-archdetect-slider::-moz-range-thumb {
            background: var(--ibex-crv, #2A6FDB);
            border: none;
        }

        .ctx-selection-enter-btn {
            display: block; width: 100%;
            background: #C4302B; color: #ffffff;
            border: none; border-radius: 3px;
            padding: 6px 0; font-size: 11px; font-weight: 500; cursor: pointer;
            font-family: 'Ubuntu', sans-serif; transition: background 0.12s;
        }
        .ctx-selection-enter-btn:hover { background: #A8221F; }
        .ctx-selection-exit-btn {
            background: transparent; color: var(--ibex-text-3);
            border: none; font-size: 10px; cursor: pointer; padding: 2px 4px;
            font-family: 'Ubuntu', sans-serif;
        }
        .ctx-selection-exit-btn:hover { color: #C4302B; }

        /* ─── Scrollbar ────────────────────────────────────────── */
        .custom-scroll::-webkit-scrollbar         { width: 6px; height: 6px; }
        .custom-scroll::-webkit-scrollbar-track   { background: transparent; }
        .custom-scroll::-webkit-scrollbar-thumb   { background: var(--ibex-border-strong); border-radius: 3px; }
        .custom-scroll::-webkit-scrollbar-thumb:hover { background: var(--ibex-text-3); }
        * { scrollbar-width: thin; scrollbar-color: var(--ibex-border-strong) transparent; }

        ::selection { background: var(--ibex-accent); color: var(--ibex-text); }

        /* ─── Override Tailwind ricorrenti ─────────────────────── */
        .bg-white,
        .bg-white\/90, .bg-white\/95,
        .bg-white\/5,  .bg-white\/50,
        .bg-gray-50, .bg-gray-50\/50,
        .bg-gray-100 { background-color: var(--ibex-surface) !important; }
        .bg-gray-900 { background-color: var(--ibex-surface-2) !important; }
        .bg-orange-50, .bg-red-50, .bg-green-50 { background-color: var(--ibex-surface-2) !important; }
        .text-gray-900, .text-gray-800, .text-gray-700, .text-gray-600 { color: var(--ibex-text)   !important; }
        .text-gray-500, .text-gray-400, .text-gray-300                 { color: var(--ibex-text-2) !important; }
        .text-white, .text-white\/70, .text-white\/80, .text-white\/90 { color: var(--ibex-text)   !important; }
        .text-white\/50                                                { color: var(--ibex-text-2) !important; }
        .border-gray-100, .border-gray-200,
        .border-white\/10, .border-white\/20, .border-white\/30,
        .border-red-100, .border-orange-200 { border-color: var(--ibex-border) !important; }
        .shadow-sm, .shadow-lg, .shadow-2xl, .shadow-inner {
            box-shadow: 0 2px 8px rgba(0,0,0,0.08) !important;
        }
        .animate-pulse { animation: none !important; }

        /* ─── Outliner items (runtime da OutlinerManager) ────────
           Valori = legge Editor reale; gli !important servono a battere
           le utility Tailwind scritte a runtime da OutlinerManager. */
        .outliner-item {
            background: transparent !important;
            border: none !important;
            border-left: 2px solid transparent !important;
            border-radius: 3px !important;
            padding: 5px 8px !important;
        }
        .outliner-item:hover { background: var(--ibex-bg) !important; border-color: transparent !important; }
        .outliner-item span {
            color: var(--ibex-text) !important;
            font-weight: 400 !important;
            font-size: 11px !important;
        }
        .outliner-item button {
            color: var(--ibex-text-2) !important;
            transition: color 0.15s;
        }
        .outliner-item button:hover { color: var(--ibex-accent) !important; }
        .outliner-item button svg { width: 13px; height: 13px; }
        .outliner-item input[type="range"] { accent-color: var(--ibex-accent); }

        /* ─── P7 S3 — classi proprie ex-Tailwind di OutlinerManager (runtime) ── */
        .outliner-list-wrapper { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
        .outliner-empty { font-size: 12px; color: var(--ibex-text-3); text-align: center; padding: 8px 0; }
        .outliner-empty--lg { padding: 16px 0; }
        .outliner-item { display: flex; align-items: center; justify-content: space-between; transition: background .15s, border-color .15s; }
        .outliner-left { display: flex; align-items: center; gap: 8px; overflow: hidden; flex: 1; min-width: 0; }
        .outliner-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
        input.outliner-name { background: var(--ibex-bg); border: 1px solid var(--ibex-border); border-radius: 3px; padding: 0 4px; color: var(--ibex-text); outline: none; font: inherit; }
        .outliner-tools { display: flex; align-items: center; gap: 4px; opacity: 0; transition: opacity .15s; }
        .outliner-item:hover .outliner-tools { opacity: 1; }
        .outliner-btn { padding: 4px; background: transparent; border: none; cursor: pointer; display: inline-flex; align-items: center; }
        .outliner-opacity { position: relative; width: 64px; height: 16px; display: flex; align-items: center; }
        .outliner-opacity input { width: 100%; height: 4px; background: var(--ibex-border); border-radius: 8px; appearance: none; -webkit-appearance: none; cursor: pointer; }
        .outliner-item.is-dragging { opacity: .5; }

        /* ─── Outliner sezioni collassabili V14 (2026-05-14) ────── */
        .outliner-section {
            display: flex;
            flex-direction: column;
            margin-bottom: 4px;
        }
        .outliner-section-header {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 8px;
            color: var(--ibex-text-3);
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            border-bottom: 1px solid var(--ibex-border);
            cursor: pointer;
            user-select: none;
            transition: color 0.12s, border-color 0.12s;
            font-family: 'Ubuntu', sans-serif;
        }
        .outliner-section-header:hover {
            color: var(--ibex-accent);
            border-bottom-color: var(--ibex-accent);
        }
        .outliner-section-chevron {
            width: 10px;
            height: 10px;
            flex-shrink: 0;
            transition: transform 0.15s ease;
        }
        .outliner-section-label {
            flex: 1;
            min-width: 0;
        }
        .outliner-section-count {
            font-family: 'Ubuntu Mono', monospace;
            font-size: 9px;
            color: var(--ibex-text-3);
            background: var(--ibex-surface-2);
            border: 1px solid var(--ibex-border);
            border-radius: 8px;
            padding: 0 5px;
            line-height: 1.4;
        }
        .outliner-section-body {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 4px 0 6px 0;
        }
        .outliner-section.collapsed .outliner-section-chevron {
            transform: rotate(-90deg);
        }
        .outliner-section.collapsed .outliner-section-body {
            display: none;
        }
        /* Sezione curve — accent CRV sul hover header (token, segue il dark) */
        .outliner-section[data-section="curves"] .outliner-section-header:hover {
            color: var(--ibex-crv);
            border-bottom-color: var(--ibex-crv);
        }

        /* Resize handle generico (classe helper usata dall'#dag-resize-handle).
           Selettore tenuto per retrocompatibilità con ibexInitResize() che
           itera su `.ibex-resize-handle`. */
        .ibex-resize-handle {
            user-select: none;
            touch-action: none;
        }

        /* ─── Loading overlay ──────────────────────────────────── */
        /* P7 de-Tailwind: layout/spinner del loading in CSS proprio (la struttura
           div>div+div è contratto con gli override colore sottostanti). */
        #loading-overlay { position: fixed; inset: 0; z-index: 9999; display: flex; flex-direction: column; align-items: center; justify-content: center; transition: opacity .5s; }
        .loading-spinner { position: relative; width: 96px; height: 96px; margin-bottom: 32px; }
        .loading-spinner > div { position: absolute; inset: 0; border: 4px solid; border-radius: 50%; }
        .loading-spinner > div:last-child { border-top-color: transparent; animation: ibex-spin 1s linear infinite; }
        @keyframes ibex-spin { 100% { transform: rotate(360deg); } }
        #loading-overlay { background: var(--ibex-bg) !important; }
        #loading-overlay > div > div:first-child { border-color: var(--ibex-border) !important; }
        #loading-overlay > div > div:last-child  { border-color: var(--ibex-accent) !important; border-top-color: transparent !important; }
        #loading-msg {
            color: var(--ibex-text-2) !important;
            font-weight: 500 !important;
            letter-spacing: 0.2em !important;
            font-size: 10px;
            text-transform: uppercase;
        }

        /* ─── Modal migrazione legacy v1.0 → v2.0 (Sessione 3) ── */
        /* Preset DAG (2026-05-05) — floating bar + modal salva preset */
        #ibex-multiselect-bar {
            position: fixed;
            bottom: 24px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 65;
            display: inline-flex;
            align-items: center;
            gap: 12px;
            padding: 8px 14px;
            background: var(--ibex-surface, #fff);
            border: 1px solid var(--ibex-border-strong, #D2D5D8);
            border-radius: 6px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.15);
            font-size: 12px;
            color: var(--ibex-text, #0B0B0C);
            transition: opacity 0.15s, transform 0.15s;
        }
        #ibex-multiselect-bar.hidden {
            display: none !important;
        }
        #ibex-multiselect-bar .ibex-mb-count {
            font-weight: 500;
            color: var(--ibex-text-2, #6E6B66);
        }
        #ibex-multiselect-bar #ibex-mb-save {
            background: var(--ibex-accent, #FF6037);
            color: #ffffff;
            border: none;
            border-radius: 4px;
            padding: 6px 14px;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            transition: filter 0.12s;
        }
        #ibex-multiselect-bar #ibex-mb-save:hover { filter: brightness(0.92); }
        #ibex-multiselect-bar #ibex-mb-cancel {
            background: transparent;
            color: var(--ibex-text-3, #A8A6A1);
            border: 1px solid var(--ibex-border, #E3E5E7);
            border-radius: 4px;
            width: 24px;
            height: 24px;
            font-size: 14px;
            line-height: 1;
            cursor: pointer;
            transition: all 0.12s;
        }
        #ibex-multiselect-bar #ibex-mb-cancel:hover {
            color: var(--ibex-text, #0B0B0C);
            border-color: var(--ibex-text-3, #A8A6A1);
        }

        #ibex-preset-modal {
            position: fixed; inset: 0; z-index: 10000;
            display: flex; align-items: center; justify-content: center;
            background: rgba(0,0,0,0.45);
        }
        #ibex-preset-modal.hidden { display: none; }
        .ibex-preset-modal-box {
            background: var(--ibex-surface, #fff);
            border: 1px solid var(--ibex-border-strong, #D2D5D8);
            border-radius: 6px;
            padding: 20px 24px;
            width: 420px;
            max-width: 90vw;
            box-shadow: 0 8px 32px rgba(0,0,0,0.25);
        }
        .ibex-preset-modal-box h2 {
            font-size: 14px;
            font-weight: 500;
            color: var(--ibex-text, #0B0B0C);
            margin: 0 0 16px;
        }
        .ibex-preset-modal-box label {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-bottom: 12px;
            font-size: 11px;
            color: var(--ibex-text-2, #6E6B66);
        }
        .ibex-preset-modal-box input,
        .ibex-preset-modal-box textarea {
            font: inherit;
            font-size: 12px;
            color: var(--ibex-text, #0B0B0C);
            background: var(--ibex-bg, #F4F5F6);
            border: 1px solid var(--ibex-border, #E3E5E7);
            border-radius: 3px;
            padding: 6px 8px;
            outline: none;
            transition: border-color 0.12s;
        }
        .ibex-preset-modal-box input:focus,
        .ibex-preset-modal-box textarea:focus {
            border-color: var(--ibex-accent, #FF6037);
        }
        .ibex-preset-modal-box textarea {
            resize: vertical;
            min-height: 60px;
        }
        .ibex-preset-modal-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 16px;
        }
        .ibex-preset-modal-actions button {
            padding: 6px 16px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.12s;
        }
        #ibex-preset-cancel {
            background: transparent;
            color: var(--ibex-text-2, #6E6B66);
            border: 1px solid var(--ibex-border, #E3E5E7);
        }
        #ibex-preset-cancel:hover {
            color: var(--ibex-text, #0B0B0C);
        }
        #ibex-preset-confirm {
            background: var(--ibex-accent, #FF6037);
            color: #ffffff;
            border: none;
        }
        #ibex-preset-confirm:hover { filter: brightness(0.92); }
        #ibex-preset-confirm:disabled {
            background: var(--ibex-text-3, #A8A6A1);
            cursor: not-allowed;
        }
        .ibex-preset-admin-row {
            margin: 8px 0 4px;
            padding: 10px 12px;
            background: rgba(255,96,55,0.06);
            border: 1px solid rgba(255,96,55,0.25);
            border-radius: 4px;
        }
        .ibex-preset-admin-row.hidden { display: none; }
        .ibex-preset-admin-toggle {
            display: flex !important;
            flex-direction: row !important;
            align-items: center;
            gap: 8px;
            margin-bottom: 0 !important;
            cursor: pointer;
            font-size: 12px !important;
            color: var(--ibex-text, #0B0B0C) !important;
            font-weight: 500;
        }
        .ibex-preset-admin-toggle input[type="checkbox"] {
            margin: 0;
            cursor: pointer;
            accent-color: var(--ibex-accent, #FF6037);
        }
        .ibex-preset-admin-hint {
            margin: 6px 0 0;
            font-size: 10px;
            color: var(--ibex-text-2, #6E6B66);
            line-height: 1.4;
        }

        #ibex-legacy-modal {
            position: fixed;
            inset: 0;
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.55);
            font-family: 'Ubuntu', sans-serif;
        }
        #ibex-legacy-modal.hidden { display: none; }
        #ibex-legacy-modal-box {
            background: var(--ibex-surface);
            color: var(--ibex-text);
            border-radius: 4px;
            padding: 28px 32px;
            max-width: 500px;
            width: calc(100vw - 48px);
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        }
        #ibex-legacy-modal-box h2 {
            font-size: 15px;
            font-weight: 600;
            margin: 0 0 14px 0;
            color: var(--ibex-accent);
            letter-spacing: 0.02em;
        }
        #ibex-legacy-modal-box p {
            font-size: 12px;
            line-height: 1.6;
            margin: 0 0 22px 0;
            color: var(--ibex-text);
        }
        #ibex-legacy-modal-dismiss {
            background: var(--ibex-accent);
            color: #ffffff;
            border: none;
            padding: 8px 20px;
            border-radius: 3px;
            font-family: inherit;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: filter 0.15s;
        }
        #ibex-legacy-modal-dismiss:hover { filter: brightness(0.9); }
    </style>
</head>
<body>
    <div id="loading-overlay">
        <div class="loading-spinner">
            <div></div>
            <div></div>
        </div>
        <p id="loading-msg">Inizializzazione Workspace...</p>
    </div>

    <?php include __DIR__ . '/partials/viewport.blade.php'; ?>
    <?php include __DIR__ . '/partials/header.blade.php'; ?>

    <div id="dag-overlay" class="hidden">
        <div id="dag-backdrop"></div>
        <div id="dag-panel">
            <div id="dag-resize-handle" class="ibex-resize-handle"
                 data-target="dag-h" data-dir="y" data-sign="-1" data-min="160" data-max="75vh"></div>
            <div id="dag-header">
                <span id="dag-title">Pipeline DAG</span>
                <div class="dag-head-tools">
                    <span id="engine-gears" title="Engine">
                        <svg class="gear gear-cw" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>
                    </span>
                    <button id="dag-close-btn" type="button">chiudi &#10005;</button>
                </div>
            </div>
            <div id="dag-body">
                <div id="dag-sidebar">
                    <section id="dag-sidebar-meshes">
                        <?php include __DIR__ . '/partials/outliner.blade.php'; ?>
                    </section>
                    <section id="dag-sidebar-tools">
                        <?php include __DIR__ . '/partials/toolbar.blade.php'; ?>
                    </section>
                    <section id="dag-sidebar-presets">
                        <?php include __DIR__ . '/partials/presets.blade.php'; ?>
                    </section>
                </div>
                <div id="dag-canvas">
                    <?php include __DIR__ . '/partials/stack.blade.php'; ?>
                </div>
            </div>
            <div class="ibex-resize-handle ibex-sidebar-resize"
                 data-target="dag-sidebar-w" data-dir="x" data-sign="1"
                 data-min="160" data-max="420"></div>
        </div>
    </div>

    <!-- #context-inspector RIMOSSO in InspectorPanel_V2.0 (2026-04-27):
         il popup tasto destro è stato sostituito dal panel laterale
         `#ibex-inspector-panel`, creato runtime da InspectorPanel.js e
         appeso a document.body. Il CSS .ctx-* (header/tool/sculpt/selection)
         resta perché usato dai contenuti dipinti dentro il panel. -->

    <!-- Sessione 3: modal migrazione legacy v1.0 → v2.0.
         Mostrato da IbexCore al bootstrap se config.legacyWarning === true.
         Dismiss via button "Ho capito" o Escape. Non persiste stato (se il
         progetto è ancora legacy al prossimo open, il modal riappare). -->
    <div id="ibex-legacy-modal" class="hidden">
        <div id="ibex-legacy-modal-box">
            <h2>Progetto in modalità compatibilità</h2>
            <p>
                Questo progetto è stato creato con una versione precedente di IBEX che
                sovrascriveva i file STL master al salvataggio. I file originali non
                sono più reperibili nel tuo Nextcloud, quindi le mesh correnti sono
                state conservate come nuovi master. La sequenza di strumenti (DAG) è
                stata svuotata — puoi ricomporre la pipeline da zero quando vuoi.
            </p>
            <button id="ibex-legacy-modal-dismiss" type="button">Ho capito</button>
        </div>
    </div>

    <?php /* Preset DAG (2026-05-05) — floating bottom-bar visibile quando
              multiSelectedSet.size > 0. Salva la selezione come preset privato. */ ?>
    <div id="ibex-multiselect-bar" class="hidden">
        <span class="ibex-mb-count">0 nodi selezionati</span>
        <button id="ibex-mb-save" type="button">Salva come preset</button>
        <button id="ibex-mb-cancel" type="button" title="Deseleziona">×</button>
    </div>

    <?php /* Modal salva preset (nome obbligatorio + descrizione opzionale +
              opzionale "Pubblica come admin" — visibile solo a membri del
              gruppo NC "Amministrazione" via flag is_admin esposto da
              listPresets endpoint). */ ?>
    <div id="ibex-preset-modal" class="hidden">
        <div class="ibex-preset-modal-box">
            <h2>Salva come preset</h2>
            <label>
                <span>Nome</span>
                <input id="ibex-preset-name" type="text" maxlength="80" autocomplete="off">
            </label>
            <label>
                <span>Descrizione (opzionale)</span>
                <textarea id="ibex-preset-desc" rows="3" maxlength="500"></textarea>
            </label>
            <div id="ibex-preset-admin-row" class="hidden ibex-preset-admin-row">
                <label class="ibex-preset-admin-toggle">
                    <input id="ibex-preset-public" type="checkbox">
                    <span>Pubblica nel pool condiviso (admin)</span>
                </label>
                <p class="ibex-preset-admin-hint">
                    I preset pubblici sono visibili e utilizzabili da tutti gli utenti.
                    Solo membri del gruppo Amministrazione possono pubblicare/eliminare.
                </p>
            </div>
            <div class="ibex-preset-modal-actions">
                <button id="ibex-preset-cancel" type="button">Annulla</button>
                <button id="ibex-preset-confirm" type="button">Salva</button>
            </div>
        </div>
    </div>

    <?php include __DIR__ . '/partials/toast.blade.php'; ?>
    <?php include __DIR__ . '/partials/scripts.blade.php'; ?>
</body>
</html>
<?php } catch (\Throwable $e) { echo "ERROR"; } ?>
