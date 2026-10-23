"""
IBEX Draco Encoder — Compressione mesh per delivery browser.
Converte STL → .drc (Google Draco standalone).

Quantizzazione: 14-bit posizione → ±0.004mm a scala 60mm (display-only, non operativo).
Il formato STL rimane il formato interno del worker (Blender, Trimesh, bake).
Draco .drc è puramente un layer di delivery al browser.

Requires: DracoPy (pip install DracoPy)
Fail silenzioso se DracoPy non installato → worker funziona senza Draco.
"""

import os
from concurrent.futures import ThreadPoolExecutor, as_completed

DRACO_POSITION_BITS = 14
DRACO_NORMAL_BITS   = 10
DRACO_LEVEL         = 7   # 0-10: 7 = buon bilanciamento velocità/ratio

# ColorReady L11.5 — soglia del GATE spazio della ri-proiezione colore.
# Il target ri-proiettato deve GIACERE sulla superficie del master: se la distanza NN
# mediana supera _REPROJECT_TAU × diagonale-BBox-master, gli spazi NON coincidono
# (transform non compensato, geometria estranea) → colorless, MAI colore scrambled.
# 0.02 = 2% della diagonale: un remesh (meshcleaner) tiene i vertici sulla superficie
# (NN ~ edge-length, << 2%); un transform di ≥ pochi mm su un'arcata li allontana oltre.
_REPROJECT_TAU = 0.02


def compress_stl(stl_path: str, drc_path: str = None, logger=None) -> bool:
    """Comprime un singolo STL in Draco .drc. Ritorna True se OK, False altrimenti (no raise)."""
    if drc_path is None:
        drc_path = stl_path.rsplit('.', 1)[0] + '.drc'
    tmp_path = None
    try:
        import DracoPy
        import trimesh
        import numpy as np

        # ─── ColorReady L11.3 (2026-07-24): color-source sidecar {stem}.ply ───
        # Il PLY è SOLO server-side (viaggia nel .ibex, MAI servito al browser: il client
        # fetcha solo .drc/.stl). Se accanto allo STL esiste un PLY a vertex-color REALE,
        # encoda geometria+colore DAL PLY → Draco riordina/de-duplica posizione E colore in
        # lockstep (allineamento corretto per costruzione). Master STL = identità, mai toccato.
        # Fail-safe assoluto: a QUALUNQUE dubbio → colorless dallo STL, MAI un .drc rotto.
        src    = None
        colors = None
        ply_path = stl_path.rsplit('.', 1)[0] + '.ply'
        if os.path.exists(ply_path):
            try:
                cmesh = trimesh.load(ply_path, force='mesh', process=False)
                # ⚠️ mesh.visual.vertex_colors è GENERATIVA: su una mesh SENZA colore ritorna
                # bianco (non None). L'unico discriminante affidabile è visual.kind == 'vertex'.
                if (cmesh is not None and hasattr(cmesh, 'vertices') and len(cmesh.vertices) > 0
                        and getattr(getattr(cmesh, 'visual', None), 'kind', None) == 'vertex'):
                    vc = np.ascontiguousarray(cmesh.visual.vertex_colors[:, :3], dtype=np.uint8)
                    if vc.shape[0] == len(cmesh.vertices):
                        src, colors = cmesh, vc
                    elif logger:
                        logger(f'[Draco] {os.path.basename(ply_path)}: colori disallineati '
                               f'({vc.shape[0]}≠{len(cmesh.vertices)}) → colorless')
            except Exception as e:
                if logger:
                    logger(f'[Draco] color-source {os.path.basename(ply_path)} illeggibile ({e}) → colorless')
                src, colors = None, None

        # Geometria: dal PLY se colorato e valido, altrimenti dallo STL (comportamento attuale).
        if src is None:
            src = trimesh.load(stl_path, force='mesh', process=False)
        if src is None or not hasattr(src, 'vertices') or len(src.vertices) == 0:
            if logger:
                logger(f'[Draco] Mesh vuota o non valida: {stl_path}')
            return False

        def _encode(_mesh, _colors):
            # colors=None → firma IDENTICA a pre-L11.3 (nessun kwarg colors) → byte-compat
            # col path colorless attuale. colors!=None → uint8 (L11.1: DracoPy rifiuta float32).
            _kw = dict(quantization_bits=DRACO_POSITION_BITS, compression_level=DRACO_LEVEL,
                       quantization_range=-1, quantization_origin=None)
            if _colors is not None:
                _kw['colors'] = _colors
            return DracoPy.encode(_mesh.vertices.astype(np.float64),
                                  _mesh.faces.astype(np.uint32), **_kw)

        try:
            draco_bytes = _encode(src, colors)
        except Exception as e:
            if colors is None:
                raise    # errore sul path base (colorless) → gestito dal catch esterno, come oggi
            # Encode col colore fallito → NON perdere il .drc: ricadi su STL colorless.
            if logger:
                logger(f'[Draco] encode colorato fallito ({e}) → fallback colorless {os.path.basename(stl_path)}')
            base = trimesh.load(stl_path, force='mesh', process=False)
            draco_bytes = _encode(base, None)

        # Write atomico (C9, 2026-07-13): un reader concorrente (serve_file/
        # DRACOLoader) non deve mai vedere un .drc troncato mid-write. Il tmp
        # dot-prefixed non entra mai nel .ibex (skip dot-file dello zip).
        tmp_path = os.path.join(os.path.dirname(drc_path) or '.',
                                '.' + os.path.basename(drc_path) + f'.tmp-{os.getpid()}')
        with open(tmp_path, 'wb') as f:
            f.write(draco_bytes)
        os.replace(tmp_path, drc_path)
        tmp_path = None

        if os.path.getsize(drc_path) < 1:
            os.unlink(drc_path)
            return False

        if logger:
            orig  = os.path.getsize(stl_path)
            comp  = os.path.getsize(drc_path)
            ratio = orig / comp if comp > 0 else 0
            logger(f'[Draco] {os.path.basename(stl_path)}: {orig // 1024}KB → {comp // 1024}KB ({ratio:.1f}x)')
        return True

    except ImportError:
        if logger:
            logger('[Draco] DracoPy non installato — skip compressione')
        return False
    except Exception as e:
        if logger:
            logger(f'[Draco] Errore su {stl_path}: {e}')
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        # Un .drc stale (geometria precedente) è peggio di nessun .drc:
        # MeshLoader fa fallback su STL fresco se il side-car manca.
        if drc_path and os.path.exists(drc_path):
            try:
                os.unlink(drc_path)
            except Exception:
                pass
        return False


def reproject_vertex_color(master_ply: str, target_stl: str, out_ply: str,
                           logger=None, target_matrix=None) -> bool:
    """
    ColorReady L11.5 — ri-proietta il colore per-vertice del MASTER colorato sulla geometria
    del TARGET (il preview STL, tipicamente rimeshato) via nearest-neighbour (scipy.cKDTree)
    e scrive `out_ply` = geometria del TARGET + colore ri-proiettato. `compress_stl` lo pescherà
    come `{stem}.ply` fratello → colora il preview `.drc` (zero modifiche a compress_stl).

    `target_matrix`: opzionale, la world matrix (flat 16, row-major) APPLICATA al target dalla
    pipeline (dal sidecar `{stem}.mat.json`). Il tool `transform` cuoce la matrice nel preview
    STL (`fast_transform.py`: `mesh.apply_transform`) → il target è in WORLD space mentre il
    master `.ply` è in SCANNER space. Per una NN corretta riportiamo il target in scanner-space
    (M^-1) PRIMA della query; senza compensazione la NN in coordinate assolute mapperebbe ogni
    vertice al master sbagliato (colore «scrambled»). Se la matrice manca o è identità, il target
    è già in scanner-space e la query è diretta.

    🔴 Fail-safe assoluto: a QUALUNQUE dubbio (master assente / `kind`≠vertex / load/query/export
    falliti / len mismatch / GATE spazio non superato) → return False, `out_ply` NON scritto →
    il preview resta colorless (`compress_stl` carica lo STL). MAI un raise che rompa il bake.
    """
    try:
        import trimesh
        import numpy as np
        from scipy.spatial import cKDTree

        # ── Master colorato (gate colore REALE come L11.3: vertex_colors è generativa) ──
        master = trimesh.load(master_ply, force='mesh', process=False)
        if (master is None or not hasattr(master, 'vertices') or len(master.vertices) == 0
                or getattr(getattr(master, 'visual', None), 'kind', None) != 'vertex'):
            return False
        master_verts = np.asarray(master.vertices, dtype=np.float64)
        master_cols  = np.ascontiguousarray(master.visual.vertex_colors[:, :3], dtype=np.uint8)
        if master_cols.shape[0] != master_verts.shape[0] or master_verts.shape[0] == 0:
            return False

        # ── Target (preview) ──
        target = trimesh.load(target_stl, force='mesh', process=False)
        if target is None or not hasattr(target, 'vertices') or len(target.vertices) == 0:
            return False
        target_verts = np.asarray(target.vertices, dtype=np.float64)

        # ── Spazio comune: inverse-transform se il target è stato trasformato ──
        query_verts = target_verts
        if target_matrix is not None:
            try:
                M = np.asarray(target_matrix, dtype=np.float64).reshape(4, 4)
                if not np.allclose(M, np.eye(4)):
                    Minv  = np.linalg.inv(M)   # singolare → LinAlgError → gate distanze decide
                    homog = np.column_stack([target_verts, np.ones(len(target_verts))])
                    query_verts = (homog @ Minv.T)[:, :3]
            except Exception:
                query_verts = target_verts

        dist, idx = cKDTree(master_verts).query(query_verts, k=1)

        # ── GATE spazio (fail-safe): il target ri-proiettato deve giacere sul master ──
        diag = float(np.linalg.norm(master_verts.max(axis=0) - master_verts.min(axis=0)))
        if diag <= 0:
            return False
        med = float(np.median(dist))
        if med > _REPROJECT_TAU * diag:
            if logger:
                logger(f'[Draco] reproject {os.path.basename(target_stl)}: spazi non allineati '
                       f'(median NN {med:.3f} > {_REPROJECT_TAU}·diag {diag:.1f}) → colorless')
            return False

        target_cols = master_cols[idx]   # (N_target, 3) uint8, allineato a target_verts per costruzione

        # out_ply = geometria del TARGET (invariata) + colore ri-proiettato. process=False:
        # nessun merge/reorder → i vertici restano allineati a target.faces (compress_stl li
        # rileggerà con process=False → stessa geometria del preview STL).
        colored = trimesh.Trimesh(vertices=target.vertices, faces=target.faces,
                                  vertex_colors=target_cols, process=False)
        # Write atomico (tmp dot-prefixed + os.replace), stesso pattern di compress_stl: un
        # export interrotto non lascia mai un {stem}.ply parziale che compress_stl leggerebbe.
        # Il tmp dot-prefixed non entra nel .ibex (skip dot-file dello zip). Oggi la reproject
        # gira sequenziale pre-ThreadPool (nessun reader concorrente) → difesa in profondità +
        # future-proof se un domani la reproject venisse parallelizzata.
        _ptmp = os.path.join(os.path.dirname(out_ply) or '.',
                             '.' + os.path.basename(out_ply) + f'.tmp-{os.getpid()}')
        # file_type='ply' ESPLICITO: il tmp ha estensione '.tmp-{pid}' → trimesh non può
        # inferire il formato dall'estensione (solleverebbe "%s exporter not available").
        colored.export(_ptmp, file_type='ply')
        os.replace(_ptmp, out_ply)
        return True

    except Exception as e:
        if logger:
            logger(f'[Draco] reproject fallito {os.path.basename(target_stl)}: {e} → colorless')
        # best-effort: rimuovi il tmp parziale (dot-prefixed → comunque fuori dallo zip .ibex)
        try:
            if '_ptmp' in dir() and _ptmp and os.path.exists(_ptmp):
                os.remove(_ptmp)
        except Exception:
            pass
        return False


def compress_directory(dir_path: str, logger=None, color_source_dir=None) -> int:
    """
    Comprime tutti gli .stl in una directory in .drc (in parallelo, N thread).
    Ritorna il numero di file compressi con successo.

    ColorReady L11.5 — `color_source_dir` (opzionale): dir del master colorato (`active_path`).
    Se dato, PRIMA del ThreadPool, per ogni `{stem}.stl` che NON ha già un `{stem}.ply` fratello
    ma per cui esiste `color_source_dir/{stem}.ply`, ri-proietta il colore del master sulla
    geometria del preview (`reproject_vertex_color`) scrivendo `dir_path/{stem}.ply`. Poi il
    ThreadPool è INVARIATO: `compress_stl` trova il `.ply` fratello e colora il preview `.drc`.
    `color_source_dir=None` (default) → comportamento IDENTICO a pre-L11.5 (byte-compat: nessun
    `.ply` scritto, nessun colore). I siti master non passano il param (il `.ply` master è già
    fratello in `active/`, usato da L11.3).
    """
    stl_files = [
        os.path.join(dir_path, f)
        for f in os.listdir(dir_path)
        if f.lower().endswith('.stl')
    ]
    if not stl_files:
        return 0

    # ── ColorReady L11.5: ri-proiezione colore master → preview (sequenziale, pre-ThreadPool) ──
    if color_source_dir:
        import json as _json
        for p in stl_files:
            stem_dir = os.path.dirname(p)
            stem     = os.path.splitext(os.path.basename(p))[0]
            sibling_ply = os.path.join(stem_dir, stem + '.ply')       # colore già presente?
            master_ply  = os.path.join(color_source_dir, stem + '.ply')
            if os.path.exists(sibling_ply) or not os.path.exists(master_ply):
                continue
            # matrice applicata (dal sidecar `{stem}.mat.json` nella stessa dir del preview,
            # scritto da apply_tier1_queue). Assente per Blender-PREVIEW_BAKE → None → NN diretta
            # + GATE distanze (colorless se il target è trasformato senza compensazione).
            _mat = None
            try:
                _matp = os.path.join(stem_dir, stem + '.mat.json')
                if os.path.exists(_matp):
                    with open(_matp) as _f:
                        _mat = _json.load(_f)
            except Exception:
                _mat = None
            try:
                reproject_vertex_color(master_ply, p, sibling_ply, logger, target_matrix=_mat)
            except Exception as _e:
                if logger:
                    logger(f'[Draco] reproject exception {os.path.basename(p)}: {_e} → colorless')

    max_workers = min(len(stl_files), os.cpu_count() or 2)
    count = 0
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(compress_stl, p, None, logger): p for p in stl_files}
        for fut in as_completed(futures):
            if fut.result():
                count += 1
    return count
