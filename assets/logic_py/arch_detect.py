"""arch_detect — Tier 1 destructive node (V2.0, 2026-05-12).

V2.0 RETROCESSIONE CONCETTUALE post-feedback edentulo:
Il dominio applicativo target di arch_detect include modelli edentuli
(arcate per protesi mobile, impianti, ecc.). In questi modelli la "cresta"
NON è un'aggregazione di cuspidi sparse ma una LINEA CONTINUA del rilievo
gengivale residuo. La curvatura locale (mean curv) non identifica la cresta
edentula (riassorbimento → cresta smooth → curvatura bassa uniforme).

Algoritmo V2.0:
  1. Load + merge_vertices (Inv. 117)
  2. PCA orientation (axis0 transverse, axis1 anteroposterior, axis2 vertical)
  3. elevation_sign via Newell normal del boundary loop più lungo (gum margin).
     Cresta è in direzione OPPOSTA all'estrusione modelgenerator → robusto sia
     per dentato sia per edentulo.
  4. Ridge skeleton via "bin top-axis2": per ogni bin axis0 (60 bin), prendi i
     top 5% vert per axis2-elevation-adjusted, calcola mediana di posizione.
     Risultato: la cresta REALE del paziente, sia che siano cuspidi dentate sia
     cresta alveolare edentula.
  5. Gaussian smooth (sigma=2 bin) + cubic spline resample arc-length 50 pts
  6. Z-offset elevation (slider UI 0-15mm, default 5mm) sopra la cresta
  7. Template fit ICP (V1.8/1.9) → CLASSIFICATION ONLY: identifica quale dei
     4 template ortodontici ideali (ovoid/square/tapered/narrow) meglio
     approssima la cresta del paziente. NON sostituisce la curva (V1.x-V1.9
     bug retrocesso). Solo metadata clinico.

Storia versions:
  - V1.0 SDF+curv score, V1.5 drop SDF, V1.6 clip robusto, V1.7 no CC filter
  - V1.8 TemplateICP + Z-offset (REPLACE skeleton → idealizzava troppo)
  - V1.9 LandmarkTemplates (forme parametriche → forme anatomiche)
  - V2.0 RIDGE: skeleton top-axis2, drop curv-driven detection, template
    classification metadata (no replace)


Estrazione automatica dell'arcata alveolare di una scansione dentale.

Output:
  - Mesh: passthrough del master (nessuna modifica geometrica).
  - File collaterale `.crv.json`: 1 spline aperta (cyclic=False) con
    ~50 control points che segue l'asse longitudinale dell'arcata
    dall'ultimo molare di destra all'ultimo molare di sinistra, passando
    sopra la cresta alveolare.

Schema datablock CRV identico a draw_curve (Inv. 117):
  {
    "splines": [{ "control_points": [[x,y,z], ...], "cyclic": false }],
    "metadata": { tool, version, n_verts_input, n_verts_selected,
                  sdf_p30, curv_p70, n_bins, ... }
  }

Algoritmo:
  1. Load mesh + merge_vertices (Inv. 117 pre-weld)
  2. PCA orientation (axis0=transverse, axis1=anteroposterior,
     axis2=vertical/occlusale). Frame canonico right-handed.
  3. Pre-smoothing Taubin 3 iter (riduce rumore senza shrinkage)
  4. Cache lookup via pml_cache: SDF + mean curvature per-vertex (SDF
     resta cachato per future use ma NON usato dal score arch_detect —
     scan dentale è open mesh, SDF instabile)
  5. Score = (mean_curv > curv_p70) — solo curvatura, NaN-safe
     - curvatura media alta = creste (cuspidi, bordo gengivale/alveolare)
     - filtro NaN/inf su mesh sculpt con facce degenerate
  6. Filtra a 1 componente connesso più grande (rimuove rumore isolato)
  7. Proietta i vert selezionati nel piano PCA (2D: axis0, axis1)
  8. Skeleton via "transverse bins":
     - Bin axis0 in 50 contenitori
     - In ogni bin: mediana di axis1 → punto centrale
     - Polyline da bin più a sx al bin più a dx
  9. Smoothing Gaussian σ=2 bin sulla polyline
  10. Resample uniforme arc-length a 50 control points
  11. Unproject 3D: per ogni punto 2D risolvi axis2 = mediana di axis2
      tra i vert selezionati locali (raggio 2mm nel piano)
  12. Scrivi .crv.json + passthrough mesh

Limiti V1.0:
  - Scansione assunta come arcata completa (12-16 denti). Frammenti parziali
    o quadranti singoli daranno curve troncate.
  - Nessun template ICP fitting (V1.1 futuro): la curva può presentare lievi
    irregolarità ereditate dal rumore di scansione anche dopo Gaussian.
  - PCA assume scansione orientata in modo "tipico" (occlusale circa
    orizzontale). Per scan ruotati di 90° l'asse vertico può confondersi
    con anteroposteriore — il check sul rapporto degli eigenvalue lo
    intercetta e abort.
  - Score sui percentili (p30 SDF, p70 curv) potrebbe non funzionare su
    mesh non-dentali (es. utente seleziona per errore una cera).

apply(src_mesh_path, params, output_path, crv_output_path, logger, cache_dir) -> bool
"""

import json
import os
import numpy as np


# =================== CONFIGURAZIONE ==========================
N_CTRL_POINTS = 50                 # control points della curva output
N_BINS = 60                        # bin axis0 per lo skeleton
CURV_PERCENTILE = 70.0             # soglia alta curvatura media (creste)
# SDF_PERCENTILE rimosso V1.5 — score non usa più SDF (open mesh).

# V1.8 (2026-05-12): Z-OFFSET elevazione curva sopra cresta alveolare.
# La curva non deve essere "adagiata" sulla mesh ma SOPRA, in direzione +Z
# locale (opposta a extrude_dir del modelgenerator → verso cuspidi/occlusale).
# 5mm = elevation standard per visualizzazione e use clinico (Bonwill,
# Hawley-Brader curve). Range UI: 0-15mm.
DEFAULT_Z_OFFSET_MM = 5.0

# V1.9 (2026-05-12): 4 template ortodontici basati su LANDMARK ANATOMICI
# da letteratura clinica (Felton 1987, Ricketts, Andrews) invece di formule
# parametriche generiche. Ogni template definisce 7 posizioni di mid-arch
# (M2, M1, PM2, PM1, C, I2, I1) in canonical frame:
#   - apex (I1) a +Y_max (anteriore, mid-line)
#   - tail (M2) a (±X_max, Y_min, negativo)
#   - asse X = transverse, asse Y = anteroposterior
# Mirror symmetric: i 7 landmarks mid-arch + 6 lato dx generano 13 punti
# totali, interpolati via cubic spline uniforme arc-length a N_CTRL_POINTS.
#
# Caratteristiche cliniche dei 4 template:
#   - ovoid:   intermolare 54mm, intercanino 26mm, lunghezza ant-post 33mm
#              forma "ideale" Class I — bilanciata, ginocchio canino moderato
#   - square:  intermolare 56mm, intercanino 30mm, lunghezza 30mm
#              posteriore più largo, anteriore più piatto (Andrews flat)
#   - tapered: intermolare 48mm, intercanino 20mm, lunghezza 36mm
#              anteriore più appuntito (forma "V"), ginocchio canino marcato
#   - narrow:  intermolare 44mm, intercanino 22mm, lunghezza 28mm
#              tutto piccolo, proporzioni simili ovoid ma scalato
#
# Tutti i landmark (x_mm, y_mm) sono in canonical frame relative al midline.
# x = distanza assoluta dalla mid-line (mm), >= 0 (mirror-symmetric).
# y = anteroposterior position (mm). Apex (I1) a max(y), molari a min(y).
#
# V2.5 (2026-05-13) — 10 TEMPLATE ORTODONTICI PREFORMATI
#   Riferimento commerciale (filo da apparecchio fisso vestibolare):
#   - G&H / Trueform: Europa I, Europa II, Standard Form
#   - 3M / Mathieu:   Trueform I, Trueform II
#   - GAC/Dentsply Bioform: I, II, III, IV, V (progressive wide → tapered)
#
#   Differenziazione clinica su 3 dimensioni (mm):
#   - W6 (m1 × 2) intermolare 1° — ampia (square) vs stretta (tapered)
#   - W3 (c × 2) intercanina    — ampia (square) vs stretta (tapered)
#   - Depth (apex i1 − apex m2) — corta (square) vs profonda (tapered)
#
#   Tutti i landmark (x_abs_mm, y_mm) in canonical frame, x ≥ 0 mirror-symmetric.
#   Apex i1 a max(y), molari a min(y). Procrustes (axis-wise scale + translation)
#   adatta il template alle proporzioni della cresta del paziente.
#
TEMPLATE_LANDMARKS = {
    # ─── G&H Trueform / Mathieu (forme classiche labiali) ─────────────
    'europa_1': {  # MBT Ovoid Compatible — classica ovoidale
        'm2': (27.0, -16.0),
        'm1': (24.5, -10.5),
        'p2': (20.5, -5.5),
        'p1': (17.0, -1.0),
        'c':  (13.0,  4.0),
        'i2': (6.5,   12.0),
        'i1': (2.0,   17.0),
    },
    'europa_2': {  # Damon Compatible — più aperta in posteriore
        'm2': (28.5, -15.0),
        'm1': (26.0, -9.5),
        'p2': (22.0, -5.0),
        'p1': (18.5, -0.5),
        'c':  (14.0,  4.5),
        'i2': (7.0,   12.5),
        'i1': (2.0,   17.5),
    },
    'trueform_1': {  # Roth/MBT Square — più ampia in canina, flat anteriore
        'm2': (28.0, -14.0),
        'm1': (26.0, -9.0),
        'p2': (22.5, -4.5),
        'p1': (19.5, -0.5),
        'c':  (15.5,  3.5),
        'i2': (8.0,   9.0),
        'i1': (2.5,   12.0),
    },
    'trueform_2': {  # variante square più piccola
        'm2': (26.0, -13.0),
        'm1': (24.0, -8.5),
        'p2': (21.0, -4.0),
        'p1': (18.0, -0.5),
        'c':  (14.5,  3.5),
        'i2': (7.5,   9.0),
        'i1': (2.5,   12.0),
    },
    'standard_form': {  # classica bilanciata (universal)
        'm2': (25.0, -15.5),
        'm1': (23.5, -10.0),
        'p2': (20.0, -5.0),
        'p1': (17.0, -0.5),
        'c':  (13.0,  4.0),
        'i2': (6.5,   12.0),
        'i1': (2.0,   16.5),
    },
    # ─── GAC/Dentsply Bioform (progressive: wide → tapered/narrow) ─────
    'bioform_1': {  # più ampia della serie Bioform
        'm2': (28.5, -16.5),
        'm1': (26.0, -11.0),
        'p2': (22.0, -5.5),
        'p1': (18.5, -0.5),
        'c':  (15.0,  4.5),
        'i2': (7.5,   12.5),
        'i1': (2.5,   17.5),
    },
    'bioform_2': {  # media-ampia
        'm2': (26.5, -17.0),
        'm1': (24.0, -11.5),
        'p2': (20.5, -6.0),
        'p1': (17.0, -0.5),
        'c':  (13.5,  4.5),
        'i2': (7.0,   13.0),
        'i1': (2.0,   18.0),
    },
    'bioform_3': {  # MBT Tapered Compatible — media-stretta, depth maggiore
        'm2': (24.0, -18.0),
        'm1': (21.0, -12.0),
        'p2': (17.5, -6.5),
        'p1': (14.5, -2.0),
        'c':  (10.0,  4.5),
        'i2': (4.5,   14.0),
        'i1': (1.5,   20.0),
    },
    'bioform_4': {  # stretta
        'm2': (22.0, -18.5),
        'm1': (19.5, -12.5),
        'p2': (16.0, -6.5),
        'p1': (13.0, -2.0),
        'c':  (9.0,   5.0),
        'i2': (4.0,   14.5),
        'i1': (1.5,   20.5),
    },
    'bioform_5': {  # più stretta, più puntata
        'm2': (20.0, -19.0),
        'm1': (17.5, -13.0),
        'p2': (14.5, -7.0),
        'p1': (12.0, -2.0),
        'c':  (8.5,   5.5),
        'i2': (3.5,   15.0),
        'i1': (1.5,   21.0),
    },
}

# Backward compat: progetti salvati pre-V2.5 con 4 nomi storici → alias verso
# i template clinicamente equivalenti della nuova serie.
TEMPLATE_ALIASES = {
    'ovoid':   'europa_1',
    'square':  'trueform_1',
    'tapered': 'bioform_3',
    'narrow':  'bioform_5',
}


def _resolve_template_alias(name):
    """Risolve alias storici (V<2.5) → nome canonico V2.5+."""
    if name in TEMPLATE_ALIASES:
        return TEMPLATE_ALIASES[name]
    return name


DEFAULT_TEMPLATE = 'auto'   # 'auto' = best fit, OR explicit name, OR 'skeleton' (no template)


def _gen_template(name, n_pts=N_CTRL_POINTS):
    """Genera template ortodontico in canonical frame da LANDMARKS anatomici.

    Algoritmo:
      1. Espande i 7 landmark mid-arch (M2..I1) a 13 landmark mirror-symmetric
         (M2_sx, M1_sx, ..., C_sx, I2_sx, I1, I2_dx, ..., M2_dx)
      2. Cubic spline interpolazione naturale (scipy) sui 13 landmark con
         parametrizzazione arc-length cumulato
      3. Resample uniforme arc-length a n_pts (default 50)

    Output: array (n_pts, 2) ordinato da -X (molare dx) a +X (dx), passando
    per (0, apex_y_max). Forma anatomicamente fedele con "ginocchio canino"
    visibile (curvatura locale alta in zona C-PM1).
    """
    landmarks = TEMPLATE_LANDMARKS[name]
    # 7 landmark mid-arch ordinati da distale a mesiale
    order = ['m2', 'm1', 'p2', 'p1', 'c', 'i2', 'i1']
    pts_right = np.array([[landmarks[k][0], landmarks[k][1]] for k in order], dtype=np.float64)
    # Mirror sx: x negato, ordine invertito (m2_sx come primo, poi m1_sx ecc.)
    pts_left = np.array([[-landmarks[k][0], landmarks[k][1]] for k in order], dtype=np.float64)
    pts_left = pts_left[::-1]  # inverti: dal più posteriore al più anteriore
    # Concatena: 7 dx (m2_sx → i1) + 6 sx skip i1 doppio (m2_sx ordine già invertito)
    # → array di 13: [m2_sx, m1_sx, p2_sx, p1_sx, c_sx, i2_sx, i1, i2_dx, p1_dx, p2_dx, m1_dx, m2_dx]
    # Wait: ricostruisco esplicito per chiarezza
    full = []
    # Lato sx: m2 → m1 → p2 → p1 → c → i2 (NO i1, lo mette al centro)
    for k in ['m2', 'm1', 'p2', 'p1', 'c', 'i2']:
        full.append([-landmarks[k][0], landmarks[k][1]])
    # Apex i1 al centro (x=0)
    full.append([0.0, landmarks['i1'][1]])
    # Lato dx: i2 → c → p1 → p2 → m1 → m2
    for k in ['i2', 'c', 'p1', 'p2', 'm1', 'm2']:
        full.append([landmarks[k][0], landmarks[k][1]])
    full_arr = np.array(full, dtype=np.float64)  # (13, 2)

    # Cubic spline parametrizzata su arc-length cumulato
    try:
        from scipy.interpolate import CubicSpline
        diffs = np.diff(full_arr, axis=0)
        seg_lens = np.linalg.norm(diffs, axis=1)
        cumlen = np.concatenate([[0.0], np.cumsum(seg_lens)])
        total = float(cumlen[-1])
        # Natural cubic spline (no boundary constraint)
        cs_x = CubicSpline(cumlen, full_arr[:, 0], bc_type='natural')
        cs_y = CubicSpline(cumlen, full_arr[:, 1], bc_type='natural')
        target = np.linspace(0.0, total, n_pts)
        pts = np.column_stack([cs_x(target), cs_y(target)])
    except Exception:
        # Fallback: interpolazione lineare
        diffs = np.diff(full_arr, axis=0)
        seg_lens = np.linalg.norm(diffs, axis=1)
        cumlen = np.concatenate([[0.0], np.cumsum(seg_lens)])
        total = float(cumlen[-1])
        target = np.linspace(0.0, total, n_pts)
        pts = np.column_stack([
            np.interp(target, cumlen, full_arr[:, 0]),
            np.interp(target, cumlen, full_arr[:, 1])
        ])
    return pts


def _fit_template_isotropic(P, Q):
    """Procrustes 2D fit di Q a P con scala UNIFORME (no aniso) + traslazione.

    V2.0 (2026-05-12): cambiato da anisotropic a isotropic. Con scaling
    per-axis indipendente, tutti i template diventavano visivamente simili
    post-fit (ogni axis si adattava al patient — perdiamo la PROPORTIONALITÀ
    del template, che è l'informazione clinicamente rilevante).
    Isotropic preserva il rapporto W/L del template originale.

    Args:
        P: (N, 2) skeleton target
        Q: (N, 2) template

    Returns:
        (Q_fitted, residual, (s, s)) — tupla (s, s) per back-compat con metadata
        che si aspetta (sx, sy).
    """
    P_mean = P.mean(axis=0)
    Q_mean = Q.mean(axis=0)
    Pc = P - P_mean
    Qc = Q - Q_mean
    num = float((Pc * Qc).sum())
    den = float((Qc * Qc).sum())
    s = num / den if den > 1e-9 else 1.0
    s = max(0.5, min(2.0, s))
    Q_fit = s * Qc + P_mean
    residual = float(((P - Q_fit) ** 2).sum())
    return Q_fit, residual, (s, s)


def _fit_template_anisotropic_true(P, Q):
    """V2.5.2 (2026-05-13): BBox-based aniso fit per modalità REPLACE.

    PROBLEMA RISOLTO: V2.5.1 usava least-squares per-axis
    `sx = <Pc_x, Qc_x> / <Qc_x, Qc_x>`. Matematicamente corretto SE P[i] e
    Q[i] sono in correspondenza punto-per-punto. MA template e cresta del
    paziente sono entrambi resampled arc-length uniform su 50 punti — la
    densità lungo l'arco è diversa (template ha più punti nella zona del
    knee canino curvato, paziente edentulo ha distribuzione più uniforme).
    Le correlazioni cross-points davano `sy` mostruoso (V acuta gigante).

    FIX: misura le dimensioni anatomiche tramite BBOX (max-min per axis),
    poi scala il template per matchare il bbox del paziente. Indipendente
    dal sampling bias.

    Args:
        P: (N, 2) skeleton target (paziente, in canonical frame)
        Q: (N, 2) template (in canonical frame)

    Returns:
        (Q_fitted, residual, (sx, sy))
    """
    P_xmin, P_ymin = float(P[:, 0].min()), float(P[:, 1].min())
    P_xmax, P_ymax = float(P[:, 0].max()), float(P[:, 1].max())
    Q_xmin, Q_ymin = float(Q[:, 0].min()), float(Q[:, 1].min())
    Q_xmax, Q_ymax = float(Q[:, 0].max()), float(Q[:, 1].max())

    P_w = max(1e-6, P_xmax - P_xmin)
    P_h = max(1e-6, P_ymax - P_ymin)
    Q_w = max(1e-6, Q_xmax - Q_xmin)
    Q_h = max(1e-6, Q_ymax - Q_ymin)

    sx = P_w / Q_w
    sy = P_h / Q_h
    sx = max(0.3, min(3.0, sx))
    sy = max(0.3, min(3.0, sy))

    # Centra il template sul midpoint del bbox di Q, scala, ricentra sul midpoint di P
    Q_cx, Q_cy = (Q_xmax + Q_xmin) / 2.0, (Q_ymax + Q_ymin) / 2.0
    P_cx, P_cy = (P_xmax + P_xmin) / 2.0, (P_ymax + P_ymin) / 2.0
    Q_fit = np.column_stack([
        (Q[:, 0] - Q_cx) * sx + P_cx,
        (Q[:, 1] - Q_cy) * sy + P_cy,
    ])
    residual = float(((P - Q_fit) ** 2).sum())
    return Q_fit, residual, (sx, sy)


# Legacy alias per backward compat — V2.5 sceglie la funzione corretta in
# base al `mode` di `_choose_best_template` (classify=isotropic, replace=anisotropic).
_fit_template_anisotropic = _fit_template_anisotropic_true


def _orient_skeleton_canonical(skeleton_2d):
    """Determina se lo skeleton ha l'apex (anteriore) a +Y o -Y in PCA frame,
    e ritorna lo skeleton ORIENTATO con apex a +Y (canonical).

    Returns:
        (skeleton_canonical, flip_y: bool)
    """
    n = len(skeleton_2d)
    if n < 6:
        return skeleton_2d, False
    inner_count = max(2, n // 5)
    outer_count = max(2, n // 5)
    # Ordina per |X| (centro vs tails)
    sorted_idx = np.argsort(np.abs(skeleton_2d[:, 0]))
    apex_y = float(np.median(skeleton_2d[sorted_idx[:inner_count], 1]))
    tail_y = float(np.median(skeleton_2d[sorted_idx[-outer_count:], 1]))
    if apex_y < tail_y:
        # anterior è a -Y → flip per portare a +Y
        skel = skeleton_2d.copy()
        skel[:, 1] *= -1
        return skel, True
    return skeleton_2d, False


def _choose_best_template(skeleton_2d, template_name, n_pts, logger=None, mode='classify'):
    """Sceglie il template best-fit (se 'auto') o fitta quello richiesto.

    V2.5 mode:
        'classify' (default): fit ISOTROPIC (preserva proporzioni template).
            Usato per `auto` — misura la similarità di FORMA, non la copertura
            dimensionale. Il fitted_2d NON viene usato per sostituire la curva,
            serve solo per ranking ("forma più simile = X").
        'replace': fit ANISOTROPIC (scala X e Y indipendentemente). Usato
            quando l'utente sceglie un template esplicito → fitted_2d
            SOSTITUISCE la cresta del paziente. Le dimensioni W6/Depth del
            template adattato matchano esattamente quelle della cresta del
            paziente, non le proporzioni originali del template.

    Returns:
        (fitted_2d, template_used, residual, scales, flip_y)
        fitted_2d è in PCA frame ORIGINALE (se skeleton era flipped, output è ri-flippato).
    """
    skel_canon, flip_y = _orient_skeleton_canonical(skeleton_2d)

    # V2.5: risolvi alias storici (ovoid/square/tapered/narrow) → V2.5 canonici
    resolved_name = _resolve_template_alias(template_name)

    # V2.5: selettore fit function in base al mode
    if mode == 'replace':
        fit_fn = _fit_template_anisotropic_true
    else:
        fit_fn = _fit_template_isotropic

    if resolved_name == 'auto':
        best = None
        for name in TEMPLATE_LANDMARKS.keys():
            tmpl = _gen_template(name, n_pts)
            fit, residual, scales = fit_fn(skel_canon, tmpl)
            if best is None or residual < best[2]:
                best = (name, fit, residual, scales)
        template_used, fitted_canon, residual, scales = best
        if logger:
            logger(f"[FAST] arch_detect: template auto-fit ({mode}) → '{template_used}' "
                   f"(residual={residual:.2f}, scales={scales[0]:.2f}/{scales[1]:.2f})")
    elif resolved_name in TEMPLATE_LANDMARKS:
        template_used = resolved_name
        tmpl = _gen_template(template_used, n_pts)
        fitted_canon, residual, scales = fit_fn(skel_canon, tmpl)
        if logger:
            alias_note = f" (alias da '{template_name}')" if template_name != resolved_name else ""
            logger(f"[FAST] arch_detect: template fit '{template_used}'{alias_note} ({mode}) "
                   f"residual={residual:.2f}, scales={scales[0]:.2f}/{scales[1]:.2f}")
    else:
        # 'skeleton' o sconosciuto → no fitting, return skeleton as-is
        return skeleton_2d, 'skeleton', 0.0, (1.0, 1.0), flip_y

    if flip_y:
        fitted_canon[:, 1] *= -1
    return fitted_canon, template_used, residual, scales, flip_y


def _cache_is_valid(crv_out_path, requested_z_offset, requested_template,
                    requested_adherence_pct=None, requested_smoothness=None,
                    requested_trim_frac=None, requested_extension_mm=None,
                    requested_knee_slope=None):
    """Verifica se il `.crv.json` esistente è ancora valido per i nuovi params.

    V2.1: aggiunti _adherence_pct, _smoothness_sigma, _trim_end_frac al check.
    V2.2: aggiunti _extension_mm, _knee_z_drop_mm (rettifica estremi).
    V2.3: knee_z_drop_mm → knee_slope_threshold (detection via |dz/ds|).
    V2.4: schema versione bumped (output ora è parabola pura, non tangente).
    V2.5: 10 template ortodontici (Europa I/II, Trueform I/II, Standard, Bioform I-V)
          + alias storici (ovoid/square/tapered/narrow). Backward compat OK.
    V2.5.1: replace mode anisotropic + fit su cresta reale pre-V2.4.
          Bump invalida cache 2.5 (classification-only) per recompute.
    V2.5.2: bbox-based aniso fit (sostituisce least-squares che dava sy
          mostruoso su template+paziente con sampling diverso). Robusto.
    V2.6: control_points salvati in mesh-LOCAL invece di scanner-WORLD.
          (ROLLBACKED in V2.7 — vedi sotto.)
    V2.7: ROLLBACK V2.6. Convenzione IBEX è scanner-world dappertutto
          (MeshLoader non applica pivot ai vertici → matrixWorld=identity).
          arch_detect, CurveMode, CurveEditMode tutti producono CP in scanner.
    V2.8: clip prolungamenti parabola V2.4 al BBox X della mesh. Pre-V2.8
          la parabola divergeva oltre i bordi laterali della scansione.
    V2.9: ELLIPSE FIT sostituisce parabola. Anatomicamente migliore — i
          rami posteriori rientrano verso l'interno (sezione di curva
          chiusa) invece di divergere all'infinito. Range θ derivato da
          BBox X mesh → curva termina naturalmente ai bordi della scansione.
    V2.10: clip Y posteriore. Pre-V2.10 i lati dell'ellisse uscivano oltre
          il BBox Y della mesh (y_lateral = cy che era oltre y_max scan).
          Ora θ range = intersezione vincolo X + vincolo Y.
    V2.11: ExtendToBBox. Pre-V2.11 il fit least_squares ai punti cresta
          proper produceva un'ellisse "interna" (cresta non copre tutto il
          bbox mesh: c'è palato anteriormente, tuberalveolare posteriormente).
          Risultato: apex e lati non raggiungevano i bordi della scansione,
          "curva corta". Fix: post-fit espandi a/b per coprire il bbox mesh.
    V2.12: PlanarZWorld. PCA axis2 non è parallelo a Z world se la mesh è
          inclinata → curva ruotata visivamente. Fix: post-unprojection
          sovrascrivi z dei CP con la media z world → curva planare in XY
          world. Toggle via _planarize_z_world (default True).
    V2.13: AlignToWorldXY (ROTTO). Forzava apex → +Y world via
          atan2 su [-π, π] → se l'apex era originariamente verso -Y world
          (orientamento mesh dipende dall'import), ruotava 180° flippando
          la curva sul lato opposto della mesh.
    V2.14: ChordAlignMinimal. Usa la CORDA (line through estremità) invece
          dell'apex come riferimento di rotazione. Normalizza l'angolo a
          [-π/2, π/2] → rotazione minima ≤ 90° attorno a Z world. La corda
          è naturalmente bidirezionale (chord +X equivalente a chord -X)
          → nessuna ambiguità di segno → mai più flip 180°.
          Toggle via _align_world_xy (default True).
    V2.15: BBoxFromRidge (TROPPO STRETTO, rollbackato in V2.17).
    V2.16: CrownBBox (NON CONFERMATO, rollbackato in V2.17).
    V2.17: RollbackToV2.9. V2.10 ClipY + V2.11 ExtendToBBox + V2.15/V2.16
          BBox experiments rimossi dopo feedback utente "la curva più bella
          la rilevava la V2.9". Tornato alla pipeline V2.9 originale:
          fit ellisse least_squares puro + clip X ai bordi mesh
          (theta_x_start/end via arcsin). Nessuna expansion al bbox mesh,
          nessun clip Y aggiuntivo. Conservati V2.12 PlanarZWorld (Z
          costante = media Z world) e V2.14 ChordAlignMinimal (rotazione
          attorno a Z world per allineare la corda a ±X world, |rot| ≤ 90°).
    Tutti i params devono matchare entro tolleranza (0.01) per cache hit.
    """
    CURRENT_VERSION = '2.17'
    if not os.path.isfile(crv_out_path):
        return False
    try:
        with open(crv_out_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        md = data.get('metadata', {})
        cached_version = str(md.get('version', ''))
        if cached_version != CURRENT_VERSION:
            return False  # schema changed, invalidate
        cached_z = float(md.get('z_offset_mm', -999))
        cached_template = str(md.get('template_used', ''))
        if abs(cached_z - float(requested_z_offset)) > 0.01:
            return False
        # V2.1 params
        if requested_adherence_pct is not None:
            cached_pct = float(md.get('adherence_pct', -1))
            if abs(cached_pct - float(requested_adherence_pct)) > 0.01:
                return False
        if requested_smoothness is not None:
            cached_sig = float(md.get('smoothness_sigma', -1))
            if abs(cached_sig - float(requested_smoothness)) > 0.01:
                return False
        if requested_trim_frac is not None:
            cached_trim = float(md.get('trim_end_frac', -1))
            if abs(cached_trim - float(requested_trim_frac)) > 0.01:
                return False
        # V2.3 params (extension + knee slope threshold)
        if requested_extension_mm is not None:
            cached_ext = float(md.get('extension_mm', -1))
            if abs(cached_ext - float(requested_extension_mm)) > 0.01:
                return False
        if requested_knee_slope is not None:
            cached_slope = float(md.get('knee_slope_threshold', -1))
            if abs(cached_slope - float(requested_knee_slope)) > 0.01:
                return False
        if requested_template == 'auto':
            return True
        return cached_template == requested_template
    except Exception:
        return False


# ───────────────────────────────────────────────────────────────────
# V2.0 (2026-05-12) helper: boundary loop + Newell normal per cresta direction
# ───────────────────────────────────────────────────────────────────

def _newell_normal(pts):
    """Algoritmo di Newell — normale di un poligono planare (somma cross
    edge-by-edge). Stable anche per polygoni leggermente non-planari."""
    n = len(pts)
    normal = np.zeros(3, dtype=np.float64)
    for i in range(n):
        a = pts[i]
        b = pts[(i + 1) % n]
        normal[0] += (a[1] - b[1]) * (a[2] + b[2])
        normal[1] += (a[2] - b[2]) * (a[0] + b[0])
        normal[2] += (a[0] - b[0]) * (a[1] + b[1])
    norm = np.linalg.norm(normal)
    return normal / norm if norm > 1e-9 else np.array([0., 0., 1.])


def _longest_boundary_loop(V, F, min_verts=10):
    """Estrae il boundary loop più lungo (≥ min_verts vert) via DFS adjacency
    su edge con face_count == 1. Pattern parallelo a modelgenerator._extract_boundary_loop.
    Ritorna (loop_idx_array, loop_pts_array) o (None, None)."""
    ec = {}
    for tri in F:
        for k in range(3):
            e = tuple(sorted([int(tri[k]), int(tri[(k + 1) % 3])]))
            ec[e] = ec.get(e, 0) + 1
    bedges = [e for e, c in ec.items() if c == 1]
    if not bedges:
        return None, None
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
        if len(loop) >= min_verts:
            loops.append(loop)
    if not loops:
        return None, None
    longest = max(loops, key=len)
    arr = np.array(longest, dtype=np.int64)
    return arr, V[arr].copy()


def _detect_knees_via_z_slope(skeleton_3d, axis2_local_idx=2,
                                slope_threshold=0.15, window=3):
    """V2.3 (2026-05-13): rileva il ginocchio via |dz/ds| (slope axis2 vs
    arc-length) invece che threshold di valore Z assoluto.

    Concetto:
      - Cresta proper = curva quasi orizzontale → |dz/ds| < threshold
      - Tuber descent = curva in discesa marcata → |dz/ds| > threshold
      - knee_left = primo idx da sx dove |dz/ds| < threshold (entrata cresta)
      - knee_right = ultimo idx da dx dove |dz/ds| < threshold (uscita cresta)

    Più robusto del threshold-Z-assoluto (V2.2): è insensibile all'offset
    di axis2 (PCA può centrare diversamente la mesh) e si adatta alla
    pendenza naturale di ogni scan.

    slope_threshold = 0.15 → ridge se la curva sale/scende meno di 15cm su
    ogni metro di arco (= cresta praticamente piatta).
    """
    n = len(skeleton_3d)
    if n < 2 * window + 2:
        return 0, n - 1

    # |dz/ds| via windowed finite difference (più robusto di 3-point)
    z_slopes = np.zeros(n)
    for i in range(n):
        i1 = max(0, i - window)
        i2 = min(n - 1, i + window)
        if i1 == i2:
            continue
        d = skeleton_3d[i2] - skeleton_3d[i1]
        ds = float(np.linalg.norm(d))
        if ds < 1e-6:
            continue
        dz = float(d[axis2_local_idx])
        z_slopes[i] = abs(dz) / ds

    # knee_left: primo idx con slope < threshold (scanning sx→dx)
    knee_left = 0
    for i in range(n):
        if z_slopes[i] < slope_threshold:
            knee_left = i
            break

    # knee_right: ultimo idx con slope < threshold (scanning dx→sx)
    knee_right = n - 1
    for i in range(n - 1, -1, -1):
        if z_slopes[i] < slope_threshold:
            knee_right = i
            break

    return knee_left, knee_right, z_slopes


def _straighten_and_extend_ends(skeleton_3d, axis2_local_idx=2,
                                 slope_threshold=0.15,
                                 ext_length_mm=18.0,
                                 tangent_window=4,
                                 n_out=50,
                                 logger=None):
    """V2.3 (2026-05-13): rettifica gli estremi della curva.

    Identifica il "ginocchio" su entrambi i lati via |dz/ds| (slope axis2
    vs arc-length) — vedi _detect_knees_via_z_slope. Dal ginocchio in poi,
    sostituisce la curva con una TANGENTE RETTILINEA prolungata, mediata
    sui `tangent_window` segmenti dopo il ginocchio (verso il centro cresta).

    Args:
        skeleton_3d: (N, 3) curva in PCA-local frame
        slope_threshold: |dz/ds| per definire "cresta proper" (default 0.15)
        ext_length_mm: lunghezza estensione tangente oltre ogni ginocchio
        tangent_window: # segmenti mediati per stabilizzare la tangente
        n_out: # control points output

    Returns:
        (n_out, 3) array — nuova curva rettificata + prolungata
    """
    n = len(skeleton_3d)
    if n < 6:
        return skeleton_3d.copy()

    knee_left, knee_right, z_slopes = _detect_knees_via_z_slope(
        skeleton_3d, axis2_local_idx, slope_threshold, window=3)

    if knee_right - knee_left < 5:
        # Cresta troppo corta — non rettificare, return as-is
        if logger:
            logger(f"[FAST] arch_detect: knee range troppo stretto "
                   f"({knee_right - knee_left} bin, slope_th={slope_threshold}), "
                   f"skip straighten")
        return skeleton_3d.copy()

    center_pts = skeleton_3d[knee_left:knee_right + 1].copy()
    n_center = len(center_pts)

    # Tangente al ginocchio sx (direzione verso PROLUNGAMENTO = uscita)
    win_left = min(tangent_window, n_center - 1)
    tang_left = (center_pts[0] - center_pts[win_left])  # vettore dal centro verso fuori
    tlen = float(np.linalg.norm(tang_left))
    tang_left = tang_left / tlen if tlen > 1e-6 else np.array([-1., 0., 0.])

    # Tangente al ginocchio dx
    win_right = min(tangent_window, n_center - 1)
    tang_right = (center_pts[-1] - center_pts[-1 - win_right])
    tlen = float(np.linalg.norm(tang_right))
    tang_right = tang_right / tlen if tlen > 1e-6 else np.array([1., 0., 0.])

    # Genera punti estensione (densità: 1 punto / mm)
    step_mm = 1.0
    n_ext = max(2, int(ext_length_mm / step_mm))

    # Estensione sx: dal knee verso fuori (più lontano = primo punto array)
    ext_left = np.array([
        center_pts[0] + tang_left * (i * step_mm)
        for i in range(n_ext, 0, -1)
    ])
    # Estensione dx: dal knee verso fuori (più lontano = ultimo punto array)
    ext_right = np.array([
        center_pts[-1] + tang_right * (i * step_mm)
        for i in range(1, n_ext + 1)
    ])

    # Concatenazione: extLeft (lontano→knee) + center + extRight (knee→lontano)
    full = np.concatenate([ext_left, center_pts, ext_right], axis=0)

    # Re-resample arc-length uniforme a n_out
    deltas = np.diff(full, axis=0)
    seg_lens = np.linalg.norm(deltas, axis=1)
    cumlen = np.concatenate([[0.0], np.cumsum(seg_lens)])
    total = float(cumlen[-1])
    if total < 1e-6:
        return skeleton_3d.copy()
    target = np.linspace(0.0, total, n_out)
    out = np.zeros((n_out, 3), dtype=np.float64)
    for d in range(3):
        out[:, d] = np.interp(target, cumlen, full[:, d])

    if logger:
        slope_l = float(z_slopes[knee_left]) if knee_left < len(z_slopes) else -1.0
        slope_r = float(z_slopes[knee_right]) if knee_right < len(z_slopes) else -1.0
        logger(f"[FAST] arch_detect V2.3: straighten knees @ idx={knee_left}/{knee_right} "
               f"(slope_left={slope_l:.3f}, slope_right={slope_r:.3f}, th={slope_threshold:.3f}), "
               f"ext={ext_length_mm:.1f}mm, total_len={total:.1f}mm")
    return out


def _fit_ellipse_arch(skeleton_3d, axis2_local_idx=2, slope_threshold=0.15,
                       n_out=50, logger=None,
                       mesh_x_min=None, mesh_x_max=None,
                       mesh_y_min=None, mesh_y_max=None):
    """V2.9 (2026-05-13): fit ELLISSE SEZIONE TRONCATA sui punti cresta proper.

    Anatomicamente l'arcata dentale è meglio modellata da un'ellisse che da
    una parabola: i rami posteriori RIENTRANO verso l'interno (sezione di
    curva chiusa) invece di divergere all'infinito come una parabola.

    Pre-V2.9 (V2.4-V2.8) usava parabola `y=ax²+bx+c` + clip bbox. La parabola
    diverge geometricamente → i prolungamenti laterali andavano sempre verso
    l'esterno del modello, e il clip bbox era un workaround approssimativo.

    V2.9 fit ellisse vera al PCA-local frame (axis-aligned, PCA orienta già
    correttamente assi trasverso/anteroposteriore). Parametrizzazione:
        x(θ) = cx + a·sin(θ)
        y(θ) = cy + b·cos(θ)
    Con θ ∈ [θ_start, θ_end] half-ellipse anteriore. θ_start/θ_end calcolati
    da BBox X mesh (= dove l'ellisse interseca i bordi laterali della scansione).

    Args:
        skeleton_3d: (N, 3) cresta in PCA-local frame
        axis2_local_idx: indice dell'asse verticale (default 2)
        slope_threshold: |dz/ds| per knee detection
        n_out: # control points output
        mesh_x_min/mesh_x_max: range x dei vertici mesh (PCA-local) per clip

    Returns:
        (n_out, 3) array — ellisse troncata PCA-local
    """
    n = len(skeleton_3d)
    if n < 6:
        return skeleton_3d.copy()

    knee_left, knee_right, z_slopes = _detect_knees_via_z_slope(
        skeleton_3d, axis2_local_idx, slope_threshold, window=3)

    if knee_right - knee_left < 5:
        if logger:
            logger(f"[FAST] arch_detect V2.9: knee range stretto "
                   f"({knee_right - knee_left}), skip ellipse fit")
        return skeleton_3d.copy()

    center = skeleton_3d[knee_left:knee_right + 1].copy()

    # Identifica gli assi xy (escludendo l'asse verticale)
    axes_xy = [i for i in range(3) if i != axis2_local_idx]
    xi, yi = axes_xy[0], axes_xy[1]

    x_proper = center[:, xi].astype(np.float64)
    y_proper = center[:, yi].astype(np.float64)
    z_const = float(np.mean(center[:, axis2_local_idx]))

    # ----- Stima iniziale ellisse dai punti -----
    x_min_p = float(x_proper.min())
    x_max_p = float(x_proper.max())
    y_min_p = float(y_proper.min())
    y_max_p = float(y_proper.max())

    # Determina direzione apex anteriore: y_max o y_min? Apex = max distanza
    # dall'asse trasverso (cx). Per arcata dentale in PCA frame, l'apex è il
    # punto centrale (|x|≈0) con max |y - mean_y|. Confronta y_max e y_min:
    # quello con più punti centrali (|x|<a/3) vince come apex.
    x_center_mask = np.abs(x_proper - (x_min_p + x_max_p) / 2) < (x_max_p - x_min_p) / 6
    if x_center_mask.sum() >= 2:
        y_center = float(np.mean(y_proper[x_center_mask]))
        # apex è verso il y più distante dai molari laterali
        y_mol_left = float(y_proper[np.argmin(x_proper)])
        y_mol_right = float(y_proper[np.argmax(x_proper)])
        y_mol_avg = (y_mol_left + y_mol_right) / 2.0
        apex_is_max = (y_center - y_mol_avg) > 0
    else:
        # Fallback: assume apex = y_max
        apex_is_max = True

    cx_init = (x_min_p + x_max_p) / 2.0
    if apex_is_max:
        # apex a y_max, molari a y_min → cy = y_min, b = depth
        cy_init = y_min_p
        b_init = y_max_p - y_min_p
        cos_sign = 1.0  # cos>0 verso apex
    else:
        # apex a y_min, molari a y_max → cy = y_max, b = depth, cos negativo
        cy_init = y_max_p
        b_init = y_max_p - y_min_p
        cos_sign = -1.0

    a_init = (x_max_p - x_min_p) / 2.0

    if a_init < 1.0 or b_init < 1.0:
        if logger:
            logger(f"[FAST] arch_detect V2.9: ellisse degenere (a={a_init:.2f}, "
                   f"b={b_init:.2f}), skip")
        return skeleton_3d.copy()

    # ----- Least squares fit: minimize sum((x²/a² + (y-cy)²/b² - 1)²) -----
    try:
        from scipy.optimize import least_squares

        def residuals(params, x, y, cs):
            cx_p, cy_p, a_p, b_p = params
            return ((x - cx_p) ** 2) / max(0.01, a_p * a_p) + \
                   ((y - cy_p) * cs - (y_max_p - y_min_p)) ** 2 / max(0.01, b_p * b_p) - 1.0

        # Vincoli: a, b > 1mm, cx vicino a init ±5mm, cy vicino a init ±10mm
        bounds_lo = [cx_init - 10.0, cy_init - 15.0, 1.0, 1.0]
        bounds_hi = [cx_init + 10.0, cy_init + 15.0, 200.0, 200.0]

        result = least_squares(
            lambda p: _ellipse_residual(p, x_proper, y_proper, cos_sign),
            x0=[cx_init, cy_init, a_init, b_init],
            bounds=(bounds_lo, bounds_hi),
            max_nfev=500
        )
        cx, cy, a, b = result.x
        fit_ok = True
    except Exception as e:
        if logger:
            logger(f"[FAST] arch_detect V2.9: ellisse fit fallito ({e}), uso stima iniziale")
        cx, cy, a, b = cx_init, cy_init, a_init, b_init
        fit_ok = False

    # ----- Determina θ_start, θ_end da BBox X mesh -----
    # Half-ellipse θ ∈ [-π/2, +π/2] (cos(θ) ≥ 0).
    # x(θ) = cx + a·sin(θ) → sin(θ) = (x - cx) / a → θ_x = arcsin
    # V2.17: solo clip X (V2.10 ClipY rimosso, ramo θ Y inerte).

    # Clip X
    if mesh_x_min is not None and mesh_x_max is not None:
        sin_left = float(np.clip((mesh_x_min - cx) / a, -1.0, 1.0))
        sin_right = float(np.clip((mesh_x_max - cx) / a, -1.0, 1.0))
    else:
        sin_left = float(np.clip((x_min_p - cx) / a, -1.0, 1.0))
        sin_right = float(np.clip((x_max_p - cx) / a, -1.0, 1.0))

    theta_x_start = np.arcsin(sin_left)
    theta_x_end = np.arcsin(sin_right)

    # V2.17 (rollback a V2.9 baseline): rimossi V2.10 ClipY + V2.11 ExtendToBBox.
    # a/b restano quelle del fit least_squares puro, theta_y_max = π/2 (no clip Y).
    # La curva è determinata SOLO da:
    #   - fit ellisse least_squares sui punti cresta (cx, cy, a, b, cos_sign)
    #   - clip X ai bordi mesh (theta_x_start/end via arcsin)
    # Niente expansion al bbox mesh, niente clip Y aggiuntivo. Comportamento
    # confermato visivamente OK in V2.9 originale.
    theta_y_max = np.pi / 2.0
    theta_start = max(theta_x_start, -theta_y_max)
    theta_end = min(theta_x_end, theta_y_max)

    if theta_end - theta_start < 0.2:
        if logger:
            logger(f"[FAST] arch_detect V2.9: θ range degenere "
                   f"[{np.degrees(theta_start):.1f}°, {np.degrees(theta_end):.1f}°], skip")
        return skeleton_3d.copy()

    # ----- Sample arc-length uniform sull'ellisse troncata -----
    n_dense = max(200, n_out * 4)
    theta_dense = np.linspace(theta_start, theta_end, n_dense)
    x_dense = cx + a * np.sin(theta_dense)
    y_dense = cy + cos_sign * b * np.cos(theta_dense)

    pts_dense = np.zeros((n_dense, 3), dtype=np.float64)
    pts_dense[:, xi] = x_dense
    pts_dense[:, yi] = y_dense
    pts_dense[:, axis2_local_idx] = z_const

    # Re-resample arc-length uniforme
    deltas = np.diff(pts_dense, axis=0)
    seg_lens = np.linalg.norm(deltas, axis=1)
    cumlen = np.concatenate([[0.0], np.cumsum(seg_lens)])
    total = float(cumlen[-1])
    if total < 1e-6:
        return skeleton_3d.copy()
    target = np.linspace(0.0, total, n_out)
    out = np.zeros((n_out, 3), dtype=np.float64)
    for d in range(3):
        out[:, d] = np.interp(target, cumlen, pts_dense[:, d])

    if logger:
        logger(f"[FAST] arch_detect V2.17 ellipse fit: "
               f"a={a:.2f}, b={b:.2f}, c=({cx:.2f},{cy:.2f}) cos_sign={cos_sign:+.0f} "
               f"θ=[{np.degrees(theta_start):.1f}°,{np.degrees(theta_end):.1f}°] "
               f"fit_ok={fit_ok} total_len={total:.1f}mm")
    return out


def _ellipse_residual(params, x, y, cos_sign):
    """Residuals algebrici per fit ellisse axis-aligned.
    Constraint: (x - cx)²/a² + (y - cy)²/b² = 1
    cos_sign: orientazione apex (+1 = y crescente, -1 = y decrescente).
    """
    cx_p, cy_p, a_p, b_p = params
    dx = x - cx_p
    dy = (y - cy_p) * cos_sign  # normalizza orientazione
    return (dx * dx) / (a_p * a_p) + (dy * dy) / (b_p * b_p) - 1.0


def _fit_parabola_arch(skeleton_3d, axis2_local_idx=2, slope_threshold=0.15,
                        ext_length_mm=18.0, n_out=50, logger=None,
                        mesh_x_min=None, mesh_x_max=None):
    """V2.4 (2026-05-13): fit PARABOLA y=a*x²+b*x+c sui punti cresta proper.

    PROBLEMA risolto: V2.3 estendeva la tangente al ginocchio. Per una curva
    strettamente convessa (arcata) la tangente al ginocchio diverge verso
    l'esterno → "tronchi di iperbole" laterali invece di una parabola pulita.

    FIX: fit polinomiale grado 2 globale sui punti cresta proper (knee-to-knee
    via Z-slope), poi estendi valutando la parabola stessa oltre il knee. La
    curva risultante è UNA parabola pura su tutto il dominio.

    Frame PCA-local: axis0 = trasverso (max varianza), axis1 = anteroposteriore,
    axis2 = vertico. Fit: y_anteroposteriore = f(x_trasverso). Z = mean(cresta).

    Args:
        skeleton_3d: (N, 3) curva in PCA-local frame
        axis2_local_idx: indice dell'asse verticale (default 2)
        slope_threshold: |dz/ds| per knee detection (default 0.15)
        ext_length_mm: arc-length oltre il knee su ogni lato
        n_out: # control points output

    Returns:
        (n_out, 3) array — parabola pura PCA-local
    """
    n = len(skeleton_3d)
    if n < 6:
        return skeleton_3d.copy()

    knee_left, knee_right, z_slopes = _detect_knees_via_z_slope(
        skeleton_3d, axis2_local_idx, slope_threshold, window=3)

    if knee_right - knee_left < 5:
        if logger:
            logger(f"[FAST] arch_detect V2.4: knee range stretto "
                   f"({knee_right - knee_left}), skip parabola fit")
        return skeleton_3d.copy()

    center = skeleton_3d[knee_left:knee_right + 1].copy()

    # Identifica gli assi xy (escludendo l'asse verticale)
    axes_xy = [i for i in range(3) if i != axis2_local_idx]
    xi, yi = axes_xy[0], axes_xy[1]

    x_proper = center[:, xi].astype(np.float64)
    y_proper = center[:, yi].astype(np.float64)
    z_const = float(np.mean(center[:, axis2_local_idx]))

    # Centra x per condizionamento numerico polyfit
    x_mean = float(np.mean(x_proper))
    x_shift = x_proper - x_mean

    # Fit parabola y = a*x² + b*x + c (least squares grado 2)
    try:
        coef = np.polyfit(x_shift, y_proper, 2)
        a, b, c = float(coef[0]), float(coef[1]), float(coef[2])
    except Exception as e:
        if logger:
            logger(f"[FAST] arch_detect V2.4: polyfit fallito ({e}), skip")
        return skeleton_3d.copy()

    # Range x della cresta proper (in coord shiftate)
    x_min_proper = float(np.min(x_shift))
    x_max_proper = float(np.max(x_shift))

    # Stima dx_ext da arc-length target: ds/dx = sqrt(1 + (2ax+b)²)
    # Valutato AL knee per partire dall'orientamento corretto.
    slope_left = 2.0 * a * x_min_proper + b
    slope_right = 2.0 * a * x_max_proper + b
    ds_dx_left = float(np.sqrt(1.0 + slope_left * slope_left))
    ds_dx_right = float(np.sqrt(1.0 + slope_right * slope_right))

    dx_ext_left = ext_length_mm / max(0.5, ds_dx_left)
    dx_ext_right = ext_length_mm / max(0.5, ds_dx_right)

    x_min_full = x_min_proper - dx_ext_left
    x_max_full = x_max_proper + dx_ext_right

    # V2.8 ClipBBox (2026-05-13): clip dei prolungamenti al BBox X della mesh.
    # Pre-V2.8 la parabola continuava la sua forma geometrica oltre i bordi
    # della scansione → prolungamenti divergenti laterali fuori dal bounding
    # box. Ora x_min_full/x_max_full sono limitati al range x dei vertici
    # della mesh (in PCA-local frame). La curva termina al bordo della
    # scansione esattamente.
    if mesh_x_min is not None:
        x_min_full = max(x_min_full, float(mesh_x_min) - x_mean)
    if mesh_x_max is not None:
        x_max_full = min(x_max_full, float(mesh_x_max) - x_mean)

    # Oversample x uniformemente, build 3D, re-resample arc-length uniforme.
    n_dense = max(200, n_out * 4)
    x_dense_shift = np.linspace(x_min_full, x_max_full, n_dense)
    y_dense = a * x_dense_shift * x_dense_shift + b * x_dense_shift + c

    pts_dense = np.zeros((n_dense, 3), dtype=np.float64)
    pts_dense[:, xi] = x_dense_shift + x_mean  # de-shift
    pts_dense[:, yi] = y_dense
    pts_dense[:, axis2_local_idx] = z_const

    # Re-resample arc-length uniforme
    deltas = np.diff(pts_dense, axis=0)
    seg_lens = np.linalg.norm(deltas, axis=1)
    cumlen = np.concatenate([[0.0], np.cumsum(seg_lens)])
    total = float(cumlen[-1])
    if total < 1e-6:
        return skeleton_3d.copy()
    target = np.linspace(0.0, total, n_out)
    out = np.zeros((n_out, 3), dtype=np.float64)
    for d in range(3):
        out[:, d] = np.interp(target, cumlen, pts_dense[:, d])

    if logger:
        logger(f"[FAST] arch_detect V2.4: parabola fit "
               f"a={a:.5f}, b={b:.5f}, c={c:.3f} "
               f"(knee idx={knee_left}/{knee_right}, "
               f"x_shift_range=[{x_min_full:.1f},{x_max_full:.1f}], "
               f"z_const={z_const:.2f}, total_len={total:.1f}mm)")
    return out


def _compute_elevation_sign(V, F, axis2, logger=None):
    """Determina se +axis2 punta verso la cresta alveolare o verso la base.

    V2.0 (2026-05-12) — uso BOUNDARY GEOMETRY (no Newell normal, che dipende
    dall'ordine DFS di traversata del loop → impredicibile).

    Algoritmo (pattern modelgenerator V2.2):
      - Proietta tutti i vert su axis2 → `z_all`
      - Proietta i vert del boundary loop su axis2 → `z_loop`
      - Confronta scan_mean = mean(z_all) vs loop_mean = mean(z_loop)
      - Se scan_mean > loop_mean → il body della mesh è in +axis2 rispetto
        al boundary → cresta (insieme alla massa del modello) è in +axis2
      - Se scan_mean < loop_mean → cresta in -axis2

    Robustezza: indipendente dall'orientamento iniziale di axis2 da PCA
    (PCA non fissa il segno degli autovettori), indipendente dall'orientazione
    della scansione in world, indipendente dall'ordine DFS del loop.

    Fallback geometrico se boundary non trovato (mesh chiusa): usa
    asimmetria axis0-range delle estremità axis2.

    Returns:
        float: +1.0 se +axis2 → cresta, -1.0 altrimenti.
    """
    try:
        loop_idx, loop_pts = _longest_boundary_loop(V, F, min_verts=10)
        if loop_idx is None or len(loop_idx) < 10:
            raise ValueError("no boundary loop")
        # Proietta verts su axis2 (operazione lineare, robust)
        z_all = V @ axis2          # (N,) proiezione di tutti i vert
        z_loop = loop_pts @ axis2  # (M,) proiezione del boundary
        scan_mean = float(z_all.mean())
        loop_mean = float(z_loop.mean())
        # Cresta = lato del body opposto al boundary
        sign = 1.0 if scan_mean > loop_mean else -1.0
        if logger:
            logger(f"[FAST] arch_detect: elevation_sign via boundary geometry "
                   f"loop={len(loop_idx)}v scan_z={scan_mean:+.2f} loop_z={loop_mean:+.2f} "
                   f"diff={scan_mean - loop_mean:+.2f} → "
                   f"{'+' if sign > 0 else '-'}axis2 = cresta")
        return sign
    except Exception as e:
        # Fallback geometrico: top 5% vs bottom 5% axis0-range (cresta = wider)
        try:
            z = V @ axis2
            p95 = np.percentile(z, 95)
            p05 = np.percentile(z, 5)
            top_idx = np.where(z > p95)[0]
            bot_idx = np.where(z < p05)[0]
            top_x_range = float(V[top_idx, 0].max() - V[top_idx, 0].min()) if len(top_idx) > 0 else 0
            bot_x_range = float(V[bot_idx, 0].max() - V[bot_idx, 0].min()) if len(bot_idx) > 0 else 0
            sign = 1.0 if top_x_range > bot_x_range else -1.0
            if logger:
                logger(f"[FAST] arch_detect: elevation_sign fallback geometric "
                       f"({e}), top_x_range={top_x_range:.1f} vs bot={bot_x_range:.1f} → "
                       f"{'+' if sign > 0 else '-'}axis2")
            return sign
        except Exception as e2:
            if logger:
                logger(f"[FAST] arch_detect: elevation_sign WARNING fallback +1 ({e2})")
            return 1.0


GAUSS_SIGMA_BINS = 2.0             # smoothing sul polyline (in unità di bin)
UNPROJECT_RADIUS_MM = 2.0          # raggio nel piano 2D per stimare axis2
MIN_VERTS_INPUT = 5000             # sotto questa soglia, mesh troppo piccola
MIN_VERTS_SELECTED = 500           # se score seleziona < 500 verts, abort
MIN_BINS_NON_EMPTY = 30            # se < 30 bin pieni, polyline insufficiente
TAUBIN_ITER = 3                    # iterazioni pre-smoothing
PCA_AXIS_RATIO_MIN = 1.3           # eigenvalue ratio λ1/λ2 e λ2/λ3 minimi
                                   # (assicura assi ben distinti = scan dentale)


def apply(src_mesh_path, params, output_path, crv_output_path, logger,
          cache_dir=None):
    """Apply arch_detect.

    Args:
        src_mesh_path: STL master mesh path.
        params: dict (riserva V1, attualmente non usato).
        output_path: STL passthrough output.
        crv_output_path: .crv.json output.
        logger: callable for log messages.
        cache_dir: path della .cache_pml dir (None = no cache).

    Returns:
        True su success, False su error.
    """
    # ---- 1. Load mesh + merge_vertices ----------------------------------
    try:
        import trimesh
        mesh = trimesh.load(src_mesh_path, process=False, force='mesh')
        if not isinstance(mesh, trimesh.Trimesh):
            logger(f"[FAST] arch_detect: load non-Trimesh ({type(mesh).__name__})")
            return False
        n_verts_pre = len(mesh.vertices)
        mesh.merge_vertices()
        n_verts = len(mesh.vertices)
        n_faces = len(mesh.faces)
        if n_verts_pre != n_verts:
            logger(f"[FAST] arch_detect: merge_vertices {n_verts_pre} → {n_verts}")
        if n_verts < MIN_VERTS_INPUT:
            logger(f"[FAST] arch_detect: mesh troppo piccola ({n_verts} < "
                   f"{MIN_VERTS_INPUT} verts), aborting")
            return False
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] arch_detect load: {e}")
        return False

    V = np.asarray(mesh.vertices, dtype=np.float64)
    F = np.asarray(mesh.faces, dtype=np.int64)

    # ---- 2. PCA orientation --------------------------------------------
    try:
        centroid = V.mean(axis=0)
        Vc = V - centroid
        # SVD su Vc (più stabile di covarianza diretta su scale grandi)
        # Sample ~10000 verts random se la mesh è molto grande (perf)
        if n_verts > 20000:
            idx_sample = np.random.RandomState(42).choice(
                n_verts, 20000, replace=False)
            Vc_sample = Vc[idx_sample]
        else:
            Vc_sample = Vc
        cov = (Vc_sample.T @ Vc_sample) / max(1, len(Vc_sample) - 1)
        eigenvalues, eigenvectors = np.linalg.eigh(cov)
        # eigh restituisce in ordine ASCENDENTE → inverti
        eigenvalues = eigenvalues[::-1]
        eigenvectors = eigenvectors[:, ::-1]

        # Check assi ben distinti
        l1, l2, l3 = float(eigenvalues[0]), float(eigenvalues[1]), float(eigenvalues[2])
        if l2 < 1e-6 or l3 < 1e-6:
            logger(f"[FAST] arch_detect: eigenvalues degeneri ({l1:.3f}, {l2:.3f}, {l3:.3f})")
            return False
        ratio12 = l1 / l2
        ratio23 = l2 / l3
        logger(f"[FAST] arch_detect: PCA eigenvalues=[{l1:.1f}, {l2:.1f}, "
               f"{l3:.1f}], ratios={ratio12:.2f}/{ratio23:.2f}")
        if ratio12 < PCA_AXIS_RATIO_MIN or ratio23 < PCA_AXIS_RATIO_MIN:
            logger(f"[FAST] arch_detect: PCA ratios sotto soglia "
                   f"({PCA_AXIS_RATIO_MIN}) — assi non distinti, scan non "
                   f"dentale o mal orientato")
            return False

        # Frame canonico:
        #   axis0 (PC1) = transverse (max variance)
        #   axis1 (PC2) = anteroposterior
        #   axis2 (PC3) = vertical (min variance, normale all'occlusale)
        axis0 = eigenvectors[:, 0] / np.linalg.norm(eigenvectors[:, 0])
        axis1 = eigenvectors[:, 1] / np.linalg.norm(eigenvectors[:, 1])
        axis2 = np.cross(axis0, axis1)
        axis2 = axis2 / np.linalg.norm(axis2)
        # Re-orthogonalize axis1 dopo aver fissato axis0/axis2
        axis1 = np.cross(axis2, axis0)
        axis1 = axis1 / np.linalg.norm(axis1)

        # Proietta tutti i verts nel frame locale
        V_local = np.column_stack([
            Vc @ axis0,
            Vc @ axis1,
            Vc @ axis2,
        ])
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] arch_detect PCA: {e}")
        return False

    # ---- 3. V2.0 (2026-05-12): Determine elevation_sign via Newell normal
    # del boundary loop più lungo (gum margin). Cresta è in direzione
    # OPPOSTA a extrude_dir del modelgenerator → per arch_detect:
    # +axis2 direction se Newell normal · axis2 > 0.
    # Fallback geometrico: top 5%/bottom 5% axis0-range — il lato con range
    # axis0 maggiore è la cresta (la cresta attraversa tutto l'arco).
    try:
        elevation_sign = _compute_elevation_sign(V, F, axis2, logger)
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] arch_detect elevation sign: {e}")
        return False

    # ---- 4. V2.1: Ridge detection via bin top-axis2 + trim ends -----------
    # V2.1 (2026-05-12) fix post-feedback "wobbly + speroni laterali":
    #   - TOP_PERCENTILE 5% → 2% (più stringente, segue meglio il vertice
    #     della cresta vs zone laterali del rilievo)
    #   - Trim ends automatico: scarta i bin con vert_count < 30% del max
    #     bin → elimina i bin terminali con pochi vert sparsi che producono
    #     mediane spurie ("speroni" laterali)
    #   - Smoothing σ default 2 → 4 (curva più liscia, meno wobble)
    # Param tweakable da UI inspector (V2.1 sliders): _adherence, _smoothness.
    try:
        # Params utente (override defaults)
        if isinstance(params, dict):
            top_pct = float(params.get('_adherence_pct', 2.0))
            top_pct = max(0.5, min(15.0, top_pct))
            user_sigma = float(params.get('_smoothness_sigma', 4.0))
            user_sigma = max(0.0, min(8.0, user_sigma))
            trim_frac = float(params.get('_trim_end_frac', 0.30))
            trim_frac = max(0.0, min(0.9, trim_frac))
        else:
            top_pct = 2.0
            user_sigma = 4.0
            trim_frac = 0.30
        MIN_VERTS_PER_BIN = 50  # alzato da 10 (V2.0) — bin estremi con pochi vert producono speroni

        local_z = (V_local[:, 2]) * elevation_sign
        x_min, x_max = float(V_local[:, 0].min()), float(V_local[:, 0].max())
        x_range = x_max - x_min
        if x_range < 10.0:
            logger(f"[FAST] arch_detect: mesh x_range troppo piccolo ({x_range:.1f}mm)")
            return False
        bins = np.linspace(x_min, x_max, N_BINS + 1)
        # Raccoglie TUTTI i bin con vert_count + position (incluso count per trim)
        all_bins = []  # [(x_c, y_med, z_med, count), ...]
        for i in range(N_BINS):
            in_bin_mask = (V_local[:, 0] >= bins[i]) & (V_local[:, 0] < bins[i + 1])
            in_bin_idx = np.where(in_bin_mask)[0]
            count = len(in_bin_idx)
            if count < MIN_VERTS_PER_BIN:
                continue
            n_top = max(MIN_VERTS_PER_BIN, int(count * top_pct / 100.0))
            z_in_bin = local_z[in_bin_idx]
            top_idx_local = np.argsort(z_in_bin)[-n_top:]
            top_idx = in_bin_idx[top_idx_local]
            x_c = 0.5 * (bins[i] + bins[i + 1])
            y_med = float(np.median(V_local[top_idx, 1]))
            z_med = float(np.median(V_local[top_idx, 2]))
            all_bins.append((x_c, y_med, z_med, count))
        n_bins_initial = len(all_bins)
        if n_bins_initial < MIN_BINS_NON_EMPTY:
            logger(f"[FAST] arch_detect: troppi pochi bin con vert >= {MIN_VERTS_PER_BIN} "
                   f"({n_bins_initial} < {MIN_BINS_NON_EMPTY}), abort")
            return False

        # Trim ends automatico: scarta primi/ultimi bin con count < trim_frac * max_count
        # Risolve "speroni laterali" — i bin terminali (zona M3/tuber) hanno pochi
        # vert sparsi → top 5% pesca punti laterali → mediane fuori asse → spike.
        max_count = max(b[3] for b in all_bins)
        trim_thresh = max_count * trim_frac
        first_valid = 0
        for i in range(len(all_bins)):
            if all_bins[i][3] >= trim_thresh:
                first_valid = i
                break
        last_valid = len(all_bins) - 1
        for i in range(len(all_bins) - 1, -1, -1):
            if all_bins[i][3] >= trim_thresh:
                last_valid = i
                break
        trimmed = all_bins[first_valid:last_valid + 1]
        n_bins_filled = len(trimmed)
        n_trimmed_start = first_valid
        n_trimmed_end = len(all_bins) - 1 - last_valid

        if n_bins_filled < MIN_BINS_NON_EMPTY:
            logger(f"[FAST] arch_detect: troppi pochi bin post-trim "
                   f"({n_bins_filled} < {MIN_BINS_NON_EMPTY}), abort")
            return False

        bin_centers = np.array([b[0] for b in trimmed], dtype=np.float64)
        bin_medians_y = np.array([b[1] for b in trimmed], dtype=np.float64)
        bin_medians_z = np.array([b[2] for b in trimmed], dtype=np.float64)

        logger(f"[FAST] arch_detect: ridge skeleton {n_bins_filled}/{N_BINS} bins "
               f"(top {top_pct:.1f}%, σ={user_sigma:.1f}, trim ends={n_trimmed_start}+{n_trimmed_end} "
               f"<{trim_frac*100:.0f}% del max count {max_count}), "
               f"x_range=[{float(bin_centers.min()):.1f}, {float(bin_centers.max()):.1f}]mm "
               f"y_range=[{float(bin_medians_y.min()):.1f}, "
               f"{float(bin_medians_y.max()):.1f}]mm "
               f"z_range=[{float(bin_medians_z.min()):.1f}, "
               f"{float(bin_medians_z.max()):.1f}]mm")

        # Ride Gaussian sigma per V2.1
        global GAUSS_SIGMA_BINS  # noqa
        gaussian_sigma_for_smoothing = user_sigma

        # Per backward compat (metadata)
        n_selected = int(len(V_local))
        curv_threshold = 0.0
        n_outliers = 0
        n_nonfinite = 0
        cache_hit = False
        arch_verts_idx = np.array([], dtype=np.int64)
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] arch_detect ridge skeleton: {e}")
        return False

    # ---- 9. Smoothing Gaussian sui y_med e z_med ------------------------
    # V2.1: usa `gaussian_sigma_for_smoothing` settato dal param utente in step 4
    # (default 4.0, override via UI slider _smoothness_sigma).
    try:
        from scipy.ndimage import gaussian_filter1d
        bin_medians_y_smooth = gaussian_filter1d(bin_medians_y, gaussian_sigma_for_smoothing)
        bin_medians_z_smooth = gaussian_filter1d(bin_medians_z, gaussian_sigma_for_smoothing)
    except ImportError:
        # Fallback: moving average
        kernel_size = max(3, int(2 * gaussian_sigma_for_smoothing + 1))
        kernel = np.ones(kernel_size) / kernel_size
        bin_medians_y_smooth = np.convolve(bin_medians_y, kernel, mode='same')
        bin_medians_z_smooth = np.convolve(bin_medians_z, kernel, mode='same')

    # ---- 10. Resample uniforme arc-length a N_CTRL_POINTS ---------------
    try:
        skeleton_3d_local = np.column_stack([
            bin_centers, bin_medians_y_smooth, bin_medians_z_smooth
        ])  # shape (n_bins_filled, 3)
        # Arc-length cumulato
        deltas = np.diff(skeleton_3d_local, axis=0)
        segment_lens = np.linalg.norm(deltas, axis=1)
        cumlen = np.concatenate([[0.0], np.cumsum(segment_lens)])
        total_len = float(cumlen[-1])
        if total_len < 30.0:  # arcata troppo corta
            logger(f"[FAST] arch_detect: arch length {total_len:.1f}mm < 30mm, abort")
            return False
        # Target arc-length uniforme
        target = np.linspace(0.0, total_len, N_CTRL_POINTS)
        resampled = np.zeros((N_CTRL_POINTS, 3), dtype=np.float64)
        for dim in range(3):
            resampled[:, dim] = np.interp(target, cumlen, skeleton_3d_local[:, dim])
        logger(f"[FAST] arch_detect: arch length={total_len:.1f}mm, "
               f"resampled to {N_CTRL_POINTS} pts uniform arc")
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] arch_detect resample: {e}")
        return False

    # ---- 10.3b V2.5: snapshot cresta REALE pre-V2.4 ---------------------
    # Salvato per fit template in modalità REPLACE (step 10.5). La parabola
    # V2.4 (con extension) ha bbox diverso dalla cresta naturale → fittare
    # un template alla parabola produce dimensioni distorte. Il template
    # deve essere fittato alla cresta REALE per matchare W6/depth del paziente.
    crest_real_3d = resampled.copy()

    # ---- 10.4 V2.4 (2026-05-13): fit PARABOLA pura ----------------------
    # V2.3 (deprecato) prolungava la TANGENTE al ginocchio → "tronchi di
    # iperbole" laterali divergenti verso l'esterno. La curva risultante
    # NON era una parabola.
    # V2.4: fit polinomiale grado 2 sui punti cresta proper (knee-to-knee),
    # poi extrapola la parabola stessa. Risultato: UNA parabola pura su
    # tutto il dominio, simmetrica, geometricamente coerente con la forma
    # di un'arcata dentale.
    #
    # V2.5: SKIPPED se l'utente ha scelto un template esplicito — in quel
    # caso il template Procrustes-fit alla cresta reale sostituirà comunque
    # la curva. Evita lavoro inutile e mantiene la cresta reale per il fit.
    template_choice_early = params.get('_template', DEFAULT_TEMPLATE) if isinstance(params, dict) else DEFAULT_TEMPLATE
    resolved_choice_early = _resolve_template_alias(template_choice_early)
    apply_v24_parabola = (resolved_choice_early == 'auto' or
                          resolved_choice_early == 'skeleton' or
                          resolved_choice_early not in TEMPLATE_LANDMARKS)
    try:
        if isinstance(params, dict):
            ext_mm = float(params.get('_extension_mm', 18.0))
            ext_mm = max(0.0, min(40.0, ext_mm))
            slope_th = float(params.get('_knee_slope_threshold', 0.15))
            slope_th = max(0.02, min(1.0, slope_th))
        else:
            ext_mm = 18.0
            slope_th = 0.15

        if apply_v24_parabola:
            # V2.9 EllipseFit (2026-05-13): fit ellisse sezione troncata invece
            # della parabola V2.4. L'ellisse rappresenta meglio l'arcata reale:
            # rami posteriori che rientrano verso l'interno invece di divergere.
            # Range θ determinato da BBox X mesh → la curva termina ai bordi
            # della scansione naturalmente seguendo la curvatura dell'ellisse.
            # `ext_mm` non più usato (l'ellisse decide la sua estensione max
            # tramite θ_start/θ_end derivati dal bbox mesh).
            #
            # V2.17 (2026-05-13) rollback: V2.10 ClipY + V2.11 ExtendToBBox +
            # V2.15/V2.16 BBox experiments rimossi. Tornato al pattern V2.9
            # originale: V_local.min/max della mesh intera come bounds per il
            # clip X (theta_x_start/end via arcsin). a/b dal fit puro.
            try:
                mesh_x_min_pca = float(V_local[:, 0].min())
                mesh_x_max_pca = float(V_local[:, 0].max())
                mesh_y_min_pca = float(V_local[:, 1].min())
                mesh_y_max_pca = float(V_local[:, 1].max())
            except Exception:
                mesh_x_min_pca = None
                mesh_x_max_pca = None
                mesh_y_min_pca = None
                mesh_y_max_pca = None

            resampled = _fit_ellipse_arch(
                resampled,
                axis2_local_idx=2,
                slope_threshold=slope_th,
                n_out=N_CTRL_POINTS,
                logger=logger,
                mesh_x_min=mesh_x_min_pca,
                mesh_x_max=mesh_x_max_pca,
                mesh_y_min=mesh_y_min_pca,
                mesh_y_max=mesh_y_max_pca,
            )
            # Update total_len post-ellisse (per metadata)
            deltas2 = np.diff(resampled, axis=0)
            total_len = float(np.linalg.norm(deltas2, axis=1).sum())
        else:
            logger(f"[FAST] arch_detect V2.5: skip parabola V2.4 "
                   f"(template '{resolved_choice_early}' sostituirà la cresta)")
    except Exception as e:
        logger(f"[FAST] arch_detect: parabola fit warning ({e}), continuing without")

    # ---- 10.5 V1.8: Template ortodontico ICP fit ------------------------
    # Sostituisce lo skeleton noisy (bin-mediana = ridge irregolare con
    # variazioni per-dente) con una curva geometricamente regolare scelta
    # tra 4 template ortodontici standard (ovoid/square/tapered/narrow).
    # Procrustes anisotropico (scale per-axis + translation, no rotation —
    # PCA ha già orientato il frame). Procrustes flippa Y se necessario.
    template_choice = params.get('_template', DEFAULT_TEMPLATE) if isinstance(params, dict) else DEFAULT_TEMPLATE
    # V2.0 CHANGE: Template fit ora è CLASSIFICATION ONLY (metadata), NON
    # sostituisce la curva skeleton. Il template ICP serve solo a rispondere
    # alla domanda clinica "a quale forma ortodontica standard si avvicina
    # questa cresta?" (ovoid/square/tapered/narrow). Output skeleton resta
    # la cresta REALE del paziente — utile sia per dentato (segue cuspidi)
    # sia per edentulo (segue cresta alveolare residua).
    try:
        # V2.5: risolvi alias legacy (ovoid/square/tapered/narrow)
        resolved_choice = _resolve_template_alias(template_choice)
        if resolved_choice == 'auto':
            # AUTO MODE — fit ISOTROPIC (preserva proporzioni template) come
            # CLASSIFICATION. Misura quanto la FORMA del template è simile
            # alla cresta reale, indipendentemente dalle dimensioni assolute.
            # Fit sulla CRESTA REALE pre-V2.4 (non sulla parabola estesa) per
            # avere W6/depth puliti. NON sostituisce la curva (auto resta
            # parabola V2.4 + metadata "forma più simile = X").
            skeleton_2d_classify = crest_real_3d[:, :2].copy()
            fitted_2d, template_used, fit_residual, fit_scales, flip_y = \
                _choose_best_template(skeleton_2d_classify, 'auto', N_CTRL_POINTS, logger, mode='classify')
        elif resolved_choice in TEMPLATE_LANDMARKS:
            # TEMPLATE ESPLICITO — fit ANISOTROPIC (scala X/Y indipendenti) per
            # matchare ESATTAMENTE le dimensioni W6/depth della cresta REALE
            # del paziente (NON della parabola V2.4 che è già stata skippata).
            # Sostituisce i 50 control points con quelli del template fittato.
            # Z viene sovrascritta in step 10.6 a target_z (curva planare).
            skeleton_2d_real = crest_real_3d[:, :2].copy()
            fitted_2d, template_used, fit_residual, fit_scales, flip_y = \
                _choose_best_template(skeleton_2d_real, template_choice, N_CTRL_POINTS, logger, mode='replace')
            if fitted_2d is not None and len(fitted_2d) == N_CTRL_POINTS:
                # Sostituisci XY di resampled con il template aniso-fit alla cresta REALE
                resampled[:, 0] = fitted_2d[:, 0]
                resampled[:, 1] = fitted_2d[:, 1]
                # Z dalla cresta reale (sarà overriden in 10.6 a target_z planare)
                resampled[:, 2] = crest_real_3d[:, 2]
                # Update total_len per i metadata
                deltas3 = np.diff(resampled, axis=0)
                total_len = float(np.linalg.norm(deltas3, axis=1).sum())
                logger(f"[FAST] arch_detect V2.5: curva sostituita con template "
                       f"'{template_used}' (aniso fit sx={fit_scales[0]:.2f} sy={fit_scales[1]:.2f}, "
                       f"total_len={total_len:.1f}mm)")
        else:
            # 'skeleton' o sconosciuto → cresta grezza V2.4 senza fit
            template_used = 'skeleton'
            fit_residual = 0.0
            fit_scales = (1.0, 1.0)
            flip_y = False
    except Exception as e:
        logger(f"[FAST] arch_detect: template classification skip ({e})")
        template_used = 'unknown'
        fit_residual = 0.0
        fit_scales = (1.0, 1.0)
        flip_y = False

    # ---- 10.6 V2.0: Z-offset (elevazione sopra cresta) -------------------
    # elevation_sign è già stato calcolato in step 3 via Newell normal del
    # boundary loop (più robusto del confronto centroid_high_curv/all).
    # ridge_z = mediana dei bin_medians_z (V2.0 — la cresta stessa, non
    # filtered per curvatura).
    try:
        z_offset_mm = float(params.get('_z_offset_mm', DEFAULT_Z_OFFSET_MM)
                            if isinstance(params, dict) else DEFAULT_Z_OFFSET_MM)
        z_offset_mm = max(0.0, min(15.0, z_offset_mm))  # clamp safety
        ridge_z = float(np.median(bin_medians_z))
        target_z = ridge_z + elevation_sign * z_offset_mm
        # Applica elevazione costante a tutti i CP (curva orizzontale rispetto
        # al PCA frame, alla quota target_z).
        resampled[:, 2] = target_z
        logger(f"[FAST] arch_detect: Z-offset={z_offset_mm:.1f}mm direction="
               f"{'+' if elevation_sign > 0 else '-'}axis2, ridge_z={ridge_z:.2f}, "
               f"target_z={target_z:.2f}")
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] arch_detect Z-offset: {e}")
        return False

    # ---- 11. Unproject to 3D scanner-world space -------------------------
    # V2.6 → V2.7 ROLLBACK (2026-05-13):
    # V2.6 sottraeva il pivot BBox dai control_points_world per ottenere
    # "mesh-LOCAL". MA in IBEX la convenzione è scanner-world = mesh-local
    # (vedi MeshLoader.js riga 51; convenzione V13.0 Bite-Safe):
    #   - vertici geometry = scanner-world DIRETTAMENTE
    #   - mesh.position = (0, 0, 0)
    #   - mesh.matrixWorld = identity (userData.pivot è SOLO metadata)
    # Quindi applyMatrix4(matrixWorld) lato frontend è no-op. Il pivot non
    # viene MAI applicato ai vertici renderizzati. La sottrazione di V2.6
    # produceva curve renderizzate a (scanner - bbox_center) = shiftate di
    # -pivot_z (~10mm) rispetto alla mesh visualizzata.
    #
    # Convenzione corretta: tutti i CP `.crv.json` sono in SCANNER-WORLD,
    # CurveViewer/CurveEditMode applicano matrixWorld (identity) → no-op
    # → CP renderizzato in scanner-world = stessa quota della mesh.
    try:
        control_points_world = np.zeros((N_CTRL_POINTS, 3), dtype=np.float64)
        for i in range(N_CTRL_POINTS):
            xc, yc, zc = resampled[i]
            control_points_world[i] = centroid + xc * axis0 + yc * axis1 + zc * axis2

        logger(f"[FAST] arch_detect V2.7: control_points in scanner-world "
               f"(convention IBEX: matrixWorld=identity, no pivot subtraction)")
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] arch_detect unproject: {e}")
        return False

    # ---- 11.5 V2.12 PlanarZWorld + V2.14 ChordAlignMinimal -----------------
    # PCA axis2 NON è parallelo a Z world se la mesh è inclinata. La curva
    # risultante è planare nel piano normale ad axis2 PCA, NON nel piano XY
    # world → utente vede la curva "ruotata" (lato sx più alto del lato dx).
    # V2.12 fix planarizza Z world: sostituisco Z di tutti i CP con la media
    # degli Z world. Curva diventa orizzontale world.
    #
    # V2.14 fix rotazione XY (sostituisce V2.13 ROTTO):
    # V2.13 forzava apex → +Y world usando atan2 su [-π, π]. Se l'apex
    # era originariamente verso -Y world (dipende da come è importata la
    # mesh nello scanner-space), V2.13 ruotava 180° flippando la curva.
    # V2.14 usa la CORDA (linea tra estremità CP[0]-CP[-1]) come riferimento:
    #   - corda è bidirezionale per natura (+X equivalente a -X)
    #   - angolo normalizzato a [-π/2, π/2] → rotazione minima ≤ 90°
    #   - nessuna preferenza front/back → no flip 180°
    # Risultato: corda allineata a ±X world (il che equivale a apex sull'asse
    # Y world, +Y o -Y a seconda dell'orientamento originale, senza forzare).
    try:
        planarize = True
        align_xy = True
        if isinstance(params, dict):
            planarize = bool(params.get('_planarize_z_world', True))
            align_xy = bool(params.get('_align_world_xy', True))

        if planarize:
            z_mean_world = float(control_points_world[:, 2].mean())
            z_world_before = (float(control_points_world[:, 2].min()),
                              float(control_points_world[:, 2].max()))
            control_points_world[:, 2] = z_mean_world
            logger(f"[FAST] arch_detect V2.12 PlanarZWorld: z range "
                   f"[{z_world_before[0]:.2f}, {z_world_before[1]:.2f}] → "
                   f"costante z_mean={z_mean_world:.2f}")
        else:
            logger(f"[FAST] arch_detect V2.12 PlanarZWorld: SKIP")

        if align_xy:
            # Corda = vettore tra le 2 estremità della curva (CP[0] e CP[-1])
            # In una mezza-ellisse arc-length resampled, queste sono i 2 punti
            # ai θ=-π/2 e θ=+π/2 → asse maggiore (transversale) dell'arcata.
            left_extr = control_points_world[0, :2]
            right_extr = control_points_world[-1, :2]
            chord = right_extr - left_extr
            chord_norm = float(np.linalg.norm(chord))
            if chord_norm > 1e-3:
                chord_n = chord / chord_norm
                # Angolo della corda rispetto a +X world: atan2(y, x) ∈ [-π, π]
                angle_from_x = float(np.arctan2(chord_n[1], chord_n[0]))
                # Normalizza a [-π/2, π/2] — la corda può puntare a +X o -X
                # indifferentemente, ci basta allinearla ALL'ASSE X world.
                # Questo garantisce rotazione minima (mai più di 90°).
                if angle_from_x > np.pi / 2:
                    angle_from_x -= np.pi
                elif angle_from_x < -np.pi / 2:
                    angle_from_x += np.pi
                rotation = -angle_from_x  # rotazione da applicare per allineare
                if abs(rotation) > 0.0087:  # > 0.5° significativo (0.0087 rad)
                    cos_r = float(np.cos(rotation))
                    sin_r = float(np.sin(rotation))
                    centroid_xy = control_points_world[:, :2].mean(axis=0)
                    cp_xy_centered = control_points_world[:, :2] - centroid_xy
                    new_x = cp_xy_centered[:, 0] * cos_r - cp_xy_centered[:, 1] * sin_r
                    new_y = cp_xy_centered[:, 0] * sin_r + cp_xy_centered[:, 1] * cos_r
                    control_points_world[:, 0] = new_x + centroid_xy[0]
                    control_points_world[:, 1] = new_y + centroid_xy[1]
                    logger(f"[FAST] arch_detect V2.14 ChordAlignMinimal: "
                           f"ruotato di {np.degrees(rotation):.2f}° attorno a "
                           f"Z world (corda → ±X world, |rot| ≤ 90°)")
                else:
                    logger(f"[FAST] arch_detect V2.14 ChordAlignMinimal: "
                           f"già allineato ({np.degrees(rotation):.2f}°)")
            else:
                logger(f"[FAST] arch_detect V2.14 ChordAlignMinimal: "
                       f"corda troppo corta ({chord_norm:.3f}mm), skip")
        else:
            logger(f"[FAST] arch_detect V2.14 ChordAlignMinimal: SKIP")
    except Exception as e:
        logger(f"[FAST] arch_detect V2.12/V2.14 warning: {e}")

    # ---- 12. Build .crv.json datablock + passthrough STL ----------------
    try:
        crv_data = {
            "splines": [{
                "control_points": [[float(p[0]), float(p[1]), float(p[2])]
                                   for p in control_points_world],
                "cyclic": False,
            }],
            "metadata": {
                "tool": "arch_detect",
                "version": "2.17",
                "coords_space": "scanner_world",
                "fit_method": "ellipse_truncated_v29_baseline_planar_chord_aligned",
                "planarize_z_world": bool(locals().get('planarize', True)),
                "align_world_xy": bool(locals().get('align_xy', True)),
                "n_verts_input": int(n_verts),
                "n_verts_selected": int(n_selected),
                "n_verts_used_for_skeleton": int(len(arch_verts_idx)),
                "curv_p70": float(curv_threshold),
                "curv_clipped_outliers": int(n_outliers),
                "curv_clipped_nonfinite": int(n_nonfinite),
                "arch_length_mm": float(total_len),
                "n_ctrl_points": int(N_CTRL_POINTS),
                "n_bins_filled": int(n_bins_filled),
                "n_bins_total": int(N_BINS),
                "pca_eigenvalues": [l1, l2, l3],
                "pca_ratios": [float(ratio12), float(ratio23)],
                "scalars_cache_hit": bool(cache_hit),
                # V1.8 (2026-05-12) — template fit + Z-offset
                "template_requested": str(template_choice),
                "template_used": str(template_used),
                "template_residual": float(fit_residual),
                "template_scales": [float(fit_scales[0]), float(fit_scales[1])],
                "template_flip_y": bool(flip_y),
                "z_offset_mm": float(z_offset_mm),
                "elevation_sign": float(elevation_sign),
                "ridge_z_local": float(ridge_z),
                # V2.1 params (per cache invalidation params-aware)
                "adherence_pct": float(top_pct),
                "smoothness_sigma": float(gaussian_sigma_for_smoothing),
                "trim_end_frac": float(trim_frac),
                "n_bins_trimmed_start": int(n_trimmed_start),
                "n_bins_trimmed_end": int(n_trimmed_end),
                # V2.4 — fit parabola pura
                "extension_mm": float(ext_mm),
                "knee_slope_threshold": float(slope_th),
                "output_shape": "parabola",
            }
        }
        # Atomic write della curva
        crv_tmp = crv_output_path + ".tmp"
        with open(crv_tmp, 'w', encoding='utf-8') as f:
            json.dump(crv_data, f, indent=2, ensure_ascii=False)
        os.replace(crv_tmp, crv_output_path)
        logger(f"[FAST] arch_detect: scritta {os.path.basename(crv_output_path)} "
               f"({N_CTRL_POINTS} pts, {total_len:.1f}mm)")
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] arch_detect write crv: {e}")
        return False

    # ---- 13. Passthrough mesh STL ---------------------------------------
    try:
        import shutil
        if os.path.abspath(src_mesh_path) != os.path.abspath(output_path):
            shutil.copy2(src_mesh_path, output_path)
        return True
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] arch_detect passthrough STL: {e}")
        return False
