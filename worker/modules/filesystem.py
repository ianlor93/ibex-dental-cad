import os
import shutil
import time
import json
import zipfile
import tempfile
from .config import USER_UID, USER_GID


def safe_target_name(target):
    """Sanifica un nome di target per usarlo come nome di CARTELLA.

    Estratta da fast_transform.py il 2026-07-14 (scorporo E3). Usata per:
      · le sottocartelle della cache pipeline  (.cache_pipeline/{safe_target}/)
      · le cartelle temporanee del fan-out Tier C (preview_tmp_partial_{safe_target})

    ⚠️ NON È UNA GUARDIA ANTI-PATH-TRAVERSAL. Sostituisce solo '/', '\\' e lo spazio:
    i '..' SOPRAVVIVONO intatti. Non rinominarla `sanitize_path()` o simili — un nome
    del genere inviterebbe qualcuno a fidarsene per la sicurezza, e non regge quel peso.
    La guardia vera sugli identificativi che arrivano dal client è
    `config.validate_node_id` (whitelist).

    ⚠️ L'IMPLEMENTAZIONE NON VA CAMBIATA. L'output è il nome di cartelle GIÀ ESISTENTI
    sul disco: se cambia anche di un solo carattere, tutte le cache `.cache_pipeline/`
    dei progetti in corso diventano irraggiungibili (orfane) e la memoization riparte
    da zero, senza che nulla lo segnali.
    """
    return target.replace('/', '_').replace('\\', '_').replace(' ', '_')


class FilesystemManager:
    def __init__(self, logger):
        self.logger = logger

    def fix_permissions(self, path):
        """Applica permessi totali (777) per permettere al PHP di cancellare"""
        try:
            # Tenta chown (potrebbe fallire se non root, ma chmod 777 funziona sempre su file propri)
            try: os.chown(path, USER_UID, USER_GID)
            except Exception: pass
            
            if os.path.isdir(path): os.chmod(path, 0o777)
            else: os.chmod(path, 0o666)
            
            for root, dirs, files in os.walk(path):
                for d in dirs:
                    fp = os.path.join(root, d)
                    try: os.chown(fp, USER_UID, USER_GID)
                    except Exception: pass
                    os.chmod(fp, 0o777) # Directory executable
                for f in files:
                    fp = os.path.join(root, f)
                    try: os.chown(fp, USER_UID, USER_GID)
                    except Exception: pass
                    os.chmod(fp, 0o666) # File read/write
            
            self.logger(f"[FS] Permissions fixed for: {path}")
        except Exception as e:
            self.logger(f"[FS ERR] Permission fix failed: {e}")

    def create_flat_zip(self, source_dir, output_file, exclude_dirs=None, required_files=None, thumb_png=None):
        # Pipeline 2-fasi per resilienza FUSE:
        #   Fase A — Staging FUSE → /tmp locale (container overlayfs, non-FUSE).
        #            Paga il costo di accesso FUSE UNA SOLA VOLTA per file: con retry
        #            lungo a backoff crescente [2,5,15,30,60] (≈112s max per file).
        #            Questo elimina il "cycling" tra file diversi che affliggeva la
        #            versione precedente (retry su file A completa, file B diventa
        #            inaccessibile, l'outer retry rifà il walk e trova B inaccessibile).
        #   Fase B — Zip + cifratura IBX2 (gen-3) in /tmp locale (Legge 2, 2026-07-13):
        #            sul cloud viene scritto SOLO il blob cifrato (.ibex.tmp
        #            ciphertext + os.replace atomico). Nessun retry: storage
        #            locale è affidabile.
        #
        # Parametri:
        #   - exclude_dirs: nomi di sottocartelle da escludere
        #                   (default {'baked', 'baked_output'} — output export locali
        #                   ricostruibili ricalcolando il DAG, non parte del .ibex)
        #   - required_files: lista di arcname che DEVONO essere presenti; se mancano
        #     solleva ValueError → il caller può riprovare
        _exclude = set(exclude_dirs) if exclude_dirs else {'baked', 'baked_output'}
        stage_dir = None
        tmp_zip = None
        local_zip = None
        try:
            # --- FASE A: Staging da FUSE a /tmp locale ---
            stage_dir = tempfile.mkdtemp(prefix='ibex_zip_', dir='/tmp')
            self.logger(f"[FS STAGE] Staging in {stage_dir}")

            # os.sync() prima del primo os.walk: forza la coerenza FUSE.
            os.sync()

            staged_count = 0
            for root, dirs, files in os.walk(source_dir):
                rel_root = os.path.relpath(root, source_dir)
                if any(part in _exclude for part in rel_root.split(os.sep)):
                    continue
                # Ricrea la struttura di sottocartelle dentro stage_dir
                if rel_root != '.':
                    os.makedirs(os.path.join(stage_dir, rel_root), exist_ok=True)
                for file in files:
                    if file.startswith('.'):
                        continue
                    # Mai zippare upload transitori (.tmp in attesa di promozione
                    # SAVE_SNAPSHOT/SAVE_SPLIT) nel .ibex (C9, 2026-07-13)
                    if file.endswith('.tmp'):
                        continue
                    src = os.path.join(root, file)
                    arcname = os.path.relpath(src, source_dir)
                    dst = os.path.join(stage_dir, arcname)
                    # Retry breve per protezione da glitch transitori (FUSE sync,
                    # fsync in corso, brief IO contention). La root cause (race condition
                    # con dashboard purge) è risolta in PHP: i file non spariscono più.
                    # Retry lungo non porta benefici — solo latenza.
                    _delays = [1, 3, 5]
                    for _attempt, _delay in enumerate(_delays + [None]):
                        try:
                            shutil.copy2(src, dst)
                            staged_count += 1
                            break
                        except FileNotFoundError:
                            if _delay is None:
                                raise
                            self.logger(f"[FS STAGE WARN] (tentativo {_attempt+1}) attendo {_delay}s: {src}")
                            time.sleep(_delay)

            self.logger(f"[FS STAGE] {staged_count} file copiati in {stage_dir}")

            # Verifica pre-zip: i file obbligatori sono tutti nel stage?
            if required_files:
                missing = [f for f in required_files
                           if not os.path.isfile(os.path.join(stage_dir, f))]
                if missing:
                    raise ValueError(f"File obbligatori assenti dallo staging (FUSE miss): {missing}")

            # --- FASE B (Legge 2, 2026-07-13): zip + cifratura in /tmp LOCALE;
            #     sul cloud del cliente arriva SOLO il blob .ibex (IBX2) finale — il
            #     plaintext non tocca mai il datadir Nextcloud (né come .ibex.tmp).
            zip_fd, local_zip = tempfile.mkstemp(prefix='ibex_zip_', suffix='.zip', dir='/tmp')
            os.close(zip_fd)

            with zipfile.ZipFile(local_zip, 'w', zipfile.ZIP_DEFLATED) as zipf:
                for root, _, files in os.walk(stage_dir):
                    for file in files:
                        file_path = os.path.join(root, file)
                        arcname = os.path.relpath(file_path, stage_dir)
                        # Nessun retry: stage_dir è storage locale (overlayfs) affidabile
                        zipf.write(file_path, arcname=arcname)

            # Verifica post-build (paranoia check): required_files presenti nel zip finale?
            if required_files:
                with zipfile.ZipFile(local_zip, 'r') as _check:
                    _names = _check.namelist()
                    _missing = [f for f in required_files if f not in _names]
                    if _missing:
                        raise ValueError(f"File obbligatori assenti dal zip finale: {_missing}")

            # Cifratura a riposo IBX2 in /tmp: il plaintext vive solo su storage
            # locale (mai sul pool nextcloud, niente blocchi ZFS CoW in chiaro)
            from .ibex_crypto import pack_ibx2, canonical_session_digest
            # PASSO B (2026-07-21): il session_digest nasce QUI, dagli STESSI byte che
            # stiamo archiviando (il manifest.json già staged) e viaggia nell'header
            # IBX2 gen-2 nello STESSO os.replace atomico → esiste sse il save riesce e
            # descrive esattamente ciò che è dentro l'archivio. project_id anche in
            # header (m6: il janitor scarta l'archivio sbagliato con ~41 byte). Se il
            # manifest manca/è illeggibile → digest None → gen-1 (il janitor non purga).
            _sess_dg = None
            _pid_hdr = None
            _burn = {}
            try:
                with open(os.path.join(stage_dir, 'manifest.json')) as _mf:
                    _m = json.load(_mf) or {}
                _sess_dg = canonical_session_digest(_m.get('session'))
                _pid_hdr = int(_m.get('project_id'))
                # IBEX-GEN3-28-7: il record di burn (Inv. 125) entra nell'header gen-3
                # come TERZA sede — durevole come il manifest E leggibile dal tier web
                # come Redis. Si legge da manifest['burn'] TOP-LEVEL: dentro `session`
                # non ci va MAI (ci passa il digest del janitor). Assente → {}.
                _b = _m.get('burn')
                _burn = _b if isinstance(_b, dict) else {}
            except Exception as _e:
                self.logger(f"[FS] session_digest non calcolato ({_e}) → IBX2 gen-1 senza digest")
                _sess_dg = None
                _pid_hdr = None
                _burn = {}
            with open(local_zip, 'rb') as _ef:
                _plain = _ef.read()
            _blob = pack_ibx2(_plain, thumb_png, project_id=_pid_hdr,
                              session_digest=_sess_dg, burn=_burn)

            # Sul cloud SOLO ciphertext: tmp nella dir di destinazione (stesso
            # filesystem → os.replace atomico), poi rename sul .ibex finale
            out_dir = os.path.dirname(output_file)
            if out_dir:
                os.makedirs(out_dir, exist_ok=True)
            tmp_fd, tmp_zip = tempfile.mkstemp(dir=out_dir or '.', suffix='.ibex.tmp')
            with os.fdopen(tmp_fd, 'wb') as _of:
                _of.write(_blob)
                _of.flush()
                os.fsync(_of.fileno())   # durabilita' (fold-in 23/7): blocchi del .ibex su disco PRIMA del replace
            # Rename atomico: sostituisce output_file solo se tutto ok
            os.replace(tmp_zip, output_file)
            tmp_zip = None   # promosso: nessun unlink nell'except (fold-in 23/7)
            # dir-fsync (cintura-e-bretelle, fold-in 23/7): rende durevole la voce di directory.
            # GUARDATO: shfs/FUSE puo' non supportarlo -> non deve MAI far fallire un save.
            try:
                _dfd = os.open(out_dir or '.', os.O_RDONLY)
                try: os.fsync(_dfd)
                finally: os.close(_dfd)
            except Exception as _de:
                self.logger(f"[FS] dir-fsync non supportato, proseguo ({_de})")
            tmp_zip = None  # ora è output_file, non va eliminato
            self.fix_permissions(output_file)
            return True
        except Exception as e:
            if tmp_zip and os.path.exists(tmp_zip):
                try: os.unlink(tmp_zip)
                except Exception: pass
            self.logger(f"[FS ERR] Zip fail: {e}")
            return False
        finally:
            if local_zip and os.path.exists(local_zip):
                try: os.unlink(local_zip)
                except OSError: pass
            if stage_dir and os.path.exists(stage_dir):
                shutil.rmtree(stage_dir, ignore_errors=True)

    def purge_active_cache(self, active_path):
        if os.path.exists(active_path):
            try: shutil.rmtree(active_path); return True
            except Exception: return False
        return True