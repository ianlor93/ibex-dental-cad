"""V4.8 SlicePlane — 2026-05-04 (sostituzione strutturale del Step 5 cutting
box bpy boolean con trimesh.intersections.slice_mesh_plane). V4.7.1 ha
dimostrato sul campo che il bug NON è nella mesh input: PyMeshLab repair
tra Step 4 e Step 5 NON trova nulla da rimuovere (`255101 → 255101 faces`)
eppure il bug persiste su G2=1.5/2.5/3.0 → RESULT_CAPPED signed_volume
NEGATIVO. Il problema è dentro il solver bpy CGAL EXACT stesso: per certe
geometrie produce risultati non-deterministici dove il cutting box NON
viene sottratto ma resta come componente con winding invertita. Soluzione
strutturale: il taglio finale è un'operazione PIANARE — non c'è bisogno
di un boolean con un AABB cosmico. `trimesh.intersections.slice_mesh_plane(
mesh, plane_normal, plane_origin, cap=True)` taglia la mesh con un piano
ed aggiunge un cap planare. Algoritmo: loop intersection + Delaunay 2D cap.
NO CGAL, NO solver non-deterministico, NO box AABB. Il piano è cut_z =
base_z_cut + extrude_dir_z * CUT_OFFSET, normal opposta a extrude_dir
(mantiene il lato della scansione dentale, taglia via lo base extruso).
Trade-off: trimesh slice è ~5x più veloce di bpy boolean, e robusto.

V4.7.1 PostStep4Repair — 2026-05-04 (estende V4.7 con repair PyMeshLab
tra Step 4 boolean e Step 5 cutting box). Verificato sul campo che V4.7
disabilitando outer decimate NON era sufficiente: G2=2.5 G3=2.5 →
signed_volume_post_Step5=-97629mm³ persisteva come BUG. Diagnosi: il CGAL
EXACT solver di bpy produce T-junction sub-mm e face degenerate
non-deterministicamente nel primo boolean (Step 4 outer-inner). Quando
il result post-Step 4 è "denso patologico" (G2=2.5 → 261903 face vs G2=2.0
→ 121017 face per stesso pattern di input), il SECONDO boolean (Step 5
cutting box) eredita il caos topologico e fallisce → box non sottratto.
Fix V4.7.1: PyMeshLab repair tra Step 4 e Step 5 (merge close vert 0.01mm,
remove duplicate face/vert, repair non-manifold). Pattern speculare a Step 3
inner repair (V4.5+). Trade-off: ~100ms in più per repair. Tutto il resto
V4.7 preservato.

V4.7 SkipOuterDecimate — 2026-05-04 (recidiva del bug V4.6 sul lato OUTER).
Bug: V4.2.11 reintrodotto fast_simplification.simplify(target_reduction=0.7)
sul mesh_solid post-close_holes per perf (Upper >200k face). Ha riportato
ESATTO stesso pattern di V4.5 (T-junction sub-mm destabilizzano bpy CGAL
EXACT solver in modo non-deterministico → box NON sottratto, resta come
componente separata nel risultato → signed_volume_post_Step5 NEGATIVO).
Verificato sul campo 2026-05-04: G2=1.5/2.5 → signed_volume=-93267/-97564mm³
(BUG visibile: cutting box che resta in vista), G2=0.0/0.5/2.0 → +14812/
14868/14920mm³ (OK). Fix: disabilitato V4.2.11 outer decimate. V4.2.12 outer
post-decimate repair MANTENUTO (utile anche senza decimate per pulire la
patch close_holes che può introdurre face nm). Trade-off: bpy boolean ~1.5x
più lento su Upper denso, ma correttezza > perf. Tutto il resto V4.6
preservato.

V4.6 SkipInnerDecimate — 2026-05-02 (fix critico bug "zona piena Upper" /
"scarpa Lower" / output catastrofico signed_volume=-125870 su Upper G2=2.0
G3=3.0). Causa root identificata empiricamente: `fast_simplification.simplify(
target_reduction=0.4)` post marching_cubes su inner shell creava T-junction
sub-millimetrici (vert quasi-coincidenti ma topologicamente distinti) e
geometria marginale che faceva collassare bpy CGAL EXACT solver in modo
non-deterministico per certe combinazioni G2/G3 (Upper G2=2.0 G3=3.0
catastrofico, altre combinazioni: signed_volume_post_Step5 oscillava da
+1678 a +20287 senza pattern logico). Fix: rimossa decimazione inner shell,
si mantiene mesh raw da marching_cubes (~40-55k face invece di ~25-32k).
Trade-off: bpy boolean ~1.5x più lento (Upper bake ~16-17s invece di ~13s,
Lower ~10s invece di ~8s). Cache HIT modelgenerator non impattato (1-2s).
Tutto il resto V4.5 preservato.

V4.5 PerComponentWinding — 2026-05-01 (fix critico Step 3.5: winding check
PER-COMPONENTE invece che globale). Bug pre-V4.5: `trimesh.volume` ritorna la
SOMMA SIGNED di TUTTE le componenti connesse → su inner shell multi-cavità da
marching_cubes con winding mista, la somma globale può mascherare componenti
invertite (es. comp A = +30000mm³ OK, comp B = -5000mm³ inv → somma +25000 →
nessun flip → B resta invertita → bpy boolean produce "barre/elementi
parassiti alla base" + normali caotiche radiali). Fix: split in componenti
connesse via `trimesh.split(only_watertight=False)`, check volume PER-componente,
flip individuale se negativo, riconcatena con offset indici. Tutto il resto V4.4
preservato (bpy EXACT boolean, V4.2 hybrid V3.0+Shapely, V4.1 loft 1:1,
V4.0 OpenSDF).

V4.4 BPY Boolean — 2026-05-01 (sostituisce Open3D V4.3 e manifold3d pre-V4.3
in Step 4 + Step 5 di `_make_hollow` con `bpy.ops.modifier_apply` BOOLEAN
solver=EXACT). Open3D `boolean_difference` usa VTK backend e fallisce su
CONTAINMENT (caso tipico dental hollow shell: inner completamente dentro
outer → "No Intersection between objects" → empty mesh). manifold3d STRICT
rifiutava self-intersection sub-mm. bpy EXACT solver gestisce ENTRAMBI per
costruzione (CGAL sotto). Worker.py È Blender headless → bpy disponibile
in-process, ~1-3s tipico su mesh dentale 220k face. Step 3.5 winding check
via trimesh.volume (preservato da V4.3). Mantenuto tutto il resto V4.2
hybrid V3.0+Shapely + V4.1 loft 1:1 + V4.0 OpenSDF.

V4.3 Open3D Boolean — 2026-05-01 (Open3D Tensor API `boolean_difference`)
RIMOSSA in V4.4: VTK backend non gestisce containment. Mantenuto helper
_compute_sdf_open3d V4.0 (Embree RaycastingScene è la parte funzionante
di Open3D usata).

V4.2 Hybrid V3.0+Shapely — 2026-05-01 (V3.0 algoritmo originale come PRIMARY
path nel `_offset_loop` con t_orig_frac mapping 1:1 nativo; shapely.buffer +
closest-point projection come SAFETY NET per loop patologici dove V3.0 non
converge. Decisione su feedback utente: "V3.0 aveva il miglior calcolo del
margine"). Mantenuto V4.1 loft 1:1 in `_build_base`.

V4.1 ShapelyBuffer — 2026-05-01 (refactor `_offset_loop` con
`shapely.Polygon.buffer` Minkowski + loft 1:1 fascia in `_build_base`
per fix autointersezione zone concave + fan triangle ventaglio).
V4.1 closest-point projection rivelatosi non sufficiente su loop dentali con
clustering cuspidi → fascia distorta → V4.2 Hybrid lo retrocede a fallback.

V4.0 OpenSDF — 2026-05-01 (rinascita strutturale Step 1 SDF: trimesh
voxelize sostituito con Open3D RaycastingScene + Embree, cache cross-project
filesystem, peak RAM da ~3GB a <300MB) — preservato.

V3.20 ArcLengthOffset — 2026-04-30 (decimazione + cubic spline + arc-length
uniform) RIMOSSO in V4.1: causava (a) autointersezione in zone concave strette
(spline 48 cp tagliava la concavità → vert offset DENTRO il loop originale →
boolean produceva parete che intercettava lo scan), (b) fan triangle nella
fascia (loop originale clustering vs loop offset uniform → ventaglio sottile
visibile post-V4.0). Sostituito da shapely.buffer (Minkowski CGAL-based,
gestisce concavità per costruzione) + resample 1:1 al loop originale (loft
quad regolare nella fascia).
V3.19 SpeedOpt — 2026-04-30 (STL binary export + decimazione marching_cubes) —
preservato. Cache SDF voxelize V3.19 RIMOSSA (sostituita da cache cross-project
V4.0). Helper `_compute_mesh_hash` resta (riusato da V4.0 con stessa chiave SHA1).

**V4.0 — Open3D Embree RaycastingScene** (peak RAM <300MB, ~95% reduction vs V3.19):

(1) `_compute_sdf_open3d(V, F, pitch, padding, logger)` — calcola SDF grid via
    `o3d.t.geometry.RaycastingScene.compute_signed_distance` (Embree-accelerated,
    multi-thread, C++ nativo). Su mesh dentale 96k verts × 1.5M voxel:
    - Trimesh voxelize V3.19: ~22s, peak RAM transient 2-3GB
    - Open3D RaycastingScene: ~500ms-2s, peak RAM <300MB
    Convention SDF Open3D: NEGATIVO dentro, POSITIVO fuori. Inverto sign per
    matchare downstream V3.19 (POSITIVO dentro, MC level=thickness cerca
    isosuperficie a `thickness` mm dentro). Mantiene `gaussian_filter(sigma=2.0)`
    post-Embree per smussare residui (costo trascurabile).

(2) Cache SDF PER-PROGETTO in `{active_path}/sdf/{mesh_hash}.npz` (ciclo-vita
    2026-07-13, Legge 1: dir da params['_sdf_cache_dir'] iniettata dal worker;
    viaggia nel .ibex al save, muore col purge alla chiusura). Hash SHA1 di
    (V_solid + F_solid + PITCH) — invariante per cambi G3 (level marching_cubes
    downstream). HIT su drag G3 e alla riapertura del progetto (sdf/ ripristinata
    dall'extract del .ibex; ~50ms read .npz vs ~500ms-2s compute fresh).

(3) Cache HIT lookup PRIMA del compute Embree → skip totale del passo SDF.
    Cache MISS → compute Embree + save .npz compressed (sdf_grid float32 + scale
    + origin + max_dist). Errori save loggati ma non bloccanti.

**V3.19 ottimizzazioni preservate**:
- STL binary export via `_export_stl_binary(mesh, path)`
- Decimazione `fast_simplification` post marching_cubes (target_reduction=0.7)

V3.11 fix (preservato): `delete_topology` produce mesh con pinch-vertices (vert
condivisi da 2+ disc topologici sconnessi). meshcleaner V22.11 dichiara
non_manifold_edges=0 ma non rileva i pinch-vert. PyMeshLab `meshing_close_holes
(selfintersection=False)` li rifiuta. Splitter custom in Python.
"""

import os
import hashlib
import numpy as np
import trimesh
from collections import defaultdict
from scipy.spatial import Delaunay
from matplotlib.path import Path

# V3.19 — fast_simplification per decimazione inner shell. Già installato nel
# container worker (vedi docker-compose.yml pip install). Fallback a no-op
# se non disponibile (skip decimazione, mesh originale passa al repair).
try:
    import fast_simplification
    _FAST_SIMPLIFICATION_AVAILABLE = True
except ImportError:
    _FAST_SIMPLIFICATION_AVAILABLE = False


def _export_stl_binary(mesh, path):
    """V3.19 — Export STL forzando binary encoding via trimesh `file_type='stl'`.

    Trimesh `mesh.export(path)` con extension `.stl` può cadere in ASCII su alcune
    versioni / configurazioni — comportamento ambiguo. Forzando `file_type='stl'`
    + scrittura bytes esplicita garantiamo binary su tutte le piattaforme.
    Su mesh grandi (>500k verts): 6× più veloce, file 6× più piccolo.

    Restituisce True su success, False su errore (caller può fallback a ASCII).
    """
    try:
        with open(path, 'wb') as f:
            f.write(mesh.export(file_type='stl'))
        return True
    except Exception:
        # Fallback all'export standard di trimesh (potrebbe essere ASCII)
        try:
            mesh.export(path)
            return True
        except Exception:
            return False


def _compute_mesh_hash(V, F, pitch):
    """V3.19 — Hash SHA1 (16 char) di (V, F, PITCH) per cache SDF lookup.

    La SDF grid dipende esclusivamente dalla geometria della mesh e dal pitch.
    Hash byte-level di numpy arrays + pitch quantizzato (4 decimali) → cache key
    deterministica. Cambio di V o F (anche 1 vert) o pitch → hash diverso → MISS.
    """
    h = hashlib.sha1()
    h.update(np.ascontiguousarray(V, dtype=np.float32).tobytes())
    h.update(np.ascontiguousarray(F, dtype=np.int32).tobytes())
    h.update(f"{pitch:.4f}".encode())
    return h.hexdigest()[:16]


# FASE 1: SDF estratta → ibex_primitives.sdf.compute_sdf (import + call nello Step 1 di _make_hollow).


def _split_pinch_vertices(V, F):
    """Identifica vert condivisi da 2+ disc topologici sconnessi (pinch-vert) e li
    splitta duplicandoli (uno per disc). Ritorna (V_new, F_new) garantito 2-manifold
    rispetto alla connettività vert (gli edge non-manifold non sono toccati — questo
    si occupa solo dei pinch-vert).

    Algoritmo:
      1. Costruisci v_to_f map (vert → list face indices)
      2. Per ogni vert v con ≥2 face: costruisci grafo face_a-face_b se condividono
         edge contenente v. Trova componenti connesse.
      3. Se >1 componente: prima componente mantiene v, ogni altra duplica v.
    """
    V_list = [v.copy() for v in V]
    F_mod = F.copy()

    v_to_f = defaultdict(list)
    for fi in range(len(F)):
        a, b, c = F[fi]
        v_to_f[a].append(fi)
        v_to_f[b].append(fi)
        v_to_f[c].append(fi)

    n_split = 0
    for v in list(v_to_f.keys()):
        fids = v_to_f[v]
        if len(fids) < 2:
            continue

        # Per ogni faccia, edge contenente v
        face_edges = {}
        for fi in fids:
            a, b, c = F_mod[fi]
            edges_v = []
            for u, w in [(a, b), (b, c), (a, c)]:
                if u == v:
                    edges_v.append(w)
                elif w == v:
                    edges_v.append(u)
            face_edges[fi] = edges_v  # gli "altri vert" degli edge contenenti v

        # Adjacency: 2 face condividono edge contenente v se condividono un "altro vert"
        adj = defaultdict(set)
        for i, fi in enumerate(fids):
            for fj in fids[i + 1:]:
                if set(face_edges[fi]) & set(face_edges[fj]):
                    adj[fi].add(fj)
                    adj[fj].add(fi)

        # Componenti connesse
        visited = set()
        components = []
        for fi in fids:
            if fi in visited:
                continue
            stack = [fi]
            comp = []
            while stack:
                node = stack.pop()
                if node in visited:
                    continue
                visited.add(node)
                comp.append(node)
                stack.extend(adj[node] - visited)
            components.append(comp)

        if len(components) <= 1:
            continue

        # Split: prima componente mantiene v, le altre duplicano
        for comp in components[1:]:
            new_v_idx = len(V_list)
            V_list.append(V[v].copy())
            for fi in comp:
                for k in range(3):
                    if F_mod[fi, k] == v:
                        F_mod[fi, k] = new_v_idx
            n_split += 1

    return np.array(V_list, dtype=np.float64), F_mod, n_split


def _remove_non_manifold_faces(V, F):
    """V4.2.10 — Versione vettorizzata numpy (era ~10s su 730k face, ora ~100ms).

    Identifica edge con 3+ face adiacenti (non-manifold) e rimuove le face
    eccedenti (tiene le prime 2). Garantisce che ogni edge della mesh risultante
    abbia ≤2 face. Ritorna (V, F_clean, n_removed).

    PRECONDIZIONE: questo NON tocca i vert. Se la mesh aveva pinch-vert, restano
    (usa _split_pinch_vertices PRIMA per gestirli).

    Algoritmo:
      1. Build edges (3M, 2) array da F (M face × 3 edge × 2 vert).
      2. Sort edge endpoints per canonical form.
      3. np.unique con return_inverse + return_counts: per ogni edge, n face.
      4. Filtra bad edges (count > 2), per ogni bad edge tieni solo prime 2 face.
    """
    M = len(F)
    if M == 0:
        return V, F, 0

    # Build (3M, 2) edge array
    edges = np.empty((3 * M, 2), dtype=F.dtype)
    edges[0::3] = F[:, [0, 1]]
    edges[1::3] = F[:, [1, 2]]
    edges[2::3] = F[:, [0, 2]]
    # Canonical form (sorted endpoints)
    edges_sorted = np.sort(edges, axis=1)
    # Unique edges + count
    _, inverse, counts = np.unique(
        edges_sorted, axis=0, return_inverse=True, return_counts=True)
    # Bad edges = quelli con > 2 face
    bad_edge_mask = counts > 2
    if not bad_edge_mask.any():
        return V, F, 0

    # face_idx flat: per ogni edge in edges_sorted, da quale face proviene
    face_idx_flat = np.arange(3 * M) // 3

    # Set di face "extra" da rimuovere (oltre le prime 2 per ogni bad edge)
    bad_face_set = set()
    for e_idx in np.where(bad_edge_mask)[0]:
        # Indici flat (in edges_sorted) che puntano a questo edge
        face_indices_for_edge = face_idx_flat[inverse == e_idx]
        # Tieni le prime 2, marca extra come "bad"
        for fi in face_indices_for_edge[2:]:
            bad_face_set.add(int(fi))

    if not bad_face_set:
        return V, F, 0

    keep_mask = np.ones(M, dtype=bool)
    keep_mask[list(bad_face_set)] = False
    F_clean = F[keep_mask]
    return V, F_clean, len(bad_face_set)


MIN_LOOP_VERTS = 10
# V3.4 originale = 300, V3.4 bumped = 1200, V4.2.3 ridotto = 600, V4.2.4 = 300.
# Cap per N_safe in `_offset_loop_v3` spline construction. Loop offset finale
# ha N verts (= loop originale) ma la spline è costruita su max 300 control
# points → loop offset molto smussato (cap anulare pulito, parete base non
# frastagliata). Trade-off: ratio N/300 ~8× → possibili sliver triangle nella
# fascia su clustering cuspidi (V4.2.4 accetta, da valutare visivamente).
MAX_SAMPLE_PTS = 300


# FASE 1: _polygon_signed_area_2d → ibex_primitives._geometry (import nei consumer).


# FASE 1: _newell_normal → ibex_primitives._geometry (import in _build_base).


def _extract_all_boundary_loops(V, F):
    """Tutti i boundary loop (≥ MIN_LOOP_VERTS) via DFS adjacency su edge_count==1.
    Ritorna lista di (indices, pts).
    """
    ec = {}
    for face in F:
        for i in range(3):
            e = tuple(sorted([int(face[i]), int(face[(i + 1) % 3])]))
            ec[e] = ec.get(e, 0) + 1
    bedges = [e for e, c in ec.items() if c == 1]
    if not bedges:
        return []
    adj = {}
    for a, b in bedges:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    visited, loops = set(), []
    for start in adj:
        if start in visited:
            continue
        loop, prev, curr = [start], -1, start
        visited.add(start)
        while True:
            nbs = [n for n in adj[curr] if n != prev and n not in visited]
            if not nbs:
                break
            prev, curr = curr, nbs[0]
            visited.add(curr)
            loop.append(curr)
        if len(loop) >= MIN_LOOP_VERTS:
            arr = np.array(loop, dtype=np.int64)
            loops.append((arr, V[arr].copy()))
    return loops


def _extract_boundary_loop(V, F):
    """Boundary loop più lungo (≥ MIN_LOOP_VERTS). Ritorna (indices, pts) o (None, None)."""
    loops = _extract_all_boundary_loops(V, F)
    if not loops:
        return None, None
    return max(loops, key=lambda lp: len(lp[0]))


# FASE 1: _offset_loop (+ _offset_loop_v3 / _offset_loop_shapely) → ibex_primitives.offset_loop (import in _build_base).


# FASE 1: _offset_loop_v3 → ibex_primitives.offset_loop.


# FASE 1: _offset_loop_shapely → ibex_primitives.offset_loop.


# FASE 1: _close_base_delaunay → ibex_primitives.base_close (import in _build_base).


def _build_base(loop_pts, loop_indices, depth, g2_offset, n_verts_so_far,
                    skip_base=False, logger=None, extrude_dir=None):
    """V4.1 ShapelyBuffer — Estrude lo base dal boundary loop con loft 1:1.

    Pipeline:
      - Fascia orizzontale: loft 1:1 quad split tra loop originale (loop_indices,
        N verts) e loop offsettato G2 (loop_pts_offset, N verts mappati 1:1).
      - Skirt verticale: loft 1:1 quad split tra loop offsettato e base flat.
      - Base: chiusura Delaunay 2D (skip_base=False) o aperta (skip_base=True).

    V4.1 strutturale: `_offset_loop` ora ritorna SEMPRE N verts mappati 1:1 al
    loop originale (arc-length proporzionale). Rimossi `MAX_SAMPLE_PTS` /
    `sample_idx` / fan loop fascia → ogni vert originale ha un quad regolare
    verso il vert offset corrispondente (no più "ventaglio" visibile su
    inter-cuspidi). Costo: +N verts top + +N verts base = ~+2360 verts (vs
    ~+1200 V3.20), trascurabile su 100k scansione totale.

    Se `extrude_dir` non è fornito, deriva da `_newell_normal` (può puntare
    nella direzione sbagliata su DFS invertita); per robustezza `apply()` lo
    calcola da scan_z_mean vs loop_z_mean.
    """
    # FASE 1: primitivi base importati (geometria pura); _build_base resta orchestrazione.
    from ibex_primitives._geometry import _newell_normal
    from ibex_primitives.offset_loop import _offset_loop
    from ibex_primitives.loft import loft_rings
    from ibex_primitives.base_close import _close_base_delaunay

    N = len(loop_pts)

    if extrude_dir is None:
        normal = _newell_normal(loop_pts)
        extrude_dir = np.array([0., 0., -1.0 if normal[2] >= 0 else 1.0])

    loop_pts_offset = _offset_loop(loop_pts, g2_offset, logger=logger)

    # V4.1 invariante: _offset_loop ritorna N verts mappati 1:1 al loop originale
    if len(loop_pts_offset) != N:
        if logger:
            logger(f'[FAST] modelgenerator WARNING: _offset_loop returned '
                   f'{len(loop_pts_offset)} verts, expected {N} (V4.1 requires 1:1)')
        # Fallback degenere: pad/truncate per evitare crash. In condizioni normali
        # questo branch non scatta perché V4.1 garantisce 1:1.
        if len(loop_pts_offset) > N:
            loop_pts_offset = loop_pts_offset[:N]
        else:
            loop_pts_offset = np.vstack([
                loop_pts_offset,
                np.tile(loop_pts_offset[-1], (N - len(loop_pts_offset), 1))
            ])

    base_z = loop_pts_offset[:, 2].mean() + extrude_dir[2] * depth
    base_pts = loop_pts_offset.copy()
    base_pts[:, 2] = base_z

    offset_top = n_verts_so_far
    offset_base = n_verts_so_far + N

    new_verts = np.vstack([loop_pts_offset, base_pts])

    # === Fascia: loft 1:1 (loop originale → loop offset G2) — primitivo loft_rings ===
    idx_offset = offset_top + np.arange(N)
    fascia_faces = loft_rings(loop_indices, loop_pts, idx_offset, loop_pts_offset)

    # === Skirt: loft 1:1 (loop offset → base flat) — primitivo loft_rings ===
    idx_base = offset_base + np.arange(N)
    skirt_faces = loft_rings(idx_offset, loop_pts_offset, idx_base, base_pts)

    if skip_base:
        new_faces = np.vstack([fascia_faces, skirt_faces])
    else:
        base_faces = _close_base_delaunay(base_pts, offset_base, extrude_dir)
        if len(base_faces) > 0:
            new_faces = np.vstack([fascia_faces, skirt_faces, base_faces])
        else:
            new_faces = np.vstack([fascia_faces, skirt_faces])

    return new_verts, new_faces


def _make_hollow(mesh_solid, thickness, base_z_cut, extrude_dir, logger, cache_dir=None):
    """Pipeline SDF + manifold3d boolean su mesh aperta sul fondo (skip_base=True).
    Ritorna trimesh aperta sul fondo o None se uno step fallisce.

    Step 0: pymeshlab.meshing_close_holes per sigillare la base → outer manifold-strict.
    Step 1: V4.0 OpenSDF — `_compute_sdf_open3d` (Embree). Cache SDF PER-PROGETTO
            in `cache_dir` (= active_path/sdf, da params['_sdf_cache_dir'];
            None → nessuna cache, solo compute). Ciclo-vita 2026-07-13, Legge 1.
            Lookup `{mesh_hash}.npz` PRIMA di compute. HIT → skip Embree.
            MISS → compute + save .npz compressed. Hash invariante per cambi G3.
    Step 2: marching_cubes(level=thickness) → inner shell.
            **V3.19 decimazione**: post marching_cubes, riduce inner shell ~3-4×
            via `fast_simplification.simplify` (target_reduction=0.7) preservando
            curvatura macro. Riduce carico downstream PyMeshLab repair + boolean.
    Step 3: PyMeshLab merge_close_vertices + repair non-manifold + close_holes.
    Step 4: manifold3d boolean outer - inner.
    Step 5: slice planare a base_z_cut, tiene il lato -extrude_dir.
    """
    import pymeshlab
    # V4.3 — manifold3d RIMOSSO, sostituito con Open3D Tensor API boolean_difference
    # (CGAL backend tollerante a self-intersection sub-mm — manifold3d STRICT
    # rifiutava outer dentale post-meshcleaner G2 alti come NotManifold).
    from skimage import measure

    V = np.array(mesh_solid.vertices, dtype=np.float64)
    F = np.array(mesh_solid.faces, dtype=np.int32)

    # Step 0 — Chiudi il fondo aperto della base con PyMeshLab (manifold-strict).
    # V3.6 (2026-04-30) — SafeRepair: V3.5 con `meshing_repair_non_manifold_edges`
    # /`_vertices` causava SEGFAULT del worker PyMeshLab 2025.7 su scansioni dense
    # patologiche (Upper 376k verts con self-intersection complesse). V3.6 sostituisce
    # con cleanup trimesh-based (safe, non crasha mai) + 2 filter PyMeshLab safe
    # (`remove_duplicate_faces`/`remove_unreferenced_vertices`). Se `close_holes`
    # ancora rifiuta input non-manifold → fallback solido (gestione esistente).
    # V3.13 (2026-04-30) — DISATTIVATO V3.11+V3.12 cleanup Python pure.
    # Il cleanup `_remove_non_manifold_faces` rimuoveva 35430+ face (~18%) creando
    # mesh con buchi massivi che `close_holes` riempiva con patch self-intersecanti
    # → mesh patologica per voxelize/marching_cubes → bake LENTISSIMO + crash.
    # Trade-off: senza cleanup, `delete_topology + modelgenerator` cade in fallback
    # solido (NO crash, gestione esistente V3.7 SafeFallback). Da risolvere meglio
    # in sessione futura con approccio diverso (es. split vert mirato invece di
    # rimuovere face).

    try:
        ms = pymeshlab.MeshSet()
        ms.add_mesh(pymeshlab.Mesh(V, F))
        try:
            ms.meshing_remove_duplicate_faces()
            ms.meshing_remove_unreferenced_vertices()
        except Exception as e_rep:
            logger(f'[FAST] modelgenerator: pre-close_holes safe-cleanup skipped ({e_rep})')
        ms.meshing_close_holes(maxholesize=5000, selfintersection=False, refinehole=False)
        m = ms.current_mesh()
        V = m.vertex_matrix()
        F = m.face_matrix()
        mesh_solid = trimesh.Trimesh(vertices=V, faces=F, process=False)
        logger(f'[FAST] modelgenerator: mesh chiusa {len(V)} verts')
    except Exception as e:
        logger(f'[FAST] modelgenerator WARNING: close_holes outer fallito ({e})')
        return None

    # V3.17 — Step 0.5 fix_normals SPOSTATO in apply() PRIMA di V3.14 PreCheck
    # (così Upper non cade più in SKIP).

    # V4.7 SkipOuterDecimate (2026-05-04) — DISABILITATO V4.2.11 outer decimate.
    # Causa root identificata empiricamente: fast_simplification.simplify(
    # target_reduction=0.7) sul mesh_solid post-close_holes creava T-junction
    # sub-millimetrici (vert quasi-coincidenti ma topologicamente distinti)
    # che destabilizzavano il bpy CGAL EXACT solver IDENTICO al bug V4.6
    # SkipInnerDecimate. Sintomo: signed_volume_post_Step5 oscillava NEGATIVO
    # (= -volume cutting box, box NON sottratto, resta come componente
    # separata nel risultato) per certe combinazioni G2/G3 in modo
    # NON-deterministico. Verificato sul campo 2026-05-04: G2=1.5/2.5 →
    # signed_volume=-93267/-97564mm³ (BUG), G2=0.0/0.5/2.0 → +14812/14868/
    # 14920mm³ (OK). Stessa pattern del bug V4.6. Trade-off accettato: bpy
    # boolean ~1.5x più lento su Upper denso (mesh_solid 200k+ face), ma
    # correttezza > perf. NESSUN warning prevedibile sul futuro paziente
    # con mesh diversa, quindi disabilitazione totale.
    # Codice V4.2.11 lasciato in commento per archivio storico.
    if False:  # V4.7: disabilitato (era OUTER_DECIMATE_FACE_THRESHOLD = 200000)
        OUTER_DECIMATE_FACE_THRESHOLD = 200000
        OUTER_DECIMATE_REDUCTION = 0.7
        if _FAST_SIMPLIFICATION_AVAILABLE and len(F) > OUTER_DECIMATE_FACE_THRESHOLD:
            try:
                n_face_pre = len(F)
                V_dec, F_dec = fast_simplification.simplify(
                    V.astype(np.float32),
                    F.astype(np.uint32),
                    target_reduction=OUTER_DECIMATE_REDUCTION,
                )
                if len(F_dec) > 1000 and len(V_dec) > 500:
                    V = V_dec.astype(np.float64)
                    F = F_dec.astype(np.int32)
                    mesh_solid = trimesh.Trimesh(vertices=V, faces=F, process=False)
                    logger(f'[FAST] modelgenerator: outer decimate {n_face_pre} → '
                           f'{len(F)} face (-{int(OUTER_DECIMATE_REDUCTION*100)}%, '
                           f'V4.2.11 perf)')
                else:
                    logger(f'[FAST] modelgenerator: outer decimate skipped '
                           f'(output degenere: {len(V_dec)} verts {len(F_dec)} face)')
            except Exception as e:
                logger(f'[FAST] modelgenerator: outer decimate skipped ({e})')

    # V4.2.12 — Step 0.45: PyMeshLab repair + re_orient su outer post-decimate.
    # close_holes E decimate possono introdurre face con winding non-coerente
    # rispetto al resto della mesh outer. V22.12 PostSmoothRepair in meshcleaner
    # garantisce coherence PRE-modelgenerator, ma la cascata close_holes →
    # decimate distrugge quella garanzia. Senza re_orient qui, manifold3d STRICT
    # rifiuta outer come NotManifold (problema visto sul campo: anche con G2=1000
    # e PostSmoothRepair OK in meshcleaner, outer fallisce dopo close_holes +
    # decimate). Pattern speculare a Step 3 inner repair (PyMeshLab pipeline).
    try:
        ms_o = pymeshlab.MeshSet()
        ms_o.add_mesh(pymeshlab.Mesh(V.astype(np.float64), F.astype(np.int32)))
        try:
            ms_o.meshing_repair_non_manifold_edges()
        except Exception:
            pass
        try:
            ms_o.meshing_repair_non_manifold_vertices()
        except Exception:
            pass
        try:
            ms_o.meshing_remove_duplicate_faces()
        except Exception:
            pass
        try:
            ms_o.meshing_remove_unreferenced_vertices()
        except Exception:
            pass
        try:
            ms_o.meshing_re_orient_faces_coherently()
        except Exception:
            pass
        m_o = ms_o.current_mesh()
        n_face_pre_repair = len(F)
        V = m_o.vertex_matrix()
        F = m_o.face_matrix()
        mesh_solid = trimesh.Trimesh(vertices=V, faces=F, process=False)
        logger(f'[FAST] modelgenerator: outer post-decimate repair + re_orient '
               f'OK ({n_face_pre_repair} → {len(F)} faces, V4.2.12)')
    except Exception as e:
        logger(f'[FAST] modelgenerator: outer post-decimate repair skipped ({e})')

    # V4.2.6 — Step 0.5: remove non-manifold FACES su OUTER post-close_holes.
    # `pre-PreCheck removed N` (V3.18 in apply()) elimina face nm PRIMA di
    # close_holes, ma la PATCH close_holes può introdurre NUOVE face nm (es.
    # patch face che condivide edge con face esistenti producendo edge con 3+
    # face). Su Upper 269 caso reale: pre-PreCheck rimuoveva 33 face, ma
    # outer rimane NotManifold dopo close_holes → causa = patch face nm.
    # Cap 200: oltre questa soglia, rimuovere face crea buchi grandi che
    # close_holes (già chiamato) non può richiudere → fallback solido.
    try:
        V_nm, F_nm, n_removed = _remove_non_manifold_faces(
            V.astype(np.float64), F.astype(np.int32))
        if 0 < n_removed < 200:
            V = V_nm
            F = F_nm
            mesh_solid = trimesh.Trimesh(vertices=V, faces=F, process=False)
            logger(f'[FAST] modelgenerator: outer remove_nm_faces -{n_removed} → '
                   f'{len(F)} faces (post close_holes)')
        elif n_removed >= 200:
            logger(f'[FAST] modelgenerator: outer remove_nm_faces SKIP '
                   f'(n_removed={n_removed} >= cap 200, rischio buchi grandi)')
    except Exception as e:
        logger(f'[FAST] modelgenerator: outer remove_nm_faces skipped ({e})')

    # V4.2.5 — Step 0.6: split pinch-vertices su OUTER post-close_holes.
    # Pattern speculare a Step 3.4 (V4.0 split inner). PyMeshLab close_holes
    # può introdurre pinch-vertex (vert condivisi tra disc topologicamente
    # sconnessi: la patch close_holes condivide vert con la mesh originale al
    # bordo del foro, ma se il foro tocca un punto pinch del bordo si crea un
    # nuovo pinch-vert nella outer chiusa). manifold3d.Manifold STRICT li
    # rifiuta come NotManifold. PyMeshLab `meshing_repair_non_manifold_*` non
    # li rileva. `_remove_non_manifold_faces` (V3.18 in apply() + V4.2.6 sopra)
    # elimina face con edge nm ma non i pinch-vert. `_split_pinch_vertices`
    # duplica il vert una volta per disc → garantisce 2-manifold rispetto a
    # connettività vert. Costo ~10-100ms su mesh outer 360k verts.
    try:
        V_split, F_split, n_split = _split_pinch_vertices(
            V.astype(np.float64), F.astype(np.int32))
        if n_split > 0:
            V = V_split
            F = F_split
            mesh_solid = trimesh.Trimesh(vertices=V, faces=F, process=False)
            logger(f'[FAST] modelgenerator: outer pinch-split {n_split} verts → '
                   f'{len(V)} verts {len(F)} faces')
    except Exception as e:
        logger(f'[FAST] modelgenerator: outer pinch-split skipped ({e})')

    # Step 1 — V4.0 OpenSDF (2026-05-01): SDF grid via Open3D Embree.
    # Sostituisce trimesh.voxel.creation.voxelize + binary_fill_holes +
    # distance_transform_edt × 2 (V3.19, peak RAM 2-3GB transient). Open3D
    # `compute_signed_distance` è C++ multi-thread → peak RAM <300MB, 10-50×
    # più veloce. Ciclo-vita 2026-07-13 (Legge 1): cache SDF PER-PROGETTO in
    # `cache_dir` (active_path/sdf — nel .ibex al save, morta col purge alla
    # chiusura). Hash invariante per G3 → cache HIT su drag G3 e alla
    # riapertura del progetto (sdf/ ripristinata dall'extract del .ibex).
    # Mantiene gaussian_filter post-Embree per smussare residui di bordo
    # (costo trascurabile, riduce T-junction in marching_cubes).
    from scipy.ndimage import gaussian_filter
    PITCH = 0.5
    PADDING = 1.0  # mm safety margin attorno BBox mesh per marching_cubes

    sdf_grid = None
    sdf_scale = None
    sdf_origin = None
    max_dist = 0.0
    mesh_hash = _compute_mesh_hash(V, F, PITCH)
    cache_path_sdf = (os.path.join(cache_dir, f'{mesh_hash}.npz')
                      if cache_dir else None)

    # Tentativo cache HIT (per-progetto)
    if cache_path_sdf and os.path.isfile(cache_path_sdf):
        try:
            data = np.load(cache_path_sdf)
            sdf_grid = data['sdf_grid']
            sdf_scale = data['scale']
            sdf_origin = data['origin']
            max_dist = float(data['max_dist'])
            if max_dist < thickness:
                logger(f'[FAST] modelgenerator WARNING: cached max_dist={max_dist:.2f}mm < '
                       f'thickness={thickness}mm — hollow skipped')
                return None
            logger(f'[FAST] modelgenerator: SDF [CACHE HIT] mesh_hash={mesh_hash[:8]} '
                   f'shape={sdf_grid.shape} max_dist={max_dist:.1f}mm')
        except Exception as e:
            logger(f'[FAST] modelgenerator: SDF cache lookup failed ({e}), recompute')
            sdf_grid = None  # safety: cade nel branch MISS

    # Cache MISS — compute SDF via Open3D Embree
    if sdf_grid is None:
        # FASE 1: SDF estratto in ibex_primitives.sdf (verbatim Embree, positivo-dentro).
        from ibex_primitives.sdf import compute_sdf
        result = compute_sdf(V, F, PITCH, PADDING, logger)
        if result is None:
            logger('[FAST] modelgenerator WARNING: SDF Open3D fallita')
            return None
        sdf_grid, sdf_scale, sdf_origin, max_dist = result

        if max_dist < thickness:
            logger(f'[FAST] modelgenerator WARNING: max_dist={max_dist:.2f}mm < '
                   f'thickness={thickness}mm — hollow skipped')
            return None

        # Smoothing post-Embree (smussa residui di precision al bordo).
        # V4.0: sigma=2.5 (era 2.0 in V3.19) — Embree è più "sharp" di trimesh
        # voxelize → marching_cubes produce inner shell con T-junction sub-pixel
        # che PyMeshLab repair non aggancia → manifold3d STRICT rifiuta.
        # sigma=2.5vox=1.25mm fisico riduce questi artefatti senza impattare
        # qualità (l'inner è "spazio vuoto" — perdiamo solo voxel noise).
        sdf_grid = gaussian_filter(sdf_grid, sigma=2.5).astype(np.float32)
        logger(f'[FAST] modelgenerator: SDF gaussian_filter sigma=2.5 OK')

        # Cache SAVE post-compute (errori non bloccano: cache è opzionale).
        # Write atomico via file-handle tmp + os.replace: 6 worker concorrenti;
        # il file-handle evita l'append automatico di '.npz' di numpy sul tmp;
        # il tmp dot-prefixed non entra mai nel .ibex (skip dot-file dello zip)
        # e non matcha il glob *.npz del prune SAVE_EXIT.
        if cache_path_sdf:
            try:
                os.makedirs(cache_dir, exist_ok=True)
                tmp_path = os.path.join(
                    cache_dir, f'.{mesh_hash}.npz.tmp-{os.getpid()}')
                with open(tmp_path, 'wb') as fh:
                    np.savez_compressed(
                        fh,
                        sdf_grid=sdf_grid,  # già float32
                        scale=sdf_scale,
                        origin=sdf_origin,
                        max_dist=np.array([max_dist]),
                    )
                os.replace(tmp_path, cache_path_sdf)
                logger(f'[FAST] modelgenerator: SDF [CACHE SAVE] mesh_hash={mesh_hash[:8]}')
            except Exception as e:
                logger(f'[FAST] modelgenerator: SDF cache save failed ({e})')

    # Step 2 — Marching cubes → inner shell (offset a `thickness` dentro il solid).
    # FASE 1: marching+coord estratto in ibex_primitives.offset.offset_surface
    # (verbatim: marching_cubes(level=thickness) + verts→world, scala = PITCH isotropo
    # == diag(PITCH) della SDF). V4.6 SkipInnerDecimate: nessuna decimazione, inner raw.
    from ibex_primitives.offset import offset_surface
    res_off = offset_surface(sdf_grid, sdf_origin, thickness, pitch=PITCH, logger=logger)
    if res_off is None:
        return None
    verts_world, faces_mc = res_off

    # Step 3 — Ripara inner shell con PyMeshLab (V2.6: aggiunto isotropic remeshing
    # come ultimo tentativo di pulizia topologia. Rebuild con edge isotropici
    # PITCH=0.5mm dissolve i T-junction sub-millimetrici di marching_cubes
    # naturalmente. Try/except: se il filtro fallisce su mesh non-manifold
    # input, skippa silently e prosegue con la mesh post-repair classica.
    # V3.1 (2026-04-30): aggiunto remove_connected_component_by_face_number
    # PRIMA del repair per eliminare componenti parassite dell'isosurface
    # marching_cubes — palato/sotto-massa dentale possono produrre "isole" di
    # SDF locale che apparirebbero come spike interni nella cavità).
    try:
        ms = pymeshlab.MeshSet()
        ms.add_mesh(pymeshlab.Mesh(verts_world, faces_mc))
        n_faces_in = len(faces_mc)
        ms.meshing_merge_close_vertices(threshold=pymeshlab.PureValue(0.3))
        # Rimuovi componenti < 1000 face (la shell principale ha tipicamente
        # >25k face, le isole parassite sono <500). Soglia mutuata da meshcleaner.
        try:
            ms.meshing_remove_connected_component_by_face_number(mincomponentsize=1000)
            n_post = len(ms.current_mesh().face_matrix())
            if n_post < n_faces_in:
                logger(f'[FAST] modelgenerator: inner cleanup small components '
                       f'{n_faces_in} → {n_post} faces')
        except Exception as e_cc:
            logger(f'[FAST] modelgenerator: small components cleanup skipped ({e_cc})')
        ms.meshing_repair_non_manifold_edges()
        ms.meshing_repair_non_manifold_vertices()
        ms.meshing_remove_duplicate_faces()
        ms.meshing_remove_unreferenced_vertices()
        ms.meshing_close_holes(maxholesize=1000, selfintersection=False, refinehole=False)
        # V4.2.7 — isotropic remesh ADATTIVO. V3.17 alzava densità inner per fix
        # cap saw-tooth Lower (bassa densità inner ~10-15k face → cap a 0.3 mm
        # remesh dava ~50k face). Su Upper denso (40k+ face inner post-MC),
        # remesh inflate a 6.7× (148k face) → boolean+cutting box+STL export
        # diventano bottleneck (~120s totale). Skip remesh se inner già denso
        # (>30k face cap dimostrato sufficiente per cap pulito senza inflate).
        # Risparmio atteso: ~60-90s su Upper, no impatto Lower (resta sotto cap).
        # V4.2.9: cap 30000 → 10000 — Upper inner tipico ~22k > 10k → SKIP.
        # Lower inner piccolo ~5-8k < 10k → APPLY (cap saw-tooth fix preservato).
        ISOTROPIC_REMESH_FACE_CAP = 10000
        n_pre_remesh = len(ms.current_mesh().face_matrix())
        if n_pre_remesh > ISOTROPIC_REMESH_FACE_CAP:
            logger(f'[FAST] modelgenerator: inner isotropic remesh SKIP '
                   f'({n_pre_remesh} face > cap {ISOTROPIC_REMESH_FACE_CAP}, '
                   f'già denso abbastanza)')
        else:
            try:
                # V3.17 targetlen=0.3 mantenuto per Lower (cap denso anti-saw-tooth).
                ms.meshing_isotropic_explicit_remeshing(
                    targetlen=pymeshlab.PureValue(0.3),
                    iterations=2,
                    checksurfdist=False,
                )
                logger(f'[FAST] modelgenerator: inner isotropic remesh OK '
                       f'(targetlen=0.3, n_pre={n_pre_remesh})')
            except Exception as e_remesh:
                logger(f'[FAST] modelgenerator: inner isotropic remesh skipped ({e_remesh})')
        m = ms.current_mesh()
        V_inner = m.vertex_matrix()
        F_inner = m.face_matrix()
        logger(f'[FAST] modelgenerator: inner repaired {len(V_inner)} verts {len(F_inner)} faces')
    except Exception as e:
        logger(f'[FAST] modelgenerator WARNING: repair fallito ({e})')
        return None

    # Step 3.4 — V4.0 split pinch-vertices su inner shell.
    # PyMeshLab `meshing_repair_non_manifold_edges/_vertices` gestisce edge non-
    # manifold ma NON i "pinch-vertex" (vert condivisi tra 2+ disc topologicamente
    # sconnessi). manifold3d.Manifold STRICT li rifiuta come NotManifold. Su
    # SDF Embree (più "sharp" di trimesh voxelize V3.19) marching_cubes produce
    # tipicamente alcune decine di pinch-vert al bordo dell'inner shell.
    # `_split_pinch_vertices` (V3.11, già esistente, usato per outer post-
    # delete_topology) duplica il vert una volta per ogni disc → garantisce
    # 2-manifold rispetto alla connettività vert. Costo trascurabile (~5-50ms su
    # mesh 70k verts), benefit critico: senza questo manifold3d rifiuta inner
    # → fallback solido patologico.
    try:
        V_inner_split, F_inner_split, n_split = _split_pinch_vertices(
            V_inner.astype(np.float64), F_inner.astype(np.int32))
        if n_split > 0:
            V_inner = V_inner_split
            F_inner = F_inner_split
            logger(f'[FAST] modelgenerator: inner pinch-split {n_split} verts → '
                   f'{len(V_inner)} verts {len(F_inner)} faces')
    except Exception as e:
        logger(f'[FAST] modelgenerator: inner pinch-split skipped ({e})')

    # V4.4 BPY BOOLEAN — sostituisce Open3D (V4.3) e manifold3d (pre-V4.3).
    # Open3D `boolean_difference` usa VTK backend, fallisce su CONTAINMENT
    # (caso tipico dental hollow shell: inner completamente dentro outer →
    # VTK richiede intersezione geometrica → "No Intersection between objects"
    # → empty mesh). manifold3d STRICT rifiutava self-intersection sub-mm.
    # bpy.ops.modifier_apply BOOLEAN solver=EXACT gestisce ENTRAMBI:
    #   - Containment (mesh contenuta in mesh) ✓
    #   - Self-intersection geometriche sub-mm ✓
    # Pattern V2.4 BpyBooleanFallback storico (Cleanup storici 2026-04-28).
    # Worker.py È Blender headless → bpy disponibile in-process, ~1-3s tipico
    # su mesh dentale 220k face.
    import bpy
    import bmesh as _bmesh

    # FASE 1: boolean estratto → ibex_primitives.boolean.boolean_difference (import + call al Step 4).

    # Step 3.5 — V4.5 PerComponentWinding (2026-05-01): orient winding PER-COMPONENTE.
    # Bug strutturale pre-V4.5: `trimesh.volume` ritorna la SOMMA SIGNED di TUTTE le
    # componenti connesse → su inner shell multi-cavità da marching_cubes con winding
    # mista (es. comp A = +30000mm³ correttamente outward, comp B = -5000mm³ invertita)
    # la somma globale (+25000) maschera B → check `vol < 0` False → nessun flip → B
    # resta invertita → bpy boolean produce risultati strani (parassiti "barre/elementi
    # alla base" del modello, normali caotiche radiali visibili nel toggle Normali).
    # Fix: split in componenti connesse (only_watertight=False per accettare anche
    # mesh marching_cubes non-strict-manifold), check volume per-componente, flip
    # individuale se negativo, riconcatena con offset indici.
    # V4.5.1 cap difensivo: se >MAX_COMPONENTS componenti (caso patologico
    # da marching_cubes degenere) skippa il per-component check e fa il
    # global flip V4.4 originale. Cap a 10 perché in pratica dental scan
    # produce 1-3 componenti; >10 indica mesh degenere → meglio non
    # iterare per evitare casi imprevisti.
    MAX_COMPONENTS = 10
    try:
        inner_tm_check = trimesh.Trimesh(vertices=V_inner, faces=F_inner, process=False)
        components = inner_tm_check.split(only_watertight=False)
        if len(components) == 0:
            components = [inner_tm_check]

        if len(components) > MAX_COMPONENTS:
            # FALLBACK V4.4 global flip difensivo
            vol_pre = float(inner_tm_check.volume)
            if vol_pre < 0:
                F_inner = F_inner[:, [0, 2, 1]]
                logger(f'[FAST] modelgenerator V4.5 SKIP per-component '
                       f'({len(components)} componenti > cap {MAX_COMPONENTS}) → '
                       f'global flip vol={vol_pre:.1f}mm³')
            else:
                logger(f'[FAST] modelgenerator V4.5 SKIP per-component '
                       f'({len(components)} componenti > cap {MAX_COMPONENTS}) → '
                       f'no global flip vol={vol_pre:.1f}mm³')
        else:
            V_parts = []
            F_parts = []
            v_offset = 0
            flipped_count = 0
            vol_total_signed = 0.0
            for i, comp in enumerate(components):
                cv = float(comp.volume)
                vol_total_signed += cv
                if cv < 0:
                    comp_faces = comp.faces[:, [0, 2, 1]].copy()
                    flipped_count += 1
                else:
                    comp_faces = comp.faces.copy()
                V_parts.append(np.asarray(comp.vertices, dtype=np.float64))
                F_parts.append(np.asarray(comp_faces, dtype=np.int32) + v_offset)
                v_offset += len(comp.vertices)

            V_inner = np.vstack(V_parts).astype(np.float64)
            F_inner = np.vstack(F_parts).astype(np.int32)
            logger(f'[FAST] modelgenerator V4.5 PerComponentWinding: '
                   f'{len(components)} componenti, {flipped_count} flipped, '
                   f'vol_signed_pre={vol_total_signed:.1f}mm³')
            # 2026-05-02 DIAG #1: signed_volume INNER post-V4.5 (input al boolean Step 4)
            try:
                _inner_post = trimesh.Trimesh(vertices=V_inner, faces=F_inner, process=False)
                logger(f'[FAST] modelgenerator DIAG: INNER post-V4.5 signed_volume='
                       f'{float(_inner_post.volume):+.1f}mm³ (atteso POSITIVO se cavity = volume vuoto)')
            except Exception as _e:
                logger(f'[FAST] modelgenerator DIAG INNER post-V4.5 skipped ({_e})')
    except Exception as e:
        logger(f'[FAST] modelgenerator: per-component winding skipped ({e}) — '
               f'fallback global check')
        try:
            inner_tm_check = trimesh.Trimesh(vertices=V_inner, faces=F_inner, process=False)
            vol_pre = float(inner_tm_check.volume)
            if vol_pre < 0:
                F_inner = F_inner[:, [0, 2, 1]]
                logger(f'[FAST] modelgenerator: fallback global flip vol={vol_pre:.1f}mm³')
        except Exception as e2:
            logger(f'[FAST] modelgenerator: anche fallback fallito ({e2})')

    # Step 4 — Boolean difference bpy EXACT (outer - inner).
    # FASE 1: boolean estratto in ibex_primitives.boolean (regression-guard:
    # stessa logica bpy EXACT verbatim → output equivalente alla closure).
    from ibex_primitives.boolean import boolean_difference
    res4 = boolean_difference(V, F, V_inner, F_inner, 'outer', 'inner')
    if res4 is None:
        logger(f'[FAST] modelgenerator WARNING: bpy boolean Step 4 fallito (empty/exception)')
        return None
    V_r, F_r = res4
    logger(f'[FAST] modelgenerator: bpy boolean OK {len(V_r)} verts {len(F_r)} faces')
    # 2026-05-02 DIAG #2: signed_volume RESULT post Step 4 boolean (pre-cutting box).
    # Atteso POSITIVO (mesh hollow chiusa, parete + cap inferiore = volume bounded).
    # Se NEGATIVO → boolean Step 4 ha invertito → bug a monte del cutting box.
    try:
        _result4 = trimesh.Trimesh(vertices=V_r, faces=F_r, process=False)
        logger(f'[FAST] modelgenerator DIAG: RESULT post Step 4 boolean signed_volume='
               f'{float(_result4.volume):+.1f}mm³ (atteso POSITIVO)')
    except Exception as _e:
        logger(f'[FAST] modelgenerator DIAG RESULT post Step 4 skipped ({_e})')

    # V4.7.1 (2026-05-04) — Repair PyMeshLab POST Step 4 boolean PRE Step 5
    # cutting box. Il CGAL EXACT solver di bpy può produrre T-junction sub-mm
    # e face degenerate non-deterministicamente (visibile come boolean output
    # 2-3× più denso del previsto: G2=2.5 G3=2.5 → 261903 face vs G2=2.0 →
    # 121017 face stesso input pattern). Questi T-junction destabilizzano il
    # SECONDO boolean (Step 5 cutting box) → box NON sottratto correttamente,
    # signed_volume_post_Step5 NEGATIVO. Repair PyMeshLab: merge close vert
    # 0.01mm, remove duplicate face/vert, repair non-manifold. Pattern
    # speculare a Step 3 inner repair (V4.5+).
    try:
        ms_r = pymeshlab.MeshSet()
        ms_r.add_mesh(pymeshlab.Mesh(V_r.astype(np.float64), F_r.astype(np.int32)))
        n_face_pre_r = len(F_r)
        try:
            ms_r.meshing_merge_close_vertices(threshold=PureValue(0.01))
        except Exception:
            pass
        try:
            ms_r.meshing_remove_duplicate_faces()
        except Exception:
            pass
        try:
            ms_r.meshing_remove_unreferenced_vertices()
        except Exception:
            pass
        try:
            ms_r.meshing_repair_non_manifold_edges()
        except Exception:
            pass
        try:
            ms_r.meshing_repair_non_manifold_vertices()
        except Exception:
            pass
        m_r = ms_r.current_mesh()
        V_r = m_r.vertex_matrix()
        F_r = m_r.face_matrix()
        logger(f'[FAST] modelgenerator: post-Step4 repair PyMeshLab '
               f'({n_face_pre_r} → {len(F_r)} faces, V4.7.1)')
    except Exception as _e:
        logger(f'[FAST] modelgenerator: post-Step4 repair skipped ({_e})')

    # Step 5 — Slice planare (V4.8 SlicePlane, sostituisce bpy boolean cutting box).
    # V4.7.1 PostStep4Repair non sufficiente: il PyMeshLab repair non trova
    # niente da rimuovere (255101 → 255101 faces) eppure bpy CGAL EXACT
    # boolean Step 5 fallisce non-deterministicamente per certe G2 (1.5/2.5/3.0)
    # → signed_volume_post_Step5 NEGATIVO (= -volume cutting box, box NON
    # sottratto, resta come componente nel risultato). Il bug è dentro il
    # solver CGAL stesso, NON nella mesh input. Soluzione strutturale:
    # sostituire boolean con un slice planare (`trimesh.intersections.
    # slice_mesh_plane(cap=True)`). Tagliare con un piano è un'operazione
    # geometrica semplice (loop intersection + Delaunay 2D cap), no CGAL,
    # no scenari non-deterministici. Tutto il volume oltre il piano viene
    # rimosso e il piano stesso viene capato.
    try:
        ed_z = float(extrude_dir[2])
        CUT_OFFSET = 1.0
        cut_z = float(base_z_cut) + ed_z * CUT_OFFSET

        # plane_normal punta verso parte MANTENUTA. Vogliamo tenere parte
        # OPPOSTA all'estrusione base (= dove c'è la scansione dentale).
        # extrude_dir +Z (loop sopra scan) → mantieni parte SOTTO cut_z → normal=(0,0,-1)
        # extrude_dir -Z (loop sotto scan) → mantieni parte SOPRA cut_z → normal=(0,0,+1)
        plane_normal = np.array([0.0, 0.0, -ed_z], dtype=np.float64)
        plane_origin = np.array([0.0, 0.0, cut_z], dtype=np.float64)

        # DIAG: dimensioni mesh input al slice
        v_min = np.min(V_r, axis=0)
        v_max = np.max(V_r, axis=0)
        logger(f'[FAST] modelgenerator V4.8 SlicePlane: input {len(V_r)} verts {len(F_r)} faces, '
               f'plane_z={cut_z:.2f}mm normal_z={-ed_z:+.0f} '
               f'(z_min={v_min[2]:.1f} z_max={v_max[2]:.1f})')

        mesh_pre = trimesh.Trimesh(vertices=V_r, faces=F_r, process=False)
        # FASE 1: slice estratto in ibex_primitives.slice_plane (regression-guard:
        # avvolge gli STESSI 2 rami trimesh → risultato byte-identico a V4.8).
        from ibex_primitives.slice_plane import slice_plane
        sliced = slice_plane(mesh_pre, plane_origin, plane_normal, cap=True)

        if sliced is None or len(sliced.faces) == 0:
            logger(f'[FAST] modelgenerator WARNING: slice_mesh_plane Step 5 ha prodotto mesh vuota')
            return None

        V_final = np.asarray(sliced.vertices, dtype=np.float64)
        F_final = np.asarray(sliced.faces, dtype=np.int32)
        result_capped = trimesh.Trimesh(
            vertices=V_final, faces=F_final, process=False
        )
        logger(f'[FAST] modelgenerator: slice plane hollow OK {len(result_capped.vertices)} verts '
               f'{len(result_capped.faces)} faces base_z_cut={base_z_cut:.2f}mm '
               f'cut_z={cut_z:.2f}mm (offset={CUT_OFFSET}mm, V4.8 SlicePlane)')
        # 2026-05-02 DIAG #3: signed_volume RESULT_CAPPED post Step 5 cutting box (output finale).
        # Atteso POSITIVO se hollow shell open-base ben formata. NEGATIVO = bug visibile.
        # Confronto con DIAG #2: se #2 POSITIVO e #3 NEGATIVO → cutting box è il colpevole.
        # Se entrambi NEGATIVI → bug è upstream (Step 4 boolean o INNER).
        try:
            logger(f'[FAST] modelgenerator DIAG: RESULT_CAPPED post Step 5 signed_volume='
                   f'{float(result_capped.volume):+.1f}mm³ (atteso POSITIVO)')
        except Exception as _e:
            logger(f'[FAST] modelgenerator DIAG RESULT_CAPPED post Step 5 skipped ({_e})')
        return result_capped
    except Exception as e:
        logger(f'[FAST] modelgenerator WARNING: bpy cutting box fallito ({e})')
        return None


def apply(src_path, params, output_path, logger):
    """Tier 1 entry point. G1 profondità base (mm), G2 margine 2D (mm),
    G3 spessore parete shell (mm, 0=solido).

    Ciclo-vita 2026-07-13 (Legge 1) — Cache SDF PER-PROGETTO: dir da
    params['_sdf_cache_dir'] (= active_path/sdf, iniettata dal worker in
    _apply_modelgenerator; assente → nessuna cache, solo compute). I .npz
    viaggiano nel .ibex al save e muoiono col purge alla chiusura.
    Hash chiave = SHA1(V_solid + F_solid + PITCH) post-Step 0 close_holes —
    invariante per G3: HIT su drag spessore e alla riapertura del progetto.
    """
    G1 = float(params.get('G1_Profondita_MM', 15) or 15)
    G2 = float(params.get('G2_Margine_MM',    0)  or 0)
    G3 = float(params.get('G3_Spessore_MM',   0)  or 0)

    mesh = trimesh.load(src_path, force='mesh', process=False)
    mesh.merge_vertices()
    V = np.array(mesh.vertices, dtype=np.float64)
    F = np.array(mesh.faces, dtype=np.int32)
    logger(f'[FAST] modelgenerator V4.6 IN: {len(V)} verts {len(F)} faces '
           f'(G1={G1}mm G2={G2}mm G3={G3}mm)')

    # V4.2.10 input decimate RIMOSSO V4.2.11: fast_simplification su mesh APERTA
    # collassa il boundary loop cervicale (~2656 verts → ~455 verts post-decimate
    # con edge max 56mm = collasso totale del bordo) → _offset_loop_v3 +
    # _build_base producono fascia distorta. fast_simplification non ha
    # boundary preservation. Decimate ora avviene POST close_holes (mesh chiusa,
    # nessun boundary da preservare) — vedi Step 0.4 in `_make_hollow` (V4.2.8).

    loop_indices, loop_pts = _extract_boundary_loop(V, F)
    if loop_indices is None:
        logger('[FAST] modelgenerator WARNING: nessun boundary loop')
        _export_stl_binary(mesh, output_path)
        return True

    # extrude_dir basato su geometria (massa scan vs centro loop), NON su
    # _newell_normal che dipende dall'ordine DFS dei vertici del boundary.
    # La scansione (denti) sta da un lato del boundary; lo base deve
    # estrudere DALL'ALTRO LATO (away from teeth).
    loop_z_mean = float(loop_pts[:, 2].mean())
    scan_z_mean = float(V[:, 2].mean())
    extrude_z_sign = -1.0 if scan_z_mean > loop_z_mean else 1.0
    extrude_dir = np.array([0., 0., extrude_z_sign])
    logger(f'[FAST] modelgenerator: extrude_dir_z={extrude_z_sign:+.0f} '
           f'(loop_z={loop_z_mean:.2f}mm, scan_z={scan_z_mean:.2f}mm)')

    # Profondità: se G3>0 estrudi 2×G1 per garantire volume sufficiente alla SDF.
    # skip_base=(G3>0): la base resta APERTA quando andiamo in _make_hollow
    # (Step 0 di _make_hollow la chiude con PyMeshLab close_holes — manifold-strict
    # per manifold3d, mentre _close_base_delaunay produce edge non manifold-strict).
    # Per G3=0 (solido): skip_base=False → Delaunay base diretta (export STL OK).
    depth = G1 * 2 if G3 > 0 else G1

    n_verts = len(V)
    new_v, new_f = _build_base(
        loop_pts, loop_indices, depth, G2, n_verts,
        skip_base=(G3 > 0), logger=logger, extrude_dir=extrude_dir
    )

    V_final = np.vstack([V, new_v])
    F_final = np.vstack([F, new_f])
    mesh_solid = trimesh.Trimesh(vertices=V_final, faces=F_final, process=False)

    # 2026-05-02 — DIAGNOSTIC log G2>0 winding hypothesis. Atteso:
    #   G2=0 → signed_volume POSITIVO (winding coerente, caso funzionante)
    #   G2>0 → signed_volume NEGATIVO (winding bridge invertita = bug cavità rossa)
    # Se l'ipotesi regge, il prossimo step è flip globale uniforme F_final[:,[0,2,1]].
    try:
        _msv = float(mesh_solid.volume)
        logger(f'[FAST] modelgenerator: mesh_solid signed_volume={_msv:+.1f}mm³ '
               f'(G2={G2}; POSITIVO atteso, NEGATIVO = winding invertita)')
    except Exception as _e:
        logger(f'[FAST] modelgenerator: signed_volume diagnostic skipped ({_e})')

    # V3.17 fix_normals trimesh — RIMOSSO V4.2.10 (2026-05-01).
    # Era pensato per scansioni STL grezze con winding mix CCW/CW.
    # Con meshcleaner V22.12 PostSmoothRepair upstream, la mesh è già
    # 2-manifold + re_orient_faces_coherently → trimesh fix_normals tentava
    # "uniformity globale" via flood-fill flippando 1-2% face → introduceva
    # non-manifold edges → outer NotManifold → boolean fail. Skip preserva
    # mesh come l'ha lasciata meshcleaner. Per scan grezzi senza meshcleaner
    # upstream, eventuale fix_normals va fatto in meshcleaner stesso.

    # V3.14 — PreCheck non-manifold edges su mesh_solid post-_build_base.
    # Se l'input upstream (es. delete_topology) ha lasciato edge con 3+ face,
    # _make_hollow Step 0 fallirebbe in close_holes + downstream produrrebbe
    # mesh patologica (crash o lentezza). Skip controllato: esporto solido
    # sanitized invece di tentare hollow.
    if G3 > 0:
        edge_count = defaultdict(int)
        for fi in range(len(F_final)):
            a, b, c = F_final[fi]
            edge_count[(min(a, b), max(a, b))] += 1
            edge_count[(min(b, c), max(b, c))] += 1
            edge_count[(min(a, c), max(a, c))] += 1
        n_nm_edges = sum(1 for cnt in edge_count.values() if cnt > 2)

        # V3.18 — cleanup chirurgico se POCHI nm edges residui (Upper edge case
        # post fix_normals). Per pochi (<100) face: rimuovi le face eccedenti,
        # mesh resta quasi-intatta. Per molti (>=100): skip cleanup (V3.12
        # lesson: rimuovere 18% face crea buchi enormi → mesh patologica).
        if 0 < n_nm_edges < 100:
            try:
                V_nm, F_nm, n_removed = _remove_non_manifold_faces(V_final, F_final)
                if n_removed > 0:
                    logger(f'[FAST] modelgenerator: pre-PreCheck removed {n_removed} '
                           f'non-manifold faces ({len(F_final)} → {len(F_nm)} faces)')
                    V_final, F_final = V_nm, F_nm
                    mesh_solid = trimesh.Trimesh(vertices=V_final, faces=F_final, process=False)
                    # Re-count post cleanup
                    edge_count = defaultdict(int)
                    for fi in range(len(F_final)):
                        a, b, c = F_final[fi]
                        edge_count[(min(a, b), max(a, b))] += 1
                        edge_count[(min(b, c), max(b, c))] += 1
                        edge_count[(min(a, c), max(a, c))] += 1
                    n_nm_edges = sum(1 for cnt in edge_count.values() if cnt > 2)
            except Exception as e:
                logger(f'[FAST] modelgenerator: pre-PreCheck nm cleanup skipped ({e})')

        if n_nm_edges > 0:
            logger(f'[FAST] modelgenerator: SKIP _make_hollow — mesh_solid ha {n_nm_edges} '
                   f'non-manifold edges (probabile delete_topology upstream). '
                   f'Esporto solido sanitized senza hollow.')
            try:
                fallback_clean = trimesh.Trimesh(
                    vertices=mesh_solid.vertices,
                    faces=mesh_solid.faces,
                    process=True, validate=True,
                )
                fallback_clean.merge_vertices()
                fallback_clean.remove_unreferenced_vertices()
                _export_stl_binary(fallback_clean, output_path)  # V3.19 binary
                logger(f'[FAST] modelgenerator: solid export OK '
                       f'{len(fallback_clean.vertices)} verts {len(fallback_clean.faces)} faces')
            except Exception as e_fb:
                logger(f'[FAST] modelgenerator: sanitize skipped ({e_fb}) — export raw')
                _export_stl_binary(mesh_solid, output_path)  # V3.19 binary
            out = trimesh.load(output_path, force='mesh', process=False)
            logger(f'[FAST] modelgenerator V4.6 OUT: {len(out.vertices)} verts {len(out.faces)} faces')
            return True

    if G3 > 0:
        # base_z_cut = quota della prima estrusione = piano di taglio finale.
        base_z_cut = float(loop_pts[:, 2].mean()) + extrude_dir[2] * G1
        # Ciclo-vita 2026-07-13 — cache SDF per-progetto: dir iniettata dal
        # worker in params['_sdf_cache_dir'] (None → nessuna cache).
        result = _make_hollow(mesh_solid, G3, base_z_cut, extrude_dir, logger,
                              cache_dir=params.get('_sdf_cache_dir'))
        if result is None:
            logger('[FAST] modelgenerator WARNING: hollow fallito — esporto solido')
            # V3.7 SafeFallback — sanifica la mesh PRIMA di export per evitare
            # STL patologico che fa crashare i bake successivi (mesh con self-
            # intersection/non-manifold residue producono STL "soup" gigante che
            # va in OOM/segfault al prossimo trimesh.load o pymeshlab.add_mesh).
            try:
                fallback_clean = trimesh.Trimesh(
                    vertices=mesh_solid.vertices,
                    faces=mesh_solid.faces,
                    process=True, validate=True,
                )
                fallback_clean.merge_vertices()
                fallback_clean.remove_unreferenced_vertices()
                logger(f'[FAST] modelgenerator: fallback solid sanitized '
                       f'{len(mesh_solid.vertices)} → {len(fallback_clean.vertices)} verts, '
                       f'{len(mesh_solid.faces)} → {len(fallback_clean.faces)} faces')
                _export_stl_binary(fallback_clean, output_path)  # V3.19 binary
            except Exception as e_fb:
                logger(f'[FAST] modelgenerator: fallback cleanup skipped ({e_fb}) — export raw')
                _export_stl_binary(mesh_solid, output_path)  # V3.19 binary
        else:
            _export_stl_binary(result, output_path)  # V3.19 binary
    else:
        _export_stl_binary(mesh_solid, output_path)  # V3.19 binary

    out = trimesh.load(output_path, force='mesh', process=False)
    logger(f'[FAST] modelgenerator V4.6 OUT: {len(out.vertices)} verts {len(out.faces)} faces')
    return True
