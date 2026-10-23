/* ════════════════════════════════════════════════════════════════════
   IBEX ICONS — icone disegnate per IBEX (stroke 1.5 · viewBox 24 · currentColor)
   ▸ Coprono dominio dentale, operazioni DAG e strumenti viewport.
   ▸ Uso:  <i data-ibex="crown"></i>  +  <script src="ibex-icons.js"></script>
     Il container decide la misura (16/20/24/32) — l'SVG riempie al 100%.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  const I = {};

  /* ── Dominio dentale ────────────────────────────────────────────── */
  I['crown'] =
    '<path d="M12 5.5c-1.6-1-3.4-1.3-4.9-.4C5.2 6.2 4.6 8.6 5.3 11c.8 2.6 1.2 5.4 2 7.6.3.9 1.6.8 1.9-.1.5-1.6.8-4.4 2.8-4.4s2.3 2.8 2.8 4.4c.3.9 1.6 1 1.9.1.8-2.2 1.2-5 2-7.6.7-2.4.1-4.8-1.8-5.9-1.5-.9-3.3-.6-4.9.4z"/>';
  I['bridge'] =
    '<path d="M3.75 16.5v-2a2.75 2.75 0 0 1 5.5 0v2"/>' +
    '<path d="M9.25 16.5v-2a2.75 2.75 0 0 1 5.5 0v2"/>' +
    '<path d="M14.75 16.5v-2a2.75 2.75 0 0 1 5.5 0v2"/>' +
    '<path d="M3.75 19.5h16.5"/>';
  I['arch'] =
    '<path d="M5.5 20.5V11a6.5 6.5 0 0 1 13 0v9.5"/>' +
    '<path d="M9 20.5v-9a3 3 0 0 1 6 0v9"/>';
  I['implant'] =
    '<path d="M8.5 3.5h7v3h-7z"/>' +
    '<path d="M9.2 6.5h5.6l-1.7 12.4a1.15 1.15 0 0 1-2.2 0z"/>' +
    '<path d="M9.6 9.5h4.8M10 12.5h4M10.4 15.5h3.2"/>';
  I['scan'] =
    '<path d="M12 21c-2.3 0-3.8-2-3.8-4.8 0-2.4 1.6-4 3.8-4s3.8 1.6 3.8 4C15.8 19 14.3 21 12 21z"/>' +
    '<path d="M5.5 7.5a9 9 0 0 1 13 0"/>' +
    '<path d="M8.3 10.2a5 5 0 0 1 7.4 0"/>';
  I['stl'] =
    '<path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z"/>' +
    '<path d="M14 3.5V7.5h4"/>' +
    '<path d="M12 11.5l2.6 4.5H9.4z"/>';

  /* ── Operazioni DAG ─────────────────────────────────────────────── */
  I['mesh-source'] =
    '<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/>' +
    '<path d="M12 12l7.8-4.5M12 12L4.2 7.5M12 12v9"/>';
  I['smooth'] =
    '<path d="M3 9.5c2.5-2.4 5-2.4 7.5 0s5 2.4 7.5 0"/>' +
    '<path d="M3 15.5c2.5-2.4 5-2.4 7.5 0s5 2.4 7.5 0"/>';
  I['offset'] =
    '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/>' +
    '<rect x="8" y="8" width="8" height="8" rx="2"/>';
  I['decimate'] =
    '<path d="M12 4.5L20.5 19.5H3.5z"/>' +
    '<path d="M12 4.5v15M7.7 12h8.6" stroke-dasharray="2 2.4"/>';
  I['trim'] =
    '<path d="M4 17.5C9.5 17.5 11 6.5 20 6.5"/>' +
    '<path d="M9.5 4l5 16" stroke-dasharray="2.5 2.5"/>';
  I['transform'] =
    '<path d="M12 13V4M12 13l-7.5 4.5M12 13l7.5 4.5"/>' +
    '<path d="M9.8 6.2L12 4l2.2 2.2"/>' +
    '<circle cx="4.5" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>' +
    '<circle cx="19.5" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>';
  I['boolean'] =
    '<circle cx="9" cy="12" r="5.5"/>' +
    '<circle cx="15" cy="12" r="5.5"/>';
  I['mirror'] =
    '<path d="M12 3v18" stroke-dasharray="2.5 2.5"/>' +
    '<path d="M8.5 7.5v9L3.5 12z"/>' +
    '<path d="M15.5 7.5v9l5-4.5z"/>';
  I['spline'] =
    '<rect x="3" y="15.5" width="3.4" height="3.4" rx="0.8"/>' +
    '<rect x="17.6" y="5" width="3.4" height="3.4" rx="0.8"/>' +
    '<path d="M6.4 16.4C7.5 11 11 7.5 17.6 6.8"/>';
  I['bake'] =
    '<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/>' +
    '<path d="M8.8 12.2l2.4 2.4 4.4-4.4"/>';

  /* ── Strumenti viewport ─────────────────────────────────────────── */
  I['select'] =
    '<path d="M4.5 4.5l15 6-6.6 2.4-2.4 6.6z"/>';
  I['move'] =
    '<path d="M12 3v18M3 12h18"/>' +
    '<path d="M9.5 5.5L12 3l2.5 2.5M9.5 18.5L12 21l2.5-2.5M5.5 9.5L3 12l2.5 2.5M18.5 9.5L21 12l-2.5 2.5"/>';
  I['rotate'] =
    '<path d="M21 12a9 9 0 1 1-2.6-6.4"/>' +
    '<path d="M21 3v5h-5"/>' +
    '<circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>';
  I['scale'] =
    '<path d="M21 3l-7.5 7.5"/>' +
    '<path d="M21 8V3h-5"/>' +
    '<rect x="3" y="13" width="8" height="8" rx="1"/>';
  I['sculpt'] =
    '<path d="M20.5 3.5l-6.8 6.8"/>' +
    '<path d="M13.9 10.1c-1.7-1.2-4-.8-5.1.8-1 1.5-.3 3.2-2.3 4.8 2.6 1.4 6 .9 7.4-1.1 1.1-1.6 1.1-3.3 0-4.5z"/>';
  I['cut'] =
    '<path d="M4 17c4 0 5.5-9 8-9s4 9 8 9"/>' +
    '<path d="M12 3.5v17" stroke-dasharray="2.5 2.5"/>';
  I['measure'] =
    '<path d="M3.8 16.4L16.4 3.8a1.4 1.4 0 0 1 2 0l1.8 1.8a1.4 1.4 0 0 1 0 2L7.6 20.2a1.4 1.4 0 0 1-2 0l-1.8-1.8a1.4 1.4 0 0 1 0-2z"/>' +
    '<path d="M8.5 15.5l1.5 1.5M11.5 12.5l1.5 1.5M14.5 9.5l1.5 1.5"/>';

  /* ── UI di sistema ──────────────────────────────────────────────── */
  I['dag'] =
    '<rect x="3" y="4.5" width="6" height="4.5" rx="1"/>' +
    '<rect x="15" y="9.75" width="6" height="4.5" rx="1"/>' +
    '<rect x="3" y="15" width="6" height="4.5" rx="1"/>' +
    '<path d="M9 6.75h2.5a1.5 1.5 0 0 1 1.5 1.5v2.25M9 17.25h2.5a1.5 1.5 0 0 0 1.5-1.5v-2.25M13 12h2"/>';
  I['bypass'] =
    '<circle cx="5" cy="12" r="1.9"/>' +
    '<circle cx="19" cy="12" r="1.9"/>' +
    '<path d="M6.9 12h10.2"/>';
  I['fit'] =
    '<path d="M3.5 8V5A1.5 1.5 0 0 1 5 3.5h3M16 3.5h3A1.5 1.5 0 0 1 20.5 5v3M20.5 16v3a1.5 1.5 0 0 1-1.5 1.5h-3M8 20.5H5A1.5 1.5 0 0 1 3.5 19v-3"/>' +
    '<circle cx="12" cy="12" r="3"/>';

  function svg(name) {
    const body = I[name];
    if (!body) return '';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  function inject(root) {
    (root || document).querySelectorAll('[data-ibex]').forEach(function (el) {
      const m = svg(el.getAttribute('data-ibex'));
      if (m) { el.innerHTML = m; el.classList.add('ibex-icon'); }
    });
  }

  window.IbexIcons = { icons: I, svg: svg, inject: inject };

  const style = document.createElement('style');
  style.textContent = '.ibex-icon{display:inline-flex;flex:none;width:16px;height:16px}.ibex-icon svg{width:100%;height:100%;display:block}';
  document.head.appendChild(style);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { inject(); });
  } else { inject(); }
})();
