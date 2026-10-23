<?php /*
    Preset DAG sidebar (2026-05-05).
    Contenuto popolato lato JS da PresetSidebar.js (caricato da IbexCore).
    Tab "Privati" / "Pubblici" — drag delle card sul canvas DAG triggera spawn.
    onclick toggle del header: window.ibexToggleSidebarSection('dag-sidebar-presets').
*/ ?>
<div class="dag-pane-col" style="background: var(--ibex-surface);">
    <div class="dag-sidebar-header" onclick="window.ibexToggleSidebarSection && window.ibexToggleSidebarSection('dag-sidebar-presets')">
        <svg class="dag-sidebar-chevron" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 4 L5 7 L8 4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>
        </svg>
        <span>Preset</span>
    </div>
    <div class="dag-sidebar-body" style="flex:1; min-height:0; display:flex; flex-direction:column;">
        <div class="ibex-preset-tabs">
            <button type="button" class="ibex-preset-tab is-active" data-tab="private">Privati</button>
            <button type="button" class="ibex-preset-tab" data-tab="public">Pubblici</button>
        </div>
        <div id="ibex-preset-list-private" class="ibex-preset-list" data-namespace="private">
            <div class="ibex-preset-empty">Nessun preset privato</div>
        </div>
        <div id="ibex-preset-list-public" class="ibex-preset-list hidden" data-namespace="public">
            <div class="ibex-preset-empty">Nessun preset pubblico</div>
        </div>
    </div>
</div>
