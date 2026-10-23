"""Boolean difference primitive — A − B via Blender boolean modifier (solver EXACT).

Estratto verbatim dalla closure `_bpy_boolean_difference` di
`modelgenerator._make_hollow` (FASE 1, scorporo primitivi). Logica bpy
identica byte-per-byte: reset scena → crea oggetti A/B → modifier BOOLEAN
DIFFERENCE solver='EXACT' → triangola n-gon → estrae (V, F).

Interfaccia numpy (V, F) → (V, F) | None, come la closure d'origine (il call
site è numpy-native → taglio 1:1 a rischio zero). Wrapper trimesh-in/out
previsto come follow-up, per allinearsi a slice_plane.

⚠️ Primitivo LATO-WORKER: richiede il contesto bpy. Il worker IBEX È Blender
headless → `import bpy` disponibile in-process (import locale per convenzione,
come in modelgenerator/topology_rebuild). NON è puro-Python come slice_plane.
"""
import numpy as np


def boolean_difference(V_a, F_a, V_b, F_b, name_a='outer', name_b='inner'):
    """Boolean A - B via bpy modifier EXACT. Reset scene + crea oggetti +
    applica modifier + triangola + estrae V/F. Ritorna (V, F) o None."""
    import bpy
    import bmesh as _bmesh
    try:
        bpy.ops.wm.read_homefile(use_empty=True)
        # Crea mesh A
        mesh_a = bpy.data.meshes.new(name_a)
        mesh_a.from_pydata(V_a.tolist(), [], F_a.tolist())
        mesh_a.update()
        obj_a = bpy.data.objects.new(name_a, mesh_a)
        bpy.context.collection.objects.link(obj_a)
        # Crea mesh B
        mesh_b = bpy.data.meshes.new(name_b)
        mesh_b.from_pydata(V_b.tolist(), [], F_b.tolist())
        mesh_b.update()
        obj_b = bpy.data.objects.new(name_b, mesh_b)
        bpy.context.collection.objects.link(obj_b)
        # Active = A, applica modifier EXACT
        bpy.context.view_layer.objects.active = obj_a
        obj_a.select_set(True)
        mod = obj_a.modifiers.new('Bool', 'BOOLEAN')
        mod.operation = 'DIFFERENCE'
        mod.object = obj_b
        mod.solver = 'EXACT'
        bpy.ops.object.modifier_apply(modifier='Bool')
        # Triangola n-gons output
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.quads_convert_to_tris(quad_method='BEAUTY', ngon_method='BEAUTY')
        bpy.ops.object.mode_set(mode='OBJECT')
        # Estrai V/F
        bm = _bmesh.new()
        bm.from_mesh(obj_a.data)
        V_out = np.array([list(v.co) for v in bm.verts], dtype=np.float64)
        F_out = np.array([[v.index for v in f.verts] for f in bm.faces], dtype=np.int32)
        bm.free()
        if len(V_out) == 0 or len(F_out) == 0:
            return None
        return V_out, F_out
    except Exception:
        return None
