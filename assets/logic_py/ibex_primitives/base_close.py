"""Base-close primitive — chiusura di un contorno con Delaunay 2D (cap triangolato).

Estratto verbatim da modelgenerator._close_base_delaunay (FASE 1). Dato un ring
di punti base + un offset di indice globale + una direzione di estrusione (per
orientare le facce), triangola il cap via Delaunay 2D (proiezione PCA/SVD) con
filtro point-in-polygon. Indici globali e direzione sono forniti dal chiamante.

Pura Python (scipy/matplotlib/numpy), niente bpy/DAG/worker.
"""
import numpy as np
from scipy.spatial import Delaunay
from matplotlib.path import Path


def _close_base_delaunay(base_sample, base_offset, extrude_dir):
    """Chiude la base con Delaunay 2D + filtro point-in-polygon. PCA SVD per
    projection 2D. Triangoli orientati concordi a extrude_dir.
    """
    M = len(base_sample)
    if M < 3:
        return np.array([], dtype=np.int32).reshape(0, 3)

    center = base_sample.mean(axis=0)
    centered = base_sample - center
    _, _, Vt = np.linalg.svd(centered, full_matrices=False)
    u_ax, v_ax = Vt[0], Vt[1]
    pts_2d = np.column_stack([centered @ u_ax, centered @ v_ax])

    try:
        tri = Delaunay(pts_2d)
    except Exception:
        return np.array([], dtype=np.int32).reshape(0, 3)
    simplices = tri.simplices
    if len(simplices) == 0:
        return np.array([], dtype=np.int32).reshape(0, 3)

    polygon = Path(pts_2d)
    centroids = pts_2d[simplices].mean(axis=1)
    inside = polygon.contains_points(centroids)
    simplices_in = simplices[inside]
    if len(simplices_in) == 0:
        return np.array([], dtype=np.int32).reshape(0, 3)

    v0 = base_sample[simplices_in[:, 0]]
    v1 = base_sample[simplices_in[:, 1]]
    v2 = base_sample[simplices_in[:, 2]]
    tri_normals = np.cross(v1 - v0, v2 - v0)
    sign = (tri_normals @ extrude_dir) > 0
    oriented = simplices_in.copy()
    oriented[~sign] = oriented[~sign][:, [0, 2, 1]]

    return (oriented + base_offset).astype(np.int32)
