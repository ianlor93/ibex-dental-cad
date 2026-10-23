"""
fast_transform — fondamenta Tier 1 (no Blender).

FASE 2-4 (2026-07-20): lo scorporo del refactor Tier 1 è chiuso. Questo modulo
NON è più l'orchestratore: è la FOGLIA su cui poggiano gli altri due moduli Tier 1.

Contiene, e SOLO questo:
  · l'ABI degli handler — `ToolContext` / `ToolResult` (importati sia da
    tier1_handlers che da tier1_orchestrator: vivono qui perché metterli
    altrove creerebbe un ciclo handlers ↔ orchestrator);
  · i due loader condivisi — `_load_matrix` / `_load_mesh`;
  · l'unico handler che resta qui, `_apply_transform` (il tool `fast_transform`
    vero e proprio: rotazione/traslazione rigida via world matrix 4x4).

Dove sono finiti gli altri pezzi:
  · gli altri 10 handler `_apply_*` (parenting, snapshot, split, meshcleaner,
    slice, draw_curve, arch_detect, curve_edit, topology_rebuild, modelgenerator)
    → `tier1_handlers.py`;
  · `apply_tier1_queue` + la tabella di dispatch `DISPATCH`
    → `tier1_orchestrator.py` (è il modulo che `worker.py` importa).

Invariante critica (fast_transform il TOOL):
  La matrice world arriva già completa dal frontend (buildPivotedMatrix).
  Questo modulo NON ricostruisce SRT né applica pivot compensation.
  Applica semplicemente: mesh.apply_transform(matrix_4x4)
"""

import os
import numpy as np
from dataclasses import dataclass
from typing import Callable, Any

try:
    import trimesh
    TRIMESH_AVAILABLE = True
except ImportError:
    TRIMESH_AVAILABLE = False


def _load_matrix(params, key, logger):
    """Legge una matrice 4×4 row-major dal parametro params[key]."""
    raw = params.get(key)
    if raw is None or not isinstance(raw, (list, tuple)) or len(raw) != 16:
        logger(f"[APPLY] [IBEX-ENGINE ERROR] matrice '{key}' assente o malformata: {raw}")
        return None
    return np.array(raw, dtype=np.float64).reshape(4, 4)


def _load_mesh(src_path, logger, mesh_cache):
    """Carica una mesh da disco o dalla cache in-task."""
    if src_path in mesh_cache:
        return mesh_cache[src_path].copy()
    try:
        return trimesh.load(src_path, force='mesh', process=False)
    except Exception as e:
        logger(f"[APPLY] [IBEX-ENGINE ERROR] caricamento STL '{src_path}' fallito: {e}")
        return None


# ============================================================================
# ABI unificata degli handler Tier 1 (FASE 1, 2026-07-14).
#
# Prima: 10 handler con 4 firme diverse (standard / +active_path / +tool_id /
# multi-output) + un contratto di ritorno che variava (tupla a 3 vs tupla a 2).
# Impossibile costruirci sopra un dispatch a tabella. Ora: un solo contratto,
# `_apply_x(ctx: ToolContext) -> ToolResult`.
# ============================================================================

@dataclass
class ToolContext:
    """Input di un handler. Immutabile PER CONVENZIONE (nessuno muta i campi)."""
    src_path: str           # STL sorgente già risolto dal caller (current_stl[target] o active/target)
    params: dict            # step['params']. READ-ONLY: copiare con dict(ctx.params) PRIMA di mutare
                            #   (unico mutatore: _apply_modelgenerator inietta _sdf_cache_dir su una copia)
    output_dir: str         # dir di scrittura. Garantito != active_path (guard in apply_tier1_queue)
    target: str             # nome mesh corrente = chiave di current_stl. Per split è il MASTER (non A/B)
    active_path: str        # radice progetto: master + collaterali (snap A/B, .crv.json, .sel.json, ...)
    tool: str               # step['tool']. Solo tag diagnostico. Sempre non vuoto quando un handler gira
    logger: Callable        # callable di logging
    mesh_cache: dict        # cache in-task path->trimesh. ⚠️ READ-ONLY PER GLI HANDLER:
                            #   solo _load_mesh LEGGE (transform/parenting). La scrittura e
                            #   l'invalidazione (BUGFIX B2) sono ESCLUSIVE del caller. Un handler
                            #   non deve mai scrivere né poppare qui.

    # NB DELIBERATO: node_id NON è un campo. Ogni handler lo estrae da ctx.params con
    # la PROPRIA policy — _apply_snapshot usa `is None` (3 stati: None=legacy,
    # valido=keyed, ''/invalido=passthrough-con-rifiuto anti-traversal), gli altri
    # usano `not node_id`. Centralizzarlo qui, con un `raw or None` o uno `.strip()`,
    # collasserebbe `None` e `''` e attiverebbe il ramo legacy quando non deve (rischio
    # sicurezza). Vietato hoistarlo. (Decisione Lorenzo, 2026-07-14.)


@dataclass
class ToolResult:
    """Output di un handler. Il control-flow del caller usa SOLO `success` e `outputs`."""
    success: bool           # UNICO discriminante fatale. False → il bake abortisce (return False).
    outputs: list           # list[tuple[str, str, Any]] = [(target, path, mesh_or_None), ...]
                            #   · vuota + success=True   → INERTE (pipeline continua, niente registrato)
                            #   · vuota + success=False   → ERRORE (bake abortisce)
                            #   · mesh != None → il caller fa mesh_cache[path] = mesh (topologia invariata)
                            #   · mesh == None → il caller fa mesh_cache.pop(path)  (invariante B2)
                            #   Il `target` della tupla è la CHIAVE per current_stl: per i single-output
                            #   è ctx.target (NON basename(src_path): coincidono oggi, ma il contratto
                            #   fissa ctx.target); per split sono i 2 nomi A/B, mai derivati dal caller.

    # NIENTE campo `inert`: INERT è DERIVATO (`success and not outputs`), non memorizzato.
    # Un campo separato sarebbe un 2° discriminante che può contraddire `success` — ed è
    # esattamente così che un migratore distratto riaprirebbe il rischio n.1 del piano
    # (inerte mappato su success=False → nodo split fresco fa fallire il bake).
    # NIENTE campo `mesh` scalare: la mesh vive DENTRO ogni tupla → zero aliasing su multi-output.

    @property
    def is_inert(self):
        """Solo diagnostica/log. Il caller NON deve MAI ramificare su questa proprietà."""
        return self.success and not self.outputs


def _apply_transform(ctx):
    """
    fast_transform: applica la world matrix (con pivot compensation) alla mesh.
    La matrice è in params['world_matrix'] (flat 16 float, row-major).
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

    logger(f"[APPLY] transform OK: {target}")
    return ToolResult(True, [(target, out_path, mesh)])
