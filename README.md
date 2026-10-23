# IBEX

**English** · [Italiano](README.it.md)

IBEX is an **experimental dental CAD that runs in the browser**, built around a **procedural node graph**.

You do not edit a mesh step by step. You build a graph of operations in the browser — transform, sculpt, clean, cut, detect the arch, generate a model base — and the server computes it and streams the result back into the 3D viewport. Every step stays editable: change a parameter, or a node in the middle of the chain, and the graph is recomputed from there. When the result is ready, a dedicated node delivers the final mesh into the user's cloud folder.

It is designed for the dental field as a whole: anyone working in the sector can use it. It was being prepared for a closed beta. This repository is a **sanitized reference release**: the identity of the original installation, credentials and infrastructure details have been removed, and everything that identifies an installation is now configuration.

> **Not a medical device.** IBEX is not certified software and has not been validated for clinical use. Whoever uses it to design or manufacture custom-made dental devices remains fully responsible for verifying every result.

## Contents

- [Graph, bake, burn](#graph-bake-burn)
- [Nodes](#nodes)
- [Working in the editor](#working-in-the-editor)
- [How a computation runs](#how-a-computation-runs)
- [Projects, saving and cleanup](#projects-saving-and-cleanup)
- [Architecture](#architecture)
- [Security](#security)
- [Installation](#installation)
- [Using it without Nextcloud](#using-it-without-nextcloud)
- [Extending IBEX: creating new tools](#extending-ibex-creating-new-tools)
- [HTTP API](#http-api)
- [Known limitations](#known-limitations)
- [How this release was prepared](#how-this-release-was-prepared)
- [Author](#author) · [License](#license)

---

## Graph, bake, burn

Three words describe the whole workflow.

- **Graph.** In a node editor next to the viewport, the user chains nodes. Each node has input and output ports (meshes, curves, transformation matrices) and its own parameters. Nodes are picked from a searchable palette, grouped by category.
- **Bake.** Every change to the graph — a parameter, a new connection, a removed node — triggers a recomputation on the server, after a short pause (500 ms) so that dragging a slider does not flood the queue. A pool of workers computes the graph and sends back a compressed preview. Heavy geometry never runs on the user's device, which is what makes IBEX usable on a tablet.
- **Burn.** When the result is right, the *Burn* node delivers the final mesh — STL, OBJ or PLY — into a folder of the user's choice in their cloud space, where it immediately appears among their files. Bake is continuous computation; burn is the one-off delivery.

---

## Nodes

This release includes thirteen nodes.

| Node | Category | What it does |
|---|---|---|
| **Transform** | Edit | Moves and rotates a mesh. Exposes its transformation on a matrix port that other nodes can reuse. |
| **Copy transform** | Edit | Applies to a mesh the transformation of another node (a "parent"), following the whole chain of parents. |
| **Sculpt** | Edit | Interactive sculpting in the browser, with dynamic topology (a modified port of SculptGL). |
| **Mesh cleaner** | Edit | Cleans a scan with PyMeshLab: removes defects, smooths the band along the open border, repairs non-manifold geometry, closes holes, and decimates very dense meshes (above 200,000 faces, down to about 150,000). |
| **Delete topology** | Edit | Deletes the faces the user selects. |
| **Split topology** | Edit | Splits a mesh in two (outputs A and B): either by selection, or along a closed curve, with a geodesic cut that follows the surface. |
| **Rebuild topology** | Edit | Works on a selected region: with one open border it closes the hole; with two separate borders it bridges them. |
| **Draw curve** | Edit | Draws spline curves on the surface of the mesh, for use by other nodes. |
| **Arch detect** | Detect | Finds the crest of the dental arch automatically, on both dentate and edentulous models, and classifies it against standard arch forms. The result is a curve. |
| **Edit curve** | Detect | Edits an existing curve: drag control points (snapped to the surface), insert or remove points, add splines, open or close them, invert their direction. |
| **Model generator** | Edit | Generates the base of a dental model: extrudes the open border of the scan downwards and cuts it flat; with a wall thickness above zero it makes the model hollow. |
| **Slice** | Edit | Cuts a mesh with a plane (origin and normal) and optionally caps the cut. |
| **Burn** | Output | Delivers the final mesh into the user's cloud folder. |

### Parameters worth knowing

- **Mesh cleaner:** width of the border band (rings), smoothing iterations, maximum hole size, and an option for curvature-aware patches (slower, about 18 s).
- **Arch detect:** height offset of the curve (0–15 mm), smoothness, extension of the ends, and the reference arch form — automatic, or one of the standard families (Europa, TrueForm, standard, Bioform 1–5).
- **Model generator:** depth of the base (5–50 mm), margin (0–5 mm), wall thickness (2–4 mm).
- **Slice:** origin and normal of the plane, cap on or off.

### Where each node computes

- **On the server** (Transform, Copy transform, Mesh cleaner, Arch detect, Model generator, Slice, and Split topology when cutting along a curve): the worker computes the node every time the graph changes.
- **In the browser, then saved on the server** (Sculpt, Delete topology, Split topology by selection, Draw curve, Edit curve; Rebuild topology for the selection): the user works interactively, and when they leave the mode the result is uploaded as a *snapshot* of that node. From then on the server uses the snapshot, and the nodes downstream are recomputed as usual.
- **Burn** does not use the workers: the web application copies the computed file directly.

The expensive nodes (Mesh cleaner, Model generator) keep a cache of their result, so an unchanged node is not recomputed.

---

## Working in the editor

### Sculpting

Brushes: **Inflate** and **Crease** (each with + and − direction), **Smooth**, **Flatten**, **Simplify**. Falloff: smooth, sharp or cylinder. Radius and strength sliders, a **lazy** stroke with its own radius, and **dynamic topology**: the mesh is refined or simplified under the brush, with an adjustable level of detail and a *Flood* command that applies it to the whole mesh. A clay-like material makes the surface easy to read while sculpting.

### Selecting

Three modes — **circle** (a 3D sphere, painted continuously), **box** and **lasso**. Selections accumulate: Shift adds, Ctrl/⌘ removes. An **X-ray** switch includes the faces on the back side. A selection is used to delete faces, to split a mesh in two, or to rebuild a region.

### Curves

Curves are drawn on the surface (*Draw curve*), detected automatically (*Arch detect*) and refined (*Edit curve*). Today they drive the geodesic cut of *Split topology*, which needs a closed curve.

### Presets

A selection of nodes can be saved as a **preset** and reused in other projects. Private presets live in the user's cloud folder; public presets form a pool shared by all users, and only administrators can publish or delete them.

### Import and export

- **Import:** STL files only, up to 20 at a time, picked from the user's cloud folders. An imported file never overwrites an existing mesh: on a name clash it is renamed.
- **Export:** through the *Burn* node, in STL, OBJ or PLY. OBJ export has a ceiling on the number of triangles, computed from the memory and time limits of PHP; STL and PLY have none.

### Panels and viewport

- **Graph** (DAG) with the node palette, searchable and grouped by category.
- **Outliner** of the meshes in the scene: visibility, rename, isolate.
- **Inspector:** properties of the selected mesh, shading (flat, smooth, orientation), the chain of nodes that act on it, with a **bypass** switch on each node, and the dedicated controls of the selected node.
- **Viewport:** fit to view, four preset views (top, front, side, ¾), a **section box**, saved views (stored with the project), grid, axes, the original colors of the scan on or off, light and dark theme.
- **Undo and redo** of the graph.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| ⌘/Ctrl + S | Save |
| ⌘/Ctrl + Z | Undo |
| ⇧⌘Z, ⌘/Ctrl + Y | Redo |
| ⌘/Ctrl + C / V | Copy / paste nodes |
| M | Bypass the selected node |
| Delete / Backspace | Delete the selected nodes |
| I | Isolate the selected mesh |
| F | Fit everything in view |
| Alt + B | Section box |

---

## How a computation runs

1. **The browser sends the graph.** It sorts the nodes topologically, drops the ones that have nothing to compute, and sends a queue of steps. Each step carries its tool, target mesh and parameters, plus what the browser already knows: transformation matrices, the names of snapshots and curves.
2. **The web application checks it and queues it.** It validates every step against strict patterns, checks that the user owns the project, and puts the task on a Redis queue.
3. **Only the latest request counts.** Every request has an increasing id. A worker discards a task that is older than one already computed for the same project, so a burst of edits produces one computation, not a backlog.
4. **One project, one worker at a time.** A worker takes a per-project lock before computing; workers that die release their locks through a periodic check.
5. **One mesh in the same process, several meshes in parallel.** With one mesh, the worker runs the queue itself. With several, it becomes a coordinator: it splits the work into one sub-task per mesh on a priority queue, which the other workers pick up, and forwards each result as soon as it is ready.
6. **The result is delivered atomically.** The computed meshes are compressed with Draco and swapped into the preview in one step, so the browser never sees a half-written result. If a node fails, the previous preview stays.
7. **The browser waits with long polling** and loads each mesh as it arrives. Too many requests (HTTP 429) are retried with increasing pauses; a computation that takes too long shows a warning without blocking the editor.

---

## Projects, saving and cleanup

### The `.ibex` archive

A project is a single file in the user's cloud folder (`IBEX/name.ibex`), encrypted with **AES-256-GCM** and two separate keys:

- the **archive key** encrypts the project itself (meshes, graph, curves, caches). Only the workers know it;
- the **thumbnail key** encrypts the preview image and the burn record. The web application knows it too, so it can show previews in the project list.

If the web-facing container were compromised, it would expose the thumbnails — never the projects. The header also carries the project id and a digest of the saved session, readable without decrypting anything: this is what allows the cleanup described below to verify a save.

### Saving

- **Autosave**, every 15 seconds, saves the session (graph, parameters, views) in the project's working copy on the server, only when something has changed.
- The encrypted archive is rewritten when the user **leaves the project** (save and exit, or closing the tab), and when they **rename** it. A failed write never replaces the previous archive.
- **Close without saving** discards the working copy and leaves the archive untouched.
- Opening a project that is not in use extracts the archive first (a loading page is shown); a project already open elsewhere opens immediately.

### Cleanup of clinical data

While a project is open, a decrypted working copy exists on the server. A cleanup process removes it only when it is **certain** that everything is saved:

- the digest of the working copy must match the digest stored in the archive header;
- no task for that project may be waiting in the queue;
- the project must have been idle for 15 minutes.

Working copies of projects deleted from the cloud are removed as well. Leftover temporary files are removed after one hour.

---

## Architecture

```
browser — editor (Drawflow + three.js), usually inside a Nextcloud iframe
   │  HTTPS
   ▼
ibex-app — nginx + PHP-FPM, plain PHP front controller (no framework)
   │  task queues
   ▼
ibex-redis — queues, sessions, project registry, file tokens (not persistent)
   │
   ▼
ibex-worker × 6 — Blender 4.5 headless + Python geometry stack
```

| Component | Role | Code |
|---|---|---|
| Editor | Graph, viewport, sculpting, selection, curves | `www/Views/projects/editor/`, `www/js/ibex/modules/`, `www/js/ibex/sculptgl/` |
| Web application | API, validation, authentication, burn | `www/index.php`, `www/Http/`, `www/Core/` |
| Workers | Computation of the graph, archives, imports | `worker/worker.py`, `worker/modules/` |
| Node logic | One Python module per tool, plus a geometry library | `assets/logic_py/`, `assets/logic_py/ibex_primitives/` |
| Node definitions | Ports and parameters; the palette | `assets/logic_gn/gn_meta.json`, `assets/tools_catalog.csv` |

- The workers run **inside Blender** in headless mode, so every module can use `bpy` and `bmesh`, together with trimesh, PyMeshLab, Open3D, Shapely, SciPy and scikit-image.
- **Redis is deliberately not persistent:** the authoritative state lives in the archives.
- **Data:** the decrypted working copy (`active/<user>/<project>/`) on the server; the encrypted archives in each user's cloud folder.
- **Database:** IBEX has no tables of its own. It only reads and writes four Nextcloud tables (`oc_filecache`, `oc_storages`, `oc_mimetypes`, `oc_group_user`).

---

## Security

- **Sign-in.** Users arrive from Nextcloud with a token signed in ES256, verified against a configured public key. Without the key, nobody can sign in. Mesh downloads use a short-lived file token (one hour).
- **Fail-closed configuration.** If the Nextcloud address is not set, IBEX sends no CORS headers, can only be framed by itself, sends no messages to other pages and accepts none.
- **Cross-site requests.** Every action that changes state requires the request to come from IBEX's own origin.
- **Messages between pages.** The editor talks to the Nextcloud page that frames it only with the configured origin, in both directions.
- **Strict input validation** of tool names, mesh names, node ids, project names and uploaded files (types and maximum sizes).
- **Encryption at rest** with two separate keys (see above).
- **Unprivileged workers:** non-root user, all Linux capabilities dropped, `no-new-privileges`, a memory cap per worker.
- **A health endpoint** that checks database and Redis without credentials, with its own rate limit.

---

## Installation

> IBEX is not a standalone application: it expects a Nextcloud instance and a Nextcloud app — the project lobby, `ibex_workspace` — that is **not part of this release**. This release is meant first of all to be **read and studied**; running it end to end requires rebuilding that environment.

### Requirements

- Docker with Docker Compose.
- Nextcloud with the **External Sites** app, which opens IBEX and signs the token users arrive with.
- A Nextcloud group named **`Amministrazione`**: its members (and the user `admin`) can publish shared presets. The name is currently fixed in the code (`www/Core/UserContext.php`).

### Steps

```bash
cp .env.example .env          # fill it in: see the comments in the file
openssl rand -base64 32       # run twice: IBEX_ARCHIVE_KEY and IBEX_THUMB_KEY
docker compose build ibex-worker-1
docker compose up -d
```

- **Two encryption keys**, 32 random bytes in base64 each. If you lose `IBEX_ARCHIVE_KEY`, existing archives can no longer be opened.
- **`NEXTCLOUD_URL`** is the address of the Nextcloud instance that frames IBEX.
- **`NEXTCLOUD_SSO_PUBKEY_B64`** is the public key of the *External Sites* app, PEM encoded in base64 on one line (`base64 -w0 key.pem`). If it is empty, nobody can sign in.
- **`IBEX_REDIS_PASS` is mandatory**: Redis will not start without it.
- **Reaching the app.** `ibex-app` publishes no ports. Connect it to your reverse proxy's network, or add a port mapping (see the comments at the end of `docker-compose.yml`).
- **Database user.** It only needs permissions on the four Nextcloud tables listed above.

---

## Using it without Nextcloud

The graph, the bake, the workers and the archive format do not depend on Nextcloud. The coupling is concentrated in five points.

1. **Sign-in.** `www/Http/Middleware/NextcloudAuthBridge.php` accepts only the signed token of *External Sites*. Any identity provider that issues an ES256 token with the user id in `userdata.uid` can replace it; so can a different authentication method.
2. **Administrator role.** `www/Core/UserContext.php` reads Nextcloud's group table. It only decides who can publish shared presets.
3. **Files.** Archives, burned meshes and private presets are written directly into the user's folder inside the Nextcloud data directory, and registered **by hand** in Nextcloud's file cache (`oc_filecache`). This is the deepest coupling, because it depends on Nextcloud's internal schema. Without Nextcloud, this layer must be replaced with your own storage.
4. **Project lobby.** The project list, creating a project, and the tabs and menus around the editor live in the Nextcloud app `ibex_workspace`, which is not included. Without it, a lobby has to be written; the API it uses is listed below.
5. **Embedding.** The editor is designed to run inside an iframe: the CSP `frame-ancestors` rule and a small message protocol with the host page (close tab, open the file picker, project renamed, editor state, commands). The editor also has its own menu bar for use outside the frame.

This adaptation has **not** been done or tested in this release.

---

## Extending IBEX: creating new tools

Every node is a tool, and adding one does not require touching the core of the bake. A typical server-side tool is:

- a Python module in `assets/logic_py/` with a single function, `apply(src_path, params, output_path, logger)`;
- a short handler in the worker, registered in two lists;
- an entry in `assets/logic_gn/gn_meta.json` (ports and parameters) and a line in `assets/tools_catalog.csv` (palette).

The parameter panel is generated automatically from the node definition.

**→ The complete guide, with the contracts, templates and pitfalls, is in [`docs/creating-tools.md`](docs/creating-tools.md).**

---

## HTTP API

All actions go through `www/index.php?action=…` and require authentication (an open session, a file token, or the signed token from Nextcloud). Actions that change state also require the request to come from IBEX's own origin.

| Action | Purpose |
|---|---|
| `editor` | Opens the editor (`id` or `open_name`) |
| `create_empty_project` | Creates a new empty project (POST only) |
| `rename_project` | Renames a project (and saves it) |
| `fast_transform`, `preview_bake` | Queue a computation |
| `check_preview` | Waits for the result (long polling) |
| `serve_file` | Serves meshes and project files |
| `save_snapshot`, `save_split` | Upload the result of a node computed in the browser |
| `save_session` | Saves the session in the working copy |
| `save_exit` | Saves the archive and leaves |
| `exit_project` | Leaves without saving |
| `heartbeat`, `check_status`, `projects_status` | Presence and state of projects |
| `list_nextcloud_dirs`, `import_files` | Browse cloud folders, import STL files |
| `export_node_stl` | Burn: delivers the final mesh |
| `save_preset`, `list_presets`, `load_preset`, `delete_preset` | Presets |
| `thumb` | Thumbnail of a project |
| `get_gn_meta` | Node definitions |
| `bake_project` | Full computation into a separate folder (not reachable from the interface) |

`/health.php` is outside the router: it is public and rate-limited.

---

## Known limitations

- **Experimental software.** IBEX was being prepared for a closed beta and was never used for clinical production.
- **No end-to-end verification.** There is no automated test suite: the only test is `worker/scripts/_test_ibx2_passob.py`, for the archive format. The save model was redesigned several times during development and has no end-to-end baseline.
- **The geometric computation was not re-run for this release.** The workers need Blender and the full environment; the release was verified on everything that can run without them (see below).
- **Coupling with Nextcloud's internal schema** (`oc_filecache`): a different version of Nextcloud may require changes.
- **The lobby is not included** (see [Installation](#installation)). Some shortcuts shown in the menus (⌘B, ⌘N, ⌘/) are handled by the lobby, not by the editor; some menu items (Documentation, Shortcuts, About) are disabled.
- **Inconsistent defaults**, left as they were:
  - *Model generator*: the interface starts the wall thickness at 2.5 mm, the Python module defaults to 0 if the value is missing;
  - *Sculpt*: the default brush radius (2.0) is above the slider's maximum (1.5), and the default brush in the code is not among the buttons;
  - *Arch detect*: three parameters read by the Python module have no control in the interface.
- **Administrator group fixed in the code** (`Amministrazione`).
- **Unused code and dependencies:**
  - an infrastructure for Blender-script tools ("Tier 2") exists but no tool uses it;
  - an icon set (`www/js/ibex/ibex-icons.js`) is not loaded by any page;
  - `libigl`, `manifold3d` and `rtree` are installed in the worker image but not imported; they are kept because the computation could not be re-run to confirm it.
- **External matcap texture.** The sculpt material loads a texture from a third-party repository that declares no license; if it is unreachable, IBEX falls back to a procedural one.
- **Internal references in comments.** Many comments cite numbered invariants (*Inv. N*, *§N*) from a design document that is not published.
- **Italian.** The user interface and the comments are in Italian.

---

## How this release was prepared

Before publication, the code went through the same structured review as the companion project, [Order Manager](https://github.com/ianlor93/dental-order-manager):

- the identity of the original installation, hostnames, personal data, embedded keys and infrastructure paths were removed, and every installation-specific value was moved to configuration;
- dead code and internal documents were removed; dependencies are pinned to the versions that ran in production;
- a message that the editor sent to *any* framing page was restricted to the configured Nextcloud origin.

The final state was checked in clean containers:
- syntax of every PHP, JavaScript, Python and JSON file;
- the configuration layer with valid, empty and malicious values;
- sign-in with the real middleware and a generated key pair: accepted with the right key, rejected with a wrong key, rejected when no key is configured;
- `docker compose config`;
- the pinned dependencies against the worker that was running in production.

---

## Author

Designed and directed by **Lorenzo Ianniello**.

The code was developed with **Claude Code** (Anthropic) under his direction. The requirements, the architecture, the security and data-protection design, and the verification of the result are his work.

---

## License

Released under the **GNU Affero General Public License v3.0 or later** — see [`LICENSE`](LICENSE). If you run a modified version as a network service, the AGPL requires you to make your source code available to its users.

Third-party material (the SculptGL port, the JWT library, the Ubuntu fonts) keeps its own license, and so do the libraries loaded at runtime and the worker's dependencies: see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
