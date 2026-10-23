"""Loft primitive — bridge tra due ring di indici (pareti quad-split).

Estratto dal pattern fascia/skirt di modelgenerator._build_base (FASE 1).
Date due ring equi-lunghe (array di indici GLOBALI + posizioni world), produce
le facce triangolari che le collegano: per ogni segmento i, quad (top_i,
top_{i+1}, bot_{i+1}, bot_i) splittato sulla diagonale più corta. Gli indici
GLOBALI sono forniti dal chiamante (bookkeeping mesh = orchestrazione); il
primitivo fa solo la geometria del bridge → output byte-equivalente ai loop
fascia/skirt originali.

Pura Python (numpy). Interfaccia indici (N,) + punti (N,3) → faces (M,3) int32.
"""
import numpy as np


def loft_rings(idx_top, pts_top, idx_bot, pts_bot):
    """Bridge ring_top → ring_bot in pareti quad-split (diagonale più corta).

    idx_top/idx_bot: (N,) indici GLOBALI dei vert delle due ring.
    pts_top/pts_bot: (N,3) posizioni world (per scegliere la diagonale).
    Ritorna faces (M,3) int32 (2 triangoli per segmento).
    """
    N = len(idx_top)
    tris = []
    for i in range(N):
        a = int(idx_top[i])
        b = int(idx_top[(i + 1) % N])
        c = int(idx_bot[(i + 1) % N])
        d = int(idx_bot[i])
        pa = pts_top[i]
        pb = pts_top[(i + 1) % N]
        pc = pts_bot[(i + 1) % N]
        pd = pts_bot[i]
        if np.linalg.norm(pa - pc) <= np.linalg.norm(pb - pd):
            tris.append([a, b, c])
            tris.append([a, c, d])
        else:
            tris.append([a, b, d])
            tris.append([b, c, d])
    return np.array(tris, dtype=np.int32)
