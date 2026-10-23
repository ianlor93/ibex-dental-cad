"""export_archform_templates_from_blender.py

Da eseguire DENTRO Blender (Text Editor → Run Script).

Itera tutti gli oggetti Curve con nomi attesi (`europa_1_upper`, ..., `bioform_5_lower`),
sampla 100 punti arc-length uniform per ognuno, normalizza in (-1, +1) bbox-based
e salva in `assets/arch_templates.json` alla radice del repository, o nel percorso
passato come argomento dopo `--` (convenzione Blender):
  blender scena.blend --python export_archform_templates_from_blender.py -- /percorso/arch_templates.json

Convenzioni di disegno (Blender):
- Piano XY (Z ignorato, puoi disegnare a Z=0 o qualsiasi valore costante).
- Asse +Y = apex anteriore (incisivi).
- Asse -Y = posteriore (molari distali sx/dx).
- Curve aperte (non chiuse) da m2_sx → i1 (apex) → m2_dx.
- Origine arbitraria — la normalizzazione bbox la rimuove.
- 2 oggetti curva separati per ogni template (upper + lower).

Nomi attesi (case-sensitive):
  europa_1_upper, europa_1_lower
  europa_2_upper, europa_2_lower
  trueform_1_upper, trueform_1_lower
  trueform_2_upper, trueform_2_lower
  standard_form_upper, standard_form_lower
  bioform_1_upper, bioform_1_lower
  bioform_2_upper, bioform_2_lower
  bioform_3_upper, bioform_3_lower
  bioform_4_upper, bioform_4_lower
  bioform_5_upper, bioform_5_lower

OUTPUT: assets/arch_templates.json alla radice del repository, o l'argomento dopo `--`
        (sovrascrive l'image-traced)
"""

import bpy
import json
import os
import sys
import math
from pathlib import Path


# Percorso di output: argomento dopo `--` (sys.argv di Blender); senza argomento,
# assets/arch_templates.json alla radice del repository (stesso nome di file).
_ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if _ARGS:
    _OUT_PATH = _ARGS[0]
else:
    try:
        _OUT_PATH = str(Path(__file__).resolve().parents[2] / 'assets' / 'arch_templates.json')
    except (NameError, IndexError):
        _OUT_PATH = ''
if not _OUT_PATH or not os.path.isdir(os.path.dirname(os.path.abspath(_OUT_PATH))):
    raise SystemExit(f"ERROR: cartella di output non trovata ({_OUT_PATH or 'percorso dello script non determinabile'}).\n"
                     "Passa il percorso come argomento dopo `--`: blender scena.blend --python "
                     "export_archform_templates_from_blender.py -- /percorso/arch_templates.json")


N_SAMPLES = 100   # punti per curva (alta densità per fedeltà visiva)
N_BEZIER_PER_SEG = 32   # subdivisioni per segmento Bezier (oversample pre-resample)


EXPECTED_NAMES = [
    'europa_1_upper',     'europa_1_lower',
    'europa_2_upper',     'europa_2_lower',
    'trueform_1_upper',   'trueform_1_lower',
    'trueform_2_upper',   'trueform_2_lower',
    'standard_form_upper', 'standard_form_lower',
    'bioform_1_upper',    'bioform_1_lower',
    'bioform_2_upper',    'bioform_2_lower',
    'bioform_3_upper',    'bioform_3_lower',
    'bioform_4_upper',    'bioform_4_lower',
    'bioform_5_upper',    'bioform_5_lower',
]


def sample_curve_polyline(curve_obj):
    """Estrae polyline densa da una Curve Bezier/Poly in Blender.

    Per Bezier: per ogni segmento usa interpolazione cubica Bezier classica
    con N_BEZIER_PER_SEG sub-passi. Applica anche la trasformazione world
    dell'oggetto (matrix_world) ai punti — così l'utente può aver translato
    le curve liberamente nella scena senza influire sul template normalizzato.

    Per Poly: usa direttamente i control points.

    Returns: lista di tuple (x, y, z) in world space, o None se curva degenere.
    """
    M = curve_obj.matrix_world
    points = []

    for spline in curve_obj.data.splines:
        if spline.type == 'BEZIER':
            bps = spline.bezier_points
            if len(bps) < 2:
                continue
            for i in range(len(bps) - 1):
                p0 = M @ bps[i].co
                h1 = M @ bps[i].handle_right
                h2 = M @ bps[i + 1].handle_left
                p1 = M @ bps[i + 1].co
                for j in range(N_BEZIER_PER_SEG):
                    t = j / N_BEZIER_PER_SEG
                    u = 1.0 - t
                    x = u**3 * p0.x + 3*u**2*t * h1.x + 3*u*t**2 * h2.x + t**3 * p1.x
                    y = u**3 * p0.y + 3*u**2*t * h1.y + 3*u*t**2 * h2.y + t**3 * p1.y
                    z = u**3 * p0.z + 3*u**2*t * h1.z + 3*u*t**2 * h2.z + t**3 * p1.z
                    points.append((x, y, z))
            # Ultimo punto
            last = M @ bps[-1].co
            points.append((last.x, last.y, last.z))
        elif spline.type == 'POLY':
            for pt in spline.points:
                p = M @ pt.co.xyz  # POLY co is 4D
                points.append((p.x, p.y, p.z))
        elif spline.type == 'NURBS':
            for pt in spline.points:
                p = M @ pt.co.xyz
                points.append((p.x, p.y, p.z))

    return points if len(points) >= 2 else None


def resample_arc_length(points_3d, n_samples):
    """Resample lista di punti in arc-length uniforme a n_samples."""
    if len(points_3d) < 2:
        return None
    # Calcola arc-length cumulato (uso solo XY per match con CAD dentale planare)
    seg_lens = []
    for i in range(len(points_3d) - 1):
        dx = points_3d[i + 1][0] - points_3d[i][0]
        dy = points_3d[i + 1][1] - points_3d[i][1]
        seg_lens.append(math.sqrt(dx * dx + dy * dy))
    cumlen = [0.0]
    for s in seg_lens:
        cumlen.append(cumlen[-1] + s)
    total = cumlen[-1]
    if total < 1e-6:
        return None

    out = []
    for i in range(n_samples):
        target = total * i / (n_samples - 1)
        # Binary search del segmento contenente target
        lo, hi = 0, len(cumlen) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if cumlen[mid] <= target:
                lo = mid
            else:
                hi = mid
        seg_len = max(1e-9, cumlen[hi] - cumlen[lo])
        alpha = (target - cumlen[lo]) / seg_len
        x = points_3d[lo][0] + alpha * (points_3d[hi][0] - points_3d[lo][0])
        y = points_3d[lo][1] + alpha * (points_3d[hi][1] - points_3d[lo][1])
        out.append((x, y))
    return out


def normalize_template(points_xy):
    """BBox-based normalize in (-1, +1) preservando proporzioni."""
    xs = [p[0] for p in points_xy]
    ys = [p[1] for p in points_xy]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    cx = (x_min + x_max) / 2.0
    cy = (y_min + y_max) / 2.0
    w = max(1e-6, x_max - x_min)
    h = max(1e-6, y_max - y_min)
    scale = max(w, h) / 2.0
    return [[(p[0] - cx) / scale, (p[1] - cy) / scale] for p in points_xy]


def main():
    # Log buffer: cattura tutto l'output testuale per scriverlo anche su file
    # (utile su Mac dove System Console non è disponibile da menu)
    log_lines = []
    def log(msg=""):
        print(msg)
        log_lines.append(msg)

    # Patch global print per intercettare tutti i print successivi
    import builtins
    _orig_print = builtins.print
    def _capturing_print(*args, **kwargs):
        s = " ".join(str(a) for a in args)
        log_lines.append(s)
        _orig_print(*args, **kwargs)
    builtins.print = _capturing_print

    log("=" * 60)
    log(f"export_archform_templates_from_blender")
    log(f"Target: {_OUT_PATH}")
    log("=" * 60)

    templates = {}
    missing = []
    failed = []
    diagnostics = {}

    for name in EXPECTED_NAMES:
        obj = bpy.data.objects.get(name)
        if obj is None:
            missing.append(name)
            print(f"[MISS] {name}: oggetto non trovato")
            continue
        if obj.type != 'CURVE':
            failed.append(name)
            print(f"[ERR ] {name}: tipo={obj.type}, atteso CURVE")
            continue

        pts_3d = sample_curve_polyline(obj)
        if pts_3d is None:
            failed.append(name)
            print(f"[ERR ] {name}: sampling fallito (curva degenere)")
            continue

        pts_resampled = resample_arc_length(pts_3d, N_SAMPLES)
        if pts_resampled is None:
            failed.append(name)
            print(f"[ERR ] {name}: arc-length resample fallito")
            continue

        normalized = normalize_template(pts_resampled)

        # Diagnostic: range XY normalizzati (per verificare bbox simmetrico)
        xs = [p[0] for p in normalized]
        ys = [p[1] for p in normalized]
        x_range = (min(xs), max(xs))
        y_range = (min(ys), max(ys))
        diagnostics[name] = {'x': x_range, 'y': y_range, 'n_raw': len(pts_3d)}

        templates[name] = normalized
        x_sym = abs(x_range[0] + x_range[1])
        warn = " ⚠ X asimmetrico" if x_sym > 0.3 else ""
        print(f"[OK  ] {name}: {len(normalized)} pts "
              f"x=[{x_range[0]:+.2f},{x_range[1]:+.2f}] "
              f"y=[{y_range[0]:+.2f},{y_range[1]:+.2f}]{warn}")

    output = {
        "version": "2.0",  # 2.0 = Blender hand-traced (vs 1.0 image-traced)
        "source": "Blender hand-traced via export_archform_templates_from_blender.py",
        "n_samples": N_SAMPLES,
        "n_templates_extracted": len(templates),
        "n_missing": len(missing),
        "n_failed": len(failed),
        "missing": missing,
        "failed": failed,
        "diagnostics": diagnostics,
        "templates": templates,
    }

    out_dir = os.path.dirname(_OUT_PATH)
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    with open(_OUT_PATH, 'w') as f:
        json.dump(output, f, indent=2)

    print()
    print("=" * 60)
    print(f"[DONE] Salvato {_OUT_PATH}")
    print(f"       {len(templates)}/20 OK, {len(missing)} mancanti, {len(failed)} falliti")
    if missing:
        print(f"       Mancanti: {', '.join(missing)}")
    if failed:
        print(f"       Falliti: {', '.join(failed)}")
    print("=" * 60)

    # Salva log su file accanto al JSON (per debug visibile senza System Console)
    log_path = _OUT_PATH.replace('.json', '_export.log')
    try:
        with open(log_path, 'w') as f:
            f.write('\n'.join(log_lines))
        _orig_print(f"[LOG ] salvato {log_path}")
    except Exception as e:
        _orig_print(f"[WARN] log non scritto: {e}")

    # Ripristina print
    builtins.print = _orig_print


main()
