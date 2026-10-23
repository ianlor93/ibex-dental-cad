<header id="ibex-header">
    <div class="ibex-header-left">
        <a href="/?action=exit_project&id=<?= htmlspecialchars($id ?? '') ?>"
           onclick="return confirm('Uscire senza salvare? Le modifiche non salvate andranno perse.')"
           id="ibex-header-exit" title="Esci senza salvare" aria-label="Esci">
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10 19l-7-7 7-7"></path></svg>
        </a>

        <div class="ibex-project-identity">
            <div class="ibex-project-name-row">
                <input type="text" id="ibex-project-name-input"
                       data-project-id="<?= htmlspecialchars($id ?? '') ?>"
                       value="<?= htmlspecialchars($project->project_name ?? 'Senza Nome') ?>"
                       spellcheck="false" autocomplete="off" maxlength="80"
                       title="Click per rinominare il progetto">
                <span class="ibex-project-status-dot" id="ibex-project-status-dot" title="Stato progetto"></span>
            </div>
            <span class="ibex-project-brand">ibex · dental cad engine</span>
        </div>

        <span class="ibex-header-divider" style="margin:0 4px;"></span>

        <!-- Hamburger (solo <=1000px, toggle la .menubar) -->
        <button type="button" class="mb-burger" id="mb-burger" aria-label="Menu" title="Menu"
                onclick="document.querySelector('.menubar')?.classList.toggle('is-mobile-open')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
        </button>

        <!-- MENU BAR (target) — azioni cablate via data-cmd → mbRun (scripts.blade.php) -->
        <nav class="menubar" aria-label="Barra dei menu">
            <!-- File -->
            <div class="mb">
                <button class="mb__btn">File</button>
                <div class="mb__pop">
                    <button class="mb__item" data-cmd="new"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span><span class="lb">Nuovo progetto</span><span class="sc">⌘N</span></button>
                    <button class="mb__item" data-cmd="open"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8L9 6H4a1 1 0 0 0-1 1z"/></svg></span><span class="lb">Apri progetto</span></button>
                    <div class="mb__sep"></div>
                    <button class="mb__item" data-cmd="save"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 4h11l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 4v5h7M8 21v-7h8v7"/></svg></span><span class="lb">Salva</span><span class="sc">⌘S</span></button>
                    <button class="mb__item" data-cmd="rename"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></span><span class="lb">Rinomina…</span></button>
                    <div class="mb__sep"></div>
                    <button class="mb__item" data-cmd="import"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 9l5-5 5 5M12 4v12"/></svg></span><span class="lb">Importa mesh</span></button>
                    <div class="mb__sep"></div>
                    <button class="mb__item" data-cmd="exit"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7 7-7M3 12h13"/></svg></span><span class="lb">Torna al cloud</span></button>
                </div>
            </div>
            <!-- Modifica -->
            <div class="mb">
                <button class="mb__btn">Modifica</button>
                <div class="mb__pop">
                    <button class="mb__item" data-cmd="undo"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5 5 5 0 0 1-5 5H9"/></svg></span><span class="lb">Annulla</span><span class="sc">⌘Z</span></button>
                    <button class="mb__item" data-cmd="redo"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0-5 5 5 5 0 0 0 5 5h6"/></svg></span><span class="lb">Ripeti</span><span class="sc">⇧⌘Z</span></button>
                    <button class="mb__item" data-cmd="bake"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg></span><span class="lb">Forza bake</span><span class="sc">⌘B</span></button>
                </div>
            </div>
            <!-- Visualizza -->
            <div class="mb">
                <button class="mb__btn">Visualizza</button>
                <div class="mb__pop">
                    <button class="mb__item" data-cmd="dag"><span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span class="lb">Pipeline DAG</span></button>
                    <button class="mb__item" data-cmd="inspector"><span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span class="lb">Inspector</span></button>
                    <button class="mb__item" data-cmd="outliner"><span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span class="lb">Outliner</span></button>
                    <div class="mb__sep"></div>
                    <button class="mb__item" data-cmd="fit"><span class="ic"></span><span class="lb">Inquadra modello</span><span class="sc">F</span></button>
                    <div class="mb__sub">
                        <button class="mb__item"><span class="ic"></span><span class="lb">Viste camera</span><span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span></button>
                        <div class="mb__pop">
                            <button class="mb__item" data-cmd="view" data-arg="dall'alto"><span class="lb">Dall'alto</span></button>
                            <button class="mb__item" data-cmd="view" data-arg="frontale"><span class="lb">Frontale</span></button>
                            <button class="mb__item" data-cmd="view" data-arg="laterale"><span class="lb">Laterale</span></button>
                            <button class="mb__item" data-cmd="view" data-arg="3/4"><span class="lb">Vista 3/4</span></button>
                        </div>
                    </div>
                    <button class="mb__item" data-cmd="section"><span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span class="lb">Sezione</span></button>
                    <div class="mb__sep"></div>
                    <button class="mb__item" data-cmd="grid"><span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span class="lb">Griglia</span></button>
                    <button class="mb__item" data-cmd="axes"><span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span class="lb">Gizmo assi</span></button>
                </div>
            </div>
            <!-- Strumenti (per-nodo → disabled fino al Pezzo nodi) -->
            <div class="mb">
                <button class="mb__btn">Strumenti</button>
                <div class="mb__pop">
                    <div class="mb__sub">
                        <button class="mb__item" aria-disabled="true"><span class="ic"></span><span class="lb">Selezione</span><span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span></button>
                        <div class="mb__pop">
                            <button class="mb__item" data-cmd="sel" data-arg="cerchio" aria-disabled="true"><span class="lb">Cerchio</span></button>
                            <button class="mb__item" data-cmd="sel" data-arg="box" aria-disabled="true"><span class="lb">Box</span></button>
                            <button class="mb__item" data-cmd="sel" data-arg="lazo" aria-disabled="true"><span class="lb">Lazo</span></button>
                        </div>
                    </div>
                    <button class="mb__item" data-cmd="sculpt" aria-disabled="true"><span class="ic"></span><span class="lb">Scolpisci</span></button>
                </div>
            </div>
            <!-- Preferenze (L6 2026-07-23) — scaffold impostazioni utente.
                 Per ora solo il TEMA: due voci mutuamente esclusive cablate al
                 meccanismo esistente (`window.ibexApplyTheme`, persist localStorage
                 + sync scena Three). La spunta è mantenuta da `mbSyncTicks`. -->
            <div class="mb">
                <button class="mb__btn">Preferenze</button>
                <div class="mb__pop">
                    <button class="mb__item" data-cmd="theme-set" data-arg="light"><span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span class="lb">Tema chiaro</span></button>
                    <button class="mb__item" data-cmd="theme-set" data-arg="dark"><span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span class="lb">Tema scuro</span></button>
                    <div class="mb__sep"></div>
                    <!-- ColorReady L11.2 (2026-07-24) — toggle globale colore scansione (MatCap ↔
                         colore). Spunta = ON, gestita da mbSyncTicks. Meccanica gemella del tema
                         (window.ibexApplyColor / localStorage['ibex_ws:color']). ⚠️ Questa voce
                         vive nell'header EDITOR, nascosto in embed (Inv. 123): visibile solo in
                         standalone. La superficie shell è una slice separata (come per il tema). -->
                    <button class="mb__item" data-cmd="color"><span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></span><span class="lb">Colore scansione</span></button>
                </div>
            </div>
            <!-- Aiuto (placeholder → disabled) -->
            <div class="mb">
                <button class="mb__btn">Aiuto</button>
                <div class="mb__pop">
                    <button class="mb__item" data-cmd="docs" aria-disabled="true"><span class="ic"></span><span class="lb">Documentazione</span></button>
                    <button class="mb__item" data-cmd="shortcuts" aria-disabled="true"><span class="ic"></span><span class="lb">Scorciatoie da tastiera</span><span class="sc">⌘/</span></button>
                    <div class="mb__sep"></div>
                    <button class="mb__item" data-cmd="about" aria-disabled="true"><span class="ic"></span><span class="lb">Info IBEX</span></button>
                </div>
            </div>
        </nav>

        <span class="ibex-header-divider"></span>

        <!-- Quickbar (command-bar personalizzabile) — DEFERITA allo step 2, placeholder vuoto -->
        <div class="quickbar" id="quickbar"></div>
    </div>

    <div id="header-actions" class="ibex-header-right">
        <!-- Worker status (Inv. 78) — transitorio, mostrato da UIManager durante il bake -->
        <div id="ibex-worker-status" class="ibex-header-pill" style="display:none;">
            <div class="ibex-worker-dot"></div><span class="ibex-worker-label">Calcolo in corso...</span>
        </div>
    </div>
</header>
<span class="mb-scrim" id="mbScrim"></span>
