<?php
/**
 * IBEX - Dental CAD Engine
 * Entry Point Centrale (Phase 16 - Fast Lane / Real-Time Bake)
 */

ini_set('display_errors', 0); 
ini_set('log_errors', 1);
error_reporting(E_ALL);

// AUTOLOADER
spl_autoload_register(function ($class) {
    $prefix = 'App\\';
    $base_dir = __DIR__ . '/';
    $len = strlen($prefix);
    if (strncmp($prefix, $class, $len) !== 0) return;
    $relative_class = substr($class, $len);
    $file = $base_dir . 'App/' . str_replace('\\', '/', $relative_class) . '.php';
    if (!file_exists($file)) {
        $file = $base_dir . str_replace('\\', '/', $relative_class) . '.php';
    }
    if (file_exists($file)) require $file;
});

use App\Core\IbexConfig;
use App\Http\Controllers\ProjectController;
use App\Http\Controllers\EditorController;
use App\Http\Middleware\NextcloudAuthBridge;
use App\Http\Middleware\AllowNextcloudFrame;

// --- FIX SAFARI E POLICY IFRAME ---
// RIMOSSI CSP e X-Frame-Options da qui per evitare conflitti mortali. 
// Lasciamo solo il CORS vitale per permettere a Javascript di scaricare le mesh asincrone.
// Origine = istanza Nextcloud configurata (NEXTCLOUD_URL); se manca, nessun header CORS.
$ncOrigin = IbexConfig::nextcloudOrigin();
if ($ncOrigin !== '') {
    header("Access-Control-Allow-Origin: {$ncOrigin}");
    header("Access-Control-Allow-Credentials: true");
}

// SESSIONE & COOKIE (Anti Intelligent Tracking Prevention Apple)
// SESSION_DOMAIN vuoto → nessun attributo Domain (cookie solo per l'host corrente).
$cookieDomain = IbexConfig::sessionDomain();
if (session_status() === PHP_SESSION_NONE) {
    $cookieParams = [
        'lifetime' => 86400,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'None'
    ];
    if ($cookieDomain !== '') { $cookieParams['domain'] = $cookieDomain; }
    session_set_cookie_params($cookieParams);
    session_start();
    
    // Fallback esplicito per Safari iOS
    $sessionId = session_id();
    if (!headers_sent()) {
        $domainAttr = ($cookieDomain !== '') ? "; Domain={$cookieDomain}" : '';
        header("Set-Cookie: PHPSESSID={$sessionId}; Path=/{$domainAttr}; Secure; HttpOnly; SameSite=None");
    }
}

// --- ROUTING ---
$action = $_REQUEST['action'] ?? 'index';

/* ═══════════════════════════════════════════════════════════════════════════
   PUNTO4-FETTA-C (2026-07-28) — CANCELLO D'ORIGINE (CSRF, forma A).

   Perché serve: il cookie di sessione è `SameSite=None` + `Secure` su
   `SESSION_DOMAIN` (`IbexConfig::sessionDomain()`, qui e nel bridge) — necessario perché IBEX
   vive in un iframe di TERZA PARTE sulla shell NC — e non esisteva alcun
   controllo di origine/referer/CSRF né qui né nei middleware. Qualunque sito
   poteva quindi innescare, coi cookie dell'utente, le azioni che cambiano stato.

   Sta QUI, subito dopo che `$action` è risolto e PRIMA di tutte e 17 le istanze
   di NextcloudAuthBridge: fallisce presto, prima di aprire PDO/Redis, ed è
   provabile con un `curl` senza sessione.

   Le tre misure che lo reggono (misura FETTA-C-FASE1, sui byte):
     · le richieste dell'editor sono SAME-ORIGIN — il documento dell'iframe è
       servito da IBEX stessa → l'origine attesa è la PROPRIA, non
       l'istanza Nextcloud configurata (che è il frame-ancestor, non il chiamante);
     · l'app non nomina mai il proprio host (0 occorrenze in `www/`)
       → l'origine attesa si deriva a runtime da `HTTP_HOST`;
     · nessun `Referrer-Policy` attivo: in `ibex-app` le uniche righe sono tutte
       COMMENTATE (`/config/nginx/ssl.conf:23-34`, misurato) → il `Referer`
       sopravvive same-origin. ⚠️ Se un giorno si scommenta `:29`
       (`Referrer-Policy "same-origin"`) il cancello REGGE lo stesso: quella
       direttiva toglie il Referer solo alle richieste CROSS-origin, e le nostre
       gatate sono tutte same-origin.
   ═══════════════════════════════════════════════════════════════════════════ */

/** True se la richiesta proviene dallo stesso host con cui il browser ha
 *  raggiunto IBEX. Puro: legge solo `$_SERVER`, nessun I/O, nessuna sessione.
 *  Passa se combacia ALMENO UNO fra `Origin` e `Referer` — così un `Origin: null`
 *  (iframe sandboxed, alcuni redirect) non rifiuta se il `Referer` è buono.
 *  Un sito terzo non può far combaciare nessuno dei due: entrambi li mette il
 *  browser, e il `Referer` non è forgiabile da un'altra origine. */
function ibex_csrf_same_origin(): bool {
    $host = $_SERVER['HTTP_HOST'] ?? '';
    if ($host === '') return false;
    $host = strtolower(explode(':', $host)[0]);        // solo host, senza porta
    if (!empty($_SERVER['HTTP_ORIGIN'])) {             // POST-fetch → Origin
        $o = parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_HOST);
        if ($o !== null && strtolower($o) === $host) return true;
    }
    if (!empty($_SERVER['HTTP_REFERER'])) {            // GET-fetch e navigazione interna
        $r = parse_url($_SERVER['HTTP_REFERER'], PHP_URL_HOST);
        if ($r !== null && strtolower($r) === $host) return true;
    }
    return false;                                      // né l'uno né l'altro → CSRF o anonima
}

/* Le 15 azioni che CAMBIANO STATO e partono dal browser.
   🔑 QUESTA LISTA È LA SICUREZZA: chi aggiunge una action di scrittura al router
   deve aggiungerla anche qui, o nasce già scoperta.
     · 12 POST-fetch same-origin → `Origin` sempre presente, costo zero;
     · `check_preview` / `check_status`: GET-fetch same-origin → `Referer`
       completo. ⚠️ `check_preview` NON è in sola lettura: consuma il canale
       Redis (`lPop`/`blPop`), per questo è qui e non fra le escluse;
     · `exit_project`: GET da TRE percorsi, tutti innescati DENTRO l'editor
       (fetch `scripts.blade.php:491`, anchor `header.blade.php:3`, click
       sintetico `:521`) → `Referer` = la pagina dell'editor. Un `<img>` o un
       link da fuori porta `Referer` estraneo o assente → 403. Non serve
       convertirlo a POST, ed è il motivo per cui il client non si tocca.

   FUORI dal cancello DI PROPOSITO (non dimenticanze):
     · `editor` — navigazione top-level (l'`src` dell'iframe messo dalla shell, o
       un deep-link): il suo `Referer` è `nextcloud` o assente → gatarlo
       impedirebbe di aprire l'editor. È già protetto dalla PROPRIETÀ (fetta ⓑ,
       `ProjectService::getProject`) e riapre solo un progetto tuo;
     · `create_empty_project` e `rename_project` — chiamati SERVER-TO-SERVER dal
       proxy NC via Guzzle (bridge `:93-102`, `index.php:285`): non hanno né
       `Origin` né `Referer` PER COSTRUZIONE. Il loro cancello non è l'origine,
       è il JWT firmato → FASE 2-bis. `create_empty_project` intanto resta
       POST-only (`:288-293`);
     · tutte le azioni in sola lettura — incluse `thumb` e `projects_status`, che
       la lobby NC chiama LEGITTIMAMENTE cross-origin (`Origin: nextcloud`):
       gatarle spegnerebbe anteprime e badge della lobby. */
$IBEX_CSRF_GATED = [
    'save_exit', 'save_session', 'bake_project', 'fast_transform', 'preview_bake',
    'save_snapshot', 'save_split', 'export_node_stl', 'import_files',
    'save_preset', 'delete_preset', 'heartbeat',
    'check_preview', 'check_status',
    'exit_project',
];
if (in_array($action, $IBEX_CSRF_GATED, true) && !ibex_csrf_same_origin()) {
    // Il rifiuto è RUMOROSO di proposito: un 403 muto su un flusso caldo sarebbe
    // indiagnosticabile. Qui si legge subito QUALE header mancava.
    error_log("[IBEX-CSRF] 403 action={$action} origin=" . ($_SERVER['HTTP_ORIGIN'] ?? '-')
            . " referer=" . ($_SERVER['HTTP_REFERER'] ?? '-')
            . " host=" . ($_SERVER['HTTP_HOST'] ?? '-'));
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'error' => 'CSRF: origine non consentita']);
    exit;
}

// 4. FAST LANE (File Serving & API - Bypass UI per Latenza Zero)
if ($action === 'serve_file') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new ProjectController(); 
        $controller->serve_file(); 
        exit;
    });
    exit;
}

if ($action === 'get_gn_meta') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $metaPath = '/appdata/ibex/assets/logic_gn/gn_meta.json';
        header('Content-Type: application/json');
        header('Cache-Control: no-store');
        if (file_exists($metaPath)) {
            readfile($metaPath);
        } else {
            echo json_encode(new \stdClass());
        }
        exit;
    });
    exit;
}

// 💎 FAST-LANE: TIER 1 TRANSFORM (no Blender)
if ($action === 'fast_transform') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new EditorController();
        $controller->fastTransform();
        exit;
    });
    exit;
}

// FAST-LANE: HEARTBEAT (presenza editor, 2026-07-22) — scrive ibex:presence:{pid}
// su ibex-redis (TTL 90s). Predisposizione: il janitor NON la consuma ancora.
if ($action === 'heartbeat') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new EditorController();
        $controller->heartbeat();
        exit;
    });
    exit;
}

// 💎 FAST-LANE: SAVE SNAPSHOT (SnapshotKeyed S2 — upload STL per tool destructive)
// Generico per sculpt, delete_topology. Il naming file dipende da (mesh_name,
// node_id); tool_id è solo diagnostico. Split_topology usa save_split (2 blob).
if ($action === 'save_snapshot') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new EditorController();
        $controller->saveSnapshot();
        exit;
    });
    exit;
}

// 💎 FAST-LANE: SAVE SPLIT (SnapshotKeyed S3 — upload 2 STL per split_topology)
// Contratto separato da save_snapshot perché multipart riceve 2 blob distinti
// (stl_blob_a + stl_blob_b) e il worker action SAVE_SPLIT li processa insieme
// atomicamente. File scritti: {stem}_snap_{nodeId}_A.stl + _B.stl.
if ($action === 'save_split') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new EditorController();
        $controller->saveSplit();
        exit;
    });
    exit;
}

// 💎 FAST-LANE: PREVIEW BAKE REAL-TIME
if ($action === 'preview_bake') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new EditorController();
        $controller->previewBake();
        exit;
    });
    exit;
}

if ($action === 'check_preview') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new EditorController();
        $controller->checkPreview();
        exit;
    });
    exit;
}

// 💎 FAST-LANE: PROJECTS STATUS (L7.1 baking, 2026-07-23) — badge di stato per la
// lobby NC (che parla col PROPRIO Redis e NON vede `project:*:status` di ibex-redis).
// Auth via bridge (jwt+json=1 → nc_uid): l'uid è SEMPRE quello firmato nel token,
// mai dalla richiesta. Sola lettura — nessuna scrittura su Redis/FS.
if ($action === 'projects_status') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new EditorController();
        $controller->projectsStatus();
        exit;
    });
    exit;
}

// 💎 FAST-LANE: LIST NEXTCLOUD DIRS — usato dal tree picker del nodo `export_stl`.
// Risponde con JSON {dirs:[...], path: '...'} delle sotto-cartelle dell'utente loggato.
// Sandbox: solo /data/nextcloud-storage/{nc_uid}/files/ + sotto. Path traversal blocked.
if ($action === 'list_nextcloud_dirs') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new EditorController();
        $controller->listNextcloudDirs();
        exit;
    });
    exit;
}

// 💎 FAST-LANE: IMPORT FILES (S5 «IBEX semplice» 2026-07-10) — importa STL da
// Nextcloud in un progetto esistente (File → Importa mesh). Accoda IMPORT_FILES.
if ($action === 'import_files') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new EditorController();
        $controller->importFiles();
        exit;
    });
    exit;
}

// 💎 FAST-LANE: RENAME PROJECT — aggiornamento inline del project_name dall'header.
if ($action === 'rename_project') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        // PUNTO4-FETTA-C-2BIS (2026-07-28) — passa se SAME-ORIGIN oppure JWT.
        // Rinomina dall'EDITOR = POST fetch same-origin (`scripts.blade.php:265`/`:451`) → passa
        // per l'origine. Rinomina dalla CARD DI LOBBY = S2S dal proxy `page#rename` (ramo
        // `old_name`, `?jwt=`+`json=1`) → niente Origin/Referer, passa per il JWT.
        // (Il nome dell'action è scritto a mano: qui vale sempre `rename_project`, e così la
        //  firma della closure resta INTATTA — il diff di questa fetta è puramente additivo.)
        if (!ibex_csrf_same_origin() && !NextcloudAuthBridge::$authViaJwt) {
            error_log("[IBEX-CSRF] 403 (2bis) action=rename_project origin=" . ($_SERVER['HTTP_ORIGIN'] ?? '-')
                    . " referer=" . ($_SERVER['HTTP_REFERER'] ?? '-'));
            http_response_code(403);
            header('Content-Type: application/json');
            echo json_encode(['success' => false, 'error' => 'CSRF: origine non consentita']);
            exit;
        }
        $controller = new EditorController();
        $controller->renameProject();
        exit;
    });
    exit;
}

// 💎 FAST-LANE: IBX2 THUMBNAIL — serve il PNG anteprima dal .ibex (opzione B).
// Auth via bridge (jwt+json=1 → nc_uid); progetto via fileid numerico (?f=),
// MAI il nome in query string. Decifra SOLO la thumb (THUMB_KEY), mai l'archive key.
if ($action === 'thumb') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new ProjectController();
        $controller->thumb();
        exit;
    });
    exit;
}

// 💎 FAST-LANE: EXPORT STL — copia mesh post-pipeline da preview/ a Nextcloud user dir.
// Copia e registrazione nella cache file di Nextcloud avvengono in una transazione:
// se la registrazione fallisce, il file copiato viene rimosso.
if ($action === 'export_node_stl') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) {
        $controller = new EditorController();
        $controller->exportNodeStl();
        exit;
    });
    exit;
}

// Preset DAG (2026-05-05) — fast-lane API per save/list/load/delete dei
// preset (sotto-grafi riutilizzabili). Privati: storage Nextcloud user.
// Pubblici: pool curato in /appdata/ibex/assets/presets_public/.
if ($action === 'save_preset' || $action === 'list_presets'
    || $action === 'load_preset' || $action === 'delete_preset') {
    $bridge = new NextcloudAuthBridge();
    $bridge->handle($_REQUEST, function($req) use ($action) {
        $controller = new EditorController();
        switch ($action) {
            case 'save_preset':   $controller->savePreset();   break;
            case 'list_presets':  $controller->listPresets();  break;
            case 'load_preset':   $controller->loadPreset();   break;
            case 'delete_preset': $controller->deletePreset(); break;
        }
        exit;
    });
    exit;
}

// 5. ROUTING UI STANDARD
$bridge = new NextcloudAuthBridge();
$frame  = new AllowNextcloudFrame();

$bridge->handle($_REQUEST, function($req) use ($frame, $action) {
    return $frame->handle($req, function($req) use ($action) {
        
        try {
            switch ($action) {
                // S7 PURGA (2026-07-10): new_project · store_project · list_projects ·
                // delete_project · close_project RIMOSSI (vecchia dashboard/lobby PHP).
                // Qualunque richiesta a quelle action cade nel default → 302 lobby NC.
                case 'create_empty_project':
                    // S6 hardening (2026-07-10): la creazione è POST-only — un GET
                    // (prefetch/anteprima/URL digitata/<img> di terzi) NON deve creare
                    // progetti. Il proxy NC page#create chiama in POST con json=1;
                    // il redirect jwt-strip del bridge converte POST→GET, quindi i
                    // flussi jwt-senza-json muoiono qui con 405 (hardening voluto).
                    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
                        http_response_code(405);
                        header('Content-Type: application/json');
                        echo json_encode(['success' => false, 'error' => 'Method Not Allowed: la creazione richiede POST']);
                        exit;
                    }
                    // PUNTO4-FETTA-C-2BIS (2026-07-28) — passa se SAME-ORIGIN oppure JWT.
                    // Nessun chiamante BROWSER legittimo: la creazione arriva solo dal proxy NC
                    // `page#create` (Guzzle, `?jwt=`+`json=1`). Il 405 qui sopra resta la PRIMA
                    // difesa (un GET muore ancora lì); questo è il secondo cancello.
                    if (!ibex_csrf_same_origin() && !NextcloudAuthBridge::$authViaJwt) {
                        error_log("[IBEX-CSRF] 403 (2bis) action={$action} origin=" . ($_SERVER['HTTP_ORIGIN'] ?? '-')
                                . " referer=" . ($_SERVER['HTTP_REFERER'] ?? '-'));
                        http_response_code(403);
                        header('Content-Type: application/json');
                        echo json_encode(['success' => false, 'error' => 'CSRF: origine non consentita']);
                        exit;
                    }
                    (new ProjectController())->storeEmpty();
                    break;
                case 'editor':         (new EditorController())->editor(); break;
                case 'check_status':   (new EditorController())->checkStatus(); break;
                case 'bake_project':   (new EditorController())->bakeProject(); break;
                case 'save_exit':      (new EditorController())->saveExit(); break;
                
                case 'exit_project':   (new ProjectController())->exit_safe(); break;

                case 'save_session':   (new EditorController())->saveSession(); break;
                case 'final_export':   http_response_code(404); exit; // export .ibex rimosso (cifratura a riposo)

                // S6 Q5 + S7: la casa è la lobby NC (ibex_workspace).
                default:
                    $lobby = IbexConfig::lobbyUrl();
                    if ($lobby === '') { http_response_code(500); echo 'NEXTCLOUD_URL non configurato'; exit; }
                    header("Location: $lobby"); exit;
            }
        } catch (\Throwable $e) {
            echo "<div style='background:#fff; color:#f00; padding:20px; font-family:sans-serif; border:2px solid red; border-radius:10px;'>";
            echo "<h1>IBEX SYSTEM ERROR</h1>";
            echo "<p><strong>Action:</strong> " . htmlspecialchars($action) . "</p>";
            echo "<p>" . htmlspecialchars($e->getMessage()) . "</p>";
            echo "</div>";
            exit;
        }
    });
});