"""Helper geometrici condivisi tra primitivi e orchestrazione (FASE 1).

Funzioni pure numpy estratte da modelgenerator: signed area (shoelace) +
normale di Newell. Importate da ibex_primitives.offset_loop (signed area) e
dall'orchestrazione _build_base (newell normal, per derivare extrude_dir).
Pura Python (numpy), niente bpy/DAG/worker. Nessuna dipendenza primitivo→device.
"""
import numpy as np


def _polygon_signed_area_2d(pts_xy):
    """Signed area di un poligono chiuso 2D via shoelace (CCW positive, CW negative)."""
    x = pts_xy[:, 0]
    y = pts_xy[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _newell_normal(pts):
    """Normale del poligono via algoritmo di Newell (somma cross product edge-by-edge)."""
    n = len(pts)
    normal = np.zeros(3)
    for i in range(n):
        curr = pts[i]
        nxt = pts[(i + 1) % n]
        normal[0] += (curr[1] - nxt[1]) * (curr[2] + nxt[2])
        normal[1] += (curr[2] - nxt[2]) * (curr[0] + nxt[0])
        normal[2] += (curr[0] - nxt[0]) * (curr[1] + nxt[1])
    length = np.linalg.norm(normal)
    return normal / length if length > 0 else np.array([0., 0., 1.])
