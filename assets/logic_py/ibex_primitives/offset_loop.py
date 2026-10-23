"""Offset 2D del boundary loop — primitivo (FASE 1).

Estratto verbatim da modelgenerator: `_offset_loop` (dispatcher V3→shapely,
sign-aware) + `_offset_loop_v3` (bisettrice + anti-self-intersection + resample
spline 1:1) + `_offset_loop_shapely` (fallback Minkowski Polygon.buffer +
closest-point). Firma pubblica = `_offset_loop`.

Pura Python (numpy/shapely/scipy — import locali nelle funzioni come l'originale),
niente bpy/DAG/worker. `_polygon_signed_area_2d` importato dal modulo condiviso
_geometry (nessuna dipendenza primitivo→modelgenerator).
"""
import numpy as np

from ibex_primitives._geometry import _polygon_signed_area_2d

# V4.2.4 — cap control points loop offset (smussa cap anulare / parete base).
MAX_SAMPLE_PTS = 300


def _offset_loop(pts, offset_mm, logger=None):
    """V4.2 Hybrid V3.0 + Shapely — V3.0 primary (cubic spline + bisezione +
    t_orig_frac mapping 1:1 al loop originale per costruzione), shapely.buffer
    fallback per loop patologici dove V3.0 non riesce.

    Decisione strategica (2026-05-01, su feedback utente "V3.0 aveva il miglior
    calcolo del margine"): V3.0 era già 1:1 mapping nativo via `t_orig_frac =
    cum[:-1] / perimeter` (campiona la spline ai parametri arc-length cumulativi
    del loop originale). V3.20 ArcLengthOffset l'ha rotto sostituendo con
    arc-length uniform della spline → fan triangle fascia visibile post-V4.0.
    V4.1 ShapelyBuffer ha tentato di replicare il pattern 1:1 via closest-point
    projection ma su loop dentali con concavità il mapping geometric produce
    distorsioni nella fascia (vert offset[i] non in corrispondenza topologica
    con vert originale[i]). V4.2 torna a V3.0 nativo come PRIMARY, mantiene
    shapely come SAFETY NET per loop dove V3.0 fallisce (effective_offset <
    50% target dopo bisezione, OR bisezione non convergente affatto).

    Pipeline:
      1. Prova `_offset_loop_v3(pts, offset_mm, logger)` → (result, ratio)
      2. Se ratio >= 0.5 → return result (V3.0 OK, fascia geometricamente
         corretta per costruzione del t_orig_frac mapping)
      3. Altrimenti → fallback `_offset_loop_shapely` (Minkowski + closest-
         point projection — robusto su zone concave estreme dove V3.0 fallisce)

    Output: N verts (= len(pts)). Sign-aware: offset>0 outset, offset<0 inset.
    """
    if offset_mm == 0:
        return pts

    def _log(msg):
        if logger is not None:
            logger(f'[FAST] modelgenerator _offset_loop: {msg}')

    # === V3.0 PRIMARY PATH ===
    result_v3, ratio = _offset_loop_v3(pts, offset_mm, logger)
    if result_v3 is not None and ratio >= 0.5:
        _log(f'V3.0 PRIMARY OK (effective_ratio={ratio:.2%})')
        return result_v3

    # === Shapely FALLBACK ===
    if result_v3 is None:
        _log('V3.0 FALLBACK (bisezione non convergente, anche dopo 12 iter '
             'su decimato) → tento shapely.buffer + closest-point')
    else:
        _log(f'V3.0 FALLBACK (effective_ratio={ratio:.2%} < 50% target) → '
             f'tento shapely.buffer + closest-point')

    return _offset_loop_shapely(pts, offset_mm, logger)


def _offset_loop_v3(pts, offset_mm, logger):
    """V3.0 algoritmo originale: decimazione + cubic spline + bisezione anti-
    autointersezione + resample con t_orig_frac (1:1 mapping al loop originale
    per costruzione).

    Returns (result, ratio):
      - result: np.ndarray (N, 3) loop offset, mappato 1:1 al loop originale
        (Z preservato dalla spline_z), o None se bisezione non converge.
      - ratio: effective_offset / abs(offset_mm) ∈ [0, 1]. None se result None.

    N_safe alto (formula V3.0 originale: ~250 control points per offset~1.5mm)
    per evitare smoothing eccessivo della curvatura del loop scansione →
    spline aderente al loop originale → mapping t_orig_frac geometricamente
    corretto.
    """
    from shapely.geometry import LinearRing
    from scipy.interpolate import CubicSpline

    def _log(msg):
        if logger is not None:
            logger(f'[FAST] modelgenerator _offset_loop_v3: {msg}')

    def _compute_offset(pts_input, off):
        """Bisezione bisettrice + scale cap. Sign-aware. Inverted check via area."""
        Nx = len(pts_input)
        result = np.zeros_like(pts_input)
        scales = np.zeros(Nx)
        abs_off = abs(off)
        sign = 1 if off > 0 else -1
        for i in range(Nx):
            prev = pts_input[(i - 1) % Nx]
            curr = pts_input[i]
            nxt = pts_input[(i + 1) % Nx]
            e1 = curr - prev
            e2 = nxt - curr
            n1 = np.array([-e1[1], e1[0], 0.0])
            n2 = np.array([-e2[1], e2[0], 0.0])
            n1_len = np.linalg.norm(n1)
            n2_len = np.linalg.norm(n2)
            if n1_len > 0:
                n1 /= n1_len
            if n2_len > 0:
                n2 /= n2_len
            bisect = n1 + n2
            b_len = np.linalg.norm(bisect)
            if b_len > 0:
                bisect /= b_len
            else:
                bisect = n1
            cos_a = np.clip(np.dot(n1, n2), -1.0, 1.0)
            angle = np.arccos(cos_a)
            cos_half = np.cos(angle / 2.0)
            if cos_half > 0.1:
                scale = min(1.0 / cos_half, 3.0)
            else:
                scale = 3.0
            scales[i] = scale
            result[i] = curr + sign * bisect * abs_off * scale

        area_orig = abs(_polygon_signed_area_2d(pts_input[:, :2]))
        area_result = abs(_polygon_signed_area_2d(result[:, :2]))
        if sign > 0:
            inverted = bool(area_result < area_orig)
        else:
            inverted = bool(area_result > area_orig)
        if inverted:
            result = 2 * pts_input - result
        return result, scales, inverted

    N = len(pts)
    diffs = np.diff(np.vstack([pts, pts[:1]]), axis=0)
    lens_xy = np.linalg.norm(diffs[:, :2], axis=1)
    cum = np.concatenate([[0.0], np.cumsum(lens_xy)])
    perimeter = float(cum[-1])

    # V4.2.3 — Spline SEMPRE attiva (rimosso NO_SPLINE_THRESHOLD V4.2.1).
    # MAX_SAMPLE_PTS=600 cap control points → loop offset smussato (su feedback
    # utente "deve avere meno elementi"). Su loop dentale tipico N=2361:
    # N_safe = min(2361, 600, int(241.8/1.25)*4=773) = 600. Trade-off: ratio
    # N/600 = 4× nel `t_orig_frac` resample → possibili sliver edge (era il
    # motivo di NO_SPLINE_THRESHOLD V4.2.1). Accettato come baseline V4.2.3,
    # da valutare visivamente. Se sliver torna problematico → pensare a
    # smoothing tangenziale post-fascia o cap dinamico basato su offset_mm.
    SAFETY_FACTOR = 2.5
    target_edge = max(SAFETY_FACTOR * abs(offset_mm), 1.0)
    N_safe = max(20, min(N, MAX_SAMPLE_PTS, int(perimeter / target_edge) * 4))
    skip_spline = (N_safe >= N)

    _log(f'perimeter={perimeter:.1f}mm, N_input={N}, target offset={offset_mm:.2f}mm '
         f'→ N_safe={N_safe} (target_edge={target_edge:.2f}mm, V3.0, '
         f'cap={MAX_SAMPLE_PTS}, skip_spline={skip_spline})')

    # Decimazione arc-length uniform a N_safe verts
    if N_safe >= N:
        pts_dec = pts.copy()
    else:
        t_dec = np.linspace(0, perimeter, N_safe, endpoint=False)
        idx_dec = np.searchsorted(cum[:-1], t_dec, side='right') - 1
        idx_dec = np.clip(idx_dec, 0, N - 1)
        frac_dec = (t_dec - cum[idx_dec]) / np.maximum(lens_xy[idx_dec], 1e-9)
        pts_dec = ((1.0 - frac_dec[:, None]) * pts[idx_dec]
                   + frac_dec[:, None] * pts[(idx_dec + 1) % N])

    # FAST-PATH: prova target offset diretto su decimato
    lo, hi = 0.0, offset_mm
    result_dec, scales, inverted = _compute_offset(pts_dec, hi)

    if LinearRing(result_dec[:, :2]).is_simple:
        n_capped = int((scales == 3.0).sum())
        _log(f'FAST-PATH simple at offset={hi:.2f}mm (decimated, '
             f'inverted={inverted}, scale min/mean/max='
             f'{scales.min():.2f}/{scales.mean():.2f}/{scales.max():.2f}, '
             f'capped {n_capped}/{len(scales)})')
        effective_offset = hi
    else:
        # BISEZIONE: cerca il massimo offset che produce loop simple
        _log(f'NON-SIMPLE at target={hi:.2f}mm — attivo BISEZIONE 12 iter')
        final_scales = scales
        for _it in range(12):
            mid = (lo + hi) / 2.0
            candidate, cand_scales, _cand_inv = _compute_offset(pts_dec, mid)
            if LinearRing(candidate[:, :2]).is_simple:
                lo = mid
                result_dec = candidate
                final_scales = cand_scales
            else:
                hi = mid

        if not LinearRing(result_dec[:, :2]).is_simple or lo == 0.0:
            _log('BISEZIONE non convergente (loop sempre non-simple) → V3.0 FAIL')
            return None, None

        effective_offset = lo
        n_capped = int((final_scales == 3.0).sum())
        pct = lo / offset_mm * 100.0
        _log(f'BISEZIONE converged: target={offset_mm:.2f}mm → effective={lo:.4f}mm '
             f'({pct:.1f}%) (capped {n_capped}/{len(final_scales)})')

    # Spline + remap t_orig_frac (1:1 al loop originale)
    if N_safe >= N:
        # Nessuna decimazione fatta → result_dec è già su N verts del loop originale
        return result_dec, abs(effective_offset) / abs(offset_mm)

    t_dec_pts = np.arange(N_safe + 1) / float(N_safe)
    result_dec_periodic = np.vstack([result_dec, result_dec[:1]])
    spline_x = CubicSpline(t_dec_pts, result_dec_periodic[:, 0], bc_type='periodic')
    spline_y = CubicSpline(t_dec_pts, result_dec_periodic[:, 1], bc_type='periodic')
    spline_z = CubicSpline(t_dec_pts, result_dec_periodic[:, 2], bc_type='periodic')

    # V3.0 RESAMPLE: t_orig_frac = cum[:-1] / perimeter — campiona la spline
    # ai parametri arc-length cumulativi del loop ORIGINALE → mapping 1:1 nativo.
    # Vert offset[i] corrisponde topologicamente a vert originale[i] PER COSTRUZIONE.
    t_orig_frac = cum[:-1] / perimeter
    result = np.column_stack([
        spline_x(t_orig_frac),
        spline_y(t_orig_frac),
        spline_z(t_orig_frac),
    ])

    final_diffs = np.diff(np.vstack([result, result[:1]]), axis=0)
    final_lens = np.linalg.norm(final_diffs[:, :2], axis=1)
    min_edge = float(final_lens.min()) if len(final_lens) > 0 else 0.0
    max_edge = float(final_lens.max()) if len(final_lens) > 0 else 0.0
    mean_edge = float(final_lens.mean()) if len(final_lens) > 0 else 0.0

    radial_dists = np.linalg.norm(result[:, :2] - pts[:, :2], axis=1)
    radial_mean = float(radial_dists.mean())

    _log(f'remap t_orig_frac N_safe={N_safe} → N={N} '
         f'(edge min/mean/max={min_edge:.4f}/{mean_edge:.4f}/{max_edge:.4f}mm, '
         f'radial mean={radial_mean:.3f}mm vs target={abs(effective_offset):.3f}mm)')

    return result, abs(effective_offset) / abs(offset_mm)


def _offset_loop_shapely(pts, offset_mm, logger):
    """V4.1 fallback path: shapely.Polygon.buffer (Minkowski CGAL) + closest-
    point projection. Usato quando V3.0 fallisce su loop molto concavi.

    Robusto per costruzione su loop con self-intersezione 2D (make_valid)
    o concavità strette (Minkowski sum gestisce nativamente). Trade-off:
    closest-point projection può produrre fascia leggermente distorta su
    zone con curvatura molto variabile, ma evita autointersezione completa.

    V4.2.2 fix Z appiattita: la Z di ogni vert offset[i] viene PRESERVATA
    1:1 da `pts[i, 2]` (Z del vert originale corrispondente). Pre-V4.2.2
    usavo `z_const = mean(pts[:, 2])` → loop offset orizzontale → fascia
    appiattita Z visivamente sbagliata → utente "BOCCIATO". XY è proiettato
    closest-point sulla curva offset shapely 2D, Z viene da vert originale.
    Coerente per costruzione con la fascia 1:1: top fascia (vert originale[i])
    e mid fascia (vert offset[i]) hanno stessa Z → no salto verticale visibile.
    """
    from shapely.geometry import Polygon, LineString, Point

    def _log(msg):
        if logger is not None:
            logger(f'[FAST] modelgenerator _offset_loop_shapely: {msg}')

    N = len(pts)
    pts_2d = pts[:, :2]
    pts_z = pts[:, 2]  # V4.2.2: Z preservata 1:1 (no più z_const appiattita)

    try:
        poly = Polygon(pts_2d)
    except Exception as e:
        _log(f'WARNING Polygon construction failed ({e}), fallback pts')
        return pts

    if not poly.is_valid:
        try:
            from shapely.validation import make_valid
            fixed = make_valid(poly)
            if fixed.geom_type == 'MultiPolygon':
                poly = max(fixed.geoms, key=lambda p: p.area)
            elif fixed.geom_type == 'Polygon':
                poly = fixed
            else:
                _log(f'WARNING make_valid produced {fixed.geom_type}, fallback pts')
                return pts
            _log(f'Polygon was invalid, repaired via make_valid → {poly.geom_type}')
        except Exception as e:
            _log(f'WARNING make_valid failed ({e}), fallback pts')
            return pts

    try:
        buffered = poly.buffer(offset_mm, join_style=1, resolution=16)
        if buffered.is_empty:
            _log(f'WARNING buffer empty, fallback pts')
            return pts
        if buffered.geom_type == 'MultiPolygon':
            buffered = max(buffered.geoms, key=lambda p: p.area)
        elif buffered.geom_type != 'Polygon':
            _log(f'WARNING buffer produced {buffered.geom_type}, fallback pts')
            return pts
    except Exception as e:
        _log(f'WARNING buffer failed ({e}), fallback pts')
        return pts

    coords = np.array(buffered.exterior.coords[:-1])
    M = len(coords)
    if M < 4:
        _log(f'WARNING buffer produced only {M} verts, fallback pts')
        return pts

    perim_orig = float(poly.exterior.length)
    perim_buf = float(buffered.exterior.length)
    _log(f'shapely buffer: input N={N} perim={perim_orig:.1f}mm → '
         f'output M={M} perim_buf={perim_buf:.1f}mm '
         f'(offset={offset_mm:+.2f}mm, join=round, resolution=16)')

    # Closest-point projection: per ogni vert originale, trova il punto più
    # vicino (euclideo) sulla curva offset.
    try:
        buf_line = LineString(np.vstack([coords, coords[:1]]))
    except Exception as e:
        _log(f'WARNING LineString construction failed ({e}), fallback pts')
        return pts

    pts_2d_offset = np.zeros((N, 2), dtype=np.float64)
    for i in range(N):
        p_orig = Point(pts_2d[i, 0], pts_2d[i, 1])
        s = buf_line.project(p_orig)
        p_proj = buf_line.interpolate(s)
        pts_2d_offset[i, 0] = p_proj.x
        pts_2d_offset[i, 1] = p_proj.y

    # V4.2.2 fix: Z preservata 1:1 dal vert originale[i] (no più appiattimento)
    result = np.column_stack([pts_2d_offset, pts_z])

    radial_dists = np.linalg.norm(pts_2d_offset - pts_2d, axis=1)
    radial_mean = float(radial_dists.mean())
    radial_max = float(radial_dists.max())
    z_min, z_max = float(pts_z.min()), float(pts_z.max())
    _log(f'closest-point projection N={N} (radial mean={radial_mean:.3f}mm '
         f'max={radial_max:.3f}mm vs target={abs(offset_mm):.3f}mm, '
         f'Z preservata range=[{z_min:.2f}, {z_max:.2f}]mm)')

    return result
