<script>
    // ═══════════════════════════════════════════════════════════
    // Fetch radar: anima indicatori durante i bake (preview/bake_project).
    // #engine-gears rimosso dalla UI in Fase B3, ma il toggle resta no-op
    // per compat con BakeEngine (che imposta la stessa classe).
    // ═══════════════════════════════════════════════════════════
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = args[0];
        const isBakeTask = typeof url === 'string' && (url.includes('preview_bake') || url.includes('bake_project'));

        if (isBakeTask) {
            document.getElementById('engine-gears')?.classList.add('is-calculating');
            document.body.classList.add('ibex-calculating');
        }

        try {
            const response = await originalFetch.apply(this, args);
            return response;
        } finally {
            if (isBakeTask) {
                document.getElementById('engine-gears')?.classList.remove('is-calculating');
                document.body.classList.remove('ibex-calculating');
            }
        }
    };

    // ═══════════════════════════════════════════════════════════
    // DAG overlay toggle (Fase C2)
    // ═══════════════════════════════════════════════════════════
    window.ibexToggleDag = function(forceOpen) {
        const ov  = document.getElementById('dag-overlay');
        const btn = document.getElementById('dag-toggle-btn');
        if (!ov) return;

        const isHidden = ov.classList.contains('hidden');
        const willOpen = (forceOpen === undefined) ? isHidden : !!forceOpen;

        if (willOpen) {
            ov.classList.remove('hidden');
            document.body.classList.add('dag-open');
            if (btn) btn.classList.add('active');

            // Forza a Drawflow di ridisegnare le connessioni dopo che il
            // pannello è nuovamente visibile (il translateY era 100%).
            // Bug #8 (Inv. 61): mentre l'overlay era .hidden il precanvas
            // poteva avere clientWidth/Height aggiornati (es. resize finestra)
            // ma gli svg.connection mantengono i pixel-size cotti dalla
            // chiamata precedente → linee disallineate al primo open.
            // Riallinea con _fixAllConnSvgSizes — stesso pattern del
            // mouseup del resize handle DAG.
            requestAnimationFrame(() => {
                try {
                    const editor = window.ibex?.stackMgr?.editor;
                    if (editor) {
                        const data = editor.export().drawflow.Home.data;
                        Object.keys(data).forEach(id => editor.updateConnectionNodes('node-' + id));
                    }
                    window.ibex?.stackMgr?._fixAllConnSvgSizes?.();
                } catch (e) { /* non critico */ }
            });
        } else {
            ov.classList.add('hidden');
            document.body.classList.remove('dag-open');
            if (btn) btn.classList.remove('active');
        }
    };

    // ═══════════════════════════════════════════════════════════
    // Resize handles — pannelli laterali + DAG overlay.
    // Ogni handle ha data-target="panel-left-w|panel-right-w|dag-h",
    // data-dir="x|y", data-sign="±1", data-min / data-max (px o "Nvh").
    // Aggiorna la CSS variable --{target} sul documentElement; Three.js
    // viene notificato via sceneMgr.onResize() durante il drag.
    // ═══════════════════════════════════════════════════════════
    function ibexInitResize() {
        const parsePx = (val, relSize) => {
            if (!val) return 0;
            const s = String(val).trim();
            if (s.endsWith('vh')) return window.innerHeight * parseFloat(s) / 100;
            if (s.endsWith('vw')) return window.innerWidth  * parseFloat(s) / 100;
            if (s.endsWith('px')) return parseFloat(s);
            return parseFloat(s);
        };
        const readVar = (name) => {
            const v = getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
            return parseFloat(v) || 0;
        };

        document.querySelectorAll('.ibex-resize-handle').forEach(handle => {
            const target = handle.dataset.target;
            const dir    = handle.dataset.dir;           // "x" | "y"
            const sign   = parseFloat(handle.dataset.sign) || 1;
            const rawMin = handle.dataset.min;
            const rawMax = handle.dataset.max;

            let dragging = false, startPos = 0, startVal = 0, panelEl = null;

            const onDown = (e) => {
                // Ignora se tasto non sinistro
                if (e.button !== undefined && e.button !== 0) return;
                e.preventDefault();
                dragging = true;
                startPos = (dir === 'x') ? e.clientX : e.clientY;
                startVal = readVar(target);
                handle.classList.add('active');

                // Flag "resizing" per disattivare transition durante drag.
                // Unica dimensione dinamica dopo il layout a schermo intero: --dag-h.
                if (target === 'dag-h') panelEl = document.getElementById('dag-overlay');
                if (panelEl) panelEl.classList.add('resizing');

                document.body.style.cursor    = (dir === 'x') ? 'ew-resize' : 'ns-resize';
                document.body.style.userSelect = 'none';

                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            };

            const onMove = (e) => {
                if (!dragging) return;
                const pos = (dir === 'x') ? e.clientX : e.clientY;
                const delta = pos - startPos;

                let newVal = startVal + delta * sign;
                const minPx = parsePx(rawMin);
                const maxPx = parsePx(rawMax);
                newVal = Math.max(minPx, Math.min(maxPx, newVal));

                document.documentElement.style.setProperty('--' + target, newVal + 'px');

                // Ricalcola canvas Three.js
                if (window.ibex?.sceneMgr?.onResize) {
                    window.ibex.sceneMgr.onResize();
                }
            };

            const onUp = () => {
                if (!dragging) return;
                dragging = false;
                handle.classList.remove('active');
                if (panelEl) { panelEl.classList.remove('resizing'); panelEl = null; }
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);

                // Aggiorna anche Drawflow dopo resize DAG (le connessioni seguono il canvas)
                if (target === 'dag-h') {
                    requestAnimationFrame(() => {
                        try {
                            const editor = window.ibex?.stackMgr?.editor;
                            if (editor) {
                                const data = editor.export().drawflow.Home.data;
                                Object.keys(data).forEach(id => editor.updateConnectionNodes('node-' + id));
                            }
                            // Bug #8 fix: il precanvas ha un nuovo clientHeight dopo resize,
                            // riallinea le dimensioni in pixel di tutti gli svg.connection.
                            window.ibex?.stackMgr?._fixAllConnSvgSizes?.();
                        } catch (e) { /* non critico */ }
                    });
                }
            };

            handle.addEventListener('mousedown', onDown);
        });
    }

    document.addEventListener('DOMContentLoaded', ibexInitResize);

    // ═══════════════════════════════════════════════════════════
    // Drag & drop sidebar DAG → canvas Drawflow
    //
    // Rende ogni .tool-card della libreria strumenti trascinabile.
    // Il drop sul canvas è gestito da window.dropMeshToCanvas in IbexCore,
    // che è stato esteso per riconoscere sia mesh (text/plain dall'outliner)
    // sia tool (ibex-type="tool" + ibex-tool-json).
    // ═══════════════════════════════════════════════════════════
    function ibexInitToolDrag() {
        const list = document.getElementById('tools-list');
        if (!list) return;
        list.querySelectorAll('.tool-card').forEach(card => {
            if (card.__ibexDragBound) return;
            card.__ibexDragBound = true;
            card.setAttribute('draggable', 'true');
            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('ibex-type', 'tool');
                e.dataTransfer.setData('ibex-tool-json', card.dataset.toolJson || '');
            });
        });
    }
    document.addEventListener('DOMContentLoaded', ibexInitToolDrag);

    // Click sul backdrop chiude il DAG
    document.addEventListener('click', (e) => {
        const bd = document.getElementById('dag-backdrop');
        if (bd && e.target === bd) window.ibexToggleDag(false);
    });

    // Pulsante chiudi nel header dell'overlay
    document.addEventListener('DOMContentLoaded', () => {
        const closeBtn = document.getElementById('dag-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', () => window.ibexToggleDag(false));
    });

    // Toggle collassabile sezioni sidebar DAG (Outliner / Toolbar)
    window.ibexToggleSidebarSection = function(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('collapsed');
        // Riposiziona connessioni Drawflow se la dimensione cambia
        const editor = window.ibex?.stackMgr?.editor;
        if (editor && editor.drawflow) {
            requestAnimationFrame(() => {
                Object.keys(editor.drawflow.drawflow.Home.data).forEach(id => {
                    editor.updateConnectionNodes('node-' + id);
                });
                window.ibex?.stackMgr?._fixAllConnSvgSizes?.();
            });
        }
    };

    // Esc globale: chiude DAG overlay oppure inspector panel
    // (InspectorPanel_V2.0 — il vecchio #context-inspector popup non esiste più).
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const dag = document.getElementById('dag-overlay');
        if (dag && !dag.classList.contains('hidden')) {
            window.ibexToggleDag(false);
            return;
        }
        if (window.ibex?.inspectorPanel?.isOpen) {
            window.ibex.inspectorPanel.close();
        }
    });

    // ─── Header redesign (2026-05-04) ────────────────────────────
    // Project name editabile inline. Salva al blur o Enter; Escape ripristina.
    function ibexInitProjectRename() {
        const inp = document.getElementById('ibex-project-name-input');
        if (!inp) return;
        const projectId = inp.dataset.projectId;
        if (!projectId) return;
        let lastSaved = inp.value;

        const commit = async () => {
            const newName = (inp.value || '').trim();
            if (newName === lastSaved) return;
            if (!newName) { inp.value = lastSaved; return; }
            // Pre-validazione client RENAME_RX — byte-allineata al server (EditorController::renameProject)
            const RENAME_RX = /^[A-Za-z0-9 _.\-()\u00C0-\u00FF]{1,80}$/;
            if (!RENAME_RX.test(newName)) {
                inp.classList.add('error'); inp.value = lastSaved;
                if (window.ibex?.uiMgr?.notify) window.ibex.uiMgr.notify('Nome non valido (1-80: lettere, numeri, spazio, _ . - ( ) accentate)', 'error');
                setTimeout(() => inp.classList.remove('error'), 2000);
                return;
            }
            inp.classList.remove('error');
            inp.classList.add('saving');
            try {
                const fd = new FormData();
                fd.append('id', projectId);
                fd.append('project_name', newName);
                const resp = await fetch('/?action=rename_project', { method: 'POST', body: fd });
                const data = await resp.json();
                inp.classList.remove('saving');
                if (data.success) {
                    lastSaved = data.project_name;
                    inp.value = lastSaved;
                    if (window.ibex?.uiMgr?.notify) {
                        window.ibex.uiMgr.notify(`Progetto rinominato in "${lastSaved}"`, 'success');
                    }
                } else {
                    inp.classList.add('error');
                    inp.value = lastSaved;
                    if (window.ibex?.uiMgr?.notify) {
                        window.ibex.uiMgr.notify(`Rinomina fallita: ${data.error || 'errore'}`, 'error');
                    }
                    setTimeout(() => inp.classList.remove('error'), 2000);
                }
            } catch (e) {
                inp.classList.remove('saving');
                inp.classList.add('error');
                inp.value = lastSaved;
                if (window.ibex?.uiMgr?.notify) {
                    window.ibex.uiMgr.notify(`Errore di rete: ${e.message || e}`, 'error');
                }
                setTimeout(() => inp.classList.remove('error'), 2000);
            }
        };

        inp.addEventListener('focus', () => { inp.select(); });
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
            else if (e.key === 'Escape') { inp.value = lastSaved; inp.blur(); }
        });
        inp.addEventListener('blur', commit);
    }
    document.addEventListener('DOMContentLoaded', ibexInitProjectRename);

    // Preset DAG (2026-05-05) — handler floating bar + modal salva preset.
    // Non dipende da window.ibex (state vive in stackMgr) ma usa la sua API.
    function ibexInitPresetSave() {
        const bar      = document.getElementById('ibex-multiselect-bar');
        const btnSave  = document.getElementById('ibex-mb-save');
        const btnCancl = document.getElementById('ibex-mb-cancel');
        const modal    = document.getElementById('ibex-preset-modal');
        const inpName  = document.getElementById('ibex-preset-name');
        const inpDesc  = document.getElementById('ibex-preset-desc');
        const btnConf  = document.getElementById('ibex-preset-confirm');
        const btnCanc2 = document.getElementById('ibex-preset-cancel');
        if (!bar || !btnSave || !modal || !inpName || !btnConf) return;

        const inpPublic = document.getElementById('ibex-preset-public');
        const closeModal = () => {
            modal.classList.add('hidden');
            inpName.value = '';
            inpDesc.value = '';
            if (inpPublic) inpPublic.checked = false;
            btnConf.disabled = false;
        };

        btnCancl?.addEventListener('click', () => {
            window.ibex?.stackMgr?.clearMultiSelection?.();
        });

        btnSave.addEventListener('click', () => {
            modal.classList.remove('hidden');
            // Mostra/nascondi la sezione admin in base al flag esposto da
            // PresetSidebar.refresh (caricato all'init di IbexCore).
            const adminRow = document.getElementById('ibex-preset-admin-row');
            const isAdmin = !!window.ibex?.presetSidebar?.isAdmin;
            if (adminRow) adminRow.classList.toggle('hidden', !isAdmin);
            setTimeout(() => inpName.focus(), 30);
        });

        btnCanc2?.addEventListener('click', closeModal);
        // Esc chiude (il listener DOMContentLoaded sotto gestisce Esc globale,
        // ma qui aggiungiamo specifico per la modale aperta).
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal(); // click sul backdrop
        });

        btnConf.addEventListener('click', async () => {
            const name = (inpName.value || '').trim();
            if (!name) {
                inpName.focus();
                inpName.style.borderColor = 'var(--ibex-error, #C4302B)';
                setTimeout(() => { inpName.style.borderColor = ''; }, 1200);
                return;
            }
            const desc = (inpDesc.value || '').trim();
            const stackMgr = window.ibex?.stackMgr;
            if (!stackMgr || typeof stackMgr.extractPresetPayload !== 'function') {
                window.ibex?.uiMgr?.notify?.('Sistema non pronto', 'error');
                return;
            }
            const payload = stackMgr.extractPresetPayload();
            if (!payload || !payload.nodes || payload.nodes.length === 0) {
                window.ibex?.uiMgr?.notify?.('Nessun nodo valido nella selezione', 'warning');
                return;
            }

            // Decidi namespace: privato di default, pubblico solo se admin
            // E checkbox spuntata. Backend ricontrolla comunque _isAdmin.
            const wantsPublic = !!(inpPublic && inpPublic.checked);
            const isAdmin = !!window.ibex?.presetSidebar?.isAdmin;
            const namespace = (wantsPublic && isAdmin) ? 'public' : 'private';

            btnConf.disabled = true;
            try {
                const fd = new URLSearchParams();
                fd.set('name', name);
                fd.set('description', desc);
                fd.set('payload_json', JSON.stringify(payload));
                fd.set('namespace', namespace);
                const r = await fetch('/?action=save_preset', {
                    method: 'POST',
                    body: fd,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                });
                const data = await r.json();
                if (!data || data.success !== true) {
                    throw new Error(data?.error || 'salvataggio fallito');
                }
                const where = namespace === 'public' ? 'pool pubblico' : 'preset privati';
                window.ibex?.uiMgr?.notify?.(`Preset "${name}" salvato (${where})`, 'success');
                closeModal();
                stackMgr.clearMultiSelection?.();
                // Refresh sidebar Preset (Fase 4)
                window.ibex?.presetSidebar?.refresh?.();
            } catch (err) {
                window.ibex?.uiMgr?.notify?.('Errore: ' + (err.message || err), 'error');
                btnConf.disabled = false;
            }
        });

        // Esc chiude la modal preset (in aggiunta al global Esc handler)
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
                closeModal();
            }
        });
    }
    document.addEventListener('DOMContentLoaded', ibexInitPresetSave);
</script>

<script type="module">
    import { IbexCore } from '/js/ibex/modules/IbexCore.js?v=<?= time() ?>';

    const config = {
        projectId: <?= json_encode($id ?? null) ?>,
        fileToken: <?= json_encode($fileToken ?? '') ?>,
        inputFiles: <?= json_encode($inputFiles ?? []) ?>,
        sessionSettings: <?= json_encode($sessionSettings ?? null, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?>,
        // Sessione 3 pipeline procedurale: migrazione legacy v1.0 → v2.0.
        // Se il worker LOAD_PROJECT ha rilevato un bake distruttivo + originali
        // mancanti → trattato master WS come nuovi master + svuotato DAG.
        // Il frontend mostra modal informativo al bootstrap.
        legacyWarning:       <?= json_encode((bool)($legacyWarning ?? false)) ?>,
        legacyWarningReason: <?= json_encode((string)($legacyWarningReason ?? '')) ?>
    };

    /* S2 «IBEX semplice» (2026-07-10): inputFiles=[] è configurazione VALIDA (progetto vuoto). */
    if (!config.projectId || !config.fileToken || !config.inputFiles) {
        console.error("IBEX FATAL: Config incompleta.");
        const msg = document.getElementById('loading-msg');
        if (msg) { msg.innerText = "ERRORE CONFIG: Dati progetto mancanti."; msg.style.color = "var(--ibex-error)"; }
    } else {
        window.ibex = new IbexCore(config);
        window.filterTools = (val) => window.ibex.uiMgr.filterTools(val);
        window.addToolToStack = (tool) => window.ibex.stackMgr.addTool(tool);
        window.saveAndExit  = () => window.ibex.saveAndExit();
        window.ibexSaveSession = () => window.ibex.saveSession(); // UX-A: salva senza uscire
        // Menu (23/7): RINOMINA = SALVA CON NOME, stesso pid. Il fork Save-As e' stato RIMOSSO.
        window.ibexFocusRename = async function(){
            var I = window.ibex; if(!I || !I.config){ return; }
            var _in = document.getElementById('ibex-project-name-input');
            var cur = (_in && _in.value) || '';
            var name = window.prompt('Rinomina progetto — nuovo nome:', cur);
            if(name === null){ return; }
            name = (name||'').trim();
            var RX = /^[A-Za-z0-9 _.\-()\u00C0-\u00FF]{1,80}$/;
            if(!RX.test(name)){ if(I.uiMgr) I.uiMgr.notify('Nome non valido (1-80: lettere, numeri, spazio, _ . - ( ) accentate)','error'); return; }
            if(name === cur){ return; }
            try{
                // (1) flush: la rinomina E' un salvataggio -> active/ deve avere l'ultimo lavoro
                if(window.ibexSaveSession){ await window.ibexSaveSession(); }
                var fd = new URLSearchParams({ id: String(I.config.projectId), project_name: name });
                var r = await fetch('/index.php?action=rename_project',{ method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: fd });
                var d = await r.json();
                if(d && d.success){
                    if(_in) _in.value = d.project_name;
                    if(I.config) I.config.projectName = d.project_name;
                    try { var _u = new URL(window.location.href); _u.searchParams.set('open_name', d.project_name); history.replaceState(null,'',_u.toString()); } catch(_e){}
                    if(document.documentElement.getAttribute('data-embed')==='1' && window.parent && (window.IBEX_CONFIG||{}).nextcloudOrigin){ try{ window.parent.postMessage({type:'ibex-renamed', name:d.project_name}, window.IBEX_CONFIG.nextcloudOrigin); }catch(_e){} }
                    if(I.uiMgr) I.uiMgr.notify('Rinominato in «'+d.project_name+'»','success');
                }
                else { if(I.uiMgr) I.uiMgr.notify('Rinomina: '+((d&&d.error)||'errore'),'error'); }
            }catch(e){ if(I.uiMgr) I.uiMgr.notify('Errore di rete: '+(e.message||e),'error'); }
        };
        window.bakeAndExit  = () => window.ibex.bakeAndExit(); // riservato al futuro export
    }
</script>

<!-- ── Menu-bar (Pezzo 2 menubar) — glue: open/close dropdown + dispatch data-cmd → funzioni ESISTENTI + tick-sync ── -->
<script>
(function(){
  function mbRun(cmd,arg){
    var I=window.ibex;
    switch(cmd){
      case 'save':      if(window.ibexSaveSession) window.ibexSaveSession(); break;
      case 'rename':    if(window.ibexFocusRename) window.ibexFocusRename(); break;
      case 'saveExit':  if(window.saveAndExit) window.saveAndExit(); break;
      case 'bake':      try{ I.stackMgr.bakeEngine.requestBake({force:true}); }catch(e){} break;
      /* L4 (2026-07-23) — «Chiudi finestra» della shell = esci SENZA salvare: scarta
         il lavoro non salvato di QUESTO progetto (purga active/{uid}/{pid} via
         exit_project, uid-scoped; il .ibex NON viene toccato) e conferma alla shell.
         Autosave e heartbeat vanno fermati PRIMA della purga: un tick successivo
         ricreerebbe la sessione appena scartata. _navigatingAway spegne il guard
         beforeunload (l'uscita e' voluta, niente dialog nativo del browser). */
      case 'discard': {
        try{ I._navigatingAway = true; }catch(e){}
        try{ if(I._autosaveTimer){ clearInterval(I._autosaveTimer); I._autosaveTimer = null; } }catch(e){}
        try{ if(I._heartbeatTimer){ clearInterval(I._heartbeatTimer); I._heartbeatTimer = null; } }catch(e){}
        var _l4ack = function(ok){
          var _nco=(window.IBEX_CONFIG||{}).nextcloudOrigin; if(!_nco) return;
          try{ window.parent.postMessage({type:'ibex-discarded', ok: !!ok}, _nco); }catch(e){}
        };
        try{
          fetch('/?action=exit_project&id=' + encodeURIComponent(I.config.projectId),
                { credentials:'include', redirect:'manual', keepalive:true })
            .then(function(){ _l4ack(true); })
            .catch(function(){ _l4ack(false); });
        }catch(e){ _l4ack(false); }
        break;
      }
      case 'import':    try{ I.importPicker.open(); }catch(e){} break;
      case 'undo':      try{ I.stackMgr.undo(); }catch(e){} break;
      case 'redo':      try{ I.stackMgr.redo(); }catch(e){} break;
      case 'dag':       if(window.ibexToggleDag) window.ibexToggleDag(); break;
      case 'inspector': try{ I.inspectorPanel.toggle(); }catch(e){} break;
      case 'fit':       try{ I.viewGizmo.fitAll(); }catch(e){} break;
      case 'section':   try{ I.viewGizmo.toggleClipBox(); if(window.notify) window.notify(I.viewGizmo._clipActive?'Sezione attiva':'Sezione disattivata'); }catch(e){} break;
      case 'view':      { var m={"dall'alto":0,"frontale":2,"laterale":4,"3/4":6}; try{ I.viewGizmo.applyPreset(m[arg]!=null?m[arg]:0); }catch(e){} break; }
      case 'outliner':  if(window.ibexToggleSidebarSection) window.ibexToggleSidebarSection('dag-sidebar-meshes'); break;
      case 'grid':      try{ var g=I.sceneMgr.gridHelper; g.visible=!g.visible; I.sceneMgr.render(); if(window.notify) window.notify(g.visible?'Griglia visibile':'Griglia nascosta'); }catch(e){} break;
      case 'axes':      { var gz=document.getElementById('ibex-view-gizmo-ui'); if(gz){ gz.style.display=(gz.style.display==='none'?'':'none'); if(window.notify) window.notify(gz.style.display==='none'?'Gizmo assi nascosto':'Gizmo assi visibile'); } break; }
      /* L6 (2026-07-23) — il tema vive nel menu «Preferenze» come due voci esplicite
         (Chiaro/Scuro). `theme` resta come toggle: nessuna voce di menu lo usa più,
         ma è l'API che una superficie esterna potrebbe ancora mandare via ibex-cmd. */
      case 'theme':     { var _d=document.documentElement.getAttribute('data-theme')==='dark'; if(window.ibexApplyTheme) window.ibexApplyTheme(_d?'light':'dark', true); break; }
      case 'theme-set': if(window.ibexApplyTheme) window.ibexApplyTheme(arg==='dark'?'dark':'light', true); break;
      /* ColorReady L11.2 (2026-07-24) — toggle globale colore scansione. Legge lo stato
         corrente da localStorage (source of truth per il tick) e lo inverte. */
      case 'color':     { var _c=false; try{ _c=localStorage.getItem('ibex_ws:color')==='1'; }catch(e){} if(window.ibexApplyColor) window.ibexApplyColor(!_c, true); break; }
      /* S6 (Q4): standalone → lobby NC; in embed 'open'/'new' sono intercettati
         a monte dalla shell (shellRun) e non arrivano mai qui. */
      case 'open':      { var _lb=(window.IBEX_CONFIG||{}).lobbyUrl; if(_lb) location.href=_lb; break; }
      case 'new':       { var _lb=(window.IBEX_CONFIG||{}).lobbyUrl; if(_lb) location.href=_lb; break; }
      case 'exit':      { var ex=document.getElementById('ibex-header-exit'); if(ex) ex.click(); break; }
      /* sel, sculpt, docs, shortcuts, about → aria-disabled nel markup (non arrivano qui) */
    }
    if(window.mbSyncTicks) window.mbSyncTicks();
    if(window.ibexSendState) window.ibexSendState();   /* shell-embed: stato → chrome finestra */
  }
  window.mbRun = mbRun;

  function init(){
    var bar=document.querySelector('.menubar'); if(!bar) return;
    var menus=[].slice.call(bar.querySelectorAll('.mb'));
    var scrim=document.getElementById('mbScrim');
    function closeAll(){menus.forEach(function(m){m.classList.remove('is-open');});bar.querySelectorAll('.mb__sub.is-open').forEach(function(s){s.classList.remove('is-open');});if(scrim)scrim.classList.remove('is-on');}
    function openMenu(m){closeAll();m.classList.add('is-open');if(scrim)scrim.classList.add('is-on');window.mbSyncTicks();}
    menus.forEach(function(m){
      var b=m.querySelector('.mb__btn'); if(!b)return;
      b.addEventListener('click',function(e){e.stopPropagation();m.classList.contains('is-open')?closeAll():openMenu(m);});
      b.addEventListener('pointerenter',function(){if(menus.some(function(x){return x.classList.contains('is-open');})&&!m.classList.contains('is-open'))openMenu(m);});
    });
    if(scrim)scrim.addEventListener('click',closeAll);
    bar.querySelectorAll('.mb__sub>.mb__item').forEach(function(t){t.addEventListener('click',function(e){e.stopPropagation();var s=t.closest('.mb__sub');var w=s.classList.contains('is-open');s.parentNode.querySelectorAll('.mb__sub.is-open').forEach(function(x){if(x!==s)x.classList.remove('is-open');});s.classList.toggle('is-open',!w);});});
    bar.querySelectorAll('.mb__item[data-cmd]').forEach(function(it){it.addEventListener('click',function(e){if(it.getAttribute('aria-disabled')==='true'){e.stopPropagation();return;}e.stopPropagation();mbRun(it.getAttribute('data-cmd'),it.getAttribute('data-arg'));closeAll();bar.classList.remove('is-mobile-open');});});
    document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeAll();bar.classList.remove('is-mobile-open');}});

    window.mbSyncTicks=function(){
      var I=window.ibex||{};
      function chk(cmd,on){bar.querySelectorAll('.mb__item[data-cmd="'+cmd+'"]').forEach(function(it){it.classList.toggle('is-checked',!!on);});}
      var dag=document.getElementById('dag-overlay');            chk('dag', !!(dag && !dag.classList.contains('hidden')));
      var insp=document.getElementById('ibex-inspector-panel');  chk('inspector', !!(insp && insp.classList.contains('ibex-inspector-open')));
      var ol=document.getElementById('dag-sidebar-meshes');      chk('outliner', !!(ol && !ol.classList.contains('collapsed')));
      chk('grid', !!(I.sceneMgr && I.sceneMgr.gridHelper && I.sceneMgr.gridHelper.visible));
      var gz=document.getElementById('ibex-view-gizmo-ui');      chk('axes', !!(gz && gz.style.display!=='none'));
      chk('section', !!(I.viewGizmo && I.viewGizmo._clipActive));
      /* L6: spunta sulla voce Preferenze corrispondente al tema attivo (non più un
         toggle unico → `chk` non basta, serve il confronto sul data-arg). */
      var _dk = document.documentElement.getAttribute('data-theme')==='dark';
      bar.querySelectorAll('.mb__item[data-cmd="theme-set"]').forEach(function(it){
        it.classList.toggle('is-checked', it.getAttribute('data-arg')===(_dk?'dark':'light'));
      });
      /* ColorReady L11.2: spunta sulla voce «Colore scansione» quando il toggle è ON.
         Fonte = localStorage (stessa del case 'color'), coerente anche prima che
         outlinerMgr sia istanziato. */
      var _colorOn=false; try{ _colorOn=localStorage.getItem('ibex_ws:color')==='1'; }catch(e){}
      bar.querySelectorAll('.mb__item[data-cmd="color"]').forEach(function(it){
        it.classList.toggle('is-checked', _colorOn);
      });
    };
    window.mbSyncTicks();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
</script>

<!-- ── Shell-embed bridge (IBEX.zip v2): editor ⇄ finestra-shell via postMessage. Inerte senza ?embed=1. ── -->
<script>
(function(){
  var EMB = document.documentElement.getAttribute('data-embed')==='1';
  var NCO = (window.IBEX_CONFIG||{}).nextcloudOrigin || '';  /* origine shell NC; '' = bridge muto */
  window.ibexSendState = function(){
    if(!EMB || !NCO || !window.parent || window.parent===window) return;
    try{
      var I=window.ibex||{};
      var dag=document.getElementById('dag-overlay');
      var insp=document.getElementById('ibex-inspector-panel');
      var ol=document.getElementById('dag-sidebar-meshes');
      var gz=document.getElementById('ibex-view-gizmo-ui');
      var w=document.getElementById('ibex-worker-status');
      var dot=document.getElementById('ibex-project-status-dot');
      window.parent.postMessage({type:'ibex-state', state:{
        dag:       !!(dag && !dag.classList.contains('hidden')),
        inspector: !!(insp && insp.classList.contains('ibex-inspector-open')),
        outliner:  !!(ol && !ol.classList.contains('collapsed')),
        grid:      !!(I.sceneMgr && I.sceneMgr.gridHelper && I.sceneMgr.gridHelper.visible),
        axes:      !!(gz && gz.style.display!=='none'),
        section:   !!(I.viewGizmo && I.viewGizmo._clipActive),
        worker:    !!(w && w.style.display && w.style.display!=='none'),
        dirty:     !!(dot && dot.classList.contains('dirty'))
      }}, NCO);
    }catch(e){}
  };
  window.addEventListener('message', function(e){
    /* S6 (Q4, 2026-07-10): origin-check — solo la shell NC può comandare
       l'editor via postMessage. Senza, qualunque pagina che embedda l'iframe
       potrebbe inviare ibex-cmd (saveExit/bake inclusi). */
    if(!NCO || e.origin!==NCO) return;
    var d=e.data; if(!d) return;
    if(d.type==='ibex-cmd' && window.mbRun){ window.mbRun(d.cmd, d.arg||null); }
    else if(d.type==='ibex-state-req'){ window.ibexSendState(); }
    else if(d.type==='ibex-theme' && window.ibexApplyTheme){ window.ibexApplyTheme(d.theme==='dark'?'dark':'light', false); }
  });
  window.addEventListener('load', function(){ window.ibexSendState(); });
})();
</script>

<!-- ── Tema scuro (IBEX.zip): applier — token CSS + sync scena Three (bg/grid) + tick menu + shell ── -->
<script>
(function(){
  var KEY='ibex_ws:theme';
  function syncScene(dark){
    try{
      var I=window.ibex; if(!I||!I.sceneMgr) return;
      if(I.sceneMgr.scene && I.sceneMgr.scene.background && I.sceneMgr.scene.background.set)
        I.sceneMgr.scene.background.set(dark?'#121315':'#F4F5F6');
      var g=I.sceneMgr.gridHelper;
      if(g && g.material){ g.material.transparent=true; g.material.opacity=dark?0.22:1; g.material.needsUpdate=true; }
      if(I.sceneMgr.render) I.sceneMgr.render();
    }catch(e){}
  }
  window.ibexApplyTheme=function(t,persist){
    var dark=(t==='dark');
    if(dark) document.documentElement.setAttribute('data-theme','dark');
    else document.documentElement.removeAttribute('data-theme');
    if(persist){ try{ localStorage.setItem(KEY,t); }catch(e){} }
    syncScene(dark);
    if(window.mbSyncTicks) window.mbSyncTicks();
    if(window.ibexSendState) window.ibexSendState();
  };
  window.addEventListener('storage',function(e){ if(e.key===KEY && window.ibexApplyTheme) window.ibexApplyTheme(e.newValue==='dark'?'dark':'light',false); });
  /* al bootstrap: se il boot-reader ha gia' settato dark, sincronizza la scena appena pronta */
  window.addEventListener('load',function(){ if(document.documentElement.getAttribute('data-theme')==='dark') syncScene(true); });
})();
</script>

<!-- ── ColorReady L11.2 (2026-07-24): toggle globale colore scansione (MatCap ↔ colore).
     Gemello dell'applier tema: setta OutlinerManager.colorMode + update() + persist
     localStorage['ibex_ws:color']. DISPLAY only, editor-side, zero shell/worker/bake.
     Default OFF: se la chiave manca, non fa nulla. Cross-tab via evento 'storage'. ── -->
<script>
(function(){
  var CKEY='ibex_ws:color';
  /* Applica il toggle: colorMode sull'outliner + update() (che riconcilia il flag
     vertexColors su ogni matcap secondo colorMode && attributo reale). `persist`=true
     scrive localStorage. Se l'outliner non è ancora pronto, lo stato resta in localStorage
     e il boot-reader qui sotto lo applica appena disponibile. */
  window.ibexApplyColor=function(on, persist){
    on=!!on;
    if(persist){ try{ localStorage.setItem(CKEY, on?'1':'0'); }catch(e){} }
    try{
      var I=window.ibex;
      if(I && I.outlinerMgr){ I.outlinerMgr.colorMode=on; if(typeof I.outlinerMgr.update==='function') I.outlinerMgr.update(); }
      /* ColorReady L11.3 (fix L3): update() riconcilia i flag ma NON ridisegna. L'applier
         tema fa syncScene→render(); qui forziamo il redraw così il cambio colore compare
         subito, senza attendere il prossimo frame rAF. */
      if(I && I.sceneMgr && typeof I.sceneMgr.render==='function') I.sceneMgr.render();
    }catch(e){}
    if(window.mbSyncTicks) window.mbSyncTicks();
  };
  /* cross-tab: un altro tab ha cambiato la preferenza → riflettila senza ri-persistere */
  window.addEventListener('storage',function(e){ if(e.key===CKEY && window.ibexApplyColor) window.ibexApplyColor(e.newValue==='1', false); });
  /* boot: leggi la preferenza e applicala appena outlinerMgr esiste. Default OFF → se
     '0'/assente non c'è nulla da fare (le mesh nascono già colorless/no-op). Retry breve
     perché window.ibex viene istanziato dopo il 'load' iniziale. */
  window.addEventListener('load',function(){
    var on=false; try{ on=localStorage.getItem(CKEY)==='1'; }catch(e){}
    if(window.mbSyncTicks) window.mbSyncTicks();   /* spunta corretta anche a OFF */
    if(!on) return;
    var tries=0;
    (function apply(){
      if(window.ibex && window.ibex.outlinerMgr){ window.ibexApplyColor(true, false); return; }
      if(tries++ < 60) setTimeout(apply, 150);
    })();
  });
})();
</script>
