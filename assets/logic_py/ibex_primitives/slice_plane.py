"""slice_plane — primitivo: taglio planare con cap (estratto da modelgenerator V4.8 Step 5)."""

import trimesh


def slice_plane(mesh, plane_origin, plane_normal, cap=True):
    """Taglia `mesh` con un piano e tappa il bordo. Pura: trimesh.Trimesh -> trimesh.Trimesh.

    Mantiene la metà verso cui punta plane_normal. Riproduce IDENTICAMENTE il blocco
    di modelgenerator: primaria slice_mesh_plane(mesh, normal, origin, cap=...),
    fallback mesh.slice_plane(origin, normal, cap=...) (ordine invertito, trimesh vecchi).
    Può ritornare una mesh vuota se il piano scarta tutta la geometria — il chiamante decide.
    """
    try:
        return trimesh.intersections.slice_mesh_plane(
            mesh, plane_normal, plane_origin, cap=cap
        )
    except TypeError:
        return mesh.slice_plane(plane_origin, plane_normal, cap=cap)
