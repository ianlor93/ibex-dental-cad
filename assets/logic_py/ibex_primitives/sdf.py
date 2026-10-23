"""SDF primitive — campo di distanza con segno via Open3D RaycastingScene (Embree).

Estratto verbatim da modelgenerator._compute_sdf_open3d (FASE 1, scorporo
primitivi accoppiati offset+SDF). Logica identica byte-per-byte: Embree
compute_signed_distance su mesh watertight, segno invertito a POSITIVO-dentro.

Rappresentazione SDF (DESIGN: rappresentazione distinta dalla mesh). Pura Python
(open3d/numpy), niente bpy, niente I/O file: la cache `.npz` resta concern di
progetto → orchestrazione in _make_hollow. Primitivo non-worker, come slice_plane.

⚠️ PRECONDIZIONE: la mesh DEVE essere watertight (Open3D compute_signed_distance
è affidabile solo su mesh chiuse).

NB: le stringhe di log mantengono il prefisso `[FAST] modelgenerator` per
compatibilità con i grep di log esistenti (cosmetico, follow-up).
"""
import numpy as np


def compute_sdf(V, F, pitch=0.5, padding=1.0, logger=None):
    """V4.0 OpenSDF — Calcola SDF grid via Open3D RaycastingScene (Embree).

    Sostituisce trimesh.voxel.creation.voxelize + binary_fill_holes +
    distance_transform_edt × 2 (V3.19, peak RAM transient 2-3GB su Lower dentale)
    con singola chiamata C++ multi-thread (peak RAM <300MB, ~10-50× più veloce).

    PRECONDIZIONE: la mesh DEVE essere watertight (post Step 0 close_holes in
    `_make_hollow`). Open3D `compute_signed_distance` è affidabile solo su mesh
    chiuse — su input con boundary loops produce SDF erronea (verts esterni
    classificati come interni o viceversa).

    Convention: V3.19 produceva sdf_grid con valori POSITIVI dentro (via
    `dist_in - dist_out`). Open3D produce NEGATIVI dentro. INVERTO il sign
    per matchare downstream code (marching_cubes a `level=thickness` cerca
    isosuperficie a `thickness` mm DENTRO il solid → sdf > 0 dentro).

    Args:
        V: vertices float64 (N, 3)
        F: faces int32 (M, 3)
        pitch: dimensione voxel (mm)
        padding: margine extra attorno al BBox della mesh (mm). Tipico 1.0mm
            per evitare clipping ai bordi del marching_cubes.
        logger: callable(str)

    Returns:
        (sdf_grid, scale, origin, max_dist) o None su errore.
        - sdf_grid: float32 array shape (nx, ny, nz), POSITIVO dentro
        - scale: float32 (3, 3) diagonal pitch (per marching_cubes downstream)
        - origin: float32 (3,) world coord del vertice grid (0,0,0)
        - max_dist: float, massima distanza interna (per check thickness)
    """
    try:
        import open3d as o3d
        import open3d.core as o3c
    except ImportError as e:
        logger(f'[FAST] modelgenerator [IBEX-ENGINE ERROR] open3d non disponibile: {e}')
        return None

    try:
        # Build mesh tensor + scena Embree
        tmesh = o3d.t.geometry.TriangleMesh()
        tmesh.vertex.positions = o3c.Tensor(
            np.ascontiguousarray(V, dtype=np.float32))
        tmesh.triangle.indices = o3c.Tensor(
            np.ascontiguousarray(F, dtype=np.uint32))
        scene = o3d.t.geometry.RaycastingScene()
        scene.add_triangles(tmesh)

        # Build query grid: vertici (NON centri) per matchare convention
        # marching_cubes (verts_mc=(i,j,k) → world = origin + (i,j,k)*pitch).
        v_min = V.min(axis=0).astype(np.float32) - np.float32(padding)
        v_max = V.max(axis=0).astype(np.float32) + np.float32(padding)
        dims = np.ceil((v_max - v_min) / pitch).astype(int) + 1
        nx, ny, nz = int(dims[0]), int(dims[1]), int(dims[2])
        n_voxel = nx * ny * nz

        # Sanity check: grid esagerata = abort prima di OOM
        # 64M voxel = 256MB float32 = limite ragionevole per dental scan
        MAX_VOXEL = 64_000_000
        if n_voxel > MAX_VOXEL:
            logger(f'[FAST] modelgenerator [IBEX-ENGINE ERROR] grid SDF troppo grande: '
                   f'{nx}×{ny}×{nz}={n_voxel:,} voxel (>{MAX_VOXEL:,})')
            return None

        xs = v_min[0] + np.arange(nx, dtype=np.float32) * np.float32(pitch)
        ys = v_min[1] + np.arange(ny, dtype=np.float32) * np.float32(pitch)
        zs = v_min[2] + np.arange(nz, dtype=np.float32) * np.float32(pitch)

        # Meshgrid 'ij' → ordering (i,j,k) compatibile con sdf_grid[i,j,k]
        xx, yy, zz = np.meshgrid(xs, ys, zs, indexing='ij')
        points = np.stack([xx.ravel(), yy.ravel(), zz.ravel()],
                          axis=1).astype(np.float32)
        # Free intermedi appena possibile (riduce peak RAM)
        del xx, yy, zz

        points_t = o3c.Tensor(points, dtype=o3c.Dtype.Float32)
        del points  # ora vive solo in points_t

        # Compute SDF (Embree multi-thread). Convention Open3D:
        #   negativo = dentro, positivo = fuori
        sdf_flat = scene.compute_signed_distance(points_t).numpy()
        del points_t, scene, tmesh  # libera Embree scene + mesh tensor

        # Inverti sign per match V3.19 convention (positivo = dentro)
        sdf_grid = (-sdf_flat).reshape(nx, ny, nz).astype(np.float32)
        max_dist = float((-sdf_flat).max()) if sdf_flat.size > 0 else 0.0
        del sdf_flat

        # Trasformazione voxel-grid → world coords (per marching_cubes)
        scale = np.diag([pitch, pitch, pitch]).astype(np.float32)
        origin = v_min.astype(np.float32)

        logger(f'[FAST] modelgenerator: SDF Embree {nx}×{ny}×{nz}={n_voxel:,} voxel, '
               f'max_dist={max_dist:.1f}mm')
        return sdf_grid, scale, origin, max_dist
    except Exception as e:
        logger(f'[FAST] modelgenerator [IBEX-ENGINE ERROR] Open3D SDF fallita: {e}')
        return None
