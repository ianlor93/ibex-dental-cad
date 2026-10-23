"""split_topology_via_curves — Tier 1 helper (V1.1, 2026-05-08).

Cut della mesh lungo N curve Bezier (datablock dal nodo `draw_curve`).
Algoritmo geodetico: ogni control point della curva → snap al vert mesh
più vicino → Dijkstra tra control points consecutivi sui edge della mesh
→ polyline chiusa di vert. Le N polylines insieme formano i "boundary
edges proibiti" del flood-fill. Due regioni risultanti → 2 mesh A/B.

V1.1 (2026-05-08): aggiunto orientation check post-flood-fill via PCA +
matplotlib point-in-polygon → garantisce A = dentro la curva (era invertito
in V1.0 a causa del seed flood-fill che cadeva spesso fuori dal loop).

Limitazioni V1.1:
  - Solo splines `cyclic=True`. Splines aperte → skip silente con log.
  - Snap-to-vert (no split triangoli). Errore di snap ≈ avg edge length
    della mesh (~0.2mm su scan dentale). Cut "aderisce" agli edge
    esistenti → bordo seghettato visibile a zoom alto, accettabile
    clinicamente.
  - Mesh deve avere 1 componente connesso. Se più componenti, il
    flood-fill marca solo quello che contiene il seed.
  - Nessuna gestione di curve nested (curve dentro curve).

V1.2 (2026-05-13): supporto schema esteso curve_edit Fase 2 — se la spline
ha `handle_types`/`handles_left`/`handles_right` non vuoti, i segmenti tra
CP consecutivi (entrambi tipo 'aligned' O uno aligned + altro vector con
handle non null) vengono upsampleti come curva Bezier cubica a 24 sample/seg
prima del Dijkstra. Per spline tutte 'vector' (default arch_detect) →
comportamento V1.1 invariato (polyline lineare tra CP).

apply(src_mesh_path, curve_json_path, out_a_path, out_b_path, logger) -> bool
"""

import json
import os
import heapq
import numpy as np
from collections import defaultdict


_BEZIER_SAMPLES_PER_SEG = 24  # V1.2 — densità rendering polyline Bezier


def _eval_bezier_polyline(spline, samples_per_seg=_BEZIER_SAMPLES_PER_SEG):
    """V1.2 — Upsample Bezier cubica della spline se ha handles.

    Per ogni segmento da CP_i a CP_{i+1}:
      - P0 = CP_i
      - P1 = handles_right[i]  (se None → P1 = P0 → degenera a linea)
      - P2 = handles_left[i+1] (se None → P2 = P3 → degenera a linea)
      - P3 = CP_{i+1}
      - Se entrambi i CP sono 'vector' O entrambi i handle mancano →
        ritorna [P0, P3] (= linea retta, 2 punti)
      - Altrimenti → Bezier cubica evaluata a `samples_per_seg` punti

    Ritorna: numpy array (N, 3) — polyline densa per Dijkstra/snap-to-vert.
    Backward compat: spline senza handle_types/handles_* → ritorna direttamente
    control_points come polyline lineare (= V1.1 behaviour).
    """
    cps_raw = spline.get('control_points', [])
    if not isinstance(cps_raw, list) or len(cps_raw) < 2:
        return np.asarray(cps_raw, dtype=np.float64) if cps_raw else np.zeros((0, 3))

    cps = np.asarray(cps_raw, dtype=np.float64)
    n = len(cps)
    types = spline.get('handle_types')
    hL = spline.get('handles_left')
    hR = spline.get('handles_right')

    # Backward compat: no handle data → ritorna control_points come polyline
    has_handles = (isinstance(types, list) and isinstance(hL, list)
                   and isinstance(hR, list) and len(types) == n
                   and 'aligned' in types)
    if not has_handles:
        return cps

    cyclic = bool(spline.get('cyclic', False))
    nSeg = n if cyclic else n - 1

    def _pt_or_none(arr, idx):
        if arr is None or idx >= len(arr):
            return None
        v = arr[idx]
        if v is None or not isinstance(v, (list, tuple)) or len(v) != 3:
            return None
        return np.asarray(v, dtype=np.float64)

    all_pts = []
    for segIdx in range(nSeg):
        i2 = (segIdx + 1) % n
        P0 = cps[segIdx]
        P3 = cps[i2]
        P1 = _pt_or_none(hR, segIdx)
        P2 = _pt_or_none(hL, i2)
        # Decidi se evaluare Bezier o linea retta per questo segmento
        type_i  = types[segIdx] if segIdx < len(types) else 'vector'
        type_i2 = types[i2] if i2 < len(types) else 'vector'
        use_bezier = (type_i == 'aligned' or type_i2 == 'aligned') and (P1 is not None or P2 is not None)
        if P1 is None: P1 = P0
        if P2 is None: P2 = P3

        if not use_bezier:
            # Linea retta — 2 punti
            seg_pts = np.stack([P0, P3], axis=0)
        else:
            # Bezier cubica
            t = np.linspace(0.0, 1.0, samples_per_seg)
            omt = 1.0 - t
            w0 = omt ** 3
            w1 = 3 * omt * omt * t
            w2 = 3 * omt * t * t
            w3 = t ** 3
            seg_pts = (w0[:, None] * P0 + w1[:, None] * P1
                       + w2[:, None] * P2 + w3[:, None] * P3)

        # Skip first pt se non è il primo segmento (continuità senza dup)
        start_k = 1 if all_pts else 0
        for k in range(start_k, len(seg_pts)):
            all_pts.append(seg_pts[k])

    return np.asarray(all_pts, dtype=np.float64) if all_pts else cps


def apply(src_mesh_path, curve_json_path, out_a_path, out_b_path, logger):
    # ---- 1. Load mesh + curve datablock ------------------------------------
    try:
        import trimesh
        mesh = trimesh.load(src_mesh_path, process=False, force='mesh')
        if not isinstance(mesh, trimesh.Trimesh):
            logger(f"[FAST] split_via_curves: load non-Trimesh ({type(mesh).__name__})")
            return False
        # Pattern Inv. da topology_rebuild V1.1: STLExporter emette STL
        # standard senza vert condivisi. trimesh.load(process=False) li
        # mantiene → triangoli adiacenti hanno indici vert distinti per le
        # stesse coords → la struttura del grafo edge è frammentata.
        # merge_vertices deduplica preservando l'ordine triangoli.
        n_verts_pre = len(mesh.vertices)
        mesh.merge_vertices()
        n_verts_post = len(mesh.vertices)
        if n_verts_pre != n_verts_post:
            logger(f"[FAST] split_via_curves: merge_vertices "
                   f"{n_verts_pre} → {n_verts_post}")
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] split_via_curves load STL: {e}")
        return False

    try:
        with open(curve_json_path, 'r') as f:
            datablock = json.load(f)
        splines = datablock.get('splines', [])
        if not isinstance(splines, list):
            logger("[FAST] split_via_curves: datablock invalido (splines non lista)")
            return False
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] split_via_curves load curve: {e}")
        return False

    V = np.asarray(mesh.vertices, dtype=np.float64)
    F = np.asarray(mesh.faces, dtype=np.int64)
    n_verts = len(V)
    n_faces = len(F)
    logger(f"[FAST] split_via_curves V1.1: mesh {n_verts}v {n_faces}f, "
           f"datablock {len(splines)} splines")

    # ---- 2. KDTree per snap-to-vert ----------------------------------------
    try:
        from scipy.spatial import cKDTree
    except ImportError:
        logger("[FAST] [IBEX-ENGINE ERROR] split_via_curves: scipy non disponibile")
        return False
    tree = cKDTree(V)

    # ---- 3. Edge adjacency + edge length per Dijkstra ----------------------
    adj = defaultdict(list)
    edge_seen = set()
    for fi in range(n_faces):
        a, b, c = int(F[fi, 0]), int(F[fi, 1]), int(F[fi, 2])
        for v0, v1 in ((a, b), (b, c), (c, a)):
            key = (v0, v1) if v0 < v1 else (v1, v0)
            if key in edge_seen:
                continue
            edge_seen.add(key)
            d = float(np.linalg.norm(V[v0] - V[v1]))
            adj[v0].append((v1, d))
            adj[v1].append((v0, d))

    # ---- 4. Per ogni spline ciclica: Dijkstra → polyline chiusa di vert ----
    forbidden_edges = set()
    n_closed = 0
    n_open_skipped = 0
    seed_face_candidates = []  # vert per scegliere face seed di A

    # Salva i cps della prima spline chiusa per orientation check (V1.1)
    first_closed_cps_for_orient = None

    for sp_idx, sp in enumerate(splines):
        cyclic = bool(sp.get('cyclic', False))
        cps_raw = sp.get('control_points', [])
        if not cyclic:
            n_open_skipped += 1
            continue
        if not isinstance(cps_raw, list) or len(cps_raw) < 3:
            logger(f"[FAST] split_via_curves: spline {sp_idx} skipped "
                   f"(control points insufficienti: {len(cps_raw) if isinstance(cps_raw, list) else 0})")
            continue

        # V1.2 — upsample Bezier se la spline ha handles aligned. Per spline
        # tutte 'vector' (default arch_detect) o senza schema esteso →
        # cps_arr = control_points raw (= comportamento V1.1).
        cps_arr = _eval_bezier_polyline(sp, samples_per_seg=_BEZIER_SAMPLES_PER_SEG)
        if len(cps_arr) < 3:
            logger(f"[FAST] split_via_curves: spline {sp_idx} skipped "
                   f"(post-Bezier upsample: {len(cps_arr)} pts < 3)")
            continue
        types_dbg = sp.get('handle_types')
        n_aligned = (sum(1 for t in types_dbg if t == 'aligned')
                     if isinstance(types_dbg, list) else 0)
        logger(f"[FAST] split_via_curves: spline {sp_idx} cps_raw={len(cps_raw)} "
               f"→ polyline={len(cps_arr)} pts (aligned={n_aligned})")
        if first_closed_cps_for_orient is None:
            first_closed_cps_for_orient = cps_arr

        # Snap each control point to nearest vert
        _, vert_idx = tree.query(cps_arr)
        vert_idx = vert_idx.tolist()

        # Dijkstra tra control points consecutivi (chiusura ciclica)
        polyline = []
        n_cp = len(vert_idx)
        path_failed = False
        for i in range(n_cp):
            v_start = vert_idx[i]
            v_end = vert_idx[(i + 1) % n_cp]
            if v_start == v_end:
                continue
            path = _dijkstra(adj, v_start, v_end)
            if path is None:
                logger(f"[FAST] split_via_curves: spline {sp_idx} Dijkstra "
                       f"fallito tra cp {i}→{(i+1)%n_cp} (v {v_start}→{v_end}). "
                       f"Mesh non connessa? Skip spline.")
                path_failed = True
                break
            polyline.extend(path[:-1])

        if path_failed or len(polyline) < 3:
            continue
        n_closed += 1

        # Edges proibiti per il flood-fill
        m = len(polyline)
        for i in range(m):
            v0 = polyline[i]
            v1 = polyline[(i + 1) % m]
            key = (v0, v1) if v0 < v1 else (v1, v0)
            forbidden_edges.add(key)

        seed_face_candidates.append(polyline[0])

    logger(f"[FAST] split_via_curves V1.1: {n_closed} splines chiuse mappate "
           f"({n_open_skipped} aperte skipped), {len(forbidden_edges)} edges proibiti")

    if n_closed == 0:
        logger("[FAST] split_via_curves FAIL: nessuna spline chiusa utilizzabile. "
               "Disegna almeno 1 curva chiusa nel nodo Disegna Curva.")
        return False

    # ---- 5. Face adjacency map (face → adjacent faces NON via forbidden edge) ----
    edge_to_faces = defaultdict(list)
    for fi in range(n_faces):
        a, b, c = int(F[fi, 0]), int(F[fi, 1]), int(F[fi, 2])
        for v0, v1 in ((a, b), (b, c), (c, a)):
            key = (v0, v1) if v0 < v1 else (v1, v0)
            edge_to_faces[key].append(fi)

    face_adj = defaultdict(list)
    for key, faces_at_edge in edge_to_faces.items():
        if key in forbidden_edges:
            continue
        if len(faces_at_edge) >= 2:
            for i in range(len(faces_at_edge)):
                for j in range(len(faces_at_edge)):
                    if i != j:
                        face_adj[faces_at_edge[i]].append(faces_at_edge[j])

    # ---- 6. Scelta seed: face contenente il vert seed_face_candidates[0] ----
    seed_vert = seed_face_candidates[0]
    seed_face = -1
    for fi in range(n_faces):
        if seed_vert in (int(F[fi, 0]), int(F[fi, 1]), int(F[fi, 2])):
            seed_face = fi
            break
    if seed_face < 0:
        logger(f"[FAST] split_via_curves FAIL: nessuna face contiene seed_vert={seed_vert}")
        return False

    # ---- 7. BFS flood-fill: marca face raggiungibili da seed senza attraversare forbidden ----
    in_a = np.zeros(n_faces, dtype=bool)
    queue = [seed_face]
    in_a[seed_face] = True
    while queue:
        cur = queue.pop()
        for nb in face_adj[cur]:
            if not in_a[nb]:
                in_a[nb] = True
                queue.append(nb)
    n_a = int(in_a.sum())
    n_b = n_faces - n_a
    logger(f"[FAST] split_via_curves V1.1: flood-fill A={n_a}/{n_faces} faces, "
           f"B={n_b}/{n_faces}")

    if n_a == 0 or n_b == 0:
        logger("[FAST] split_via_curves FAIL: una delle 2 regioni è vuota. "
               "La curva non delimita realmente 2 zone separate? Verifica che "
               "le splines siano chiuse e formino loop ben definiti.")
        return False

    # ---- 7b. Orientation check (V1.1) — A = dentro la curva ---------------
    # Il flood-fill BFS parte da seed_face che contiene un vert SULLA polyline.
    # Quale dei 2 lati del cut contiene seed_face è arbitrario → in genere A
    # finisce per essere "fuori" il loop (grande) e B "dentro" (piccolo).
    # Convenzione utente richiede A = dentro la curva, quindi swap se serve.
    #
    # Strategia: PCA della prima spline chiusa → piano migliore. Test
    # point-in-polygon 2D su sample face di A. Se sample fuori polygon →
    # swap.
    try:
        if first_closed_cps_for_orient is not None and len(first_closed_cps_for_orient) >= 3:
            from matplotlib.path import Path as MPath
            centroid_c = first_closed_cps_for_orient.mean(axis=0)
            cps_c = first_closed_cps_for_orient - centroid_c
            _, _, vh = np.linalg.svd(cps_c, full_matrices=False)
            axis_u, axis_v = vh[0], vh[1]
            cps_2d = np.column_stack([cps_c @ axis_u, cps_c @ axis_v])
            poly = MPath(cps_2d)

            # Sample face di A: prendi un face nel mezzo (non al boundary)
            # via centroide più "interno" → bilanciato.
            # Pragmatic: prendi tutti i face di A, calcola centroidi 2D, conta
            # quanti sono dentro polygon. Se > 50% dentro → A=dentro, no swap.
            face_centroids_3d = V[F[in_a]].mean(axis=1)
            fc_centered = face_centroids_3d - centroid_c
            fc_2d = np.column_stack([
                fc_centered @ axis_u,
                fc_centered @ axis_v
            ])
            inside_count = int(poly.contains_points(fc_2d).sum())
            outside_count = n_a - inside_count

            # Idem per B
            face_centroids_3d_b = V[F[~in_a]].mean(axis=1)
            fc_centered_b = face_centroids_3d_b - centroid_c
            fc_2d_b = np.column_stack([
                fc_centered_b @ axis_u,
                fc_centered_b @ axis_v
            ])
            inside_count_b = int(poly.contains_points(fc_2d_b).sum())

            # Il branch con MAGGIORE intersezione "inside polygon" è A.
            if inside_count_b > inside_count:
                in_a = ~in_a
                n_a, n_b = n_b, n_a
                logger(f"[FAST] split_via_curves V1.1: A↔B swap "
                       f"(B aveva {inside_count_b} face dentro polygon vs "
                       f"A={inside_count}); convenzione: A = dentro la curva")
            else:
                logger(f"[FAST] split_via_curves V1.1: orientation OK "
                       f"(A inside={inside_count}, B inside={inside_count_b}), no swap")
    except Exception as e:
        # Fallback heuristic: A = il branch più piccolo
        if n_a > n_b:
            in_a = ~in_a
            n_a, n_b = n_b, n_a
            logger(f"[FAST] split_via_curves V1.1: orientation fallback "
                   f"(errore PCA: {e}); swap A↔B 'A=più piccolo'")

    # ---- 8. Costruisci 2 mesh: A = facce con in_a, B = complemento --------
    try:
        import trimesh as _tm
        F_a = F[in_a]
        F_b = F[~in_a]

        mesh_a = _tm.Trimesh(V, F_a, process=False)
        mesh_a.remove_unreferenced_vertices()
        mesh_a.export(out_a_path)

        mesh_b = _tm.Trimesh(V, F_b, process=False)
        mesh_b.remove_unreferenced_vertices()
        mesh_b.export(out_b_path)

        logger(f"[FAST] split_via_curves V1.1 OUT: A={len(mesh_a.faces)} faces "
               f"({len(mesh_a.vertices)} verts), B={len(mesh_b.faces)} faces "
               f"({len(mesh_b.vertices)} verts)")
        return True
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] split_via_curves save: {e}")
        return False


def _dijkstra(adj, start, end):
    """
    Cammino minimo sui vert tra start e end via edge weighted (lunghezza).
    Ritorna lista [start, ..., end] di vert idx, o None se non raggiungibile.
    """
    dist = {start: 0.0}
    prev = {}
    heap = [(0.0, start)]
    while heap:
        d_cur, u = heapq.heappop(heap)
        if u == end:
            path = [end]
            while path[-1] != start:
                path.append(prev[path[-1]])
            return list(reversed(path))
        if d_cur > dist.get(u, float('inf')):
            continue
        for v, w in adj[u]:
            d_new = d_cur + w
            if d_new < dist.get(v, float('inf')):
                dist[v] = d_new
                prev[v] = u
                heapq.heappush(heap, (d_new, v))
    return None
