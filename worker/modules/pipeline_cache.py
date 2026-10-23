"""
pipeline_cache — memoization degli step intermedi della pipeline Tier 1.

Estratto da fast_transform.py il 2026-07-14 (scorporo E1). Contiene SOLO la
logica di cache: identità di uno step (hash del contenuto + chiave di cache) e
validazione delle entry. Non conosce la queue, il DAG, i tool né la geometria.

--- Come funziona (Tier C Fase 1, 2026-04-30) ---
Solo per i tool computazionalmente costosi (CACHEABLE_TOOLS: meshcleaner ~3s,
modelgenerator ~25s). Skip per i tool rapidi (fast_transform/parenting ~1s) e per
i destructive (sono copy passthrough, costo I/O bassissimo).

  cache key = SHA1(target + tool + params filtrati + input_hash)
  lookup    = cache_dir/{safe_target}/{cache_key}.stl
  HIT       → copia diretta, skip compute
  MISS      → esegui + salva (scrittura atomica, vedi BUGFIX B4 nel caller)

GC implicita: ogni run rimuove i file di cache del target NON referenziati
(mantiene solo gli step "live" della pipeline corrente). Cleanup esplicito al
SAVE_EXIT (worker.py). La GC vive nel caller perché dipende dallo stato della
queue (used_cache_keys), non da questo modulo.

⚠️ IMPORT STATICO OBBLIGATORIO.
Questo modulo va importato con `from .pipeline_cache import ...`, MAI via
importlib.spec_from_file_location: `_HASH_CACHE` è stato process-local e vive
per tutta la vita del worker. Un import dinamico lo ricreerebbe vuoto ad ogni
task, e ogni step ri-hasherebbe da capo ogni STL (Inv. 103).
"""

import os
import json
import hashlib

# Tool per cui vale la pena memoizzare. Gli altri costano meno del lookup.
CACHEABLE_TOOLS = {'meshcleaner', 'modelgenerator'}

# Chiavi escluse dal cache_key (puntatori/iniezioni, non valori UI):
# - world_matrix     : ricostruita ogni call, usata solo da fast_transform/parenting
#                      (che non sono cacheable comunque)
# - _snapshot_node_id: per i destructive, non cacheable comunque
# - _sdf_cache_dir   : path della cache SDF per-progetto, iniettato dal worker (2026-07-13)
# Le chiavi che iniziano con 'IN_' (cavi del grafo) sono filtrate per prefisso.
_INTERNAL_PARAM_KEYS = {'world_matrix', '_snapshot_node_id', '_sdf_cache_dir'}

# Cache process-local dell'hash MD5 degli STL, keyed su (path, mtime, size).
# Evita di ri-hashare un file invariato ad ogni lookup. Cap a 500 entry con
# eviction FIFO approssimata (non LRU — sufficiente per l'uso tipico del worker).
_HASH_CACHE = {}
_HASH_CACHE_CAP = 500


def compute_input_hash(path):
    """MD5 abbreviato (16 char) del contenuto di uno STL. Memo su (path, mtime, size).

    Ritorna None se il file non esiste o su errore I/O: il caller salta il lookup
    di cache quando riceve None (fallback al compute normale dello step).
    """
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (path, st.st_mtime, st.st_size)
    if key in _HASH_CACHE:
        return _HASH_CACHE[key]
    try:
        with open(path, 'rb') as f:
            h = hashlib.md5(f.read()).hexdigest()[:16]
    except Exception:
        return None
    _HASH_CACHE[key] = h
    # Cap dimensione cache (evita memory leak sul worker long-running)
    if len(_HASH_CACHE) > _HASH_CACHE_CAP:
        # FIFO approssimata: butta le 100 entry più vecchie (insertion order, Py3.7+)
        for old_key in list(_HASH_CACHE.keys())[:100]:
            del _HASH_CACHE[old_key]
    return h


def compute_cache_key(target, tool, params, input_hash):
    """SHA1 abbreviato (16 char) di (target + tool + params filtrati + input_hash).

    Identifica univocamente l'output di uno step. Cambia QUALSIASI input — nome del
    target, id del tool, params UI, contenuto dello STL sorgente — e la chiave cambia.
    Ritorna None se input_hash è None (il caller salta la cache).
    """
    if not input_hash:
        return None
    filtered = {
        k: v for k, v in (params or {}).items()
        if k not in _INTERNAL_PARAM_KEYS and not k.startswith('IN_')
    }
    payload = json.dumps([target, tool, filtered, input_hash], sort_keys=True, default=str)
    return hashlib.sha1(payload.encode('utf-8')).hexdigest()[:16]


def stl_looks_valid(path):
    """Validazione cheap di una entry STL in cache (self-heal, BUGFIX B4, 2026-07-14).

    Serve a NON servire entry troncate scritte da un CACHE SAVE non atomico (worker
    OOM-killato tra la copia e il rename, pre-BUGFIX B4): la GC conserva proprio le
    key "usate", quindi senza questo check una entry avvelenata verrebbe servita ad
    ogni bake, per sempre.

    Ritorna False SOLO quando il file è dimostrabilmente rotto:
      - size < 134 (stessa soglia usata dal worker sugli STL di preview)
      - header binario incoerente (size != 84 + 50*n_tri) E il file non è un
        ASCII STL (non inizia con 'solid')
    In ogni altro caso ritorna True: questa validazione non deve MAI produrre falsi
    positivi — un unlink erroneo disabiliterebbe la cache per sempre su quella key.
    """
    try:
        size = os.path.getsize(path)
        if size < 134:
            return False
        with open(path, 'rb') as f:
            head = f.read(84)
    except OSError:
        return False
    if len(head) < 84:
        return False
    n_tri = int.from_bytes(head[80:84], 'little')
    if size == 84 + 50 * n_tri:
        return True                        # STL binario coerente
    return head[:5].lower() == b'solid'    # ASCII STL / header non standard: accetta
