<div class="dag-pane-col" style="background: transparent;">
    <div class="dag-zoom">
        <button onclick="window.ibex.stackMgr.editor.zoom_in()" title="Zoom In">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
        </button>
        <button onclick="window.ibex.stackMgr.editor.zoom_reset()" title="Reset Zoom">
            1:1
        </button>
        <button onclick="window.ibex.stackMgr.editor.zoom_out()" title="Zoom Out">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4"></path></svg>
        </button>
    </div>

    <div id="drawflow" class="bg-dotted-pattern" ondrop="window.dropMeshToCanvas(event)" ondragover="event.preventDefault()"></div>
</div>
