"""extract_archform_templates.py — V1.0 (2026-05-13)

Image tracing dei 10 template ortodontici dall'immagine di riferimento.

USO:    python extract_archform_templates.py [IMMAGINE.png] [OUTPUT.json]
INPUT:  1° argomento; default assets/archform_templates_ref.png alla radice del
        repository. L'immagine NON è nel repository: la fornisce chi usa lo script.
OUTPUT: 2° argomento; default assets/arch_templates.json alla radice del repository.

Format JSON output:
{
    "version": "1.0",
    "source": "archform_templates_ref.png",
    "n_samples": 100,
    "templates": {
        "europa_1_upper":   [[x, y], [x, y], ...],   # 100 pts arc-length uniform
        "europa_1_lower":   [[x, y], ...],
        "europa_2_upper":   [...],
        "europa_2_lower":   [...],
        "trueform_1_upper": [...],
        "trueform_1_lower": [...],
        "trueform_2_upper": [...],
        "trueform_2_lower": [...],
        "standard_form_upper": [...],
        "standard_form_lower": [...],
        "bioform_1_upper":  [...],
        "bioform_1_lower":  [...],
        "bioform_2_upper":  [...],
        "bioform_2_lower":  [...],
        "bioform_3_upper":  [...],
        "bioform_3_lower":  [...],
        "bioform_4_upper":  [...],
        "bioform_4_lower":  [...],
        "bioform_5_upper":  [...],
        "bioform_5_lower":  [...]
    }
}

Coordinate in spazio normalizzato (-1, +1) per X (trasverso) e Y (anteroposteriore).
Apex (anteriore) a +Y, molari posteriori a -Y. Centro arcata a (0, 0).
La calibrazione in mm avviene in arch_detect.py applicando W6_ref (default 60mm
per upper, 53mm per lower — valori clinici Class I da Thai study PMC4484149).

Algoritmo:
1. Carica immagine grayscale + threshold (linee nere)
2. Per ogni ROI predefinita (10 forme × 2 archi = 20 ROI):
   - Estrae sub-image
   - Trova componenti connessi (i 2 archi sono i 2 più lunghi non-testo)
   - Per ogni arco: skeletonize → trova polyline ordinata → arc-length uniform N=100
3. Normalizza in (-1, +1) basato su bbox di ogni arco
4. Salva JSON

Dependencies: numpy, scipy, scikit-image, PIL (tutti già nel worker)
"""

import os
import sys
import json
from pathlib import Path
import numpy as np

try:
    from PIL import Image
except ImportError:
    raise SystemExit("ERROR: PIL/Pillow non installato. pip install Pillow")

try:
    from skimage.morphology import skeletonize
    from skimage.measure import label, regionprops
except ImportError:
    raise SystemExit("ERROR: scikit-image non installato. pip install scikit-image")

from scipy.spatial.distance import cdist
from scipy.ndimage import binary_dilation

# ───────────────────────────────────────────────────────────────────
# Configurazione
# ───────────────────────────────────────────────────────────────────

# Percorsi: dagli argomenti della riga di comando; senza argomenti, la cartella
# assets/ alla radice del repository (stessi nomi di file).
_REPO_ASSETS = Path(__file__).resolve().parents[2] / 'assets'
IMG_PATH = sys.argv[1] if len(sys.argv) > 1 else str(_REPO_ASSETS / 'archform_templates_ref.png')
OUT_PATH = sys.argv[2] if len(sys.argv) > 2 else str(_REPO_ASSETS / 'arch_templates.json')

N_SAMPLES = 100   # punti per arco (alta densità per fedeltà visiva)

# Threshold per binarizzazione (linee nere su sfondo bianco)
BINARY_THRESHOLD = 180  # pixel < 180 → nero (filo), >= 180 → bianco (sfondo)

# ROI dei 10 template nell'immagine (approssimato da inspection visiva).
# Coordinate: (x_min, y_min, x_max, y_max) in pixel.
# DA CALIBRARE dopo aver visto le dimensioni reali dell'immagine.
# L'immagine sembra essere ~1000x750 px circa.

ROIS = {
    # Colonna sinistra (4 forme)
    'europa_1':     {'roi': (60,  10,  280, 200), 'has_upper_lower': True},
    'trueform_1':   {'roi': (60,  220, 280, 380), 'has_upper_lower': True},
    'trueform_2':   {'roi': (60,  400, 280, 560), 'has_upper_lower': True},
    'standard_form':{'roi': (60,  580, 280, 750), 'has_upper_lower': True},
    # Colonna centrale (6 forme)
    'europa_2':     {'roi': (290, 10,  510, 150), 'has_upper_lower': True},
    'bioform_1':    {'roi': (290, 160, 510, 270), 'has_upper_lower': True},
    'bioform_2':    {'roi': (290, 280, 510, 380), 'has_upper_lower': True},
    'bioform_3':    {'roi': (290, 390, 510, 470), 'has_upper_lower': True},
    'bioform_4':    {'roi': (290, 480, 510, 580), 'has_upper_lower': True},
    'bioform_5':    {'roi': (290, 590, 510, 750), 'has_upper_lower': True},
}


# ───────────────────────────────────────────────────────────────────
# Image processing
# ───────────────────────────────────────────────────────────────────

def load_binary(path):
    """Carica immagine, converti a grayscale, binarizza (linee=True)."""
    img = Image.open(path).convert('L')
    arr = np.array(img)
    print(f"[INFO] image shape: {arr.shape}, dtype={arr.dtype}")
    binary = arr < BINARY_THRESHOLD  # True = pixel nero (filo o testo)
    print(f"[INFO] binary fill ratio: {binary.mean():.4f}")
    return binary, arr.shape


def extract_roi_components(binary, roi, dilation_iter=2):
    """Estrae componenti connessi dentro una ROI dopo binary_dilation per
    chiudere gap micro tra cap/lati di archi frammentati (problema noto:
    nelle stampe templates ortho, il cap superiore e i due lati verticali
    spesso sono disconnessi a livello pixel).

    Args:
        binary: full image binarized
        roi: (x1, y1, x2, y2)
        dilation_iter: # iterazioni binary_dilation (2 = chiude gap fino a 4px
                       senza far fondere UPPER e LOWER se distano >= 5px)

    Returns:
        (props, sub_orig, sub_dilated): props del dilated, sub_orig per skeletonize,
        sub_dilated per debug.
    """
    x1, y1, x2, y2 = roi
    sub = binary[y1:y2, x1:x2].copy()
    if dilation_iter > 0:
        sub_dilated = binary_dilation(sub, iterations=dilation_iter)
    else:
        sub_dilated = sub
    labels = label(sub_dilated, connectivity=2)
    props = regionprops(labels)
    props = sorted(props, key=lambda p: p.area, reverse=True)
    return props, sub, sub_dilated


def _debug_roi(name, roi, props, sub):
    """Dump diagnostic per una ROI: dimensioni, n. componenti, top 5 props
    con area, bbox, aspect ratio."""
    x1, y1, x2, y2 = roi
    n_black = int(sub.sum())
    n_pix = sub.shape[0] * sub.shape[1]
    print(f"  [DBG] roi=({x1},{y1},{x2},{y2}) size={sub.shape} "
          f"black_pix={n_black}/{n_pix} ({100.0*n_black/max(1, n_pix):.2f}%)")
    print(f"  [DBG] n_components={len(props)}")
    for i, p in enumerate(props[:8]):
        min_r, min_c, max_r, max_c = p.bbox
        bw = max_c - min_c
        bh = max_r - min_r
        ar = bw / max(1, bh)
        print(f"  [DBG]   #{i} area={int(p.area):5d} bbox=({min_c},{min_r})-({max_c},{max_r}) "
              f"size={bw}x{bh} aspect={ar:.2f}")


def trace_polyline_from_skeleton(skel):
    """Skeleton → polyline ordinata (lista di (y, x) lungo l'arco).

    Algoritmo:
    1. Trova endpoints (pixel con 1 solo vicino)
    2. Parti da uno dei 2 endpoint, traversa via greedy nearest-neighbor
       (each pixel del skeleton ha esattamente 2 vicini eccetto endpoints)
    3. Ritorna lista ordinata
    """
    ys, xs = np.where(skel)
    if len(ys) < 5:
        return None
    coords = np.column_stack([ys, xs])  # (N, 2) [row, col]

    # Trova endpoints: pixel del skeleton con esattamente 1 vicino 8-connesso
    H, W = skel.shape
    endpoints = []
    for i, (r, c) in enumerate(coords):
        n_neighbors = 0
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                rr, cc = r + dr, c + dc
                if 0 <= rr < H and 0 <= cc < W and skel[rr, cc]:
                    n_neighbors += 1
        if n_neighbors == 1:
            endpoints.append(i)

    if len(endpoints) < 2:
        # No clear endpoints (cycle or junction) — fallback: prendi pixel più
        # lontano dalla mediana come start
        ctr = coords.mean(axis=0)
        dists = np.linalg.norm(coords - ctr, axis=1)
        start_idx = int(np.argmax(dists))
    else:
        # Prendi un endpoint qualsiasi (start_idx)
        start_idx = endpoints[0]

    # Traversa greedy nearest-neighbor
    visited = np.zeros(len(coords), dtype=bool)
    visited[start_idx] = True
    path = [start_idx]
    current_idx = start_idx
    while True:
        cur = coords[current_idx]
        # Trova vicino non-visitato più vicino
        diffs = coords - cur
        dists = np.linalg.norm(diffs, axis=1)
        # Maschera pixel non-visitati a distanza 1-2 (8-connessi)
        mask = (~visited) & (dists > 0) & (dists < 3.0)
        if not mask.any():
            break
        candidates = np.where(mask)[0]
        next_idx = candidates[np.argmin(dists[candidates])]
        if dists[next_idx] > 2.5:  # gap troppo grande, stop
            break
        visited[next_idx] = True
        path.append(next_idx)
        current_idx = next_idx

    if len(path) < 5:
        return None

    return coords[path]  # (M, 2) in (row, col)


def resample_arc_length(polyline_yx, n_out):
    """Resample polyline uniform in arc-length, n_out punti."""
    pts = polyline_yx.astype(np.float64)
    diffs = np.diff(pts, axis=0)
    seg_lens = np.linalg.norm(diffs, axis=1)
    cumlen = np.concatenate([[0.0], np.cumsum(seg_lens)])
    total = float(cumlen[-1])
    if total < 1.0:
        return None
    target = np.linspace(0.0, total, n_out)
    out = np.zeros((n_out, 2), dtype=np.float64)
    for d in range(2):
        out[:, d] = np.interp(target, cumlen, pts[:, d])
    return out


def normalize_arch_template(polyline_yx, x_offset, y_offset):
    """Polyline in pixel space (row, col) → coordinate template normalizzate (-1,+1).

    Step:
    1. Converti (row, col) → (x_pix, y_pix) absolute (in immagine intera, non ROI)
       x_pix = col + x_offset, y_pix = row + y_offset
    2. Calcola bbox dei punti
    3. Centra su midpoint bbox, normalizza in [-1, +1] sul max(width, height)
    4. Flip Y: in immagine Y cresce verso il basso, vogliamo apex a +Y
       (l'apex anteriore dell'arcata è il PIÙ ALTO nell'immagine = Y_pix piccolo)
    5. Ordina i punti da sx (apex_dx posteriore) ad dx (apex_sx posteriore)
       passando per apex anteriore al center (axis-X attraversa)
    """
    pts = polyline_yx.copy()
    # row=Y_pix, col=X_pix → swap
    x_pix = pts[:, 1] + x_offset  # col
    y_pix = pts[:, 0] + y_offset  # row

    # Center & scale
    x_min, x_max = float(x_pix.min()), float(x_pix.max())
    y_min, y_max = float(y_pix.min()), float(y_pix.max())
    w = max(1e-6, x_max - x_min)
    h = max(1e-6, y_max - y_min)
    scale = max(w, h) / 2.0

    cx = (x_min + x_max) / 2.0
    cy = (y_min + y_max) / 2.0

    # Coord normalizzate: x in [-1, +1] (trasverso), y anteroposteriore
    # In immagine Y_pix piccolo = top (apex anteriore dell'arcata),
    # Y_pix grande = bottom (posteriore). Vogliamo apex a +Y.
    x_norm = (x_pix - cx) / scale
    y_norm = -(y_pix - cy) / scale  # FLIP Y

    return np.column_stack([x_norm, y_norm])


def split_upper_lower(polyline_a, polyline_b):
    """Date 2 polilinee, identifica quale è UPPER (più grande/esterna) e quale LOWER.
    Confronta il bbox: upper ha bbox più grande.
    Ritorna (upper, lower)."""
    def bbox_area(p):
        return (p[:, 0].max() - p[:, 0].min()) * (p[:, 1].max() - p[:, 1].min())
    if bbox_area(polyline_a) >= bbox_area(polyline_b):
        return polyline_a, polyline_b
    return polyline_b, polyline_a


# ───────────────────────────────────────────────────────────────────
# Main
# ───────────────────────────────────────────────────────────────────

def main():
    if not os.path.isfile(IMG_PATH):
        raise SystemExit(f"ERROR: immagine di riferimento non trovata: {IMG_PATH}\n"
                         f"archform_templates_ref.png non è nel repository: va fornita da chi usa lo script.\n"
                         f"Passa il percorso come argomento: "
                         f"python extract_archform_templates.py <immagine.png> [output.json]")
    if not os.path.isdir(os.path.dirname(os.path.abspath(OUT_PATH))):
        raise SystemExit(f"ERROR: cartella di output non trovata per {OUT_PATH}\n"
                         f"Passa il percorso di output come 2° argomento.")

    binary, shape = load_binary(IMG_PATH)
    H, W = shape

    templates = {}
    for name, info in ROIS.items():
        x1, y1, x2, y2 = info['roi']
        # Clamp ROI a immagine
        x1 = max(0, min(W - 1, x1))
        x2 = max(x1 + 10, min(W, x2))
        y1 = max(0, min(H - 1, y1))
        y2 = max(y1 + 10, min(H, y2))

        props, sub, sub_dilated = extract_roi_components(binary, (x1, y1, x2, y2), dilation_iter=2)
        print(f"\n[ROI] {name}")
        _debug_roi(name, (x1, y1, x2, y2), props, sub_dilated)
        if len(props) == 0:
            print(f"[WARN] {name}: no components found")
            continue

        # Filtro per area: gli archi POST-dilation sono UN componente unico
        # (cap+lati uniti) con area > ~300 px. Testo dilatato ha area < ~200 px.
        # Threshold conservativo: area >= 250.
        # NO filtro aspect — un arco completo a U inversa ha bbox quasi quadrato
        # (aspect ~1.0). Il vecchio filtro aspect>1.2 era basato su assunzione sbagliata.
        arch_props = [p for p in props if p.area >= 250]

        if len(arch_props) < (2 if info['has_upper_lower'] else 1):
            print(f"[WARN] {name}: trovati solo {len(arch_props)} archi (atteso "
                  f"{'2' if info['has_upper_lower'] else '1'})")
            # Continue comunque con quello che c'è

        # Per ogni arco: skeletonize sub originale (NON dilatato — per centerline pulita)
        # mascherato dal componente dilated (definisce quali pixel del sub originale
        # appartengono a questo arco). Poi trace polyline.
        traced = []
        for p in arch_props[:2]:  # top 2 per area
            min_r, min_c, max_r, max_c = p.bbox
            # Crop sub originale al bbox del componente
            sub_orig_crop = sub[min_r:max_r, min_c:max_c]
            # Mask: pixel originali ∩ componente dilated (per evitare di catturare
            # altri archi/testo passanti nel bbox di questo componente)
            comp_mask = (label(sub_dilated, connectivity=2) == p.label)[min_r:max_r, min_c:max_c]
            masked_orig = sub_orig_crop & comp_mask
            # Skeletonize i pixel originali (centerline 1px wide)
            comp_skel = skeletonize(masked_orig)
            if comp_skel.sum() < 10:
                # Fallback: skeletonize del componente dilated (meno preciso ma sempre OK)
                comp_skel = skeletonize(comp_mask)
                print(f"  [DBG] {name}: skel fallback su dilated mask "
                      f"(orig masked too small: {int(masked_orig.sum())} px)")

            polyline_local = trace_polyline_from_skeleton(comp_skel)
            if polyline_local is None:
                print(f"  [DBG] {name}: trace fallita per componente bbox=({min_c},{min_r})-({max_c},{max_r})")
                continue
            # Converti a coord ROI: + (min_r, min_c)
            polyline_local[:, 0] += min_r
            polyline_local[:, 1] += min_c
            # Resample arc-length
            resampled = resample_arc_length(polyline_local, N_SAMPLES)
            if resampled is None:
                continue
            # Normalizza
            normalized = normalize_arch_template(resampled, x1, y1)
            traced.append(normalized)

        if len(traced) == 0:
            print(f"[ERR ] {name}: no traceable arches")
            continue

        def _polybbox(p):
            return (float(p[:, 0].min()), float(p[:, 0].max()),
                    float(p[:, 1].min()), float(p[:, 1].max()))

        if info['has_upper_lower'] and len(traced) >= 2:
            upper, lower = split_upper_lower(traced[0], traced[1])
            templates[f"{name}_upper"] = upper.tolist()
            templates[f"{name}_lower"] = lower.tolist()
            ub = _polybbox(upper); lb = _polybbox(lower)
            # Sanity: x_range simmetrico (-1..+1) e y_range non degenerato
            x_sym_u = abs(ub[0] + ub[1])  # se simmetrico: vicino a 0
            x_sym_l = abs(lb[0] + lb[1])
            sanity_warn = ""
            if x_sym_u > 0.3 or x_sym_l > 0.3:
                sanity_warn = " ⚠ X asimmetrico (forse mezzo arco)"
            if (ub[3] - ub[2]) < 0.5 or (lb[3] - lb[2]) < 0.5:
                sanity_warn += " ⚠ Y range piccolo"
            print(f"[OK  ] {name}: upper+lower estratti{sanity_warn}")
            print(f"         upper x=[{ub[0]:+.2f},{ub[1]:+.2f}] y=[{ub[2]:+.2f},{ub[3]:+.2f}]")
            print(f"         lower x=[{lb[0]:+.2f},{lb[1]:+.2f}] y=[{lb[2]:+.2f},{lb[3]:+.2f}]")
        elif len(traced) >= 1:
            templates[f"{name}_upper"] = traced[0].tolist()
            tb = _polybbox(traced[0])
            print(f"[OK  ] {name}: solo upper estratto "
                  f"x=[{tb[0]:+.2f},{tb[1]:+.2f}] y=[{tb[2]:+.2f},{tb[3]:+.2f}]")

    # Salva JSON
    output = {
        "version": "1.0",
        "source": os.path.basename(IMG_PATH),
        "n_samples": N_SAMPLES,
        "n_templates_extracted": len(templates),
        "templates": templates,
    }
    with open(OUT_PATH, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"\n[DONE] Salvato {OUT_PATH}")
    print(f"       {len(templates)} archi estratti (atteso: 20 = 10 forme × upper/lower)")


if __name__ == '__main__':
    main()
