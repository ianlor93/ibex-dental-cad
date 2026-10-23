import time
import redis
import json
import os
import sys
import shutil
import glob
import threading
import uuid
import ctypes

current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.append(current_dir)

# FASE 1 — inaugurazione libreria primitivi: mette logic_py su sys.path così i
# moduli-nodo caricati via importlib (slice.py, modelgenerator.py, …) possono fare
# `from ibex_primitives.X import Y`. Fonte di verità unica: config.LOGIC_PY_DIR
# (nessun literal di path duplicato). append (non insert): evita di ombreggiare
# moduli omonimi come lo stub fast_transform.py.
from modules.config import LOGIC_PY_DIR
if LOGIC_PY_DIR not in sys.path:
    sys.path.append(LOGIC_PY_DIR)

try:
    from modules.config import (REDIS_HOST, REDIS_PORT, REDIS_PASS, ACTIVE_BASE, CLOUD_BASE,
                                TIER1_TOOLS, NO_BACKEND_TOOLS, _TOOL_RENAME, validate_node_id)
    # de-DB 2026-07-20: modules.database ELIMINATO — nessun accesso al DB dal worker.
    from modules.filesystem import FilesystemManager, safe_target_name
    from modules.blender_handler import BlenderHandler
    from modules.logic_builder import LogicBuilder
    # FASE 4 (2026-07-20): apply_tier1_queue traslocato in tier1_orchestrator.
    # fast_transform resta la foglia (ABI + loader + _apply_transform); gli
    # handler in tier1_handlers. worker.py importa SOLO l'orchestratore.
    from modules.tier1_orchestrator import apply_tier1_queue
    from modules.draco_encoder import compress_directory
except ImportError as e:
    print(f"[CRITICAL ERROR] Modules not found in {current_dir}. Details: {e}")
    sys.exit(1)

def log(msg): print(f"[IBEX-WORKER] {msg}", flush=True)


def _set_status(pid, status):
    """de-DB 2026-07-20: stato progetto → Redis (volatile, ex=3600), NON più il DB.
    Rimpiazza la vecchia update_status. `project:{pid}:status` è già la sede primaria letta
    da PHP (ProjectService.determineStatus); ora è anche l'UNICA. Errore incluso come
    valore di status ('error'). Best-effort: un fallimento Redis non deve abortire il task."""
    try:
        r.set(f"project:{pid}:status", status, ex=3600)
    except Exception as e:
        log(f"[STATUS] set fallito pid={pid} status={status}: {e}")


def _rp_registry(uid, name, pid):
    """de-DB 2026-07-20: registra/aggiorna l'indice Redis di un progetto (mirror Python di
    App\\Core\\ProjectRegistry::bind). Idempotente. La verità durevole resta il manifest."""
    try:
        r.hset(f"ibex:name2pid:{uid}", name, str(pid))
        r.hset(f"ibex:pid2meta:{pid}", 'uid', uid)
        r.hset(f"ibex:pid2meta:{pid}", 'name', name)
        r.sadd(f"ibex:projects:{uid}", str(pid))
        # next_pid non deve mai regredire sotto un pid già esistente.
        try:
            cur = int(r.get('ibex:next_pid') or 0)
            if int(pid) > cur:
                r.set('ibex:next_pid', int(pid))
        except Exception:
            pass
    except Exception as e:
        log(f"[REGISTRY] bind fallito pid={pid}: {e}")


def _registry_rebuild():
    """de-DB durabilità: ricostruisce l'indice Redis (name2pid/pid2meta/next_pid) scandendo e
    decifrando i .ibex. È l'UNICO modo di ripopolare name↔pid da freddo dopo un FLUSHALL (il
    filename .ibex non porta il pid; vive solo nel manifest.project_id). One-shot, un worker
    solo (elezione SET NX). Best-effort: un .ibex illeggibile viene saltato, non blocca."""
    if not r.set('ibex:registry_rebuilt', '1', nx=True, ex=86400):
        return  # già fatto da un altro worker (o in questa giornata)
    try:
        import zipfile, io as _io, glob as _glob
        from modules.ibex_crypto import decrypt_bytes
    except Exception as e:
        log(f"[REGISTRY] rebuild skip (import): {e}")
        return
    n = 0
    try:
        for path in _glob.glob(os.path.join(CLOUD_BASE, '*', 'files', 'IBEX', '*.ibex')):
            try:
                with open(path, 'rb') as _f:
                    _zb = decrypt_bytes(_f.read())
                with zipfile.ZipFile(_io.BytesIO(_zb), 'r') as z:
                    with z.open('manifest.json') as mf:
                        m = json.load(mf) or {}
                pid = m.get('project_id'); name = os.path.splitext(os.path.basename(path))[0]  # de-DB fix 22/7: NOME = stem del filename (identita'), non il manifest interno (stale post-rinomina)
                # uid = il segmento dopo CLOUD_BASE nel path
                rel = os.path.relpath(path, CLOUD_BASE)
                uid = rel.split(os.sep)[0]
                if pid and name and uid:
                    _rp_registry(uid, name, int(pid))
                    # L7.5.2: ripopola anche la proiezione burn. `ibex:burn:{pid}` vive su
                    # ibex-redis, che gira `--appendonly no` → un recreate la perde. La
                    # sede DUREVOLE è `manifest['burn']` dentro il .ibex (che qui stiamo
                    # già decifrando e leggendo per il registro): stesso identico pattern
                    # di recupero di name2pid, zero letture in più.
                    try:
                        _burn = m.get('burn')
                        if isinstance(_burn, dict) and _burn.get('n'):
                            r.set(f"ibex:burn:{int(pid)}", json.dumps(_burn))
                    except Exception:
                        pass          # best-effort: non deve mai bloccare il rebuild
                    n += 1
            except Exception:
                continue
    except Exception as e:
        log(f"[REGISTRY] rebuild errore: {e}")
    log(f"[REGISTRY] rebuild completato: {n} progetti indicizzati")


def _deliver(channel, payload, ttl=15, ctx=""):
    """Consegna una risposta al frontend sul suo canale Redis. (2026-07-14)

    ⚠️ PERCHÉ ESISTE. Prima di oggi ogni respond_ok/_error/_progress faceva:
            try: r.lpush(...); r.expire(...)
            except: pass          # ← muto
    Se la lpush falliva (client Redis degradato dopo un restart, connessione persa,
    OOM), la risposta non partiva e NESSUNO lo sapeva: il worker loggava comunque
    "[FAST DONE]" — che viene stampato PRIMA della respond_ok — e il frontend restava
    appeso per sempre ad aspettare. Il log diceva "fatto", l'utente vedeva il bollino
    girare all'infinito, e le due cose non si potevano collegare.

    Ora un fallimento di consegna è RUMOROSO. Non possiamo ritrasmettere (il canale è
    a consumo distruttivo e il client sta già aspettando), ma almeno lo si vede nei log.

    Ritorna True se la risposta è partita, False altrimenti.
    """
    if not channel:
        log(f"[DELIVER] {ctx}: nessun response_channel nel task — risposta NON inviata")
        return False
    try:
        r.lpush(channel, json.dumps(payload))
        r.expire(channel, ttl)
        return True
    except Exception as e:
        log(f"[DELIVER] [IBEX-ENGINE ERROR] {ctx}: consegna FALLITA su {channel}: {e} "
            f"— il frontend resterà appeso (bollino 'calcolo in corso' acceso)")
        return False


def _read_client_thumb(active_path):
    """IBX2 (2026-07-21): legge lo SCREENSHOT del canvas editor scritto da PHP
    (.thumb.png in active/), o None. Passato a create_flat_zip → segmento thumb
    dell'IBX2. Best-effort: qualunque problema → None → thumb_len=0 → placeholder."""
    try:
        p = os.path.join(active_path, '.thumb.png')
        if os.path.isfile(p) and 100 < os.path.getsize(p) <= 2 * 1024 * 1024:
            with open(p, 'rb') as _f:
                b = _f.read()
            if b[:8] == b'\x89PNG\r\n\x1a\n':
                return b
    except Exception as _e:
        log(f"[THUMB] read .thumb.png: {_e}")
    return None


def _strip_no_backend(queue, ctx=""):
    """B9 (2026-07-14): scarta dalla queue i nodi solo-UI (config.NO_BACKEND_TOOLS).

    Il frontend li filtra già (ToolExecutor.js:497), ma BAKE_PROJECT NON riflatta il
    grafo: legge la `stack` PERSISTITA (EditorController.php:866). Una stack salvata
    prima che la guardia client esistesse contiene ancora `export_stl` → senza questo
    filtro finirebbe in tier2_queue → _gen_unknown_tool → [IBEX-ENGINE ERROR] → bake
    fallito. Il log NON è decorativo: se scatta, quel progetto ha una stack legacy.
    """
    if not queue:
        return queue
    # RENAME 2026-07-21: normalizza i nomi tool UNA VOLTA, qui, per TUTTI i path
    # (FAST/PREVIEW/BAKE/MESH_PIPELINE chiamano tutti _strip_no_backend). Da qui a
    # valle (tier-split TIER1_TOOLS, DISPATCH) si conoscono solo i nomi nuovi.
    for _s in queue:
        _t = _s.get('tool')
        if _t in _TOOL_RENAME:
            _s['tool'] = _TOOL_RENAME[_t]
    kept = [s for s in queue if s.get('tool') not in NO_BACKEND_TOOLS]
    dropped = len(queue) - len(kept)
    if dropped:
        names = sorted({s.get('tool') for s in queue if s.get('tool') in NO_BACKEND_TOOLS})
        log(f"[QUEUE] {ctx}: scartati {dropped} nodi no_backend ({', '.join(names)}) "
            f"— nessun compute lato worker (stack legacy?)")
    return kept

# V5.14 MallocTrim (2026-05-05): rilascia heap inutilizzato al kernel dopo
# ogni task. glibc malloc tiene grandi pool free dopo task heavy (modelgenerator,
# manifold3d boolean, marching_cubes) — il working set residente del process
# Blender resta gonfiato (~2GB+ private_dirty) anche idle. trim(0) costa
# ~1-5ms vs durata task minuti; riduce idle baseline ~30-50% post-task heavy.
# ctypes.CDLL("libc.so.6") con fallback no-op se la libc non è caricabile
# (es. runtime esotico). Errori del trim stesso silenziati — è opzionale.
try:
    _LIBC = ctypes.CDLL("libc.so.6")
    def _trim_memory():
        try:
            _LIBC.malloc_trim(0)
        except Exception:
            pass
except OSError:
    log("[BOOT] WARNING: libc.so.6 non caricabile, malloc_trim disabilitato")
    def _trim_memory():
        pass

log(f"--- STARTING IBEX WORKER V5.14 (MallocTrim) - DIR: {current_dir} ---")

try:
    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASS, db=0, decode_responses=True, socket_keepalive=True, socket_timeout=30, socket_connect_timeout=10, health_check_interval=30, retry_on_timeout=True)
    r.ping()
    log("--- REDIS CONNECTED ---")
except Exception as e:
    log(f"--- REDIS ERROR: {e} ---")
    sys.exit(1)

fs_mgr = FilesystemManager(log)
blender = BlenderHandler(log)

processed_previews = {}

# SnapshotKeyed Session 1 (2026-04-23): helper per distinguere master STL
# dai file snapshot `{stem}_snap_{nodeId}.stl` (keyed per nodeId) e legacy
# `{stem}_sculpted.stl`. Usato dai filter master_stl_files nei manifest.
import re as _re_snapshot
_SNAPSHOT_FILE_RX = _re_snapshot.compile(r'_snap_[A-Za-z0-9_\-]+\.stl$', _re_snapshot.IGNORECASE)

# S5 IMPORT_FILES: whitelist basename per i file importati (specchio della
# whitelist PHP di EditorController + charset ammesso da logic_builder._TARGET_RX)
_IMPORT_NAME_RX = _re_snapshot.compile(r'^[A-Za-z0-9 _.()\-]+\.stl$', _re_snapshot.IGNORECASE)

# ═══════════════════════════════════════════════════════════════════════════
# PUNTO4-FETTA-D (2026-07-28) — validazione d'ingresso degli identificativi.
#
# `uid`, `project_id` e `project_name` del messaggio di task diventano PATH in
# `process_task` senza che il worker li abbia mai guardati: la difesa e' tutta a
# monte, nei 10 `ctype_digit` di SEC.1 — in un altro linguaggio e in un altro
# container. Chi aggiunge un decimo produttore di task senza quella guardia
# riapre la classe, e nulla qui glielo segnala. Questa e' la SECONDA rete.
#
# ⚠️ Non sostituisce il PHP: e' ridondanza voluta. Oggi nessun task legittimo puo'
# fallire questi controlli — misurato contro TUTTI i produttori: i 9 rPush/lPush di
# EditorController, `storeEmpty`, i re-enqueue del worker stesso e i sub-task
# MESH_PIPELINE, che portano uid/project_id/project_name (fan-out `:1137-1140`).
#
# Sul pid si usa una regex `[0-9]+`, NON `str.isdigit()`: quest'ultimo accetta le
# cifre Unicode (es. '\u0661\u0662\u0663') che `int()` converte volentieri, e un path
# con caratteri non-ASCII passerebbe il controllo.
# Sull'uid si rifiutano ESPLICITAMENTE '.' e '..': la classe del bridge PHP
# (`NextcloudAuthBridge:78`, `[a-zA-Z0-9._@-]`) li AMMETTE, e `active/../{pid}`
# uscirebbe dalla cartella dell'utente. E' l'unico punto del sistema che li chiude.
_TASK_PID_RX = _re_snapshot.compile(r'[0-9]+')
_TASK_UID_RX = _re_snapshot.compile(r'[A-Za-z0-9._@\-]{1,64}')


def _task_ids_reject_reason(uid, pid, raw_name):
    """None se (uid, pid, project_name) sono sicuri da interpolare in un path,
    altrimenti la stringa del motivo (per il log). Nessun side-effect, nessun I/O."""
    s_pid = str(pid)
    if not _TASK_PID_RX.fullmatch(s_pid) or int(s_pid) <= 0:
        return f"project_id non numerico o non positivo: {pid!r}"
    s_uid = str(uid)
    if s_uid in ('.', '..') or not _TASK_UID_RX.fullmatch(s_uid):
        return f"uid fuori whitelist: {uid!r}"
    if raw_name is not None:
        s_nm = str(raw_name)
        if (s_nm in ('', '.', '..') or '/' in s_nm or '\\' in s_nm
                or any(ord(c) < 32 for c in s_nm)):
            return f"project_name non ammesso: {raw_name!r}"
    return None


def _safe_import_src(uid, rel):
    """PUNTO4-FETTA-D — path sorgente di un import, SANDBOXATO dentro {uid}/files/.
    Ritorna il path assoluto risolto, oppure None se esce dalla sandbox.

    ⚠️ Non si puo' ridurre al basename: un `rel` multi-segmento e' LEGITTIMO — l'utente
    importa anche da sottocartelle (es. "COMO/Upper.stl") e il PHP passa proprio path
    relativi a {uid}/files/ (`importFiles`). Quindi si sandboxa, come fa il PHP.
    ⚠️ Il prefix-check ESIGE il separatore finale: `startswith(root)` da solo accetta le
    directory SORELLE (`files_trashbin`, `files_versions`) — e' lo stesso difetto corretto
    lato PHP nella slice SEC-sandbox. Non semplificarlo via."""
    try:
        root = os.path.realpath(os.path.join(CLOUD_BASE, str(uid), "files"))
        cand = os.path.realpath(os.path.join(root, str(rel).lstrip('/')))
    except Exception:
        return None
    if cand == root or cand.startswith(root + os.sep):
        return cand
    return None


def _is_master_stl(fname):
    """True se `fname` è uno STL master (non snapshot, non legacy sculpted)."""
    if not fname.lower().endswith('.stl'):
        return False
    if fname.lower().endswith('_sculpted.stl'):
        return False  # legacy pre-S1
    if _SNAPSHOT_FILE_RX.search(fname):
        return False  # snapshot keyed per nodeId (SnapshotKeyed S1)
    return True

# --- Redis lock helpers ---
# Previene bake concorrenti sullo stesso progetto (Bug RC-2).
# TTL 120s: anche se il worker crasha durante un bake, il lock scade automaticamente.
#
# V5.13 BootCleanup (2026-04-30) — Lock orphan detection via heartbeat.
# Problema risolto: TTL coordinator FAST_TRANSFORM = 600s (Tier C). Se il
# coordinator viene killato (OOM, container restart, manual stop), il lock
# resta in Redis fino a scadenza naturale → utente vede "Lock non acquisito"
# per fino a 10 min.
#
# Soluzione: ogni worker scrive `ibex_alive_{WORKER_ID}` con TTL 30s e
# refresha in background (10s interval). I lock contengono il WORKER_ID
# come value (non più "1"). Cleanup thread periodico (60s) verifica per
# ogni `ibex_lock_*` se il suo owner WORKER_ID ha ancora un heartbeat
# attivo (`ibex_alive_*` exists). Se NO → lock orfano → DEL.
#
# WORKER_ID = container ID Docker (env HOSTNAME, sempre univoco e cambia
# al recreate). Recreate container → nuovo WORKER_ID → vecchi lock owner
# diventano orfani al primo cleanup ciclo.
# WORKER_ID = container_hostname + UUID univoco per processo Python.
# Critical: l'UUID garantisce che `docker restart` (stesso HOSTNAME) generi
# WORKER_ID DIVERSO → vecchi lock vengono identificati come orfani al cleanup.
WORKER_ID = f"{os.environ.get('HOSTNAME', 'unknown')}-{uuid.uuid4().hex[:8]}"
ALIVE_TTL = 30
ALIVE_REFRESH_INTERVAL = 10
CLEANUP_INTERVAL = 60
CLEANUP_WARMUP = 45  # attendi che altri worker scrivano heartbeat prima di cleanup


def _acquire_lock(pid, ttl=120):
    """Tenta di acquisire il lock Redis per il progetto. Ritorna True se acquisito.
    V5.13: il value del lock è WORKER_ID (per identificare il worker owner)."""
    return r.set(f"ibex_lock_{pid}", WORKER_ID, nx=True, ex=ttl)


def _release_lock(pid):
    r.delete(f"ibex_lock_{pid}")


def _heartbeat_worker():
    """V5.13 — Background thread: refresh `ibex_alive_{WORKER_ID}` ogni 10s con TTL 30s.
    Permette al cleanup periodico di identificare worker morti (heartbeat scaduto)."""
    while True:
        try:
            r.set(f"ibex_alive_{WORKER_ID}", str(int(time.time())), ex=ALIVE_TTL)
        except Exception:
            pass  # Errori Redis transient: prossimo iter retry
        time.sleep(ALIVE_REFRESH_INTERVAL)


def _cleanup_orphan_locks():
    """V5.13 — Background thread: ogni 60s scansiona `ibex_lock_*` e cancella
    quelli il cui owner WORKER_ID non ha più heartbeat (`ibex_alive_*` non esiste).

    Warmup 45s post-boot: dà tempo agli altri worker di scrivere il loro
    heartbeat → evita falsi orfani durante restart sequenziale del pool.
    """
    time.sleep(CLEANUP_WARMUP)
    while True:
        try:
            cleaned = 0
            for key in r.scan_iter(match="ibex_lock_*", count=100):
                try:
                    owner = r.get(key)
                    if not owner:
                        continue
                    # Skip lock vecchio formato V5.12 (value="1") — manteniamo per compat
                    # ma identificheremo come orfano se nessun worker scrive `ibex_alive_1`
                    if not r.exists(f"ibex_alive_{owner}"):
                        # Owner morto → lock orfano
                        r.delete(key)
                        cleaned += 1
                        log(f"[CLEANUP] orphan lock {key} (owner={owner} no heartbeat)")
                except Exception as e_inner:
                    log(f"[CLEANUP] error on key {key}: {e_inner}")
            if cleaned > 0:
                log(f"[CLEANUP] {cleaned} orphan lock(s) rimossi in questo ciclo")
        except Exception as e:
            log(f"[CLEANUP] scan error: {e}")
        time.sleep(CLEANUP_INTERVAL)


# ═══════════════════════════════════════════════════════════════════
# JANITOR — ciclo-vita progetti, FILESYSTEM-DRIVEN (de-DB, 2026-07-20).
#
# Ogni JANITOR_INTERVAL secondi, UN solo worker (elezione SET NX su
# `ibex_lock_janitor`). Itera active/{uid}/{pid}/ dal FILESYSTEM (non dal DB).
# Per ogni progetto (project_name dal manifest):
#
#   · manifest.json senza `project_name` (pre-dedb / corrotto / assente)
#         → SKIP conservativo: non so risolvere il .ibex → non tocco.
#   · .ibex ASSENTE (cancellato da Files, o mai creato) E età active_dir > GRACE
#         → rrmdir active/ + pulizia chiavi Redis (orfano riconciliato).
#   · .ibex PRESENTE → PASSO B (2026-07-21): il janitor VERIFICA, non deduce. Purga
#         SOLO se ① digest(active/manifest.session) == session_digest nell'header del
#         .ibex (DURABILITÀ: la sessione è provatamente archiviata — lettura PARZIALE
#         di 41 byte, nessun decrypt dei 105 MB), ② nessun job in coda per il pid
#         (LIVENESS), ③ idle >= GRACE. Header `project_id` ≠ pid → non è il tuo archivio
#         (m6) → non toccare. Header vecchio senza digest (IBX1/IBX2 gen-1) → non
#         verificabile → non toccare (si sblocca al prossimo save, che scrive gen-2).
#   · Il vecchio criterio mtime(manifest) > mtime(.ibex) è RIMOSSO, non affiancato:
#         era una DEDUZIONE (bocciata dal recon), sostituita da una VERIFICA (digest).
#
# Rimossi (de-DB): il loop DB get_all_projects/delete_project, il warn duplicati
# (richiedeva il DB — tornerà file-based in BLOCCO 3 se serve), la guard mtime>1h.
# Ogni progetto toccato passa per il mutex `_acquire_lock(pid)`.
# ═══════════════════════════════════════════════════════════════════
JANITOR_INTERVAL = 300
JANITOR_WARMUP = 60
# de-DB 2026-07-20: FILESYSTEM-DRIVEN (nessuno `status` dal DB). PASSO B 2026-07-21: il
# criterio di durabilità è il session_digest nell'header IBX2 gen-2, non più mtime.
# Rimossi: JANITOR_ACTIVE_MIN_AGE (era il bug — purgava l'editor idle), JANITOR_BUSY,
# JANITOR_PURGE_BLACKLIST.
JANITOR_GRACE = 900  # 15 min: guardia idle (editor riaperto-e-fermo) + anti nati-morti


def _janitor_manifest_pname(active_dir):
    """project_name dal manifest.json di un active_dir, o None (→ skip conservativo).

    de-DB: il janitor non ha più il DB per risolvere il .ibex di un pid; il nome
    del progetto (= basename del .ibex) vive nel manifest. Se manca (manifest
    pre-dedb, corrotto, o assente) il janitor NON tocca la dir."""
    try:
        with open(os.path.join(active_dir, 'manifest.json')) as _f:
            pn = (json.load(_f) or {}).get('project_name')
        return pn if isinstance(pn, str) and pn else None
    except Exception:
        return None


from modules.janitor_logic import pids_with_queued_jobs, janitor_verdict  # PASSO B: criterio in un modulo (single source)


def _janitor_cycle():
    # de-DB 2026-07-20: FILESYSTEM-DRIVEN. Itera active/{uid}/{pid}/ dal disco.
    # PASSO B 2026-07-21: la purga VERIFICA (digest della sessione), non deduce (mtime).
    queued_pids = pids_with_queued_jobs(r)
    try:
        uids = [u for u in os.listdir(ACTIVE_BASE)
                if os.path.isdir(os.path.join(ACTIVE_BASE, u))]
    except Exception:
        uids = []

    for uid in uids:
        base = os.path.join(ACTIVE_BASE, uid)
        try:
            folders = [f for f in os.listdir(base)
                       if f.isdigit() and os.path.isdir(os.path.join(base, f))]
        except Exception:
            continue
        for pid_str in folders:
            active_dir = os.path.join(base, pid_str)
            manifest_path = os.path.join(active_dir, 'manifest.json')

            pname = _janitor_manifest_pname(active_dir)
            if not pname:
                # Pre-dedb / corrotto / assente: non so risolvere il .ibex → SKIP conservativo.
                continue
            ibex_path = os.path.join(CLOUD_BASE, uid, 'files', 'IBEX', f"{pname}.ibex")

            try:
                if not os.path.exists(ibex_path):
                    # Progetto cancellato da Files (o .ibex mai creato). Guard età
                    # anti nati-morti: il .ibex nasce a FINE INIT_PROJECT.
                    try:
                        if time.time() - os.path.getmtime(active_dir) < JANITOR_GRACE:
                            continue
                    except OSError:
                        continue
                    if not _acquire_lock(pid_str, ttl=60):
                        continue
                    try:
                        shutil.rmtree(active_dir, ignore_errors=True)
                        r.delete(f"project:{pid_str}:status")
                        r.delete(f"latest_preview_{pid_str}")
                        log(f"[JANITOR] orfano riconciliato: {uid}/{pid_str} '{pname}' (.ibex assente)")
                    finally:
                        _release_lock(pid_str)
                    continue

                # .ibex esiste → PASSO B: il janitor VERIFICA (non deduce). Verdetto in
                # janitor_verdict (fonte UNICA del criterio: usata anche dal diagnostico).
                verdict = janitor_verdict(manifest_path, ibex_path, pid_str, queued_pids, JANITOR_GRACE)
                if verdict != 'purge':
                    continue
                # provato salvato + nessun job + idle: purgabile, la riapertura ri-estrae il buono.
                if not _acquire_lock(pid_str, ttl=60):
                    continue
                try:
                    shutil.rmtree(active_dir, ignore_errors=True)
                    log(f"[JANITOR] active purgata: {uid}/{pid_str} '{pname}' (digest match, coda vuota)")
                finally:
                    _release_lock(pid_str)
            except OSError:
                continue

    # ── 4. Sweep .ibex.tmp orfani (Legge 2, 2026-07-13) ──
    # I tmp di create_flat_zip sono effimeri (os.replace/unlink); un kill duro
    # mid-save può lasciarne uno nella IBEX/ dell'utente (post-fix: ciphertext;
    # legacy pre-fix: plaintext — vanno via entrambi). Guard età >1h per non
    # incrociare un save in volo.
    try:
        for tmp_path in glob.glob(os.path.join(CLOUD_BASE, '*', 'files', 'IBEX', '*.ibex.tmp')):
            try:
                if time.time() - os.path.getmtime(tmp_path) > 3600:
                    os.unlink(tmp_path)
                    log(f"[JANITOR] .ibex.tmp orfano rimosso: {os.path.basename(tmp_path)}")
            except OSError:
                continue
    except Exception as e:
        log(f"[JANITOR] sweep .ibex.tmp: {e}")

    # [rimosso 20260722-193024Z - cambio sicurezza] Sweep name2pid autonomo ELIMINATO dal janitor:
    # niente riconciliazione automatica del registry. Orfani gestiti A MANO via
    # scripts/_reconcile_registry.py (dry-run default, --apply per rimuovere).


def _janitor():
    """S6 — Background thread: elezione + ciclo janitor ogni JANITOR_INTERVAL."""
    time.sleep(JANITOR_WARMUP)
    while True:
        try:
            # Elezione: TTL < INTERVAL → il lock scade da solo prima del
            # prossimo giro; niente release esplicita (evita il caso "release
            # dopo expiry cancella il lock del prossimo eletto").
            if r.set("ibex_lock_janitor", WORKER_ID, nx=True, ex=JANITOR_INTERVAL - 20):
                _janitor_cycle()
        except Exception as e:
            log(f"[JANITOR] cycle error: {e}")
        time.sleep(JANITOR_INTERVAL)


def process_task(task):
    action = task.get('action')
    uid = task.get('uid')
    pid = task.get('project_id')
    p_name = task.get('project_name', f"project_{pid}")

    # PUNTO4-FETTA-D (2026-07-28) — seconda rete: due righe piu' sotto questi tre
    # valori diventano path. Se uno non e' usabile, il task NON si processa.
    # `project_name` si valida sul valore GREZZO di `task.get`, non su `p_name`:
    # cosi' il controllo copre anche la ri-lettura che SAVE_EXIT fa della stessa
    # chiave (`p_name = task.get('project_name', '')`, binding suo).
    _bad = _task_ids_reject_reason(uid, pid, task.get('project_name'))
    if _bad is not None:
        log(f"[TASK REJECT] {action}: {_bad} — task scartato, nessun path costruito.")
        return

    active_path = os.path.join(ACTIVE_BASE, str(uid), str(pid))
    cloud_ibex_path = os.path.join(CLOUD_BASE, str(uid), "files", "IBEX", f"{p_name}.ibex")

    if action == 'INIT_PROJECT':
        log(f"--- INIT PROJECT {pid} ---")
        try:
            if not fs_mgr.purge_active_cache(active_path):
                log(f"[INIT ERR] Impossibile pulire cache {active_path}. Task abortito.")
                _set_status(pid, 'error')
                return
            os.makedirs(active_path, exist_ok=True)

            input_files = task.get('files', [])
            for rel in input_files:
                src = os.path.join(CLOUD_BASE, str(uid), "files", rel.lstrip('/'))
                if os.path.exists(src):
                    shutil.copy2(src, os.path.join(active_path, os.path.basename(rel)))

            fs_mgr.fix_permissions(active_path)

            lb = LogicBuilder(active_path)
            script = lb.build_init_script()

            if blender.run_script(script):
                fs_mgr.fix_permissions(active_path)
                compress_directory(active_path, log)

                # Manifest v2.0 fresh: segna il progetto come "V2 dalla creazione"
                # → Session 3 migration skip silente (nessun legacy_warning).
                # SnapshotKeyed S1: _is_master_stl esclude anche `_snap_{nodeId}.stl`.
                master_stl_files = [
                    f for f in os.listdir(active_path)
                    if _is_master_stl(f)
                ]
                # ManifestSoT V3.0 (2026-05-02): manifest.json contiene anche
                # `session` (DAG + visuals + mesh_state + last_bake + ...). All'INIT
                # la sessione è vuota — sarà popolata dal primo SAVE_EXIT.
                manifest = {
                    'version': '3.0',
                    'project_id': pid,        # de-DB: il .ibex è auto-descrittivo → rebuild registry
                    'project_name': p_name,   # de-DB: identità nel manifest (il janitor + editor la leggono)
                    'input_files': master_stl_files,
                    'timestamp': time.time(),
                    'baked': False,
                    'session': {},
                }
                with open(os.path.join(active_path, 'manifest.json'), 'w') as mf:
                    json.dump(manifest, mf)

                if fs_mgr.create_flat_zip(active_path, cloud_ibex_path,
                                          exclude_dirs=['baked', 'baked_output', 'preview',
                                                        'preview_tmp', 'preview_tier1_tmp',
                                                        'sculpt_cache', '.cache_pipeline', '.cache_sdf',
                                                        '.cache_pml']):
                    _set_status(pid, 'ready')
                    _rp_registry(uid, p_name, pid)   # de-DB: indicizza il progetto appena creato
                else:
                    _set_status(pid, 'error')
            else:
                _set_status(pid, 'error')
        except Exception as e:
            log(f"[INIT ERR] {e}")
            _set_status(pid, 'error')

    elif action == 'IMPORT_FILES':
        # ═══════════════════════════════════════════════════════════════
        # S5 «IBEX semplice» (2026-07-10) — import di nuovi STL in un
        # progetto ESISTENTE (File → Importa mesh). Ingest come INIT ma
        # SENZA purge: copia da NC con dedupe-rename (Inv.67: mai
        # overwrite), build_import_script apre la scena esistente (Inv.12)
        # e importa SOLO i nuovi, merge pivots (Inv.31), .drc per-file
        # (Inv.41), manifest ricalcolato ATOMICO con session preservata
        # (Inv.69), re-zip .ibex (senza, la purge dashboard + LOAD
        # perderebbero l'import). L'editor è APERTO durante l'import →
        # lock obbligatorio con retry-wait + re-enqueue (pattern SAVE_EXIT).
        # ═══════════════════════════════════════════════════════════════
        log(f"--- IMPORT FILES {pid} ---")

        got_lock = _acquire_lock(pid, ttl=120)
        if not got_lock:
            for _ in range(10):
                time.sleep(2)
                if _acquire_lock(pid, ttl=120):
                    got_lock = True
                    break
        if not got_lock:
            retries = int(task.get('_import_retry', 0))
            if retries < 3:
                task['_import_retry'] = retries + 1
                r.rpush('ibex_tasks', json.dumps(task))
                log(f"[IMPORT] Lock occupato per PID {pid}, re-enqueue ({retries + 1}/3).")
            else:
                log(f"[IMPORT ERR] Lock mai ottenuto per PID {pid} dopo 3 re-enqueue.")
                _set_status(pid, 'error')
            return

        copied = []  # basenames effettivamente copiati (per rollback su fail)
        try:
            scene_file = os.path.join(active_path, 'scene.blend')
            if not os.path.isfile(scene_file):
                log(f"[IMPORT ERR] scene.blend assente in {active_path} — aprire prima il progetto.")
                _set_status(pid, 'error')
                return

            existing = set(os.listdir(active_path))
            for rel in task.get('files', []):
                base = os.path.basename(str(rel))
                if not _IMPORT_NAME_RX.match(base):
                    log(f"[IMPORT] Nome non ammesso, skip: {base}")
                    continue
                # PUNTO4-FETTA-D (2026-07-28): il path si costruiva con `rel` INTERO
                # mentre la whitelist qui sopra guarda solo il BASENAME — un
                # "../../vittima/files/x.stl" ha basename ammesso e path fuori.
                # Chiuso finora SOLO dal realpath-sandbox lato PHP (`importFiles`):
                # difesa a fonte unica, in un altro linguaggio e in un altro container.
                # Ora il valore VERIFICATO e quello USATO sono lo stesso.
                src = _safe_import_src(uid, rel)
                if src is None:
                    log(f"[IMPORT] [SANDBOX] path fuori da {{uid}}/files/, skip: {rel!r}")
                    continue
                if not os.path.exists(src):
                    log(f"[IMPORT] Sorgente NC mancante, skip: {rel}")
                    continue
                # Dedupe-rename (Inv.67): mai overwrite — né contro i file
                # esistenti né dentro il batch corrente.
                stem, ext = os.path.splitext(base)
                final = base
                n = 2
                while final in existing:
                    final = f"{stem} ({n}){ext}"
                    n += 1
                shutil.copy2(src, os.path.join(active_path, final))
                existing.add(final)
                copied.append(final)

            if not copied:
                log(f"[IMPORT] Nessun file importabile per PID {pid} — no-op benigno.")
                _set_status(pid, 'ready')
                return

            fs_mgr.fix_permissions(active_path)
            log(f"[IMPORT] Copiati {len(copied)} STL: {copied}")

            lb = LogicBuilder(active_path)
            script = lb.build_import_script(copied)

            if blender.run_script(script):
                # .drc solo per i nuovi file (Inv.41, pattern SAVE_SNAPSHOT)
                from modules.draco_encoder import compress_stl
                for f in copied:
                    try:
                        # S6 fix (2026-07-10): logger DEVE essere keyword — la firma è
                        # (stl_path, drc_path=None, logger=None); posizionale finiva
                        # in drc_path → TypeError silenziosa, .drc mai creati.
                        compress_stl(os.path.join(active_path, f), logger=log)
                    except Exception as ce:
                        log(f"[IMPORT] drc fallito per {f}: {ce}")
                fs_mgr.fix_permissions(active_path)

                # Manifest ricalcolato (SoT), session/baked preservati, write ATOMICA
                master_stl_files = [f for f in os.listdir(active_path) if _is_master_stl(f)]
                mp = os.path.join(active_path, 'manifest.json')
                existing_manifest = {}
                if os.path.isfile(mp):
                    try:
                        with open(mp) as _ef:
                            existing_manifest = json.load(_ef) or {}
                    except Exception:
                        existing_manifest = {}
                manifest = {
                    'version': '3.0',
                    'project_id': existing_manifest.get('project_id') or pid,          # de-DB
                    'project_name': existing_manifest.get('project_name') or p_name,   # de-DB
                    'input_files': master_stl_files,
                    'timestamp': time.time(),
                    'baked': existing_manifest.get('baked', False),
                    'session': existing_manifest.get('session', {}),
                }
                if 'baked_output_files' in existing_manifest:
                    manifest['baked_output_files'] = existing_manifest['baked_output_files']
                # L7.5.2 (2026-07-24): `burn` è TOP-LEVEL (fratello di `session`, MAI dentro:
                # il digest del janitor guarda solo `session`). Questo manifest è RICOSTRUITO
                # da whitelist → senza questo carry-over la sintesi burn sparirebbe in SILENZIO
                # al primo IMPORT_FILES. Stesso trattamento di `baked_output_files`.
                if 'burn' in existing_manifest:
                    manifest['burn'] = existing_manifest['burn']
                tmp_mp = mp + '.tmp'
                with open(tmp_mp, 'w') as mf:
                    json.dump(manifest, mf)
                os.replace(tmp_mp, mp)

                if fs_mgr.create_flat_zip(active_path, cloud_ibex_path,
                                          exclude_dirs=['baked', 'baked_output', 'preview',
                                                        'preview_tmp', 'preview_tier1_tmp',
                                                        'sculpt_cache', '.cache_pipeline', '.cache_sdf',
                                                        '.cache_pml'],
                                          required_files=['scene.blend']):
                    _set_status(pid, 'ready')
                    r.set(f"project:{pid}:status", "ready", ex=3600)
                    log(f"[IMPORT] OK: {len(copied)} mesh aggiunte, .ibex aggiornato.")
                else:
                    _set_status(pid, 'error')
            else:
                # Rollback: mai STL orfani fuori scena (Inv.17)
                for f in copied:
                    for p in (os.path.join(active_path, f),
                              os.path.join(active_path, os.path.splitext(f)[0] + '.drc')):
                        try:
                            if os.path.isfile(p):
                                os.unlink(p)
                        except Exception:
                            pass
                log(f"[IMPORT ERR] Import Blender fallito — rollback di {len(copied)} file copiati.")
                _set_status(pid, 'error')
        except Exception as e:
            log(f"[IMPORT ERR] {e}")
            _set_status(pid, 'error')
        finally:
            _release_lock(pid)

    elif action == 'LOAD_PROJECT':
        log(f"--- LOAD PROJECT {pid} ---")
        # 1c anti-clobber (de-DB, 2026-07-20): se in active/ c'è un manifest PIÙ RECENTE
        # del .ibex, contiene lavoro non ancora salvato nell'archivio (autosave). Ri-estrarre
        # il .ibex fermo all'ultimo SAVE_EXIT lo CANCELLEREBBE (era il 2° anello del bug 283).
        # Protezione ESPLICITA nel worker, non implicita nel chiamante.
        try:
            _mp = os.path.join(active_path, 'manifest.json')
            if (os.path.isfile(_mp) and os.path.exists(cloud_ibex_path)
                    and os.path.getmtime(_mp) > os.path.getmtime(cloud_ibex_path)):
                log(f"[LOAD GUARD] manifest locale più recente del .ibex — skip extract "
                    f"(lavoro non salvato preservato)")
                _set_status(pid, 'ready')
                return
        except OSError:
            pass
        if not fs_mgr.purge_active_cache(active_path):
            log(f"[LOAD ERR] Impossibile pulire cache {active_path}. Task abortito.")
            _set_status(pid, 'error')
            return
        os.makedirs(active_path, exist_ok=True)
        if os.path.exists(cloud_ibex_path):
            try:
                import zipfile, io as _io
                from modules.ibex_crypto import decrypt_bytes
                with open(cloud_ibex_path, 'rb') as _f:
                    _blob = _f.read()
                _zipbytes = decrypt_bytes(_blob)
                with zipfile.ZipFile(_io.BytesIO(_zipbytes), 'r') as z:
                    z.extractall(active_path)

                scene_file = os.path.join(active_path, "scene.blend")
                if not os.path.exists(scene_file):
                    log(f"[LOAD ERR] scene.blend non trovato dopo estrazione zip — tentativo auto-recovery INIT_PROJECT")
                    # de-DB: input_files dal manifest estratto (era una lettura DB).
                    input_files = []
                    try:
                        _rp = os.path.join(active_path, 'manifest.json')
                        if os.path.isfile(_rp):
                            with open(_rp) as _rf:
                                input_files = (json.load(_rf) or {}).get('input_files', []) or []
                    except Exception:
                        input_files = []
                    if input_files:
                        r.rpush('ibex_tasks', json.dumps({
                            'action':       'INIT_PROJECT',
                            'uid':          uid,
                            'project_id':   pid,
                            'project_name': p_name,
                            'files':        input_files
                        }))
                        _set_status(pid, 'initializing')
                        log(f"[LOAD RECOVERY] INIT_PROJECT accodato per PID {pid} ({len(input_files)} file STL)")
                    else:
                        log(f"[LOAD ERR] input_file_path vuoto per PID {pid} — impossibile recuperare")
                        _set_status(pid, 'error')
                    return

                fs_mgr.fix_permissions(active_path)

                # de-DB 2026-07-20: assicura project_name + project_id nel manifest estratto
                # (self-descriptive .ibex → janitor risolve il .ibex, rebuild registry). Write
                # atomico solo se manca qualcosa; ri-registra sempre l'indice Redis.
                try:
                    _mp2 = os.path.join(active_path, 'manifest.json')
                    if os.path.isfile(_mp2):
                        with open(_mp2) as _mf2:
                            _mdata = json.load(_mf2) or {}
                        _changed = False
                        if _mdata.get('project_name') != p_name:  # de-DB fix 22/7: forza il nome dal filename caricato (ripara manifest interno stale)
                            _mdata['project_name'] = p_name; _changed = True
                        if not _mdata.get('project_id'):
                            _mdata['project_id'] = pid; _changed = True
                        if _changed:
                            _tmp2 = _mp2 + '.tmp'
                            with open(_tmp2, 'w') as _mf2:
                                json.dump(_mdata, _mf2)
                            os.replace(_tmp2, _mp2)
                            log(f"[LOAD] manifest migrato: project_name='{p_name}' project_id={pid}")
                        # Ri-registra l'indice Redis (idempotente): open_name→pid + ownership.
                        _rp_registry(uid, p_name, pid)  # de-DB fix 22/7: bind col NOME = filename stem, mai col manifest interno
                except Exception as _e:
                    log(f"[LOAD] write-back project_name skip: {_e}")

                # de-DB 2026-07-20: blocco MIGRAZIONE LEGACY v1→v2 RIMOSSO (PASSO 0a: nessun
                # progetto legacy). LOAD ora: extract → write-back project_name/id → .drc → ready.

                # Auto-genera .drc mancanti (progetti legacy o zip senza .drc)
                missing_drc = [
                    f for f in os.listdir(active_path)
                    if f.lower().endswith('.stl')
                    and not os.path.exists(os.path.join(active_path, f[:-4] + '.drc'))
                ]
                if missing_drc:
                    log(f"[LOAD] Generazione .drc per {len(missing_drc)} mesh legacy")
                    compress_directory(active_path, log)

                _set_status(pid, 'ready')
            except Exception as e:
                log(f"[LOAD ERR] {e}")
                _set_status(pid, 'error')
        else:
            log(f"[LOAD ERR] File .ibex non trovato: {cloud_ibex_path}")
            _set_status(pid, 'error')

    elif action == 'BAKE_PROJECT':
        # ═══════════════════════════════════════════════════════════════
        # BAKE_PROJECT — NON-DISTRUTTIVO (Sessione 2 pipeline procedurale).
        #
        # Semantica: "export finale per la fresatrice". Calcola il risultato
        # dell'intera pipeline a partire dai master STL e lo scrive in
        # active_path/baked/. I master in active_path NON vengono toccati.
        #
        # Invarianti (Sessione 2):
        #   · I master STL in active_path restano immutabili
        #   · scene.blend non viene rigenerato
        #   · preview/ non viene eliminata (è il viewport state corrente,
        #     indipendente dall'export baked)
        #   · .ibex ESCLUDE baked/ dall'archivio (è locale + ricostruibile)
        #   · active_path NON viene purgato al termine → i file baked/
        #     restano disponibili per serve_file fino al prossimo open
        #   · status='baked' protegge active_path dalla purge dashboard
        #     (blacklist ProjectController::index — A4)
        # ═══════════════════════════════════════════════════════════════
        log(f"--- BAKE PROJECT {pid} (NON-DESTRUCTIVE EXPORT) ---")

        if not _acquire_lock(pid, ttl=300):
            log(f"[BAKE ERR] Lock non acquisito per PID {pid} — bake già in corso")
            _set_status(pid, 'error')
            return

        try:
            # S3 «IBEX semplice» (2026-07-10) — guard anti-brick 0-mesh (Q8).
            # Bake su progetto SENZA master = skip BENIGNO: mai status='error'
            # (brickerebbe il progetto via circuit-breaker editor()). Fonte
            # autorevole = master fisici in active_path (stesso _is_master_stl
            # usato per il manifest a fine bake). Status riportato a 'ready'
            # (il PHP lo ha già messo a 'baking' prima di accodare).
            masters = ([f for f in os.listdir(active_path) if _is_master_stl(f)]
                       if os.path.isdir(active_path) else [])
            if not masters:
                log(f"[BAKE SKIP] PID {pid}: 0 master in active_path — progetto vuoto, nessun export. Status → 'ready'.")
                _set_status(pid, 'ready')
                return

            _set_status(pid, 'baking')
            r.set(f"project:{pid}:status", "baking", ex=3600)

            # B9: la stack di BAKE è PERSISTITA (EditorController.php:866), non
            # riflattata → può contenere nodi no_backend legacy. Scartali.
            queue = _strip_no_backend(task.get('queue', []), 'BAKE_PROJECT')
            baked_dir = os.path.join(active_path, "baked")

            # Purge solo baked/, MAI active_path (contiene i master immutabili)
            if not fs_mgr.purge_active_cache(baked_dir):
                log(f"[BAKE ERR] Impossibile pulire {baked_dir}. Task abortito.")
                _set_status(pid, 'error')
                return
            os.makedirs(baked_dir)

            # Separa Tier 1 e Tier 2
            tier1_queue = [s for s in queue if s.get('tool') in TIER1_TOOLS]
            tier2_queue = [s for s in queue if s.get('tool') not in TIER1_TOOLS]

            # Step 1: applica Tier 1 via Trimesh (sui master STL in active_path).
            # Output in sottocartella tmp dentro baked/; rimossa dopo Blender.
            tier1_tmp = os.path.join(baked_dir, "tier1_out")
            if tier1_queue:
                os.makedirs(tier1_tmp, exist_ok=True)
                if not apply_tier1_queue(tier1_queue, active_path, tier1_tmp, log):
                    log(f"[BAKE ERR] Tier 1 fast transform fallito")
                    _set_status(pid, 'error')
                    return

            # Step 2: applica Tier 2 via Blender (output_dir=baked_dir).
            # Se pure Tier 1 queue, Blender esporta gli STL Tier 1 via tier1_override + export_all.
            lb = LogicBuilder(active_path, baked_dir)
            script = lb.build_script(tier2_queue,
                                     export_all=True,
                                     tier1_override=tier1_tmp if tier1_queue else None)

            if blender.run_script(script):
                out_files = [f for f in os.listdir(baked_dir) if f.lower().endswith('.stl')]
                if not out_files:
                    log(f"[BAKE ERR] Nessun STL prodotto in {baked_dir}")
                    _set_status(pid, 'error')
                    return

                invalid_stl = [f for f in out_files if os.path.getsize(os.path.join(baked_dir, f)) < 134]
                if invalid_stl:
                    log(f"[BAKE ERR] STL non validi (troppo piccoli): {invalid_stl}")
                    _set_status(pid, 'error')
                    return

                try:
                    # Cleanup tier1_tmp (non deve entrare nell'export finale)
                    if os.path.isdir(tier1_tmp):
                        shutil.rmtree(tier1_tmp, ignore_errors=True)

                    # Genera .drc dentro baked/ per delivery browser
                    compress_directory(baked_dir, log)

                    # Manifest v2.0 (invariante ristrutturazione pipeline):
                    #   version             — bump da "1.0" → "2.0"
                    #   input_files         — master STL intatti (scanner-space)
                    #   baked_output_files  — STL cotti in active_path/baked/
                    #   baked               — False: master mai sovrascritti in v2.0
                    #                         (campo mantenuto per disambiguare v1.0
                    #                         legacy in fase di migrazione — Sessione 3)
                    master_stl_files = [
                        f for f in os.listdir(active_path)
                        if _is_master_stl(f)
                    ]
                    # ManifestSoT V3.0: preserva il campo `session` se presente
                    # (BAKE non modifica DAG/visuals/last_bake — sono già stati
                    # salvati dall'ultimo SAVE_EXIT). Aggiunge solo baked_output_files.
                    existing_manifest = {}
                    mp = os.path.join(active_path, "manifest.json")
                    if os.path.isfile(mp):
                        try:
                            with open(mp) as _ef:
                                existing_manifest = json.load(_ef) or {}
                        except Exception:
                            existing_manifest = {}
                    manifest = {
                        "version": "3.0",
                        "project_id": existing_manifest.get('project_id') or pid,          # de-DB
                        "project_name": existing_manifest.get('project_name') or p_name,   # de-DB
                        "input_files": master_stl_files,
                        "baked_output_files": out_files,
                        "baked": False,
                        "timestamp": time.time(),
                        "session": existing_manifest.get('session', {}),
                    }
                    # L7.5.2: carry-over di `burn` (top-level). Vedi nota in IMPORT_FILES:
                    # anche qui il manifest è ricostruito da whitelist → senza questa riga
                    # un BAKE_PROJECT cancellerebbe la sintesi burn senza alcun errore.
                    if 'burn' in existing_manifest:
                        manifest['burn'] = existing_manifest['burn']
                    with open(mp, 'w') as f:
                        json.dump(manifest, f)

                    fs_mgr.fix_permissions(active_path)

                    # Ricrea .ibex ESCLUDENDO baked/ (output locale ricostruibile).
                    # Il .ibex contiene solo master + scene.blend + sculpted — tutto
                    # il necessario per ricostruire la scena al prossimo LOAD_PROJECT.
                    if fs_mgr.create_flat_zip(
                        active_path, cloud_ibex_path,
                        exclude_dirs=['baked', 'baked_output', 'preview', 'preview_tmp',
                                      'preview_tier1_tmp', 'sculpt_cache', '.cache_pipeline', '.cache_sdf',
                                      '.cache_pml'],
                        required_files=['scene.blend'],
                        thumb_png=_read_client_thumb(active_path)
                    ):
                        _set_status(pid, 'baked')
                        r.set(f"project:{pid}:status", "baked", ex=3600)
                        # NO purge_active_cache: active_path (master + baked/) resta
                        # disponibile per serve_file. Dashboard blacklist 'baked' (A4)
                        # impedisce la purga finché l'utente non riapre l'editor.
                    else:
                        _set_status(pid, 'error')
                except Exception as e:
                    log(f"[BAKE ERR] Post-processing fallito: {e}")
                    _set_status(pid, 'error')
            else:
                _set_status(pid, 'error')

        finally:
            _release_lock(pid)

    elif action == 'FAST_TRANSFORM':
        # Tier C — Smart Worker (2026-04-30): coordinator con parallelismo intra-task.
        # Pipeline 1 mesh → fast-path legacy sequenziale (codice originale).
        # Pipeline 2+ mesh → split per target, spawn N sub-task MESH_PIPELINE su
        #   coda dedicata `ibex_tasks_pipeline`, wait completion via channel
        #   `pipeline_done_{pid}_{preview_id}`, swap per-mesh atomico (sub-task
        #   stessi swap-pano i loro file in preview/), forward progress al
        #   frontend via response_channel.
        # Cache pipeline (Fase 1) attiva in entrambi i path.
        response_channel = task.get('response_channel')

        def respond_error(msg):
            log(f"[FAST ERR] {msg}")
            _deliver(response_channel, {'success': False, 'error': msg},
                     ttl=15, ctx='FAST_TRANSFORM/error')

        def respond_ok():
            _deliver(response_channel, {'success': True},
                     ttl=15, ctx='FAST_TRANSFORM/ok')

        def respond_progress(target, success, error=None):
            # Tier C Fase 3: progress message per hot-swap incrementale frontend.
            # Il frontend (BakeEngine._pollPreviewReady) processa progress messages
            # facendo hot-swap della singola mesh appena pronta. Failure parziale
            # → notify rosso sulla mesh fallita, mesh OK già aggiornate.
            payload = {'progress': True, 'target': target, 'success': bool(success)}
            if error:
                payload['error'] = str(error)
            _deliver(response_channel, payload, ttl=30, ctx=f'FAST_TRANSFORM/progress[{target}]')

        status = r.get(f"project:{pid}:status")
        if status in ('baking', 'baked'):
            log(f"[DROP] Fast transform annullata — progetto in stato '{status}'")
            respond_error(f"Progetto in stato {status}")
            return

        try:
            task_id = int(task.get('preview_id', 0))
            redis_latest = int(float(r.get(f"latest_preview_{pid}") or 0))
        except Exception:
            task_id = 0
            redis_latest = 0

        highest_done = processed_previews.get(pid, 0)

        if task_id > 0 and (task_id <= highest_done or redis_latest == 999999999):
            log(f"[DROP LIFO] Scartata FAST_TRANSFORM {task_id} (done={highest_done}, latest={redis_latest})")
            respond_error("Preview superata da una più recente")
            return

        processed_previews[pid] = max(highest_done, task_id)
        log(f"--- FAST TRANSFORM {pid} (ID: {task_id}) ---")

        queue = _strip_no_backend(task.get('queue', []), 'FAST_TRANSFORM')  # B9
        if not queue:
            respond_error("Queue vuota")
            return

        if not os.path.isdir(active_path):
            respond_error(f"Cartella attiva non trovata: {active_path}")
            return

        # TTL aumentato per coprire wait sub-task (era 30s)
        if not _acquire_lock(pid, ttl=600):
            respond_error("Lock non acquisito — operazione già in corso su questo progetto")
            return

        preview_dir = os.path.join(active_path, "preview")
        cache_pipeline_dir = os.path.join(active_path, ".cache_pipeline")

        # Estrai targets unici dalla queue (preserva ordine prima apparizione)
        targets = []
        seen_targets = set()
        for s in queue:
            t = s.get('target')
            if t and t not in seen_targets:
                seen_targets.add(t)
                targets.append(t)

        # ═════════════════════════════════════════════════════════════════════
        # FAST-PATH: 1 mesh (o 0 — defensive) → path legacy sequenziale
        # Cache pipeline attiva. Stesso pattern del worker pre-Tier-C.
        # ═════════════════════════════════════════════════════════════════════
        if len(targets) <= 1:
            preview_tmp = os.path.join(active_path, "preview_tmp")
            try:
                if os.path.exists(preview_tmp):
                    shutil.rmtree(preview_tmp)
                os.makedirs(preview_tmp, exist_ok=True)

                if not apply_tier1_queue(queue, active_path, preview_tmp, log,
                                         cache_dir=cache_pipeline_dir):
                    shutil.rmtree(preview_tmp, ignore_errors=True)
                    respond_error("Fast transform fallito")
                    return

                out_files = [f for f in os.listdir(preview_tmp) if f.lower().endswith('.stl')]
                if not out_files:
                    shutil.rmtree(preview_tmp, ignore_errors=True)
                    respond_error("Nessun STL prodotto dal fast transform")
                    return

                invalid_stl = []
                for f in out_files:
                    size = os.path.getsize(os.path.join(preview_tmp, f))
                    if size < 134:
                        invalid_stl.append(f"{f} ({size} byte)")
                if invalid_stl:
                    shutil.rmtree(preview_tmp, ignore_errors=True)
                    respond_error(f"STL non validi: {', '.join(invalid_stl)}")
                    return

                # ColorReady L11.5: ri-proietta il colore del master (active/{stem}.ply) sulla
                # geometria del preview → preview .drc colorato (KILLER#1 chiuso, colore sopravvive
                # allo slider). Master .ply assente → colorless come oggi (byte-compat). Solo preview.
                compress_directory(preview_tmp, log, color_source_dir=active_path)
                os.sync()
                fs_mgr.fix_permissions(preview_tmp)

                # Swap atomico directory (path legacy)
                preview_old = os.path.join(active_path, "preview_old")
                if os.path.exists(preview_old):
                    shutil.rmtree(preview_old, ignore_errors=True)
                if os.path.exists(preview_dir):
                    os.rename(preview_dir, preview_old)
                os.rename(preview_tmp, preview_dir)
                if os.path.exists(preview_old):
                    shutil.rmtree(preview_old, ignore_errors=True)

                fs_mgr.fix_permissions(preview_dir)
                os.sync()

                log(f"[FAST DONE] {len(out_files)} mesh: {', '.join(out_files)}")
                respond_ok()

            except Exception as e:
                shutil.rmtree(preview_tmp, ignore_errors=True)
                respond_error(f"Errore fast transform: {e}")
            finally:
                _release_lock(pid)
            return

        # ═════════════════════════════════════════════════════════════════════
        # TIER C COORDINATOR: 2+ mesh → spawn N sub-task MESH_PIPELINE
        # ═════════════════════════════════════════════════════════════════════
        log(f"[FAST coordinator] {len(targets)} target paralleli: {targets}")

        notify_channel = f"pipeline_done_{pid}_{task_id}"
        abort_key = f"pipeline_abort_{pid}_{task_id}"
        partial_dirs = {
            t: os.path.join(active_path, f"preview_tmp_partial_{safe_target_name(t)}")
            for t in targets
        }
        sub_queues = {t: [s for s in queue if s.get('target') == t] for t in targets}

        try:
            # Cleanup pregresso (defensive — se coordinator precedente crashato)
            r.delete(notify_channel, abort_key)
            for d in partial_dirs.values():
                shutil.rmtree(d, ignore_errors=True)
                os.makedirs(d, exist_ok=True)

            # Garantisce esistenza preview/ per swap per-mesh dei sub-task
            os.makedirs(preview_dir, exist_ok=True)

            # Spawn N sub-task MESH_PIPELINE su coda dedicata.
            # Coda separata `ibex_tasks_pipeline` per priorità: il loop principale
            # del worker fa brpop multi-queue con pipeline first → evita starvation
            # dei sub-task quando arrivano nuovi FAST_TRANSFORM in `ibex_tasks`.
            for t in targets:
                sub_task = {
                    'action': 'MESH_PIPELINE',
                    'uid': uid,
                    'project_id': pid,
                    'project_name': p_name,
                    'target': t,
                    'sub_queue': sub_queues[t],
                    'preview_tmp_partial': partial_dirs[t],
                    'preview_id': task_id,
                    'notify_channel': notify_channel,
                    'abort_key': abort_key,
                    'cache_dir': cache_pipeline_dir,
                }
                r.rpush('ibex_tasks_pipeline', json.dumps(sub_task))

            log(f"[FAST coordinator] Spawn {len(targets)} sub-task su ibex_tasks_pipeline")

            # Wait completion con LIFO check + deadline 600s.
            # Per ogni completion: forward progress al frontend (Fase 3).
            completed_count = 0
            results = {}  # target -> {success, error}
            deadline = time.time() + 600  # 10 min cap totale

            while completed_count < len(targets):
                remaining = max(1, int(deadline - time.time()))
                if remaining <= 1:
                    r.set(abort_key, "1", ex=600)
                    respond_error(
                        f"Timeout sub-task ({completed_count}/{len(targets)} completati)")
                    return

                # LIFO check ad ogni iter (latest_preview cambiato → abort)
                try:
                    rl = int(float(r.get(f"latest_preview_{pid}") or 0))
                except Exception:
                    rl = 0
                if rl > task_id and rl != 999999999:
                    r.set(abort_key, "1", ex=600)
                    respond_error("Superata da preview più recente")
                    return

                # Brpop con timeout breve (ricontrolla LIFO/deadline)
                res = r.brpop(notify_channel, timeout=min(remaining, 5))
                if not res:
                    continue

                try:
                    done = json.loads(res[1])
                except Exception:
                    continue

                done_target = done.get('target')
                done_success = done.get('success', False)
                done_error = done.get('error')

                if done_target and done_target not in results:
                    results[done_target] = done
                    completed_count += 1
                    # Forward progress al frontend (Fase 3 — hot-swap incrementale)
                    respond_progress(done_target, done_success, done_error)
                    log(f"[FAST coordinator] {completed_count}/{len(targets)} done: "
                        f"{done_target} success={done_success}")

            # Best-effort: anche se 1+ fail, le mesh OK sono già swappate per-mesh.
            # Le mesh fail NON sono state swappate → preview/ mantiene versione precedente.
            failed = [t for t, d in results.items() if not d.get('success')]
            if failed:
                log(f"[FAST DONE Tier-C] WARN — {len(failed)}/{len(targets)} fail: {failed}. "
                    f"Mesh OK già swappate, mesh fail mantengono versione precedente (best-effort).")
            else:
                log(f"[FAST DONE Tier-C] {len(targets)} mesh: {', '.join(targets)}")

            # Final response sempre success=true (best-effort policy).
            # I sub-task fail sono stati notificati al frontend via progress messages.
            respond_ok()

        except Exception as e:
            respond_error(f"Errore coordinator: {e}")
        finally:
            # Cleanup partial dirs (i file utili sono già in preview/ via swap per-mesh).
            # NON tocchiamo notify_channel/abort_key — TTL li scaderà; sub-task
            # ancora in volo (raro) li userebbero per decidere se procedere.
            for d in partial_dirs.values():
                shutil.rmtree(d, ignore_errors=True)
            _release_lock(pid)

    elif action == 'PREVIEW_BAKE':
        response_channel = task.get('response_channel')

        def respond_error(msg):
            log(f"[PREVIEW ERR] {msg}")
            _deliver(response_channel, {'success': False, 'error': msg},
                     ttl=15, ctx='PREVIEW_BAKE/error')

        def respond_ok():
            _deliver(response_channel, {'success': True},
                     ttl=15, ctx='PREVIEW_BAKE/ok')

        status = r.get(f"project:{pid}:status")
        if status in ('baking', 'baked'):
            log(f"[DROP] Preview annullata — progetto in stato '{status}'")
            respond_error(f"Progetto in stato {status}")
            return

        try:
            task_id = int(task.get('preview_id', 0))
            redis_latest = int(float(r.get(f"latest_preview_{pid}") or 0))
        except Exception:
            task_id = 0
            redis_latest = 0

        highest_done = processed_previews.get(pid, 0)

        if task_id > 0 and (task_id <= highest_done or redis_latest == 999999999):
            log(f"[DROP LIFO] Scartata PREVIEW {task_id} (done={highest_done}, latest={redis_latest})")
            respond_error("Preview superata da una più recente")
            return

        processed_previews[pid] = max(highest_done, task_id)
        log(f"--- PREVIEW BAKE {pid} (ID: {task_id}) ---")

        queue = _strip_no_backend(task.get('queue', []), 'PREVIEW_BAKE')  # B9
        if not queue:
            respond_error("Queue vuota")
            return

        if not os.path.isdir(active_path):
            respond_error(f"Cartella attiva non trovata: {active_path}")
            return

        if not _acquire_lock(pid, ttl=120):
            respond_error("Lock non acquisito — operazione già in corso su questo progetto")
            return

        preview_dir = os.path.join(active_path, "preview")
        preview_tmp = os.path.join(active_path, "preview_tmp")
        tier1_out   = os.path.join(active_path, "preview_tier1_tmp")

        try:
            if os.path.exists(preview_tmp):
                shutil.rmtree(preview_tmp)
            os.makedirs(preview_tmp, exist_ok=True)

            # --- Tier routing (fix queue mista Tier 1 + Tier 2) ---
            # BAKE_PROJECT già fa questa separazione; la replichiamo qui per PREVIEW_BAKE.
            # Senza questo filtro, LogicBuilder cerca fast_transform.blend (inesistente)
            # e run_script() fallisce silenziosamente con [IBEX-ENGINE ERROR] GN File mancante.
            tier1_queue = [s for s in queue if s.get('tool') in TIER1_TOOLS]
            tier2_queue = [s for s in queue if s.get('tool') not in TIER1_TOOLS]

            # Step 1: applica Tier 1 via Trimesh se presenti (con cache pipeline Tier C Fase 1)
            if tier1_queue:
                if os.path.exists(tier1_out):
                    shutil.rmtree(tier1_out)
                os.makedirs(tier1_out, exist_ok=True)
                cache_pipeline_dir = os.path.join(active_path, ".cache_pipeline")
                if not apply_tier1_queue(tier1_queue, active_path, tier1_out, log,
                                         cache_dir=cache_pipeline_dir):
                    shutil.rmtree(tier1_out, ignore_errors=True)
                    respond_error("Fast transform fallito nel preview misto")
                    return
                log(f"[PREVIEW] Tier 1 applicato via Trimesh: {[s.get('tool') for s in tier1_queue]}")

            # Step 2: costruisci ed esegui lo script Blender solo per Tier 2
            if not tier2_queue:
                # Edge case: queue puramente Tier 1 arrivata come preview_bake per errore
                # (BakeEngine.js dovrebbe inviare fast_transform, ma gestiamo il caso).
                for f in os.listdir(tier1_out):
                    if f.lower().endswith('.stl'):
                        shutil.copy2(os.path.join(tier1_out, f), os.path.join(preview_tmp, f))
                shutil.rmtree(tier1_out, ignore_errors=True)
                tier1_out = None
                log(f"[PREVIEW] Solo Tier 1 in preview_bake — STL copiati direttamente")

            else:
                lb = LogicBuilder(active_path, preview_tmp)
                script = lb.build_script(
                    tier2_queue,
                    tier1_override=tier1_out if tier1_queue else None
                )

                try:
                    redis_latest_now = int(float(r.get(f"latest_preview_{pid}") or 0))
                except Exception:
                    redis_latest_now = 0

                if redis_latest_now > task_id and redis_latest_now != 999999999:
                    log(f"[DROP PRE-BLENDER] Preview {task_id} superata da {redis_latest_now}")
                    shutil.rmtree(preview_tmp, ignore_errors=True)
                    if tier1_out:
                        shutil.rmtree(tier1_out, ignore_errors=True)
                    respond_error("Superata da preview più recente")
                    return

                if not blender.run_script(script):
                    shutil.rmtree(preview_tmp, ignore_errors=True)
                    if tier1_out:
                        shutil.rmtree(tier1_out, ignore_errors=True)
                    respond_error("Errore esecuzione Blender")
                    return

                # Copia gli STL Tier 1 "orfani" (senza Tier 2 a valle) che Blender
                # non ha esportato (build_script usa export_all=False per il preview).
                if tier1_queue and tier1_out:
                    tier2_targets = {s.get('target') for s in tier2_queue}
                    for f in os.listdir(tier1_out):
                        if f.lower().endswith('.stl') and f not in tier2_targets:
                            dst = os.path.join(preview_tmp, f)
                            if not os.path.exists(dst):
                                shutil.copy2(os.path.join(tier1_out, f), dst)
                    shutil.rmtree(tier1_out, ignore_errors=True)
                    tier1_out = None

            # --- Validazione e swap atomico (invariati) ---
            out_files = [f for f in os.listdir(preview_tmp) if f.lower().endswith('.stl')]

            if not out_files:
                shutil.rmtree(preview_tmp, ignore_errors=True)
                respond_error("Nessun STL generato dal preview bake")
                return

            os.sync()

            invalid_stl = []
            for f in out_files:
                size = os.path.getsize(os.path.join(preview_tmp, f))
                if size < 134:
                    invalid_stl.append(f"{f} ({size} byte)")
            if invalid_stl:
                shutil.rmtree(preview_tmp, ignore_errors=True)
                respond_error(f"STL non validi: {', '.join(invalid_stl)}")
                return

            # ColorReady L11.5: ri-proiezione colore master → preview (vedi FAST_TRANSFORM).
            # ⚠️ PREVIEW_BAKE: gli STL preview_tmp li scrive Blender (tier2) → il sidecar
            # {stem}.mat.json NON è qui (sta in tier1_out) → target_matrix=None → NN diretta +
            # GATE distanze (colorless se il target è trasformato). Fail-safe.
            compress_directory(preview_tmp, log, color_source_dir=active_path)

            fs_mgr.fix_permissions(preview_tmp)

            preview_old = os.path.join(active_path, "preview_old")
            if os.path.exists(preview_old):
                shutil.rmtree(preview_old, ignore_errors=True)
            if os.path.exists(preview_dir):
                os.rename(preview_dir, preview_old)
            os.rename(preview_tmp, preview_dir)
            if os.path.exists(preview_old):
                shutil.rmtree(preview_old, ignore_errors=True)

            fs_mgr.fix_permissions(preview_dir)
            os.sync()

            log(f"[PREVIEW DONE] {len(out_files)} mesh pronti: {', '.join(out_files)}")
            respond_ok()

        except Exception as e:
            shutil.rmtree(preview_tmp, ignore_errors=True)
            if tier1_out and os.path.exists(tier1_out):
                shutil.rmtree(tier1_out, ignore_errors=True)
            respond_error(f"Preview bake fallita: {e}")
        finally:
            _release_lock(pid)

    elif action == 'SAVE_SNAPSHOT':
        # ═══════════════════════════════════════════════════════════════
        # SAVE_SNAPSHOT — Persistenza mesh destructive client-side (generico).
        #
        # SnapshotKeyed Session 2 (2026-04-24): rename da SAVE_SCULPT.
        # Handler generico per tutti i tool `destructive: true` in gn_meta.json:
        # sculpt, delete_topology, futuri split_topology. Il `tool_id` nel
        # payload è solo diagnostico (log); il naming file dipende da (mesh_name,
        # node_id) e NON da tool_id.
        #
        # Il PHP ha scritto il tmp file tramite move_uploaded_file:
        #   - Nuovo: `{active_path}/{stem}_snap_{nodeId}.stl.tmp`
        #   - Legacy (fallback): `{active_path}/{stem}_sculpted.stl.tmp`
        #
        # Flusso:
        #   1. Valida mesh_name + node_id (whitelist regex)
        #   2. Cerca il .tmp corrispondente, valida size (≥ 134B)
        #   3. os.replace → file finale
        #   4. trimesh.remove_unreferenced_vertices (utile per delete_topology —
        #      rimuove verts non referenziati dall'index dopo face removal)
        #   5. compress_stl → .drc per delivery browser
        #   6. fix_permissions(active_path) DOPO compress_stl
        #   7. respond_ok via Redis lpush sul canale snapshot_resp_{uid}_{pid}
        #
        # Nessun lock: operazione su file dedicato (per nodeId), non interferisce
        # con preview_bake / save_exit / bake_project di altri task.
        # ═══════════════════════════════════════════════════════════════
        # E2 (2026-07-14): la whitelist nodeId/toolId vive in config.validate_node_id
        # (sede unica). Prima era ricompilata qui a ogni SAVE_SNAPSHOT.

        response_channel = task.get('response_channel')
        mesh_name = task.get('mesh_name', '')
        node_id   = task.get('node_id')   # SnapshotKeyed S1: None per task legacy in coda
        tool_id   = task.get('tool_id')   # SnapshotKeyed S2: diagnostico (log only)

        def _snap_respond_error(msg):
            log(f"[SNAPSHOT ERR] {msg}")
            if response_channel:
                try:
                    r.lpush(response_channel, json.dumps({'success': False, 'error': msg}))
                    r.expire(response_channel, 15)
                except Exception:
                    pass

        def _snap_respond_ok(payload=None):
            if response_channel:
                try:
                    data = {'success': True}
                    if payload:
                        data.update(payload)
                    r.lpush(response_channel, json.dumps(data))
                    r.expire(response_channel, 15)
                except Exception:
                    pass

        if not mesh_name or not isinstance(mesh_name, str):
            _snap_respond_error("mesh_name mancante o invalido")
            return
        # Path-traversal guard mesh_name: solo basename con estensione .stl
        if '/' in mesh_name or '\\' in mesh_name or not mesh_name.lower().endswith('.stl'):
            _snap_respond_error(f"mesh_name non consentito: {mesh_name}")
            return

        # tool_id è solo diagnostico; whitelist difensiva (non impatta il naming file).
        if tool_id is not None and not validate_node_id(tool_id):
            log(f"[SNAPSHOT WARN] tool_id non conforme alla whitelist: {tool_id!r} — ignorato")
            tool_id = None

        stem = os.path.splitext(mesh_name)[0]
        tool_label = tool_id or 'unknown'

        if node_id is None:
            # Task legacy in coda al deploy (frontend pre-SnapshotKeyed_S1):
            # manteniamo il vecchio naming come fallback. Il log deprecation segnala
            # l'occorrenza; il file `_sculpted.stl` risultante sarà orfano dal punto
            # di vista del frontend aggiornato, che cerca `_snap_{nodeId}.stl`.
            log(f"[SNAPSHOT] DEPRECATED: node_id mancante nel payload per {mesh_name} "
                f"(tool={tool_label}), fallback a legacy naming _sculpted.stl")
            tmp_path    = os.path.join(active_path, f"{stem}_sculpted.stl.tmp")
            final_path  = os.path.join(active_path, f"{stem}_sculpted.stl")
            file_label  = f"{stem}_sculpted.stl (legacy)"
        else:
            # Nuovo schema: whitelist nodeId (impedisce path traversal via nodeId controllato
            # dal client — es. nodeId = "../../../etc/passwd" verrebbe rifiutato).
            if not validate_node_id(node_id):
                _snap_respond_error(f"node_id non conforme alla whitelist: {node_id!r}")
                return
            tmp_path    = os.path.join(active_path, f"{stem}_snap_{node_id}.stl.tmp")
            final_path  = os.path.join(active_path, f"{stem}_snap_{node_id}.stl")
            file_label  = f"{stem}_snap_{node_id}.stl"

        if not os.path.isfile(tmp_path):
            _snap_respond_error(f"File tmp non trovato: {tmp_path}")
            return

        try:
            size = os.path.getsize(tmp_path)
            if size < 134:
                try: os.unlink(tmp_path)
                except Exception: pass
                _snap_respond_error(f"STL non valido ({size} byte < 134)")
                return

            os.replace(tmp_path, final_path)

            # topology_rebuild V1.0 (2026-05-05): se accanto al .stl.tmp c'è
            # anche un .sel.json.tmp (face indices della selezione utente), lo
            # rinomina insieme. Per sculpt/delete_topology non è scritto, no-op.
            if node_id is not None:
                sel_tmp   = os.path.join(active_path, f"{stem}_snap_{node_id}.sel.json.tmp")
                sel_final = os.path.join(active_path, f"{stem}_snap_{node_id}.sel.json")
                if os.path.isfile(sel_tmp):
                    try:
                        os.replace(sel_tmp, sel_final)
                        log(f"[SNAPSHOT] selection file salvato: "
                            f"{stem}_snap_{node_id}.sel.json")
                    except Exception as e:
                        log(f"[SNAPSHOT WARN] selection rename fallito ({e}) — "
                            f"il tool topology_rebuild farà passthrough")

            # draw_curve V1.0 (2026-05-06): stesso pattern per il file
            # .crv.json (datablock di N splines Bezier). Il file è scritto da
            # PHP saveSnapshot quando arriva curve_blob nel POST. Pattern
            # identico al .sel.json: rename atomico insieme allo .stl.
            if node_id is not None:
                crv_tmp   = os.path.join(active_path, f"{stem}_snap_{node_id}.crv.json.tmp")
                crv_final = os.path.join(active_path, f"{stem}_snap_{node_id}.crv.json")
                if os.path.isfile(crv_tmp):
                    try:
                        os.replace(crv_tmp, crv_final)
                        log(f"[SNAPSHOT] curve file salvato: "
                            f"{stem}_snap_{node_id}.crv.json")
                    except Exception as e:
                        log(f"[SNAPSHOT WARN] curve rename fallito ({e}) — "
                            f"il consumer della curva avrà datablock stale")

            # SnapshotKeyed S2 (2026-04-24): cleanup verts orfani via trimesh.
            # Necessario per delete_topology (STLExporter di Three.js emette solo
            # triangoli presenti nell'index, ma al reload downstream con process=False
            # vogliamo garantire consistenza). No-op per sculpt (no verts orfani
            # da un semplice displacement). Costo ~200-500ms su 100k verts. S2-A3.
            try:
                import trimesh as _tm
                m = _tm.load(final_path, force='mesh', process=False)
                n_before = len(m.vertices)
                m.remove_unreferenced_vertices()
                n_after = len(m.vertices)
                if n_after < n_before:
                    m.export(final_path)
                    log(f"[SNAPSHOT] cleanup verts orfani: {n_before} → {n_after} "
                        f"({tool_label} / {file_label})")
            except ImportError:
                log(f"[SNAPSHOT WARN] trimesh non disponibile, skip cleanup verts")
            except Exception as e:
                log(f"[SNAPSHOT WARN] cleanup verts fallito (non blocca save): {e}")

            # Draco side-car per delivery client al prossimo reload/hotswap
            try:
                from modules.draco_encoder import compress_stl
                compress_stl(final_path, logger=log)
            except Exception as e:
                log(f"[SNAPSHOT WARN] compress_stl fallita (non blocca save): {e}")

            # fix_permissions DOPO compress_stl così anche il .drc diventa www-data
            fs_mgr.fix_permissions(active_path)

            # Size refresh dopo cleanup (potrebbe essere cambiato)
            try:
                size = os.path.getsize(final_path)
            except Exception:
                pass

            log(f"[SNAPSHOT OK] {tool_label}: {file_label} salvato ({size} byte)")
            resp = {'mesh_name': mesh_name, 'size': size}
            if node_id is not None:
                resp['node_id'] = node_id
            if tool_id is not None:
                resp['tool_id'] = tool_id
            _snap_respond_ok(resp)
        except Exception as e:
            log(f"[SNAPSHOT ERR] {e}")
            _snap_respond_error(str(e))

    elif action == 'SAVE_SPLIT':
        # ═══════════════════════════════════════════════════════════════
        # SAVE_SPLIT — Persistenza snapshot multi-output per split_topology.
        #
        # SnapshotKeyed Session 3 (2026-04-25): nuova action per il nodo
        # `split_topology` che produce 2 mesh distinte invece di 1.
        #
        # Il PHP ha scritto 2 tmp files via move_uploaded_file:
        #   - `{active_path}/{stem}_snap_{nodeId}_A.stl.tmp`
        #   - `{active_path}/{stem}_snap_{nodeId}_B.stl.tmp`
        #
        # Contratto task (payload Redis):
        #   action          = 'SAVE_SPLIT'
        #   uid, project_id
        #   mesh_name       — mesh master (es. "Upper.stl")
        #   node_id         — ID Drawflow del nodo split (whitelist regex)
        #   tool_id         — 'split_topology' (diagnostico, opzionale)
        #   response_channel— tipicamente "snapshot_resp_{uid}_{pid}"
        #
        # Flusso:
        #   1. Valida mesh_name + node_id + tool_id (tutti whitelist)
        #   2. Per entrambi A/B: cerca tmp, valida size ≥134B, os.replace → final
        #   3. Per entrambi: trimesh.remove_unreferenced_vertices (utile per split
        #      perché la geometry lato client condivide il position buffer con
        #      la mesh master → molti verts orfani post-separazione)
        #   4. Per entrambi: compress_stl → .drc
        #   5. fix_permissions
        #   6. respond_ok via Redis lpush con entrambi i nomi + size
        #
        # Fallback legacy NON supportato: split è nuovo in S3, nessun client
        # pre-S3 può inviare una SAVE_SPLIT senza node_id.
        # ═══════════════════════════════════════════════════════════════
        # E2 (2026-07-14): whitelist nodeId/toolId → config.validate_node_id (sede unica).

        response_channel = task.get('response_channel')
        mesh_name = task.get('mesh_name', '')
        node_id   = task.get('node_id')
        tool_id   = task.get('tool_id')

        def _split_respond_error(msg):
            log(f"[SPLIT ERR] {msg}")
            if response_channel:
                try:
                    r.lpush(response_channel, json.dumps({'success': False, 'error': msg}))
                    r.expire(response_channel, 15)
                except Exception:
                    pass

        def _split_respond_ok(payload=None):
            if response_channel:
                try:
                    data = {'success': True}
                    if payload:
                        data.update(payload)
                    r.lpush(response_channel, json.dumps(data))
                    r.expire(response_channel, 15)
                except Exception:
                    pass

        if not mesh_name or not isinstance(mesh_name, str):
            _split_respond_error("mesh_name mancante o invalido")
            return
        if '/' in mesh_name or '\\' in mesh_name or not mesh_name.lower().endswith('.stl'):
            _split_respond_error(f"mesh_name non consentito: {mesh_name}")
            return

        if not validate_node_id(node_id):
            _split_respond_error(f"node_id non conforme alla whitelist: {node_id!r}")
            return

        if tool_id is not None and not validate_node_id(tool_id):
            log(f"[SPLIT WARN] tool_id non conforme alla whitelist: {tool_id!r} — ignorato")
            tool_id = None
        tool_label = tool_id or 'split_topology'

        stem = os.path.splitext(mesh_name)[0]
        branches = [
            ('A', f"{stem}_snap_{node_id}_A.stl"),
            ('B', f"{stem}_snap_{node_id}_B.stl"),
        ]

        # Pre-check: entrambi i tmp devono esistere PRIMA di procedere (atomicità).
        missing = []
        for (branch, fname) in branches:
            tmp_path = os.path.join(active_path, f"{fname}.tmp")
            if not os.path.isfile(tmp_path):
                missing.append(f"branch={branch} path={tmp_path}")
        if missing:
            _split_respond_error(f"File tmp non trovati: {missing}")
            return

        results = []
        try:
            for (branch, fname) in branches:
                tmp_path   = os.path.join(active_path, f"{fname}.tmp")
                final_path = os.path.join(active_path, fname)

                size = os.path.getsize(tmp_path)
                if size < 134:
                    try: os.unlink(tmp_path)
                    except Exception: pass
                    _split_respond_error(f"STL branch {branch} non valido ({size} byte < 134)")
                    return

                os.replace(tmp_path, final_path)

                # Cleanup verts orfani (utile per split — client serializza sempre
                # il position buffer completo, molti verts orfani post-separazione).
                try:
                    import trimesh as _tm
                    m = _tm.load(final_path, force='mesh', process=False)
                    n_before = len(m.vertices)
                    m.remove_unreferenced_vertices()
                    n_after = len(m.vertices)
                    if n_after < n_before:
                        m.export(final_path)
                        log(f"[SPLIT] branch {branch} cleanup verts orfani: "
                            f"{n_before} → {n_after} ({fname})")
                except ImportError:
                    log(f"[SPLIT WARN] trimesh non disponibile, skip cleanup verts branch {branch}")
                except Exception as e:
                    log(f"[SPLIT WARN] cleanup verts branch {branch} fallito (non blocca): {e}")

                # Draco side-car per delivery browser
                try:
                    from modules.draco_encoder import compress_stl
                    compress_stl(final_path, logger=log)
                except Exception as e:
                    log(f"[SPLIT WARN] compress_stl branch {branch} fallita (non blocca): {e}")

                # Size refresh post-cleanup
                try:
                    size = os.path.getsize(final_path)
                except Exception:
                    pass

                results.append({'branch': branch, 'mesh_name': fname, 'size': size})
                log(f"[SPLIT OK] {tool_label} branch {branch}: {fname} salvato ({size} byte)")

            fs_mgr.fix_permissions(active_path)

            resp = {
                'mesh_name': mesh_name,
                'node_id': node_id,
                'branches': results,
            }
            if tool_id is not None:
                resp['tool_id'] = tool_id
            _split_respond_ok(resp)
        except Exception as e:
            log(f"[SPLIT ERR] {e}")
            _split_respond_error(str(e))

    elif action == 'MESH_PIPELINE':
        # Tier C — executor sub-task (2026-04-30).
        # Spawned dal coordinator FAST_TRANSFORM. Processa la sub-pipeline per
        # UN singolo target, fa swap PER-MESH atomico in preview/, notifica
        # completion via channel pipeline_done_{pid}_{preview_id}.
        # NESSUN _acquire_lock — il coordinator hold ibex_lock_{pid} per la
        # durata totale.
        target = task.get('target')
        sub_queue = _strip_no_backend(task.get('sub_queue', []), 'MESH_PIPELINE')  # B9
        preview_tmp_partial = task.get('preview_tmp_partial')
        parent_preview_id = int(task.get('preview_id', 0) or 0)
        notify_channel = task.get('notify_channel')
        abort_key = task.get('abort_key')
        cache_dir = task.get('cache_dir')

        def _mp_notify(success, error=None):
            if notify_channel:
                try:
                    payload = {'target': target, 'success': bool(success)}
                    if error:
                        payload['error'] = str(error)
                    r.lpush(notify_channel, json.dumps(payload))
                    r.expire(notify_channel, 600)
                except Exception:
                    pass

        if not target or not sub_queue or not preview_tmp_partial:
            log(f"[PIPELINE ERR] task malformato: target={target!r}, "
                f"sub_queue_len={len(sub_queue) if sub_queue else 0}")
            _mp_notify(False, "task malformato")
            return

        # Pre-check abort cooperativo
        if abort_key and r.exists(abort_key):
            log(f"[PIPELINE] abort flag set per {target}, skip")
            _mp_notify(False, "abort")
            return

        # LIFO secondario (latest_preview cambiato durante la coda)
        try:
            rl_pipe = int(float(r.get(f"latest_preview_{pid}") or 0))
        except Exception:
            rl_pipe = 0
        if parent_preview_id > 0 and rl_pipe > parent_preview_id and rl_pipe != 999999999:
            log(f"[PIPELINE] superata da preview più recente, skip {target}")
            _mp_notify(False, "superato")
            return

        if not os.path.isdir(active_path):
            log(f"[PIPELINE ERR] active_path mancante: {active_path}")
            _mp_notify(False, f"active_path mancante")
            return

        preview_dir = os.path.join(active_path, "preview")

        t0 = time.time()
        try:
            os.makedirs(preview_tmp_partial, exist_ok=True)
            os.makedirs(preview_dir, exist_ok=True)

            # Esegui sub-pipeline (cache pipeline attiva)
            if not apply_tier1_queue(sub_queue, active_path, preview_tmp_partial, log,
                                     cache_dir=cache_dir):
                _mp_notify(False, "apply_tier1_queue fallito")
                return

            # Validate STL prodotti
            out_files = [f for f in os.listdir(preview_tmp_partial) if f.lower().endswith('.stl')]
            if not out_files:
                _mp_notify(False, "nessun STL prodotto")
                return

            invalid = []
            for f in out_files:
                size = os.path.getsize(os.path.join(preview_tmp_partial, f))
                if size < 134:
                    invalid.append(f"{f} ({size}B)")
            if invalid:
                _mp_notify(False, f"STL non validi: {invalid}")
                return

            # Compress (genera .drc nella partial dir)
            # ColorReady L11.5: ri-proiezione colore master → preview (Tier C / per-mesh).
            # Il sidecar {stem}.mat.json è scritto qui da apply_tier1_queue → target_matrix corretto.
            compress_directory(preview_tmp_partial, log, color_source_dir=active_path)
            os.sync()
            fs_mgr.fix_permissions(preview_tmp_partial)

            # Swap PER-MESH atomico (file rename, NO directory rename).
            # Ordine: .drc PRIMA, .stl DOPO. Frontend Draco usa .drc come
            # priorità; in caso di window inconsistenza ~1ms tra rename, è
            # meglio avere .drc fresco + .stl stale che il contrario.
            partial_files = os.listdir(preview_tmp_partial)
            # ④ FastReload sidecar: .mat.json swappa INSIEME alla geometria (dopo .stl)
            # → il fan-out Tier C non reintroduce la race in piccolo (coppia coerente).
            for ext in ('.drc', '.stl', '.mat.json'):
                for f in partial_files:
                    if not f.lower().endswith(ext):
                        continue
                    src = os.path.join(preview_tmp_partial, f)
                    dst = os.path.join(preview_dir, f)
                    if not os.path.exists(src):
                        continue  # già spostato (es. .drc già dopo prima iter)
                    try:
                        os.replace(src, dst)  # atomic rename, replaces dest
                    except OSError as e:
                        log(f"[PIPELINE WARN] rename {f} fallito: {e}")

            fs_mgr.fix_permissions(preview_dir)
            os.sync()

            dur_ms = int((time.time() - t0) * 1000)
            log(f"[PIPELINE OK] target={target} files={out_files} dur={dur_ms}ms")
            _mp_notify(True)

        except Exception as e:
            log(f"[PIPELINE ERR] target={target} err={e}")
            _mp_notify(False, str(e))
        # NON cleanup partial_dir qui — coordinator lo fa nel suo finally.

    elif action == 'RENAME_SAVE':
        # RINOMINA-SALVA (23/7): la rinomina E' un salvataggio. PHP ha gia' rinominato
        # {old}.ibex -> {new}.ibex + filecache + manifest + registry (STESSO pid); qui si
        # aggiorna il CONTENUTO ri-zippando active/{pid} nel .ibex col nome nuovo.
        # active/ NON viene purgata (scheda aperta), nessun pid nuovo, nessuna cancellazione.
        # Fallimento -> .ibex col contenuto precedente + active/ intatta: nessuna perdita,
        # nessun orfano (il primo save successivo riallinea).
        try:
            if not os.path.isdir(active_path):
                log(f"[RENAME_SAVE] active assente pid={pid} - skip (niente da ri-zippare)")
            elif fs_mgr.create_flat_zip(
                    active_path, cloud_ibex_path,
                    exclude_dirs=['baked','baked_output','preview_tmp',
                                  'preview_tier1_tmp','sculpt_cache',
                                  '.cache_pipeline','.cache_sdf','.cache_pml']):
                log(f"[RENAME_SAVE] OK pid={pid} '{p_name}' - .ibex allineato al contenuto corrente")
            else:
                log(f"[RENAME_SAVE] create_flat_zip FALLITO pid={pid} - active/ intatta, nessuna perdita")
        except Exception as e:
            log(f"[RENAME_SAVE] errore pid={pid}: {e}")
    elif action == 'SAVE_EXIT':
        # ═══════════════════════════════════════════════════════════════
        # SAVE_EXIT — Salvataggio non-distruttivo della sessione.
        #
        # Salva lo stato del DAG senza applicare trasformazioni agli STL master.
        # Gli STL restano in coordinate scanner originali (invariante V13.0).
        # Il bake distruttivo avviene solo all'export finale (futuro).
        #
        # FastReload (2026-05-02): l'archivio .ibex INCLUDE preview/ così che al
        # reload la mesh in WS sia immediatamente disponibile senza ri-bake.
        # Il frontend ripristina `appliedMatFlat` per ogni mesh + i `preview_baked_params`
        # già nei nodi DAG → applyGraph() calcola il delta corretto e non riapplica
        # due volte la matrice (vedi invariante 42 aggiornata).
        #
        # FastReload V18.3 (2026-05-02): active_path PURGATO al termine di SAVE_EXIT.
        # Pattern simmetrico: ogni progetto chiuso = 1 purge → spazio disco liberato
        # subito invece di accumulare in attesa della dashboard. Al prossimo open,
        # LOAD_PROJECT extract del .ibex ricostruisce active_path COMPLETO (master +
        # scene.blend + preview/ + manifest) → fast reload funziona perché preview/ è
        # nel zip. Trade-off accettato: ~3-5s extract al reload diretto vs <1s con
        # cache calda, ma indipendenza dalla dashboard come unico cleanup trigger
        # (utile per scaling commerciale dove gli utenti potrebbero non visitare la
        # lista progetti).
        # ═══════════════════════════════════════════════════════════════
        uid    = task.get('uid')
        pid    = task.get('project_id')
        p_name = task.get('project_name', '')
        log(f"--- SAVE EXIT {pid} ---")

        active_path      = os.path.join(ACTIVE_BASE, uid, str(pid))
        cloud_ibex_path  = os.path.join(CLOUD_BASE, uid, 'files', 'IBEX', f"{p_name}.ibex")

        # PUNTO4-FETTA-D (2026-07-28) — D1. Flag di successo del salvataggio: parte
        # False e diventa True in UN SOLO punto, dopo che `create_flat_zip` ha
        # ritornato True e il `.ibex` e' stato riscritto. Il `finally` in fondo gata
        # su di lei la SOLA purga di active_path. Dichiarata PRIMA del lock cosi' la
        # variabile esiste su ogni percorso che arriva al finally.
        saved_ok = False

        if not _acquire_lock(pid, ttl=30):
            # Un FAST_TRANSFORM/PREVIEW potrebbe tenere ancora il lock: attendi il rilascio
            # invece di skippare (lo skip lasciava lo stato 'queued' per sempre).
            _got = False
            for _ in range(10):          # ~20s
                time.sleep(2)
                if _acquire_lock(pid, ttl=30):
                    _got = True
                    break
            if not _got:
                _rt = int(task.get('_save_retry', 0))
                if _rt < 3:
                    task['_save_retry'] = _rt + 1
                    r.rpush('ibex_tasks', json.dumps(task))
                    log(f"[SAVE_EXIT] Lock occupato PID {pid}, re-enqueue (tentativo {_rt+1}/3)")
                else:
                    log(f"[SAVE_EXIT ERR] Lock occupato PID {pid} dopo 3 re-enqueue — forzo ready per non lasciare stuck")
                    _set_status(pid, 'ready')
                return

        try:
            # Pre-flight: verifica che scene.blend e tutti gli STL master siano accessibili.
            # Su Unraid shfs (FUSE), i file possono apparire in os.listdir ma essere
            # transientemente inaccessibili a os.stat durante operazioni del mover.
            scene_blend = os.path.join(active_path, 'scene.blend')
            if not os.path.exists(scene_blend):
                log(f"[SAVE_EXIT ERR] scene.blend non trovato in {active_path} — save annullato, archivio .ibex preservato")
                return

            # Esclude i `_sculpted.stl` (legacy) e gli `{stem}_snap_{nodeId}.stl`
            # (SnapshotKeyed S1) dal manifest: sono versioni modificate delle
            # mesh master, NON mesh indipendenti da ricaricare al reopen. PHP editor()
            # ha un filtro equivalente come safety per manifest legacy (pre-fix).
            stl_files = [
                f for f in os.listdir(active_path)
                if _is_master_stl(f)
            ]
            missing = [f for f in stl_files if not os.path.isfile(os.path.join(active_path, f))]
            if missing:
                log(f"[SAVE_EXIT ERR] STL non accessibili: {missing} — save annullato, archivio .ibex preservato")
                return
            # ManifestSoT (2026-05-02): il manifest.json è già stato scritto
            # ATOMICAMENTE da PHP saveExit() PRIMA di accodare questo task. Contiene
            # version=3.0, input_files, baked=false, timestamp, session={...} (SoT).
            # Il worker NON lo riscrive — semplicemente verifica che esista.
            # Forza fsync per visibilità FUSE prima del zip (PHP scrive su mount
            # condiviso, può esserci write-back delay sotto Unraid shfs).
            manifest_path = os.path.join(active_path, 'manifest.json')
            if not os.path.isfile(manifest_path):
                log(f"[SAVE_EXIT ERR] manifest.json mancante in {active_path} — PHP saveExit() ha fallito? Save annullato.")
                return
            try:
                fd = os.open(manifest_path, os.O_RDONLY)
                os.fsync(fd)
                os.close(fd)
            except OSError as e:
                log(f"[SAVE_EXIT WARN] fsync manifest.json: {e}")

            # Ciclo-vita 2026-07-13 (Legge 1) — prune LRU della cache SDF
            # per-progetto PRIMA del zip: sdf/ viaggia nel .ibex, tenere solo
            # i K .npz più recenti contiene la moltiplicazione per-variante
            # (l'hash cambia a ogni modifica del solido upstream).
            SDF_KEEP = 4
            sdf_dir = os.path.join(active_path, 'sdf')
            if os.path.isdir(sdf_dir):
                try:
                    npz = sorted(
                        (f for f in os.listdir(sdf_dir) if f.endswith('.npz')),
                        key=lambda f: os.path.getmtime(os.path.join(sdf_dir, f)),
                        reverse=True)
                    for fname in npz[SDF_KEEP:]:
                        os.unlink(os.path.join(sdf_dir, fname))
                    if len(npz) > SDF_KEEP:
                        log(f"[SAVE_EXIT] prune sdf/: {len(npz) - SDF_KEEP} .npz rimossi (keep {SDF_KEEP})")
                except OSError as e:
                    log(f"[SAVE_EXIT WARN] prune sdf/: {e}")

            # FastReload (2026-05-02): preview/ INCLUSA nel .ibex (era esclusa pre-fix).
            # Il bake è già stato fatto in questa sessione: salvarne il risultato evita
            # che l'utente debba aspettare un ricalcolo completo al prossimo open.
            # Il frontend ripristina `appliedMatFlat` per ogni mesh dal session_settings,
            # così applyGraph() vede la matrice già applicata e non riapplica (vedi inv. 42).
            # Restano escluse: cartelle temp di volo (preview_tmp, preview_tmp_partial_*,
            # preview_tier1_tmp), output bake distruttivo (baked, baked_output), cache effimere.
            if fs_mgr.create_flat_zip(
                active_path, cloud_ibex_path,
                exclude_dirs=['baked', 'baked_output', 'preview_tmp',
                              'preview_tier1_tmp', 'sculpt_cache', '.cache_pipeline', '.cache_sdf',
                              '.cache_pml'],
                required_files=['scene.blend'],
                thumb_png=_read_client_thumb(active_path)
            ):
                log(f"[SAVE_EXIT] PID {pid} salvato. Archivio .ibex aggiornato.")
                saved_ok = True   # PUNTO4-FETTA-D — UNICO punto in cui diventa True.

                # ═════════════════════════════════════════════════════════════
                # SnapshotKeyed Session 1 (2026-04-23) — Lazy cleanup snapshot orfani.
                #
                # Nuovo schema: il client invia `snapshot_nodes` = lista di
                # [{mesh: "Upper.stl", nodeId: "5"}] per ogni nodo DAG destructive
                # (gn_meta.json `destructive: true`, es. sculpt). Qui eliminiamo
                # i file `{stem}_snap_{nodeId}.stl` + `.drc` la cui coppia
                # (stem, nodeId) NON è in quella lista (= nodo rimosso dall'utente).
                #
                # Backward compat: se il task contiene `sculpted_meshes` (frontend
                # pre-SnapshotKeyed_S1 — task in coda al deploy), applichiamo il
                # cleanup vecchio stile su `_sculpted.stl/.drc`. Il contratto
                # nuovo `snapshot_nodes` prevale se entrambi presenti.
                #
                # Cleanup aggiuntivo legacy: in presenza di `snapshot_nodes`,
                # eliminiamo SEMPRE eventuali `{stem}_sculpted.stl/.drc` rimasti
                # (progetti pre-deploy con sculpt V2 BVH nel .ibex). S1-A6:
                # "i progetti salvati pre-deploy perdono lo snapshot" — li
                # eliminiamo dall'active_path così da non trascinarli nei
                # prossimi .ibex.
                #
                # Guard: nessuna delle due chiavi presente → no cleanup (task
                # frammentato / malformato). Errori non falliscono SAVE_EXIT.
                # ═════════════════════════════════════════════════════════════
                if 'snapshot_nodes' in task:
                    snapshot_nodes = task.get('snapshot_nodes', []) or []
                    keep_pairs = set()
                    if isinstance(snapshot_nodes, list):
                        for item in snapshot_nodes:
                            if not isinstance(item, dict):
                                continue
                            m = item.get('mesh', '')
                            nid = item.get('nodeId', '')
                            if (isinstance(m, str) and m.lower().endswith('.stl')
                                    and isinstance(nid, str) and nid):
                                keep_pairs.add((os.path.splitext(m)[0], nid))

                    # SnapshotKeyed S3 (2026-04-25, S3-NA7 opt c): regex matcha
                    # sia il pattern single-output `_snap_{nodeId}.stl`
                    # (sculpt/delete_topology) sia il pattern multi-output
                    # `_snap_{nodeId}_A.stl` / `_B.stl` (split_topology).
                    # topology_rebuild V1.0 (2026-05-05): aggiunta estensione
                    # `.sel.json` per il file di selezione collaterale (face
                    # indices della selezione utente). Cleanup speculare a .stl/.drc.
                    # draw_curve V1.0 (2026-05-06): aggiunta `.crv.json` per
                    # datablock curve Bezier (collateral del nodo draw_curve).
                    # Per lo split, `keep_pairs` contiene `(stem, nodeId)` del nodo
                    # split → preservare entrambi i branch A/B se il nodo è attivo.
                    # Match group 3 è il branch opzionale (None per single-output).
                    import re as _re_cleanup
                    _SNAP_RX = _re_cleanup.compile(
                        r'^(.+)_snap_([^._]+)(?:_([AB]))?\.(stl|drc|sel\.json|crv\.json|recompute_seq)$'
                    )

                    removed_new = []
                    removed_legacy = []
                    try:
                        for fname in os.listdir(active_path):
                            match = _SNAP_RX.match(fname)
                            if match:
                                stem, nid = match.group(1), match.group(2)
                                # branch = 'A' | 'B' | None (None = single-output)
                                # Non influenza la decisione keep: se (stem, nodeId) è
                                # in keep_pairs, preserva TUTTI i file matching (inclusi
                                # i due branch A/B dello split + legacy single-output).
                                if (stem, nid) in keep_pairs:
                                    continue
                                try:
                                    os.unlink(os.path.join(active_path, fname))
                                    removed_new.append(fname)
                                except Exception as e:
                                    log(f"[SAVE_EXIT] cleanup snap unlink err su {fname}: {e}")
                                continue
                            # Legacy cleanup unconditional: progetti pre-deploy avevano
                            # `_sculpted.stl/.drc` e il contratto nuovo non li riconosce.
                            if fname.endswith('_sculpted.stl') or fname.endswith('_sculpted.drc'):
                                try:
                                    os.unlink(os.path.join(active_path, fname))
                                    removed_legacy.append(fname)
                                except Exception as e:
                                    log(f"[SAVE_EXIT] cleanup sculpted-legacy unlink err su {fname}: {e}")
                    except Exception as e:
                        log(f"[SAVE_EXIT] cleanup listdir err: {e}")
                    if removed_new:
                        log(f"[SAVE_EXIT] snap cleanup: {len(removed_new)} file orfani eliminati "
                            f"(keep={sorted(keep_pairs)})")
                    if removed_legacy:
                        log(f"[SAVE_EXIT] legacy sculpted cleanup: {len(removed_legacy)} file "
                            f"(_sculpted.stl/.drc da progetti pre-SnapshotKeyed_S1)")
                elif 'sculpted_meshes' in task:
                    # Backward compat: task in coda al deploy con payload legacy.
                    # Il frontend aggiornato invia `snapshot_nodes`; questo ramo gira solo
                    # per task Redis pushati dal frontend vecchio.
                    sculpted_meshes = task.get('sculpted_meshes', []) or []
                    if isinstance(sculpted_meshes, list):
                        keep_stems = {
                            os.path.splitext(m)[0]
                            for m in sculpted_meshes
                            if isinstance(m, str) and m.lower().endswith('.stl')
                        }
                        removed = []
                        try:
                            for fname in os.listdir(active_path):
                                if fname.endswith('_sculpted.stl'):
                                    stem = fname[:-len('_sculpted.stl')]
                                elif fname.endswith('_sculpted.drc'):
                                    stem = fname[:-len('_sculpted.drc')]
                                else:
                                    continue
                                if stem in keep_stems:
                                    continue
                                try:
                                    os.unlink(os.path.join(active_path, fname))
                                    removed.append(fname)
                                except Exception as e:
                                    log(f"[SAVE_EXIT] cleanup sculpt-legacy unlink err su {fname}: {e}")
                        except Exception as e:
                            log(f"[SAVE_EXIT] cleanup sculpt-legacy listdir err: {e}")
                        if removed:
                            log(f"[SAVE_EXIT] legacy sculpt cleanup (task pre-S1): "
                                f"{len(removed)} file orfani (keep={sorted(keep_stems)})")
            else:
                # Fallimento zip: .ibex immutato (atomic write rollback).
                # PUNTO4-FETTA-A (2026-07-28): qui c'era «session_settings già in DB →
                # progetto comunque apribile», FALSO dal de-DB (2026-07-20). Non esiste
                # più alcun DB: `manifest.session` è l'UNICA sede della sessione (Inv. 69).
                # Il progetto riapre all'ultimo salvataggio RIUSCITO; la sessione corrente
                # non è recuperabile da nessun'altra parte.
                log(f"[SAVE_EXIT] Zip fallito per PID {pid} — .ibex precedente preservato: il progetto riapre all'ultimo salvataggio riuscito. La sessione corrente NON è in alcun DB (de-DB) → nessun recupero oltre quel .ibex")
        except Exception as e:
            log(f"[SAVE_EXIT ERR] {e}")
        finally:
            # FastReload V18.3 (2026-05-02): purge full di active_path al termine
            # di SAVE_EXIT. Sostituisce i cleanup mirati precedenti (.cache_pipeline,
            # .cache_sdf legacy, preview_tmp_partial_*) — ora ridondanti perché tutta
            # la cartella viene rimossa.
            #
            # Pre-condizione: il `.ibex` su Nextcloud è già aggiornato (try success)
            # OPPURE il .ibex precedente è preservato per atomic write rollback (try
            # fail). In entrambi i casi, il prossimo LOAD_PROJECT extract ricostruisce
            # active_path correttamente (master + scene.blend + preview/ + manifest).
            #
            # Trade-off: riapertura diretta paga ~3-5s di extract invece di <1s con
            # active calda. Vantaggio: spazio disco liberato subito, indipendenza
            # dalla dashboard come unico cleanup trigger (scaling commerciale).
            # PUNTO4-FETTA-D (2026-07-28) — D1: la purga era INCONDIZIONATA, e ci si
            # arrivava da CINQUE strade senza un `.ibex` aggiornato — tre delle quali
            # sono `return` DENTRO il try (scene.blend assente, STL non accessibili,
            # manifest.json mancante) che eseguono comunque questo finally. Post de-DB
            # la sessione corrente vive SOLO in `active/manifest.json`: su un save
            # fallito si cancellava l'UNICA copia mentre il `.ibex` restava indietro.
            #
            # Perche' e' sicuro NON purgare a fallimento: `active/` che sopravvive =
            # progetto CALDO -> alla riapertura `editor()` la usa direttamente
            # (FastReload) e l'utente ritrova la sua sessione. E il janitor non la
            # purga al posto nostro: il suo criterio e' il MATCH del digest, e su un
            # save fallito il digest di `active/manifest.json` NON combacia con
            # l'header del `.ibex` vecchio -> `skip:unsaved-mismatch`
            # (`janitor_logic.py:62-63`). Nessun accumulo: al primo save riuscito la
            # purga avviene, e l'orfano-per-eta' resta la rete del janitor.
            if saved_ok:
                try:
                    if fs_mgr.purge_active_cache(active_path):
                        log(f"[SAVE_EXIT] active_path purgato (FastReload V18.3): {active_path}")
                    else:
                        log(f"[SAVE_EXIT WARN] purge_active_cache fallito su {active_path}")
                except Exception as purge_err:
                    log(f"[SAVE_EXIT WARN] purge_active_cache exception: {purge_err}")
            else:
                log(f"[SAVE_EXIT] PUNTO4-FETTA-D: save NON riuscito per PID {pid} — "
                    f"active_path PRESERVATO ({active_path}). La sessione corrente e' "
                    f"recuperabile alla riapertura (FastReload); il janitor non la purga "
                    f"(digest disallineato -> skip:unsaved-mismatch).")
            # Sempre: riporta status='ready'. PHP saveExit() l'ha settato a 'queued'
            # per proteggere dalla purga dashboard durante il worker; ora che il
            # worker ha finito (successo o fallimento), libera lo status. Con il
            # purge esplicito sopra, la dashboard non ha più nulla da pulire qui —
            # ma il pattern blacklist resta valido per altri progetti in volo.
            _set_status(pid, 'ready')
            _release_lock(pid)


# V5.13 BootCleanup (2026-04-30) — Avvia thread heartbeat + cleanup orphan locks.
# Daemon=True → si chiudono automaticamente quando il main thread (loop brpop) termina.
log(f"[BOOT] WORKER_ID={WORKER_ID}")
log(f"[BOOT] Avvio heartbeat thread (refresh ibex_alive_{WORKER_ID} ogni {ALIVE_REFRESH_INTERVAL}s, TTL {ALIVE_TTL}s)")
threading.Thread(target=_heartbeat_worker, daemon=True, name='heartbeat').start()
log(f"[BOOT] Avvio cleanup orphan locks thread (warmup {CLEANUP_WARMUP}s, poi ciclo {CLEANUP_INTERVAL}s)")
threading.Thread(target=_cleanup_orphan_locks, daemon=True, name='cleanup').start()
log(f"[BOOT] Avvio janitor thread S6 (warmup {JANITOR_WARMUP}s, ciclo {JANITOR_INTERVAL}s, grace {JANITOR_GRACE}s)")
threading.Thread(target=_janitor, daemon=True, name='janitor').start()

# de-DB 2026-07-20: rebuild one-shot dell'indice Redis dai .ibex (un worker solo, elezione NX).
# In un thread per non ritardare il boot / il consumo della coda.
threading.Thread(target=_registry_rebuild, daemon=True, name='registry-rebuild').start()


while True:
    try:
        # Tier C (2026-04-30): multi-queue brpop con priorità a `ibex_tasks_pipeline`.
        # I sub-task MESH_PIPELINE hanno priorità più alta dei FAST_TRANSFORM/
        # PREVIEW_BAKE/INIT in `ibex_tasks` per evitare starvation: il coordinator
        # FAST_TRANSFORM brpop su pipeline_done_* aspettando i sub-task; se i
        # worker liberi continuassero a peschare nuovi FAST_TRANSFORM (priorità
        # più alta), i sub-task non verrebbero mai processati → deadlock.
        res = r.brpop(["ibex_tasks_pipeline", "ibex_tasks"], timeout=5)
        if res:
            queue_name, payload = res[0], res[1]
            task_data = json.loads(payload)
            log(f"Task da {queue_name}: {task_data.get('action')} (PID: {task_data.get('project_id')})")
            process_task(task_data)
            # V5.14 MallocTrim: rilascia heap inutilizzato al kernel dopo OGNI
            # task. Punto unico nel main loop → copre tutti i branch di
            # process_task (INIT/LOAD/BAKE/FAST/PREVIEW/MESH_PIPELINE/SAVE_*).
            # Costo trascurabile (~1-5ms), beneficio significativo su task
            # heavy che lasciano heap fragmentato. Vedi invariante 109.
            _trim_memory()
    except redis.ConnectionError as e:
        log(f"Redis disconnected: {e}. Reconnecting...")
        time.sleep(3)
        try:
            r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASS, db=0, decode_responses=True, socket_keepalive=True, socket_timeout=30, socket_connect_timeout=10, health_check_interval=30, retry_on_timeout=True)
            r.ping()
            log("Redis reconnected.")
        except Exception:
            pass
    except json.JSONDecodeError as e:
        log(f"JSON decode error: {e}")
    except Exception as e:
        log(f"Main Loop Error: {e}")
        time.sleep(1)
