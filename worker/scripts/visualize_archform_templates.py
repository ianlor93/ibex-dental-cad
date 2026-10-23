"""visualize_archform_templates.py — Mosaic preview dei 10 template estratti.

USO:    python visualize_archform_templates.py [INPUT.json] [OUTPUT.png]
INPUT:  1° argomento; default assets/arch_templates.json alla radice del repository.
OUTPUT: 2° argomento; default assets/arch_templates_preview.png alla radice del repository.

Per ciascuno dei 10 template, disegna upper (rosso) + lower (blu) sovrapposti
in una griglia 5x2 (5 colonne, 2 righe). Permette confronto visivo immediato
con l'immagine originale Ortho_Template.png.
"""

import os
import sys
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Percorsi: dagli argomenti della riga di comando; senza argomenti, la cartella
# assets/ alla radice del repository (stessi nomi di file).
_REPO_ASSETS = Path(__file__).resolve().parents[2] / 'assets'
JSON_PATH = sys.argv[1] if len(sys.argv) > 1 else str(_REPO_ASSETS / 'arch_templates.json')
OUT_PATH = sys.argv[2] if len(sys.argv) > 2 else str(_REPO_ASSETS / 'arch_templates_preview.png')

TEMPLATE_ORDER = [
    'europa_1', 'europa_2', 'standard_form', 'trueform_1', 'trueform_2',
    'bioform_1', 'bioform_2', 'bioform_3', 'bioform_4', 'bioform_5',
]

CELL_W = 200
CELL_H = 150
PADDING = 30
N_COLS = 5
N_ROWS = 2

UPPER_COLOR = (220, 60, 60)   # rosso
LOWER_COLOR = (60, 100, 220)  # blu


def draw_template(draw, pts, ox, oy, color, w=CELL_W, h=CELL_H):
    """Disegna la polilinea pts (normalizzata [-1,+1]) nella cella (ox, oy)."""
    # Scala in pixel: x normalizzato [-1,+1] → [0, w-1], y normalizzato [-1,+1] → [h-1, 0] (flip)
    margin = 10
    sw = (w - 2 * margin) / 2.0
    sh = (h - 2 * margin) / 2.0
    cx = ox + w // 2
    cy = oy + h // 2
    xy = []
    for p in pts:
        x_pix = cx + p[0] * sw
        y_pix = cy - p[1] * sh  # flip Y per visualizzazione (matplotlib-like)
        xy.append((x_pix, y_pix))
    draw.line(xy, fill=color, width=2)
    # Endpoint markers
    if len(xy) > 0:
        for ep in (xy[0], xy[-1]):
            draw.ellipse((ep[0]-3, ep[1]-3, ep[0]+3, ep[1]+3), fill=color)


def main():
    if not os.path.isfile(JSON_PATH):
        raise SystemExit(f"ERROR: {JSON_PATH} non trovato — lancia prima extract_archform_templates.py\n"
                         f"oppure passa il percorso come argomento: "
                         f"python visualize_archform_templates.py <arch_templates.json> [preview.png]")
    if not os.path.isdir(os.path.dirname(os.path.abspath(OUT_PATH))):
        raise SystemExit(f"ERROR: cartella di output non trovata per {OUT_PATH}\n"
                         f"Passa il percorso di output come 2° argomento.")

    with open(JSON_PATH, 'r') as f:
        data = json.load(f)
    templates = data['templates']
    print(f"[INFO] {len(templates)} template loaded from {JSON_PATH}")

    img_w = N_COLS * CELL_W + (N_COLS + 1) * PADDING // 2
    img_h = N_ROWS * CELL_H + (N_ROWS + 1) * PADDING // 2 + 30  # +30 per titoli
    img = Image.new('RGB', (img_w, img_h), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Default font (skia se disponibile, altrimenti default PIL)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 12)
    except Exception:
        font = ImageFont.load_default()

    for idx, name in enumerate(TEMPLATE_ORDER):
        col = idx % N_COLS
        row = idx // N_COLS
        ox = PADDING // 2 + col * (CELL_W + PADDING // 2)
        oy = 25 + row * (CELL_H + PADDING // 2)

        # Cell border
        draw.rectangle((ox, oy, ox + CELL_W, oy + CELL_H), outline=(200, 200, 200))

        # Title
        draw.text((ox + 5, oy - 15), name, fill=(0, 0, 0), font=font)

        upper_key = f"{name}_upper"
        lower_key = f"{name}_lower"
        if upper_key in templates:
            pts_upper = np.array(templates[upper_key])
            draw_template(draw, pts_upper, ox, oy, UPPER_COLOR)
        if lower_key in templates:
            pts_lower = np.array(templates[lower_key])
            draw_template(draw, pts_lower, ox, oy, LOWER_COLOR)

    # Legend
    draw.text((PADDING, img_h - 18), "Rosso = UPPER  Blu = LOWER",
              fill=(50, 50, 50), font=font)

    img.save(OUT_PATH)
    print(f"[DONE] Salvato {OUT_PATH}")


if __name__ == '__main__':
    main()
