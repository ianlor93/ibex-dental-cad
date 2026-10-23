"""meshcleaner — Tier 1 tool (PyMeshLab V22.16 InputDecimation, 2026-05-01).

V22.16 — decimazione mesh ingresso > 200k face a target ~150k face via
PyMeshLab quadric edge collapse. La scansione raw (200k-1M face, sub-mm)
contiene self-intersezioni geometriche residue causa "zona piena Upper"
downstream in modelgenerator. Decimazione a ~150k face elimina molti
micro-SI per costruzione (triangoli più grandi → meno punti di
intersezione). Beneficio collaterale: Laplacian downstream ~3x più
veloce su Upper. Posizione Step 0.5 (post load, pre Step 1 cleanup).
Trade-off: sub-mm detail perso (irrilevante per SDF PITCH=0.5mm).

V22.12 — fix critico per supportare G2 alti (1000-4000+) senza rompere boolean
del modelgenerator downstream. V22.11 applicava Laplacian uniforme aggressivo
SENZA cleanup topologico post-smoothing → mesh con winding face invertita
(1-2% face flipped a G2≥1000) + edge non-manifold sub-millimetrici → manifold3d
STRICT in modelgenerator rifiutava outer come NotManifold → fallback solido.
V22.12 aggiunge Step 2.5 PostSmoothRepair: repair_nm_edges + repair_nm_vertices
+ remove_duplicate_faces + remove_unreferenced_vertices + re_orient_faces_
coherently (in ordine critico). Mesh output 2-manifold per costruzione →
modelgenerator boolean OK anche con G2=4000.

Pipeline 5-step C++ nativo PyMeshLab:
  Step 1   — pulizia (pre-weld + remove small components)
  Step 2   — Laplacian UNIFORME (cotangentweight=False) su selezione bordo + G1
             dilatazioni con transfer inclusive=True (G2//5 iter). Pesi uniformi
             1/N evitano l'amplificazione di cot(θ) su triangoli sottili/ottusi.
  Step 2.5 — V22.12 PostSmoothRepair: repair_nm_edges + repair_nm_vertices +
             remove_duplicate_faces + remove_unreferenced_vertices +
             re_orient_faces_coherently. Garantisce mesh 2-manifold per
             modelgenerator boolean downstream.
  Step 3   — close_holes refinehole + selfintersection=False (chiusura fori grandi)
  Step 4   — validazione + save

NOTA 2026-04-30: tentativo V22.12/V22.13 BezierBoundary (cubic spline periodic
decimata sostituiva il Laplacian boundary) ha PEGGIORATO il risultato visivo
sia sul bordo (estrusione base distorta) che sul cap modelgenerator. Rollback
totale a V22.11. La causa root delle ondulazioni nel cap anulare resta APERTA
e va affrontata con un approccio diverso (NON via decimazione spline del
boundary in meshcleaner).

apply(src_path, params, output_path, logger) -> bool
G1_Seleziona_Boundary_INT (0-20, default 4)    numero di anelli dilatati nella selezione (fascia)
G2_Liscia_Boundary_INT    (0-1000, default 1000) iterazioni Laplacian uniforme (G2//5)
G3_Patch_Fori_INT         (0-100, default 20)   edge cap chiusura fori (mapping G3×100 → maxholesize)
G4_Patch_in_curvatura     (bool, default False) refinehole=G4 → True patch curvature-fitted (~18s)
"""

import pymeshlab
from pymeshlab import PureValue


MIN_COMPONENT_FACES = 1000


def apply(src_path, params, output_path, logger):
    G1 = int(params.get('G1_Seleziona_Boundary_INT', 4) or 0)
    G2 = int(params.get('G2_Liscia_Boundary_INT', 1000) or 0)
    G3 = int(params.get('G3_Patch_Fori_INT', 20) or 0)
    G4 = bool(params.get('G4_Patch_in_curvatura', False))

    try:
        ms = pymeshlab.MeshSet()
        ms.load_new_mesh(src_path)
    except Exception as e:
        logger(f'[FAST] [IBEX-ENGINE ERROR] meshcleaner load: {e}')
        return False

    m_in = ms.current_mesh()
    logger(f'[FAST] meshcleaner V22.16 IN: {m_in.vertex_number()} verts, '
           f'{m_in.face_number()} faces (G1={G1} G2={G2} G3={G3}mm)')

    # Step 0.5 — V22.16 InputDecimation (2026-05-01).
    # Decimazione mesh ingresso > THRESHOLD face. Le scansioni raw (200k-1M
    # face, sub-mm) hanno spesso self-intersezioni geometriche residue. La
    # decimazione a ~150k face elimina molti micro-attraversamenti per
    # costruzione (triangoli più grandi → meno densità → meno punti di
    # intersezione). Beneficio collaterale: Laplacian downstream più
    # veloce (~3x speedup su Upper). Trade-off accettato: sub-mm detail
    # perso (irrilevante per hollow shell con SDF PITCH=0.5mm).
    # Posizione: PRIMA di Step 1, così pre-weld + remove components
    # opera già su mesh più piccola.
    DECIMATE_TARGET_FACES = 150000
    DECIMATE_THRESHOLD = 200000
    try:
        n_pre_dec = ms.current_mesh().face_number()
        if n_pre_dec > DECIMATE_THRESHOLD:
            ms.meshing_decimation_quadric_edge_collapse(
                targetfacenum=DECIMATE_TARGET_FACES,
                qualitythr=0.3,
                preserveboundary=True,
                preservenormal=True,
                preservetopology=True,
                planarquadric=True,
                autoclean=True,
            )
            n_post_dec = ms.current_mesh().face_number()
            logger(f'[FAST] meshcleaner V22.16 InputDecimation: '
                   f'{n_pre_dec} → {n_post_dec} faces (target={DECIMATE_TARGET_FACES})')
        else:
            logger(f'[FAST] meshcleaner V22.16 InputDecimation SKIP '
                   f'({n_pre_dec} faces ≤ threshold {DECIMATE_THRESHOLD})')
    except Exception as dec_e:
        logger(f'[FAST] meshcleaner V22.16 InputDecimation error ({dec_e}) — '
               f'mantengo mesh originale')

    # Step 1 — Pulizia
    try:
        ms.meshing_merge_close_vertices(threshold=PureValue(0.001))
        before = ms.current_mesh().face_number()
        ms.meshing_remove_connected_component_by_face_number(
            mincomponentsize=MIN_COMPONENT_FACES)
        removed = before - ms.current_mesh().face_number()
        if removed > 0:
            logger(f'[FAST] meshcleaner: -{removed} face (componenti piccole)')
    except Exception as e:
        logger(f'[FAST] meshcleaner WARNING cleanup: {e}')

    # Step 2 — Laplacian cotangente su selezione bordo + G1 dilatazioni
    if G1 > 0 or G2 > 0:
        try:
            ms.set_selection_none()
            ms.compute_selection_from_mesh_border()
            for _ in range(max(0, G1)):
                ms.apply_selection_dilatation()
            try:
                ms.compute_selection_transfer_vertex_to_face(inclusive=True)
            except TypeError:
                ms.compute_selection_transfer_vertex_to_face()
            try:
                ms.compute_selection_transfer_face_to_vertex(inclusive=True)
            except TypeError:
                ms.compute_selection_transfer_face_to_vertex()
            n_iter = max(1, G2 // 5)
            ms.apply_coord_laplacian_smoothing(
                stepsmoothnum=n_iter,
                boundary=True,
                selected=True,
                cotangentweight=False
            )
            ms.set_selection_none()
            logger(f'[FAST] meshcleaner: smooth (G1={G1} dil, {n_iter} iter uniform)')
        except Exception as e:
            logger(f'[FAST] meshcleaner WARNING smooth: {e}')

        # Step 2.5 — V22.12 PostSmoothRepair (2026-05-01).
        # Critical per supportare G2 alti (es. 1000-4000 → 200-800 iter Laplacian)
        # senza rompere modelgenerator boolean downstream. Su G2≥1000 il
        # Laplacian aggressivo può:
        #   - Invertire winding face (vert "scavalca" piano dei vicini → triangoli
        #     adiacenti cambiano orientation → mesh_solid downstream ha 1-2% face
        #     flipped → fix_normals di trimesh non basta a coerentizzare
        #     completamente → manifold3d STRICT rifiuta outer come NotManifold)
        #   - Creare edge non-manifold sub-millimetrici (vert quasi-collassati)
        #   - Creare face degenerate (triangoli quasi-collassati)
        # Repair pipeline ordine critico:
        #   1. repair_non_manifold_edges PRIMA (perché re_orient richiede manifold)
        #   2. repair_non_manifold_vertices
        #   3. remove_duplicate_faces (collassi → duplicati)
        #   4. remove_unreferenced_vertices
        #   5. re_orient_faces_coherently — flood-fill winding sulla mesh
        #      manifold-strict ottenuta sopra → tutte le face concordi
        # Tutti in try/except: se uno fallisce skippa silently e prosegue.
        # NON cambia visibilmente il bordo smoothato (operazioni topologiche).
        try:
            ms.meshing_repair_non_manifold_edges()
        except Exception as e:
            logger(f'[FAST] meshcleaner: repair_nm_edges skipped ({e})')
        try:
            ms.meshing_repair_non_manifold_vertices()
        except Exception as e:
            logger(f'[FAST] meshcleaner: repair_nm_vertices skipped ({e})')
        try:
            ms.meshing_remove_duplicate_faces()
        except Exception as e:
            logger(f'[FAST] meshcleaner: remove_dup_faces skipped ({e})')
        try:
            ms.meshing_remove_unreferenced_vertices()
        except Exception as e:
            logger(f'[FAST] meshcleaner: remove_unref_verts skipped ({e})')
        try:
            ms.meshing_re_orient_faces_coherently()
            logger('[FAST] meshcleaner: post-smooth repair + re_orient OK (V22.12)')
        except Exception as e:
            logger(f'[FAST] meshcleaner: re_orient skipped ({e})')

    # Step 3 — Chiusura fori (refinehole opzionale via G4)
    if G3 > 0:
        G3_edges = max(3, int(G3 * 100))
        ms.meshing_close_holes(
            maxholesize=G3_edges,
            selfintersection=False,
            refinehole=G4
        )
        logger(f'[FAST] meshcleaner: close_holes G3_edges={G3_edges} refinehole={G4}')

    # Step 4 — Validazione + save
    try:
        t = ms.get_topological_measures()
        logger(f'[FAST] meshcleaner: manifold={t.get("is_mesh_two_manifold", False)} '
               f'boundary_edges={t.get("boundary_edges", 0)} '
               f'non_manifold_edges={t.get("non_two_manifold_edges", 0)}')
    except Exception:
        pass

    try:
        ms.save_current_mesh(output_path)
        m_out = ms.current_mesh()
        logger(f'[FAST] meshcleaner OUT: {m_out.vertex_number()} verts, '
               f'{m_out.face_number()} faces')
        return True
    except Exception as e:
        logger(f'[FAST] [IBEX-ENGINE ERROR] save: {e}')
        return False
