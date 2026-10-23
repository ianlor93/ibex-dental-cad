"""
tier1_orchestrator — orchestratore della queue Tier 1 (FASE 4 dello scorporo, 2026-07-20).

Contiene `apply_tier1_queue` (l'unico simbolo pubblico: `worker.py` importa QUESTO,
non più fast_transform) + la tabella di dispatch `DISPATCH` (FASE 3).

Cosa orchestra (traslato da fast_transform.py senza cambi di logica):
  · traversal della queue Tier 1;
  · lookup / save / GC della pipeline cache (delega a pipeline_cache + safe_target_name);
  · passthrough dei nodi muted (incl. il caso split_topology che rifabbrica A/B);
  · gestione della mesh_cache in-task (invariante B2: l'invalidazione è del CALLER,
    mai degli handler — mesh None ⇒ pop, mesh!=None ⇒ set);
  · post-dispatch uniforme per single-output / split-multi / inerte.

Il dispatch (`DISPATCH`) mappa tool → handler. Gli handler vivono in
tier1_handlers.py (10) e in fast_transform.py (_apply_transform). L'ABI
ToolContext/ToolResult e i loader stanno in fast_transform.py (foglia).

DAG import (aciclico): tier1_orchestrator → {fast_transform, tier1_handlers,
pipeline_cache, filesystem, config}; tier1_handlers → fast_transform.
"""

import os
import time
import uuid
import shutil
import json

from .config import DESTRUCTIVE_TOOLS
from .pipeline_cache import (
    CACHEABLE_TOOLS,
    compute_input_hash,
    compute_cache_key,
    stl_looks_valid,
)
from .filesystem import safe_target_name
from .fast_transform import TRIMESH_AVAILABLE, ToolContext, _apply_transform
from .tier1_handlers import (
    _apply_parenting,
    _apply_snapshot,
    _apply_split,
    _apply_meshcleaner,
    _apply_slice,
    _apply_draw_curve,
    _apply_arch_detect,
    _apply_curve_edit,
    _apply_topology_rebuild,
    _apply_modelgenerator,
)


# ============================================================================
# DISPATCH — tool → handler (FASE 3, 2026-07-20).
#
# Sostituisce la catena if/elif il cui ORDINE era load-bearing: i 5 destructive
# con handler dedicato (split_topology, topology_rebuild, draw_curve, arch_detect,
# curve_edit) DOVEVANO precedere il catch-all `elif tool in DESTRUCTIVE_TOOLS`,
# altrimenti split_topology cadeva su _apply_snapshot (semantica diversa). Con la
# tabella l'ordine smette di contare — è il guadagno della fase.
#
# Le chiavi ESPLICITE sono i tool con handler dedicato. Il `setdefault` sotto
# aggiunge i destructive SENZA branch dedicato (oggi: sculpt, delete_topology) →
# _apply_snapshot, senza sovrascrivere i 5 già presenti. Invariante di
# copertura verificata dal test di mappatura FASE 3:
#     set(DISPATCH) == set(TIER1_TOOLS)  e  set(DESTRUCTIVE_TOOLS) <= set(DISPATCH)
# ============================================================================
DISPATCH = {
    'transform':        _apply_transform,
    'parent':           _apply_parenting,
    'meshcleaner':      _apply_meshcleaner,
    'slice':            _apply_slice,
    'modelgenerator':   _apply_modelgenerator,
    'split_topology':   _apply_split,
    'topology_rebuild': _apply_topology_rebuild,
    'draw_curve':       _apply_draw_curve,
    'arch_detect':      _apply_arch_detect,
    'curve_edit':       _apply_curve_edit,
}
for _destructive_tool in sorted(DESTRUCTIVE_TOOLS):
    DISPATCH.setdefault(_destructive_tool, _apply_snapshot)   # sculpt, delete_topology (catch-all S2)
del _destructive_tool


# ============================================================================
# Tool il cui `world_matrix` è DAVVERO applicato alla geometria (Bug A, 2026-07-29).
#
# Censimento sui byte: `mesh.apply_transform(mat)` compare in DUE punti soli nel
# worker — _apply_transform (fast_transform.py:135) e _apply_parenting
# (tier1_handlers.py:49) — ed entrambi leggono `params['world_matrix']` via
# _load_matrix. Gli altri 8 handler non nominano mai il campo, e `world_matrix`
# non compare in NESSUN file di assets/logic_py/ (i 4 handler che passano `params`
# intero a un modulo logic_py — meshcleaner, slice, arch_detect, modelgenerator —
# glielo consegnano, e quello lo ignora).
#
# ⚠️ Allargare questo set senza aggiungere l'apply corrispondente fa DERIVARE la
# mesh; restringerlo togliendo un tool che la applica la fa derivare all'incontrario.
# È una lista semantica, non una comodità.
#
# I nomi sono quelli POST-rename: `_TOOL_RENAME` (config.py:90) normalizza
# fast_transform→transform e fast_parenting→parent in worker._strip_no_backend,
# che gira prima di TUTTI e quattro i call-site di apply_tier1_queue
# (worker.py:926 BAKE, :1100 FAST, :1338 PREVIEW, :1825 MESH_PIPELINE).
# ============================================================================
_MATRIX_TOOLS = {'transform', 'parent'}


def _is_identity16(mat):
    """True se `mat` è l'identità 4×4 flat (16 float).

    Tolleranza 1e-9: la STESSA di BakeEngine.js:708 — le due implementazioni della
    medesima regola devono decidere identico, o il sidecar e `appliedMatFlat`
    divergono di nuovo. Input malformato (non-lista, len != 16, valori non
    numerici) → False, cioè «non identità» → viene registrato, esattamente come
    faceva il codice pre-fix: questa funzione può solo TOGLIERE registrazioni
    provabilmente identità, mai aggiungerne.
    """
    if not isinstance(mat, (list, tuple)) or len(mat) != 16:
        return False
    try:
        return all(abs(float(v) - (1.0 if i % 5 == 0 else 0.0)) <= 1e-9
                   for i, v in enumerate(mat))
    except (TypeError, ValueError):
        return False


def apply_tier1_queue(queue, active_path, output_dir, logger, cache_dir=None):
    """
    Applica in sequenza tutti gli step Tier 1 della queue.

    queue: lista di step ordinati topologicamente
    active_path: directory con gli STL master del progetto
    output_dir: directory di output (es. preview_tmp/)
    logger: callable per logging
    cache_dir: opzionale (Tier C Fase 1, 2026-04-30) — directory cache pipeline.
        Se non None, attiva memoization per i tool in `pipeline_cache.CACHEABLE_TOOLS`
        (meshcleaner, modelgenerator). Cache hit → copia da cache, skip compute.
        Cache miss → esegui step + salva output in cache. GC automatico per
        target alla fine: rimuove cache file NON referenziati in questo run.
        Tipicamente: cache_dir = active_path/.cache_pipeline

    Ritorna True se tutti gli step hanno successo, False al primo errore.

    Ottimizzazione in-task mesh_cache: il mesh Trimesh viene tenuto in memoria
    tra step consecutivi sullo stesso target per evitare round-trip su FUSE.

    INVARIANTE mesh_cache (BUGFIX B2, 2026-07-14) — l'invalidazione è
    RESPONSABILITÀ DEL CALLER, mai degli handler:
      dopo ogni step, mesh_cache[out_path] è popolata SE E SOLO SE l'handler ha
      restituito la mesh in memoria (out_mesh != None → solo fast_transform e
      fast_parenting). In TUTTI gli altri casi (handler che riscrive il file e
      ritorna None, cache hit servito da cache_dir, split multi-output, muted con
      copy) la entry viene RIMOSSA: il file su disco è stato riscritto e una entry
      residua di uno step precedente sarebbe STALE — _load_mesh la servirebbe al
      prossimo step scartando il lavoro dell'handler (es. fast_transform →
      meshcleaner → fast_transform annullava il meshcleaner).
    Gli handler NON devono toccare mesh_cache.
    """
    if not TRIMESH_AVAILABLE:
        logger("[APPLY] [IBEX-ENGINE ERROR] trimesh non disponibile nel container")
        return False

    # L'invariante mesh_cache assume che output_dir NON coincida con active_path
    # (le chiavi di mesh_cache sono output_dir/{target}; gli handler scrivono
    # collaterali in active_path — snap A/B, .crv.json, .recompute_seq — che non
    # sono mai chiavi di cache). Oggi è vero in tutti i call-site (worker.py:794,
    # :991, :1232, :1048): lo rendiamo esplicito invece di lasciarlo implicito.
    if os.path.abspath(output_dir) == os.path.abspath(active_path):
        logger("[APPLY] [IBEX-ENGINE ERROR] output_dir non può coincidere con active_path")
        return False

    os.makedirs(output_dir, exist_ok=True)

    # current_stl: target -> path STL su disco (per compatibilità con il caller)
    # mesh_cache:  path -> trimesh.Trimesh — evita reload da FUSE per step concatenati
    current_stl = {}
    mesh_cache  = {}  # valido solo per la durata di questa chiamata
    # ④ FastReload sidecar (2026-07-21): world matrix applicata per target (l'ULTIMO
    # world_matrix Tier 1 in ordine di queue = ciò che il client cattura in
    # appliedMatFlat via _bestMatrixByTarget). Scritta accanto alla geometria a fine run.
    applied_mat_by_target = {}

    # Cache pipeline tracking: target -> set(cache_key) usati in questo run.
    # Usato per GC finale (rimuove le key NON referenziate per questo target).
    used_cache_keys = {}

    for step in queue:
        tool   = step.get('tool', '')
        target = step.get('target', '')
        params = step.get('params', {})

        # ④ sidecar: registra il world_matrix SOLO se denota una trasformazione
        # DAVVERO applicata alla geometria. Due condizioni, entrambe necessarie:
        #
        #   (a) `tool in _MATRIX_TOOLS` — solo transform e parent chiamano
        #       mesh.apply_transform(wm). Gli altri 10 tool Tier 1 ricevono il
        #       campo per UNIFORMITÀ (ToolExecutor.js:616-619 lo inietta su OGNI
        #       nodo con tier===1) e per loro computeToolWorld rende IDENTITÀ:
        #       solo `transform` ha widget _POS/_ROT e solo `parent` ha un socket
        #       IN_MTX_ (gn_meta.json), che sono i due unici modi in cui quella
        #       funzione può produrre una matrice non banale.
        #
        #   (b) non-identità — è la regola che il CLIENT applica già da V15.1
        #       (BakeEngine.js:704-728 `_bestMatrixByTarget`): «vince l'ULTIMO
        #       world_matrix NON-identity». Senza (b) basta un secondo nodo
        #       Transform lasciato a slider zero — lo stato di DEFAULT di ogni
        #       nodo appena trascinato dalla palette — per riscrivere identità
        #       sopra la matrice vera.
        #
        # Bug A (2026-07-29, pid 297 e 299): il last-wins INCONDIZIONATO faceva
        # vincere l'identità dei tool di pulizia, che in coda arrivano ultimi →
        # sidecar identità su geometria che la matrice ce l'ha già dentro → al
        # reopen EditorController fa vincere il sidecar su applied_matrices e
        # applyGraph calcola applyMat = worldMat × I⁻¹ = M, applicandola una
        # SECONDA volta → deriva di esattamente M, cumulativa ad ogni riapertura.
        #
        # Il commento pre-fix diceva «specchia _bestMatrixByTarget lato client»:
        # era l'INTENZIONE giusta con l'implementazione sbagliata — il client
        # scarta le identità, questo registro no. Ora specchia davvero.
        _wm = params.get('world_matrix')
        if _wm and target and tool in _MATRIX_TOOLS and not _is_identity16(_wm):
            applied_mat_by_target[target] = _wm

        if not target:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] step senza target: {step}")
            return False

        # Risolvi il path STL corrente per questo target
        src_path = current_stl.get(target) or os.path.join(active_path, target)

        if not os.path.exists(src_path):
            logger(f"[APPLY] [IBEX-ENGINE ERROR] STL non trovato: {src_path}")
            return False

        # === MUTE / Bypass (V18.X NodeMute, 2026-05-05) ===
        # Pattern Houdini "bypass" / Blender "mute". Quando params._muted=True
        # il nodo è presente nel DAG e nel manifest ma il worker SALTA il calcolo
        # e fa passthrough: copia src -> output identica. Downstream riceve
        # l'input intatto del nodo (non il risultato del compute). Skip totale
        # del cache lookup/save (il passthrough è già un cp ~istantaneo, non
        # serve memoization). Skip dispatch tool. Caso speciale split_topology:
        # produce 2 file _snap_{nodeId}_A/B = entrambi copia del master upstream
        # (downstream del ramo A o B vede l'input intero, coerente con Houdini).
        if params.get('_muted'):
            try:
                if tool == 'split_topology':
                    # Multi-output muted: crea entrambi i target A/B come copia master.
                    # Pattern naming identico a _apply_split (vedi riga ~484).
                    stem = os.path.splitext(target)[0]
                    node_id = params.get('_snapshot_node_id', '')
                    if not node_id:
                        logger(f"[APPLY] split MUTED: _snapshot_node_id mancante, skip")
                        continue
                    for branch in ('A', 'B'):
                        bt = f"{stem}_snap_{node_id}_{branch}.stl"
                        bp = os.path.join(output_dir, bt)
                        # Defensive: skip se src e bp coincidono (improbabile per split, ma safe).
                        if os.path.abspath(src_path) != os.path.abspath(bp):
                            shutil.copy2(src_path, bp)
                            mesh_cache.pop(bp, None)  # BUGFIX B2: bp riscritto su disco
                        current_stl[bt] = bp
                    logger(f"[APPLY] {tool}/{target} MUTED -> passthrough A+B (snap_{node_id})")
                else:
                    out_path = os.path.join(output_dir, target)
                    # FIX 2026-05-05: se il nodo muted è downstream di un altro
                    # nodo già processato in output_dir, src_path punta già a
                    # output_dir/target → shutil.copy2 lancia SameFileError.
                    # Pattern identico a _apply_snapshot (sculpt/delete_topology):
                    # se src == dst, passthrough in-place (no copy, current_stl
                    # già consistent dal nodo precedente).
                    if os.path.abspath(src_path) == os.path.abspath(out_path):
                        # BUGFIX B2 — unica carve-out legittima: qui il "no-write" è
                        # provabile localmente (nessuna scrittura in questo ramo, solo
                        # log) → la entry mesh_cache[out_path] è ancora coerente col
                        # file e NON va invalidata. Negli handler l'equivalente check
                        # `src==out` NON implica "no write" (arch_detect cache-miss,
                        # topology_rebuild fallback scrivono comunque) → lì si poppa.
                        logger(f"[APPLY] {tool}/{target} MUTED -> passthrough in-place (no copy)")
                    else:
                        shutil.copy2(src_path, out_path)
                        mesh_cache.pop(out_path, None)  # BUGFIX B2: out_path riscritto
                        logger(f"[APPLY] {tool}/{target} MUTED -> passthrough")
                    current_stl[target] = out_path
            except Exception as e:
                logger(f"[APPLY] [IBEX-ENGINE ERROR] muted passthrough fail ({tool}/{target}): {e}")
                return False
            continue  # skip cache lookup + dispatch tool

        # === Cache pipeline lookup (Tier C Fase 1) ===
        # Solo per tool computationally expensive whitelisted. Skip per
        # fast_transform/parenting (rapidi, params dragati continuamente)
        # e per destructive (sono copy passthrough, costo minimo).
        cache_key = None
        cache_path = None
        if cache_dir and tool in CACHEABLE_TOOLS:
            input_hash = compute_input_hash(src_path)
            cache_key = compute_cache_key(target, tool, params, input_hash)
            if cache_key:
                target_cache_dir = os.path.join(cache_dir, safe_target_name(target))
                cache_path = os.path.join(target_cache_dir, cache_key + '.stl')
                if os.path.isfile(cache_path) and not stl_looks_valid(cache_path):
                    # BUGFIX B4 — self-heal: entry troncata da un CACHE SAVE non
                    # atomico (kill/OOM pre-fix). Senza questo unlink la key resta
                    # "usata" → la GC non la tocca → servita a ogni bake per sempre.
                    logger(f"[APPLY] [CACHE CORRUPT] {tool}/{target} key={cache_key[:8]} "
                           f"→ entry rimossa, recompute")
                    try:
                        os.unlink(cache_path)
                    except OSError:
                        pass
                if os.path.isfile(cache_path):
                    out_path = os.path.join(output_dir, target)
                    try:
                        shutil.copy2(cache_path, out_path)
                        logger(f"[APPLY] [CACHE HIT] {tool}/{target} key={cache_key[:8]}")
                        current_stl[target] = out_path
                        # BUGFIX B2: out_path è stato appena RISCRITTO dalla cache.
                        # Non basta "non popolare" mesh_cache: una entry residua per
                        # QUESTO path, scritta da uno step precedente sullo stesso
                        # target, vincerebbe su disco in _load_mesh → il risultato
                        # cachato verrebbe scartato. Va INVALIDATA.
                        mesh_cache.pop(out_path, None)
                        used_cache_keys.setdefault(target, set()).add(cache_key)
                        continue  # skip dispatch tool, prossimo step
                    except Exception as e:
                        logger(f"[APPLY] [CACHE WARN] copy hit fallita ({e}), recompute")
                        cache_path = None  # fallback compute normale

        # === Dispatch tool (cache miss o tool non cacheable) ===
        # FASE 3 (2026-07-20): l'if/elif è diventato la tabella `DISPATCH`
        # (module-level). L'ORDINE non conta più: i destructive con handler
        # dedicato (split_topology, topology_rebuild, draw_curve, arch_detect,
        # curve_edit) sono chiavi ESPLICITE in DISPATCH; sculpt/delete_topology
        # cadono su _apply_snapshot via il `setdefault` che popola DISPATCH dai
        # DESTRUCTIVE_TOOLS residui. Riproduce esattamente il vecchio
        # `elif tool in DESTRUCTIVE_TOOLS` che stava DOPO gli elif espliciti.
        handler = DISPATCH.get(tool)
        if handler is None:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] tool non Tier 1 nella queue: {tool}")
            return False

        ctx = ToolContext(
            src_path=src_path, params=params, output_dir=output_dir, target=target,
            active_path=active_path, tool=tool, logger=logger, mesh_cache=mesh_cache,
        )
        result = handler(ctx)

        # `success` è l'UNICO discriminante fatale. INERT (success=True, outputs=[])
        # NON abortisce: il for sotto non itera, la pipeline prosegue (nodo split
        # fresco senza applySplit / snapshot non ancora salvato).
        if not result.success:
            return False

        # Post-dispatch UNIFORME per single-output, split-multi e inerte.
        #   · split: outputs=[(A,…),(B,…)] → il MASTER (target) NON è in outputs →
        #     current_stl[target] non viene toccato (subsume il vecchio `continue`).
        #   · inerte: outputs=[] → il for non fa nulla → pipeline prosegue.
        #   · BUGFIX B2: mesh None → pop incondizionato (il file su disco è stato
        #     (ri)scritto; una entry residua sarebbe stale). mesh!=None (solo
        #     transform/parenting) → topologia invariata, la cache resta valida.
        for (t, p, m) in result.outputs:
            current_stl[t] = p
            if m is not None:
                mesh_cache[p] = m
            else:
                mesh_cache.pop(p, None)

        # === Cache pipeline save (Tier C Fase 1) — SOLO single-output cacheable ===
        # BUGFIX B4 (2026-07-14): scrittura ATOMICA vs KILL del processo — copy2 su
        # tmp + os.replace. Il tmp ha nome UNIVOCO per writer (pid+uuid): due sub-task
        # MESH_PIPELINE possono scrivere la STESSA cache_key in parallelo (non prendono
        # il lock, controllano abort_key solo all'ingresso — worker.py:1680/:1707 —
        # mentre il coordinator rilascia il lock al LIFO-abort con i sub-task in volo).
        # Con tmp fisso si troncherebbero a vicenda e os.replace pubblicherebbe un STL
        # misto sotto chiave valida. Il suffisso '.tmp' non finisce in '.stl' → la GC
        # non lo scambia per una cache key.
        # Il guard len(outputs)==1 è ESPLICITO: cache_path/cache_key sono valorizzati
        # solo per CACHEABLE_TOOLS (meshcleaner, modelgenerator), entrambi single-output.
        # Blinda contro un futuro multi-output erroneamente reso cacheable (zipparebbe
        # un solo branch, o IndexError su outputs[0]).
        if cache_path and cache_key and len(result.outputs) == 1:
            saved_path = result.outputs[0][1]
            tmp_cache = f"{cache_path}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
            try:
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                shutil.copy2(saved_path, tmp_cache)
                os.replace(tmp_cache, cache_path)   # atomico vs kill del processo
                logger(f"[APPLY] [CACHE SAVE] {tool}/{target} key={cache_key[:8]}")
                used_cache_keys.setdefault(target, set()).add(cache_key)
            except Exception as e:
                try:
                    os.unlink(tmp_cache)            # safe: nome univoco per writer
                except OSError:
                    pass
                logger(f"[APPLY] [CACHE WARN] save fallito ({e})")

    # === GC implicita cache pipeline ===
    # Per ogni target processato, rimuove le cache file NON referenziate in
    # questo run. Mantiene solo gli "step live" della pipeline corrente.
    # Caso d'uso: utente cambia params di un nodo → cache key vecchia diventa
    # inutilizzata → rimossa al prossimo run. Cache size cap implicito.
    if cache_dir and used_cache_keys:
        now = time.time()
        for target, used in used_cache_keys.items():
            target_cache_dir = os.path.join(cache_dir, safe_target_name(target))
            if not os.path.isdir(target_cache_dir):
                continue
            try:
                for f in os.listdir(target_cache_dir):
                    fpath = os.path.join(target_cache_dir, f)
                    if f.endswith('.tmp'):
                        # BUGFIX B4: residuo di un CACHE SAVE ucciso (OOM/SIGKILL) tra
                        # copy2 e os.replace. Guard di età OBBLIGATORIO (stesso pattern
                        # dello sweep janitor, worker.py:288-296): un .tmp fresco può
                        # appartenere a un writer VIVO su un altro worker (sub-task
                        # MESH_PIPELINE stale sullo stesso target, cache_dir condivisa)
                        # → cancellarlo gli farebbe fallire os.replace.
                        # NB: il check va PRIMA del filtro '.stl', altrimenti è morto.
                        try:
                            if now - os.path.getmtime(fpath) > 3600:
                                os.unlink(fpath)
                        except OSError:
                            pass
                        continue
                    if not f.endswith('.stl'):
                        continue
                    key = f[:-4]  # rimuove '.stl'
                    if key not in used:
                        try:
                            os.unlink(fpath)
                        except OSError:
                            pass
            except OSError:
                pass

    # ④ FastReload sidecar — scrive output_dir/{stem}.mat.json per ogni master target
    # (SEMPRE, identity se nessun world_matrix → assenza del file = archivio pre-fix).
    # La coppia geometria+matrice viaggia nello stesso swap atomico (dir-rename per
    # FAST inline; per-mesh os.replace per Tier C in worker.py). Le derivate split
    # (_snap_..._A/B) sono ESCLUSE: usano un path di load separato (fallback invariato).
    _IDENTITY16 = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
    for _t in current_stl:
        if '_snap_' in _t:
            continue
        try:
            _mat = applied_mat_by_target.get(_t, _IDENTITY16)
            with open(os.path.join(output_dir, os.path.splitext(_t)[0] + '.mat.json'), 'w') as _sf:
                json.dump(_mat, _sf)
        except Exception as _e:
            logger(f"[APPLY] [SIDECAR WARN] {_t}: {_e}")

    return True
