"""
logic_builder — Generatore script Blender per IBEX Tier 2.

Architettura Python-pure (V14.0+):
    Nessun .blend viene più caricato da assets/logic_gn/ per costruire node
    groups o mesh ops. Ogni tool Tier 2 è implementato come metodo _gen_*
    che emette codice Python/BMesh inline, eseguito via bpy nel processo
    Blender del worker (inline exec) o via subprocess fallback.

    Il registro _TIER2_GENERATORS mappa tool_id → metodo generatore. Tool
    sconosciuti producono un [IBEX-ENGINE ERROR] esplicito (niente fallback
    silenzioso su file .blend inesistenti).

    scene.blend resta necessario: contiene le mesh importate da INIT_PROJECT
    (coordinate scanner, pivot BBox center — invariante 1 "V13.0 Bite-Safe").
    LogicBuilder resta rilevante anche senza tool Tier 2 registrati: fornisce
    build_init_script() + _generate_export_all() usato da BAKE_PROJECT per
    esportare mesh non toccate da alcun tool.

I tool Tier 1 (fast_transform, fast_parenting, sculpt, meshcleaner) NON
passano per questo modulo: sono filtrati dal worker in tier1_queue e applicati
da worker/modules/fast_transform.py. Tre famiglie runtime:
  · Trimesh + numpy → fast_transform, fast_parenting (matrici rigide)
  · Passthrough STL → sculpt (Sculpt V2 BVH client-side)
  · PyMeshLab in-process → meshcleaner (V16.0, 2026-04-22)

NOTA (2026-04-22): meshcleaner migrato a Tier 1 via PyMeshLab. _TIER2_GENERATORS
è attualmente un dict VUOTO. delta_sculpting rimosso in precedenza con Sculpt V2.
"""

import os
import re
import importlib.util
import json

from .config import LOGIC_PY_DIR

# C1 guard (2026-06-14): `target` arriva dalla queue ($_POST['queue'] via Redis) e finiva
# interpolato GREZZO in codice generato per exec() Blender (era _tgt_file = '{target}').
# Whitelist filename mesh (stesso charset di meshName in EditorController:206) → rifiuta
# payload con ' ; ) newline ecc. Difesa: build_script() fail-closed + _generate_export() repr.
_TARGET_RX = re.compile(r'^[A-Za-z0-9 _.()\-]+\.stl$', re.IGNORECASE)


def _load_tier2_tool(name):
    """
    Carica dinamicamente un modulo tool Tier 2 da assets/logic_py/{name}.py.
    `assets/` non è un package Python (è sibling di worker/, non su sys.path):
    usiamo importlib.util.spec_from_file_location con path assoluto da
    config.LOGIC_PY_DIR. Ogni modulo deve esporre `generate(target, params) -> str`.
    """
    path = os.path.join(LOGIC_PY_DIR, f"{name}.py")
    spec = importlib.util.spec_from_file_location(f"ibex_tier2_{name}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Impossibile caricare tool Tier 2 da {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, 'generate'):
        raise AttributeError(f"Tool Tier 2 {name} non espone generate(target, params)")
    return mod


# Tool Tier 2 attivi. Al 2026-04-22 il set è VUOTO: meshcleaner è migrato
# a Tier 1 via PyMeshLab (fast_transform._apply_meshcleaner). LogicBuilder
# resta utile per build_init_script() + _generate_export_all() (bake delle
# mesh non toccate da alcun tool). Qualsiasi futuro tool Tier 2 va
# registrato qui + in _TIER2_GENERATORS (dispatch) — vedi docstring modulo.
TIER2_TOOLS = set()


class LogicBuilder:
    def __init__(self, active_dir, output_dir=None):
        self.active_dir = active_dir
        self.output_dir = output_dir or active_dir

    # ═════════════════════════════════════════════════════════════════════
    # Header comune — importazioni + utility condivise
    # ═════════════════════════════════════════════════════════════════════

    def get_header(self):
        return f"""
import bpy, os, json, math, mathutils, bmesh, traceback

def hex_to_rgba(hex_str):
    hex_str = hex_str.lstrip('#')
    if len(hex_str) == 6:
        r, g, b = tuple(int(hex_str[i:i+2], 16)/255.0 for i in (0, 2, 4))
        return (r**2.2, g**2.2, b**2.2, 1.0)
    return (1.0, 1.0, 1.0, 1.0)

def recombine_vectors(params):
    if not isinstance(params, dict):
        return {{}}
    new_params = params.copy()
    bases = set()
    for k in params.keys():
        if isinstance(k, str) and (k.endswith('_X') or k.endswith('_Y') or k.endswith('_Z')):
            bases.add(k.rsplit('_', 1)[0])
    for b in bases:
        if f"{{b}}_X" in params and f"{{b}}_Y" in params and f"{{b}}_Z" in params:
            new_params[b] = [params[f"{{b}}_X"], params[f"{{b}}_Y"], params[f"{{b}}_Z"]]
    return new_params

def _ibex_resolve_mesh(target):
    # target può essere "Upper.stl" (INIT_PROJECT usa il filename come obj.name)
    # oppure "Upper" (legacy). Tenta entrambi e ritorna None + errore esplicito.
    name_noext = os.path.splitext(target)[0]
    obj = bpy.data.objects.get(target) or bpy.data.objects.get(name_noext)
    if obj is None:
        print(f"[IBEX-ENGINE ERROR] Oggetto non in scena: '{{target}}' (cercato anche '{{name_noext}}')")
    return obj

print("[IBEX-ENGINE V14.0] --- BLENDER PROCEDURAL VAULT START ---")
active_dir = {repr(self.active_dir)}
output_dir = {repr(self.output_dir)}
scene_file = os.path.join(active_dir, 'scene.blend')
"""

    # ═════════════════════════════════════════════════════════════════════
    # Entry point pubblici
    # ═════════════════════════════════════════════════════════════════════

    def build_init_script(self):
        """
        INIT_PROJECT: importa gli STL in scene.blend, imposta origine al BBox
        center (invariante 1 V13.0 — NON centra i vertici a (0,0,0) per
        preservare il Bite), salva mesh_pivots.json.
        """
        script = self.get_header()
        script += """
bpy.ops.wm.read_factory_settings(use_empty=True)
imported_count = 0
mesh_pivots = {}
for file in os.listdir(active_dir):
    if file.endswith('.stl') and 'Dummy' not in file:
        filepath = os.path.join(active_dir, file)

        if hasattr(bpy.ops.wm, 'stl_import'):
            bpy.ops.wm.stl_import(filepath=filepath)
        else:
            bpy.ops.import_mesh.stl(filepath=filepath)

        obj = bpy.context.selected_objects[0]
        obj.name = file

        # V13.0 Bite-Safe: origine al BBox center, NO location=(0,0,0).
        bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
        pivot = list(obj.location)
        mesh_pivots[file] = pivot
        print(f"[IBEX-ENGINE] Mesh importata: {file} — pivot: {pivot}")
        imported_count += 1

pivot_manifest_path = os.path.join(active_dir, 'mesh_pivots.json')
# L9.1 (2026-07-24): scrittura ATOMICA (tmp + os.replace), stesso pattern del
# save di scene.blend in build_import_script. Prima era una open('w') troncante:
# un crash/OOM tra troncamento e json.dump lasciava il sidecar a 0 byte →
# serve_file lo tratta come 404 (minSize=10) → MeshLoader.loadPivotManifest
# ritorna {} → fallback BBox client-side su TUTTE le mesh (pivot inferito su
# geometria Draco/world-space invece che Blender/scanner-space) = rischio Bite.
# Il tmp sta in active_dir (stesso filesystem → replace atomico) e finisce in
# '.tmp' → create_flat_zip lo esclude comunque se sopravvivesse a un crash.
_pivot_tmp = pivot_manifest_path + '.tmp'
with open(_pivot_tmp, 'w') as pf:
    json.dump(mesh_pivots, pf)
os.replace(_pivot_tmp, pivot_manifest_path)
print(f"[IBEX-ENGINE] Pivot manifest salvato: {len(mesh_pivots)} mesh")

bpy.ops.wm.save_as_mainfile(filepath=scene_file)
print(f"[IBEX-ENGINE] Scene initialized with {imported_count} masters.")
"""
        return script

    def build_import_script(self, new_files):
        """
        IMPORT_FILES (S5 «IBEX semplice», 2026-07-10): importa SOLO i nuovi
        STL nella scene.blend ESISTENTE — open_mainfile, MAI
        read_factory_settings su progetto vivo (Inv.12) — e fa il MERGE di
        mesh_pivots.json con le sole chiavi nuove (Inv.31: i pivot dei master
        esistenti non si ricalcolano). Origine al BBox center senza centering
        (Inv.1 Bite-Safe). Su import PARZIALE la scena NON viene salvata
        (emerge [IBEX-ENGINE ERROR] → il worker fa rollback delle copie: mai
        divergenza scena↔file, Inv.17). Save atomico via tmp + os.replace.
        `new_files` = basenames già validati dal worker (whitelist regex).
        NB: il filtro legacy 'Dummy' di build_init_script NON è replicato:
        qui l'utente seleziona esplicitamente i file (decisione S5).
        """
        script = self.get_header()
        script += f"""
new_files = {repr(list(new_files))}
bpy.ops.wm.open_mainfile(filepath=scene_file)

pivot_manifest_path = os.path.join(active_dir, 'mesh_pivots.json')
mesh_pivots = {{}}
if os.path.isfile(pivot_manifest_path):
    try:
        with open(pivot_manifest_path) as pf:
            mesh_pivots = json.load(pf) or {{}}
    except Exception:
        mesh_pivots = {{}}

imported_count = 0
for file in new_files:
    filepath = os.path.join(active_dir, file)
    if not os.path.isfile(filepath):
        print(f"[IBEX-ENGINE ERROR] Import: file mancante in active_dir: {{file}}")
        continue

    if hasattr(bpy.ops.wm, 'stl_import'):
        bpy.ops.wm.stl_import(filepath=filepath)
    else:
        bpy.ops.import_mesh.stl(filepath=filepath)

    obj = bpy.context.selected_objects[0]
    obj.name = file

    # V13.0 Bite-Safe: origine al BBox center, NO location=(0,0,0).
    bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
    pivot = list(obj.location)
    mesh_pivots[file] = pivot
    print(f"[IBEX-ENGINE] Mesh importata: {{file}} — pivot: {{pivot}}")
    imported_count += 1

if imported_count != len(new_files):
    print("[IBEX-ENGINE ERROR] Import parziale: scena NON salvata (rollback lato worker).")
else:
    # L9.1 (2026-07-24): scrittura ATOMICA del sidecar (tmp + os.replace), lo
    # stesso pattern gia' usato 4 righe sotto per scene.blend. Prima era una
    # open('w') troncante: un crash/OOM tra troncamento e json.dump lasciava
    # mesh_pivots.json a 0 byte -> serve_file 404 (minSize=10) -> il client
    # cade sul fallback BBox per TUTTE le mesh = pivot Bite-Safe perso.
    # NB: niente graffe letterali qui dentro, questo generatore e' una f-string.
    _pivot_tmp = pivot_manifest_path + '.tmp'
    with open(_pivot_tmp, 'w') as pf:
        json.dump(mesh_pivots, pf)
    os.replace(_pivot_tmp, pivot_manifest_path)
    tmp_scene = scene_file + '.tmp.blend'
    bpy.ops.wm.save_as_mainfile(filepath=tmp_scene)
    os.replace(tmp_scene, scene_file)
    print(f"[IBEX-ENGINE] Import completato: {{imported_count}} mesh aggiunte alla scena.")
"""
        return script

    def build_script(self, queue, export_all=False, tier1_override=None):
        """
        PREVIEW_BAKE / BAKE_PROJECT: apre scene.blend, applica tool Tier 2
        sulla queue filtrata, esporta STL.

        queue:           lista step Tier 2 già filtrati dal worker (Tier 1
                         non deve arrivare qui; se arriva, viene loggato
                         come [IBEX-ENGINE ERROR] nel dispatch).
        export_all:      True per BAKE_PROJECT (esporta TUTTE le mesh di scena
                         — invariante 17 Anti-Frankenstein 3.0); False per
                         PREVIEW_BAKE (esporta solo i target della queue).
        tier1_override:  path directory contenente STL già trasformati da
                         Trimesh. Se presente, rimpiazza i corrispondenti
                         oggetti in scene.blend prima di applicare Tier 2.
        """
        script = self.get_header()

        # C1 guard: rifiuta target malevoli nella queue PRIMA di generare qualunque codice exec().
        for _s in (queue or []):
            _t = _s.get('target')
            if _t and not _TARGET_RX.fullmatch(str(_t)):
                return self.get_header() + '\nprint("[IBEX-ENGINE ERROR] target non valido nella queue (C1 guard)")\n'

        script += "\nbpy.ops.wm.open_mainfile(filepath=scene_file)\n"

        if tier1_override and os.path.isdir(tier1_override):
            script += self._generate_tier1_override(tier1_override)

        script += self._generate_tool_application(queue)

        if export_all:
            script += self._generate_export_all()
        else:
            active_targets = list({step.get('target') for step in queue if step.get('target')})
            script += self._generate_export(active_targets)

        return script

    # ═════════════════════════════════════════════════════════════════════
    # Tier 1 override — reimporta STL già trasformati in sostituzione di scene.blend
    # ═════════════════════════════════════════════════════════════════════

    def _generate_tier1_override(self, tier1_dir):
        return f"""
# [IBEX-ENGINE] Tier 1 override: reimporta STL Trimesh prima di applicare Tier 2
_tier1_dir = {repr(tier1_dir)}
_override_files = [f for f in os.listdir(_tier1_dir) if f.lower().endswith('.stl')] if os.path.isdir(_tier1_dir) else []
for _fname in _override_files:
    _old = bpy.data.objects.get(_fname)
    if _old:
        bpy.data.objects.remove(_old, do_unlink=True)
    _stl_path = os.path.join(_tier1_dir, _fname)
    if hasattr(bpy.ops.wm, 'stl_import'):
        bpy.ops.wm.stl_import(filepath=_stl_path)
    else:
        bpy.ops.import_mesh.stl(filepath=_stl_path)
    _new_obj = bpy.context.selected_objects[0] if bpy.context.selected_objects else None
    if _new_obj:
        _new_obj.name = _fname
        bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
    print(f"[IBEX-ENGINE] Tier1 override importato: {{_fname}}")
print(f"[IBEX-ENGINE] Tier1 override completato: {{len(_override_files)}} mesh sostituite")
"""

    # ═════════════════════════════════════════════════════════════════════
    # Dispatch tool Tier 2 — registro Python-pure (niente .blend)
    # ═════════════════════════════════════════════════════════════════════

    def _generate_tool_application(self, queue):
        """
        Itera gli step della queue e genera codice Python per ciascuno.
        Ogni tool Tier 2 deve avere un generatore registrato in TIER2_GENERATORS.
        Tool sconosciuti producono [IBEX-ENGINE ERROR] esplicito.
        """
        parts = []
        for step in queue:
            tool_id = step.get('tool', '')
            target = step.get('target', '')
            raw_params = step.get('params', {}) or {}

            gen = self._TIER2_GENERATORS.get(tool_id)
            if gen is None:
                # Tool non registrato. Non c'è più alcun fallback .blend:
                # o il tool esiste come _gen_* in questa classe, o è un errore.
                parts.append(self._gen_unknown_tool(tool_id, target))
                continue

            parts.append(gen(target, raw_params))

        return "\n".join(parts)

    def _gen_unknown_tool(self, tool_id, target):
        # Emessa come istruzione Python che fa print dell'errore a runtime.
        # BlenderHandler._parse_and_evaluate cattura [IBEX-ENGINE ERROR] e
        # fa fallire run_script() → worker risponde fallimento al canale preview.
        # C1-BAKE difesa in profondita (2026-07-28): tool_id/target vengono dalla queue del
        # client. NON interpolarli con !r dentro un literal a doppi apici - repr() usa gli
        # apici singoli e lascia i doppi NUDI, che chiudono il print() e fanno eseguire il
        # resto. json.dumps() escapa tutto: sicuro dentro exec().
        msg = ('[IBEX-ENGINE ERROR] Tier 2 tool sconosciuto: %r su target %r. '
               'Registrare un _gen_* in logic_builder.py' % (tool_id, target))
        return 'print(%s)' % json.dumps(msg)

    # ─────────────────────────────────────────────────────────────────────
    # Tool Tier 2: la logica geometrica vive in assets/logic_py/{tool}.py
    # Qui dentro solo infrastruttura + dispatcher (vedi _TIER2_GENERATORS).
    # ─────────────────────────────────────────────────────────────────────

    # Registro dei tool Tier 2 — attualmente VUOTO (2026-04-22).
    # meshcleaner è stato migrato a Tier 1 (PyMeshLab); prima di lui
    # qui c'erano gn_meshcleaner_v2 + alias. Per aggiungere un nuovo
    # tool Tier 2: creare assets/logic_py/{tool}.py con generate(target,
    # params) -> str, caricarlo in cima al modulo via _load_tier2_tool,
    # registrare la lambda qui e aggiungere il nome a TIER2_TOOLS.
    _TIER2_GENERATORS = {}


    # ═════════════════════════════════════════════════════════════════════
    # Export — funzione comune _export_single_mesh_code
    # ═════════════════════════════════════════════════════════════════════

    def _export_single_mesh_code(self, obj_var='obj', target_var='target_name'):
        """
        Codice condiviso per esportare una singola mesh:
          DESELECT → clone → estrai attributi ibx_* → applica modifier snapshot
          → export STL + sidecar JSON → cleanup clone.

        Invariante 1 del Bug #1 risolto: sia _generate_export che
        _generate_export_all usano QUESTO metodo — divergenze tra preview e
        bake sono impossibili.
        """
        return f"""
    # Anti-Frankenstein: deseleziona tutto prima del clone
    bpy.ops.object.select_all(action='DESELECT')

    # Clone sacrificale
    _clone = {obj_var}.copy()
    _clone.data = {obj_var}.data.copy()
    bpy.context.collection.objects.link(_clone)
    bpy.context.view_layer.objects.active = _clone
    _clone.select_set(True)

    _sidecar = {{}}
    _eval_dg = bpy.context.evaluated_depsgraph_get()
    _eval_m = _clone.evaluated_get(_eval_dg).to_mesh()
    try:
        for _aname, _attr in _eval_m.attributes.items():
            if _aname.startswith('ibx_') and len(_attr.data) > 0:
                _v = _attr.data[0]
                if hasattr(_v, 'vector'):
                    _vv = _v.vector
                    _sidecar[_aname] = {{"x": round(_vv[0],5), "y": round(_vv[1],5), "z": round(_vv[2],5)}}
                elif hasattr(_v, 'color'):
                    _c = _v.color
                    _sidecar[_aname] = [round(_c[0],4), round(_c[1],4), round(_c[2],4), round(_c[3],4)]
                elif hasattr(_v, 'value'):
                    _sidecar[_aname] = _v.value
        _clone.to_mesh_clear()
    except Exception as _ex:
        print(f"[IBEX-ENGINE WARNING] Extractor fail su {{{target_var}}}: {{{{_ex}}}}")

    # Cottura modificatori — list() per snapshot sicuro
    for _mod in list(_clone.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=_mod.name)
        except Exception as _me:
            print(f"[IBEX-ENGINE ERROR] modifier_apply fallito '{{{{_mod.name}}}}' su {{{target_var}}}: {{{{_me}}}}")

    # Sidecar JSON
    _fp = os.path.join(output_dir, {target_var})
    _jfp = _fp.replace('.stl', '.json')
    try:
        with open(_jfp, 'w') as _jf:
            json.dump(_sidecar, _jf)
    except Exception as _je:
        print(f"[IBEX-ENGINE ERROR] Sidecar write fail {{{target_var}}}: {{{{_je}}}}")

    # Export STL
    try:
        if hasattr(bpy.ops.wm, 'stl_export'):
            bpy.ops.wm.stl_export(filepath=_fp, export_selected_objects=True, global_scale=1.0)
        else:
            bpy.ops.export_mesh.stl(filepath=_fp, use_selection=True, global_scale=1.0, use_scene_unit=False, ascii=False, use_mesh_modifiers=True)
        print(f"[IBEX-ENGINE] Esportato: {{{target_var}}}")
    except Exception as _ee:
        print(f"[IBEX-ENGINE ERROR] Export fail {{{target_var}}}: {{{{_ee}}}}")

    bpy.data.objects.remove(_clone, do_unlink=True)
"""

    def _generate_export_all(self):
        """
        BAKE_PROJECT: esporta TUTTE le mesh di scena (invariante 17).
        Scopre gli oggetti al runtime via bpy.data.objects → include anche
        mesh mai toccate da alcun tool (altrimenti perse: Bug C).
        """
        export_body = self._export_single_mesh_code(obj_var='_obj', target_var='_obj.name')
        return f"""
# [IBEX-ENGINE] EXPORT ALL MESHES (Anti-Frankenstein 3.0)
print("[IBEX-ENGINE] Avvio export TOTALE della scena...")
_mesh_objects = [obj for obj in bpy.data.objects if obj.type == 'MESH']
print(f"[IBEX-ENGINE] Oggetti mesh trovati: {{len(_mesh_objects)}}")
for _obj in _mesh_objects:
    print(f"[IBEX-ENGINE] Esporto mesh: {{_obj.name}}")
{export_body}
print(f"[IBEX-ENGINE] Export totale completato: {{len(_mesh_objects)}} mesh.")
"""

    def _generate_export(self, active_targets):
        """
        PREVIEW_BAKE: esporta solo i target della queue (veloce).
        Usa lo stesso _export_single_mesh_code di _generate_export_all.
        """
        script = ""
        for target in active_targets:
            safe_lit = repr(target)  # C1: literal Python sicuro (era _tgt_file = '{target}', iniettabile)
            export_body = self._export_single_mesh_code(obj_var='_tgt_obj', target_var='_tgt_file')
            script += f"""
_tgt_file = {safe_lit}
_tgt_name = os.path.splitext(_tgt_file)[0]
_tgt_obj = bpy.data.objects.get(_tgt_name) or bpy.data.objects.get(_tgt_file)
if _tgt_obj:
    print(f"[IBEX-ENGINE] Preview export: {{_tgt_name}}")
{export_body}
else:
    print(f"[IBEX-ENGINE ERROR] Oggetto non trovato in scena: {{_tgt_file}} (cercato: {{_tgt_name}})")
"""
        return script
