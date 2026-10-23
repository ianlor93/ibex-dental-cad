// ═══════════════════════════════════════════════════════════════
// IBEX dom-escape — T1Escape_29-7 (2026-07-29)
//
// Un solo `escapeHtml` per tutto il frontend. Prima viveva in QUATTRO
// copie byte-identiche come metodo privato `_escapeHtml(s)`:
//   ContextInspector.js:633 · ViewGizmo.js:744 · ExportPicker.js:449 ·
//   ImportPicker.js:300  (tutte md5 5589491da6e06b16856173db16b60bde).
//
// DEDUP VERBATIM: il corpo qui sotto è quello delle 4, de-indentato dei
// 4 spazi del corpo-di-classe e nient'altro. Stesso set di caratteri
// escapati (`& < > " '`), stesso `String(s)` in ingresso (quindi stessa
// resa di `null`/`undefined`/numeri), stesso ordine — comportamento
// INVARIATO per tutti i chiamanti.
//
// Funzione LIBERA e pura: non usa `this`, quindi il call site passa da
// `this._escapeHtml(x)` a `escapeHtml(x)` senza altre differenze.
//
// ⚠️ NON è l'escape per gli attributi «tecnici». Restano DUE varianti
// deliberatamente diverse, che NON vanno unificate qui:
//   - `ContextInspector.js` `escAttr` (locale) — escapa `& " < >` ma NON
//     l'apostrofo: usarlo al posto di questo cambierebbe il value degli
//     input rename.
//   - `ExportPicker.js::_escapeAttr` — escapa il solo `"` perché serve a
//     costruire un SELETTORE CSS (`[data-name="…"]`), non dell'HTML:
//     entitizzare `&`/`<`/`>` lì dentro romperebbe il match nel DOM.
//
// ⚠️ Inv. 101 (identità ESM via URL canonico): i 4 import site di questo
// file devono usare lo STESSO token `?v=` (`./dom-escape.js?v=X` dai
// `modules/`, `../dom-escape.js?v=X` da `modules/inspectors/`) — stesso
// URL assoluto ⇒ un solo modulo ESM in cache.
// ═══════════════════════════════════════════════════════════════

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
}
