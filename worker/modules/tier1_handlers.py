"""
tier1_handlers — handler dei tool Tier 1 (FASE 2 dello scorporo, 2026-07-20).

Copia-incolla PURA dei 10 `_apply_*` che prima vivevano in fast_transform.py.
Nessuna logica cambiata rispetto alla FASE 1 (ABI ToolContext/ToolResult): i
corpi sono byte-identici. Ogni handler continua ad ADATTARE al proprio interno
la firma divergente del modulo logic_py che invoca (meshcleaner/slice/
modelgenerator: `apply(src,params,out,log)`; arch_detect: kwargs; topology_rebuild:
`apply(src,sel,out,log)`; split_via_curves: `apply(src,crv,a,b,log)`).

Contratto: `_apply_x(ctx: ToolContext) -> ToolResult`. Il dispatch (quale handler
per quale tool) e l'orchestrazione della queue vivono in tier1_orchestrator.py.
`_apply_transform` NON è qui: resta in fast_transform.py (è il tool omonimo).

L'ABI (ToolResult) e i loader condivisi (_load_matrix/_load_mesh) sono importati
da .fast_transform — la foglia del sotto-sistema Tier 1. La whitelist nodeId
(validate_node_id) da .config (sede unica, E2 2026-07-14).
"""

import os
import json
import shutil
import traceback

from .config import validate_node_id
from .fast_transform import ToolResult, _load_matrix, _load_mesh


def _apply_parenting(ctx):
    """
    fast_parenting: applica la world matrix del parent alla mesh figlia.
    La matrice è in params['world_matrix'] (flat 16 float, row-major).
    È la world matrix pura del parent (con pivot compensation), NON la
    variante GN-corretta (IN_MTX_Parent) usata da Blender GN.
    Trimesh fa: vertex_out = matrix * vertex_in (moltiplicazione diretta).
    Restituisce ToolResult; la mesh in memoria viaggia nella tupla di output.
    """
    src_path, params, output_dir, target, logger, mesh_cache = (
        ctx.src_path, ctx.params, ctx.output_dir, ctx.target, ctx.logger, ctx.mesh_cache)

    mat = _load_matrix(params, 'world_matrix', logger)
    if mat is None:
        return ToolResult(False, [])

    mesh = _load_mesh(src_path, logger, mesh_cache or {})
    if mesh is None:
        return ToolResult(False, [])

    mesh.apply_transform(mat)

    out_path = os.path.join(output_dir, target)
    try:
        mesh.export(out_path)
    except Exception as e:
        logger(f"[APPLY] [IBEX-ENGINE ERROR] export STL '{out_path}' fallito: {e}")
        return ToolResult(False, [])

    logger(f"[APPLY] parent OK: {target}")
    return ToolResult(True, [(target, out_path, mesh)])


def _apply_snapshot(ctx):
    """
    _apply_snapshot (SnapshotKeyed Session 2, 2026-04-24): handler generico per
    tutti i tool destructive. Rinomina + generalizzazione di `_apply_sculpt`
    (Session 1). Usato da sculpt, delete_topology, futuri split_topology.

    Passthrough della mesh modificata client-side, keyed per nodeId invece che
    per nome mesh (o per toolId).

    Il file snapshot è `{active_path}/{stem}_snap_{nodeId}.stl` dove:
      - stem = basename(src_path) senza estensione (es. "Upper", "Parte A")
      - nodeId = params['_snapshot_node_id'] (iniettato da ToolExecutor.
        flattenGraphForBackend per ogni nodo con data.destructive === true)

    Lookup dir: `active_path` (NON src_path.dir). Il file è scritto da
    SAVE_SNAPSHOT worker action in active_path/, indipendentemente da dove sia
    stato prodotto src_path (preview_tmp/ se preceduto da altro Tier 1).

    Semantica:
      - nodeId valido + file presente   → copia come output
      - nodeId valido + file assente    → passthrough master (nodo inerte)
      - nodeId assente (legacy)         → fallback a `{stem}_sculpted.stl`
                                           con log deprecation. Serve per
                                           sessioni con frontend cached che
                                           inviano queue senza
                                           `_snapshot_node_id`.
      - nodeId invalido (caratteri fuori whitelist) → passthrough master
                                           (sicurezza: no path traversal).

    LIMITAZIONE NOTA (invariata da Sculpt V2): se un altro Tier 1 upstream
    applica una matrice a monte (es. fast_transform → sculpt), lo snapshot
    viene copiato SOPRA quell'output → trasformazione upstream scartata.
    Il warning UX è in StackManager._checkSculptPosition (invariante 77b,
    limitato a toolId==='sculpt' — S2-A9 mantiene lo scope stretto).

    Restituisce ToolResult(True, [(ctx.target, out_path, None)]); mesh=None → il
    CALLER invalida mesh_cache[out_path] (BUGFIX B2) → il prossimo step ricarica da disco.
    ⚠️ La CHIAVE dell'output è ctx.target, NON basename(src_path): coincidono oggi
    (single-output destructive) ma il contratto fissa ctx.target (Invariante 7).
    """
    src_path, params, output_dir, target, logger, active_path, tool_id = (
        ctx.src_path, ctx.params, ctx.output_dir, ctx.target, ctx.logger,
        ctx.active_path, ctx.tool)

    out_path = os.path.join(output_dir, os.path.basename(src_path))
    src_dir = active_path if active_path else os.path.dirname(src_path)
    stem = os.path.splitext(os.path.basename(src_path))[0]

    node_id = params.get('_snapshot_node_id') if isinstance(params, dict) else None
    # Tool tag (diagnostico only, per log leggibili): è ctx.tool (lo slug del nodo).
    # Il naming file NON dipende da tool_id — resta `is None` la policy su node_id.
    tool_tag = tool_id or 'snapshot'

    if node_id is None:
        # Task legacy in coda al deploy (frontend pre-SnapshotKeyed_S1): fallback
        # al naming vecchio. Transitorio — il frontend aggiornato invia sempre
        # _snapshot_node_id per i nodi destructive.
        logger(f"[APPLY] {tool_tag} DEPRECATED: _snapshot_node_id mancante per {target}, "
               f"fallback legacy _sculpted.stl")
        snapshot = os.path.join(src_dir, f"{stem}_sculpted.stl")
        snapshot_label = f"{stem}_sculpted.stl (legacy)"
    elif validate_node_id(node_id):
        snapshot = os.path.join(src_dir, f"{stem}_snap_{node_id}.stl")
        snapshot_label = f"{stem}_snap_{node_id}.stl"
    else:
        # nodeId non vuoto ma non safe — rifiuta senza fallback (no silent path traversal)
        logger(f"[APPLY] [IBEX-ENGINE ERROR] {tool_tag} node_id non conforme alla "
               f"whitelist: {node_id!r}, passthrough master")
        snapshot = None
        snapshot_label = None

    if snapshot and os.path.isfile(snapshot):
        try:
            shutil.copy2(snapshot, out_path)
            logger(f"[APPLY] {tool_tag}: usata {snapshot_label} per {target}")
            return ToolResult(True, [(target, out_path, None)])
        except Exception as e:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] {tool_tag} copy fallito: {e}")
            return ToolResult(False, [])

    # Passthrough master (nessun file snapshot trovato — nodo appena aggiunto,
    # o legacy assente, o nodeId invalido).
    # Se il destructive arriva DOPO un altro step Tier 1 (es. fast_parenting → sculpt),
    # src_path == out_path (stesso file in output_dir). shutil.copy2 solleverebbe
    # SameFileError → guard con abspath compare + skip no-op.
    try:
        if os.path.abspath(src_path) == os.path.abspath(out_path):
            logger(f"[APPLY] {tool_tag} passthrough in-place (no snapshot): {target}")
        else:
            shutil.copy2(src_path, out_path)
            logger(f"[APPLY] {tool_tag} passthrough copy (no snapshot): {target}")
        return ToolResult(True, [(target, out_path, None)])
    except Exception as e:
        logger(f"[APPLY] [IBEX-ENGINE ERROR] {tool_tag} passthrough copy fallito: {e}")
        return ToolResult(False, [])


def _apply_split(ctx):
    """
    _apply_split (SnapshotKeyed Session 3, 2026-04-25): split multi-output per
    il tool `split_topology`. Cerca 2 file snapshot in active_path:
        {stem}_snap_{nodeId}_A.stl
        {stem}_snap_{nodeId}_B.stl
    dove:
        - stem   = basename(src_path) senza estensione
        - nodeId = params['_snapshot_node_id'] (whitelist regex)

    Se entrambi presenti → copia entrambi in output_dir, ritorna
    `(True, [(target_a, path_a), (target_b, path_b)])`. Il caller
    (`apply_tier1_queue`) aggiorna `current_stl` con i 2 nuovi target.

    Se uno o entrambi mancano → nodo inerte (non ancora eseguito dall'utente).
    Ritorna `(True, [])` — nessun nuovo target registrato in current_stl, i
    downstream dei port A/B cercheranno un target che non esiste → il worker
    solleva errore al prossimo step con `STL non trovato`. È il comportamento
    voluto: l'utente deve prima fare applySplit lato client.

    NOTA architetturale: diversamente da _apply_snapshot, questa funzione NON
    tocca `target` (il nome della mesh master). I 2 output hanno nomi distinti
    derivati da stem+nodeId+branch. Downstream del DAG puntano ai nuovi target
    via ToolExecutor.resolveBaseMesh esteso (S3-NA4).

    Return:
        ToolResult. success/outputs mappano i casi così:
          - inerte (nodeId assente/invalido · cut fallito · snapshot mancanti)
            → ToolResult(True, [])   → la pipeline CONTINUA, nessun target registrato
          - errore (modulo non caricabile · copy fallita · eccezione)
            → ToolResult(False, [])  → il bake abortisce
          - successo → ToolResult(True, [(target_a, path_a, None), (target_b, path_b, None)])
    """
    src_path, params, output_dir, target, logger, active_path, tool_id = (
        ctx.src_path, ctx.params, ctx.output_dir, ctx.target, ctx.logger,
        ctx.active_path, ctx.tool)

    node_id = params.get('_snapshot_node_id') if isinstance(params, dict) else None
    tool_tag = tool_id or 'split'

    if node_id is None or not validate_node_id(node_id):
        logger(f"[APPLY] {tool_tag}: _snapshot_node_id assente/invalido per {target}, "
               f"nodo inerte (nessun output generato)")
        return ToolResult(True, [])   # INERTE

    src_dir = active_path if active_path else os.path.dirname(src_path)
    stem = os.path.splitext(os.path.basename(src_path))[0]

    target_a = f"{stem}_snap_{node_id}_A.stl"
    target_b = f"{stem}_snap_{node_id}_B.stl"
    out_a = os.path.join(output_dir, target_a)
    out_b = os.path.join(output_dir, target_b)

    # ─────────────────────────────────────────────────────────────
    # V1.0 draw_curve dual-mode (2026-05-06):
    # Se ToolExecutor ha iniettato `_curve_input_file_rel` nei params (= filename
    # del `.crv.json` del nodo draw_curve upstream), il cut viene fatto via
    # algoritmo geodetico Dijkstra+flood-fill. Output: mesh A/B salvate
    # direttamente in active_path/{stem}_snap_{nodeId}_{A,B}.stl + copia in
    # output_dir per la pipeline. Non c'è applySplit lato client in modalità
    # curva — il worker GENERA i 2 file invece di leggerli.
    # ─────────────────────────────────────────────────────────────
    # Frontend ToolExecutor inietta `_curve_input_file_rel` come filename
    # relativo (es. "Upper_snap_5.crv.json"). Il worker concatena con
    # active_path per ottenere il path assoluto. Whitelist: solo nomi che
    # finiscono in `.crv.json` per evitare path traversal via il param.
    curve_input_rel = params.get('_curve_input_file_rel') if isinstance(params, dict) else None
    curve_input_file = None
    # B6 (2026-07-14): rimosso il dump incondizionato di param_keys/in_keys — sparava
    # a OGNI step di split. Il log qui sotto resta perché è CONDIZIONATO alla presenza
    # di una curva ed è l'unico modo di distinguere "curve cut" da "split inerte".
    if curve_input_rel and isinstance(curve_input_rel, str) and curve_input_rel.endswith('.crv.json') \
       and '/' not in curve_input_rel and '\\' not in curve_input_rel and active_path:
        curve_input_file = os.path.join(active_path, curve_input_rel)
        logger(f"[APPLY] {tool_tag} curve path: {curve_input_file} "
               f"exists={os.path.isfile(curve_input_file)}")
    if curve_input_file and os.path.isfile(curve_input_file):
        logger(f"[APPLY] {tool_tag} DUAL-MODE curve cut via {os.path.basename(curve_input_file)}")
        # Output finale in active_path (così serve_file lo trova al reload)
        # + copia in output_dir per la pipeline corrente.
        snap_a_active = os.path.join(active_path, target_a) if active_path else out_a
        snap_b_active = os.path.join(active_path, target_b) if active_path else out_b
        try:
            import importlib.util
            from .config import LOGIC_PY_DIR
            spec = importlib.util.spec_from_file_location(
                "ibex_split_via_curves",
                os.path.join(LOGIC_PY_DIR, "split_topology_via_curves.py"))
            if spec is None or spec.loader is None:
                logger(f"[APPLY] [IBEX-ENGINE ERROR] split_topology_via_curves.py non caricabile")
                return ToolResult(False, [])   # ERRORE
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            success = mod.apply(src_path, curve_input_file,
                                snap_a_active, snap_b_active, logger)
            if not success:
                logger(f"[APPLY] {tool_tag}: curve cut fallito → nodo inerte")
                return ToolResult(True, [])   # INERTE (graceful: pipeline continua, A/B non aggiunti)
            # Copia da active_path → output_dir per la pipeline (i target downstream
            # cercheranno via current_stl[target_a/b]).
            if active_path:
                shutil.copy2(snap_a_active, out_a)
                shutil.copy2(snap_b_active, out_b)
            logger(f"[APPLY] {tool_tag} curve cut OK: {target_a} + {target_b}")
            return ToolResult(True, [(target_a, out_a, None), (target_b, out_b, None)])
        except Exception as e:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] {tool_tag} curve cut: {e}")
            return ToolResult(False, [])   # ERRORE

    # ─────────────────────────────────────────────────────────────
    # Modalità classica (V1, 2026-04-25): brush selection lato client.
    # Cerca i 2 snapshot pre-esistenti in active_path.
    # ─────────────────────────────────────────────────────────────
    snap_a_src = os.path.join(src_dir, f"{stem}_snap_{node_id}_A.stl")
    snap_b_src = os.path.join(src_dir, f"{stem}_snap_{node_id}_B.stl")

    has_a = os.path.isfile(snap_a_src)
    has_b = os.path.isfile(snap_b_src)

    if has_a and has_b:
        try:
            shutil.copy2(snap_a_src, out_a)
            shutil.copy2(snap_b_src, out_b)
            logger(f"[APPLY] {tool_tag}: usati {target_a} + {target_b} per {target}")
            return ToolResult(True, [(target_a, out_a, None), (target_b, out_b, None)])
        except Exception as e:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] {tool_tag} copy fallito: {e}")
            return ToolResult(False, [])   # ERRORE

    # Uno o entrambi i file mancano — nodo inerte.
    logger(f"[APPLY] {tool_tag}: snapshot assenti (A={has_a}, B={has_b}) per nodeId={node_id}, "
           f"nodo inerte")
    return ToolResult(True, [])   # INERTE


def _apply_meshcleaner(ctx):
    """
    meshcleaner (V16.0 PyMeshLab): smoothing con boundary preservation + fascia
    transizione + hole filling via PyMeshLab 2025.7 in-process nel worker.

    Topologia cambia (smoothing + chiusura fori): mesh=None → il CALLER invalida
    mesh_cache[out_path] (BUGFIX B2) e il prossimo step ricarica lo STL da disco.
    L'handler NON tocca mesh_cache.

    Import dinamico di assets/logic_py/meshcleaner.py via importlib: il modulo
    espone `apply(src_path, params, output_path, logger) -> bool`.
    """
    src_path, params, output_dir, target, logger = (
        ctx.src_path, ctx.params, ctx.output_dir, ctx.target, ctx.logger)
    out_path = os.path.join(output_dir, target)
    try:
        import importlib.util
        from .config import LOGIC_PY_DIR
        spec = importlib.util.spec_from_file_location(
            "ibex_meshcleaner",
            os.path.join(LOGIC_PY_DIR, "meshcleaner.py"))
        if spec is None or spec.loader is None:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] meshcleaner.py non caricabile da {LOGIC_PY_DIR}")
            return ToolResult(False, [])
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if not hasattr(mod, 'apply'):
            logger("[APPLY] [IBEX-ENGINE ERROR] meshcleaner.py non espone apply(src,params,out,log)")
            return ToolResult(False, [])
        success = mod.apply(src_path, params, out_path, logger)
        if not success:
            return ToolResult(False, [])
        logger(f"[APPLY] meshcleaner OK: {target}")
        return ToolResult(True, [(target, out_path, None)])
    except Exception as e:
        logger(f"[APPLY] [IBEX-ENGINE ERROR] meshcleaner failure: {e}")
        return ToolResult(False, [])


def _apply_slice(ctx):
    """slice (FASE 1): taglio planare con cap via ibex_primitives.slice_plane.
    Import dinamico di assets/logic_py/slice.py; topologia cambia → mesh=None
    → il CALLER invalida mesh_cache[out_path] (BUGFIX B2)."""
    src_path, params, output_dir, target, logger = (
        ctx.src_path, ctx.params, ctx.output_dir, ctx.target, ctx.logger)
    out_path = os.path.join(output_dir, target)
    try:
        import importlib.util
        from .config import LOGIC_PY_DIR
        spec = importlib.util.spec_from_file_location(
            "ibex_slice", os.path.join(LOGIC_PY_DIR, "slice.py"))
        if spec is None or spec.loader is None:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] slice.py non caricabile da {LOGIC_PY_DIR}")
            return ToolResult(False, [])
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if not hasattr(mod, 'apply'):
            logger("[APPLY] [IBEX-ENGINE ERROR] slice.py non espone apply(src,params,out,log)")
            return ToolResult(False, [])
        success = mod.apply(src_path, params, out_path, logger)
        if not success:
            return ToolResult(False, [])
        logger(f"[APPLY] slice OK: {target}")
        return ToolResult(True, [(target, out_path, None)])
    except Exception as e:
        logger(f"[APPLY] [IBEX-ENGINE ERROR] slice failure: {e}")
        return ToolResult(False, [])


def _apply_draw_curve(ctx):
    """
    draw_curve (V1.0, 2026-05-06): nodo destructive Tier 1 che produce un
    datablock CURVA (`{stem}_snap_{nodeId}.crv.json`). La mesh in input è
    PASSATA THROUGH inalterata — il nodo non modifica la geometria, solo
    persiste il file della curva accanto allo snapshot mesh.

    Output socket: `OUT_CRV_Curve` (semantico, non geometrico). I consumer
    downstream (split_topology dual-mode) leggono il `.crv.json` da
    active_path per usarlo nel loro algoritmo.

    Pattern identico a sculpt/delete_topology nel worker:
      - cerca `{stem}_snap_{nodeId}.stl` (mesh) → se assente, passthrough master
      - il file `.crv.json` è cercato dai consumer SEPARATAMENTE, non qui
    """
    src_path, params, output_dir, target, logger, active_path = (
        ctx.src_path, ctx.params, ctx.output_dir, ctx.target, ctx.logger, ctx.active_path)
    out_path = os.path.join(output_dir, target)
    src_dir = active_path if active_path else os.path.dirname(src_path)
    stem = os.path.splitext(os.path.basename(src_path))[0]

    node_id = params.get('_snapshot_node_id') if isinstance(params, dict) else None
    if not node_id or not validate_node_id(node_id):
        logger(f"[APPLY] draw_curve passthrough (no node_id valido): {target}")
        try:
            if os.path.abspath(src_path) != os.path.abspath(out_path):
                shutil.copy2(src_path, out_path)
            return ToolResult(True, [(target, out_path, None)])
        except Exception as e:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] draw_curve passthrough: {e}")
            return ToolResult(False, [])

    snapshot_stl = os.path.join(src_dir, f"{stem}_snap_{node_id}.stl")
    snapshot_crv = os.path.join(src_dir, f"{stem}_snap_{node_id}.crv.json")
    has_stl = os.path.isfile(snapshot_stl)
    has_crv = os.path.isfile(snapshot_crv)

    # Stato del nodo (diagnostico)
    if has_stl and has_crv:
        logger(f"[APPLY] draw_curve: snapshot+curve OK per nodeId={node_id} ({target})")
    elif has_stl and not has_crv:
        logger(f"[APPLY] draw_curve: snapshot mesh OK ma curva ASSENTE "
               f"(nodeId={node_id}) — consumer downstream userà datablock vuoto")
    else:
        logger(f"[APPLY] draw_curve: nessuno snapshot per nodeId={node_id}, "
               f"passthrough master ({target})")

    # In ogni caso, la mesh output è la mesh input (no modifica).
    try:
        # Se c'è uno snapshot mesh, lo usiamo come output (preservazione di
        # eventuali Tier 1 upstream incorporati nel snapshot al save).
        # Altrimenti passthrough src_path.
        chosen_src = snapshot_stl if has_stl else src_path
        if os.path.abspath(chosen_src) != os.path.abspath(out_path):
            shutil.copy2(chosen_src, out_path)
        return ToolResult(True, [(target, out_path, None)])
    except Exception as e:
        logger(f"[APPLY] [IBEX-ENGINE ERROR] draw_curve copy fallita: {e}")
        return ToolResult(False, [])


def _apply_arch_detect(ctx):
    """
    arch_detect (V1.0, 2026-05-12): destructive Tier 1 auto-detection
    dell'arcata alveolare. Esegue attivamente la rilevazione (no passthrough
    puro): chiama assets/logic_py/arch_detect.py::apply che usa la cache
    condivisa .cache_pml per SDF + curvatura.

    Output:
      - STL: passthrough del master (la mesh NON viene modificata)
      - File `.crv.json`: scritto in active_path/{stem}_snap_{nodeId}.crv.json
        (stesso schema di draw_curve, consumabile da split_topology dual-mode
        o da nodi di visualizzazione/protesi futuri)

    A differenza di sculpt/delete_topology/draw_curve (snapshot keyed per nodeId
    che PROPAGA lo stato applyXxx del client), arch_detect è una computazione
    DETERMINISTICA sul master: ogni bake produce la stessa curva. Il file
    `.crv.json` è di fatto un cache dell'output algoritmico. Lo riteniamo
    "destructive" solo perché il file vive accanto agli altri snapshot keyed
    e segue lo stesso lifecycle (cleanup SAVE_EXIT regex `_snap_{nodeId}`).
    """
    src_path, params, output_dir, target, logger, active_path = (
        ctx.src_path, ctx.params, ctx.output_dir, ctx.target, ctx.logger, ctx.active_path)
    out_path = os.path.join(output_dir, target)
    src_dir = active_path if active_path else os.path.dirname(src_path)
    stem = os.path.splitext(os.path.basename(src_path))[0]

    node_id = params.get('_snapshot_node_id') if isinstance(params, dict) else None
    if not node_id or not validate_node_id(node_id):
        logger(f"[APPLY] arch_detect passthrough (no node_id valido): {target}")
        try:
            if os.path.abspath(src_path) != os.path.abspath(out_path):
                shutil.copy2(src_path, out_path)
            return ToolResult(True, [(target, out_path, None)])
        except Exception as e:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] arch_detect passthrough: {e}")
            return ToolResult(False, [])

    # Path del datablock CRV (snapshot keyed per nodeId)
    crv_out = os.path.join(src_dir, f"{stem}_snap_{node_id}.crv.json")
    crv_already_exists = os.path.isfile(crv_out)

    # === CACHE V1.8 (2026-05-12): params-aware ===
    # arch_detect è una funzione DETERMINISTICA del master mesh + params.
    # Cache invalida se:
    #   - params._z_offset_mm differisce dal cached value (in .crv.json metadata)
    #   - params._template differisce dal cached template_used
    #   - params._recompute_seq cresce (esplicit user "Ricalcola")
    # Tutti i 3 check usano arch_detect.py::_cache_is_valid che parsa il
    # .crv.json metadata. Il counter _recompute_seq resta come "kill switch"
    # forte (es. user vuole ricalcolare anche se params invariati).
    force_recompute = False
    if isinstance(params, dict) and crv_already_exists:
        requested_seq = params.get('_recompute_seq', 0)
        seq_file = os.path.join(src_dir, f"{stem}_snap_{node_id}.recompute_seq")
        last_seq = 0
        try:
            if os.path.isfile(seq_file):
                with open(seq_file) as f:
                    last_seq = int(f.read().strip() or 0)
        except Exception:
            last_seq = 0
        try:
            requested_seq_int = int(requested_seq)
        except Exception:
            requested_seq_int = 0
        if requested_seq_int > last_seq:
            force_recompute = True
            logger(f"[APPLY] arch_detect: force recompute requested "
                   f"(_recompute_seq {last_seq} → {requested_seq_int})")

    # Cache check params-aware (chiama helper module-level di arch_detect.py)
    cache_valid = False
    if crv_already_exists and not force_recompute:
        try:
            import importlib.util as _ilu
            from . import config as _cfg
            arch_path = os.path.join(_cfg.LOGIC_PY_DIR, 'arch_detect.py')
            spec = _ilu.spec_from_file_location("arch_detect_mod", arch_path)
            mod = _ilu.module_from_spec(spec)
            spec.loader.exec_module(mod)
            req_z = float(params.get('_z_offset_mm', mod.DEFAULT_Z_OFFSET_MM))
            req_tmpl = params.get('_template', mod.DEFAULT_TEMPLATE)
            # V2.1: pass i 3 nuovi tunables al cache check
            req_adh = params.get('_adherence_pct', None)
            req_smo = params.get('_smoothness_sigma', None)
            req_trm = params.get('_trim_end_frac', None)
            # V2.3: rettifica estremi via Z-slope (sostituisce V2.2 knee_z_drop_mm)
            req_ext = params.get('_extension_mm', None)
            req_knee_slope = params.get('_knee_slope_threshold', None)
            cache_valid = mod._cache_is_valid(crv_out, req_z, req_tmpl,
                                              requested_adherence_pct=req_adh,
                                              requested_smoothness=req_smo,
                                              requested_trim_frac=req_trm,
                                              requested_extension_mm=req_ext,
                                              requested_knee_slope=req_knee_slope)
        except Exception as e:
            logger(f"[APPLY] arch_detect: cache check failed ({e}), recompute")
            cache_valid = False

    if cache_valid:
        try:
            logger(f"[APPLY] arch_detect: CACHE HIT params-match "
                   f"(.crv.json valido per nodeId={node_id}), skip compute")
            if os.path.abspath(src_path) != os.path.abspath(out_path):
                shutil.copy2(src_path, out_path)
            return ToolResult(True, [(target, out_path, None)])
        except Exception as e:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] arch_detect cache hit fallita: {e}")
            return ToolResult(False, [])

    # === CACHE MISS: invoca arch_detect.apply ===
    try:
        import importlib.util
        from . import config as _cfg
        arch_path = os.path.join(_cfg.LOGIC_PY_DIR, 'arch_detect.py')
        if not os.path.isfile(arch_path):
            logger(f"[APPLY] [IBEX-ENGINE ERROR] arch_detect.py non trovato in "
                   f"{_cfg.LOGIC_PY_DIR}")
            return ToolResult(False, [])
        spec = importlib.util.spec_from_file_location("arch_detect_mod", arch_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if not hasattr(mod, 'apply'):
            logger("[APPLY] [IBEX-ENGINE ERROR] arch_detect.py non espone apply()")
            return ToolResult(False, [])

        # Cache .cache_pml condivisa (V1.0 2026-05-12 — Inv. 118 nuova)
        cache_pml_dir = (os.path.join(active_path, '.cache_pml')
                        if active_path else None)

        success = mod.apply(
            src_mesh_path=src_path,
            params=params if isinstance(params, dict) else {},
            output_path=out_path,   # passthrough STL viene scritto qui
            crv_output_path=crv_out,
            logger=logger,
            cache_dir=cache_pml_dir,
        )
        if not success:
            return ToolResult(False, [])
        logger(f"[APPLY] arch_detect OK: {os.path.basename(crv_out)}")
        # V1.1: salva _recompute_seq corrente accanto al .crv.json per il
        # prossimo bake (cache HIT finché user non clicca "Ricalcola").
        try:
            if isinstance(params, dict):
                requested_seq = int(params.get('_recompute_seq', 0) or 0)
                seq_file = os.path.join(src_dir, f"{stem}_snap_{node_id}.recompute_seq")
                with open(seq_file, 'w') as f:
                    f.write(str(requested_seq))
        except Exception as e:
            logger(f"[APPLY] arch_detect: warning save recompute_seq ({e})")
        return ToolResult(True, [(target, out_path, None)])
    except Exception as e:
        logger(f"[APPLY] [IBEX-ENGINE ERROR] arch_detect.apply fallita: {e}")
        return ToolResult(False, [])


def _apply_curve_edit(ctx):
    """
    curve_edit (V1.0, 2026-05-12): destructive Tier 1 — editor curva.
    Input: mesh (per snap durante edit client-side) + curva upstream (.crv.json).
    Output: nuova curva .crv.json keyed per nodeId del curve_edit + mesh
    passthrough invariata.

    Comportamento:
      - SE existe `{stem}_snap_{nodeId}.crv.json` (l'utente ha già editato
        e cliccato "Conferma") → usa la versione editata
      - ALTRIMENTI (primo render, nessun edit ancora) → copia la curva
        upstream a `{stem}_snap_{nodeId}.crv.json` per default (passthrough)

    Curva upstream individuata via params._curve_input_file_rel iniettato da
    ToolExecutor (stesso pattern di split_topology_via_curves):
      - relativa ad active_path
      - whitelist endswith('.crv.json') + no path separator

    Mesh: SEMPRE passthrough (return src_path, no copy → Tier C swap opera
    sul mesh post-pipeline upstream invariato).
    """
    src_path, params, output_dir, target, logger, active_path = (
        ctx.src_path, ctx.params, ctx.output_dir, ctx.target, ctx.logger, ctx.active_path)
    out_path = os.path.join(output_dir, target)
    src_dir = active_path if active_path else os.path.dirname(src_path)
    stem = os.path.splitext(os.path.basename(src_path))[0]

    node_id = params.get('_snapshot_node_id') if isinstance(params, dict) else None
    if not node_id or not validate_node_id(node_id):
        logger(f"[APPLY] curve_edit passthrough (no node_id valido): {target}")
        try:
            if os.path.abspath(src_path) != os.path.abspath(out_path):
                shutil.copy2(src_path, out_path)
            return ToolResult(True, [(target, out_path, None)])
        except Exception as e:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] curve_edit passthrough: {e}")
            return ToolResult(False, [])

    my_crv = os.path.join(src_dir, f"{stem}_snap_{node_id}.crv.json")
    my_crv_exists = os.path.isfile(my_crv)

    # V1.3 (2026-05-13): distingui "salvato dall'utente" da "copia stale upstream".
    # SnapshotPersist.saveCurve scrive `metadata.user_edited: true` solo quando
    # l'utente clicca "Salva e esci" in CurveEditMode. Una copia automatica
    # da upstream (primo bake post-collegamento) NON ha questo flag — eredita
    # `metadata.tool == 'arch_detect'` o simile.
    # Senza questo check, modifiche a slider di arch_detect non si propagavano
    # a curve_edit (forma stale persiste indefinitamente).
    is_user_edited = False
    if my_crv_exists:
        try:
            with open(my_crv, 'r', encoding='utf-8') as f:
                _data = json.load(f)
            is_user_edited = bool(_data.get('metadata', {}).get('user_edited', False))
        except Exception:
            is_user_edited = False

    if my_crv_exists and is_user_edited:
        logger(f"[APPLY] curve_edit: usa versione editata utente "
               f"({stem}_snap_{node_id}.crv.json, metadata.user_edited=True)")
    else:
        # Ricopia upstream — sia "primo bake" che "rinfresca copia stale post
        # modifica arch_detect upstream".
        upstream_rel = params.get('_curve_input_file_rel') if isinstance(params, dict) else None
        if upstream_rel and isinstance(upstream_rel, str) \
                and upstream_rel.endswith('.crv.json') \
                and '/' not in upstream_rel and '\\' not in upstream_rel:
            upstream_crv = os.path.join(src_dir, upstream_rel)
            if os.path.isfile(upstream_crv):
                try:
                    shutil.copy2(upstream_crv, my_crv)
                    reason = "primo bake" if not my_crv_exists else "refresh copia stale (user_edited=False)"
                    logger(f"[APPLY] curve_edit: {reason}, "
                           f"copio upstream {upstream_rel} → {os.path.basename(my_crv)}")
                except Exception as e:
                    logger(f"[APPLY] [IBEX-ENGINE ERROR] curve_edit copy upstream: {e}")
                    return ToolResult(False, [])
            else:
                logger(f"[APPLY] curve_edit: upstream curve assente "
                       f"({upstream_rel}) — output sarà vuoto")
        else:
            logger(f"[APPLY] curve_edit: nessun _curve_input_file_rel valido "
                   f"({upstream_rel!r}) — output sarà vuoto")

    # Mesh passthrough: nessun copy verso output_dir (Tier C swap operera
    # sull'output del passo precedente nella pipeline, già in output_dir).
    # Se è il primo step (src=master), copia per garantire che output_dir/target esista.
    try:
        if os.path.abspath(src_path) != os.path.abspath(out_path):
            shutil.copy2(src_path, out_path)
        return ToolResult(True, [(target, out_path, None)])
    except Exception as e:
        logger(f"[APPLY] [IBEX-ENGINE ERROR] curve_edit passthrough mesh: {e}")
        return ToolResult(False, [])


def _apply_topology_rebuild(ctx):
    """
    topology_rebuild (V1.0 SingleSelect, 2026-05-05): destructive Tier 1 con
    selezione utente. Diversamente da _apply_snapshot (passthrough puro), questo
    handler ESEGUE attivamente la rebuild via bmesh in-process.

    Cerca DUE file in active_path:
      - {stem}_snap_{nodeId}.stl       — mesh modificata (output Tier 1 upstream)
      - {stem}_snap_{nodeId}.sel.json  — face indices della selezione utente

    Se entrambi presenti → delega a assets/logic_py/topology_rebuild.py::apply
    Se mancano (nodo appena aggiunto, no applyRebuild ancora) → passthrough master.
    Se rebuild fallisce (combinazione non gestita, loop incompleti, bmesh error)
    → passthrough master + log warning (non rompe la pipeline downstream).

    Topologia cambia (close_hole o bridge → nuove face): mesh=None → il CALLER
    invalida mesh_cache[out_path] (BUGFIX B2) e il prossimo step ricarica da disco.
    """
    src_path, params, output_dir, target, logger, active_path = (
        ctx.src_path, ctx.params, ctx.output_dir, ctx.target, ctx.logger, ctx.active_path)
    # Diagnostic IN log (verbose V1.0): aiuta a tracciare il flow quando
    # l'utente collega il nodo per la prima volta o segnala errori.
    logger(f"[APPLY] topology_rebuild IN: src={src_path} target={target} "
           f"out_dir={output_dir} active={active_path}")

    out_path = os.path.join(output_dir, target)
    src_dir = active_path if active_path else os.path.dirname(src_path)
    stem = os.path.splitext(os.path.basename(src_path))[0]

    node_id = params.get('_snapshot_node_id') if isinstance(params, dict) else None
    if not node_id or not validate_node_id(node_id):
        # No nodeId → nodo legacy o invalido → passthrough master
        logger(f"[APPLY] topology_rebuild passthrough (no node_id valido): {target} "
               f"(node_id={node_id!r})")
        try:
            if os.path.abspath(src_path) != os.path.abspath(out_path):
                shutil.copy2(src_path, out_path)
            return ToolResult(True, [(target, out_path, None)])
        except Exception as e:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] topology_rebuild passthrough: {e}")
            return ToolResult(False, [])

    snapshot_stl = os.path.join(src_dir, f"{stem}_snap_{node_id}.stl")
    snapshot_sel = os.path.join(src_dir, f"{stem}_snap_{node_id}.sel.json")

    has_stl = os.path.isfile(snapshot_stl)
    has_sel = os.path.isfile(snapshot_sel)

    if not has_stl or not has_sel:
        # Nodo aggiunto ma applyRebuild non ancora fatto → passthrough master
        logger(f"[APPLY] topology_rebuild passthrough (snapshot.stl={has_stl}, "
               f"snapshot.sel={has_sel}): {target}")
        try:
            if not os.path.isfile(src_path):
                logger(f"[APPLY] [IBEX-ENGINE ERROR] topology_rebuild passthrough: "
                       f"src non esiste: {src_path}")
                return ToolResult(False, [])
            if os.path.abspath(src_path) != os.path.abspath(out_path):
                # B7 (2026-07-14): rimosso `if not os.path.isdir(output_dir): makedirs(...)`
                # — irraggiungibile: apply_tier1_queue fa già os.makedirs(output_dir)
                # prima di iterare la queue.
                shutil.copy2(src_path, out_path)
                logger(f"[APPLY] topology_rebuild passthrough copy: "
                       f"{src_path} → {out_path}")
            else:
                logger(f"[APPLY] topology_rebuild passthrough in-place: {target}")
            return ToolResult(True, [(target, out_path, None)])
        except Exception as e:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] topology_rebuild passthrough exception: {e}")
            logger(f"[APPLY] traceback: {traceback.format_exc()}")
            return ToolResult(False, [])

    # Entrambi i file presenti → carica modulo logic_py + chiama apply()
    try:
        import importlib.util
        from .config import LOGIC_PY_DIR
        spec = importlib.util.spec_from_file_location(
            "ibex_topology_rebuild",
            os.path.join(LOGIC_PY_DIR, "topology_rebuild.py"))
        if spec is None or spec.loader is None:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] topology_rebuild.py non caricabile "
                   f"da {LOGIC_PY_DIR}")
            return ToolResult(False, [])
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if not hasattr(mod, 'apply'):
            logger("[APPLY] [IBEX-ENGINE ERROR] topology_rebuild.py non espone "
                   "apply(src, sel, out, logger)")
            return ToolResult(False, [])
        success = mod.apply(snapshot_stl, snapshot_sel, out_path, logger)
        if not success:
            # Fail graceful: passthrough la mesh snapshot così l'utente non perde
            # tool upstream (il warning già loggato dal modulo).
            logger(f"[APPLY] topology_rebuild fail → passthrough snapshot: {target}")
            try:
                shutil.copy2(snapshot_stl, out_path)
                return ToolResult(True, [(target, out_path, None)])
            except Exception as e:
                logger(f"[APPLY] [IBEX-ENGINE ERROR] topology_rebuild fallback copy: {e}")
                return ToolResult(False, [])
        logger(f"[APPLY] topology_rebuild OK: {target}")
        return ToolResult(True, [(target, out_path, None)])
    except Exception as e:
        logger(f"[APPLY] [IBEX-ENGINE ERROR] topology_rebuild failure: {e}")
        return ToolResult(False, [])


def _apply_modelgenerator(ctx):
    """
    modelgenerator (V4.0 OpenSDF, 2026-05-01): genera lo base del modello
    dentale estrudendo il boundary aperto della scansione + shell cava SDF
    (G3>0) via Open3D Embree.

    Topologia cambia (nuovi vert + face per base): out_mesh=None → il CALLER invalida
    mesh_cache[out_path] (BUGFIX B2) e il prossimo step ricarica lo STL da disco.

    Import dinamico di assets/logic_py/modelgenerator.py via importlib: il modulo
    espone `apply(src_path, params, output_path, logger) -> bool`.

    Ciclo-vita 2026-07-13 (Legge 1) — cache SDF PER-PROGETTO: questa funzione
    inietta `params['_sdf_cache_dir'] = {active_path}/sdf` e modelgenerator
    salva/rilegge lì i `.npz` (nel .ibex al save, morti col purge alla
    chiusura). La cache globale env IBEX_SDF_CACHE_GLOBAL (V4.0) è RIMOSSA.
    """
    src_path, params, output_dir, target, logger, active_path = (
        ctx.src_path, ctx.params, ctx.output_dir, ctx.target, ctx.logger, ctx.active_path)
    out_path = os.path.join(output_dir, target)
    try:
        import importlib.util
        from .config import LOGIC_PY_DIR
        spec = importlib.util.spec_from_file_location(
            "ibex_modelgenerator",
            os.path.join(LOGIC_PY_DIR, "modelgenerator.py"))
        if spec is None or spec.loader is None:
            logger(f"[APPLY] [IBEX-ENGINE ERROR] modelgenerator.py non caricabile da {LOGIC_PY_DIR}")
            return ToolResult(False, [])
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if not hasattr(mod, 'apply'):
            logger("[APPLY] [IBEX-ENGINE ERROR] modelgenerator.py non espone apply(src,params,out,log)")
            return ToolResult(False, [])

        # Ciclo-vita 2026-07-13 (Legge 1): cache SDF PER-PROGETTO in
        # active_path/sdf/ — entra nel .ibex, muore col purge. Copia difensiva
        # di params (niente side-effect sul dict della queue); chiave interna
        # esclusa dal cache_key via pipeline_cache._INTERNAL_PARAM_KEYS.
        if active_path:
            params = dict(params)
            params['_sdf_cache_dir'] = os.path.join(active_path, 'sdf')
        success = mod.apply(src_path, params, out_path, logger)
        if not success:
            return ToolResult(False, [])
        logger(f"[APPLY] modelgenerator OK: {target}")
        return ToolResult(True, [(target, out_path, None)])
    except Exception as e:
        logger(f"[APPLY] [IBEX-ENGINE ERROR] modelgenerator failure: {e}")
        return ToolResult(False, [])
