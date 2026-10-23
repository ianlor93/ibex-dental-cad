"""Offset surface primitive — isosuperficie offset in spazio SDF via marching cubes.

Estratto verbatim dal blocco marching di modelgenerator._make_hollow (FASE 1,
scorporo primitivi accoppiati offset+SDF). Dato un campo SDF (positivo dentro) +
l'origine world della griglia, produce la superficie a `distance` mm DENTRO il
solid: marching_cubes(sdf, level=distance) + trasformazione dei vertici in
coordinate mondo (scala = pitch isotropo, identica a diag(pitch) della SDF).

Interfaccia numpy (V, F) come boolean/SDF → taglio 1:1. Pura Python (skimage/
numpy), niente bpy né I/O file → primitivo non-worker, come slice_plane.
"""
import numpy as np
from skimage import measure


def offset_surface(sdf, origin, distance, pitch=0.5, logger=None):
    """Superficie offset a `distance` (mm) dentro il solid descritto da `sdf`
    (positivo dentro). marching_cubes(level=distance) + verts → world coords
    (scala isotropa pitch, traslazione origin). Ritorna (V, F) o None.

    Nota: `scale = diag(pitch)` è ricostruito qui — identico a quello prodotto
    dalla SDF (`compute_sdf` lo costruisce come np.diag([pitch]*3)), quindi
    `verts_mc.dot(scale.T) + origin` è byte-equivalente al blocco originale.
    """
    try:
        verts_mc, faces_mc, _, _ = measure.marching_cubes(sdf, level=distance)
        scale = np.diag([pitch, pitch, pitch]).astype(np.float32)
        verts_world = verts_mc.dot(scale.T) + origin
        if logger:
            logger(f'[FAST] modelgenerator: inner shell {len(verts_world)} verts {len(faces_mc)} faces')
        return verts_world, faces_mc
    except Exception as e:
        if logger:
            logger(f'[FAST] modelgenerator WARNING: marching_cubes fallito ({e})')
        return None
