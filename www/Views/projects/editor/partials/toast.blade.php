<?php /* Toast — pilla di legge (Editor reale.html:301-305 + :975-986), zero Tailwind.
         Pilla UNICA top-center riusata (il nuovo messaggio sostituisce il precedente),
         2000ms — gli ERRORI tengono 3000ms (deviazione dichiarata: in un CAD un errore
         di bake non deve sparire sotto un "salvato"). Firma window.notify(message, type)
         PRESERVATA (UIManager.notify vi delega, ~15 call-site nei moduli). */ ?>
<style>
#toast{position:fixed;left:50%;top:76px;transform:translateX(-50%) translateY(-8px);z-index:130;display:flex;align-items:center;gap:9px;
  max-width:min(92vw,420px);padding:9px 14px;border-radius:var(--r-pill, 9999px);background:var(--ibex-text);color:var(--ibex-surface);font-size:12px;font-weight:500;
  box-shadow:0 6px 24px rgba(0,0,0,.16);opacity:0;pointer-events:none;transition:opacity .24s cubic-bezier(.2,.8,.2,1),transform .24s cubic-bezier(.2,.8,.2,1);
  font-family:'Ubuntu',sans-serif}
#toast.on{opacity:1;transform:translateX(-50%)}
#toast svg{width:16px;height:16px;flex:none}
#toast.toast-error svg{color:var(--ibex-error)}
#toast.toast-warning svg{color:var(--ibex-mtx)}
:root[data-embed="1"] #toast{top:14px}
</style>
<div id="toast"></div>
<script>
(function(){
    var PATHS = {
        success: 'M5 13l4 4L19 7',
        info:    'M12 16v-4 M12 8h.01 M12 3a9 9 0 100 18 9 9 0 000-18',
        error:   'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
        warning: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'
    };
    var toastT;
    window.notify = function(message, type = 'info') {
        var t = document.getElementById('toast');
        if (!t) return;
        var p = PATHS[type] || PATHS.info;
        t.className = '';
        if (type === 'error')   t.classList.add('toast-error');
        if (type === 'warning') t.classList.add('toast-warning');
        t.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + p + '"/></svg><span></span>';
        t.querySelector('span').textContent = message;
        t.classList.add('on');
        clearTimeout(toastT);
        toastT = setTimeout(function(){ t.classList.remove('on'); }, type === 'error' ? 3000 : 2000);
    };
})();
</script>
