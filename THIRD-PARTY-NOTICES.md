# Avvisi sui componenti di terzi

IBEX è distribuito con licenza AGPL-3.0-or-later (vedi `LICENSE`). Questo file elenca
il materiale di terzi incluso nel repository, quello caricato dal browser a runtime e
le dipendenze esterne, ciascuno con la propria licenza.

## 1. Incluso nel repository

### SculptGL — `www/js/ibex/sculptgl/`
- **Origine:** SculptGL (stephomi), https://github.com/stephomi/sculptgl
- **Licenza:** MIT. Testo in `www/js/ibex/sculptgl/LICENSE`.
- **Modifiche:** porting in moduli ES e adattamento al motore di IBEX (Three.js). Le
  modifiche sono descritte nelle intestazioni dei file.
- Non derivano da SculptGL, e sono codice di IBEX: `IbexBridge.js` (ponte tra
  BufferGeometry di Three.js e `MeshDynamic`) e `IbexMainAdapter.js` (adattatore
  dell'interfaccia `_main` di SculptGL verso IBEX).

### firebase/php-jwt — `www/lib/Firebase/JWT/`
- **Origine:** https://github.com/firebase/php-jwt
- **Licenza:** BSD-3-Clause. Testo in `www/lib/Firebase/JWT/LICENSE`.
- **Modifiche:** namespace riscritto in `OCA\External\Vendor\Firebase\JWT` (lo stesso
  usato dall'app External Sites di Nextcloud).

### Font Ubuntu e Ubuntu Mono — `www/static/fonts/`
- **Origine:** famiglia di caratteri Ubuntu.
- **Licenza:** Ubuntu Font Licence 1.0. Testo in `www/static/fonts/UFL.txt`.
- **File:** `Ubuntu-Regular.ttf`, `Ubuntu-Medium.ttf`, `Ubuntu-Bold.ttf`,
  `UbuntuMono-Regular.ttf`, `UbuntuMono-Bold.ttf`, dichiarati in
  `www/static/css/ibex-fonts.css`.

## 2. Caricato dal browser a runtime (non incluso)

Questi componenti non sono nel repository: il browser li scarica dai CDN indicati,
alle versioni fissate qui sotto.

| Componente | Versione | Licenza | Caricato da | Dove nel codice |
|---|---|---|---|---|
| three.js (con gli addon `examples/jsm/`) | 0.160.0 | MIT | unpkg.com | `www/Views/projects/editor/main.blade.php` (import map) |
| three-mesh-bvh | 0.7.8 | MIT | unpkg.com | `main.blade.php` (import map) |
| gl-matrix | 3.4.3 | MIT | esm.sh | `main.blade.php` (import map) |
| Drawflow | 0.0.60 | MIT | cdn.jsdelivr.net | `main.blade.php` (script e foglio di stile) |
| Decoder Draco (distribuito con three.js 0.160.0) | — | Apache-2.0 | unpkg.com | `www/js/ibex/modules/MeshLoader.js` (`setDecoderPath`) |
| Texture matcap di `nidorx/matcaps` | commit `1b1e43a338335b6401034d48488298966755d717` | non dichiarata | cdn.jsdelivr.net | `www/js/ibex/modules/SculptMode.js` |

**Texture matcap:** il repository `nidorx/matcaps` non dichiara una licenza. La
texture non è inclusa in IBEX e va considerata materiale di terzi. Se non è
raggiungibile, IBEX usa una texture procedurale propria.

## 3. Template d'arcata — `assets/arch_templates.json`

Approssimazioni di forme d'arcata standard, ricalcate da un'immagine di riferimento
non inclusa nel repository (`worker/scripts/extract_archform_templates.py`). I nomi
(es. Europa, TrueForm, Bioform) servono solo a identificare le forme e possono essere
marchi dei rispettivi titolari.

## 4. Dipendenze del worker — `worker/requirements.txt`

Non sono incluse nel repository: vengono installate nell'immagine Docker del worker,
ciascuna con la propria licenza. Da segnalare:

- **Blender:** il worker gira dentro Blender e usa il suo modulo `bpy`
  (GPL-2.0-or-later). L'immagine di base è `blendergrid/blender:4.5`.
- **PyMeshLab:** GPL-3.0.

Entrambe sono compatibili con l'AGPL-3.0-or-later del progetto.

## 5. Immagini Docker usate da `docker-compose.yml`

Non sono incluse nel repository e hanno ciascuna la propria licenza:

- `ghcr.io/linuxserver/nginx` (app web);
- `redis` (coda e cache);
- `blendergrid/blender` (base dell'immagine del worker, vedi `Dockerfile`).
