"""
fast_transform — Tier 1 fast path per traslazione e rotazione.

Riceve dal worker una world matrix 4×4 row-major (flat array 16 float)
già calcolata dal frontend con pivot compensation inclusa.
Applica la matrice ai vertici STL via Trimesh e scrive l'output.

Contratto socket (identico a gn_transform.blend rimosso):
  IN_GEO_Mesh   — nome file STL target (stringa, gestito dal worker)
  G1_Trasla_POS — vec3 traslazione (usato dal frontend per buildPivotedMatrix)
  G2_Ruota_ROT  — vec3 rotazione gradi (usato dal frontend per buildPivotedMatrix)
  OUT_GEO_Mesh  — mesh trasformata (STL output, gestito dal worker)

Il worker NON chiama questo file direttamente: usa worker/modules/fast_transform.py
che a sua volta applica la logica qui documentata via Trimesh.
Questo file esiste nella cartella assets/logic_py per documentazione e per
mantenere la convenzione del sistema (ogni tool ha il suo source_file in assets).
"""

TOOL_SLUG = "fast_transform"
TECH_TYPE = "FAST"
