# Creating a new tool

**English** · [Italiano](creating-tools.it.md) · [Back to the README](../README.md)

In IBEX every node of the graph is a **tool**. This guide explains how a tool travels from the palette to the worker and back, what contracts it has to respect, and how to add a new one. Every statement refers to files in this repository.

> The code templates in this guide are **derived** from existing tools (mainly *Slice*). They follow the real contracts, but they have not been compiled or run as they are written here.

## Contents

1. [Two kinds of tools](#1-two-kinds-of-tools)
2. [The path of a tool, layer by layer](#2-the-path-of-a-tool-layer-by-layer)
3. [Defining a node: `gn_meta.json`](#3-defining-a-node-gn_metajson)
4. [The worker contract](#4-the-worker-contract)
5. [Step by step: a tool computed in the worker](#5-step-by-step-a-tool-computed-in-the-worker)
6. [Templates](#6-templates)
7. [A tool computed in the browser](#7-a-tool-computed-in-the-browser)
8. [Optional: inspector, custom node, cache](#8-optional-inspector-custom-node-cache)
9. [Deploying the change](#9-deploying-the-change)
10. [Pitfalls](#10-pitfalls)
11. [Debugging](#11-debugging)

---

## 1. Two kinds of tools

All tools in this release run in **Tier 1**, the fast path: the worker executes them **in-process**, as Python code running inside Blender. That means `bpy` and `bmesh` are available, together with trimesh, PyMeshLab, Open3D, Shapely, SciPy and scikit-image.

There are two ways to build a tool on top of Tier 1.

| Kind | Where the result is computed | Examples |
|---|---|---|
| **Worker tool** | In the worker, at every change of the graph | Slice, Mesh cleaner, Model generator, Arch detect |
| **Browser ("destructive") tool** | In the browser, interactively; the result is uploaded as a *snapshot*, which the worker then uses in place of the input | Sculpt, Delete topology, Draw curve, Edit curve |

A third tier ("Tier 2", Blender scripts generated on the fly and run in a subprocess) still exists in the code, but no tool uses it, and its registry is empty. **A new tool belongs in Tier 1.**

---

## 2. The path of a tool, layer by layer

From the moment a user drags a tool from the palette to the moment the preview updates, a tool touches these layers.

| # | Layer | File | What it does with the tool |
|---|---|---|---|
| 1 | **Palette** | `assets/tools_catalog.csv` | One line per tool: it appears in the palette, grouped by category |
| 2 | **Node definition** | `assets/logic_gn/gn_meta.json` | Ports, parameters, execution mode, flags |
| 3 | **Node builder** | `www/js/ibex/modules/NodeBuilder.js` | Builds the node in the graph: generic template, or a dedicated one from `NODE_SPECS` |
| 4 | **Inspector** | `www/js/ibex/modules/ContextInspector.js`, `inspectors/` | Generic controls from the parameters, or a dedicated section |
| 5 | **Graph flattening** | `www/js/ibex/modules/ToolExecutor.js` | Turns the graph into an ordered queue of steps, and injects what the browser knows (matrices, snapshots, curves) |
| 6 | **Bake request** | `www/js/ibex/modules/BakeEngine.js` | Debounces the changes and sends the queue to the server |
| 7 | **Validation** | `www/Http/Controllers/EditorController.php` (`_validateQueue`) | Checks every step against strict patterns, then queues the task in Redis |
| 8 | **Worker dispatch** | `worker/worker.py`, `worker/modules/tier1_orchestrator.py` | Picks the handler of the tool from the `DISPATCH` table |
| 9 | **Handler** | `worker/modules/tier1_handlers.py` | Adapts the worker to the tool's logic module |
| 10 | **Logic** | `assets/logic_py/<tool>.py` | The actual geometry |
| 11 | **Result** | `worker/worker.py` | STL → Draco preview → atomic swap → the browser is notified |

For a new worker tool, the layers you touch are **1, 2, 8, 9 and 10**. The others pick up the tool by themselves.

---

## 3. Defining a node: `gn_meta.json`

`assets/logic_gn/gn_meta.json` contains one entry per tool, under its slug. The browser downloads it once (`?action=get_gn_meta`).

```json
"slice": {
  "tech_type": "FAST",
  "inputs": {
    "IN_GEO_Mesh":    { "type": "NodeSocketGeometry", "is_port": true },
    "G1_Origine_VEC": { "type": "vector",   "default": [0, 0, 0], "step": 0.5 },
    "G2_Normale_VEC": { "type": "vector",   "default": [0, 0, 1], "step": 0.1 },
    "G3_Cap":         { "type": "checkbox", "default": true }
  },
  "outputs": { "OUT_GEO_Mesh": { "type": "NodeSocketGeometry", "is_port": true } },
  "display_name": "Slice"
}
```

(The real entry may contain more fields; this is the shape that matters.)

### Fields of the entry

| Field | Meaning |
|---|---|
| `tech_type` | **Must be `"FAST"`.** It is what makes the node Tier 1. Any other value sends it to Tier 2, which is empty, and the bake fails |
| `inputs` | Ports (`IN_…`, with `"is_port": true`) and parameters (`G<n>_…`) |
| `outputs` | Output ports (`OUT_…`) |
| `display_name` | Title of the node |
| `destructive` | `true` for browser tools: the node keeps its own snapshot |
| `no_backend` | `true` for nodes that the worker must never see (like *Burn*) |
| `description` | Optional description |

A `tier` field appears on some entries, but **it is not read**: the tier comes only from `tech_type`.

### Ports and their types

The type of a port is encoded in the **prefix of its name**. The browser reads the prefix to decide what to pass to the worker, and colors the port accordingly. There is no compatibility check between ports, so connections are the user's responsibility.

| Prefix | Type | Color | What the worker receives |
|---|---|---|---|
| `IN_GEO_` / `OUT_GEO_` | Geometry (`NodeSocketGeometry`) | green | the name of the mesh |
| `IN_MTX_` / `OUT_MTX_` | Matrix (`NodeSocketMatrix`) | amber | a 4×4 matrix, 16 numbers |
| `IN_CRV_` / `OUT_CRV_` | Curve (`NodeSocketCurve`) | blue | the name of a `.crv.json` file, in `_curve_input_file_rel` |
| `IN_VEC_` | Vector | amber | a vector |

### Parameters

A parameter's name follows the pattern **`G<n>_<Name>[_SUFFIX]`**:

- **`G<n>`** groups the parameters in the panel (G1, G2, …);
- **`<Name>`** becomes the label: the panel builds it from the key itself, removing `G<n>_` and the suffix. The `label` field of the definition is **not** used by the node's panel;
- **the suffix** chooses the widget.

| Suffix | Widget |
|---|---|
| `_POS`, `_ROT`, `_SCL` | vector (position, rotation in degrees, scale) |
| `_INT`, `_PCT` | number |
| `_VIS` | switch |
| `_COL` | color |
| `_MAT`, `_MENU` | select |

The `type` field accepts `vector`, `slider`, `checkbox`, `color`, `segmented` (with `options`) and `select_obj`. The other fields are `default`, `min`, `max`, `step`, `hidden` and `readonly`. `min` and `max` are used by the inspector; without them its range is ±1000.

**Initial value:** `default`, or else 1 for `_SCL` and 0 for everything else. The browser always sends the initial value to the worker. Your Python module should still use the same default, so that the two never disagree.

---

## 4. The worker contract

### The handler: `_apply_<tool>(ctx) -> ToolResult`

Every handler receives a single `ToolContext` and returns a `ToolResult` (both defined in `worker/modules/fast_transform.py`).

**`ToolContext`**

| Field | Content |
|---|---|
| `src_path` | path of the input STL, already resolved |
| `params` | the node's parameters, plus the values injected by the browser. **Read-only:** copy it with `dict(ctx.params)` before changing anything |
| `output_dir` | where outputs must be written. It is always different from `active_path` |
| `target` | name of the mesh (for example `Upper.stl`) |
| `active_path` | the project's working copy, for side files (curves, selections, snapshots) |
| `tool` | the tool's slug |
| `logger` | logging function |
| `mesh_cache` | internal: **do not touch it** |

The node id is not a field of the context: if you need it, read `params['_snapshot_node_id']`.

**`ToolResult(success, outputs)`**

| Result | Meaning |
|---|---|
| `ToolResult(True, [(target, path, None)])` | success; `None` tells the caller that the topology changed, and invalidates the cache |
| `ToolResult(True, [(target, path, mesh)])` | success with the mesh in memory: **only** for rigid transformations |
| `ToolResult(True, [])` | the node is **inert** (nothing to do): the pipeline goes on |
| `ToolResult(False, [])` | error: the bake stops, and the previous preview stays |

### The logic module: `apply(src_path, params, output_path, logger) -> bool`

The geometry lives in `assets/logic_py/<tool>.py`, which exposes a single function.

- **It receives:**
  - the path of the input STL;
  - the parameters: the keys of `gn_meta.json`, plus values injected by the browser such as `world_matrix`, `_muted` and `_snapshot_node_id`;
  - the output path;
  - the logging function.
- **It must write a binary STL** to `output_path` and return `True`, or return `False` on failure.
- **It reports errors** with `logger("[…] [IBEX-ENGINE ERROR] …")` followed by `return False`. Exceptions are caught by the handler.

The handler loads the module **at every call** (with `importlib`), so changes to `logic_py` take effect at the next bake. `assets/logic_py/` is on the worker's import path, so a module can use the shared geometry library: `from ibex_primitives.<module> import …`.

Some existing modules have a different signature, which their own handler adapts: for example `arch_detect` (keyword arguments), `topology_rebuild.apply(src, sel, out, log)` and `split_topology_via_curves.apply(src, crv, a, b, log)`. For a new tool, use the standard one.

---

## 5. Step by step: a tool computed in the worker

Example: a tool with slug `my_tool`, one mesh in and one mesh out, and its parameters in the generic panel.

1. **Write the logic** in `assets/logic_py/my_tool.py` (template in [§6](#6-templates)).
2. **Write the handler** `_apply_my_tool(ctx)` in `worker/modules/tier1_handlers.py`, modelled on `_apply_slice`.
3. **Register the tool in the worker:**
   - add `'my_tool'` to `TIER1_TOOLS` in `worker/modules/config.py`;
   - import the handler and add it to `DISPATCH` in `worker/modules/tier1_orchestrator.py`.

   The two must always contain the same tools: `set(DISPATCH) == set(TIER1_TOOLS)`.
4. **Define the node:** an entry `"my_tool"` in `assets/logic_gn/gn_meta.json`, with `"tech_type": "FAST"`, the ports and the parameters.
5. **Add it to the palette:** a line in `assets/tools_catalog.csv`. The separator is `;`, and the columns are `slug;display_name;tech_type;source_file;category;params_json`:

   ```
   my_tool;My Tool;FAST;my_tool.py;Modifica;{}
   ```

   The category groups the tool in the palette. `tech_type` and `source_file` are only shown in the palette; they do not decide where the tool runs.
6. **Restart the workers** (see [§9](#9-deploying-the-change)).

Nothing has to change in `ToolExecutor`, `BakeEngine` or `EditorController`, as long as the slug contains only letters, digits, `_` and `-`.

---

## 6. Templates

### `assets/logic_py/my_tool.py`

```python
import trimesh

def apply(src_path, params, output_path, logger):
    try:
        mesh = trimesh.load(src_path, force='mesh', process=False)
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] my_tool: cannot load '{src_path}': {e}")
        return False

    value = float(params.get('G1_Value_INT', 1))   # same key and default as gn_meta.json

    # … process the mesh …

    try:
        with open(output_path, 'wb') as f:
            f.write(mesh.export(file_type='stl'))   # binary STL
    except Exception as e:
        logger(f"[FAST] [IBEX-ENGINE ERROR] my_tool: export failed: {e}")
        return False
    return True
```

### Handler in `worker/modules/tier1_handlers.py`

```python
def _apply_my_tool(ctx):
    out_path = os.path.join(ctx.output_dir, ctx.target)
    try:
        import importlib.util
        from .config import LOGIC_PY_DIR
        spec = importlib.util.spec_from_file_location(
            "ibex_my_tool", os.path.join(LOGIC_PY_DIR, "my_tool.py"))
        if spec is None or spec.loader is None:
            ctx.logger(f"[APPLY] [IBEX-ENGINE ERROR] my_tool.py cannot be loaded from {LOGIC_PY_DIR}")
            return ToolResult(False, [])
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if not mod.apply(ctx.src_path, ctx.params, out_path, ctx.logger):
            return ToolResult(False, [])
        return ToolResult(True, [(ctx.target, out_path, None)])   # None: topology changed
    except Exception as e:
        ctx.logger(f"[APPLY] [IBEX-ENGINE ERROR] my_tool failed: {e}")
        return ToolResult(False, [])
```

### Entry in `assets/logic_gn/gn_meta.json`

```json
"my_tool": {
  "tech_type": "FAST",
  "inputs": {
    "IN_GEO_Mesh":  { "type": "NodeSocketGeometry", "is_port": true },
    "G1_Value_INT": { "type": "slider", "min": 0, "max": 10, "step": 1, "default": 1 }
  },
  "outputs": { "OUT_GEO_Mesh": { "type": "NodeSocketGeometry", "is_port": true } },
  "display_name": "My Tool"
}
```

---

## 7. A tool computed in the browser

A browser tool lets the user work interactively — sculpting, selecting, drawing — and then **persists** the result on the server. The worker uses it as a pass-through.

How the existing ones work:

1. The node is declared with `"destructive": true` in `gn_meta.json`. The browser then attaches its node id to the step (`_snapshot_node_id`).
2. A browser mode (for example `CurveMode.js`, `SculptMode.js`, `SelectionMode.js`) does the interactive work.
3. When the user leaves the mode, the browser uploads the result with `POST ?action=save_snapshot`:
   - `stl_blob`: the mesh, mandatory;
   - `curve_blob`: a curve, up to 5 MB, in the form `{"splines":[{"control_points":[[x,y,z],…],"cyclic":bool}]}`, in the mesh's local coordinates;
   - `selection_blob`: a selection, up to 10 MB, in the form `{"face_indices":[…]}`.

   A tool that produces two meshes uses `save_split` instead.
4. The worker stores the files as `<mesh>_snap_<nodeId>.stl` (and `.crv.json`, `.sel.json`).
5. At every bake, the step of the node carries its `_snapshot_node_id`. Nodes downstream connected to a curve port receive the name of the curve file in `_curve_input_file_rel`.
6. When the project is saved and closed, the snapshots of nodes that no longer exist are deleted.

To add one, besides what [§5](#5-step-by-step-a-tool-computed-in-the-worker) describes:
- set `"destructive": true` in `gn_meta.json`;
- add the slug to `DESTRUCTIVE_TOOLS` in `worker/modules/config.py` **and** to `DESTRUCTIVE_TOOL_IDS` in `www/js/ibex/modules/StackManager.js`;
- write the browser mode that calls `save_snapshot`.

If the worker only has to use the snapshot in place of the input, no dedicated handler is needed: destructive tools without one are routed to the generic `_apply_snapshot`.

---

## 8. Optional: inspector, custom node, cache

### A dedicated inspector section

By default, the inspector shows controls generated from the parameters, plus a *Bypass* switch. For custom controls:
- write a module `www/js/ibex/modules/inspectors/my_tool.js` that exports `{ build, bind }`;
- register it in `INSPECTORS` and in `BIND_ORDER` in `ContextInspector.js`;
- update the `?v=` version of the `ContextInspector` import in `IbexCore.js` (see [§9](#9-deploying-the-change)).

The arch detection inspector is a good example of parameters that live only in the inspector: keys that begin with `_`, stored in the node's parameters (`inspectors/archDetect.js`).

### A dedicated node template

Nodes with buttons or a special layout are defined in the `NODE_SPECS` registry of `NodeBuilder.js`. The rule written above the registry: **only data, no functions**.

A tool in `NODE_SPECS` does **not** become loadable from a preset automatically: `addToolFromPreset` has an explicit list, which must be extended.

### Result cache

For an expensive tool with a **single output**, add its slug to `CACHEABLE_TOOLS` in `worker/modules/pipeline_cache.py`. An unchanged node is then served from the cache (`.cache_pipeline/` in the working copy). Never enable it for tools with more than one output.

---

## 9. Deploying the change

- **`assets/logic_py/`** is reloaded at every call: the next bake uses the new code.
- **`worker/modules/`** (`config.py`, `tier1_handlers.py`, `tier1_orchestrator.py`, …) is loaded when the worker starts. **Restart the workers**, for example with `docker compose restart ibex-worker-1 … ibex-worker-6`. If in doubt, delete the `__pycache__/` folders.
- **`gn_meta.json` and `tools_catalog.csv`** are read when the editor is opened: reload the page.
- **JavaScript modules** are imported with a fixed version string (`?v=…`). If you change a module, you must also change its `?v=` **in the module that imports it**, all the way up the chain. Otherwise the browser keeps serving the old version from its cache. The same URL must be used everywhere a module is imported: two different URLs create two separate instances of the same module.

---

## 10. Pitfalls

1. **Missing registration.** A tool that is not in both `TIER1_TOOLS` and `DISPATCH` makes the bake fail ("tool non Tier 1 nella queue"). This is deliberate: an unknown tool must fail loudly, never be silently skipped.
2. **`tech_type` different from `"FAST"`** sends the node to Tier 2, which is empty: the bake fails.
3. **Names.** A tool slug may only contain letters, digits, `_` and `-`. Node ids are validated in three places that must stay aligned: `NODE_ID_RX` in `worker/modules/config.py`, the PHP side, and the browser.
4. **`ctx.params` is read-only.** Copy it before changing it.
5. **`mesh_cache` belongs to the worker.** A handler must neither write it nor clear it. If the topology changes, return `None` as the mesh.
6. **Inert is not an error.** `ToolResult(True, [])` = nothing to do; `ToolResult(False, [])` = error. Do not invent a third state.
7. **`world_matrix` reaches every Tier 1 step**, but only *Transform* and *Copy transform* apply it. Do not add a tool to the "matrix" list without actually applying the matrix: the mesh would drift.
8. **Renamed tools.** `_TOOL_RENAME` in `worker/modules/config.py` is the only map from old names to new ones, applied when the queue arrives; the browser mirrors it in `_migrateLegacyToolIds` (`StackManager.js`).
9. **`NODE_SPECS` is data only**, and it is looked up with `Object.hasOwn`, so that a slug like `constructor` cannot match a built-in property.
10. **Version strings** (`?v=`) must change in the importing module, otherwise the browser serves the old code.
11. **The result cache** is only for tools with a single output.
12. **New write actions in the PHP router** must be added to `$IBEX_CSRF_GATED` in `www/index.php`. The comment there says it plainly: that list *is* the security.
13. **Output format:** binary STL, never ASCII.
14. **Where to write:** the main output always goes in `ctx.output_dir`, never in `active_path`. Side files (curves, selections, snapshots) belong in `active_path`.

---

## 11. Debugging

- **Worker logs.** Every tool logs through `logger`, and errors carry the marker `[IBEX-ENGINE ERROR]`. Read them with `docker logs ibex-worker-N`.
- **In the editor**, a failed step stops the bake, shows the error as a notification and keeps the previous preview.
- **A node that does nothing** is usually inert on purpose (for example a split with neither a selection nor a curve): nodes downstream may then fail because their input file does not exist.
- **To test the logic alone**, call `apply()` from a Python shell inside a worker container, with an STL and a dictionary of parameters. The module does not depend on Redis or on the rest of the worker.
