"""topology_rebuild — Tier 1 destructive tool (V1.3 rollback, 2026-05-08).

V1.3 (rollback 2026-05-08): tornato all'algoritmo originale stabile dopo
tentativi V1.4-V1.7 di generalizzare il caso "fascia a U attorno al bordo
aperto" che non hanno prodotto risultati visualmente accettabili.

Storico V1.0 SingleSelect, 2026-05-05.



Ricostruzione topologica auto-detect su una selezione di facce. Single-select:
l'utente seleziona facce e il tool decide automaticamente cosa fare:

  Caso 1 — 1 loop chiuso, 1 componente connesso  → CHIUDE FORO
           (bmesh.ops.grid_fill se edge count pari, fallback triangle_fill)

  Caso 2 — 2 loops, 2 componenti                  → BRIDGE
           (bmesh.ops.bridge_loops + subdivide_edges per gap fino a 5-10mm)

  Caso 3 — qualsiasi altra combinazione           → FAIL graceful

I "componenti" sono raggruppamenti di facce selezionate connesse via edge
condivisi. I "loop" sono cicli chiusi di edge che delimitano la SELEZIONE
(edge appartenenti a 1 sola faccia della selezione, scartando quelli interni).

Architettura ibrida Tier 1 + bmesh (pattern modelgenerator V2.4 storico):
  - trimesh per load/save (formato STL binary, performance)
  - numpy per detection (loop extraction + union-find componenti)
  - bmesh in-process per le operazioni topologiche (grid_fill / bridge_loops /
    subdivide_edges) — il worker È Blender headless, `import bpy` disponibile.

Subdivide post-bridge:
  - target edge length 0.5mm hardcoded V1.0 (no parametro UI)
  - n_cuts = clamp(1, 30, int(gap_distance_mm / 0.5))
  - use_grid_fill=True per quad-dominante quando possibile

apply(src_path, sel_path, output_path, logger) -> bool
  - src_path: path STL della mesh (incorpora world matrix di tool upstream)
  - sel_path: path JSON con `{"face_indices": [int, ...]}` — face index della
              selezione utente, validi su src mesh post-load (ordine triangoli
              preservato da trimesh process=False — Inv. 43)
  - output_path: dove salvare la mesh modificata
  - logger: callable per logging
  - return: True se rebuild riuscita; False se fail (chiamante fa passthrough
            master per evitare di rompere la pipeline)
"""

import json
import os
import numpy as np
from collections import defaultdict


TARGET_EDGE_LEN_MM = 0.5     # subdivide post-bridge target
SUBDIVIDE_MAX_CUTS = 30
MIN_LOOP_VERTS = 3


def apply(src_path, sel_path, output_path, logger):
    # ---- 1. Load mesh + selection ------------------------------------------
    try:
        import trimesh
        mesh = trimesh.load(src_path, process=False, force='mesh')
        if not isinstance(mesh, trimesh.Trimesh):
            logger(f"[FAST] topology_rebuild: load non-Trimesh ({type(mesh).__name__})")
            return False
        # CRITICAL (V1.1, 2026-05-05): STL binary di STLExporter emette 3 vert
        # NON-CONDIVISI per ogni triangolo (formato STL standard). trimesh.load
        # con process=False li mantiene così → ogni triangolo ha indici vert
        # unici → due triangoli adiacenti NON condividono indici → l'edge
        # "comune" geometricamente NON è (v0, v1) identico → tutti gli edge
        # sono "boundary della selezione" → ogni faccia è "componente isolato"
        # → V1.0 falliva con `loops=N_faces, componenti=N_faces`.
        # FIX: merge_vertices deduplica i vert con stesse coords e rimappa
        # mesh.faces. PRESERVA l'ordine delle face → face_id stabile (Inv. 43).
        n_verts_pre = len(mesh.vertices)
        mesh.merge_vertices()
        n_verts_post = len(mesh.vertices)
        if n_verts_pre != n_verts_post:
            logger(f"[FAST] topology_rebuild: merge_vertices {n_verts_pre} → "
                   f"{n_verts_post} (dedupe STL non-shared verts)")
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] topology_rebuild load STL: {e}")
        return False

    try:
        with open(sel_path, 'r') as f:
            sel_data = json.load(f)
        face_idx_list = sel_data.get('face_indices', [])
        if not isinstance(face_idx_list, list) or not face_idx_list:
            logger("[FAST] topology_rebuild: selection vuota o malformata")
            return False
        # Validazione indici
        n_faces = len(mesh.faces)
        face_idx_set = set()
        for fi in face_idx_list:
            if not isinstance(fi, int):
                continue
            if 0 <= fi < n_faces:
                face_idx_set.add(fi)
        if not face_idx_set:
            logger("[FAST] topology_rebuild: nessun face index valido nella selezione")
            return False
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] topology_rebuild load selection: {e}")
        return False

    V = np.asarray(mesh.vertices, dtype=np.float64)
    F = np.asarray(mesh.faces, dtype=np.int64)
    logger(f"[FAST] topology_rebuild V1.3 IN: {len(V)} verts, {len(F)} faces, "
           f"{len(face_idx_set)} faces selezionate")

    # ---- 2. Boundary edges GLOBALI della mesh -------------------------------
    # Edge globalmente in face_count==1 = bordi dei FORI della mesh originale.
    global_edge_count = defaultdict(int)
    for fi in range(len(F)):
        a, b, c = int(F[fi, 0]), int(F[fi, 1]), int(F[fi, 2])
        for v0, v1 in ((a, b), (b, c), (c, a)):
            key = (v0, v1) if v0 < v1 else (v1, v0)
            global_edge_count[key] += 1
    global_boundary_edges = [e for e, n in global_edge_count.items() if n == 1]
    logger(f"[FAST] topology_rebuild: {len(global_boundary_edges)} boundary edges "
           f"globali (= bordi dei fori della mesh)")

    if not global_boundary_edges:
        logger("[FAST] topology_rebuild FAIL: la mesh non ha bordi aperti "
               "(nessun foro né pezzo disconnesso da chiudere). Niente da "
               "ricostruire.")
        return False

    # ---- 3. Boundary edges sotto-selezione (entrambi vert dentro la selezione)
    # Filtro AND sugli endpoint dell'edge.
    selected_verts = set()
    for fi in face_idx_set:
        selected_verts.add(int(F[fi, 0]))
        selected_verts.add(int(F[fi, 1]))
        selected_verts.add(int(F[fi, 2]))

    sel_boundary_edges = [
        (v0, v1) for (v0, v1) in global_boundary_edges
        if v0 in selected_verts and v1 in selected_verts
    ]
    logger(f"[FAST] topology_rebuild: {len(sel_boundary_edges)} boundary edges "
           f"con ENTRAMBI gli endpoint nella selezione")

    if not sel_boundary_edges:
        logger("[FAST] topology_rebuild FAIL: la selezione non copre alcun "
               "bordo aperto. Per close_hole seleziona TUTTO il bordo del foro; "
               "per bridge seleziona facce ADIACENTI ai 2 lati del gap.")
        return False

    # ---- 4. DFS extraction: loops chiusi + chains aperte --------------------
    adj = defaultdict(set)
    for v0, v1 in sel_boundary_edges:
        adj[v0].add(v1)
        adj[v1].add(v0)

    visited = set()
    loops = []
    chains = []

    def _walk(start_vert, prev_vert):
        path = [start_vert]
        cur = start_vert
        prev = prev_vert
        while True:
            nbrs = [n for n in adj[cur] if n != prev and n not in visited]
            if not nbrs:
                return path, cur
            nxt = nbrs[0]
            path.append(nxt)
            visited.add(nxt)
            prev = cur
            cur = nxt

    for start in list(adj.keys()):
        if start in visited:
            continue
        if len(adj[start]) < 2:
            visited.add(start)
            continue
        visited.add(start)
        forward_path, end_fwd = _walk(start, None)
        is_closed = start in adj[end_fwd] and len(forward_path) >= MIN_LOOP_VERTS
        if is_closed:
            loops.append(forward_path)
            continue
        if len(forward_path) >= 2:
            backward_path, end_bwd = _walk(start, forward_path[1])
            full_chain = list(reversed(backward_path[1:])) + forward_path
        else:
            full_chain = forward_path
        if len(full_chain) >= MIN_LOOP_VERTS:
            chains.append(full_chain)

    logger(f"[FAST] topology_rebuild: estratti {len(loops)} loop chiusi + "
           f"{len(chains)} chain aperte dai boundary edges sotto-selezione")

    try:
        import bpy
        import bmesh
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] topology_rebuild: bpy/bmesh import: {e}")
        return False

    # Reset Blender scene per evitare stato sporco da run precedenti
    try:
        bpy.ops.wm.read_homefile(use_empty=True)
    except Exception:
        pass

    # Crea bpy mesh dalle V, F numpy
    bpy_mesh = bpy.data.meshes.new("ibex_topology_rebuild")
    bpy_mesh.from_pydata(V.tolist(), [], F.tolist())
    bpy_mesh.update()

    bm = bmesh.new()
    bm.from_mesh(bpy_mesh)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()

    success = False
    op_label = '?'

    # V1.3 dispatch (rollback 2026-05-08): basato su STRUTTURA della selezione.
    #   - 1 loop chiuso, 0 chain     → l'utente ha cerchiato l'INTERO bordo
    #                                   di un foro → close_hole.
    #   - 0 loop, 2 chain aperte     → l'utente ha selezionato 2 SEGMENTI del
    #                                   bordo → bridge tra le 2 chain (use_cyclic=False).
    #   - 2 loop chiusi, 0 chain     → bridge tra 2 fori distinti completamente
    #                                   selezionati (raro ma supportato).
    #   - else                        → fail graceful, no operation.
    if len(loops) == 1 and len(chains) == 0:
        op_label = 'close_hole'
        success = _bm_close_loop(bm, loops[0], logger)
    elif len(loops) == 0 and len(chains) == 2:
        op_label = 'bridge_chains'
        success = _bm_bridge_loops(bm, V, chains[0], chains[1], logger,
                                   cyclic=False)
    elif len(loops) == 2 and len(chains) == 0:
        op_label = 'bridge_loops'
        success = _bm_bridge_loops(bm, V, loops[0], loops[1], logger,
                                   cyclic=True)
    else:
        logger(f"[FAST] topology_rebuild FAIL: combinazione non gestita "
               f"(loops={len(loops)}, chain aperte={len(chains)}). V1.3 "
               f"supporta: (1 loop, 0 chain) close_hole · (0 loop, 2 chain) "
               f"bridge tra 2 segmenti · (2 loop, 0 chain) bridge tra 2 fori. "
               f"Per BRIDGE su un'arcata aperta: seleziona facce SOLO sui 2 "
               f"lati del gap (non sull'intero perimetro del foro).")
        try: bm.free()
        except Exception: pass
        try: bpy.data.meshes.remove(bpy_mesh)
        except Exception: pass
        return False


    if success:
        try:
            bm.to_mesh(bpy_mesh)
            bm.free()
            # Estrai V_out, F_out dalla bpy mesh
            verts_out = np.array([v.co[:] for v in bpy_mesh.vertices], dtype=np.float64)
            faces_out = []
            for poly in bpy_mesh.polygons:
                vs = list(poly.vertices)
                if len(vs) == 3:
                    faces_out.append(vs)
                elif len(vs) == 4:
                    faces_out.append([vs[0], vs[1], vs[2]])
                    faces_out.append([vs[0], vs[2], vs[3]])
                # else: ngon → skip (non dovrebbe accadere post triangulate)
            faces_out = np.array(faces_out, dtype=np.int64)
            # Cleanup bpy data
            bpy.data.meshes.remove(bpy_mesh)

            import trimesh
            mesh_out = trimesh.Trimesh(verts_out, faces_out, process=False)
            mesh_out.export(output_path)
            logger(f"[FAST] topology_rebuild OUT ({op_label}): "
                   f"{len(verts_out)} verts, {len(faces_out)} faces")
            return True
        except Exception as e:
            logger(f"[FAST] [IBEX-ENGINE ERROR] topology_rebuild save: {e}")
            return False
    else:
        try:
            bm.free()
            bpy.data.meshes.remove(bpy_mesh)
        except Exception:
            pass
        logger(f"[FAST] topology_rebuild FAIL: {op_label} non riuscito")
        return False


def _bm_close_loop(bm, loop_verts, logger):
    """
    Chiude un loop di vert (lista circolare di vert idx) con grid_fill o
    triangle_fill. Pattern proven meshcleaner V15.x.
    """
    try:
        loop_edges = []
        for i in range(len(loop_verts)):
            v0_idx = loop_verts[i]
            v1_idx = loop_verts[(i + 1) % len(loop_verts)]
            v0 = bm.verts[v0_idx]
            v1 = bm.verts[v1_idx]
            e = bm.edges.get([v0, v1])
            if e is not None:
                loop_edges.append(e)

        if len(loop_edges) < 3:
            logger(f"[FAST] topology_rebuild close_hole: loop edges insufficienti "
                   f"({len(loop_edges)})")
            return False

        import bmesh
        # 1. grid_fill (quad-dominante, richiede edge count pari ≥ 4)
        if len(loop_edges) >= 4 and len(loop_edges) % 2 == 0:
            try:
                ret = bmesh.ops.grid_fill(bm, edges=loop_edges, use_smooth=False)
                created = ret.get('faces', [])
                if created:
                    logger(f"[FAST] topology_rebuild close_hole: grid_fill OK "
                           f"({len(created)} face)")
                    return True
            except Exception as e:
                logger(f"[FAST] topology_rebuild close_hole: grid_fill skipped ({e})")

        # 2. triangle_fill (sempre funziona, fan-style)
        try:
            ret = bmesh.ops.triangle_fill(bm, edges=loop_edges, use_dissolve=False)
            created = ret.get('geom', [])
            n_faces = sum(1 for g in created if hasattr(g, 'verts') and len(g.verts) == 3)
            if n_faces > 0:
                logger(f"[FAST] topology_rebuild close_hole: triangle_fill OK "
                       f"({n_faces} face)")
                return True
        except Exception as e:
            logger(f"[FAST] topology_rebuild close_hole: triangle_fill failed ({e})")

        return False
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] _bm_close_loop: {e}")
        return False


def _bm_bridge_loops(bm, V, loop_a, loop_b, logger, cyclic=True):
    """
    Bridge tra 2 loop/chain di vert. V1.3 (2026-05-05):
      0. Allineamento chain: se chain_a[0]<→chain_b[-1] dist < chain_a[0]<→chain_b[0]
         dist, reverse chain_b prima di costruire gli edge. Evita "diagonali
         storte" quando le 2 chain procedono in direzioni opposte (caso comune
         su brush dello stesso loop globale: estremi attesi in pairing
         start↔start / end↔end, non start↔end).
      1. bmesh.ops.bridge_loops(edges=edges_a + edges_b, use_cyclic=cyclic)
      2. subdivide_edges sui new edges del bridge — n_cuts adattivo basato su
         target_edge_len = avg_edge_dei_2_chain (più denso → tessellation
         coerente con mesh circostante). target_edge_len cap a TARGET_EDGE_LEN_MM
         se troppo piccolo (<0.1mm = rumore subpixel).
      3. smooth_vert 3 iter sui vert NUOVI del bridge (non sui boundary
         originali della mesh). Regolarizza posizioni interpolate, riduce
         "frastagliature" da bridge raw. Boundary fissi → no shrinkage.
    """
    try:
        import bmesh

        # ---- 0. Allineamento chain: closest-endpoint pairing ----------------
        # bridge_loops accoppia i vert nell'ordine in cui appaiono. Se chain B
        # è "rovesciata" rispetto a chain A, ottieni diagonali a "X" sul bridge.
        # Calcolo le 4 distanze tra estremi e reverse chain_b se end↔end è più
        # vicino di end↔start (= chain_b è invertita).
        ax_start = V[loop_a[0]]
        ax_end   = V[loop_a[-1]]
        bx_start = V[loop_b[0]]
        bx_end   = V[loop_b[-1]]
        # Se cyclic: l'ordine è arbitrario, non serve allineare (loop chiusi
        # bridge_loops gestisce internamente). Solo per chain aperte.
        if not cyclic and len(loop_b) >= 2:
            d_aligned   = float(np.linalg.norm(ax_start - bx_start)) \
                        + float(np.linalg.norm(ax_end   - bx_end))
            d_reversed  = float(np.linalg.norm(ax_start - bx_end)) \
                        + float(np.linalg.norm(ax_end   - bx_start))
            if d_reversed < d_aligned:
                loop_b = list(reversed(loop_b))
                logger(f"[FAST] topology_rebuild bridge: chain B revertita "
                       f"per allineamento (d_aligned={d_aligned:.2f}mm vs "
                       f"d_reversed={d_reversed:.2f}mm)")

        # Costruisci edge list. Per chain aperte (cyclic=False) escludi
        # l'edge di chiusura (last → first), che geometricamente NON esiste.
        def loop_to_edges(loop_verts, is_cyclic):
            edges = []
            n_seg = len(loop_verts) if is_cyclic else len(loop_verts) - 1
            for i in range(n_seg):
                v0 = bm.verts[loop_verts[i]]
                v1 = bm.verts[loop_verts[(i + 1) % len(loop_verts)]]
                e = bm.edges.get([v0, v1])
                if e is not None:
                    edges.append(e)
            return edges

        edges_a = loop_to_edges(loop_a, cyclic)
        edges_b = loop_to_edges(loop_b, cyclic)

        if len(edges_a) < 2 or len(edges_b) < 2:
            logger(f"[FAST] topology_rebuild bridge: edge insufficienti "
                   f"(A={len(edges_a)}, B={len(edges_b)}, cyclic={cyclic})")
            return False

        # ---- Stima target_edge_len adattivo dalle 2 chain -------------------
        # Avg edge length delle 2 chain → target tessellation post-subdivide
        # coerente con la mesh circostante (~0.1-0.3mm tipico su scan dentale).
        # Cap a TARGET_EDGE_LEN_MM=0.5mm se troppo piccolo (<0.1mm = noise).
        edge_lens_a = [float(np.linalg.norm(V[loop_a[i+1]] - V[loop_a[i]]))
                       for i in range(len(loop_a)-1)]
        edge_lens_b = [float(np.linalg.norm(V[loop_b[i+1]] - V[loop_b[i]]))
                       for i in range(len(loop_b)-1)]
        all_edge_lens = edge_lens_a + edge_lens_b
        avg_edge_len_mm = (sum(all_edge_lens) / max(1, len(all_edge_lens))
                           if all_edge_lens else TARGET_EDGE_LEN_MM)
        target_edge = max(0.1, min(TARGET_EDGE_LEN_MM, avg_edge_len_mm))

        # Stima gap distance (mm) dai centroidi dei 2 loop
        cen_a = V[np.array(loop_a, dtype=np.int64)].mean(axis=0)
        cen_b = V[np.array(loop_b, dtype=np.int64)].mean(axis=0)
        gap_dist = float(np.linalg.norm(cen_b - cen_a))

        # Pre-set di edges esistenti per detectare quelli new post-bridge
        edges_pre = set(e.index for e in bm.edges)
        # Boundary verts originali (NON da smussare post-bridge per non far
        # collassare il bordo della mesh circostante).
        boundary_vert_set = set(loop_a) | set(loop_b)

        # 1. Bridge
        try:
            ret = bmesh.ops.bridge_loops(
                bm, edges=edges_a + edges_b,
                use_pairs=False,
                use_cyclic=cyclic,
                use_merge=False,
                merge_factor=0.5
            )
            new_faces = ret.get('faces', [])
            if not new_faces:
                logger("[FAST] topology_rebuild bridge: bridge_loops 0 face create")
                return False
            logger(f"[FAST] topology_rebuild bridge: bridge_loops OK "
                   f"({len(new_faces)} face, gap={gap_dist:.2f}mm)")
        except Exception as e:
            logger(f"[FAST] topology_rebuild bridge: bridge_loops fallito ({e})")
            return False

        # 2. Subdivide post-bridge — n_cuts adattivo basato su target_edge_len
        # calcolato dalle chain originali (V1.3). Più cuts = triangoli più
        # piccoli e tessellation coerente con la mesh dentale circostante.
        bm.edges.ensure_lookup_table()
        new_edges = [e for e in bm.edges if e.index not in edges_pre]
        if new_edges and gap_dist > target_edge:
            n_cuts = max(1, min(SUBDIVIDE_MAX_CUTS,
                                int(gap_dist / target_edge) - 1))
            try:
                bmesh.ops.subdivide_edges(
                    bm, edges=new_edges,
                    cuts=n_cuts,
                    use_grid_fill=True
                )
                logger(f"[FAST] topology_rebuild bridge: subdivide n_cuts={n_cuts} "
                       f"(target_edge={target_edge:.2f}mm, gap={gap_dist:.2f}mm)")
            except Exception as e:
                logger(f"[FAST] topology_rebuild bridge: subdivide_edges skipped ({e})")

        # 3. Smooth dei vert NUOVI (non boundary originali) per regolarizzare
        # le posizioni. Boundary verts della mesh circostante restano fissi
        # (non in `boundary_vert_set` originale = sono nuovi del bridge).
        # 3 iterazioni con factor=0.5 = pattern Laplacian smooth standard.
        try:
            bm.verts.ensure_lookup_table()
            new_verts = [v for v in bm.verts
                         if v.index not in boundary_vert_set
                         and any(e.index not in edges_pre for e in v.link_edges)]
            if new_verts:
                bmesh.ops.smooth_vert(
                    bm, verts=new_verts,
                    factor=0.5,
                    mirror_clip_x=False, mirror_clip_y=False, mirror_clip_z=False,
                    use_axis_x=True, use_axis_y=True, use_axis_z=True
                )
                # 2 iterazioni aggiuntive per smoothing più aggressivo.
                bmesh.ops.smooth_vert(bm, verts=new_verts, factor=0.5,
                                      mirror_clip_x=False, mirror_clip_y=False,
                                      mirror_clip_z=False,
                                      use_axis_x=True, use_axis_y=True, use_axis_z=True)
                bmesh.ops.smooth_vert(bm, verts=new_verts, factor=0.5,
                                      mirror_clip_x=False, mirror_clip_y=False,
                                      mirror_clip_z=False,
                                      use_axis_x=True, use_axis_y=True, use_axis_z=True)
                logger(f"[FAST] topology_rebuild bridge: smooth {len(new_verts)} "
                       f"new verts × 3 iter (boundary preservato)")
        except Exception as e:
            logger(f"[FAST] topology_rebuild bridge: smooth_vert skipped ({e})")

        # 4. Recalc normals per coerenza winding bridge
        try:
            bm.faces.ensure_lookup_table()
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        except Exception as e:
            logger(f"[FAST] topology_rebuild bridge: recalc_face_normals skipped ({e})")

        return True
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] _bm_bridge_loops: {e}")
        return False
