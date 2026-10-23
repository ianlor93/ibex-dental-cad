import * as THREE from 'three';
// T1Resolve_29-7 — `_resolveTargetMesh` collassato nell'util condiviso (era ×2, byte-identico a SelectionMode).
import { resolveTargetMesh } from './mesh-resolve.js?v=T1Resolve_29-7';

// ═══════════════════════════════════════════════════════════════
// IBEX SculptMode SculptGL_S4_V2.18 — cleanup diag logs cascade
//
// V2.18 (2026-04-27): cascade bump degli import dei 6 brush dopo
//   cleanup dei diag logs in SculptBase (V1.4 → V1.5). Brush V1.3 → V1.4,
//   Smooth V1.3 → V1.4, Flatten V1.3 → V1.4, Inflate V1.3 → V1.4,
//   Crease V1.2 → V1.3, Simplify V1.6 → V1.7. I file brush internamente
//   importano `SculptBase.js?v=SculptGL_S2_V1.5` (era V1.4) — il bump qui
//   forza il browser a ricaricare i brush, che a loro volta caricheranno
//   SculptBase V1.5 (senza i 4 console.log). Logica brush invariata.
//
// V2.17 (2026-04-27, ROOT CAUSE FIX "Simplify ignora Detail"):
//   Diagnosi V2.16 ha esposto un bug latente da S1 (2026-04-27 originale).
//   I log `[DYNTOPO CFG]` mostravano `_applyDyntopoConfig` scrivere
//   `MeshDynamic.TARGET_EDGE_LEN = 0.3` mentre `[DYNTOPO CLASS CHECK]`
//   leggeva `mesh.constructor.TARGET_EDGE_LEN = 0.5` (default). Le due
//   property statiche dovrebbero essere LO STESSO storage, invece erano
//   disgiunte → due istanze di classe `MeshDynamic` indipendenti.
//
//   Causa: ESM tratta URL diversi come moduli separati. SculptMode
//   importava `'../sculptgl/MeshDynamic.js?v=SculptGL_S1_V1.2'` mentre
//   IbexBridge (che CREA le mesh tramite `new MeshDynamic()`) importava
//   `'./MeshDynamic.js'` (no ?v=). Due URL → due moduli → due classi →
//   due `TARGET_EDGE_LEN`/`SUBDIVISION_FACTOR`/`DECIMATION_FACTOR`/
//   `FALLOFF_TYPE` static disgiunti.
//
//   `_applyDyntopoConfig` scriveva sulla classe SculptMode-side; le
//   mesh esistenti erano istanze della classe IbexBridge-side; qualsiasi
//   slider (Detail/Falloff/dyntopo on-off) cambiava SOLO la SculptMode-side
//   → totalmente ignorato dal `dynamicTopology` runtime.
//
//   Risultato pre-fix: Simplify equalizzava sempre a target=0.5 (default)
//   senza guardare lo slider. Stesso bug latente per Smooth/Push/Pull/
//   Inflate/Flatten/Crease, ma meno percepibile perché altri brush usano
//   il falloff (anche legacy 'smooth' default) e fanno displacement vert
//   indipendente dal target.
//
//   Fix V2.17: rimosso `?v=SculptGL_S1_V1.2` dall'import di MeshDynamic.
//   Ora SculptMode usa lo stesso URL di IbexBridge → ESM cache hit →
//   STESSO modulo → STESSA classe → STESSE static properties.
//
//   Cleanup: rimossi i 4 `console.log('[DYNTOPO CFG] ...')` introdotti
//   in V2.16. Restano i log informativi `[SCULPT] ENTER`, `[SCULPT] EXIT`,
//   `[DYNTOPO] stroke verts ...` (quelli del `_finalizeStroke`).
//
//   Nota: i diagnostic logs in SculptBase V1.4 (`[DYNTOPO STROKE]`,
//   `[DYNTOPO CLASS CHECK]`, `[PRE-DYNTOPO]`, `[POST-DYNTOPO]`) restano
//   per ora — verifico il fix con un altro round di log, poi li rimuovo
//   in V1.5.
//
// V2.16 (2026-04-27, diagnostic logs — superseded da V2.17):
//   Aggiunti console.log diagnostici TEMPORANEI in `_applyDyntopoConfig`
//   (4 punti, uno per ciascun branch/return). Cascade bump per cache-bust
//   SculptBase V1.4 (diag): Brush V1.3, Smooth V1.3, Flatten V1.3,
//   Crease V1.2, Inflate V1.3, Simplify V1.6. Tag: [DYNTOPO CFG].
//
// V2.15 (2026-04-27, fix Simplify "non funziona"):
//   `_applyDyntopoConfig` branch simplify: `SUBDIVISION_FACTOR` da 0 → 75.
//   Diagnosi V2.14: con SUBDIVISION=0, `dynamicTopology` chiamava solo
//   `mesh.decimate` (collapse-only). Sulle zone della scansione dove gli
//   edge sono già lunghi rispetto al target (= la maggior parte di mesh
//   meshcleaned con edge ~0.2mm e target Detail tipico 0.3-0.5mm), il
//   decimate non trovava edge corti da collassare → no-op visibile, mesh
//   invariata = "Simplify non funziona".
//
//   Fix V2.15: SUBDIVISION_FACTOR=75 + DECIMATION_FACTOR=75 entrambi
//   attivi → `dynamicTopology` esegue subdivide+decimate insieme. Split
//   edge > target, collapse edge < target/2. Effetto netto: tutti gli
//   edge convergono verso `[target/2, target]` → uniformazione (equalize)
//   Blender-style. Comportamento "remesh dynamic" non "decimator".
//
//   Conseguenza voluta: in zone con topologia più rada del target,
//   Simplify AUMENTA la densità (split). In zone più dense, la riduce
//   (collapse). Non è più "solo riduttivo" → coerente con Blender Simplify
//   in dyntopo mode che è un equalizer al target detail.
//
// V2.14 (2026-04-27, Simplify riscritto):
//   - Bump import `Simplify` V1.4 → V1.5. Simplify ora chiama
//     `dynamicTopology(picking)` direttamente (come Brush/Inflate/Flatten/
//     Crease) invece di filtrare i face e chiamare `mesh.decimate` custom.
//     Risolve il bug "Simplify funziona solo una volta": dynamicTopology
//     ricalcola fresh il set di vert/face dal picking ad ogni mousemove
//     → il decimate riprende su zone non ancora stabilizzate.
//   - Filter curvature rimosso (era distruttivo e introduceva bug a
//     cascata su normali rumorose). Simplify per design semplifica TUTTO
//     nel raggio.
//   - `_applyDyntopoConfig` branch simplify: rinomina cosmetica
//     `baseDetail` → `detail` per allineamento con altre variabili locali
//     della funzione. Comportamento invariato.
//   - **Conseguenza UX**: slider Intensità diventa no-op per Simplify
//     (dynamicTopology non legge `_intensity`). Coerente con Smooth no-op
//     per falloff. Slider visibile sempre, nessuna modifica UI (A4).
//
// V2.13 (2026-04-27, lazy brush UI feedback):
//   - Overlay SVG full-viewport (z-index 50, pointer-events:none) con
//     LINEA tratteggiata arancione tra cursore mouse e "segugio"
//     (posizione effettiva del brush) + CERCHIO arancione attorno al
//     cursore mouse con raggio = `lazyRadius × 80px`. Tipo Blender/ZBrush.
//   - Cursor 3D del brush ora si posiziona sul SEGUGIO (non sul mouse)
//     quando lazy attivo + dragging → coerente con la posizione reale del
//     displacement. Fuori stroke o senza lazy: cursor segue il mouse come
//     prima.
//   - Refactor: nuovo `_updateCursorAtCanvasPos(x, y, rect?)` usato sia da
//     `_updateCursorFromMouseEvent(e)` (dispatch da evento) sia da
//     `_onMouseMove` con lazy attivo (passa `_lazyPos`).
//   - Lifecycle overlay: creato lazy al primo `_updateLazyOverlay`, hidden
//     al `_onMouseLeave`, `_finalizeStroke`, `exit()`. Non distrutto
//     (SculptMode singleton, riuso tra sessioni sculpt).
//
// V2.12b (2026-04-27): bump `?v=` di TUTTI i brush (Brush V1.2, Smooth V1.2,
//   Flatten V1.2, Inflate V1.2, Crease V1.1, Simplify V1.4) — nei brush
//   stessi è stato bumpato l'import SculptBase V1.3, ma senza bumpare il
//   ?v= dei brush in SculptMode, Chrome serviva i brush dalla cache con
//   import SculptBase V1.2 vecchio → falloff selector inerte. Fix cascata.
//   (Icona SVG Smooth corretta a forma U in ContextInspector V2.6 stesso.)
//
// V2.12 (2026-04-27, 4-obiettivi-in-uno):
//   (1) FLOOD FILL dyntopo: nuovo metodo `floodFill()` che rimescola
//       TUTTA la mesh fino al target edge length corrente (no brush
//       necessario). Loop iterativo con cap 10 iterazioni (convergenza
//       quando nbFaces non cambia). Usa `center=[0,0,0]` + `radius2=Infinity`
//       per coprire tutti i face (A2 + A4). Chiamata diretta a
//       `mesh.subdivide`/`mesh.decimate`, bypass di `dynamicTopology`.
//       `_modifiedSession = true` dopo flood (A6).
//   (2) LAZY BRUSH: nuovo flag `brush.lazy` + slider `brush.lazyRadius` (0-1).
//       In `_onMouseMove`, se lazy attivo, il "segugio" segue il cursore
//       con ritardo elastico — cursore dentro il raggio = segugio fermo,
//       oltre il raggio = segugio interpola. Reset `_lazyActive = false`
//       in `_onMouseDown` e `_finalizeStroke`.
//   (3) 3 falloff UI: smooth / sharp / cylinder (A7: migrazione legacy
//       'linear'→'cylinder', 'sphere'→'smooth' al `enter()`).
//   (4) Range tuning (A8): DEFAULT_BRUSH radius 2.0→0.5, strength 0.3→0.5.
//       Clamp al `enter()`: radius>1.5 → 1.5, strength>1.0 → 1.0 (+ minimi
//       a 0.1 per coerenza con i nuovi range UI).
//
// V2.11c (2026-04-27): fix "Simplify triangoli giganti + ignora strength".
//   (1) Bump import Simplify V1.2 → V1.3 — d2Min strength-aware (factor
//       0.05..1.0 mappato da brush.strength [0, 2]), rimosso override
//       TARGET×2 fisso che causava catastrofi con detail pre-impostato.
//   (2) `_applyDyntopoConfig` branch simplify setta TARGET_EDGE_LEN =
//       `brush.dyntopoDetail` (o 0.5mm default) → rispetta lo slider
//       Detail anche quando il brush precedente aveva valori diversi
//       (era il bug: TARGET globale ereditato da switch precedenti).
//
// V2.11b (2026-04-27): bump import Simplify V1.1 → V1.2 — filtro curvature
//   più robusto (avgDot invece di minDot, threshold 25° invece di 20°,
//   fallback "no filter" se scarto > 95%). Il V1.1 killava il brush su
//   scansioni dentali per rumore nelle normali face.
//
// V2.11 (2026-04-27, post-session cleanup):
//   - `DEFAULT_BRUSH.type` cambiato da `'push'` a `'inflate'`: Inflate con
//     sign=+1 diventa il brush primario dell'UI. Push/Pull restano istanze
//     in `_brushInstances` come fallback + backward compat per sessioni
//     legacy salvate, ma NON sono più nella row di bottoni del panel
//     (rimossi da ContextInspector V2.5).
//   - Bump import `Simplify` V1.0 → V1.1 (curvature-aware collapse).
//
// V2.10 (2026-04-27, brush Simplify):
//   - Nuovo brush `simplify` (decimation localizzata, nessun displacement).
//     Import `Simplify` da `../sculptgl/tools/Simplify.js` V1.0.
//   - `_createBrushInstances()`: aggiunta istanza `simplify`.
//   - `_applyDyntopoConfig()` esteso con branch iniziale per simplify:
//     quando `type==='simplify'`, forza `SUBDIVISION_FACTOR=0` +
//     `DECIMATION_FACTOR=75` a prescindere dal flag `brush.dyntopo` (il
//     brush è topology-only: deve funzionare sempre). `TARGET_EDGE_LEN`
//     non toccato qui — Simplify.stroke lo override temporaneamente
//     (×2 durante lo stroke, ripristino prima del ritorno).
//   - `_updateCursorBrushIndicators()`: `type==='simplify'` → direction=0
//     (freccia nascosta come smooth, outer ring piatto). Il brush non ha
//     verso add/remove — è un'azione topologica.
//
// V2.9 (2026-04-27, brush Crease + sign selector):
//   - Nuovo brush `crease` (porting di SculptGL Crease.js, pinch radiale +
//     displacement normale con falloff^5 — solchi/creste sottili). Import
//     `Crease` da `../sculptgl/tools/Crease.js` V1.0.
//   - `_createBrushInstances()`: aggiunta istanza `crease` con
//     `_negative = true` (default SculptGL: scavo).
//   - Nuovo campo `DEFAULT_BRUSH.sign = +1` per selettore +/- su
//     inflate/crease. Valore persistente nel config `this.brush.sign`.
//   - Nuovo `_applyBrushSign()` helper: se brush attivo è inflate o crease,
//     setta `_brushInstances[type]._negative = (sign < 0)`. Chiamato da
//     `enter()` (dopo `_createBrushInstances`) e `setBrush()` (dopo
//     l'Object.assign). `setBrush({sign: ±1})` → propagazione immediata.
//   - `_applyDyntopoConfig()`: crease cade nel ramo dedicato con
//     DECIMATION=0 (come smooth: il pinch radiale accorcia edge → rischio
//     tombstone/micro-fori con collapse attivo).
//   - `_updateCursorBrushIndicators()`: per type='crease', direction
//     deriva dal sign UI (+1 → cupola sottile, -1 → imbuto). Per type=
//     'inflate' stesso pattern, ma basato su brush.sign invece che
//     `inst._negative` (ora consistente).
//
// V2.8b (2026-04-27, fix rugosità Inflate):
//   - Bump import `Inflate` V1.0 → V1.1 (blend 60% per-vertex + 40% area
//     normal smoothata per attenuare la rugosità da amplificazione del
//     rumore delle normali su scansioni dentali). Comportamento SculptMode
//     invariato (il fix è interno a Inflate.stroke/inflate).
//
// V2.8 (2026-04-27, brush Inflate):
//   - Nuovo brush `inflate` (per-vertex normal displacement). Import
//     `Inflate` dal nuovo `../sculptgl/tools/Inflate.js` V1.0.
//   - `_createBrushInstances()`: aggiunta istanza `inflate` con
//     `_negative = false` (default: gonfia). Push/pull esistenti
//     conservati (fallback + backward compat, A2).
//   - `_updateCursorBrushIndicators()`: per `type==='inflate'`, la
//     direzione dipende da `_brushInstances.inflate._negative`:
//     false → +1 (cupola/gonfia), true → -1 (imbuto/contrae).
//   - `_applyDyntopoConfig()`: inflate cade nel branch `else`
//     (DECIMATION=37) come push/pull/flatten. Nessuna modifica esplicita.
//
// V2.7 (2026-04-27, falloff centralizzato):
//   - Nuovo `_applyFalloffConfig()` che scrive `MeshDynamic.FALLOFF_TYPE`
//     dal `brush.falloff` corrente. Chiamato da `enter()` (dopo
//     `_applyDyntopoConfig`) e da `setBrush()` (dopo l'Object.assign).
//   - `setBrush({falloff})` propaga il tipo di falloff al SculptGL via
//     static property. Brush.js/Flatten.js leggono `FALLOFF_TYPE` da
//     `mesh.constructor` dentro il loop displacement e chiamano
//     `SculptBase.computeFalloff(dist2, radius2, type)`.
//   - Bump catena import: MeshDynamic V1.1 → V1.2 (+ FALLOFF_TYPE static),
//     Brush V1.0 → V1.1, Flatten V1.0 → V1.1.
//
// V2.6 (2026-04-27, cursor tuning):
//   - Gradient texture alpha boost ~1.8× (centro 0.40 → 0.72, metà 0.22 →
//     0.48, bordo 0.08 → 0.22). La modulazione `disc.opacity = strength/2`
//     resta; il gradient è ora percepibile anche a strength~0.5.
//   - Outer ring offset Z factor `0.3 → 0.6` → cupola/imbuto 2× più
//     evidenti. Max |offset| = 1.2 raggio-normalizzato a strength=2.
//
// V2.5 (2026-04-27, cursor brush-indicators):
//   - `disc.opacity` ora correlata a `brush.strength` (mapping slider
//     [0, 2] → opacity [0.1, 1.0] a riposo; stroke: +0.15 clamped).
//     `_updateCursorBrushIndicators()` è la fonte di verità per
//     `_cursorDiscBaseOpacity` (riferimento per il feedback pressione).
//   - Freccia più sottile: `CylinderGeometry` r 0.04 → 0.015, `ConeGeometry`
//     r 0.12 → 0.05, length 0.30 → 0.15 (total 1.0 invariato).
//   - Freccia racchiusa in sub-group `_cursorArrowGroup` → rotazione di
//     `π` sull'asse X inverte il verso (`+Z` → `-Z`):
//       · push   → +Z (aggiunge material)
//       · pull/flatten → -Z (toglie material)
//       · smooth → hidden (neutro, solo ring)
//   - Nuovo `_cursorOuter.position.z` offset proporzionale a
//     `direction × strength × 0.3` (raggio-normalizzato) → il bordo
//     del cursor si solleva/scava proporzionalmente all'intensità e
//     al verso del brush. Effetto visivo: cupola per push, imbuto per
//     pull/flatten, piatto per smooth.
//   - `setBrush({type, strength})` chiama `_updateCursorBrushIndicators()`
//     oltre a `_updateCursorScale()`. `_initCursor` idem al termine.
//
// V2.4 (2026-04-27, cursor polish):
//   - Disc del cursor passa da riempimento uniforme (opacity 0.06) a
//     `CanvasTexture` radiale → bloom visibile che sfuma dal centro al
//     bordo (alpha 0.40 → 0.22 → 0.08 → 0.0). Render tra inner ring (0.40)
//     e outer ring (0.92) ora ha un gradient continuo invece di spazio
//     vuoto. Nuovo helper `_createCursorGradientTexture()`.
//   - Nuova freccia al centro del group, parallela alla normale della
//     superficie: `_cursorArrowShaft` (`CylinderGeometry` r=0.04 h=0.7)
//     + `_cursorArrowHead` (`ConeGeometry` r=0.12 h=0.3), entrambe
//     orientate lungo `+Z` locale del group (che è la direzione normale
//     della mesh, via `setFromUnitVectors(_cursorUpZ, normalWorld)`).
//     Totale lunghezza 1.0 raggio-normalizzato = 1× brush radius dopo
//     scale. Colore arancione `0xFF6037`, `depthTest: false`.
//   - Feedback pressione esteso alle nuove componenti: shaft/head boost
//     opacity durante stroke, reset a riposo.
//
// V2.3 (2026-04-27, InspectorPanel post):
//   - `_initCursor()` crea un `THREE.Group` (this._cursorGroup) con 3 mesh
//     a raggio normalizzato 1.0: (a) disc `CircleGeometry(1.0)` arancione
//     semitrasparente (opacity 0.06) → riempimento tenue, dà senso di
//     volume; (b) inner ring `RingGeometry(0.36, 0.40)` arancione 0.5 →
//     core del brush al 40% del raggio; (c) outer ring `RingGeometry(0.92,
//     1.0)` arancione 0.9 → bordo del raggio. Tutti `depthTest: false` +
//     `renderOrder: 999`. Alias `this.cursorMesh = this._cursorGroup` per
//     compat con il codice downstream che usa position/quaternion/visible.
//   - `_updateCursorScale()` scala il Group con `brush.radius`.
//   - Feedback pressione: al `_onMouseDown` (dopo `dragging=true`) boost
//     opacity (outer 0.9→1.0, inner 0.5→0.8, disc 0.06→0.10); al
//     `_finalizeStroke` ripristino valori a riposo. Visibile durante lo
//     stroke come "anello più contratto/intenso".
//   - `_updateCursorFromMouseEvent` invariato — opera su `this.cursorMesh`
//     che ora è il group.
//
// V2.2 (2026-04-27, TARGET_EDGE_LEN): `_applyDyntopoConfig` semplificato —
// scrittura diretta `MeshDynamic.TARGET_EDGE_LEN = detail` (default 0.5mm
// invece di radius/4). Soglie split/collapse in SculptBase.dynamicTopology
// derivano da TARGET_EDGE_LEN via `mesh.constructor.TARGET_EDGE_LEN`.
// SUBDIVISION_FACTOR/DECIMATION_FACTOR restano come toggle on/off.
//
// V2.1 (2026-04-27, SculptGL S4 Mod1): material override ceramica creta.
// V2.0 → V1.x: versioni precedenti (storico non incluso nel repository).
//
// ═══════════════════════════════════════════════════════════════
// Storico V1.0 (bootstrap S2) — brush SculptGL (no dyntopo)
//
// Riscrittura completa rispetto a V5.17 (SnapshotKeyed_S4). La vecchia
// implementazione (displacement diretto su BufferGeometry + adjacency
// cache + dyntopo custom localizzato) è sostituita dal sistema brush
// SculptGL (stephomi, MIT) via IbexBridge → MeshDynamic.
//
// Architettura:
//   - IbexBridge (mesh.userData.sculptgl, per-mesh A7) contiene MeshDynamic.
//   - IbexMainAdapter espone l'interfaccia `_main` attesa da SculptGL.
//   - Picking SculptGL: raycast Three.js BVH + Octree SculptGL per sphere.
//   - Brush: Brush (push/pull), Smooth, Flatten istanze persistenti.
//   - Sync Three.js post-sample via `adapter.render()` (A3 per-mousemove).
//   - BVH Three.js stale durante stroke → rebuild a mouseup in _finalizeStroke.
//
// NO dyntopo in questa sessione. Il flag `brush.dyntopo` viene ignorato
// (sarà attivato in S3 mappando su MeshDynamic.SUBDIVISION_FACTOR).
//
// API pubblica (compat con NodeBuilder + ContextInspector V1.8):
//   enter(nodeId), exit(), setBrush(partial),
//   active, targetNodeId, targetMesh, brush, dragging
//
// Brush mapping (A6):
//   push    → Brush (negative=false, clay=false)  — area-normal displacement
//   pull    → Brush (negative=true,  clay=false)
//   smooth  → Smooth (tangent=false) — Laplacian classico
//   flatten → Flatten (negative=true)
// ═══════════════════════════════════════════════════════════════

import { IbexBridge }     from '../sculptgl/IbexBridge.js?v=SculptGL_S1_V1.0';
import { IbexMainAdapter } from '../sculptgl/IbexMainAdapter.js?v=SculptGL_S3_V1.0';
import Picking            from '../sculptgl/Picking.js?v=SculptGL_S2_V1.1';
import Brush              from '../sculptgl/tools/Brush.js?v=SculptGL_S2_V1.4';
import Smooth             from '../sculptgl/tools/Smooth.js?v=SculptGL_S3_V1.4';
import Flatten            from '../sculptgl/tools/Flatten.js?v=SculptGL_S2_V1.4';
import Inflate            from '../sculptgl/tools/Inflate.js?v=SculptGL_S4_V1.4';
import Crease             from '../sculptgl/tools/Crease.js?v=SculptGL_S4_V1.3';
import Simplify           from '../sculptgl/tools/Simplify.js?v=SculptGL_S4_V1.7';
// IMPORTANTE (V2.17): NESSUN `?v=` qui. IbexBridge.js importa MeshDynamic
// con bare URL `./MeshDynamic.js`. Aggiungere un `?v=` qui crea una seconda
// istanza ESM della stessa classe → property statiche disgiunte → bug
// "_applyDyntopoConfig non ha effetto". Vedi header file V2.17 per dettaglio.
import MeshDynamic        from '../sculptgl/MeshDynamic.js';

// S3: dyntopo è CONTROLLATO DINAMICAMENTE via `_applyDyntopoConfig()` (chiamato
// da enter() e setBrush()). I factor globali `MeshDynamic.SUBDIVISION_FACTOR`
// e `DECIMATION_FACTOR` vengono settati in base a `brush.dyntopo` + `brush.dyntopoDetail`.
// Default class-level (75/0 di SculptGL) vengono comunque sovrascritti in enter().
//
// IMPORTANTE: Smooth.stroke NON chiama `dynamicTopology` (invariato da SculptGL
// originale) → dyntopo non scatta per il brush smooth anche con factor > 0.
// Push/pull (Brush) e Flatten chiamano dyntopo come da design SculptGL.

const DEFAULT_BRUSH = Object.freeze({
    type:          'inflate', // V2.11: Inflate primario (era 'push'). Push/Pull
                              // conservati in _brushInstances ma nascosti dall'UI.
                              // Tipi UI visibili: inflate | crease | smooth | flatten | simplify
    radius:        0.5,       // V2.12: mm (range slider 0.1-1.5, era 2.0)
    strength:      0.5,       // V2.12: base factor (range slider 0.1-1.0, era 0.3)
    falloff:       'smooth',  // V2.12: 3 tipi UI: smooth | sharp | cylinder (rimossi linear/sphere)
    sign:          +1,        // V2.9: selettore +/- per inflate/crease (+1 = add, -1 = remove)
    dyntopo:       false,     // S3: mapperà su MeshDynamic.SUBDIVISION_FACTOR
    dyntopoDetail: null,      // S3: target edge length mm
    lazy:          false,     // V2.12: lazy brush (segugio con ritardo elastico)
    lazyRadius:    0.5        // V2.12: raggio lazy [0, 1] (0 = nessun ritardo, 1 = max)
});

export class SculptMode {
    constructor(ibex) {
        this.ibex = ibex;
        this.active = false;
        this.targetNodeId = null;
        this.targetMesh = null;
        this.brush = { ...DEFAULT_BRUSH };

        this.dragging = false;
        this._modifiedSession = false;   // sopravvive a _finalizeStroke; reset solo in enter()
        this._prevMouseButtons = null;

        // SculptGL instances — inizializzati in enter()
        this._bridge = null;
        this._adapter = null;
        this._picking = null;
        this._brushInstances = null;
        this._currentBrushInstance = null;

        // S4 Mod1: material override durante sculpt — MatCap ad alto contrasto
        // rende visibili le facce create dal dyntopo (il ClinicalWhite uniforme
        // le nascondeva). `_sculptMatcapTex` lazy-generated una sola volta.
        this._savedMaterial = null;
        this._sculptMatcapTex = null;

        // Cursor ring 3D (identico a V5.17) — raycast Three.js indipendente
        // dal Picking SculptGL. Durante stroke il BVH Three.js è stale ma
        // per displacement <1mm il cursor non drift visibilmente.
        this._initCursor();

        // Scratch THREE objects
        this._cursorRaycaster = new THREE.Raycaster();
        this._cursorRaycaster.firstHitOnly = true;
        this._cursorMouse = new THREE.Vector2();
        this._cursorTmpN = new THREE.Vector3();
        this._cursorTmpQ = new THREE.Quaternion();
        this._cursorUpZ = new THREE.Vector3(0, 0, 1);

        // V2.12: Lazy brush state — il segugio segue il cursore con ritardo.
        // `_lazyPos` tiene la posizione schermo (px) del segugio; `_lazyActive`
        // è false al primo stroke di un drag (reset in mousedown/finalize).
        this._lazyPos = new THREE.Vector3();
        this._lazyActive = false;

        // V2.13: overlay SVG per feedback visivo lazy (linea + cerchio).
        // Creato lazy al primo uso via `_createLazyOverlay()`, resta hidden
        // finché non serve. Non tocco qui per non inquinare costruttore.
        this._lazyOverlay = null;
        this._lazyLineEl = null;
        this._lazyCircleEl = null;

        this._boundDown  = this._onMouseDown.bind(this);
        this._boundMove  = this._onMouseMove.bind(this);
        this._boundUp    = this._onMouseUp.bind(this);
        this._boundLeave = this._onMouseLeave.bind(this);
    }

    // ─────────────────────────────────────────────────────────────
    // Entry / Exit
    // ─────────────────────────────────────────────────────────────

    enter(nodeId) {
        if (this.active) {
            console.warn('[SCULPT] già attivo — exit prima di re-entrare');
            return;
        }
        const mesh = this._resolveTargetMesh(nodeId);
        if (!mesh) {
            alert('Collega prima una mesh al socket IN_GEO_Mesh del nodo Scolpisci');
            return;
        }

        // V2.12 (A7): migrazione valori falloff legacy dai config persistiti.
        // V1.2 aveva 4 tipi (smooth, linear, sphere, sharp). V1.3 ne ha 3
        // (smooth, sharp, cylinder). Remap per preservare l'highlight UI.
        if (this.brush.falloff === 'linear') this.brush.falloff = 'cylinder';
        else if (this.brush.falloff === 'sphere') this.brush.falloff = 'smooth';

        // V2.12 (A8): clamp radius e strength ai nuovi range UI.
        // radius: range UI [0.1, 1.5] → clamp sotto 0.1 e sopra 1.5
        // strength: range UI [0.1, 1.0] → clamp sotto 0.1 e sopra 1.0
        if (this.brush.radius   > 1.5) this.brush.radius   = 1.5;
        if (this.brush.radius   < 0.1) this.brush.radius   = 0.1;
        if (this.brush.strength > 1.0) this.brush.strength = 1.0;
        if (this.brush.strength < 0.1) this.brush.strength = 0.1;

        // S4 Mod1 (V1.7): override material con MatCap sculpt dalla CDN
        // nidorx/matcaps (grigio-azzurro clay classico, stesso della demo
        // three-mesh-bvh). Caricamento async con fallback procedurale immediato
        // (l'utente vede comunque qualcosa appena entra in sculpt, la texture
        // reale arriva appena la rete risponde).
        if (!this._savedMaterial) {
            this._savedMaterial = mesh.material;
            if (!this._sculptMatcapTex) {
                // Fallback procedurale immediato (sincrono) → material montato
                // senza attesa. Il CDN matcap arriva via Promise e sostituisce
                // la texture nel material corrente (se ancora in sculpt).
                this._sculptMatcapTex = this._createFallbackMatcap();
                this._createSculptMatcapTexture().then(tex => {
                    this._sculptMatcapTex = tex;
                    if (this.active &&
                        this.targetMesh?.material?.isMeshMatcapMaterial) {
                        this.targetMesh.material.matcap = tex;
                        this.targetMesh.material.needsUpdate = true;
                        this.ibex.sceneMgr?.render?.();
                    }
                });
            }
            const sculptMat = new THREE.MeshMatcapMaterial({
                matcap:      this._sculptMatcapTex,
                flatShading: false,
                side:        THREE.DoubleSide
            });
            // Array material: applica solo al primo elemento, preserva il resto
            // per il ripristino in exit(). IBEX mesh usano sempre material singolo
            // (MeshMatcapMaterial da MeshLoader) — il caso array è difensivo.
            if (Array.isArray(this._savedMaterial)) {
                const arr = this._savedMaterial.slice();
                arr[0] = sculptMat;
                mesh.material = arr;
            } else {
                mesh.material = sculptMat;
            }
        }

        // Lazy-init IbexBridge per-mesh (A7). Se esiste già (sculpt precedente
        // sulla stessa mesh), lo riusiamo MA ri-inizializziamo MeshDynamic dal
        // BufferGeometry corrente: la geometry può essere stata modificata da
        // un bake remoto (fast_transform, meshcleaner) tra una sessione sculpt
        // e l'altra. S4 farà questo anche in BakeEngine.hotSwapMeshes.
        if (!mesh.userData.sculptgl) {
            mesh.userData.sculptgl = new IbexBridge();
        }
        this._bridge = mesh.userData.sculptgl;
        this._bridge.initFromThreeMesh(mesh);

        // Istanzia adapter + picking + brush
        this._adapter = new IbexMainAdapter(this.ibex, this._bridge);
        this._picking = new Picking(this._adapter);
        this._adapter._pickingInstance = this._picking;
        this._createBrushInstances();
        this._setActiveBrush(this.brush.type);
        this._applyBrushParams();
        this._applyBrushSign();       // V2.9: sync inflate/crease._negative dal brush.sign
        this._applyDyntopoConfig();   // S3: sync MeshDynamic factors
        this._applyFalloffConfig();   // V2.7: sync MeshDynamic.FALLOFF_TYPE

        this.active = true;
        this.targetNodeId = nodeId;
        this.targetMesh = mesh;
        this._modifiedSession = false;

        // OrbitControls: LEFT disabilitato (brush), MIDDLE rotate, RIGHT pan.
        const ctrl = this.ibex.sceneMgr?.controls;
        if (ctrl) {
            this._prevMouseButtons = { ...(ctrl.mouseButtons || {}) };
            ctrl.mouseButtons = {
                LEFT:   null,
                MIDDLE: THREE.MOUSE.ROTATE,
                RIGHT:  THREE.MOUSE.PAN
            };
        }

        this.ibex.sceneMgr.scene.add(this.cursorMesh);
        this.cursorMesh.visible = false;

        const canvas = this.ibex.sceneMgr.renderer.domElement;
        canvas.addEventListener('mousedown',  this._boundDown);
        canvas.addEventListener('mousemove',  this._boundMove);
        canvas.addEventListener('mouseup',    this._boundUp);
        canvas.addEventListener('mouseleave', this._boundLeave);

        if (this.ibex.contextInspector) this.ibex.contextInspector.refresh();
        if (this.ibex.sceneMgr?.deselectMesh) this.ibex.sceneMgr.deselectMesh();

        this.ibex.sceneMgr.render();
        console.log(`[SCULPT] ENTER node ${nodeId} target=${mesh.name} brush=${this.brush.type} r=${this.brush.radius} s=${this.brush.strength}`);
    }

    exit() {
        if (!this.active) return;
        if (this.dragging) this._finalizeStroke();

        this._hideLazyOverlay(); // V2.13: safety cleanup feedback lazy

        const ctrl = this.ibex.sceneMgr?.controls;
        if (ctrl && this._prevMouseButtons) {
            ctrl.mouseButtons = this._prevMouseButtons;
            this._prevMouseButtons = null;
        }
        if (this.cursorMesh?.parent) this.cursorMesh.parent.remove(this.cursorMesh);

        const canvas = this.ibex.sceneMgr?.renderer?.domElement;
        if (canvas) {
            canvas.removeEventListener('mousedown',  this._boundDown);
            canvas.removeEventListener('mousemove',  this._boundMove);
            canvas.removeEventListener('mouseup',    this._boundUp);
            canvas.removeEventListener('mouseleave', this._boundLeave);
        }

        // S4 Mod1: ripristina material originale PRIMA del save snapshot.
        // SnapshotPersist non legge mesh.material (opera su geometry.clone),
        // ma il ripristino qui ha due scopi: (a) frame post-exit mostra la
        // mesh col MatCap ClinicalWhite (non MatCap sculpt) al prossimo
        // sceneMgr.render(); (b) chi userà la mesh fuori sculpt (contextmenu,
        // outliner, BakeEngine) la trova nel suo stato visuale canonico.
        if (this._savedMaterial && this.targetMesh) {
            this.targetMesh.material = this._savedMaterial;
            this._savedMaterial = null;
        }

        const meshToSave   = this.targetMesh;
        const nodeIdToSave = this.targetNodeId;
        const wasDirty     = this._modifiedSession;

        if (meshToSave?.geometry && wasDirty) {
            // Sync finale + rebuild BVH + computeVertexNormals (STLExporter li
            // serializza). A8: SnapshotPersist usa mesh.geometry come-è.
            this._bridge?.syncToThree();
            const g = meshToSave.geometry;
            g.computeVertexNormals();
            if (typeof g.computeBoundsTree === 'function') {
                g.computeBoundsTree();  // A5: rebuild BVH post-sculpt
            }
        }

        // Persistenza fire-and-forget (invariante ereditata da V5.17/Invariante 77)
        if (wasDirty && meshToSave && this.ibex.snapshotPersist) {
            this.ibex.uiMgr?.notify?.('Salvataggio scolpitura…', 'info');
            this.ibex.snapshotPersist.save(meshToSave, nodeIdToSave, 'sculpt')
                .then(res => {
                    if (res.ok) {
                        const vc = meshToSave.geometry.attributes.position.count;
                        this.ibex.uiMgr?.notify?.(
                            `Scolpitura salvata (${(res.size / 1024).toFixed(0)} KB)`, 'success');
                        this.ibex.stackMgr?.updateSculptNodeMeta?.(nodeIdToSave, {
                            sculpted:      true,
                            mesh_name:     res.mesh_name || meshToSave.name,
                            vertex_count:  vc,
                            last_modified: Math.floor(Date.now() / 1000)
                        });
                    } else {
                        this.ibex.uiMgr?.notify?.(
                            `Errore salvataggio scolpitura: ${res.error || 'unknown'}`, 'error');
                        console.warn('[SCULPT] save failed:', res);
                    }
                })
                .catch(e => {
                    this.ibex.uiMgr?.notify?.(
                        `Errore salvataggio scolpitura: ${e.message || e}`, 'error');
                    console.error('[SCULPT] save exception:', e);
                });
        }

        console.log(`[SCULPT] EXIT node ${this.targetNodeId} (modified=${wasDirty})`);

        // Reset state — il bridge resta attaccato a mesh.userData.sculptgl per riuso.
        this.active = false;
        this.targetNodeId = null;
        this.targetMesh = null;
        this.dragging = false;
        this._bridge = null;
        this._adapter = null;
        this._picking = null;
        this._brushInstances = null;
        this._currentBrushInstance = null;

        if (this.ibex.contextInspector) this.ibex.contextInspector.refresh();
        // ColorReady L11.3 (fix L3): all'uscita da sculpt il material canonico è già
        // ripristinato (:567) e this.active è false (:617) → update() riconcilia il flag
        // colore (want = colorMode && attributo allineato) sul matcap tornato in scena.
        // Senza, il colore non si ri-applicava fino a un update() scatenato da altro.
        window.ibex?.outlinerMgr?.update?.();
        this.ibex.sceneMgr?.render();
    }

    setBrush(partial) {
        Object.assign(this.brush, partial || {});
        if (partial?.type !== undefined && this._brushInstances) {
            this._setActiveBrush(this.brush.type);
        }
        this._applyBrushParams();
        this._applyBrushSign();       // V2.9: sync inflate/crease._negative dal brush.sign
        this._applyDyntopoConfig();   // S3: sync MeshDynamic factors
        this._applyFalloffConfig();   // V2.7: sync MeshDynamic.FALLOFF_TYPE
        this._updateCursorScale();
        this._updateCursorBrushIndicators(); // V2.5: dir arrow + offset outer + disc opacity
        if (this.ibex.sceneMgr) this.ibex.sceneMgr.render();
    }

    // ─────────────────────────────────────────────────────────────
    // Brush management
    // ─────────────────────────────────────────────────────────────

    _createBrushInstances() {
        const push = new Brush(this._adapter);
        push._negative = false;
        push._clay = false;
        const pull = new Brush(this._adapter);
        pull._negative = true;
        pull._clay = false;
        const smooth = new Smooth(this._adapter);
        smooth._tangent = false;  // Laplacian classico (stabile su dentale)
        const flatten = new Flatten(this._adapter);
        flatten._negative = true;  // default SculptGL (scava verso il piano)
        // V2.8 (Obiettivo 2/4): Inflate — per-vertex normal, default gonfia.
        const inflate = new Inflate(this._adapter);
        inflate._negative = false;
        // V2.9 (Obiettivo 3/4): Crease — pinch radiale + brush normale.
        // `_negative=true` default SculptGL (scavo). Verrà sovrascritto da
        // `_applyBrushSign()` secondo il `brush.sign` corrente.
        const crease = new Crease(this._adapter);
        crease._negative = true;
        // V2.10 (Obiettivo 4/4): Simplify — decimation localizzata, no displacement.
        const simplify = new Simplify(this._adapter);
        this._brushInstances = { push, pull, smooth, flatten, inflate, crease, simplify };
    }

    _setActiveBrush(type) {
        const inst = this._brushInstances[type] || this._brushInstances.push;
        this._currentBrushInstance = inst;
        if (this._adapter) this._adapter._currentBrush = inst;
    }

    _applyBrushParams() {
        if (!this._currentBrushInstance) return;
        this._currentBrushInstance._radius    = this.brush.radius;
        this._currentBrushInstance._intensity = this.brush.strength;
    }

    /**
     * V2.9: propaga `brush.sign` (+1/-1) al flag `_negative` delle istanze
     * inflate e crease. Per gli altri brush il sign è ignorato (push/pull
     * sono già 2 istanze distinte; flatten e smooth hanno semantica propria).
     *
     * Chiamato da `enter()` dopo `_createBrushInstances` e da `setBrush()`
     * dopo l'Object.assign. Effect atomico: il prossimo stroke userà il
     * nuovo sign senza bisogno di riavviare sculpt.
     */
    _applyBrushSign() {
        if (!this._brushInstances) return;
        const isNeg = (this.brush.sign < 0);
        if (this._brushInstances.inflate) this._brushInstances.inflate._negative = isNeg;
        if (this._brushInstances.crease)  this._brushInstances.crease._negative  = isNeg;
    }

    /**
     * Dyntopo config — scrive `MeshDynamic.TARGET_EDGE_LEN` (mm) direttamente.
     *
     * Soglie split/collapse (d2Max/d2Min in SculptBase.dynamicTopology) derivano
     * dal target edge length, NON dal radius brush. Il comportamento dyntopo
     * non cambia muovendo il radius — solo il dyntopoDetail slider lo altera.
     *
     * SUBDIVISION_FACTOR/DECIMATION_FACTOR restano come toggle on/off
     * (SculptBase early-returns se entrambi sono 0). Valori 75/37 sono
     * arbitrari: l'early-exit guard è la sola semantica rilevante ora.
     *
     * Smooth brush: disable collapse → evita chain collapse/tombstone
     * ("micro fori" visibili, lezione V5.17). Solo split densifica.
     *
     * Default `detail` = 0.5mm quando `dyntopoDetail` è null (scala dentale).
     */
    _applyDyntopoConfig() {
        // V2.15: Simplify ora EQUALIZE (Blender-style) — sia split sia
        // collapse attivi → tutti gli edge convergono verso [target/2, target].
        // SUBDIVISION=75 (split edge > target), DECIMATION=75 (collapse edge
        // < target/2). TARGET_EDGE_LEN da `brush.dyntopoDetail` (o 0.5mm).
        // `Simplify.stroke` (V1.5) chiama `dynamicTopology(picking)` che
        // esegue entrambi i rami con `d2Max = target²` e `d2Min = target²/4`.
        // In zone più rade del target la mesh AUMENTA in densità (subdivide).
        // Lo slider Intensità è no-op per Simplify (dynamicTopology ignora
        // `_intensity`). Funziona sempre, a prescindere dal flag `brush.dyntopo`.
        if (this.brush.type === 'simplify') {
            MeshDynamic.SUBDIVISION_FACTOR = 75;
            MeshDynamic.DECIMATION_FACTOR  = 75;
            const detail = (this.brush.dyntopoDetail != null && this.brush.dyntopoDetail > 0)
                ? this.brush.dyntopoDetail
                : 0.5;
            MeshDynamic.TARGET_EDGE_LEN = detail;
            return;
        }
        if (!this.brush.dyntopo) {
            MeshDynamic.SUBDIVISION_FACTOR = 0;
            MeshDynamic.DECIMATION_FACTOR  = 0;
            return;
        }
        const r = this.brush.radius;
        if (!(r > 0)) {
            MeshDynamic.SUBDIVISION_FACTOR = 0;
            MeshDynamic.DECIMATION_FACTOR  = 0;
            return;
        }
        const detail = (this.brush.dyntopoDetail != null && this.brush.dyntopoDetail > 0)
            ? this.brush.dyntopoDetail
            : 0.5; // default 0.5mm
        MeshDynamic.TARGET_EDGE_LEN = detail;
        MeshDynamic.SUBDIVISION_FACTOR = 75;
        // Collapse policy:
        //   smooth → 0 (Laplacian accorcia edge → chain collapse = micro-fori)
        //   crease → 0 (pinch radiale accorcia edge → stesso rischio)
        //   altri (push/pull/flatten/inflate) → 37 (collapse attivo)
        if (this.brush.type === 'smooth' || this.brush.type === 'crease') {
            MeshDynamic.DECIMATION_FACTOR = 0;
        } else {
            MeshDynamic.DECIMATION_FACTOR = 37;
        }
    }

    /**
     * V2.7: propaga `brush.falloff` a `MeshDynamic.FALLOFF_TYPE`. Letto da
     * Brush/Flatten/Crease/Inflate nel loop displacement via
     * `mesh.constructor.FALLOFF_TYPE` → `SculptBase.computeFalloff(...)`.
     * Chiamato da `enter()` e `setBrush()`. Smooth brush non usa falloff
     * (laplacian puro) — il valore è no-op quando il brush attivo è Smooth.
     */
    _applyFalloffConfig() {
        MeshDynamic.FALLOFF_TYPE = this.brush.falloff || 'smooth';
    }

    // ─────────────────────────────────────────────────────────────
    // V2.12: Flood Fill dyntopo — rimesha TUTTA la mesh al target corrente
    //
    // Diverso da un brush: applica `subdivide + decimate` all'intera mesh
    // in un colpo solo (loop iterativo fino a convergenza, cap 10). Utile
    // quando l'utente cambia `dyntopoDetail` e vuole propagare il nuovo
    // target a tutta la mesh (non solo sotto il brush).
    //
    // Tecniche:
    //   A2 — center = [0,0,0] + radius² = Infinity → cattura tutti i face,
    //        indifferente al center effettivo.
    //   A4 — loop iterativo: ogni iter di Subdivision/Decimation SculptGL
    //        al max raddoppia/dimezza la densità → mesh molto più dense del
    //        target richiedono più iter per convergere. Break se nbFaces
    //        non cambia (converged) o dopo 10 iter (safety).
    //   A5 — `new Uint32Array(nb)` + fill manuale (Subdivision/Decimation
    //        SculptGL prevedono typed array).
    //   A6 — `_modifiedSession = true` → SnapshotPersist.save parte a exit().
    //
    // Non tocca `MeshDynamic.SUBDIVISION_FACTOR`/`DECIMATION_FACTOR` perché
    // chiama direttamente `mesh.subdivide` / `mesh.decimate` (bypassa
    // `dynamicTopology` e i suoi guard `subFactor === 0`). Il `d2Max` e
    // `d2Min` sono calcolati dal `TARGET_EDGE_LEN` corrente (sincronizzato
    // dall'ultimo `_applyDyntopoConfig` o `setBrush({dyntopoDetail})`).
    // ─────────────────────────────────────────────────────────────
    floodFill() {
        if (!this.active || !this._bridge) return;
        const mesh = this._bridge.getMeshDynamic();
        if (!mesh) return;

        // Assicura che TARGET_EDGE_LEN rifletta il brush.dyntopoDetail corrente.
        this._applyDyntopoConfig();

        const target = MeshDynamic.TARGET_EDGE_LEN;
        if (!(target > 0)) {
            console.warn('[FLOOD] TARGET_EDGE_LEN non valido:', target);
            return;
        }
        const d2Max = target * target;
        const d2Min = d2Max * 0.25;

        // A2: center=[0,0,0] + radius²=Infinity cattura tutti i face
        // (il check `dist² < radius²` interno è sempre vero per Infinity).
        const center = new Float32Array([0, 0, 0]);
        const radius2 = Infinity;

        // Stub stateManager (coerente con lo stub IBEX di SculptGL —
        // StateManager reale non serve, undo-redo non implementato).
        const stateManager = { pushVertices: () => {}, pushFaces: () => {} };

        const nbVStart = mesh.getNbVertices();

        // A4: loop iterativo fino a convergenza o cap 10.
        let prev = -1;
        let iter = 0;
        while (iter < 10) {
            const nb = mesh.getNbFaces();
            if (nb === prev) break; // converged
            prev = nb;

            // A5: Uint32Array per i face indices (0..nb-1).
            const allFaces = new Uint32Array(nb);
            for (let i = 0; i < nb; ++i) allFaces[i] = i;

            mesh.subdivide(allFaces, center, radius2, d2Max, stateManager);
            mesh.decimate(allFaces, center, radius2, d2Min, stateManager);
            iter++;
        }

        // Update buffer topology/geometry (nessun argomento = full update).
        mesh.updateTopology();
        mesh.updateGeometry();

        // Sync Three.js BufferGeometry + rebuild BVH + invalida caches.
        this._bridge.syncToThree();
        const threeGeo = this.targetMesh.geometry; // A3: senza underscore
        threeGeo.computeVertexNormals();
        if (typeof threeGeo.computeBoundsTree === 'function') {
            threeGeo.computeBoundsTree();
        }
        this.targetMesh.userData.vertNeighbors     = null;
        this.targetMesh.userData.vertNeighborsN    = -1;
        this.targetMesh.userData.vertNeighborsGeom = null;

        // A6: marca sessione dirty → exit() triggera SnapshotPersist.save.
        this._modifiedSession = true;

        const nbVEnd = mesh.getNbVertices();
        const delta = nbVEnd - nbVStart;
        const sign = delta >= 0 ? '+' : '';
        console.log(`[FLOOD] verts: ${nbVStart} → ${nbVEnd} (${sign}${delta}) target=${target.toFixed(3)}mm iter=${iter}`);

        if (this.ibex.sceneMgr) this.ibex.sceneMgr.render();
    }

    // ─────────────────────────────────────────────────────────────
    // Mouse handlers — aggiornano adapter mouse state + brush start/update
    // ─────────────────────────────────────────────────────────────

    _onMouseDown(e) {
        if (!this.active || e.button !== 0) return;
        if (!this._currentBrushInstance || !this._adapter) return;
        e.preventDefault();

        this._adapter._mouseX = this._screenX(e);
        this._adapter._mouseY = this._screenY(e);

        const brush = this._currentBrushInstance;
        const ok = brush.start(false);
        if (!ok) return;

        this.dragging = true;

        // V2.12: reset segugio lazy al nuovo stroke (il primo mousemove
        // lo inizializzerà alla posizione corrente se lazy è attivo).
        this._lazyActive = false;

        // V2.5: Feedback pressione — ring + freccia più intensi; disc boost su baseOp
        if (this._cursorOuter) {
            this._cursorOuter.material.opacity = 1.0;
            this._cursorInner.material.opacity = 0.8;
            this._cursorDisc.material.opacity  = Math.min(1.0, (this._cursorDiscBaseOpacity ?? 0.5) + 0.15);
            this._cursorArrowShaft.material.opacity = 1.0;
            this._cursorArrowHead.material.opacity  = 1.0;
        }

        // S3 debug: vertex count all'inizio dello stroke (per log dyntopo in finalize)
        this._strokeStartVerts = this.targetMesh?.geometry?.attributes?.position?.count ?? 0;

        // SculptBase.sculptStroke (chiamato da start→startSculpt) skippa il
        // primo sample perché al mouseDown `_lastMouseX/Y === _mouseX/Y` → dist=0
        // → `if (dist <= minSpacing) return`. Per UX "click = un bump" forziamo
        // manualmente un sample via makeStroke primitive (senza stroke spacing).
        brush.makeStroke(this._adapter._mouseX, this._adapter._mouseY, this._picking);
        // adapter.render → bridge.syncToThree + sceneMgr.render
        this._adapter.render();

        this._modifiedSession = true;
    }

    _onMouseMove(e) {
        if (!this.active) return;

        // Non dragging: cursor 3D segue il mouse direttamente, overlay lazy off.
        if (!this.dragging || !this._currentBrushInstance || !this._adapter || !this._picking) {
            this._updateCursorFromMouseEvent(e);
            this._hideLazyOverlay();
            if (this.ibex.sceneMgr) this.ibex.sceneMgr.render();
            return;
        }

        const mx = this._screenX(e);
        const my = this._screenY(e);

        // V2.12: Lazy brush — segugio segue cursore con ritardo elastico.
        // V2.13: feedback visivo UI tipo Blender/ZBrush — cursor 3D al
        // segugio, overlay SVG con linea + cerchio raggio al mouse.
        if (this.brush.lazy && this.brush.lazyRadius > 0) {
            if (!this._lazyActive) {
                // Inizializza segugio alla posizione corrente (evita jump).
                this._lazyPos.set(mx, my, 0);
                this._lazyActive = true;
            }
            const dx = mx - this._lazyPos.x;
            const dy = my - this._lazyPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const lazyPx = this.brush.lazyRadius * 80; // 0..80 px
            let skipStroke = false;
            if (dist >= lazyPx) {
                // Sposta segugio verso cursore, lasciando distanza = lazyPx.
                const ratio = (dist - lazyPx) / dist;
                this._lazyPos.x += dx * ratio;
                this._lazyPos.y += dy * ratio;
            } else {
                skipStroke = true; // cursore dentro raggio, segugio fermo
            }

            // Cursor 3D al SEGUGIO (non al mouse) → coerente con displacement.
            this._updateCursorAtCanvasPos(this._lazyPos.x, this._lazyPos.y);
            // Overlay feedback: linea mouse→segugio + cerchio raggio al mouse.
            this._updateLazyOverlay(e.clientX, e.clientY, this._lazyPos.x, this._lazyPos.y);

            if (skipStroke) {
                if (this.ibex.sceneMgr) this.ibex.sceneMgr.render();
                return;
            }
            this._adapter._mouseX = this._lazyPos.x;
            this._adapter._mouseY = this._lazyPos.y;
        } else {
            this._updateCursorFromMouseEvent(e);
            this._hideLazyOverlay();
            this._lazyActive = false;
            this._adapter._mouseX = mx;
            this._adapter._mouseY = my;
        }

        // Bypass del `SculptBase.sculptStroke` spacing (pensato per _radius in
        // pixel, non mm): chiamiamo `makeStroke` primitive direttamente → 1
        // sample per mousemove event (pattern event-driven Three.js, coerente
        // col resto di IBEX). Niente oversampling, niente skip per dist<spacing.
        // Su drag molto veloci si perdono sample intermedi — accettabile per
        // sculpt clinico (movimenti moderati).
        this._currentBrushInstance.makeStroke(
            this._adapter._mouseX,
            this._adapter._mouseY,
            this._picking
        );
        // adapter.render → bridge.syncToThree + sceneMgr.render
        this._adapter.render();
        this._modifiedSession = true;
    }

    _onMouseUp(_e) {
        if (!this.active || !this.dragging) return;
        this._finalizeStroke();
    }

    _onMouseLeave(_e) {
        if (this.cursorMesh) this.cursorMesh.visible = false;
        this._hideLazyOverlay(); // V2.13: nascondi linea+cerchio lazy
        if (this.dragging) this._finalizeStroke();
        if (this.ibex.sceneMgr) this.ibex.sceneMgr.render();
    }

    _finalizeStroke() {
        this.dragging = false;
        this._lazyActive = false; // V2.12: reset segugio lazy a fine stroke
        this._hideLazyOverlay();   // V2.13: nascondi feedback visivo lazy

        // V2.5: Ripristina opacità a riposo; disc.opacity torna al base (legato a strength)
        if (this._cursorOuter) {
            this._cursorOuter.material.opacity = 0.9;
            this._cursorInner.material.opacity = 0.5;
            this._cursorDisc.material.opacity  = this._cursorDiscBaseOpacity ?? 0.5;
            this._cursorArrowShaft.material.opacity = 0.85;
            this._cursorArrowHead.material.opacity  = 0.95;
        }

        if (!this.targetMesh) return;

        if (this._modifiedSession) {
            // Sync finale (difensivo — adapter.render già sync dopo l'ultimo
            // stroke, ma possono esserci edge case con stroke spacing).
            this._bridge?.syncToThree();

            // Rebuild BVH Three.js + invalida caches adjacency (A5).
            const g = this.targetMesh.geometry;
            if (typeof g.computeBoundsTree === 'function') {
                g.computeBoundsTree();
            }
            this.targetMesh.userData.vertNeighbors     = null;
            this.targetMesh.userData.vertNeighborsN    = -1;
            this.targetMesh.userData.vertNeighborsGeom = null;
        }

        // S3 debug: log delta count dyntopo (diagnostic)
        const nbVEnd = this.targetMesh?.geometry?.attributes?.position?.count ?? 0;
        const startV = this._strokeStartVerts ?? nbVEnd;
        const delta = nbVEnd - startV;
        if (delta !== 0) {
            const sign = delta > 0 ? '+' : '';
            console.log(`[DYNTOPO] stroke verts: ${startV} → ${nbVEnd} (${sign}${delta})  dyntopo=${this.brush.dyntopo}  detail=${this.brush.dyntopoDetail ?? 'auto'}  radius=${this.brush.radius}  type=${this.brush.type}`);
        } else if (this.brush.dyntopo) {
            console.log(`[DYNTOPO] stroke verts INVARIATO: ${nbVEnd}  dyntopo=true  detail=${this.brush.dyntopoDetail ?? 'auto (' + (this.brush.radius/4).toFixed(2) + ')'}  radius=${this.brush.radius}  type=${this.brush.type}  subFactor=${MeshDynamic.SUBDIVISION_FACTOR.toFixed(1)} — prova a ridurre Detail`);
        }
        this._strokeStartVerts = nbVEnd;

        this.ibex.sceneMgr?.render();
    }

    // ─────────────────────────────────────────────────────────────
    // Screen coords helper — canvas-local pixels
    // ─────────────────────────────────────────────────────────────
    _screenX(e) {
        const rect = this.ibex.sceneMgr.renderer.domElement.getBoundingClientRect();
        return e.clientX - rect.left;
    }
    _screenY(e) {
        const rect = this.ibex.sceneMgr.renderer.domElement.getBoundingClientRect();
        return e.clientY - rect.top;
    }

    // ─────────────────────────────────────────────────────────────
    // Cursor ring — raycast Three.js sulla targetMesh per feedback visivo
    // ─────────────────────────────────────────────────────────────
    _updateCursorFromMouseEvent(e) {
        if (!this.targetMesh) return;
        const canvas = this.ibex.sceneMgr.renderer.domElement;
        const rect   = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        this._updateCursorAtCanvasPos(cx, cy, rect);
    }

    /**
     * V2.13: raycast + posizionamento cursor 3D a coord canvas-local
     * arbitrarie. Usato da `_updateCursorFromMouseEvent` (coord da evento)
     * e da `_onMouseMove` con lazy attivo (coord da `_lazyPos`, segugio
     * invece del mouse → il cerchio brush 3D segue il segugio).
     */
    _updateCursorAtCanvasPos(canvasX, canvasY, rect) {
        if (!this.targetMesh) return;
        if (!rect) {
            rect = this.ibex.sceneMgr.renderer.domElement.getBoundingClientRect();
        }
        this._cursorMouse.x =  (canvasX / rect.width)  * 2 - 1;
        this._cursorMouse.y = -(canvasY / rect.height) * 2 + 1;
        this._cursorRaycaster.setFromCamera(this._cursorMouse, this.ibex.sceneMgr.camera);
        const hits = this._cursorRaycaster.intersectObject(this.targetMesh, false);
        if (hits[0]) {
            this.cursorMesh.visible = true;
            this.cursorMesh.position.copy(hits[0].point);
            this._cursorTmpN.copy(hits[0].face.normal)
                .transformDirection(this.targetMesh.matrixWorld)
                .normalize();
            this._cursorTmpQ.setFromUnitVectors(this._cursorUpZ, this._cursorTmpN);
            this.cursorMesh.quaternion.copy(this._cursorTmpQ);
        } else {
            this.cursorMesh.visible = false;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // V2.13: Lazy brush overlay — linea tratteggiata + cerchio del raggio
    //
    // Feedback visivo tipo Blender/ZBrush: quando il brush lazy è attivo
    // durante uno stroke, mostra:
    //   - un CERCHIO attorno al cursore del mouse (raggio = lazyRadius*80px)
    //   - una LINEA tratteggiata tra cursore mouse e "segugio" (posizione
    //     effettiva del brush, = `_lazyPos`)
    // Overlay SVG in <body>, pointer-events: none, z-index 50.
    // Visibile solo quando `brush.lazy && dragging && _lazyActive`.
    // ─────────────────────────────────────────────────────────────
    _createLazyOverlay() {
        if (this._lazyOverlay) return;
        const overlay = document.createElement('div');
        overlay.id = 'ibex-lazy-overlay';
        overlay.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" style="position:absolute; inset:0; width:100%; height:100%; overflow:visible;">
                <line   x1="0" y1="0" x2="0" y2="0"
                        stroke="#FF6037" stroke-width="1.5"
                        stroke-dasharray="4 3" stroke-linecap="round"
                        opacity="0.85" />
                <circle cx="0" cy="0" r="0"
                        stroke="#FF6037" stroke-width="1"
                        fill="none" opacity="0.55" />
            </svg>`;
        overlay.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; pointer-events:none; z-index:50; display:none;';
        document.body.appendChild(overlay);
        this._lazyOverlay   = overlay;
        this._lazyLineEl    = overlay.querySelector('line');
        this._lazyCircleEl  = overlay.querySelector('circle');
    }

    _updateLazyOverlay(mouseClientX, mouseClientY, segugioCanvasX, segugioCanvasY) {
        if (!this._lazyOverlay) this._createLazyOverlay();
        const canvas = this.ibex.sceneMgr.renderer.domElement;
        const rect = canvas.getBoundingClientRect();
        const segugioClientX = rect.left + segugioCanvasX;
        const segugioClientY = rect.top  + segugioCanvasY;
        const lazyPx = Math.max(0, this.brush.lazyRadius * 80);
        this._lazyLineEl.setAttribute('x1', String(mouseClientX));
        this._lazyLineEl.setAttribute('y1', String(mouseClientY));
        this._lazyLineEl.setAttribute('x2', String(segugioClientX));
        this._lazyLineEl.setAttribute('y2', String(segugioClientY));
        this._lazyCircleEl.setAttribute('cx', String(mouseClientX));
        this._lazyCircleEl.setAttribute('cy', String(mouseClientY));
        this._lazyCircleEl.setAttribute('r',  String(lazyPx));
        this._lazyOverlay.style.display = 'block';
    }

    _hideLazyOverlay() {
        if (this._lazyOverlay) this._lazyOverlay.style.display = 'none';
    }

    // ─────────────────────────────────────────────────────────────
    // Resolve target mesh via graph (IN_GEO_Mesh edge) — invariato da V5.17
    // ─────────────────────────────────────────────────────────────
    // T1Resolve_29-7 — delega all'util condiviso (era ×2 byte-identico con SelectionMode).
    _resolveTargetMesh(nodeId) { return resolveTargetMesh(this.ibex, nodeId); }

    // ─────────────────────────────────────────────────────────────
    // Cursor ring 3D layered (V2.4) — Group: disc(gradient) + inner + outer + arrow
    // ─────────────────────────────────────────────────────────────
    _initCursor() {
        // Gruppo contenitore — posizione e orientamento aggiornati insieme
        this._cursorGroup = new THREE.Group();
        this._cursorGroup.renderOrder = 999;

        // 1. Disco radiale con GRADIENT texture — bloom visibile che sfuma
        //    dal centro al bordo. Riempie lo spazio tra inner e outer ring
        //    con continuità (V2.4).
        const discGeo = new THREE.CircleGeometry(1.0, 64);
        const discMat = new THREE.MeshBasicMaterial({
            color:       0xFF6037,
            map:         this._createCursorGradientTexture(),
            transparent: true,
            opacity:     1.0,               // gradient è nella texture alpha
            side:        THREE.DoubleSide,
            depthTest:   false,
        });
        this._cursorDisc = new THREE.Mesh(discGeo, discMat);
        this._cursorDisc.renderOrder = 999;

        // 2. Anello interno — core intensità (40% del raggio)
        const innerGeo = new THREE.RingGeometry(0.36, 0.40, 64);
        const innerMat = new THREE.MeshBasicMaterial({
            color:       0xFF6037,
            transparent: true,
            opacity:     0.5,
            side:        THREE.DoubleSide,
            depthTest:   false,
        });
        this._cursorInner = new THREE.Mesh(innerGeo, innerMat);
        this._cursorInner.renderOrder = 999;

        // 3. Anello esterno — bordo del raggio
        const outerGeo = new THREE.RingGeometry(0.92, 1.0, 64);
        const outerMat = new THREE.MeshBasicMaterial({
            color:       0xFF6037,
            transparent: true,
            opacity:     0.9,
            side:        THREE.DoubleSide,
            depthTest:   false,
        });
        this._cursorOuter = new THREE.Mesh(outerGeo, outerMat);
        this._cursorOuter.renderOrder = 999;

        // 4. Freccia al centro parallela alla normale (V2.4, V2.5 più sottile).
        //    Il group ha +Z orientato lungo la normale world della mesh
        //    (_updateCursorFromMouseEvent: setFromUnitVectors(UpZ, normalWorld)).
        //    Cylinder e Cone di Three.js sono Y-up di default → rotateX(PI/2)
        //    riallinea l'asse a +Z. translate dopo la rotazione posiziona
        //    base/top lungo +Z.
        //
        //    Shaft: z ∈ [0.00, 0.85] (parte dalla superficie)
        //    Head:  z ∈ [0.85, 1.00] (punta a z=1.0 = 1× raggio fuori)
        //
        //    V2.5: freccia avvolta in `_cursorArrowGroup` → rotazione X di π
        //    al runtime inverte il verso (+Z ↔ -Z) per indicare add/remove.
        this._cursorArrowGroup = new THREE.Group();
        this._cursorArrowGroup.renderOrder = 999;

        const shaftGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.85, 12);
        shaftGeo.rotateX(Math.PI / 2);
        shaftGeo.translate(0, 0, 0.425);
        const shaftMat = new THREE.MeshBasicMaterial({
            color:       0xFF6037,
            transparent: true,
            opacity:     0.85,
            depthTest:   false,
        });
        this._cursorArrowShaft = new THREE.Mesh(shaftGeo, shaftMat);
        this._cursorArrowShaft.renderOrder = 999;

        const headGeo = new THREE.ConeGeometry(0.05, 0.15, 12);
        headGeo.rotateX(Math.PI / 2);
        headGeo.translate(0, 0, 0.925);
        const headMat = new THREE.MeshBasicMaterial({
            color:       0xFF6037,
            transparent: true,
            opacity:     0.95,
            depthTest:   false,
        });
        this._cursorArrowHead = new THREE.Mesh(headGeo, headMat);
        this._cursorArrowHead.renderOrder = 999;

        this._cursorArrowGroup.add(this._cursorArrowShaft);
        this._cursorArrowGroup.add(this._cursorArrowHead);

        this._cursorGroup.add(this._cursorDisc);
        this._cursorGroup.add(this._cursorInner);
        this._cursorGroup.add(this._cursorOuter);
        this._cursorGroup.add(this._cursorArrowGroup);

        // Alias per compatibilità con il resto del codice che usa this.cursorMesh
        this.cursorMesh = this._cursorGroup;

        // V2.5: baseline per il feedback pressione (disc.opacity riposo).
        this._cursorDiscBaseOpacity = 1.0;

        this._updateCursorScale();
        this._updateCursorBrushIndicators();
    }

    /**
     * V2.5: aggiorna le 3 informazioni visive del cursor legate al brush:
     *   (1) direzione della freccia (verso +Z per add, -Z per remove, hidden per smooth)
     *   (2) offset Z del outer ring (sollevato per add, abbassato per remove)
     *   (3) opacity del disc gradient (correlata a strength)
     *
     * Chiamato da `setBrush({type, strength})` e in fondo a `_initCursor()`.
     * Non tocca la scale del group (gestita da _updateCursorScale).
     */
    _updateCursorBrushIndicators() {
        if (!this._cursorGroup) return;
        const type     = this.brush.type;
        const strength = this.brush.strength;

        // Direzione intrinseca del brush:
        //   +1 → add (solleva material)     → push, inflate(sign=+1), crease(sign=+1)
        //   -1 → remove (scava / flatten)   → pull, flatten, inflate(sign=-1), crease(sign=-1)
        //    0 → neutro (laplacian / topology-only) → smooth, simplify
        let direction = 0;
        if      (type === 'push')                          direction = +1;
        else if (type === 'pull' || type === 'flatten')    direction = -1;
        else if (type === 'inflate' || type === 'crease') {
            // V2.9: direzione deriva dal `brush.sign` (propagato a `_negative`
            // dell'istanza via `_applyBrushSign()`). Selettore UI +/-.
            direction = (this.brush.sign < 0) ? -1 : +1;
        }
        // V2.10: simplify → direction=0 (topology-only, no displacement).
        // Freccia nascosta, outer ring piatto (come smooth).

        // (1) Freccia: visibilità + rotazione 180° per remove.
        if (this._cursorArrowGroup) {
            this._cursorArrowGroup.visible = (direction !== 0);
            this._cursorArrowGroup.rotation.x = (direction < 0) ? Math.PI : 0;
        }

        // (2) Outer ring: offset Z proporzionale a direction × strength.
        //     V2.6: factor 0.3 → 0.6 (più evidente). Max |offset| = 1.2
        //     raggio-normalizzato a strength=2 (1.2× raggio brush fuori/dentro).
        if (this._cursorOuter) {
            this._cursorOuter.position.z = direction * strength * 0.6;
        }

        // (3) Disc opacity correlata a strength (mapping [0,2] → [0.1, 1.0]).
        //     Salvato in `_cursorDiscBaseOpacity` per il boost del feedback
        //     pressione (_onMouseDown/_finalizeStroke).
        const baseOp = Math.max(0.1, Math.min(1.0, strength / 2));
        this._cursorDiscBaseOpacity = baseOp;
        if (this._cursorDisc && !this.dragging) {
            this._cursorDisc.material.opacity = baseOp;
        } else if (this._cursorDisc && this.dragging) {
            // Se siamo già in stroke quando l'utente cambia strength/type,
            // applica il boost immediatamente sul nuovo base.
            this._cursorDisc.material.opacity = Math.min(1.0, baseOp + 0.15);
        }
    }

    /**
     * V2.6: alpha boost ~1.8× sul radial gradient (era V2.4 più tenue, poco
     * visibile a strength basse/medie anche dopo la modulazione disc.opacity).
     * Texture bianca con alpha graduato centro→bordo, moltiplicata col color
     * arancione del materiale e con `material.opacity = strength/2` → bloom
     * arancione continuo e percepibile tra inner e outer ring anche a
     * strength ~0.5.
     */
    _createCursorGradientTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
        g.addColorStop(0.00, 'rgba(255, 255, 255, 0.72)');
        g.addColorStop(0.40, 'rgba(255, 255, 255, 0.48)');
        g.addColorStop(0.80, 'rgba(255, 255, 255, 0.22)');
        g.addColorStop(1.00, 'rgba(255, 255, 255, 0.0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 256, 256);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }

    _updateCursorScale() {
        if (!this._cursorGroup) return;
        const r = this.brush.radius;
        this._cursorGroup.scale.set(r, r, r);
    }

    // ─────────────────────────────────────────────────────────────
    // S4 Mod1 (V1.7): MatCap sculpt — clay grigio-azzurro da CDN
    //
    // Il ClinicalWhite uniforme di MeshLoader nascondeva le variazioni di
    // normale tra face adjacent → il dyntopo agiva sui dati ma non era
    // distinguibile visivamente. Questo MatCap (clay grigio-azzurro classico
    // tipo sculpt Blender/ZBrush) ha gradient forte + specular netto → face
    // adjacent catturano matcap-lookup diversi → topology visibile.
    //
    // Caricato ASYNC dal repo `nidorx/matcaps` via TextureLoader (il repository non
    // dichiara una licenza: la texture è caricata a runtime e non è inclusa in IBEX),
    // stesso matcap usato dalla demo three-mesh-bvh. Fallback procedurale
    // applicato immediatamente in enter() per non bloccare l'UI.
    // Cached in `this._sculptMatcapTex` (sincrono inizialmente = fallback;
    // quando la Promise arriva, sostituisce la cache + applica al material
    // corrente se sculpt è ancora attivo sulla stessa mesh).
    // ─────────────────────────────────────────────────────────────
    _createSculptMatcapTexture() {
        return new Promise((resolve) => {
            const loader = new THREE.TextureLoader();
            // jsDelivr CDN → CORS abilitato, cache globale. Path corretto del
            // repo nidorx/matcaps: `{size}/{hex}.png` (il suffisso -{size}px
            // nel filename NON esiste — errore nel path originale → 404).
            // Matcap ceramica color creta (V2.0 → V2.1 ripristino V1.9):
            // base terracotta calda #CAA094, highlight bianco-crema #EADEDC
            // (glaze lucido), ombre #875343 medie e #956255 mezzotono per
            // contrasto luce/ombra direzionale. Il tentativo "più chiaro"
            // (CAA78A...) riduceva troppo il contrasto → topologia dyntopo
            // meno leggibile.
            loader.load(
                'https://cdn.jsdelivr.net/gh/nidorx/matcaps@1b1e43a338335b6401034d48488298966755d717/1024/CAA094_875343_956255_EADEDC.png',
                (tex) => {
                    tex.colorSpace = THREE.SRGBColorSpace;
                    resolve(tex);
                },
                undefined,
                () => {
                    // CDN non raggiungibile (network error / CORS / 404):
                    // fallback procedurale coerente col look target.
                    resolve(this._createFallbackMatcap());
                }
            );
        });
    }

    _createFallbackMatcap() {
        // Fallback ceramica creta: coerente col matcap CDN
        // CAA094_875343_956255_EADEDC. Base terracotta calda + highlight
        // crema bianco + ombra marrone media per contrasto direzionale.
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#875343';
        ctx.fillRect(0, 0, size, size);
        const grad = ctx.createRadialGradient(size*0.35, size*0.3, 0, size*0.5, size*0.5, size*0.6);
        grad.addColorStop(0,   '#EADEDC');  // highlight bianco-crema
        grad.addColorStop(0.4, '#CAA094');  // base terracotta
        grad.addColorStop(1,   '#956255');  // ombra marrone media
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(size/2, size/2, size/2, 0, Math.PI*2); ctx.fill();
        const spec = ctx.createRadialGradient(size*0.32, size*0.28, 0, size*0.32, size*0.28, size*0.1);
        spec.addColorStop(0, 'rgba(255,255,255,0.85)');
        spec.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = spec;
        ctx.beginPath(); ctx.arc(size/2, size/2, size/2, 0, Math.PI*2); ctx.fill();
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }
}
