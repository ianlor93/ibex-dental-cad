"""PASSO B (2026-07-21) — criterio del janitor, in un modulo a sé così worker.py
E il diagnostico _janitor_decide.py usano la STESSA logica (nessun mirror che possa
divergere). Zero side-effect all'import (nessuna connessione): `r` e `grace` passati
come parametri."""
import os
import time
import json
from .ibex_crypto import canonical_session_digest, read_header_meta


def pids_with_queued_jobs(r):
    """Set di project_id (int) presenti come task in ibex_tasks / ibex_tasks_pipeline.
    Guardia di LIVENESS: non purgare un pid con lavoro in coda — un SAVE_EXIT/bake sta
    per toccarlo, e il digest da solo non lo vede (l'autosave a 15s può non aver ancora
    aggiornato active/manifest.json). O(coda) una volta per ciclo."""
    pids = set()
    try:
        for q in ('ibex_tasks', 'ibex_tasks_pipeline'):
            for raw in r.lrange(q, 0, -1):
                try:
                    pid = json.loads(raw).get('project_id')
                    if pid is not None:
                        pids.add(int(pid))
                except Exception:
                    continue
    except Exception:
        pass
    return pids


def janitor_verdict(manifest_path, ibex_path, pid_str, queued_pids, grace):
    """Verdetto di purga per un active_dir con .ibex PRESENTE. Ritorna 'purge' oppure
    'skip:<motivo>'. Il janitor VERIFICA, non deduce.

    Purga SOLO se: ① il digest della sessione in active/manifest.json coincide col
    session_digest nell'header gen-2 del .ibex (DURABILITÀ, lettura PARZIALE di 41 B,
    nessun decrypt dei 105 MB) · ② nessun job in coda per il pid (LIVENESS) · ③ idle
    >= grace. Header project_id ≠ pid → m6 (archivio sbagliato). Header senza digest
    (IBX1 / IBX2 gen-1) → non verificabile → non toccare (si sblocca al prossimo save)."""
    if not os.path.isfile(manifest_path):
        return 'skip:no-manifest'
    if int(pid_str) in queued_pids:
        return 'skip:queued'                # ② liveness
    try:
        if time.time() - os.path.getmtime(manifest_path) < grace:
            return 'skip:idle'              # ③ idle < grace → probabile editor vivo
    except OSError:
        return 'skip:no-manifest'
    try:
        with open(manifest_path) as _mf:
            _sess = (json.load(_mf) or {}).get('session')
        _dg_active = canonical_session_digest(_sess)
        with open(ibex_path, 'rb') as _bf:
            _head = _bf.read(41)            # solo l'header gen-2: NIENTE decrypt del payload
        _meta = read_header_meta(_head)
    except Exception:
        return 'skip:read-error'
    if _meta is None:
        return 'skip:old-header'            # IBX1 / IBX2 gen-1 → non verificabile
    if _meta['project_id'] != int(pid_str):
        return 'skip:m6-wrong-archive'      # m6: non è il tuo archivio
    if _meta['session_digest'] != _dg_active:
        return 'skip:unsaved-mismatch'      # sessione non (ancora) nel .ibex
    return 'purge'                          # ① provato salvato
