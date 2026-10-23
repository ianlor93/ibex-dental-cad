"""slice — nodo Tier 1: wrapper sottile sopra ibex_primitives.slice_plane.
apply(src_path, params, output_path, logger) -> bool. La geometria sta nella libreria."""

import numpy as np
import trimesh
from ibex_primitives.slice_plane import slice_plane


def _as_vec3(val, fallback):
    try:
        a = np.asarray(val, dtype=np.float64).reshape(-1)
        if a.shape[0] >= 3:
            return a[:3]
    except Exception:
        pass
    return np.asarray(fallback, dtype=np.float64)


def apply(src_path, params, output_path, logger):
    try:
        mesh = trimesh.load(src_path, force='mesh', process=False)
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] slice load '{src_path}': {e}")
        return False

    origin = _as_vec3(params.get('G1_Origine_VEC'), [0.0, 0.0, 0.0])
    normal = _as_vec3(params.get('G2_Normale_VEC'), [0.0, 0.0, 1.0])
    cap = bool(params.get('G3_Cap', True))

    if float(np.linalg.norm(normal)) < 1e-9:
        logger("[FAST] [IBEX-ENGINE ERROR] slice: normale piano nulla")
        return False

    logger(f"[FAST] slice IN: {len(mesh.vertices)} verts {len(mesh.faces)} faces "
           f"origin={origin.tolist()} normal={normal.tolist()} cap={cap}")
    try:
        sliced = slice_plane(mesh, origin, normal, cap=cap)
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] slice_plane: {e}")
        return False

    if sliced is None or len(sliced.faces) == 0:
        logger("[FAST] [IBEX-ENGINE ERROR] slice: risultato vuoto (piano scarta tutta la mesh?)")
        return False

    try:
        data = sliced.export(file_type='stl')   # bytes binari (no ASCII, lezione V3.19)
        with open(output_path, 'wb') as f:
            f.write(data)
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] slice export: {e}")
        return False

    logger(f"[FAST] slice OUT: {len(sliced.vertices)} verts {len(sliced.faces)} faces")
    return True
