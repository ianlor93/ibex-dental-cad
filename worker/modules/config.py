import os
import re

# --- PATH CONFIGURATION ---
CLOUD_BASE = "/data/nextcloud-storage"
ACTIVE_BASE = "/appdata/ibex/active"
ASSETS_BASE = "/appdata/ibex/assets"

# Asset Subdirectories
LOGIC_PY_DIR = os.path.join(ASSETS_BASE, "logic_py")
LOGIC_GN_DIR = os.path.join(ASSETS_BASE, "logic_gn")
LIBRARIES_DIR = os.path.join(ASSETS_BASE, "libraries") # Nuova cartella per Denti/Impianti

# Binary Paths
BLENDER_PATH = "/usr/local/blender/blender"

# --- DATABASE CONFIG: RIMOSSA (de-DB 2026-07-20) ---
# Il worker non accede più alla tabella progetti. L'identità è su Redis
# (ProjectRegistry / ibex:* keys), la verità durevole nel .ibex/manifest.
# Le env DB_* restano nel compose finché il PHP le usa per le ALTRE tabelle
# (oc_filecache/oc_storages/oc_enamel_studios).

# --- REDIS CONFIG ---
REDIS_HOST = os.environ.get('REDIS_HOST', 'ibex-redis')
REDIS_PORT = 6379
REDIS_PASS = os.getenv('IBEX_REDIS_PASS') or None  # auth ibex-redis (2026-06-14); None se env assente

# --- PERMISSIONS (www-data) ---
USER_UID = 33
USER_GID = 33

# --- TIER 1 TOOLS (fast path: Trimesh/PyMeshLab, no Blender subprocess) ---
# Questi tool bypassano il subprocess Blender e sono orchestrati da
# worker/modules/fast_transform.py. fast_transform/fast_parenting applicano
# matrici rigide via Trimesh; sculpt + delete_topology + split_topology sono
# passthrough su {stem}_snap_{nodeId}.stl (o _snap_{nodeId}_{A,B}.stl per split);
# meshcleaner (V16.0) usa PyMeshLab in-process.
TIER1_TOOLS = {
    'transform', 'parent',
    'sculpt', 'meshcleaner', 'delete_topology', 'split_topology',
    'modelgenerator',
    'topology_rebuild',
    'draw_curve',
    'arch_detect',
    'curve_edit',
    'slice',
}

# --- DESTRUCTIVE TOOLS (SnapshotKeyed Sessions 1-3, 2026-04-23/24/25) ---
# Tool che producono uno snapshot della mesh, identificato per nodeId.
# File snapshot:
#   - Single-output (sculpt, delete_topology): {stem}_snap_{nodeId}.stl
#   - Multi-output  (split_topology):          {stem}_snap_{nodeId}_A.stl
#                                              {stem}_snap_{nodeId}_B.stl
# Tutti in active_path (scanner-space). Se il nodo viene rimosso dal DAG, il
# pipeline torna al master; lazy cleanup dei file orfani al SAVE_EXIT via task
# `snapshot_nodes: [{mesh, nodeId}]` — la regex del cleanup matcha sia il
# pattern _snap_{nodeId} sia _snap_{nodeId}_[AB] (S3-NA7 opzione c).
# Set PARALLELO a TIER1_TOOLS — un tool destructive può essere o meno Tier 1.
# Usato da:
#   - worker.py SAVE_EXIT cleanup
#   - fast_transform.py apply_tier1_queue dispatch (split ha branch dedicato;
#     sculpt/delete_topology route a _apply_snapshot via catch-all)
#   - (frontend speculare: assets/logic_gn/gn_meta.json `destructive: true` +
#      StackManager._migrateLegacyToolIds DESTRUCTIVE_TOOL_IDS backfill)
DESTRUCTIVE_TOOLS = {'sculpt', 'delete_topology', 'split_topology', 'topology_rebuild', 'draw_curve',
                     'arch_detect', 'curve_edit'}

# --- NO-BACKEND TOOLS (B9, 2026-07-14) ---
# Nodi che vivono SOLO nella UI e non hanno alcun compute lato worker.
#   export_stl → apre il picker Nextcloud; lo STL è scritto da PHP
#                (EditorController::exportNodeStl), non dalla pipeline.
#
# Il frontend li esclude già dalla queue (ToolExecutor.js:497, StackManager.js:1490),
# MA BAKE_PROJECT non riflatta il grafo: legge la `stack` PERSISTITA
# (EditorController.php:866). Una stack salvata prima che la guardia client
# esistesse (pre 2026-05-03) contiene ancora export_stl → arriverebbe al worker →
# non è in TIER1_TOOLS → finisce in tier2_queue → LogicBuilder._gen_unknown_tool →
# [IBEX-ENGINE ERROR] → bake fallito. Difesa in profondità: il worker li scarta.
#
# ⚠️ La lista è una WHITELIST ESPLICITA, non un "salta ciò che non conosci":
# un tool DAVVERO sconosciuto deve continuare a fallire rumorosamente (Inv. 45).
NO_BACKEND_TOOLS = {'burn'}

# --- RENAME nomi tool (2026-07-21, perimetro ristretto) ---
# «fast» marcava Tier1-vs-Tier2 (Tier2 vuoto) = bugia storica; burn = consegna
# del file all'utente (vs bake = calcolo server-side). MAPPA UNICA vecchio→nuovo: applicata
# al queue-ingress in worker._strip_no_backend (PRIMA del tier-split). È l'UNICO
# punto dove i nomi vecchi sopravvivono (grafi legacy) → il grep-zero la esclude.
_TOOL_RENAME = {'fast_transform': 'transform', 'fast_parenting': 'parent', 'export_stl': 'burn'}



# --- WHITELIST nodeId / toolId (E2, 2026-07-14) — SEDE UNICA ---
# Il nodeId arriva dal CLIENT e finisce dentro un nome di file:
#     active/{uid}/{pid}/{stem}_snap_{nodeId}.stl
# È quindi una GUARDIA DI SICUREZZA: senza, un nodeId come "../../../etc/passwd"
# uscirebbe dalla sandbox del progetto (Inv. 81).
#
# Prima di oggi la stessa regex era compilata in 5 posti: fast_transform.py (1×,
# 6 call site) e worker.py (4×, dentro SAVE_SNAPSHOT e SAVE_SPLIT). Cinque copie
# di una guardia di sicurezza sono cinque occasioni di divergere.
#
# ⚠️ `fullmatch`, NON `$`. In Python (e in PHP) `$` NON significa "fine stringa":
# significa "fine stringa OPPURE subito prima di un a-capo finale". Con il vecchio
# `re.match(r'^[a-zA-Z0-9_\-]+$', nid)` il valore "5\n" PASSAVA la whitelist e
# produceva un file `Upper_snap_5\n.stl` — con un a-capo nel nome, che il cleanup
# degli snapshot orfani al SAVE_EXIT può non riconoscere. `fullmatch` esige che
# l'INTERA stringa sia consumata: niente a-capo, niente sorprese.
#
# ⚠️ SINCRONIZZAZIONE A 3 SEDI (Inv. 81) — questa NON è l'unica copia nel sistema:
#   · qui                                  → worker (Python)
#   · EditorController.php:257 e :489      → HTTP (PHP)  ⚠️ ha ancora il bug del `$`:
#                                             `preg_match('/^[A-Za-z0-9_\-]+$/')`
#                                             accetta l'a-capo finale. Serve il
#                                             modificatore `D` (o `\z`). NON ancora fixato.
#   · frontend                             → genera i nodeId (Drawflow: interi)
# Cambiare il pattern qui SENZA allineare PHP crea un buco o un falso rifiuto.
NODE_ID_RX = re.compile(r'[A-Za-z0-9_\-]+')


def validate_node_id(nid):
    """True se `nid` è un identificativo di nodo/tool sicuro da usare in un path.

    Usata sia per node_id (che finisce nel nome del file snapshot) sia per tool_id
    (solo diagnostico, ma validato per difesa in profondità).
    """
    return isinstance(nid, str) and NODE_ID_RX.fullmatch(nid) is not None