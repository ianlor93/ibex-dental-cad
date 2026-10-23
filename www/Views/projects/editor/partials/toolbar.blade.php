<div class="dag-pane-col" style="background: var(--ibex-surface);">
    <div class="dag-sidebar-header" onclick="window.ibexToggleSidebarSection('dag-sidebar-tools')">
        <svg class="dag-sidebar-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 6 L8 10 L12 6"/>
        </svg>
        <span>Toolbar</span>
    </div>

    <div class="dag-sidebar-body" style="flex:1; min-height:0; display:flex; flex-direction:column;">
        <div class="tool-search-wrap">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            <input type="text" id="tool-search" oninput="window.filterTools(this.value)"
                   placeholder="Cerca strumento...">
        </div>

        <div class="tools-list custom-scroll" id="tools-list" style="background: var(--ibex-surface);">
            <?php if (!empty($categorizedTools) && is_array($categorizedTools)): ?>
                <?php foreach ($categorizedTools as $catName => $tools): ?>
                    <div class="tool-category">
                        <h3 class="tool-category-header"
                            onclick="this.parentElement.classList.toggle('collapsed')">
                            <svg class="tool-category-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M4 6 L8 10 L12 6"/>
                            </svg>
                            <span><?= htmlspecialchars($catName) ?></span>
                        </h3>
                        <div class="tool-category-body">
                            <?php foreach ($tools as $tool): ?>
                                <?php $toolJson = htmlspecialchars(json_encode($tool), ENT_QUOTES, 'UTF-8'); ?>
                                <div class="tool-card"
                                     data-tool-json='<?= $toolJson ?>'
                                     draggable="true"
                                     onclick='window.addToolToStack(<?= $toolJson ?>)'>
                                    <span class="tname"><?= htmlspecialchars($tool['name']) ?></span>
                                    <span class="tadd">+</span>
                                </div>
                            <?php endforeach; ?>
                        </div>
                    </div>
                <?php endforeach; ?>
            <?php else: ?>
                <div class="tools-empty" style="color: var(--ibex-error); background: var(--ibex-surface-2); border: 1px solid var(--ibex-border); border-radius: 3px;">Nessun Tool Trovato</div>
            <?php endif; ?>
        </div>
    </div>
</div>
