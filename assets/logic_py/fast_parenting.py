"""
fast_parenting — Tier 1 fast path per copia trasformazione da parent.

Riceve dal worker la matrice world 4×4 row-major (flat array 16 float)
del parent, calcolata da flattenGraphForBackend() nel frontend.
Applica la matrice ai vertici STL della mesh figlia via Trimesh.

Contratto socket (identico a gn_parenting.blend rimosso):
  IN_GEO_Mesh   — nome file STL della mesh figlia (gestito dal worker)
  IN_MTX_Parent — matrice 4×4 row-major del parent (flat array 16 float)
  OUT_GEO_Mesh  — mesh figlia trasformata (STL output, gestito dal worker)

Nessun socket slider: il nodo riceve solo la matrice dal cavo IN_MTX_Parent.
Il worker NON chiama questo file direttamente: usa worker/modules/fast_transform.py.
Questo file esiste nella cartella assets/logic_py per documentazione e per
mantenere la convenzione del sistema (ogni tool ha il suo source_file in assets).
"""

TOOL_SLUG = "fast_parenting"
TECH_TYPE = "FAST"
