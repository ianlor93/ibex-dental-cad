<?php
namespace App\Http\Controllers;

use PDO;
use Redis;
use Exception;
use App\Core\UserContext;
use App\Core\ProjectRegistry;
use App\Core\IbexConfig;
use App\Services\ProjectService;

// S8 (2026-07-10): rimossi use TierManager (mai usato nel corpo) e la coppia
// morta serveFile()+FileService.
class EditorController {
    private PDO $db;
    private Redis $redis;
    private ProjectService $projectService;

    public function __construct() {
        $host = getenv('DB_HOST'); $dbname = getenv('DB_NAME'); $user = getenv('DB_USER'); $pass = getenv('DB_PASS');
        try {
            $this->db = new PDO("mysql:host=$host;dbname=$dbname;charset=utf8mb4", $user, $pass);
            $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $this->redis = new Redis();
            $this->redis->connect(IbexConfig::redisHost(), 6379, 2.5);
            $rp = getenv('IBEX_REDIS_PASS'); if ($rp) { $this->redis->auth($rp); }
        } catch (Exception $e) { die("System Error: " . $e->getMessage()); }

        $this->projectService = new ProjectService($this->db, $this->redis);
    }

    // PRESENZA (heartbeat, 2026-07-22): l'editor batte ogni ~30s finche' e' vivo.
    // Scrive ibex:presence:{pid} (TTL 90s) su ibex-redis. NESSUN altro effetto —
    // predisposizione: il janitor non la consuma ancora. A/B intatti, niente D1.
    public function heartbeat(): void {
        session_write_close();
        header('Content-Type: application/json');
        $id  = $_POST['id']        ?? null;
        $uid = $_SESSION['nc_uid'] ?? null;
        if (!$id || !$uid || !ctype_digit((string)$id)) {
            echo json_encode(['ok' => false]);
            exit;
        }
        $pid = (int)$id;
        // PUNTO4-FETTA-B — cancello di proprietà PRIMA del setEx.
        // `ibex:presence:{pid}` porta dentro l'uid del CHIAMANTE: senza cancello chiunque
        // poteva dichiararsi «presente» sul progetto di un altro. Oggi è latente (nessuno
        // consuma la chiave), ma il consumatore previsto è il TERZO SEGNALE del janitor —
        // e a quel punto una presenza falsa impedirebbe la purga di `active/` altrui.
        // La regola è «al consumo verificare uid==owner»: il controllo va messo
        // PRIMA della scrittura, non prima della lettura, o la chiave nasce già sporca.
        // La risposta è la STESSA del ramo auth (`ok:false`), di proposito: un errore
        // distinto direbbe al chiamante se quel pid esiste. O(1) sul caldo (FONTE A).
        if (!$this->_ownsProject($uid, $pid)) {
            echo json_encode(['ok' => false]);
            exit;
        }
        $this->redis->setEx("ibex:presence:{$pid}", 90, json_encode(['uid' => $uid, 'ts' => time()]));
        echo json_encode(['ok' => true]);
        exit;
    }

    /* ─────────────────────────────────────────────────────────────────────────
       L7.1 (2026-07-23) — STATO PROGETTI per la lobby NC (badge «baking»).
       SOLA LETTURA: zero scritture su Redis/FS. L'uid arriva SEMPRE dal JWT via
       NextcloudAuthBridge ($_SESSION['nc_uid']), MAI da $_GET/$_POST — nessun
       nome/pid arbitrario dalla richiesta.

       Perché vive qui e non su Nextcloud (recon L7.0): NC parla col PROPRIO Redis
       (`redis`), ibex-app e i worker con `ibex-redis`. La lobby NC non vede lo
       stato dei progetti → deve essere ibex-app a esporlo.

       A riposo `project:{pid}:status` NON esiste (TTL 1h): lo stato non si può
       leggere dal solo Redis. `ready`/`archived` si derivano dal FS delle copie
       di lavoro su NVMe (`active/{uid}/{pid}` esiste ⟺ progetto «caldo»).

       LOGICA CANONICA (priorità dall'alto):
         1. baking   — pid in coda (`ibex_tasks`|`ibex_tasks_pipeline`)
                       · OPPURE status ∈ {queued, initializing, baking}
                       · OPPURE `ibex_lock_{pid}` esiste
         2. error    — status == 'error' OPPURE `project:{pid}:error` esiste
         3. ready    — esiste la dir `active/{uid}/{pid}`
         4. archived — freddo: il progetto vive solo come `.ibex`
       I valori Redis `baked`/`ready`/`active` NON sono un badge a sé: se il
       progetto è caldo cadono in `ready`, se è stato purgato in `archived`.
       ───────────────────────────────────────────────────────────────────────── */
    public function projectsStatus(): void {
        session_write_close();
        header('Content-Type: application/json');
        header('Cache-Control: no-store');

        $uid = $_SESSION['nc_uid'] ?? null;
        if (!$uid) {
            http_response_code(401);
            echo json_encode(['error' => 'non autenticato']);
            exit;
        }

        // Progetti dell'utente: nome → pid (registry Redis, de-DB).
        $name2pid = $this->redis->hGetAll("ibex:name2pid:{$uid}");
        if (!is_array($name2pid) || !$name2pid) {
            echo json_encode(['projects' => new \stdClass(), 'ts' => time()]);
            exit;
        }
        $pids = [];
        foreach ($name2pid as $nm => $p) { $pids[(string)$nm] = (int)$p; }

        // UNA lettura della coda per TUTTI i progetti (non una per pid).
        $queued = [];
        foreach (['ibex_tasks', 'ibex_tasks_pipeline'] as $q) {
            $rows = $this->redis->lRange($q, 0, -1);
            if (!is_array($rows)) { continue; }
            foreach ($rows as $raw) {
                $t = json_decode((string)$raw, true);
                if (is_array($t) && isset($t['project_id'])) {
                    $queued[(int)$t['project_id']] = true;
                }
            }
        }

        // status + lock + error + burn di ogni pid in UNA pipeline (4 comandi per pid).
        // L7.5.2: il burn viaggia in una mappa PARALLELA (vedi sotto) — `projects` resta
        // nome→stringa com'era in L7.1, così una shell vecchia continua a funzionare.
        $pipe = $this->redis->multi(Redis::PIPELINE);
        foreach ($pids as $pid) {
            $pipe->get("project:{$pid}:status");
            $pipe->exists("ibex_lock_{$pid}");
            $pipe->exists("project:{$pid}:error");
            $pipe->get("ibex:burn:{$pid}");
        }
        $res = $pipe->exec();
        if (!is_array($res)) { $res = []; }

        $out   = [];
        $burns = [];
        $i = 0;
        foreach ($pids as $name => $pid) {
            $st      = $res[$i] ?? false;          // string | false
            $hasLock = !empty($res[$i + 1]);
            $hasErr  = !empty($res[$i + 2]);
            $burnRaw = $res[$i + 3] ?? false;      // L7.5.2
            $i += 4;
            $st = is_string($st) ? $st : '';

            // L7.5.2 — sintesi burn. Emessa SOLO se ben formata e non vuota: la card
            // ha il gate `p.burn.n > 0`, quindi un valore sporco non deve arrivarci.
            // IBEX-GEN3-28-7 (sessione B) — TERZA sede. Se `ibex:burn:{pid}` MANCA
            // (ibex-redis gira `--appendonly no` e SENZA volume: un recreate la azzera)
            // il record si legge dall'header IBX2 gen-3 del `.ibex`, che è durevole
            // E leggibile dal tier web. Il ramo scatta SOLO sull'ASSENZA della chiave,
            // mai sul suo contenuto: con Redis popolata il comportamento resta identico
            // a prima byte per byte, e non c'è un solo accesso a disco in più.
            $b = (is_string($burnRaw) && $burnRaw !== '')
                ? json_decode($burnRaw, true)
                : $this->_burnFromHeader($uid, (string)$name, (int)$pid);
            if (is_array($b)) {
                if (is_array($b) && !empty($b['n']) && !empty($b['meshes']) && is_array($b['meshes'])) {
                    $burns[$name] = ['n' => (int)$b['n'], 'meshes' => array_values($b['meshes'])];
                    // IBEX-EXPORT-27-7 — `files`: mappa nome_di_scena → ultimo filename di
                    // esportazione. Propagata SOLO se presente e non vuota, così un record
                    // vecchio resta byte-identico a prima: la firma di dedup del poll lato
                    // shell non cambia e non provoca re-render spuri.
                    $bFiles = [];
                    foreach ((array)($b['files'] ?? []) as $k => $v) {
                        if (is_string($k) && is_string($v) && $k !== '' && $v !== '') $bFiles[$k] = $v;
                    }
                    if ($bFiles) { $burns[$name]['files'] = $bFiles; }
                }
            }

            if (isset($queued[$pid])
                || in_array($st, ['queued', 'initializing', 'baking'], true)
                || $hasLock) {
                $badge = 'baking';
            } elseif ($st === 'error' || $hasErr) {
                $badge = 'error';
            } elseif (is_dir(ProjectService::ACTIVE_BASE . "/{$uid}/{$pid}")) {
                $badge = 'ready';
            } else {
                $badge = 'archived';
            }
            $out[$name] = $badge;
        }

        echo json_encode([
            'projects' => $out   ?: new \stdClass(),
            'burns'    => $burns ?: new \stdClass(),   // L7.5.2 — mappa parallela, additiva
            'ts'       => time(),
        ]);
        exit;
    }

    private function getCategorizedTools() {
        $csvPath = '/appdata/ibex/assets/tools_catalog.csv';
        $categories = [];
        
        if (!file_exists($csvPath)) return [];

        if (($handle = fopen($csvPath, "r")) !== FALSE) {
            $line1 = fgets($handle); rewind($handle);
            $delimiter = (strpos($line1, ';') !== false) ? ';' : ',';
            $header = fgetcsv($handle, 1000, $delimiter);
            $header = array_map(function($h) { return trim(preg_replace('/[\x00-\x1F\x80-\xFF]/', '', $h)); }, $header);

            while (($data = fgetcsv($handle, 1000, $delimiter)) !== FALSE) {
                if (count($header) !== count($data)) continue;
                $row = array_combine($header, array_map('trim', $data));
                
                $params = [];
                if (!empty($row['params_json'])) {
                    $json = str_replace("'", '"', $row['params_json']);
                    $params = json_decode($json, true) ?: [];
                }
                
                $tool = [
                    'id' => $row['slug'],
                    'name' => $row['display_name'],
                    'type' => $row['tech_type'],
                    'source' => $row['source_file'],
                    'icon' => $this->getIconForType($row['tech_type']),
                    'params' => $params
                ];
                
                $catName = $row['category'] ?? 'Altro';
                if (!isset($categories[$catName])) $categories[$catName] = [];
                $categories[$catName][] = $tool;
            }
            fclose($handle);
        }
        return $categories;
    }

    private function getIconForType($type) {
        return match($type) { 'PY' => '⚡', 'GN' => '🧬', 'FAST' => '⚡', 'EXP' => '💾', default => '🔧' };
    }

    /**
     * Render della loading page server-side per status `queued`/`baking`/
     * `initializing`. Allineato al loading-overlay del client (ClinicalLight
     * V1: spinner 96×96 doppio anello + label 10px tracking-widest uppercase,
     * bg #f5f5f3, font Ubuntu). Sostituisce le vecchie pagine `background:#111`
     * con riferimenti a "Blender" (rimosso 2026-05-12 — IBEX è il brand,
     * Blender è dettaglio implementativo interno non user-facing).
     */
    private function _renderLoadingPage(string $msg, int $refreshSec = 2): void {
        $msgEsc = htmlspecialchars($msg, ENT_QUOTES, 'UTF-8');
        echo <<<HTML
<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="{$refreshSec}">
<title>IBEX</title>
<link rel="stylesheet" href="/static/css/ibex-fonts.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#f5f5f3;color:#1a1a1a;font-family:'Ubuntu',system-ui,sans-serif}
.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh}
.spinner{position:relative;width:96px;height:96px;margin-bottom:32px}
.spinner-bg,.spinner-fg{position:absolute;inset:0;border:4px solid;border-radius:50%}
.spinner-bg{border-color:#e6e4e1}
.spinner-fg{border-color:#FF6E4A;border-top-color:transparent;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.msg{font-size:10px;text-transform:uppercase;letter-spacing:0.2em;color:#888;font-weight:500}
</style>
</head>
<body>
<div class="loading">
<div class="spinner"><div class="spinner-bg"></div><div class="spinner-fg"></div></div>
<p class="msg">{$msgEsc}</p>
</div>
</body>
</html>
HTML;
    }

    /**
     * Render della error page server-side. Stesso look della loading page
     * (palette ClinicalLight, font Ubuntu, no riferimenti tecnici "Blender")
     * ma senza spinner — invece mostra titolo accent + corpo + link ritorno.
     * Usato per stati irrecuperabili (status='error') dove l'utente deve
     * tornare alla lista progetti.
     */
    private function _renderErrorPage(string $title, string $body): void {
        $lobby = IbexConfig::lobbyUrl();
        if ($lobby === '') { http_response_code(500); echo 'NEXTCLOUD_URL non configurato'; return; }
        $lobbyEsc = htmlspecialchars($lobby, ENT_QUOTES, 'UTF-8');
        $titleEsc = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
        // $body può contenere HTML semplice (es. <code>): NON escapare.
        echo <<<HTML
<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<title>IBEX</title>
<link rel="stylesheet" href="/static/css/ibex-fonts.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#f5f5f3;color:#1a1a1a;font-family:'Ubuntu',system-ui,sans-serif}
.err{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:20px;padding:0 32px;text-align:center;max-width:520px;margin:0 auto}
.err h1{font-size:13px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:#FF6E4A}
.err p{font-size:13px;line-height:1.6;color:#666;font-weight:400}
.err code{font-family:'Ubuntu Mono',monospace;font-size:12px;background:#ebeae7;padding:2px 6px;border-radius:3px;color:#1a1a1a}
.err a{font-size:11px;text-transform:uppercase;letter-spacing:0.18em;color:#1a1a1a;text-decoration:none;border:1px solid #cccac8;padding:9px 18px;border-radius:3px;transition:all .15s}
.err a:hover{border-color:#FF6E4A;color:#FF6E4A}
</style>
</head>
<body>
<div class="err">
<h1>{$titleEsc}</h1>
{$body}
<a href="{$lobbyEsc}" target="_top">&larr; Torna ai progetti</a>
</div>
</body>
</html>
HTML;
    }

    /**
     * S6 igiene JSON (2026-07-10) — json_decode(,true) collassa {} vuoto in []
     * e json_encode lo riscrive come LISTA: Drawflow importerebbe la mappa nodi
     * come Array → addNode crea buchi → export [null,…] → extractDAG crash
     * (bug PhpJsonFix, blindato anche client-side in StackManager V3.65).
     * Riconverte gli [] VUOTI in stdClass sulle sole chiavi-dizionario note.
     * MAI usare JSON_FORCE_OBJECT (romperebbe le liste vere: stack, input_files,
     * splines, tool_execution_order, snapshot_nodes). Sicuro perché i dict
     * non-vuoti hanno sempre chiavi stringa (node-id Drawflow parte da "1",
     * visuals/mesh_state keyed per filename) → json_encode li rende già oggetti.
     */
    /**
     * 1b (de-DB, 2026-07-20): conta i NODI reali del DAG in una sessione.
     * È il GUARD della riconciliazione: dice se una fonte ha contenuto, non se
     * il contenitore esiste. Tollera ogni forma malformata (ritorna 0).
     */
    /**
     * de-DB ownership: l'uid possiede il pid se active/{uid}/{id} esiste (path uid-scoped)
     * o se il registry Redis lo conferma. Rimpiazza le SELECT ... WHERE id AND nc_uid.
     */
    private function _ownsProject(string $uid, int $id): bool {
        if (is_dir("/appdata/ibex/active/$uid/$id")) return true;       // FONTE A — filesystem
        $owner = ProjectRegistry::ownerOf($this->redis, $id);           // FONTE B — registry Redis
        if ($owner !== null) return ($owner === $uid);
        // ── FONTE C (PUNTO4-FETTA-B, 2026-07-28) ──────────────────────────────────
        // Qui c'era `: false`. Era un fail-closed che chiudeva fuori il PROPRIETARIO:
        // A è falsa per OGNI progetto freddo (SAVE_EXIT e janitor purgano `active/`), e
        // B è muta ogni volta che ibex-redis viene ricreata (`--appendonly no`, nessun
        // volume) finché `_registry_rebuild` non riparte — e riparte solo al BOOT di un
        // worker, non a comando. In quello stato «non lo so» veniva letto come «non sei
        // tu». C interroga la sede che sopravvive a tutto: l'header dei suoi `.ibex`.
        return $this->_ownsByArchiveHeader($uid, $id);
    }

    /**
     * FONTE C (PUNTO4-FETTA-B, 2026-07-28) — il pid è fra i `.ibex` di QUESTO utente?
     *
     * Perché non può mai dire «sì» per il progetto di un altro: si enumera SOLO la
     * cartella IBEX di `$uid` — che arriva dalla SESSIONE, mai dalla richiesta — e i pid
     * sono globalmente unici (`ProjectRegistry::allocatePid` = INCR). Un pid trovato lì
     * dentro è necessariamente suo.
     *
     * Nel path non entra NESSUN componente controllato dal client → nessun traversal.
     * Il nome non si COMPONE: si enumera con `glob` e il pid si legge dall'header, perché
     * il filename non porta il pid (`ProjectRegistry:11`, `worker.py:77`). Il `realpath`
     * in testa è difesa in profondità, stesso spirito di `_burnFromHeader`. `$uid` passa
     * dalla whitelist del bridge (`NextcloudAuthBridge:78`, `[a-zA-Z0-9._@-]`) che esclude
     * i metacaratteri di `glob` — stesso presupposto di `ProjectRegistry::nextUntitled`.
     *
     * COSTO: paga SOLO sul ramo freddo (A falsa E B muta). Sul percorso caldo A o B
     * rispondono e questo metodo non viene nemmeno chiamato. O(n° `.ibex` di quell'utente),
     * 9 byte letti per file, nessun decrypt, nessuna chiave, nessuna `stat` per byte.
     */
    private function _ownsByArchiveHeader(string $uid, int $id): bool {
        if ($uid === '' || $id <= 0) return false;
        try {
            $dir = realpath("/data/nextcloud-storage/{$uid}/files/IBEX");
            if ($dir === false || !is_dir($dir)) return false;
            foreach (glob($dir . '/*.ibex') ?: [] as $f) {
                if (\App\Core\IbexThumb::readProjectId($f) === $id) return true;
            }
        } catch (\Throwable $e) {
            // Disco/permessi → degrada a «non lo so» = no. Mai un 500 da un predicato.
        }
        return false;
    }

    /** de-DB: project_name di un pid — dal manifest caldo, altrimenti dal registry. */
    private function _projectName(string $uid, int $id): ?string {
        $mp = "/appdata/ibex/active/$uid/$id/manifest.json";
        if (is_file($mp)) {
            $m = json_decode(@file_get_contents($mp), true) ?: [];
            if (!empty($m['project_name'])) return $m['project_name'];
        }
        $meta = ProjectRegistry::meta($this->redis, $id);
        return $meta['name'] ?? null;
    }

    private function _sessionNodeCount($session): int {
        if (!is_array($session)) return 0;
        $data = $session['ui_graph']['drawflow']['Home']['data'] ?? null;
        return is_array($data) ? count($data) : 0;
    }

    private function _normalizeSessionDicts($session) {
        if (!is_array($session)) return $session;
        foreach (['visuals', 'mesh_state'] as $k) {
            if (array_key_exists($k, $session) && $session[$k] === []) {
                $session[$k] = new \stdClass();
            }
        }
        if (isset($session['last_bake']) && is_array($session['last_bake'])) {
            foreach (['params', 'applied_matrices'] as $k) {
                if (array_key_exists($k, $session['last_bake']) && $session['last_bake'][$k] === []) {
                    $session['last_bake'][$k] = new \stdClass();
                }
            }
        }
        if (isset($session['ui_graph']['drawflow']) && is_array($session['ui_graph']['drawflow'])) {
            foreach ($session['ui_graph']['drawflow'] as $m => $mod) {
                if (!is_array($mod) || !array_key_exists('data', $mod)) continue;
                if ($mod['data'] === []) {
                    $session['ui_graph']['drawflow'][$m]['data'] = new \stdClass();
                    continue;
                }
                if (!is_array($mod['data'])) continue;
                foreach ($mod['data'] as $nid => $node) {
                    if (!is_array($node) || !isset($node['data']) || !is_array($node['data'])) continue;
                    foreach (['params', 'paramsConfig', 'preview_baked_params'] as $nk) {
                        if (array_key_exists($nk, $node['data']) && $node['data'][$nk] === []) {
                            $session['ui_graph']['drawflow'][$m]['data'][$nid]['data'][$nk] = new \stdClass();
                        }
                    }
                }
            }
        }
        return $session;
    }

    public function saveSnapshot() {
        // ═══════════════════════════════════════════════════════════════
        // saveSnapshot — persistenza snapshot mesh client-side (generico).
        //
        // SnapshotKeyed Session 2 (2026-04-24): rename da saveSculpt.
        // Handler generico per tutti i tool destructive (sculpt, delete_topology,
        // futuri split_topology). Il file è keyed per (mesh_name, node_id); il
        // tool_id è solo diagnostico.
        //
        // Contratto client → server (multipart POST):
        //   id            — project_id
        //   mesh_name     — es. "Upper.stl" (basename con .stl, no path traversal)
        //   node_id       — ID Drawflow del nodo destructive (es. "5"). Whitelist regex.
        //                   Se assente: fallback legacy (sessioni browser pre-S1).
        //   tool_id       — es. "sculpt" | "delete_topology". Whitelist. Solo logging.
        //   stl_blob      — file STL binario serializzato da STLExporter({binary:true})
        //
        // Flusso:
        //   1. Auth + ownership check (nc_uid match)
        //   2. Valida mesh_name (regex), valida node_id + tool_id (whitelist) se presenti
        //   3. Valida upload (UPLOAD_ERR_OK, size ≥ 134B)
        //   4. move_uploaded_file → active_path/{stem}_snap_{nodeId}.stl.tmp
        //      (fallback legacy: {stem}_sculpted.stl.tmp)
        //   5. rPush task SAVE_SNAPSHOT a Redis con node_id + tool_id + blPop (30s)
        //   6. Ritorna JSON con success/error dal worker
        //
        // Canale risposta dedicato: snapshot_resp_{uid}_{pid} (non interferisce
        // col polling preview_resp_* di BakeEngine).
        // ═══════════════════════════════════════════════════════════════
        session_write_close();
        header('Content-Type: application/json');

        $id       = $_POST['id']        ?? null;
        $uid      = $_SESSION['nc_uid'] ?? null;
        $meshName = $_POST['mesh_name'] ?? '';
        $nodeId   = $_POST['node_id']   ?? null;
        $toolId   = $_POST['tool_id']   ?? null;

        if (!$id || !$uid || !ctype_digit((string)$id)) {
            echo json_encode(['success' => false, 'error' => 'Dati Auth mancanti.']);
            exit;
        }

        // Whitelist mesh_name: solo caratteri safe + .stl finale, no path traversal
        if (!preg_match('/^[A-Za-z0-9 _.\-()]+\.stl$/i', $meshName)) {
            echo json_encode(['success' => false, 'error' => 'mesh_name invalido']);
            exit;
        }

        // Whitelist node_id: alfanumerico + underscore + trattino (Drawflow IDs)
        // Stessa regex del worker (_NODE_ID_RX in fast_transform.py).
        if ($nodeId !== null && $nodeId !== '' && !preg_match('/^[A-Za-z0-9_\-]+$/', (string)$nodeId)) {
            echo json_encode(['success' => false, 'error' => 'node_id invalido']);
            exit;
        }
        if ($nodeId === '') $nodeId = null;

        // Whitelist tool_id: stessa regex (solo alfanumerico+underscore+trattino).
        // Diagnostico, non impatta il naming file. Null-safe.
        if ($toolId !== null && $toolId !== '' && !preg_match('/^[A-Za-z0-9_\-]+$/', (string)$toolId)) {
            echo json_encode(['success' => false, 'error' => 'tool_id invalido']);
            exit;
        }
        if ($toolId === '') $toolId = null;

        // Ownership check
        try {
            if (!$this->_ownsProject($uid, (int)$id)) {
                echo json_encode(['success' => false, 'error' => 'Progetto non trovato o non autorizzato']);
                exit;
            }
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'error' => 'DB error: ' . $e->getMessage()]);
            exit;
        }

        // Valida upload
        if (!isset($_FILES['stl_blob']) || $_FILES['stl_blob']['error'] !== UPLOAD_ERR_OK) {
            $err = $_FILES['stl_blob']['error'] ?? 'missing';
            echo json_encode(['success' => false, 'error' => "Upload STL fallito (err={$err})"]);
            exit;
        }
        $uploaded = $_FILES['stl_blob'];
        if ($uploaded['size'] < 134) {
            echo json_encode(['success' => false, 'error' => 'STL troppo piccolo (< 134 byte)']);
            exit;
        }

        $activePath = "/appdata/ibex/active/{$uid}/{$id}";
        if (!is_dir($activePath)) {
            echo json_encode(['success' => false, 'error' => 'active_path non esistente — apri prima l\'editor']);
            exit;
        }

        $stem = pathinfo($meshName, PATHINFO_FILENAME);
        // Nuovo schema: {stem}_snap_{nodeId}.stl. Fallback legacy: {stem}_sculpted.stl
        // (solo per client browser con JS cached pre-S1 che non invia node_id).
        if ($nodeId !== null) {
            $tmpPath = "{$activePath}/{$stem}_snap_{$nodeId}.stl.tmp";
        } else {
            $tmpPath = "{$activePath}/{$stem}_sculpted.stl.tmp";
        }

        if (!move_uploaded_file($uploaded['tmp_name'], $tmpPath)) {
            echo json_encode(['success' => false, 'error' => 'Scrittura tmp file fallita']);
            exit;
        }

        // GodMethod 2026-07-29 -> _ingestSelectionBlob (ex righe 549-594)
        $this->_ingestSelectionBlob($activePath, $stem, $nodeId, $tmpPath);

        // GodMethod 2026-07-29 -> _ingestCurveBlob (ex righe 596-648)
        $this->_ingestCurveBlob($activePath, $stem, $nodeId, $tmpPath);

        // GodMethod 2026-07-29 -> _dispatchSnapshotTask (ex righe 650-673)
        $this->_dispatchSnapshotTask($uid, $id, $meshName, $nodeId, $toolId);
        exit;
    }

    // ─────────────────────────────────────────────────────────────
    // GodMethod 2026-07-29 — estratto VERBATIM da saveSnapshot() (righe 549-594 del
    // file pre-refactor, md5 23207eaba48208af6147d70ae132ae1a).
    // Il corpo qui sotto e' BYTE-IDENTICO all'originale: i parametri portano
    // gli STESSI nomi dei locali di partenza, quindi non una riga e' riscritta.
    // La condizione `if` e' DENTRO il blocco migrato: la chiamata e' incondizionata,
    // esattamente come lo era il raggiungimento di quell'`if`. Gli `exit` interni
    // terminano lo script da qui come facevano da li'.
    // ─────────────────────────────────────────────────────────────
    private function _ingestSelectionBlob($activePath, $stem, $nodeId, $tmpPath): void {
        // topology_rebuild V1.0 (2026-05-05): se l'upload include anche
        // `selection_blob` (JSON con face_indices della selezione utente), lo
        // valida + lo scrive accanto come `{stem}_snap_{nodeId}.sel.json.tmp`.
        // Il worker SAVE_SNAPSHOT lo rinomina insieme alla mesh atomicamente.
        // Optional: senza selection_blob, lo snapshot resta single-file (sculpt
        // / delete_topology / split_topology — il loro flow è invariato).
        if ($nodeId !== null
            && isset($_FILES['selection_blob'])
            && $_FILES['selection_blob']['error'] === UPLOAD_ERR_OK) {
            $selUpload = $_FILES['selection_blob'];
            // Cap difensivo: 10MB di JSON = ~1.5M face indices, ben oltre
            // qualsiasi mesh dentale realistica
            if ($selUpload['size'] > 10 * 1024 * 1024) {
                @unlink($tmpPath);
                echo json_encode(['success' => false, 'error' => 'selection_blob troppo grande (max 10MB)']);
                exit;
            }
            // Parse + valida struttura {face_indices: [int, ...]}
            $rawSel = @file_get_contents($selUpload['tmp_name']);
            $parsed = $rawSel ? json_decode($rawSel, true) : null;
            if (!is_array($parsed) || !isset($parsed['face_indices']) || !is_array($parsed['face_indices'])) {
                @unlink($tmpPath);
                echo json_encode(['success' => false, 'error' => 'selection_blob JSON invalido (atteso {face_indices: [int, ...]})']);
                exit;
            }
            // Filtra solo interi non-negativi (no validazione max — il worker
            // re-valida contro n_faces della mesh effettivamente caricata)
            $cleanIndices = [];
            foreach ($parsed['face_indices'] as $fi) {
                if (is_int($fi) && $fi >= 0) {
                    $cleanIndices[] = $fi;
                }
            }
            if (empty($cleanIndices)) {
                @unlink($tmpPath);
                echo json_encode(['success' => false, 'error' => 'selection_blob non contiene face_indices validi']);
                exit;
            }
            $selTmpPath = "{$activePath}/{$stem}_snap_{$nodeId}.sel.json.tmp";
            $clean = json_encode(['face_indices' => $cleanIndices]);
            if (file_put_contents($selTmpPath, $clean) === false) {
                @unlink($tmpPath);
                echo json_encode(['success' => false, 'error' => 'Scrittura selection tmp fallita']);
                exit;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // GodMethod 2026-07-29 — estratto VERBATIM da saveSnapshot() (righe 596-648 del
    // file pre-refactor, md5 23207eaba48208af6147d70ae132ae1a).
    // Il corpo qui sotto e' BYTE-IDENTICO all'originale: i parametri portano
    // gli STESSI nomi dei locali di partenza, quindi non una riga e' riscritta.
    // Idem: `if` incluso nel blocco, chiamata incondizionata.
    // ─────────────────────────────────────────────────────────────
    private function _ingestCurveBlob($activePath, $stem, $nodeId, $tmpPath): void {
        // draw_curve V1.0 (2026-05-06): se l'upload include `curve_blob`
        // (JSON con schema `{splines: [{control_points, cyclic}, ...]}`), lo
        // valida + scrive accanto come `{stem}_snap_{nodeId}.crv.json.tmp`.
        // Il worker SAVE_SNAPSHOT lo rinomina insieme alla mesh atomicamente.
        if ($nodeId !== null
            && isset($_FILES['curve_blob'])
            && $_FILES['curve_blob']['error'] === UPLOAD_ERR_OK) {
            $crvUpload = $_FILES['curve_blob'];
            // Cap difensivo: 5MB di JSON = ~50k control points totali
            if ($crvUpload['size'] > 5 * 1024 * 1024) {
                @unlink($tmpPath);
                @unlink("{$activePath}/{$stem}_snap_{$nodeId}.sel.json.tmp"); // cleanup parallelo
                echo json_encode(['success' => false, 'error' => 'curve_blob troppo grande (max 5MB)']);
                exit;
            }
            $rawCrv = @file_get_contents($crvUpload['tmp_name']);
            $parsedCrv = $rawCrv ? json_decode($rawCrv, true) : null;
            if (!is_array($parsedCrv) || !isset($parsedCrv['splines']) || !is_array($parsedCrv['splines'])) {
                @unlink($tmpPath);
                @unlink("{$activePath}/{$stem}_snap_{$nodeId}.sel.json.tmp");
                echo json_encode(['success' => false, 'error' => 'curve_blob JSON invalido (atteso {splines: [...]})']);
                exit;
            }
            // Filtra splines validi: control_points deve essere lista di
            // [x,y,z] numerici, cyclic boolean
            $cleanSplines = [];
            foreach ($parsedCrv['splines'] as $sp) {
                if (!is_array($sp) || !isset($sp['control_points']) || !is_array($sp['control_points'])) continue;
                $cleanCps = [];
                foreach ($sp['control_points'] as $cp) {
                    if (is_array($cp) && count($cp) === 3
                        && is_numeric($cp[0]) && is_numeric($cp[1]) && is_numeric($cp[2])) {
                        $cleanCps[] = [(float)$cp[0], (float)$cp[1], (float)$cp[2]];
                    }
                }
                if (count($cleanCps) >= 2) {
                    $cleanSplines[] = [
                        'control_points' => $cleanCps,
                        'cyclic' => !empty($sp['cyclic'])
                    ];
                }
            }
            // Anche se 0 splines validi, scriviamo il file (datablock vuoto è
            // legittimo — l'utente può aver cancellato tutte le curve).
            $crvTmpPath = "{$activePath}/{$stem}_snap_{$nodeId}.crv.json.tmp";
            $cleanCrv = json_encode(['splines' => $cleanSplines]);
            if (file_put_contents($crvTmpPath, $cleanCrv) === false) {
                @unlink($tmpPath);
                @unlink("{$activePath}/{$stem}_snap_{$nodeId}.sel.json.tmp");
                echo json_encode(['success' => false, 'error' => 'Scrittura curve tmp fallita']);
                exit;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // GodMethod 2026-07-29 — estratto VERBATIM da saveSnapshot() (righe 650-673 del
    // file pre-refactor, md5 23207eaba48208af6147d70ae132ae1a).
    // Il corpo qui sotto e' BYTE-IDENTICO all'originale: i parametri portano
    // gli STESSI nomi dei locali di partenza, quindi non una riga e' riscritta.
    // L'`exit;` finale NON e' qui: resta in saveSnapshot, dove era.
    // ─────────────────────────────────────────────────────────────
    private function _dispatchSnapshotTask($uid, $id, $meshName, $nodeId, $toolId): void {
        $responseChannel = "snapshot_resp_{$uid}_{$id}";

        try {
            $this->redis->del($responseChannel);
            $taskPayload = [
                'action'           => 'SAVE_SNAPSHOT',
                'uid'              => $uid,
                'project_id'       => $id,
                'mesh_name'        => $meshName,
                'response_channel' => $responseChannel,
            ];
            if ($nodeId !== null) $taskPayload['node_id'] = $nodeId;
            if ($toolId !== null) $taskPayload['tool_id'] = $toolId;
            $this->redis->rPush('ibex_tasks', json_encode($taskPayload));

            $blocked = $this->redis->blPop([$responseChannel], 30);
            if (is_array($blocked) && count($blocked) >= 2) {
                echo $blocked[1];
            } else {
                echo json_encode(['success' => false, 'error' => 'Timeout worker (30s)']);
            }
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'error' => $e->getMessage()]);
        }
    }

    public function saveSplit() {
        // ═══════════════════════════════════════════════════════════════
        // saveSplit — persistenza snapshot multi-output per split_topology.
        //
        // SnapshotKeyed Session 3 (2026-04-25): il client invia 2 blob STL
        // (branch A e B). Il server scrive 2 tmp file, poi accoda un task
        // SAVE_SPLIT al worker che finalizza entrambi (rename + cleanup
        // verts orfani + Draco). Naming file:
        //   {active_path}/{stem}_snap_{nodeId}_A.stl
        //   {active_path}/{stem}_snap_{nodeId}_B.stl
        //
        // Contratto client → server (multipart POST):
        //   id              — project_id
        //   mesh_name       — es. "Upper.stl" (basename con .stl)
        //   node_id         — ID Drawflow del nodo split (whitelist regex)
        //   tool_id         — 'split_topology' (diagnostico, opzionale)
        //   stl_blob_a      — STL binario branch A (selezione)
        //   stl_blob_b      — STL binario branch B (complemento)
        //
        // Canale risposta: snapshot_resp_{uid}_{pid} (riusa stesso canale
        // di saveSnapshot — non c'è conflitto perché client e server
        // serializzano naturalmente le chiamate).
        // ═══════════════════════════════════════════════════════════════
        session_write_close();
        header('Content-Type: application/json');

        $id       = $_POST['id']        ?? null;
        $uid      = $_SESSION['nc_uid'] ?? null;
        $meshName = $_POST['mesh_name'] ?? '';
        $nodeId   = $_POST['node_id']   ?? null;
        $toolId   = $_POST['tool_id']   ?? null;

        if (!$id || !$uid || !ctype_digit((string)$id)) {
            echo json_encode(['success' => false, 'error' => 'Dati Auth mancanti.']);
            exit;
        }

        if (!preg_match('/^[A-Za-z0-9 _.\-()]+\.stl$/i', $meshName)) {
            echo json_encode(['success' => false, 'error' => 'mesh_name invalido']);
            exit;
        }

        // node_id è OBBLIGATORIO per split (nessun fallback legacy).
        if (!$nodeId || !preg_match('/^[A-Za-z0-9_\-]+$/', (string)$nodeId)) {
            echo json_encode(['success' => false, 'error' => 'node_id mancante o invalido']);
            exit;
        }

        if ($toolId !== null && $toolId !== '' && !preg_match('/^[A-Za-z0-9_\-]+$/', (string)$toolId)) {
            echo json_encode(['success' => false, 'error' => 'tool_id invalido']);
            exit;
        }
        if ($toolId === '') $toolId = null;

        // Ownership check
        try {
            if (!$this->_ownsProject($uid, (int)$id)) {
                echo json_encode(['success' => false, 'error' => 'Progetto non trovato o non autorizzato']);
                exit;
            }
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'error' => 'DB error: ' . $e->getMessage()]);
            exit;
        }

        // Valida entrambi gli upload (atomicità: se uno manca, fallisci prima di scrivere nulla)
        foreach (['stl_blob_a', 'stl_blob_b'] as $field) {
            if (!isset($_FILES[$field]) || $_FILES[$field]['error'] !== UPLOAD_ERR_OK) {
                $err = $_FILES[$field]['error'] ?? 'missing';
                echo json_encode(['success' => false, 'error' => "Upload {$field} fallito (err={$err})"]);
                exit;
            }
            if ($_FILES[$field]['size'] < 134) {
                echo json_encode(['success' => false, 'error' => "STL {$field} troppo piccolo (< 134 byte)"]);
                exit;
            }
        }

        $activePath = "/appdata/ibex/active/{$uid}/{$id}";
        if (!is_dir($activePath)) {
            echo json_encode(['success' => false, 'error' => 'active_path non esistente — apri prima l\'editor']);
            exit;
        }

        $stem = pathinfo($meshName, PATHINFO_FILENAME);
        $tmpPathA = "{$activePath}/{$stem}_snap_{$nodeId}_A.stl.tmp";
        $tmpPathB = "{$activePath}/{$stem}_snap_{$nodeId}_B.stl.tmp";

        // Move atomico di entrambi i file. Se il secondo fallisce, rollback del primo.
        if (!move_uploaded_file($_FILES['stl_blob_a']['tmp_name'], $tmpPathA)) {
            echo json_encode(['success' => false, 'error' => 'Scrittura tmp A fallita']);
            exit;
        }
        if (!move_uploaded_file($_FILES['stl_blob_b']['tmp_name'], $tmpPathB)) {
            @unlink($tmpPathA);
            echo json_encode(['success' => false, 'error' => 'Scrittura tmp B fallita (rollback A)']);
            exit;
        }

        $responseChannel = "snapshot_resp_{$uid}_{$id}";

        try {
            $this->redis->del($responseChannel);
            $taskPayload = [
                'action'           => 'SAVE_SPLIT',
                'uid'              => $uid,
                'project_id'       => $id,
                'mesh_name'        => $meshName,
                'node_id'          => $nodeId,
                'response_channel' => $responseChannel,
            ];
            if ($toolId !== null) $taskPayload['tool_id'] = $toolId;
            $this->redis->rPush('ibex_tasks', json_encode($taskPayload));

            $blocked = $this->redis->blPop([$responseChannel], 30);
            if (is_array($blocked) && count($blocked) >= 2) {
                echo $blocked[1];
            } else {
                echo json_encode(['success' => false, 'error' => 'Timeout worker (30s)']);
            }
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'error' => $e->getMessage()]);
        }
        exit;
    }

    /**
     * C1 guard (2026-06-14): valida la queue ($_POST['queue']) prima del rPush a Redis.
     * `target` finisce interpolato in codice exec() lato worker (logic_builder) → whitelist
     * filename mesh + tool slug; rifiuta payload con caratteri di injection.
     */
    private function _validateQueue($queue): bool {
        if (!is_array($queue)) return false;
        foreach ($queue as $step) {
            if (!is_array($step)) return false;
            $t = $step['target'] ?? '';
            if ($t !== '' && (!is_string($t) || !preg_match('/^[A-Za-z0-9 _.()\-]+\.stl$/iD', $t))) return false;
            $tool = $step['tool'] ?? '';
            if ($tool !== '' && (!is_string($tool) || !preg_match('/^[A-Za-z0-9_\-]+$/D', $tool))) return false;
        }
        return true;
    }

    public function fastTransform() {
        // Tier 1 fast path: stessa struttura di previewBake ma action=FAST_TRANSFORM.
        // Il worker risponde via lo stesso canale Redis polling usato da previewBake.
        session_write_close();
        header('Content-Type: application/json');

        $id        = $_POST['id'] ?? null;
        $uid       = $_SESSION['nc_uid'] ?? null;
        $queueJson = $_POST['queue'] ?? '[]';
        $previewId = (int)($_POST['preview_id'] ?? 0);

        if (!$id || !$uid || !ctype_digit((string)$id)) {
            echo json_encode(['success' => false, 'error' => 'Dati Auth mancanti.']);
            exit;
        }

        // PUNTO4-FETTA-B — cancello di proprietà PRIMA del primo write. Senza, il pid di
        // un altro bastava a sovrascrivergli `latest_preview_{pid}` e far scartare al
        // worker le sue anteprime in volo (LIFO, worker.py:1005).
        // Costo O(1) sul percorso caldo: qui il progetto è APERTO in editor, quindi
        // FONTE A (is_dir active/) risponde subito e il ramo C non viene mai sfiorato.
        if (!$this->_ownsProject($uid, (int)$id)) {
            echo json_encode(['success' => false, 'error' => 'Progetto non trovato o non autorizzato']);
            exit;
        }

        $currentStatus = $this->redis->get("project:{$id}:status");
        if ($currentStatus === 'baking' || $currentStatus === 'baked') {
            echo json_encode(['success' => false, 'error' => 'Bake in corso. Ignorato.']);
            exit;
        }

        $queue = json_decode($queueJson, true) ?: [];
        $responseChannel = "preview_resp_{$uid}_{$id}";

        try {
            $this->redis->setEx("latest_preview_{$id}", 3600, $previewId);
            $this->redis->del($responseChannel);

            if (!ctype_digit((string)$id) || !$this->_validateQueue($queue)) { echo json_encode(['success'=>false,'error'=>'Richiesta non valida (C1 guard).']); exit; }
            $this->redis->rPush('ibex_tasks', json_encode([
                'action'           => 'FAST_TRANSFORM',
                'uid'              => $uid,
                'project_id'       => $id,
                'queue'            => $queue,
                'preview_id'       => $previewId,
                'response_channel' => $responseChannel
            ]));

            echo json_encode(['queued' => true]);
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'error' => $e->getMessage()]);
        }
        exit;
    }

    public function previewBake() {
        // Rilascia la sessione per non bloccare il download asincrono delle mesh
        session_write_close();
        header('Content-Type: application/json');
        
        $id = $_POST['id'] ?? null;
        $uid = $_SESSION['nc_uid'] ?? null;
        $queueJson = $_POST['queue'] ?? '[]';
        $previewId = (int)($_POST['preview_id'] ?? 0); 

        if (!$id || !$uid || !ctype_digit((string)$id)) {
            echo json_encode(['success' => false, 'error' => 'Dati Auth mancanti.']);
            exit;
        }

        // PUNTO4-FETTA-B — gemello del cancello di fastTransform, stessa ragione e stesso
        // costo: `latest_preview_{pid}` più sotto è una chiave nominata da un pid che
        // fin qui non era mai stato verificato come proprio.
        if (!$this->_ownsProject($uid, (int)$id)) {
            echo json_encode(['success' => false, 'error' => 'Progetto non trovato o non autorizzato']);
            exit;
        }

        // Se è in corso il salvataggio definitivo, rifiuta le nuove anteprime
        $currentStatus = $this->redis->get("project:{$id}:status");
        if ($currentStatus === 'baking' || $currentStatus === 'baked') {
            echo json_encode(['success' => false, 'error' => 'Bake in corso. Ignorato.']);
            exit;
        }

        $queue = json_decode($queueJson, true) ?: [];
        $responseChannel = "preview_resp_{$uid}_{$id}";

        try {
            $this->redis->setEx("latest_preview_{$id}", 3600, $previewId);
            $this->redis->del($responseChannel);
            
            // rPush crea una coda LIFO perfetta per lo streaming
            if (!ctype_digit((string)$id) || !$this->_validateQueue($queue)) { echo json_encode(['success'=>false,'error'=>'Richiesta non valida (C1 guard).']); exit; }
            $this->redis->rPush('ibex_tasks', json_encode([
                'action' => 'PREVIEW_BAKE',
                'uid' => $uid,
                'project_id' => $id,
                'queue' => $queue, 
                'preview_id' => $previewId,
                'response_channel' => $responseChannel
            ]));

            echo json_encode(['queued' => true]);
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'error' => $e->getMessage()]);
        }
        exit;
    }

    public function checkPreview() {
        // LONG-POLLING V15.9: blocca fino a 25s su Redis BLPOP.
        //
        // Problema che risolve: il polling a intervalli fissi (800ms-2s) generava
        // troppe richieste HTTP, triggering il rate-limiter nginx (HTTP 429) anche
        // sul POST preview_bake. Ogni bake lento (~1-3s) produceva 5-10 polls.
        //
        // Fix: PHP blocca su BLPOP con timeout 25s. Appena il worker fa LPUSH al
        // canale, BLPOP sblocca e ritorniamo il risultato. Una sola richiesta
        // HTTP per bake, con latenza = worker_time (zero polling overhead).
        //
        // Timeout 25s < PHP max_execution_time (30s default) per evitare kill FPM.
        // Se il worker è più lento di 25s, ritorniamo pending e JS fa un secondo
        // long-poll. Caso patologico per bake standard (tipicamente <2s).
        //
        // session_write_close() vitale: altrimenti questa richiesta blocca il lock
        // sessione PHP per 25s → l'utente non può fare altre richieste nel frattempo.
        session_write_close();
        header('Content-Type: application/json');

        $id  = $_GET['id'] ?? $_POST['id'] ?? null;
        $uid = $_SESSION['nc_uid'] ?? null;
        if (!$id || !$uid || !ctype_digit((string)$id)) {
            echo json_encode(['error' => 'Dati mancanti']);
            exit;
        }

        $responseChannel = "preview_resp_{$uid}_{$id}";

        // Prima prova lPop non-bloccante (ottimizzazione per risposte già pronte).
        // Se c'è già qualcosa in coda (worker ha finito prima che arrivassimo),
        // saltiamo il BLPOP 25s e rispondiamo subito.
        $result = $this->redis->lPop($responseChannel);
        if ($result) {
            echo $result;
            exit;
        }

        // Coda vuota: blocca fino a 25s su BLPOP. Il worker fa rPush sul canale
        // al completamento, sbloccandoci istantaneamente.
        $blocked = $this->redis->blPop([$responseChannel], 25);
        if (is_array($blocked) && count($blocked) >= 2) {
            // phpredis blPop: ritorna [channel_name, value]
            echo $blocked[1];
        } else {
            // Timeout 25s: il worker non ha ancora finito. JS può riprovare.
            echo json_encode(['pending' => true]);
        }
        exit;
    }

    /** IBX2 (2026-07-21): salva lo SCREENSHOT del canvas editor (inviato dal client
     *  in $_FILES['thumbnail']) in active/{pid}/.thumb.png. Il worker SAVE_EXIT/BAKE
     *  lo legge e lo incastona nel segmento thumb dell'IBX2 (poi active/ è purgata).
     *  Best-effort: mai far fallire il save per il thumb. Solo PNG, cap 2 MiB. Il
     *  dot-prefix esclude il file dallo staging zip (finisce SOLO nel segmento IBX2). */
    private function _saveThumbUpload(string $activePath): void {
        if (empty($_FILES['thumbnail']) || ($_FILES['thumbnail']['error'] ?? 1) !== UPLOAD_ERR_OK) return;
        $tmp = $_FILES['thumbnail']['tmp_name'] ?? '';
        if (!is_uploaded_file($tmp)) return;
        $sz = (int)($_FILES['thumbnail']['size'] ?? 0);
        if ($sz <= 0 || $sz > 2 * 1024 * 1024) return;
        $bytes = @file_get_contents($tmp);
        if ($bytes === false || strncmp($bytes, "\x89PNG\r\n\x1a\n", 8) !== 0) return;   // solo PNG
        $t = @tempnam($activePath, '.thumb-tmp-');
        if ($t !== false && @file_put_contents($t, $bytes) !== false) {
            @rename($t, "$activePath/.thumb.png");
        } elseif ($t !== false) { @unlink($t); }
    }

    public function saveExit() {
        session_write_close();
        header('Content-Type: application/json');

        $id  = $_POST['id']  ?? null;
        $uid = $_SESSION['nc_uid'] ?? null;
        $sessionDataJson = $_POST['session_data'] ?? '{}';

        if (!$id || !$uid || !ctype_digit((string)$id)) {
            echo json_encode(['success' => false, 'error' => 'Auth Missing']);
            exit;
        }

        $sessionData = json_decode($sessionDataJson, true);

        try {
            // ManifestSoT (2026-05-02): la sessione (DAG + visuals + mesh_state +
            // last_bake + ...) viene scritta DIRETTAMENTE in `active_path/manifest.json`
            // come campo `session`. Il manifest diventa Source of Truth, il DB è solo
            // cache dashboard (project_name, status, input_file_path, nc_uid).
            // Atomic write: tempfile + rename per evitare race con worker SAVE_EXIT
            // che zip lo stesso manifest.
            $activeBase  = '/appdata/ibex/active';  // mount in container ibex-app
            $activePath  = "$activeBase/$uid/$id";
            $manifestPath = "$activePath/manifest.json";

            if (!is_dir($activePath)) {
                throw new Exception("active_path mancante: $activePath");
            }
            $this->_saveThumbUpload($activePath);   // IBX2: screenshot canvas → .thumb.png

            // Carica manifest esistente per preservare input_files (set una volta da INIT)
            $manifest = [];
            if (is_file($manifestPath)) {
                $manifest = json_decode(@file_get_contents($manifestPath), true) ?: [];
            }
            $manifest['version']    = '3.0';
            $manifest['baked']      = false;
            $manifest['timestamp']  = time();
            // S6 igiene JSON: {} vuoti preservati come oggetti nel manifest.
            $manifest['session']    = $this->_normalizeSessionDicts($sessionData);
            $this->_hydrateBurn($manifest, $id);   // L7.5.2 fix: vedi _hydrateBurn()
            // input_files si preserva da v2.0 → v3.0; se manifest mancava, ricalcola
            if (empty($manifest['input_files'])) {
                $stls = [];
                foreach (glob("$activePath/*.stl") ?: [] as $f) {
                    $name = basename($f);
                    // esclude derivate (sculpted, snapshot)
                    if (strpos($name, '_sculpted.') !== false) continue;
                    if (preg_match('/_snap_[A-Za-z0-9_\-]+(_[AB])?\.stl$/i', $name)) continue;
                    $stls[] = $name;
                }
                $manifest['input_files'] = $stls;
            }

            // Atomic write: tempfile in stessa dir → rename
            $tmpPath = tempnam($activePath, '.manifest-tmp-');
            if ($tmpPath === false) {
                throw new Exception("tempnam fallito in $activePath");
            }
            if (file_put_contents($tmpPath, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) === false) {
                @unlink($tmpPath);
                throw new Exception("write manifest fallito");
            }
            if (!rename($tmpPath, $manifestPath)) {
                @unlink($tmpPath);
                throw new Exception("rename manifest fallito");
            }

            // de-DB 2026-07-20: stato → Redis (volatile). 'queued' tiene fuori il janitor
            // finché il worker SAVE_EXIT non riporta 'ready'. Il manifest (appena scritto
            // atomico sopra) è la SoT della sessione — nessuna scrittura DB.
            $this->redis->setEx("project:$id:status", 3600, 'queued');
            $pName = $this->_projectName($uid, (int)$id);

            // SnapshotKeyed Session 1 (2026-04-23): lista nodi destructive nel DAG
            // (coppia {mesh, nodeId}) → il worker SAVE_EXIT cleanup elimina i file
            // `{stem}_snap_{nodeId}.stl/.drc` la cui coppia NON è in questa lista.
            // Formato atteso (StackManager.getSnapshotNodes):
            //   [{mesh: "Upper.stl", nodeId: "5"}, ...]
            $snapshotNodes = $sessionData['snapshot_nodes'] ?? [];
            if (!is_array($snapshotNodes)) $snapshotNodes = [];

            $this->redis->rPush('ibex_tasks', json_encode([
                'action'           => 'SAVE_EXIT',
                'uid'              => $uid,
                'project_id'       => $id,
                'project_name'     => $pName,
                'snapshot_nodes'   => $snapshotNodes,
            ]));

            echo json_encode([
                'success'  => true,
                // S7: campo legacy (il client S6 usa _exitAfterSave, lo ignora).
                'redirect' => IbexConfig::lobbyUrl()
            ]);

        } catch (Exception $e) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            echo json_encode(['success' => false, 'error' => $e->getMessage()]);
        }
        exit;
    }

    public function bakeProject() {
        session_write_close(); 
        header('Content-Type: application/json');
        
        $id = $_POST['id'] ?? null;
        $uid = $_SESSION['nc_uid'] ?? null;
        $sessionDataJson = $_POST['session_data'] ?? '{}';
        
        if (!$id || !$uid || !ctype_digit((string)$id)) { echo json_encode(['success' => false, 'error' => 'Auth Missing']); exit; }

        // PUNTO4-FETTA-B (2026-07-28) — CANCELLO DI PROPRIETÀ, prima di ogni scrittura.
        // Questo era l'UNICO handler che accodava al worker senza sapere di chi fosse il
        // progetto: l'`is_dir($activePath)` più sotto avvolge SOLO la scrittura del
        // manifest, non è un cancello. Con il pid di un altro si scriveva comunque
        // `project:{pid}:status='baking'` (1 h → la vittima vede la loading-page e ogni
        // sua anteprima viene rifiutata) + `latest_preview_{pid}=999999999` (il worker
        // scarta per LIFO le sue preview in volo) + il rPush di BAKE_PROJECT. Nessuna
        // lettura né scrittura di dati altrui, ma un DoS cross-utente sì.
        // Il cancello sta QUI perché i tre write sono più sotto e non devono precederlo.
        if (!$this->_ownsProject($uid, (int)$id)) {
            echo json_encode(['success' => false, 'error' => 'Progetto non trovato o non autorizzato']);
            exit;
        }

        $sessionData = json_decode($sessionDataJson, true);
        $queue = $sessionData['stack'] ?? [];
        // C1-BAKE (2026-07-28, audit 3.1/3.6): unico dei tre produttori senza guardia.
        // Regge sul CHARSET di _validateQueue (tool = ^[A-Za-z0-9_-]+$): rilassarlo riapre la RCE.
        if (!$this->_validateQueue($queue)) { echo json_encode(['success'=>false,'error'=>'Richiesta non valida (C1 guard).']); exit; }
        $uiGraph = $sessionData['ui_graph'] ?? null;
        $visuals = $sessionData['visuals'] ?? [];

        if (empty($queue)) {
            echo json_encode(['success' => true, 'redirect' => IbexConfig::lobbyUrl()]); // S7: campo legacy, ignorato dal client S6
            exit;
        }

        // S3 «IBEX semplice» (2026-07-10) — guard UX 0-mesh (Q8, doppio col worker):
        // progetto senza master = rifiuto chiaro SENZA accodare né toccare lo status.
        // Fonte: manifest.json (SoT, Inv.69); se illeggibile si fail-open —
        // l'anti-brick vero è il guard nel worker.
        $activeBase   = '/appdata/ibex/active';
        $manifestPath = "$activeBase/$uid/$id/manifest.json";
        if (is_file($manifestPath)) {
            $mf = json_decode((string)@file_get_contents($manifestPath), true);
            if (is_array($mf) && array_key_exists('input_files', $mf) && empty($mf['input_files'])) {
                echo json_encode(['success' => false, 'error' => 'Progetto vuoto — importa una scansione prima del bake.']);
                exit;
            }
        }

        try {
            // V13.0: mesh_state (pivot + bakedMat) e tool_execution_order persistiti
            $meshState = $sessionData['mesh_state'] ?? [];
            $toolOrder = $sessionData['tool_execution_order'] ?? [];

            $frozenSession = [
                'stack' => array_values($queue),
                'ui_graph' => $uiGraph,
                'visuals' => $visuals,
                'mesh_state' => $meshState,
                'tool_execution_order' => $toolOrder
            ];

            // de-DB 2026-07-20: il DAG del bake vive nel MANIFEST, non più nel DB.
            // Scrittura atomica di manifest.session PRIMA di accodare il BAKE (altrimenti,
            // senza il DB, un bake dopo modifiche non salvate perderebbe il grafo).
            $activePath   = "/appdata/ibex/active/$uid/$id";
            $manifestPath = "$activePath/manifest.json";
            if (is_dir($activePath)) {
                $this->_saveThumbUpload($activePath);   // IBX2: screenshot canvas → .thumb.png
                $mf = is_file($manifestPath) ? (json_decode(@file_get_contents($manifestPath), true) ?: []) : [];
                $mf['version']   = '3.0';
                $mf['timestamp'] = time();
                // L9.2 (2026-07-24): preserva SOLO saved_views attraverso il bake. Sono viste
                // camera fatte a mano dall'utente (ViewGizmo.js:148 le legge da
                // sessionSettings.saved_views), l'unico campo di `session` che il payload del
                // bake non porta e che NESSUNO rigenera. La guardia !array_key_exists sul
                // payload implementa «non sovrascrivere cio' che il payload porta»: oggi
                // inerte (bakeAndExit non le manda), corretta se un domani le mandasse.
                // ⛔ last_bake e snapshot_nodes NON si preservano, di proposito: il drop di
                // last_bake e' LOAD-BEARING per il reset anti-Bug#4 al reopen a caldo
                // (Inv.42, editor() ~:1288-1305); snapshot_nodes e' write-only (nessun
                // lettore del manifest, rigenerato dal DAG ad ogni save).
                $prevSession = (isset($mf['session']) && is_array($mf['session'])) ? $mf['session'] : [];
                if (!array_key_exists('saved_views', $frozenSession)
                    && array_key_exists('saved_views', $prevSession)) {
                    $frozenSession['saved_views'] = $prevSession['saved_views'];
                }
                $mf['session']   = $this->_normalizeSessionDicts($frozenSession);
                $this->_hydrateBurn($mf, $id);   // L7.5.2 fix: vedi _hydrateBurn()
                $tmp = tempnam($activePath, '.manifest-tmp-');
                if ($tmp !== false) {
                    if (file_put_contents($tmp, json_encode($mf, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) !== false) {
                        @rename($tmp, $manifestPath);
                    } else { @unlink($tmp); }
                }
            }
            $pName = $this->_projectName($uid, (int)$id);

            $this->redis->setEx("project:{$id}:status", 3600, 'baking');
            $this->redis->setEx("latest_preview_{$id}", 3600, 999999999);

            $this->redis->rPush('ibex_tasks', json_encode([
                'action' => 'BAKE_PROJECT',
                'uid' => $uid,
                'project_id' => $id,
                'project_name' => $pName,
                'queue' => array_values($queue)
            ]));

            echo json_encode(['success' => true, 'redirect' => IbexConfig::lobbyUrl()]); // S7: campo legacy, ignorato dal client S6

        } catch (Exception $e) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            echo json_encode(['success' => false, 'error' => $e->getMessage()]);
        }
        exit;
    }

    public function editor() {
        $id = $_GET['id'] ?? null; $uid = $_SESSION['nc_uid'] ?? null;
        if (!$id && $uid && !empty($_GET['open_name'])) {
            $id = $this->projectService->getIdByProjectName((string)$_GET['open_name'], $uid);
        }
        // Hardening 2026-07-20: pagina d'errore IN-PLACE, mai `header("Location: …")`.
        // Un redirect DENTRO l'iframe editor carica la shell nell'iframe → la shell
        // ri-iframe-a IBEX → nesting IBEX-in-IBEX. _renderErrorPage resta nell'iframe.
        if (!$id || !$uid || !ctype_digit((string)$id)) { $this->_renderErrorPage('Nessun progetto', '<p>Apri un progetto dalla lista.</p>'); exit; }

        $project = $this->projectService->getProject((int)$id, $uid);
        // de-DB: getProject ritorna null se il pid non esiste / non è dell'uid (era una riga DB).
        // Hardening 2026-07-20: causa storica del nesting IBEX-in-IBEX (progetto vecchio
        // non nel registry → null → redirect → shell dentro l'iframe). Ora errore in-place.
        if ($project === null) { $this->_renderErrorPage('Progetto non trovato', '<p>Questo progetto non esiste più o non è associato al tuo account.</p>'); exit; }

        // Circuit-breaker: se il progetto è in stato error, non re-accodare LOAD_PROJECT.
        // Senza questo check, ogni refresh della pagina ri-accodava LOAD_PROJECT → loop infinito.
        if ($project->status === 'error') {
            $this->_renderErrorPage(
                'Progetto non ripristinabile',
                "<p>L'archivio del progetto è corrotto o mancante (<code>scene.blend</code> assente).</p>"
              . "<p>Il sistema ha tentato il recupero automatico. Se il problema persiste, contatta il supporto.</p>"
            );
            exit;
        }

        if (in_array($project->status, ['baking', 'queued', 'initializing'])) {
            $this->_renderLoadingPage('Elaborazione in corso');
            exit;
        }

        $activePath = "/appdata/ibex/active/$uid/$id";
        
        if (!file_exists("$activePath/scene.blend") && !file_exists("$activePath/manifest.json")) {
             $this->redis->rPush('ibex_tasks', json_encode(['action' => 'LOAD_PROJECT', 'uid' => $uid, 'project_id' => $id, 'project_name' => $project->project_name]));
             $this->redis->setEx("project:$id:status", 3600, 'initializing');   // de-DB
             $this->_renderLoadingPage('Ripristino sessione');
             exit;
        }

        // GodMethod 2026-07-29 -> _resolveInputFiles (ex righe 1266-1305)
        [$inputFiles, $legacyWarning, $legacyWarningReason] = $this->_resolveInputFiles($activePath, $project);

        $fileToken = bin2hex(random_bytes(16));
        $this->redis->setEx("auth_token:$fileToken", 3600, $uid);

        // GodMethod 2026-07-29 -> _readSessionFromManifest (ex righe 1310-1328)
        $sessionSettings = $this->_readSessionFromManifest($activePath);
        $categorizedTools = $this->getCategorizedTools();

        $this->redis->del("project:{$id}:status");

        // GodMethod 2026-07-29 -> _applyFastReload (ex righe 1333-1426)
        $sessionSettings = $this->_applyFastReload($activePath, $sessionSettings);

        // S6 igiene JSON (lettura): il round-trip json_decode(,true) →
        // json_encode dell'inject (scripts.blade:408) ricollasserebbe {} → []
        // ANCHE con manifest perfetto su disco; qui si normalizza dopo tutte
        // le mutazioni e prima dell'include — ripara anche i manifest storici
        // già corrotti senza migrazione.
        $sessionSettings = $this->_normalizeSessionDicts($sessionSettings);

        include __DIR__ . "/../../Views/projects/editor/main.blade.php";
    }
    
    // S8 (2026-07-10): serveFile() RIMOSSO — mai instradato (il serving vivo è
    // ProjectController::serve_file via fast-lane); con lui muore FileService
    // (quarantenato). Coppia insieme-o-nessuno.

    // ─────────────────────────────────────────────────────────────
    // GodMethod 2026-07-29 — estratto VERBATIM da editor() (righe 1266-1305 del
    // file pre-refactor, md5 23207eaba48208af6147d70ae132ae1a).
    // Il corpo qui sotto e' BYTE-IDENTICO all'originale: i parametri portano
    // gli STESSI nomi dei locali di partenza, quindi non una riga e' riscritta.
    // Porta con se' le DUE regex del filtro master-vs-snapshot (`_sculpted` /
    // `_snap_`): girano sempre prima che $inputFiles raggiunga la view, come prima.
    // ─────────────────────────────────────────────────────────────
    private function _resolveInputFiles($activePath, $project): array {
        $inputFiles = [];
        $legacyWarning = false;
        $legacyWarningReason = '';
        if (file_exists("$activePath/manifest.json")) {
            $m = json_decode(file_get_contents("$activePath/manifest.json"), true) ?: [];
            $manifestVersion = $m['version'] ?? '1.0';
            if ($manifestVersion === '2.0') {
                // v2.0 (Sessione 2 ristrutturazione pipeline): master STL immutabili
                // in active_path. `baked_output_files` è l'export in active/baked/
                // (non va caricato dall'editor — serve_file ?from=baked per download).
                $inputFiles = $m['input_files'] ?? [];
            } else {
                // v1.0 legacy: `output_files` poteva contenere master sovrascritti
                // da bake distruttivo. Fallback a input_files se assente.
                // Session 3 migration gestirà la disambiguazione.
                $inputFiles = $m['output_files'] ?? ($m['input_files'] ?? []);
            }
            // Flag migrazione Sessione 3: se il worker LOAD_PROJECT ha trattato il
            // progetto come legacy v1.0 con master WS e originali non recuperabili,
            // imposta legacy_warning=true nel manifest v2.0. Propaga al frontend per
            // mostrare modal informativo "DAG svuotato — master sono le mesh della
            // sessione precedente".
            $legacyWarning = !empty($m['legacy_warning']);
            $legacyWarningReason = (string)($m['legacy_warning_reason'] ?? '');
        }
        if (empty($inputFiles)) $inputFiles = json_decode((string)$project->input_file_path, true) ?: [];

        // Safety filter master vs snapshot: escludi sia il legacy `_sculpted.stl`
        // (pre-Sessione 5) sia il nuovo `{stem}_snap_{nodeId}.stl` (SnapshotKeyed
        // S1, 2026-04-23). Sono versioni modificate delle mesh, NON mesh
        // indipendenti da ricaricare al reopen dell'editor. Guardia difensiva
        // contro manifest scritti con filter non aggiornato.
        if (is_array($inputFiles)) {
            $inputFiles = array_values(array_filter($inputFiles, function($f) {
                if (!is_string($f)) return false;
                if (preg_match('/_sculpted\.stl$/i', $f)) return false;
                if (preg_match('/_snap_[A-Za-z0-9_\-]+\.stl$/i', $f)) return false;
                return true;
            }));
        }

        return [$inputFiles, $legacyWarning, $legacyWarningReason];
    }

    // ─────────────────────────────────────────────────────────────
    // GodMethod 2026-07-29 — estratto VERBATIM da editor() (righe 1310-1328 del
    // file pre-refactor, md5 23207eaba48208af6147d70ae132ae1a).
    // Il corpo qui sotto e' BYTE-IDENTICO all'originale: i parametri portano
    // gli STESSI nomi dei locali di partenza, quindi non una riga e' riscritta.
    // Fonte unica della sessione (de-DB): manifest.json campo `session`.
    // ─────────────────────────────────────────────────────────────
    private function _readSessionFromManifest($activePath): array {
        // ManifestSoT (2026-05-02): la sessione vive in `active_path/manifest.json`
        // nel campo `session`. Il DB è solo cache dashboard. Lettura priorità:
        //   1. manifest.json v3.0 con `session` campo → SoT
        //   2. fallback: DB.session_settings (legacy, progetti pre-ManifestSoT)
        // Migrazione automatica: il prossimo SAVE_EXIT scriverà manifest v3.0 con
        // session, dopodiché DB.session_settings non viene più letto.
        // ── Sessione dal MANIFEST (de-DB 2026-07-20) ──────────────────────────
        // Fonte unica: manifest.json campo `session`. Il fallback DB (ex "1b",
        // recupero del 283) è RIMOSSO col de-DB: la protezione contro la perdita è
        // strutturale — janitor filesystem-driven (non purga il non-salvato) + guard
        // anti-clobber in LOAD_PROJECT. `_sessionNodeCount` è un helper di validazione
        // RISERVATO/non-usato (0 chiamanti), NON una guardia attiva.
        $manifestPath    = "$activePath/manifest.json";
        $sessionSettings = [];
        if (is_file($manifestPath)) {
            $manifestData    = json_decode(@file_get_contents($manifestPath), true) ?: [];
            if (isset($manifestData['session']) && is_array($manifestData['session'])) {
                $sessionSettings = $manifestData['session'];
            }
        }

        return $sessionSettings;
    }

    // ─────────────────────────────────────────────────────────────
    // GodMethod 2026-07-29 — estratto VERBATIM da editor() (righe 1333-1426 del
    // file pre-refactor, md5 23207eaba48208af6147d70ae132ae1a).
    // Il corpo qui sotto e' BYTE-IDENTICO all'originale: i parametri portano
    // gli STESSI nomi dei locali di partenza, quindi non una riga e' riscritta.
    // $sessionSettings entra per VALORE e torna mutato: il `foreach ... as &$node`
    // opera sulla copia locale, il chiamante riassegna. Effetto identico.
    // ─────────────────────────────────────────────────────────────
    private function _applyFastReload($activePath, $sessionSettings): array {
        // FastReload (2026-05-02): pulizia preview/ + reset preview_baked_params
        // sono CONDIZIONALI alla presenza E coerenza di `session_settings.last_bake`.
        //
        // Schema FastReload: SAVE_EXIT include preview/ nel .ibex + il frontend
        // salva in `last_bake` la mappa `appliedMatFlat` per ogni mesh + lo snapshot
        // di `_lastBakedParams` + `_lastBakedNodeIds`. Al reload, IbexCore ripristina
        // `mesh.userData.appliedMatFlat` da last_bake.applied_matrices, StackManager
        // ripopola BakeEngine._lastBakedParams/_lastBakedNodeIds. applyGraph() vede
        // appliedMatFlat presente → branch Tier 1 → applyMat = worldMat × applied_inv
        // → identity in assenza di modifiche → mesh resta in WS visualmente corretta.
        //
        // Sanity check: il fast reload è valido SOLO se preview/ esiste e contiene
        // almeno un .stl/.drc. Se l'extract del .ibex è andato male o la cartella
        // è stata cancellata da un cleanup, cadiamo nel path legacy (eliminazione +
        // reset) per ricalcolare la pipeline pulita al primo bake.
        //
        // Senza last_bake (progetti legacy salvati pre-FastReload), il fix V15.6
        // (eliminazione preview/ + reset preview_baked_params) resta attivo come
        // backward-compat per evitare il Bug #4 doppia applicazione matrice.
        $previewPath = "$activePath/preview";
        $previewIsValid = false;
        if (is_dir($previewPath)) {
            // GLOB_BRACE non è disponibile su Alpine Linux (musl libc).
            // Due glob separati equivalenti.
            $previewFiles = array_merge(
                glob("$previewPath/*.stl") ?: [],
                glob("$previewPath/*.drc") ?: []
            );
            foreach ($previewFiles as $f) {
                if (is_file($f) && filesize($f) > 0) { $previewIsValid = true; break; }
            }
        }
        // ④ FastReload sidecar-matrice (2026-07-21) — fix VERO della race Salva&Esci-
        //    a-bake-in-volo. Il worker scrive preview/{stem}.mat.json (la world matrix
        //    applicata) INSIEME alla geometria, nello stesso swap atomico → è la fonte
        //    AUTORITATIVA, coerente per costruzione con preview/{stem}.stl. La
        //    sovrapponiamo su last_bake.applied_matrices (il sidecar VINCE): così anche
        //    un last_bake catturato a metà bake (race) viene corretto dalla matrice del
        //    bake che ha davvero prodotto la geometria. Sidecar assente = archivio
        //    precedente al fix → si resta su last_bake come FALLBACK (NON rimosso).
        //    DEVE girare PRIMA del coverage guard ② (così il guard vede la mappa corretta).
        if (is_dir($previewPath) && !empty($sessionSettings['last_bake'])) {
            if (!isset($sessionSettings['last_bake']['applied_matrices'])
                || !is_array($sessionSettings['last_bake']['applied_matrices'])) {
                $sessionSettings['last_bake']['applied_matrices'] = [];
            }
            foreach (glob("$previewPath/*.mat.json") ?: [] as $mjf) {
                $stem = preg_replace('/\.mat\.json$/i', '', basename($mjf));
                if ($stem === '') continue;
                $mat = json_decode((string)@file_get_contents($mjf), true);
                if (is_array($mat) && count($mat) === 16) {
                    $sessionSettings['last_bake']['applied_matrices']["$stem.stl"] = $mat;
                }
            }
        }
        $hasLastBake = !empty($sessionSettings['last_bake']) && $previewIsValid;
        // ② FastReload coverage guard (2026-07-21): l'invariante è "mesh servita da
        //    preview/ (World-Space) ⟺ appliedMatFlat ripristinato al reopen". Un
        //    Salva&Esci a bake in volo può scrivere last_bake SENZA la matrice di una
        //    mesh il cui file preview/ è già WS (il figlio parented è il caso tipico)
        //    → al reopen applyGraph cade nel ramo `applyMat = worldMat` e la
        //    doppia-applica sui vertici WS → mesh fuori posto. Se applied_matrices NON
        //    copre OGNI master presente in preview/, invalida tutto il fast-reload →
        //    ricade nel path già esistente sotto (bake pulito dai master scanner-space).
        //    Fail-safe: mai servire una preview WS non coperta; il costo di un falso
        //    positivo è un solo bake pulito al reopen (server-side cache_pipeline HIT).
        if ($hasLastBake) {
            $am = $sessionSettings['last_bake']['applied_matrices'] ?? [];
            foreach (($previewFiles ?? []) as $f) {
                $stem = preg_replace('/\.(stl|drc)$/i', '', basename($f));
                // Le derivate split (`_snap_..._A/B`) non sono master né stanno in
                // preview/; escluse comunque dal controllo di copertura per sicurezza.
                if ($stem === '' || strpos($stem, '_snap_') !== false) continue;
                if (!isset($am["$stem.stl"])) { $hasLastBake = false; break; }
            }
        }
        if (!$hasLastBake && is_dir($previewPath)) {
            foreach (glob("$previewPath/*") ?: [] as $f) { if (is_file($f)) @unlink($f); }
            @rmdir($previewPath);
        }
        if (!$hasLastBake && isset($sessionSettings['ui_graph']['drawflow']['Home']['data'])) {
            foreach ($sessionSettings['ui_graph']['drawflow']['Home']['data'] as &$node) {
                if (($node['name'] ?? '') === 'tool') {
                    $node['data']['preview_baked_params'] = null;
                }
            }
            unset($node);
        }
        // Se il fast reload è invalidato (preview/ corrotta/mancante), rimuovo
        // last_bake da session_settings per coerenza: il frontend non tenterà di
        // ripristinare appliedMatFlat puntando a vertici WS che non esistono.
        if (!$hasLastBake && isset($sessionSettings['last_bake'])) {
            unset($sessionSettings['last_bake']);
        }

        return $sessionSettings;
    }

    public function checkStatus() {
        session_write_close();
        $id = $_GET['id'] ?? 0; $uid = $_SESSION['nc_uid'] ?? '';
        echo json_encode($this->projectService->determineStatus((int)$id, $uid)); exit;
    }
    
    // S7 (2026-07-10): closeSession() RIMOSSO — metodo morto, nessun case lo instradava.
    public function saveSession() {
        session_write_close();
        header('Content-Type: application/json');
        $uid = $_SESSION['nc_uid'] ?? null;
        $id  = (int)($_POST['id'] ?? 0);
        if (!$uid || !$id) { echo json_encode(['success' => false]); exit; }

        $sessionDataJson = $_POST['session_data'] ?? null;
        if (!$sessionDataJson) { echo json_encode(['success' => false]); exit; }

        // UX-A (2026-06-28) — Salva-senza-uscire. ManifestSoT (Inv. 69): al reload
        // editor() legge `manifest.json.session` con PRIORITÀ sul DB → un save che
        // toccasse solo session_settings sarebbe ignorato. Quindi scriviamo il
        // manifest atomicamente (stesso blocco di saveExit) MA senza task worker,
        // senza cambio status e senza redirect: l'utente resta nell'editor.
        // Checkpoint LOCALE: sopravvive a un refresh dell'editor; il re-zip su
        // Nextcloud avviene solo al prossimo save_exit/bake.
        $sessionData = json_decode($sessionDataJson, true);
        $ok = false;   // de-DB: successo = manifest scritto
        try {
            $activeBase   = '/appdata/ibex/active';
            $activePath   = "$activeBase/$uid/$id";
            $manifestPath = "$activePath/manifest.json";
            if (is_dir($activePath)) {
                $manifest = [];
                if (is_file($manifestPath)) {
                    $manifest = json_decode(@file_get_contents($manifestPath), true) ?: [];
                }
                $manifest['version']   = '3.0';
                $manifest['baked']     = false;
                $manifest['timestamp'] = time();
                // S6 igiene JSON: {} vuoti preservati come oggetti nel manifest.
                $manifest['session']   = $this->_normalizeSessionDicts($sessionData);
                $this->_hydrateBurn($manifest, $id);   // L7.5.2 fix: vedi _hydrateBurn()
                if (empty($manifest['input_files'])) {
                    $stls = [];
                    foreach (glob("$activePath/*.stl") ?: [] as $f) {
                        $name = basename($f);
                        if (strpos($name, '_sculpted.') !== false) continue;
                        if (preg_match('/_snap_[A-Za-z0-9_\-]+(_[AB])?\.stl$/i', $name)) continue;
                        $stls[] = $name;
                    }
                    $manifest['input_files'] = $stls;
                }
                $tmpPath = tempnam($activePath, '.manifest-tmp-');
                if ($tmpPath !== false) {
                    $ok_write = file_put_contents($tmpPath, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) !== false;
                    if ($ok_write && @rename($tmpPath, $manifestPath)) {
                        $ok = true;   // de-DB: il manifest È il salvataggio (nessuna cache DB)
                    } else {
                        @unlink($tmpPath);
                    }
                }
            }
        } catch (\Throwable $e) {
            // manifest best-effort
        }

        // de-DB 2026-07-20: nessuna scrittura DB. Il manifest è l'unica SoT della sessione.
        echo json_encode(['success' => (bool)$ok]);
        exit;
    }

    public function export() {
        // Dead (de-DB 2026-07-20): export .ibex disabilitato (cifratura a riposo).
        // index.php lo instrada ma il download è sempre stato 404. Nessun accesso DB.
        http_response_code(404); exit;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ExportNodeSTL (2026-05-03) — nodo `burn` (ex `export_stl`, rename 2026-07-21)
    //
    // Due endpoint:
    //   listNextcloudDirs (GET)  — popola tree picker, sandbox stretto a /files/
    //   exportNodeStl    (POST) — copia mesh post-pipeline da preview/ a NC user
    //                              + registrazione atomica nella cache file NC.
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * GET /?action=list_nextcloud_dirs&path=<rel>
     * File browser endpoint per ExportPicker. Ritorna JSON:
     *   {
     *     dirs:  ["FolderA", "FolderB", ...]  // ordinate naturalcase
     *     files: [{name, size, mtime}, ...]   // ordinati naturalcase
     *     path:  "<rel path corrente>"
     *   }
     * Sandbox stretto: `/data/nextcloud-storage/{nc_uid}/files/` + sotto.
     * Path traversal bloccato via realpath + strpos prefix check. Hidden files
     * (.dot) skippati. Symlink che escono dalla sandbox skippati per BOTH dirs E files.
     */
    /**
     * S5 «IBEX semplice» (2026-07-10) — import di STL Nextcloud in un progetto
     * ESISTENTE (File → Importa mesh). Valida (ownership, gate status, sandbox
     * realpath per-file, whitelist basename, solo .stl, cap 20), appende i path
     * NC a input_file_path (auto-recovery Inv.37), setta status='queued'
     * (blacklist purge + loading page al reload) e accoda IMPORT_FILES.
     * Fire-and-forget: il client fa soft-reload, l'attesa la gestisce editor().
     */
    public function importFiles() {
        session_write_close();
        header('Content-Type: application/json');

        $id    = $_POST['id'] ?? null;
        $uid   = $_SESSION['nc_uid'] ?? null;
        $files = $_POST['files'] ?? [];

        if (!$uid || !$id || !ctype_digit((string)$id)) {
            echo json_encode(['success' => false, 'error' => 'Auth/ID mancanti']); exit;
        }
        if (!is_array($files) || count($files) === 0) {
            echo json_encode(['success' => false, 'error' => 'Nessun file selezionato']); exit;
        }
        if (count($files) > 20) {
            echo json_encode(['success' => false, 'error' => 'Massimo 20 file per import']); exit;
        }

        // de-DB: identità/stato da FS+registry (era SELECT sulla tabella).
        $proj = $this->projectService->getProject((int)$id, $uid);
        if ($proj === null) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Progetto non trovato']); exit;
        }

        // Gate status: niente import durante bake/init/altro import in coda
        $busy = ['baking', 'initializing', 'queued'];
        $redisStatus = (string)$this->redis->get("project:{$id}:status");
        if (in_array($proj->status, $busy, true) || $redisStatus === 'baking') {
            echo json_encode(['success' => false, 'error' => "Progetto occupato ({$proj->status}) — riprova tra poco"]); exit;
        }

        $activePath = "/appdata/ibex/active/$uid/$id";
        if (!is_dir($activePath) || !is_file("$activePath/scene.blend")) {
            echo json_encode(['success' => false, 'error' => "active_path non pronto — apri prima l'editor"]); exit;
        }

        // Validazione per-file: sandbox realpath (pattern listNextcloudDirs —
        // la lacuna di store() NON si eredita) + estensione + whitelist basename
        // ⚠️ Il prefix-check richiede il SEPARATORE finale (o l'uguaglianza esatta):
        // `strpos($t, $absSandbox) !== 0` da solo accetta le directory SORELLE di
        // `files/` — `files_trashbin`, `files_versions` — perche' la stringa inizia
        // comunque con `.../files`. Stessa forma in TUTTE le sedi sandbox del file:
        // non semplificarla via. `$absSandbox` viene sempre dall'uid di SESSIONE.
        $sandbox    = "/data/nextcloud-storage/$uid/files";
        $absSandbox = realpath($sandbox);
        $clean = [];
        foreach ($files as $rel) {
            if (!is_string($rel) || $rel === '') {
                echo json_encode(['success' => false, 'error' => 'File non valido']); exit;
            }
            $rel = ltrim($rel, '/');
            $target = realpath("$sandbox/$rel");
            if ($target === false || $absSandbox === false || !($target === $absSandbox || strpos($target, $absSandbox . DIRECTORY_SEPARATOR) === 0)) {
                http_response_code(403);
                echo json_encode(['success' => false, 'error' => "Percorso non ammesso: $rel"]); exit;
            }
            if (!is_file($target)) {
                echo json_encode(['success' => false, 'error' => "File inesistente: $rel"]); exit;
            }
            $base = basename($rel);
            if (strtolower(pathinfo($base, PATHINFO_EXTENSION)) !== 'stl') {
                echo json_encode(['success' => false, 'error' => "Solo file STL (v1): $base"]); exit;
            }
            if (!preg_match('/^[A-Za-z0-9 _.\-()]+\.stl$/i', $base)) {
                echo json_encode(['success' => false, 'error' => "Nome file non ammesso: $base"]); exit;
            }
            $clean[] = '/' . $rel;
        }

        try {
            // de-DB 2026-07-20: l'append di input_files lo fa il worker IMPORT_FILES sul
            // manifest (unica SoT). PHP setta solo lo stato → Redis.
            $this->redis->setEx("project:$id:status", 3600, 'queued');

            $this->redis->lPush('ibex_tasks', json_encode([
                'action' => 'IMPORT_FILES',
                'uid' => $uid,
                'project_id' => (int)$id,
                'project_name' => $proj->project_name,
                'files' => $clean
            ]));

            echo json_encode(['success' => true, 'queued' => true, 'count' => count($clean)]);
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'error' => $e->getMessage()]);
        }
        exit;
    }

    public function listNextcloudDirs() {
        session_write_close();
        header('Content-Type: application/json');

        $uid = $_SESSION['nc_uid'] ?? '';
        if (!$uid) {
            http_response_code(401);
            echo json_encode(['error' => 'auth missing']);
            return;
        }

        $relPath = trim((string)($_GET['path'] ?? ''), "/ \t\r\n\0\x0B");
        $sandbox = "/data/nextcloud-storage/{$uid}/files";

        if (!is_dir($sandbox)) {
            http_response_code(404);
            echo json_encode(['error' => 'user files dir missing']);
            return;
        }

        $absSandbox = realpath($sandbox);
        $target     = $relPath === '' ? $absSandbox : realpath("{$sandbox}/{$relPath}");

        if ($target === false || $absSandbox === false || !($target === $absSandbox || strpos($target, $absSandbox . DIRECTORY_SEPARATOR) === 0)) {
            http_response_code(403);
            echo json_encode(['error' => 'forbidden path']);
            return;
        }

        if (!is_dir($target)) {
            http_response_code(404);
            echo json_encode(['error' => 'not a directory']);
            return;
        }

        $dirs  = [];
        $files = [];
        $entries = @scandir($target);
        if ($entries !== false) {
            foreach ($entries as $entry) {
                if ($entry === '.' || $entry === '..') continue;
                if ($entry[0] === '.') continue;
                $fullPath = "{$target}/{$entry}";

                if (is_dir($fullPath)) {
                    // Skip symlink directory che escono dalla sandbox
                    $resolved = realpath($fullPath);
                    if ($resolved === false || !($resolved === $absSandbox || strpos($resolved, $absSandbox . DIRECTORY_SEPARATOR) === 0)) continue;
                    $dirs[] = $entry;
                } elseif (is_file($fullPath)) {
                    // Anche per i file: skip symlink esterni
                    $resolved = realpath($fullPath);
                    if ($resolved === false || !($resolved === $absSandbox || strpos($resolved, $absSandbox . DIRECTORY_SEPARATOR) === 0)) continue;
                    $files[] = [
                        'name'  => $entry,
                        'size'  => @filesize($fullPath) ?: 0,
                        'mtime' => @filemtime($fullPath) ?: 0,
                    ];
                }
            }
        }
        sort($dirs, SORT_NATURAL | SORT_FLAG_CASE);
        usort($files, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));

        echo json_encode([
            'dirs'  => $dirs,
            'files' => $files,
            'path'  => $relPath,
        ]);
    }

    /**
     * POST /?action=export_node_stl
     * Body: project_id, mesh_name, directory_path (rel a /files/), filename (con .stl)
     *
     * Flow atomico:
     *   1. Auth + ownership project
     *   2. Sanitize filename (whitelist regex), sandbox directory
     *   3. Verifica src `active_path/preview/{mesh_name}` esiste (post-bake)
     *   4. Transazione: copia (o transcodifica) src → dest, permessi 0664, registrazione
     *      in nextcloud.oc_filecache, COMMIT; se un passo fallisce, ROLLBACK e rimozione di dest
     *   5. Registrazione del burn (_recordBurn), dopo il COMMIT
     *
     * Ritorna JSON {success, path?, size?, timestamp?, error?}.
     */
    public function exportNodeStl() {
        session_write_close();
        header('Content-Type: application/json');

        $uid       = $_SESSION['nc_uid'] ?? '';
        $pid       = (int)($_POST['project_id'] ?? 0);
        $meshName  = trim((string)($_POST['mesh_name'] ?? ''));
        $relDir    = trim((string)($_POST['directory_path'] ?? ''), "/ \t\r\n\0\x0B");
        $filename  = trim((string)($_POST['filename'] ?? ''));

        // L10.3 — formato di export. Assente ⇒ 'stl' ⇒ comportamento IDENTICO a prima.
        // ⚠️ La whitelist DEVE precedere qualunque interpolazione di $fmt nella regex
        // di validazione del filename: un valore non validato lì dentro sarebbe un
        // pattern arbitrario iniettato in preg_match. Dopo `in_array(...,true)` i tre
        // valori sono alfabetici puri → interpolazione sicura.
        $fmtRaw = $_POST['format'] ?? 'stl';
        if (!is_string($fmtRaw)) {   // `format[]=x` arriva come array
            echo json_encode(['success' => false, 'error' => 'format non valido']);
            return;
        }
        $fmt = strtolower(trim($fmtRaw));
        if ($fmt === '') $fmt = 'stl';
        if (!in_array($fmt, self::EXPORT_FORMATS, true)) {
            echo json_encode(['success' => false, 'error' => 'formato non supportato (ammessi: stl, obj, ply)']);
            return;
        }

        if (!$uid || !$pid || $meshName === '' || $filename === '') {
            echo json_encode(['success' => false, 'error' => 'missing fields']);
            return;
        }

        // 1. Ownership progetto (de-DB)
        if (!$this->_ownsProject($uid, (int)$pid)) {
            echo json_encode(['success' => false, 'error' => 'forbidden']);
            return;
        }

        // 2. Sanitize filename — whitelist (alfanumerico + spazio + comuni separatori), suffix .{fmt}
        // ⚠️ NON riscrivere come '/\.(stl|obj|ply)$/i': l'ancora iniziale `^` e la classe
        // (che esclude `/` e `\`) sono la difesa PRIMARIA sul filename — il path finale
        // è costruito diretto (`$dest = "{$destDir}/{$filename}"`). Il `basename()` tre
        // righe più sotto è difesa in profondità AGGIUNTA a valle, non un sostituto.
        // `$fmt` è già passato dalla whitelist di sopra → interpolazione sicura. `D` = `$`
        // non accetta il newline finale.
        if (!preg_match('/^[A-Za-z0-9 _.\-()]+\.' . $fmt . '$/iD', $filename)) {
            echo json_encode(['success' => false, 'error' => "filename non valido (consentiti: A-Z, 0-9, spazi, _.-()) e deve finire .{$fmt}"]);
            return;
        }
        // Difesa in profondità: no-op per qualunque nome che abbia superato la regex
        // (la classe esclude già i separatori), ma se un domani la regex venisse
        // allargata questo resta a impedire che un path esca da $destDir.
        $filename = basename($filename);
        // Sanitize meshName — stesso pattern del save_snapshot
        if (!preg_match('/^[A-Za-z0-9 _.\-()]+\.stl$/i', $meshName)) {
            echo json_encode(['success' => false, 'error' => 'mesh_name non valido']);
            return;
        }

        // Sandbox dir
        $sandbox = "/data/nextcloud-storage/{$uid}/files";
        $absSandbox = realpath($sandbox);
        if (!$absSandbox) {
            echo json_encode(['success' => false, 'error' => 'user files dir missing']);
            return;
        }
        $destDir = $relDir === '' ? $absSandbox : realpath("{$sandbox}/{$relDir}");
        if (!$destDir || !($destDir === $absSandbox || strpos($destDir, $absSandbox . DIRECTORY_SEPARATOR) === 0) || !is_dir($destDir)) {
            echo json_encode(['success' => false, 'error' => 'directory destinazione non valida']);
            return;
        }

        // 3. Source mesh: preview/{meshName} (post-pipeline WS)
        $activePath = "/appdata/ibex/active/{$uid}/{$pid}";
        $src = "{$activePath}/preview/{$meshName}";
        if (!is_file($src) || filesize($src) < 134) {
            echo json_encode(['success' => false, 'error' => 'mesh non disponibile post-bake — fai un bake completo prima']);
            return;
        }
        $dest = "{$destDir}/{$filename}";

        // 4. Copia del file e registrazione in oc_filecache, nella stessa transazione
        try {
            $this->db->beginTransaction();

            // Copy atomic via tempfile + rename (evita file parzialmente scritti
            // visibili a NC mid-copy)
            $tmp = tempnam($destDir, '.export-tmp-');
            if ($tmp === false) throw new \Exception("tempnam fallito in {$destDir}");
            if ($fmt === 'stl') {
                // Path storico INVARIATO: copia byte-a-byte del preview STL.
                if (!copy($src, $tmp)) {
                    @unlink($tmp);
                    throw new \Exception("copy {$src} → {$tmp} fallita");
                }
            } else {
                // L10.3 — OBJ/PLY: si TRANSCODIFICA lo STL sorgente ($src resta
                // `preview/{$meshName}`, sempre `.stl`). Nessun altro file di
                // `preview/` viene letto — in particolare MAI il `{stem}.ply`
                // sorgente-colore di L11.3/L11.5, che è server-only.
                try {
                    $this->_transcodeStl($src, $tmp, $fmt);
                } catch (\Throwable $te) {
                    @unlink($tmp);
                    throw new \Exception($te->getMessage());
                }
            }
            if (!rename($tmp, $dest)) {
                @unlink($tmp);
                throw new \Exception("rename {$tmp} → {$dest} fallito");
            }

            // Permessi consistenti con file scritti via NC (rw-rw-r-- 0664).
            // chown/chgrp non servono — Nextcloud legge come read-OK con `other`.
            @chmod($dest, 0664);

            // Registra il file in nextcloud.oc_filecache così NC lo vede subito nell'UI
            // SENZA dover triggerare uno scan manuale. Walk parent dirs (crea
            // riga directory se mancante) + insert/update riga file. Touch
            // etag dei parent per change detection lato client NC.
            $relPathFromHomeFiles = ($relDir === '' ? '' : $relDir . '/') . $filename;
            $this->_registerFileInNextcloud($uid, $relPathFromHomeFiles, $dest, $fmt);

            $this->db->commit();
        } catch (\Exception $e) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            // Rimuovo il file scritto se il filecache insert fallisce, così non
            // restano file orfani sul filesystem (visibili via SSH ma fantasma in NC).
            if (isset($dest) && is_file($dest)) @unlink($dest);
            echo json_encode([
                'success' => false,
                'error'   => $e->getMessage(),
            ]);
            return;
        }

        // 5. L7.5.2 (2026-07-24): registra il burn. DOPO il commit: il file è già copiato
        // e registrato in NC — da qui in poi nulla può far fallire l'export.
        $this->_recordBurn($uid, $pid, $meshName, $filename);

        echo json_encode([
            'success'   => true,
            'path'      => ($relDir === '' ? '' : $relDir . '/') . $filename,
            'size'      => filesize($dest),
            'timestamp' => time(),
        ]);
    }

    /* ─────────────────────────────────────────────────────────────────────────
       L7.5.2 — SINTESI BURN per la card della lobby.

       Forma: `{n: <#mesh distinte>, meshes: [<nomi distinti>]}`.

       DUE SEDI, ruoli diversi:
         · `manifest['burn']` — TOP-LEVEL, fratello di `session`. DUREVOLE: entra nel
           `.ibex` al prossimo pack. ⚠️ MAI dentro `session`: il janitor confronta
           `canonical_session_digest(manifest['session'])` con l'header del `.ibex`,
           quindi scriverci dentro lo farebbe risultare «non salvato» PER SEMPRE
           (skip:unsaved-mismatch → active/ mai purgata).
         · `ibex:burn:{pid}` (ibex-redis) — proiezione per la lobby: la legge
           projectsStatus, così il badge non richiede di decifrare l'archivio.
           Volatile (`--appendonly no`) → la ricostruisce `_registry_rebuild`.

       DUE RACE, gestite diversamente:
         1. burn ↔ burn (due export ravvicinati): `flock` su un lockfile dedicato →
            serializzati. Senza, entrambi leggerebbero n=1 e scriverebbero n=2.
            È la race che perderebbe un dato in modo NON auto-riparante.
         2. burn ↔ autosave (`saveSession` riscrive il manifest ogni ~15s): finestra
            di ~1ms, non serializzabile senza toccare anche l'autosave. Coperta
            dall'unione delle due sedi: il set finale è `manifest ∪ redis ∪ nuovo`,
            quindi monotòno — se l'autosave sovrascrive il `burn` del manifest, il
            burn successivo lo ripristina intero da Redis. (Il verso opposto è già
            innocuo: `session` la ri-pusha il client al giro d'autosave dopo.)

       TUTTO best-effort (modello `_saveThumbUpload`): il burn è GIÀ avvenuto, un
       problema nel registrarlo non deve mai trasformarsi in un export fallito.
       ───────────────────────────────────────────────────────────────────────── */
    /* L7.5.2 — FIX di durabilità (2026-07-24, dopo la prima misura sul campo).
       Sintomo osservato: `ibex:burn:290` popolato ma `manifest['burn']` ASSENTE.
       Causa: ogni scrittura del manifest (autosave `saveSession` ogni ~15s, `saveExit`,
       `bakeProject`) fa load-modify-write; se legge il manifest PRIMA che `_recordBurn`
       rinomini il suo, lo sovrascrive e il burn sparisce. `session` sopravvive perché il
       client la ri-pusha al giro dopo — il burn no, nessuno lo ri-pusha.
       Contare sull'unione-da-Redis del burn SUCCESSIVO non basta: un burn singolo non
       raggiungerebbe mai il `.ibex`, e la durabilità è tutto il punto del manifest.

       Fix: ogni writer del manifest si ri-idrata da Redis prima di scrivere. Il set è
       monotòno (unione), quindi la convergenza avviene entro un ciclo d'autosave e
       nessun ramo può togliere una mesh già registrata. Best-effort: Redis giù → si
       tiene ciò che c'è già nel manifest, mai un downgrade. */
    private function _hydrateBurn(array &$manifest, int $pid): void {
        if ($pid <= 0) return;
        try {
            $meshes = [];
            $files  = [];   // IBEX-EXPORT-27-7 — nome_di_scena → ultimo filename esportato
            foreach ((array)($manifest['burn']['meshes'] ?? []) as $m) {
                if (is_string($m) && $m !== '') $meshes[] = $m;
            }
            foreach ((array)($manifest['burn']['files'] ?? []) as $k => $v) {
                if (is_string($k) && is_string($v) && $k !== '' && $v !== '') $files[$k] = $v;
            }
            $prev = json_decode((string)$this->redis->get("ibex:burn:{$pid}"), true);
            foreach ((array)($prev['meshes'] ?? []) as $m) {
                if (is_string($m) && $m !== '') $meshes[] = $m;
            }
            // IBEX-EXPORT-27-7 — su chiave ripetuta vince Redis: è la sede che
            // sopravvive al clobber dell'autosave descritto nella nota qui sopra.
            foreach ((array)($prev['files'] ?? []) as $k => $v) {
                if (is_string($k) && is_string($v) && $k !== '' && $v !== '') $files[$k] = $v;
            }
            $meshes = array_values(array_unique($meshes));
            if (!$meshes) return;                        // nessun burn da nessuna parte
            sort($meshes, SORT_NATURAL | SORT_FLAG_CASE);
            $manifest['burn'] = ['n' => count($meshes), 'meshes' => $meshes];
            // IBEX-EXPORT-27-7 — potatura: nessuna voce `files` orfana rispetto a `meshes`.
            $files = array_intersect_key($files, array_flip($meshes));
            if ($files) { $manifest['burn']['files'] = $files; }
        } catch (\Throwable $e) {
            // Redis irraggiungibile → lascia il manifest com'è (mai un downgrade).
        }
    }

    /* ─────────────────────────────────────────────────────────────────────────
       IBEX-GEN3-28-7 (sessione B) — record di burn dalla TERZA sede: l'header
       IBX2 gen-3 del `.ibex` (§26). È il consumatore per cui gen-3 è stata fatta.

       PERCHÉ serve: delle tre sedi (Inv. 125), `manifest['burn']` è durevole ma
       vive sotto ARCHIVE_KEY — il tier web NON può aprirla; `ibex:burn:{pid}` è
       web-leggibile ma volatile. A Redis ricreata i burn sparivano dalle card
       mentre il dato vero era ancora dentro i `.ibex`. L'header gen-3 è l'unica
       sede insieme durevole e web-leggibile, e questa funzione la legge.

       QUANDO: solo se la chiave Redis MANCA. In regime normale non tocca il disco.
       COSTO: lettura PARZIALE — 57 byte di prefisso + il solo segmento burn
       (poche centinaia di byte), MAI il payload. `readBurn` usa solo THUMB_KEY.
       SELF-HEALING: su record valido ri-popola `ibex:burn:{pid}`, così dal poll
       successivo il costo torna a zero. Sul risultato negativo NON scrive nulla:
       un `.ibex` gen-2 (non ancora risalvato) porta il burn nel manifest cifrato,
       che il worker sa recuperare con `_registry_rebuild` — mettere in cache un
       «niente» glielo maschererebbe.
       BEST-EFFORT: qualunque problema → null → la card si comporta come oggi. */
    private function _burnFromHeader(string $uid, string $name, int $pid): ?array {
        if ($uid === '' || $name === '' || $pid <= 0) return null;
        try {
            // Sandbox realpath (stesso spirito di `thumb()` e `serve_file`): il nome
            // arriva dal registry Redis, non dalla richiesta, ma la guardia blinda
            // comunque una voce anomala con `..` o un symlink.
            $base = realpath("/data/nextcloud-storage/{$uid}/files/IBEX");
            if ($base === false) return null;
            $real = realpath($base . '/' . $name . '.ibex');
            if ($real === false || strpos($real, $base . '/') !== 0) return null;

            $b = \App\Core\IbexThumb::readBurn($real);
            if (!is_array($b) || empty($b['meshes']) || !is_array($b['meshes'])) return null;
            if (empty($b['n'])) { $b['n'] = count($b['meshes']); }

            // Ri-popola la sede volatile (stesso gesto di `_registry_rebuild` lato
            // worker). Best-effort: se Redis è giù il record viene servito comunque.
            try { $this->redis->set("ibex:burn:{$pid}", json_encode($b)); }
            catch (\Throwable $e) { /* Redis giù: si serve comunque dall'header */ }

            return $b;
        } catch (\Throwable $e) {
            return null;
        }
    }

    // IBEX-EXPORT-27-7 — 4° parametro OPZIONALE (default null): le chiamate
    // esistenti restano valide e si comportano esattamente come prima.
    private function _recordBurn(string $uid, int $pid, string $meshName, ?string $filename = null): void {
        if ($uid === '' || $pid <= 0 || $meshName === '') return;
        $activePath = ProjectService::ACTIVE_BASE . "/{$uid}/{$pid}";
        if (!is_dir($activePath)) return;          // progetto non caldo: niente da aggiornare

        $lock = null;
        try {
            // Race 1: serializza i burn concorrenti sullo stesso progetto.
            $lock = @fopen("$activePath/.burn.lock", 'c');
            if ($lock !== false) { @flock($lock, LOCK_EX); }

            $manifestPath = "$activePath/manifest.json";
            // Rilettura FRESCA il più tardi possibile → finestra minima verso l'autosave.
            $manifest = is_file($manifestPath)
                ? (json_decode(@file_get_contents($manifestPath), true) ?: [])
                : [];

            // Unione delle due sedi + la mesh nuova (monotòno, vedi Race 2).
            $meshes = [];
            $files  = [];   // IBEX-EXPORT-27-7 — nome_di_scena → ultimo filename esportato
            foreach ((array)($manifest['burn']['meshes'] ?? []) as $m) {
                if (is_string($m) && $m !== '') $meshes[] = $m;
            }
            foreach ((array)($manifest['burn']['files'] ?? []) as $k => $v) {
                if (is_string($k) && is_string($v) && $k !== '' && $v !== '') $files[$k] = $v;
            }
            try {
                $prev = json_decode((string)$this->redis->get("ibex:burn:{$pid}"), true);
                foreach ((array)($prev['meshes'] ?? []) as $m) {
                    if (is_string($m) && $m !== '') $meshes[] = $m;
                }
                // IBEX-EXPORT-27-7 — su chiave ripetuta vince Redis (sede che
                // sopravvive al clobber dell'autosave).
                foreach ((array)($prev['files'] ?? []) as $k => $v) {
                    if (is_string($k) && is_string($v) && $k !== '' && $v !== '') $files[$k] = $v;
                }
            } catch (\Throwable $e) { /* Redis giù: il manifest basta */ }
            $meshes[] = $meshName;
            // IBEX-EXPORT-27-7 — il filename di QUESTO burn vince su tutto: è il più recente.
            if (is_string($filename) && $filename !== '') { $files[$meshName] = $filename; }

            $meshes = array_values(array_unique($meshes));
            sort($meshes, SORT_NATURAL | SORT_FLAG_CASE);   // ordine stabile → niente diff spuri
            $burn = ['n' => count($meshes), 'meshes' => $meshes];
            // IBEX-EXPORT-27-7 — potatura: nessuna voce `files` orfana rispetto a `meshes`.
            // `$burn` viaggia INTERO verso ENTRAMBE le sedi piu' sotto — l'assegnazione
            // `$manifest['burn'] = $burn;` e la `$this->redis->set("ibex:burn:{$pid}", …)` —
            // quindi nessuna delle due scritture ha richiesto modifiche.
            // (Niente numeri di riga qui: si sfasano al primo edit e mentono.)
            $files = array_intersect_key($files, array_flip($meshes));
            if ($files) { $burn['files'] = $files; }

            // Scrittura atomica: tocca SOLO la chiave `burn`, mai `session`.
            // ⚠️ Ogni ramo di fallimento LOGGA. Nella prima versione erano tutti
            // silenziati con @: quando il burn non è comparso nel manifest non c'era
            // modo di distinguere «write fallita» da «sovrascritta dall'autosave».
            if (is_dir($activePath)) {
                $manifest['burn'] = $burn;
                $tmp = @tempnam($activePath, '.manifest-tmp-');
                if ($tmp === false) {
                    error_log("[IBEX-BURN] tempnam fallito in {$activePath}");
                } else {
                    $json = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                    if ($json === false) {
                        @unlink($tmp);
                        error_log("[IBEX-BURN] json_encode fallito pid={$pid}: " . json_last_error_msg());
                    } elseif (@file_put_contents($tmp, $json) === false) {
                        @unlink($tmp);
                        error_log("[IBEX-BURN] write tmp fallita pid={$pid}");
                    } elseif (!@rename($tmp, $manifestPath)) {
                        @unlink($tmp);
                        error_log("[IBEX-BURN] rename manifest fallito pid={$pid}");
                    }
                }
            }

            // Proiezione per la lobby. Nessun TTL: è persistente come il registro
            // (e ricostruibile dal manifest via _registry_rebuild).
            try { $this->redis->set("ibex:burn:{$pid}", json_encode($burn)); }
            catch (\Throwable $e) { /* la sede durevole è il manifest */ }

        } catch (\Throwable $e) {
            error_log("[IBEX-BURN] record fallito pid={$pid}: " . $e->getMessage());
        } finally {
            if ($lock !== false && $lock !== null) { @flock($lock, LOCK_UN); @fclose($lock); }
        }
    }

    /**
     * POST /?action=rename_project
     * Body: id, project_name
     * Aggiorna inline il nome progetto dall'header. Whitelist regex stringente
     * (no path separators, no special chars), max 80 char. Ownership check.
     */
    public function renameProject() {
        session_write_close();
        header('Content-Type: application/json');

        $uid = $_SESSION['nc_uid'] ?? '';
        $id  = (int)($_POST['id'] ?? 0);
        $oldNameIn = trim((string)($_POST['old_name'] ?? ''));   // lobby: identità = nome del .ibex
        $newName = trim((string)($_POST['project_name'] ?? ''));

        // Identità risolvibile via id (header editor) OPPURE old_name (lobby NC).
        if (!$uid || $newName === '' || ($id <= 0 && $oldNameIn === '')) {
            echo json_encode(['success' => false, 'error' => 'missing fields']);
            return;
        }
        // Whitelist nuovo nome — DEVE restare allineata al client (shell-v7.js `RENAME_RX`).
        // Niente / \ : * ? " < > |
        if (!preg_match('/^[A-Za-z0-9 _.\-()À-ÿ]{1,80}$/u', $newName)) {
            echo json_encode(['success' => false, 'error' => 'nome non valido (max 80 char, senza / \\ : * ? " < > |)']);
            return;
        }
        // de-DB 2026-07-20: il nome è l'identità del .ibex (open_name == stem del file).
        // Rinominare = rinominare il file + nextcloud.oc_filecache (NC UI) + manifest + registry Redis.
        // Nessun accesso alla tabella progetti.
        //
        // lobby-rename 2026-07-20: due chiamanti.
        //   • editor header → POST id       → ownership via registry + nome via manifest/registry.
        //   • lobby NC card → POST old_name → identità = .ibex sotto la home (uid-scoped dal JWT del
        //                                     proxy page#rename); id best-effort dal registry (serve
        //                                     solo a manifest + registry rename).
        if ($id > 0) {
            if (!$this->_ownsProject($uid, (int)$id)) {
                echo json_encode(['success' => false, 'error' => 'progetto non trovato o forbidden']);
                return;
            }
            $oldName = $this->_projectName($uid, (int)$id);
            if ($oldName === null) {
                echo json_encode(['success' => false, 'error' => 'nome corrente non risolvibile']);
                return;
            }
        } else {
            // Lobby name-keyed: il nome corrente deve superare la stessa whitelist
            // (anti path-traversal: la regex esclude / e \ → resta dentro files/IBEX).
            if (!preg_match('/^[A-Za-z0-9 _.\-()À-ÿ]{1,80}$/u', $oldNameIn)) {
                echo json_encode(['success' => false, 'error' => 'nome corrente non valido']);
                return;
            }
            $oldName = $oldNameIn;
            $id = ProjectRegistry::resolve($this->redis, $uid, $oldName) ?? 0;   // 0 = non ancora indicizzato
        }
        if ($newName === $oldName) { echo json_encode(['success' => true, 'project_name' => $newName]); return; }

        $ibexDir = "/data/nextcloud-storage/$uid/files/IBEX";
        $oldIbex = "$ibexDir/$oldName.ibex";
        $newIbex = "$ibexDir/$newName.ibex";

        // Anti-collisione: nome già usato (registry) o file già presente.
        if (ProjectRegistry::resolve($this->redis, $uid, $newName) !== null || is_file($newIbex)) {
            echo json_encode(['success' => false, 'error' => 'esiste già un progetto con questo nome']);
            return;
        }

        // 1. rinomina il file .ibex.
        //    editor: un progetto appena creato può non avere ancora il .ibex → step no-op, si prosegue
        //            con manifest+registry (id > 0 garantito).
        //    lobby (id non risolto): senza file NÉ indice non c'è nulla da rinominare → errore.
        if (!is_file($oldIbex)) {
            if ($id <= 0) {
                echo json_encode(['success' => false, 'error' => 'progetto non trovato']);
                return;
            }
        } elseif (!@rename($oldIbex, $newIbex)) {
            echo json_encode(['success' => false, 'error' => 'rename file .ibex fallito']);
            return;
        }
        // 2. nextcloud.oc_filecache: rinomina la riga (mantiene il fileid → open_name/anteprime NC stabili)
        try {
            $st = $this->db->prepare("SELECT numeric_id FROM nextcloud.oc_storages WHERE id = ?");
            $st->execute(["home::$uid"]);
            $storageId = (int)$st->fetchColumn();
            if ($storageId) {
                $oldRel = "files/IBEX/$oldName.ibex";
                $newRel = "files/IBEX/$newName.ibex";
                $up = $this->db->prepare(
                    "UPDATE nextcloud.oc_filecache SET path = ?, name = ?, path_hash = ? WHERE storage = ? AND path_hash = ?"
                );
                $up->execute([$newRel, "$newName.ibex", md5($newRel), $storageId, md5($oldRel)]);
            }
        } catch (\Throwable $e) { /* filecache best-effort: il file è già rinominato su disco */ }
        // 3. manifest.project_name (se il progetto è caldo in active/ — solo con pid noto)
        $mp = "/appdata/ibex/active/$uid/$id/manifest.json";
        if ($id > 0 && is_file($mp)) {
            $m = json_decode(@file_get_contents($mp), true) ?: [];
            $m['project_name'] = $newName;
            $tmp = @tempnam("/appdata/ibex/active/$uid/$id", '.manifest-tmp-');
            if ($tmp !== false && file_put_contents($tmp, json_encode($m, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) !== false) {
                @rename($tmp, $mp);
            } elseif ($tmp !== false) { @unlink($tmp); }
        }
        // 4. registry Redis (name2pid + pid2meta) — solo con pid noto.
        //    id non risolto (vecchio progetto non ancora indicizzato): salta — il rebuild
        //    warmup del worker re-indicizza dal manifest del .ibex rinominato. Degradazione
        //    sicura: il file (verità) e la lobby (che elenca dal filesystem) sono già coerenti.
        if ($id > 0) {
            ProjectRegistry::rename($this->redis, $uid, $oldName, $newName, (int)$id);
        }

        // 5. RINOMINA = SALVA-ADESSO (23/7): accoda il ri-zip di active/{pid} nel .ibex col
        //    nome NUOVO, cosi' il file sul cloud porta il CONTENUTO corrente (non l'ultimo save).
        //    Stesso pid, active/ NON purgata, scheda non chiusa. Fallimento del ri-zip = .ibex
        //    col contenuto precedente + active/ intatta -> nessuna perdita, nessun orfano.
        if ($id > 0 && is_dir("/appdata/ibex/active/$uid/$id")) {
            try {
                $this->redis->rPush('ibex_tasks', json_encode([
                    'action' => 'RENAME_SAVE', 'uid' => $uid,
                    'project_id' => (int)$id, 'project_name' => $newName,
                ]));
            } catch (\Throwable $e) { /* best-effort: la rinomina e' gia' consistente */ }
        }

        echo json_encode(['success' => true, 'project_name' => $newName]);
    }

    /**
     * Registra un file nel filecache di Nextcloud così NC lo vede nell'UI
     * SENZA dover triggerare uno scan via OCC. Walk parent dirs (crea righe
     * directory mancanti) + insert/update riga file + touch etag dei parent
     * (per change detection lato client NC).
     *
     * Da invocare DENTRO la transazione che ha già fatto la copy file: se
     * questo metodo lancia, il caller deve fare rollback E unlink del file
     * scritto su disco (altrimenti restano file orfani fantasma in NC).
     *
     * @param string $uid          NC user (es. "mario.rossi@example.org")
     * @param string $relPathInsideHome  path RELATIVO alla cartella `files/`
     *                              dell'utente (es. "COMO/UpperModel.stl"),
     *                              SENZA il prefisso "files/".
     * @param string $absPath      path filesystem assoluto del file scritto
     * @throws \Exception su errori SQL o storage non trovato
     */
    // ═══════════════════════════════════════════════════════════════
    // Preset DAG (2026-05-05) — salva/lista/carica/elimina sotto-grafi
    // riutilizzabili. Privati: storage Nextcloud user
    // /data/nextcloud-storage/{uid}/files/IBEX/.ibex_internal/presets/.
    // Pubblici: /appdata/ibex/assets/presets_public/. File obfuscato come
    // base64(gzip(JSON)) con magic header "IBXPRST\n" — Nextcloud webUI
    // non riconosce il MIME, scarica come blob opaco.
    // ═══════════════════════════════════════════════════════════════

    /** Magic header dei file preset legacy V1.0 (backward compat lettura). */
    private const PRESET_MAGIC = "IBXPRST\n";

    /** Sandbox dir privati per uid. Format JSON puro V1.1 (.json), backward
     *  compat lettura V1.0 (.bin con magic header + base64+gzip). */
    private function _privatePresetDir(string $uid): string {
        return "/data/nextcloud-storage/{$uid}/files/IBEX/.ibex_internal/presets";
    }

    /** Sandbox dir pubblici. V1.1 (2026-05-05): rinominato da
     *  /appdata/ibex/assets/presets_public a /appdata/ibex/assets/logic_preset
     *  per allineamento naming con altri asset pool (logic_py/, logic_gn/). */
    private function _publicPresetDir(): string {
        return "/appdata/ibex/assets/logic_preset";
    }

    /** Slugify nome (lowercase, accent strip, [a-z0-9-] only, max 40 char). */
    private function _slugify(string $name): string {
        $s = mb_strtolower($name, 'UTF-8');
        $s = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
        $s = preg_replace('/[^a-z0-9]+/', '-', $s);
        $s = trim($s, '-');
        $s = substr($s, 0, 40);
        return $s ?: 'preset';
    }

    /** Wrapper per UserContext::isAdmin — privilegio "pubblicare preset
     *  nel pool condiviso". 'admin' OR membro 'Amministrazione' (esclude
     *  'Operativi' che ha permessi più ristretti). */
    private function _isAdmin(string $uid): bool {
        return UserContext::isAdmin($this->db, $uid);
    }

    /** Scrive il preset come JSON UTF-8 puro (V1.1). Atomic write via tempfile + rename. */
    private function _writePresetFile(array $obj, string $absPath): void {
        $json = json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        if ($json === false) throw new \Exception('json_encode preset fallito');

        $dir = dirname($absPath);
        $tmp = tempnam($dir, '.preset-tmp-');
        if ($tmp === false) throw new \Exception("tempnam fallito in {$dir}");
        if (file_put_contents($tmp, $json) === false) {
            @unlink($tmp);
            throw new \Exception("file_put_contents fallito su {$tmp}");
        }
        if (!rename($tmp, $absPath)) {
            @unlink($tmp);
            throw new \Exception("rename {$tmp} → {$absPath} fallito");
        }
        @chmod($absPath, 0644);
    }

    /** Decode payload. V1.1: JSON puro. V1.0 (legacy .bin): magic header +
     *  base64 + gzip → backward compat lettura per non rompere preset
     *  esistenti pre-migrazione. */
    private function _readPresetFile(string $absPath): ?array {
        if (!is_file($absPath)) return null;
        $blob = @file_get_contents($absPath);
        if ($blob === false) return null;

        // V1.1 — JSON puro (formato corrente)
        $obj = @json_decode($blob, true);
        if (is_array($obj)) return $obj;

        // V1.0 — backward compat: magic header + base64 + gzip
        $magicLen = strlen(self::PRESET_MAGIC);
        if (strncmp($blob, self::PRESET_MAGIC, $magicLen) !== 0) return null;
        $b64  = substr($blob, $magicLen);
        $gz   = base64_decode($b64, true);
        if ($gz === false) return null;
        $json = @gzdecode($gz);
        if ($json === false) return null;
        $obj = json_decode($json, true);
        return is_array($obj) ? $obj : null;
    }

    /** Risolve l'absolute path di un preset cercando prima .json (V1.1) poi
     *  .bin (V1.0 backward compat). Ritorna null se nessuno dei due esiste.
     *  Sandbox check via realpath + prefix delegata al chiamante. */
    private function _resolvePresetPath(string $dir, string $id): ?string {
        $jsonPath = $dir . '/' . $id . '.json';
        if (is_file($jsonPath)) return $jsonPath;
        $binPath = $dir . '/' . $id . '.bin';
        if (is_file($binPath)) return $binPath;
        return null;
    }

    /** POST ?action=save_preset — body: name, description, payload_json,
     *  namespace (default 'private', 'public' richiede admin). */
    public function savePreset() {
        session_write_close();
        header('Content-Type: application/json');

        $uid          = $_SESSION['nc_uid'] ?? '';
        $name         = trim((string)($_POST['name'] ?? ''));
        $description  = trim((string)($_POST['description'] ?? ''));
        $payloadJson  = (string)($_POST['payload_json'] ?? '');
        $namespace    = (string)($_POST['namespace'] ?? 'private');

        if (!$uid || $name === '' || $payloadJson === '') {
            echo json_encode(['success' => false, 'error' => 'missing fields']);
            return;
        }
        if (!in_array($namespace, ['private', 'public'], true)) {
            echo json_encode(['success' => false, 'error' => 'namespace non valido']);
            return;
        }
        // Solo membri del gruppo Nextcloud "Amministrazione" possono salvare
        // nel pool pubblico. Check tramite oc_group_user.
        if ($namespace === 'public' && !$this->_isAdmin($uid)) {
            echo json_encode(['success' => false, 'error' => 'permessi insufficienti: solo gli amministratori possono pubblicare preset']);
            return;
        }

        // Whitelist nome — pattern liberale: accetta unicode arbitrario,
        // vieta SOLO control chars (anti-injection log/storage). Il filename
        // di disco viene da _slugify (lossy, [a-z0-9-] only) → nessun rischio
        // path traversal. Il display via JS è textContent → no XSS.
        $nlen = mb_strlen($name);
        if ($nlen === 0 || $nlen > 80 || preg_match('/[\x00-\x1F\x7F]/u', $name)) {
            echo json_encode(['success' => false, 'error' => 'nome non valido (lunghezza o caratteri di controllo)']);
            return;
        }
        if (mb_strlen($description) > 500 || preg_match('/[\x00-\x08\x0B-\x1F\x7F]/u', $description)) {
            echo json_encode(['success' => false, 'error' => 'descrizione troppo lunga o con caratteri non validi']);
            return;
        }

        // Decode payload utente → re-encode con campi ammessi (defensive).
        $rawPayload = json_decode($payloadJson, true);
        if (!is_array($rawPayload) || !isset($rawPayload['nodes']) || !is_array($rawPayload['nodes'])) {
            echo json_encode(['success' => false, 'error' => 'payload non valido']);
            return;
        }
        $obj = [
            'version'     => '1.1',
            'name'        => $name,
            'description' => $description,
            'created_at'  => gmdate('c'),
            'author'      => $uid,
            'namespace'   => $namespace,
            'nodes'       => $rawPayload['nodes'],
            'connections' => $rawPayload['connections'] ?? [],
        ];

        $slug = $this->_slugify($name);

        if ($namespace === 'private') {
            // Privato: filename = slug + uuid8 (evita collisioni tra preset
            // privati con stesso nome). Storage: home Nextcloud user.
            $uuid8    = bin2hex(random_bytes(4));
            $id       = "{$slug}_{$uuid8}";
            $filename = "{$id}.json";

            $sandboxFiles = "/data/nextcloud-storage/{$uid}/files";
            $absSandbox   = realpath($sandboxFiles);
            if (!$absSandbox) {
                echo json_encode(['success' => false, 'error' => 'user files dir missing']);
                return;
            }
            $presetDir = $this->_privatePresetDir($uid);
            if (!is_dir($presetDir)) {
                if (!@mkdir($presetDir, 0750, true) && !is_dir($presetDir)) {
                    echo json_encode(['success' => false, 'error' => 'mkdir preset dir fallito (verifica permission /data/nextcloud-storage/'.$uid.'/files/IBEX/)']);
                    return;
                }
            }
            $absDest = $presetDir . '/' . $filename;
            $absDestRealParent = realpath($presetDir);
            if (!$absDestRealParent || !($absDestRealParent === $absSandbox || strpos($absDestRealParent, $absSandbox . DIRECTORY_SEPARATOR) === 0)) {
                echo json_encode(['success' => false, 'error' => 'sandbox check fallita']);
                return;
            }

            try {
                $this->db->beginTransaction();
                $this->_writePresetFile($obj, $absDest);
                $relInsideFiles = "IBEX/.ibex_internal/presets/{$filename}";
                $this->_registerFileInNextcloud($uid, $relInsideFiles, $absDest);
                $this->db->commit();
            } catch (\Exception $e) {
                if ($this->db->inTransaction()) $this->db->rollBack();
                if (is_file($absDest)) @unlink($absDest);
                echo json_encode(['success' => false, 'error' => $e->getMessage()]);
                return;
            }
        } else {
            // Pubblico (admin only): filename = slug puro (no uuid; admin-
            // controlled, gestisce collisioni manualmente). Storage: pool
            // condiviso /appdata/ibex/assets/logic_preset/. Niente filecache
            // (NC non monta /appdata, è dir IBEX-only).
            $id       = $slug;
            $filename = "{$slug}.json";

            $publicDir = $this->_publicPresetDir();
            if (!is_dir($publicDir)) {
                if (!@mkdir($publicDir, 0755, true) && !is_dir($publicDir)) {
                    echo json_encode(['success' => false, 'error' => 'mkdir public preset dir fallito (verifica permission '.$publicDir.')']);
                    return;
                }
            }
            $absDest = $publicDir . '/' . $filename;

            // Overwrite esplicito: se l'admin salva un preset con lo stesso
            // slug di uno esistente, viene sovrascritto. Comportamento
            // intenzionale (admin sa cosa fa, no uuid8 per coerenza).
            try {
                $this->_writePresetFile($obj, $absDest);
            } catch (\Exception $e) {
                if (is_file($absDest)) @unlink($absDest);
                echo json_encode(['success' => false, 'error' => $e->getMessage()]);
                return;
            }
        }

        echo json_encode([
            'success'     => true,
            'id'          => $id,
            'namespace'   => $namespace,
            'name'        => $name,
            'description' => $description,
            'created_at'  => $obj['created_at'],
        ]);
    }

    /** GET ?action=list_presets — ritorna { private, public, is_admin } */
    public function listPresets() {
        session_write_close();
        header('Content-Type: application/json');

        $uid = $_SESSION['nc_uid'] ?? '';
        if (!$uid) {
            echo json_encode(['success' => false, 'error' => 'auth missing']);
            return;
        }

        // Filter su .json (V1.1) e .bin (V1.0 backward compat).
        $listOf = function (string $dir, string $namespace): array {
            $items = [];
            if (!is_dir($dir)) return $items;
            $files = @scandir($dir) ?: [];
            foreach ($files as $f) {
                if ($f === '.' || $f === '..') continue;
                $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
                if (!in_array($ext, ['json', 'bin'], true)) continue;
                $abs = $dir . '/' . $f;
                $obj = $this->_readPresetFile($abs);
                if (!$obj) continue;
                // ID = filename senza estensione
                $id = substr($f, 0, -(strlen($ext) + 1));
                $items[] = [
                    'id'          => $id,
                    'namespace'   => $namespace,
                    'name'        => (string)($obj['name'] ?? $id),
                    'description' => (string)($obj['description'] ?? ''),
                    'created_at'  => (string)($obj['created_at'] ?? ''),
                    'author'      => (string)($obj['author'] ?? ''),
                    'node_count'  => is_array($obj['nodes'] ?? null) ? count($obj['nodes']) : 0,
                ];
            }
            usort($items, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
            return $items;
        };

        $private = $listOf($this->_privatePresetDir($uid), 'private');
        $public  = $listOf($this->_publicPresetDir(),     'public');

        echo json_encode([
            'success'  => true,
            'private'  => $private,
            'public'   => $public,
            'is_admin' => $this->_isAdmin($uid),
        ]);
    }

    /** GET ?action=load_preset&id=X&namespace=private|public — ritorna payload completo. */
    public function loadPreset() {
        session_write_close();
        header('Content-Type: application/json');

        $uid       = $_SESSION['nc_uid'] ?? '';
        $id        = (string)($_GET['id'] ?? '');
        $namespace = (string)($_GET['namespace'] ?? 'private');

        if (!$uid || $id === '') {
            echo json_encode(['success' => false, 'error' => 'missing fields']);
            return;
        }
        if (!in_array($namespace, ['private', 'public'], true)) {
            echo json_encode(['success' => false, 'error' => 'namespace non valido']);
            return;
        }
        // Whitelist id: privati = slug_uuid8, pubblici = slug libero.
        $regex = $namespace === 'private' ? '/^[a-z0-9-]+_[a-f0-9]{8}$/' : '/^[a-z0-9_-]+$/i';
        if (!preg_match($regex, $id)) {
            echo json_encode(['success' => false, 'error' => 'id non valido']);
            return;
        }

        $dir = $namespace === 'private' ? $this->_privatePresetDir($uid) : $this->_publicPresetDir();
        // V1.1 cerca .json + .bin (backward compat)
        $abs = $this->_resolvePresetPath($dir, $id);
        if (!$abs) {
            echo json_encode(['success' => false, 'error' => 'preset non trovato']);
            return;
        }
        $absReal = realpath($abs);
        $dirReal = realpath($dir);
        if (!$absReal || !$dirReal || strpos($absReal, $dirReal) !== 0) {
            echo json_encode(['success' => false, 'error' => 'preset non trovato']);
            return;
        }

        $obj = $this->_readPresetFile($absReal);
        if (!$obj) {
            echo json_encode(['success' => false, 'error' => 'preset corrotto o formato non valido']);
            return;
        }
        $obj['success']   = true;
        $obj['id']        = $id;
        $obj['namespace'] = $namespace;
        echo json_encode($obj);
    }

    /** POST ?action=delete_preset — body: id, namespace (default 'private').
     *  Privati: utente proprietario. Pubblici: solo admin (oc_group_user). */
    public function deletePreset() {
        session_write_close();
        header('Content-Type: application/json');

        $uid       = $_SESSION['nc_uid'] ?? '';
        $id        = (string)($_POST['id'] ?? '');
        $namespace = (string)($_POST['namespace'] ?? 'private');

        if (!$uid || $id === '') {
            echo json_encode(['success' => false, 'error' => 'missing fields']);
            return;
        }
        if (!in_array($namespace, ['private', 'public'], true)) {
            echo json_encode(['success' => false, 'error' => 'namespace non valido']);
            return;
        }
        if ($namespace === 'public' && !$this->_isAdmin($uid)) {
            echo json_encode(['success' => false, 'error' => 'permessi insufficienti: solo gli amministratori possono eliminare preset pubblici']);
            return;
        }

        // Whitelist id
        $regex = $namespace === 'private' ? '/^[a-z0-9-]+_[a-f0-9]{8}$/' : '/^[a-z0-9_-]+$/i';
        if (!preg_match($regex, $id)) {
            echo json_encode(['success' => false, 'error' => 'id non valido']);
            return;
        }

        $dir = $namespace === 'private' ? $this->_privatePresetDir($uid) : $this->_publicPresetDir();
        $abs = $this->_resolvePresetPath($dir, $id); // .json o .bin
        if (!$abs) {
            echo json_encode(['success' => false, 'error' => 'preset non trovato']);
            return;
        }
        $absReal = realpath($abs);
        $dirReal = realpath($dir);
        if (!$absReal || !$dirReal || strpos($absReal, $dirReal) !== 0) {
            echo json_encode(['success' => false, 'error' => 'preset non trovato']);
            return;
        }

        if ($namespace === 'private') {
            // Rimuovi file + filecache row + touch parent etag (NC sync).
            $ext = strtolower(pathinfo($absReal, PATHINFO_EXTENSION));
            try {
                $this->db->beginTransaction();
                $stmt = $this->db->prepare("SELECT numeric_id FROM nextcloud.oc_storages WHERE id = ?");
                $stmt->execute(["home::{$uid}"]);
                $storageId = (int)$stmt->fetchColumn();

                if ($storageId) {
                    $relPath = "files/IBEX/.ibex_internal/presets/{$id}.{$ext}";
                    $stmt = $this->db->prepare("DELETE FROM nextcloud.oc_filecache WHERE storage = ? AND path_hash = ?");
                    $stmt->execute([$storageId, md5($relPath)]);

                    $touchPaths = [
                        'files',
                        'files/IBEX',
                        'files/IBEX/.ibex_internal',
                        'files/IBEX/.ibex_internal/presets',
                    ];
                    $upd = $this->db->prepare("UPDATE nextcloud.oc_filecache SET etag = ? WHERE storage = ? AND path_hash = ?");
                    foreach ($touchPaths as $p) {
                        $upd->execute([bin2hex(random_bytes(8)), $storageId, md5($p)]);
                    }
                }
                if (!@unlink($absReal)) throw new \Exception("unlink fallito: {$absReal}");
                $this->db->commit();
            } catch (\Exception $e) {
                if ($this->db->inTransaction()) $this->db->rollBack();
                echo json_encode(['success' => false, 'error' => $e->getMessage()]);
                return;
            }
        } else {
            // Pubblico: solo unlink, no filecache (è in /appdata, fuori NC)
            if (!@unlink($absReal)) {
                echo json_encode(['success' => false, 'error' => "unlink fallito: {$absReal}"]);
                return;
            }
        }

        echo json_encode(['success' => true, 'id' => $id, 'namespace' => $namespace]);
    }

    /* ═════════════════════════════════════════════════════════════════════════
       L10.3 — TRANSCODIFICA STL binario → OBJ / PLY (SOLO geometria).

       Sorgente: SEMPRE `preview/{mesh}.stl` (binario, scritto da IBEX stessa via
       trimesh / PyMeshLab / STLExporter). Nessun colore, nessun materiale, nessun
       `.mtl`: il MatCap è un artificio di viewport, non un attributo della mesh.

       🔴 Endianness — l'STL è little-endian per specifica:
          `f`/`l` di unpack seguono l'ordine della MACCHINA → MAI usarli qui.
          Si usano `g` (float32 LE), `V` (uint32 LE), `v` (uint16 LE).

       Memoria: lettura a blocchi di 50 B × N. PLY = streaming puro (costante).
       OBJ = weld esatto → l'unica struttura che cresce con la mesh (vedi cap).
       ───────────────────────────────────────────────────────────────────────── */

    private const EXPORT_FORMATS   = ['stl', 'obj', 'ply'];
    private const STL_TRI_CHUNK    = 2000;       // 2000 × 50 B = 100 000 B per fread
    private const IO_FLUSH_BYTES   = 1048576;    // 1 MiB di buffer prima di fwrite
    private const OBJ_CAP_NO_LIMIT = 5000000;    // cap se memory_limit = -1
    /* Byte di picco per triangolo del weld OBJ. MISURATO il 2026-07-25 su una mesh
       dentale vera (236 250 triangoli): 48,8 B/tri, picco 11,5 MB. Qui sta il doppio,
       cioè metà della capienza teorica come margine.
       ⚠️ È una stima STRUTTURALE: la memoria dipende dai vertici UNICI, quindi da
       quanto la mesh condivide davvero. Una mesh patologica senza vertici condivisi
       costerebbe ~3× questo valore → per quella c'è la guardia a runtime nel weld
       (_transcodeStlToObj), che misura invece di stimare. */
    private const OBJ_BYTES_PER_TRI = 98;
    /* Triangoli/secondo del weld OBJ — MISURATI 530 924/s, qui sta la metà. Serve al
       secondo tetto del cap, derivato da `max_execution_time`: senza, un memory_limit
       alto lascerebbe passare mesh che non finiscono in tempo → fatal 500 invece del
       messaggio pulito «esportala in STL o PLY». */
    private const OBJ_TRI_PER_SEC   = 250000;
    /* Frazione di `memory_limit` oltre la quale il weld si ferma da solo. */
    private const OBJ_MEM_GUARD     = 0.75;
    /* Byte dei DUE temporanei OBJ per triangolo (righe `v` + righe `f`), stima
       generosa: serve SOLO a scegliere dove metterli (vedi `_objTmpDir`). */
    private const OBJ_TMP_BYTES_PER_TRI = 140;

    /** Sonda una-tantum: su locale non-C `%g` può produrre la VIRGOLA decimale
        (un OBJ con `12,345` è corrotto e se ne accorge solo la fresatrice). */
    private static ?bool $_decimalComma = null;

    private function _fmtCoord(float $v): string {
        if (self::$_decimalComma === null) {
            self::$_decimalComma = (strpos(sprintf('%.9g', 1.5), ',') !== false);
        }
        if (!is_finite($v)) {
            // Meglio un errore esplicito che un OBJ sintatticamente valido con
            // `v nan nan nan` dentro: quello lo scopre la fresatrice.
            throw new \Exception('coordinata non finita (NaN/Inf) nell\'STL sorgente: mesh non esportabile');
        }
        // %.9g = 9 cifre significative = round-trip esatto di un float32.
        $s = sprintf('%.9g', $v);
        // …ma `%g` passa alla NOTAZIONE ESPONENZIALE per esponenti < -4 o ≥ 9:
        // `2.99999992e-05` è legale per chi usa strtod (Blender, MeshLab, three.js)
        // e illeggibile per i parser OBJ ingenui di certi CAM. Riscrittura in
        // notazione fissa — resta round-trip esatto sul float32 (17 decimali
        // coprono l'intero range utile; sotto ~1e-17 mm il valore È zero).
        if (strpbrk($s, 'eE') !== false) {
            $s = rtrim(rtrim(sprintf('%.17F', $v), '0'), '.');
            if ($s === '' || $s === '-') $s = '0';
        }
        return self::$_decimalComma ? strtr($s, ',', '.') : $s;
    }

    /** `fwrite` che NON tollera la scrittura parziale. Su disco pieno / quota
     *  esaurita `fwrite` scrive quel che può e ritorna un conteggio corto SENZA
     *  emettere nulla: il file resterebbe troncato e proseguirebbe comunque verso
     *  `rename` + registrazione in oc_filecache + commit della transazione. */
    private function _fw($h, string $s): void {
        if ($s === '') return;
        $n = @fwrite($h, $s);
        if ($n === false || $n !== strlen($s)) {
            throw new \Exception('scrittura del file di export fallita (disco pieno o quota esaurita?)');
        }
    }

    /** `fclose` con esito verificato: il flush finale del buffer di stream avviene
     *  QUI, quindi un ENOSPC può emergere solo alla chiusura. Va chiamata nel path
     *  di successo, MAI da un `finally` (mascherebbe l'eccezione in volo). */
    private function _fclose($h): void {
        if (!is_resource($h)) return;
        if (@fclose($h) === false) {
            throw new \Exception('chiusura del file di export fallita (scrittura non completata)');
        }
    }

    /** Dove nascono i due temporanei del weld OBJ. Preferenza alla temp dir del
     *  container (stesso pattern di `create_flat_zip`), così i file intermedi NON
     *  compaiono nella cartella Nextcloud dell'utente — dove resterebbero visibili
     *  se il processo muore di fatal (i `finally` di PHP non girano sui fatal).
     *  Si ripiega sulla cartella di destinazione se /tmp non è usabile o non ha
     *  spazio: in un container può essere un tmpfs piccolo. */
    private function _objTmpDir(int $nTri, string $fallbackDir): string {
        $sys = rtrim((string)sys_get_temp_dir(), '/');
        if ($sys === '' || !is_dir($sys) || !is_writable($sys)) return $fallbackDir;
        $need = (float)$nTri * self::OBJ_TMP_BYTES_PER_TRI * 2.0;   // 2× di margine
        $free = @disk_free_space($sys);
        if ($free !== false && (float)$free < $need) return $fallbackDir;
        return $sys;
    }

    /** Apre l'STL binario e valida `84 + 50·nTri == filesize`.
     *  @return array{0: resource, 1: int} */
    private function _openBinaryStl(string $src) {
        $size = @filesize($src);
        $fh   = @fopen($src, 'rb');
        if (!$fh) throw new \Exception("apertura STL sorgente fallita");
        $hdr = fread($fh, 84);
        if ($hdr === false || strlen($hdr) < 84) {
            fclose($fh);
            throw new \Exception("STL sorgente troncato (< 84 byte)");
        }
        $u    = unpack('V', substr($hdr, 80, 4));   // uint32 LE
        $nTri = (int)($u[1] ?? 0);
        $expected = 84 + 50 * $nTri;
        if ($nTri <= 0 || $expected !== (int)$size) {
            fclose($fh);
            // Gli STL di preview/ li scrive IBEX: una discordanza è CORRUZIONE,
            // non un caso da tollerare. (Copre anche l'eventuale STL ASCII: il
            // discriminante è l'aritmetica delle dimensioni, non il magic.)
            throw new \Exception("STL sorgente incoerente: header dichiara {$nTri} triangoli (attesi {$expected} byte) ma il file ne ha {$size}");
        }
        return [$fh, $nTri];
    }

    private function _transcodeStl(string $src, string $dstTmp, string $fmt): void {
        switch ($fmt) {
            case 'ply': $this->_transcodeStlToPly($src, $dstTmp); return;
            case 'obj': $this->_transcodeStlToObj($src, $dstTmp); return;
            default:    throw new \Exception("formato di transcodifica non gestito: {$fmt}");
        }
    }

    /** PLY binary_little_endian, SENZA weld → memoria costante, nessun cap.
     *  Stessa "zuppa di triangoli" dello STL: zero perdita rispetto a oggi. */
    private function _transcodeStlToPly(string $src, string $dstTmp): void {
        [$fh, $nTri] = $this->_openBinaryStl($src);
        $out = @fopen($dstTmp, 'wb');
        if (!$out) { fclose($fh); throw new \Exception("apertura output PLY fallita"); }
        try {   // ⚠️ ogni scrittura passa da _fw: una fwrite corta (ENOSPC) qui
                //    significherebbe conteggi d'header che non tornano col binario.
            $nVert = 3 * $nTri;
            // Header da lista di proprietà: aggiungere red/green/blue in futuro
            // resta un edit locale (una riga in $props).
            $props  = ['property float x', 'property float y', 'property float z'];
            $header = "ply\n"
                    . "format binary_little_endian 1.0\n"
                    . "comment IBEX\n"
                    . "element vertex {$nVert}\n"
                    . implode("\n", $props) . "\n"
                    . "element face {$nTri}\n"
                    . "property list uchar int vertex_indices\n"
                    . "end_header\n";          // ← il binario inizia SUBITO dopo
            $this->_fw($out, $header);

            // Vertici: i 36 B (3 × float32 LE) si ricopiano VERBATIM dal record STL
            // (offset 12, dopo la normale) — più veloce e bit-esatto.
            $remaining = $nTri;
            while ($remaining > 0) {
                $batch = min(self::STL_TRI_CHUNK, $remaining);
                $data  = fread($fh, 50 * $batch);
                if ($data === false || strlen($data) !== 50 * $batch) {
                    throw new \Exception("lettura STL troncata durante la transcodifica");
                }
                $buf = '';
                for ($t = 0; $t < $batch; $t++) $buf .= substr($data, $t * 50 + 12, 36);
                $this->_fw($out, $buf);
                $remaining -= $batch;
            }

            // Facce: senza weld gli indici sono 3i, 3i+1, 3i+2 → nessuna rilettura.
            $bufF = '';
            for ($i = 0; $i < $nTri; $i++) {
                $b = 3 * $i;
                $bufF .= pack('C', 3) . pack('VVV', $b, $b + 1, $b + 2);
                if (strlen($bufF) >= self::IO_FLUSH_BYTES) { $this->_fw($out, $bufF); $bufF = ''; }
            }
            $this->_fw($out, $bufF);
            $this->_fclose($out); $out = null;   // il flush finale può ancora fallire
        } finally {
            fclose($fh);
            // difensivo: nel path di successo è già chiusa (e verificata) sopra.
            if (is_resource($out)) @fclose($out);
        }
    }

    /** OBJ ASCII con weld ESATTO (nessun epsilon): negli STL prodotti da IBEX i
     *  vertici coincidenti sono bit-identici, quindi la chiave è il terzetto di
     *  12 byte grezzi. Due file temporanei (vertici / facce) → mai le facce in RAM. */
    private function _transcodeStlToObj(string $src, string $dstTmp): void {
        [$fh, $nTri] = $this->_openBinaryStl($src);
        $cap = $this->_objCapTriangles();
        if ($nTri > $cap) {
            fclose($fh);
            // Errore PRIMA di qualunque scrittura (e, a monte, prima del commit
            // della transazione): STL e PLY non hanno cap → via d'uscita sempre presente.
            throw new \Exception("mesh troppo densa per l'export OBJ ({$nTri} triangoli, limite {$cap}): esportala in STL o PLY");
        }
        $dir  = $this->_objTmpDir($nTri, dirname($dstTmp));
        $tmpV = tempnam($dir, '.objv-');
        $tmpF = tempnam($dir, '.objf-');
        if ($tmpV === false || $tmpF === false) {
            fclose($fh);
            if ($tmpV !== false) @unlink($tmpV);
            if ($tmpF !== false) @unlink($tmpF);
            throw new \Exception("tempnam fallito per la transcodifica OBJ");
        }
        // I `finally` NON girano sui fatal (memory_limit, max_execution_time) e il
        // fatal più probabile è proprio qui: questa è l'unica rete contro i residui.
        register_shutdown_function(static function () use ($tmpV, $tmpF) {
            if (is_file($tmpV)) @unlink($tmpV);
            if (is_file($tmpF)) @unlink($tmpF);
        });
        $fv = null; $ff = null;
        try {
            $fv = @fopen($tmpV, 'wb');
            $ff = @fopen($tmpF, 'wb');
            if (!$fv || !$ff) throw new \Exception("apertura temporanei OBJ fallita");
            $this->_fw($fv, "# IBEX — export geometria (nessun materiale)\n");

            $memLimit = $this->_memoryLimitBytes();
            $memCeil  = $memLimit > 0 ? (int)($memLimit * self::OBJ_MEM_GUARD) : 0;
            $map  = [];   // 'v'+12 byte grezzi → indice 1-based. UNICA struttura che cresce.
            $next = 0;
            $bufV = '';
            $bufF = '';
            $remaining = $nTri;
            while ($remaining > 0) {
                $batch = min(self::STL_TRI_CHUNK, $remaining);
                $data  = fread($fh, 50 * $batch);
                if ($data === false || strlen($data) !== 50 * $batch) {
                    throw new \Exception("lettura STL troncata durante la transcodifica");
                }
                for ($t = 0; $t < $batch; $t++) {
                    $base = $t * 50 + 12;                 // salta la normale
                    $i0 = 0; $i1 = 0; $i2 = 0;
                    for ($k = 0; $k < 3; $k++) {
                        $raw = substr($data, $base + $k * 12, 12);
                        // prefisso letterale: nessuna conversione chiave→numero da parte di PHP
                        $key = 'v' . $raw;
                        if (isset($map[$key])) {
                            $idx = $map[$key];
                        } else {
                            $c = unpack('g3', $raw);      // 3 × float32 LE
                            $idx = ++$next;
                            $map[$key] = $idx;
                            $bufV .= 'v ' . $this->_fmtCoord($c[1]) . ' '
                                          . $this->_fmtCoord($c[2]) . ' '
                                          . $this->_fmtCoord($c[3]) . "\n";
                        }
                        if ($k === 0) $i0 = $idx; elseif ($k === 1) $i1 = $idx; else $i2 = $idx;
                    }
                    $bufF .= "f {$i0} {$i1} {$i2}\n";     // indici OBJ 1-based
                }
                if (strlen($bufV) >= self::IO_FLUSH_BYTES) { $this->_fw($fv, $bufV); $bufV = ''; }
                if (strlen($bufF) >= self::IO_FLUSH_BYTES) { $this->_fw($ff, $bufF); $bufF = ''; }
                $remaining -= $batch;
                // Guardia a RUNTIME (una lettura ogni 2000 triangoli, costo nullo).
                // Il cap statico STIMA la memoria dal numero di triangoli, ma il weld
                // cresce coi vertici UNICI: una mesh che non condivide nulla costa ~3×
                // la media misurata. Qui si MISURA e si esce con lo stesso errore
                // leggibile, prima che sia l'allocatore a morire di fatal — cioè prima
                // di qualunque scrittura sulla destinazione e prima del commit.
                if ($memCeil > 0 && memory_get_usage(true) > $memCeil) {
                    throw new \Exception("mesh troppo densa per l'export OBJ (memoria esaurita durante il weld, {$nTri} triangoli): esportala in STL o PLY");
                }
            }
            $this->_fw($fv, $bufV);
            $this->_fw($ff, $bufF);
            $this->_fclose($fv); $fv = null;
            $this->_fclose($ff); $ff = null;
            unset($map, $bufV, $bufF);

            // Concatenazione in streaming: vertici, poi facce.
            $out = @fopen($dstTmp, 'wb');
            if (!$out) throw new \Exception("apertura output OBJ fallita");
            try {
                foreach ([$tmpV, $tmpF] as $part) {
                    $in = @fopen($part, 'rb');
                    if (!$in) throw new \Exception("rilettura temporaneo OBJ fallita");
                    try {
                        while (!feof($in)) {
                            $b = fread($in, self::IO_FLUSH_BYTES);
                            // ⚠️ MAI `break` qui: uscirebbe dal solo `while` e il
                            // `foreach` proseguirebbe con le FACCE → un OBJ con tutte
                            // le righe `f` e solo una parte delle `v`, cioè indici
                            // fuori range, pubblicato e consegnato come valido.
                            if ($b === false) throw new \Exception("rilettura temporaneo OBJ fallita (errore di I/O)");
                            $this->_fw($out, $b);
                        }
                    } finally { fclose($in); }
                }
                $this->_fclose($out); $out = null;
            } finally { if (is_resource($out)) @fclose($out); }
        } finally {
            fclose($fh);
            if (is_resource($fv)) fclose($fv);
            if (is_resource($ff)) fclose($ff);
            @unlink($tmpV);
            @unlink($tmpF);
        }
    }

    /** Cap triangoli per l'OBJ, derivato a RUNTIME da `memory_limit`
     *  (il weld è l'unica parte con memoria proporzionale alla mesh). */
    /** `memory_limit` in byte; 0 = nessun limite (o valore non interpretabile). */
    private function _memoryLimitBytes(): int {
        $raw = trim((string)ini_get('memory_limit'));
        if ($raw === '' || $raw === '-1') return 0;
        $mult = 1;
        $suf  = strtoupper(substr($raw, -1));
        if     ($suf === 'K') $mult = 1024;
        elseif ($suf === 'M') $mult = 1048576;
        elseif ($suf === 'G') $mult = 1073741824;
        $bytes = (int)((float)$raw * $mult);
        return $bytes > 0 ? $bytes : 0;
    }

    private function _objCapTriangles(): int {
        $cap   = self::OBJ_CAP_NO_LIMIT;
        $bytes = $this->_memoryLimitBytes();
        if ($bytes > 0) {
            $cap = max(50000, (int)floor(($bytes * 0.5) / self::OBJ_BYTES_PER_TRI));
        }
        // Secondo tetto: il TEMPO. Il weld gira dentro la transazione del burn;
        // un cap derivato solo dalla memoria lascerebbe passare, con memory_limit
        // alto, mesh che sforano `max_execution_time` → fatal invece dell'errore
        // pulito. `0` = nessun limite di tempo (CLI) → resta il solo cap-memoria.
        $secs = (int)ini_get('max_execution_time');
        if ($secs > 0) {
            $cap = min($cap, max(50000, (int)floor($secs * 0.5 * self::OBJ_TRI_PER_SEC)));
        }
        return $cap;
    }

    private function _registerFileInNextcloud(string $uid, string $relPathInsideHome, string $absPath, string $fmt = 'stl'): void {
        // Lookup storage (home utente)
        $stmt = $this->db->prepare("SELECT numeric_id FROM nextcloud.oc_storages WHERE id = ?");
        $stmt->execute(["home::{$uid}"]);
        $storageId = (int)$stmt->fetchColumn();
        if (!$storageId) {
            throw new \Exception("Storage Nextcloud non trovato per utente {$uid}");
        }

        // Lookup mimetype per FORMATO + la sua "parte" (con fallback hardcoded ai
        // valori osservati sul DB attuale 60/5 se nessun candidato si risolve).
        // L10.3: prima era fisso `application/sla` per QUALUNQUE file → un .obj/.ply
        // finiva in NC dichiarato STL (icona/anteprima/handler sbagliati).
        // ⚠️ Si LEGGE soltanto: nessun INSERT in oc_mimetypes (è la macchina di NC).
        //    Un candidato è accettato solo se si risolvono SIA il mimetype SIA la sua
        //    parte, altrimenti si passa al successivo: così la riga in oc_filecache
        //    non è mai incoerente (es. `model/obj` con mimepart `application`).
        $stmt = $this->db->prepare("SELECT id FROM nextcloud.oc_mimetypes WHERE mimetype = ?");
        if ($fmt === 'stl') {
            // Ramo IDENTICO a prima di L10.3, riga per riga: `_registerFileInNextcloud`
            // è chiamata anche da savePreset (un .json) col default 'stl', e quel
            // comportamento non deve cambiare — nemmeno nel caso di bordo in cui
            // `application/sla` non fosse in tabella.
            $stmt->execute(['application/sla']);
            $mimeFile = (int)$stmt->fetchColumn() ?: 60;
            $stmt->execute(['application']);
            $mimePart = (int)$stmt->fetchColumn() ?: 5;
        } else {
            $mimeCandidates = [
                'obj' => ['model/obj', 'text/plain', 'application/octet-stream'],
                'ply' => ['model/ply', 'application/octet-stream'],
            ];
            $mimeFile = 0;
            $mimePart = 0;
            foreach ($mimeCandidates[$fmt] as $cand) {
                $stmt->execute([$cand]);
                $idFull = (int)$stmt->fetchColumn();
                if (!$idFull) continue;
                $stmt->execute([explode('/', $cand)[0]]);
                $idPart = (int)$stmt->fetchColumn();
                if (!$idPart) continue;             // parte assente → candidato scartato
                $mimeFile = $idFull;
                $mimePart = $idPart;
                break;
            }
            if (!$mimeFile || !$mimePart) {
                // Nessun INSERT in oc_mimetypes: si scende sul fallback storico e LO SI
                // SEGNALA. Senza il log, un .obj finirebbe dichiarato `application/sla`
                // in silenzio — esattamente il difetto che questa modifica chiude.
                error_log("[IBEX][export] nessun mimetype risolto per .{$fmt} in oc_mimetypes: registrato col fallback 60/5 (application/sla).");
                $mimeFile = 60;
                $mimePart = 5;
            }
        }
        $stmt->execute(['httpd/unix-directory']);
        $mimeDir = (int)$stmt->fetchColumn() ?: 2;
        $stmt->execute(['httpd']);
        $mimeHttpd = (int)$stmt->fetchColumn() ?: 1;

        // Path NC ha sempre prefisso "files/" sotto la home
        $relPath = "files/" . $relPathInsideHome;
        $segments = explode('/', $relPath);
        $fileName = array_pop($segments);
        $dirSegments = $segments; // ["files", "COMO", ...]

        // Walk parent dirs: per ognuna lookup nel filecache, crea se mancante.
        $parentId = -1; // root storage virtual parent
        $currentPath = '';
        foreach ($dirSegments as $seg) {
            $currentPath = $currentPath === '' ? $seg : "{$currentPath}/{$seg}";
            $pathHash = md5($currentPath);

            $stmt = $this->db->prepare(
                "SELECT fileid FROM nextcloud.oc_filecache WHERE storage = ? AND path_hash = ?"
            );
            $stmt->execute([$storageId, $pathHash]);
            $existing = $stmt->fetchColumn();
            if ($existing !== false) {
                $parentId = (int)$existing;
                continue;
            }

            // Crea riga directory mancante.
            $absDir = "/data/nextcloud-storage/{$uid}/{$currentPath}";
            if (!is_dir($absDir)) {
                throw new \Exception("Cartella {$currentPath} non esiste su disco");
            }
            $mtime = filemtime($absDir) ?: time();
            $etag = bin2hex(random_bytes(8));

            // permissions=31 (read+update+create+delete+share = 1+2+4+8+16)
            $stmt = $this->db->prepare(
                "INSERT INTO nextcloud.oc_filecache
                    (storage, path, path_hash, parent, name,
                     mimetype, mimepart, size, mtime, storage_mtime,
                     encrypted, unencrypted_size, etag, permissions)
                 VALUES (?, ?, ?, ?, ?, ?, ?, -1, ?, ?, 0, 0, ?, 31)"
            );
            $stmt->execute([
                $storageId, $currentPath, $pathHash, $parentId, $seg,
                $mimeDir, $mimeHttpd, $mtime, $mtime, $etag
            ]);
            $parentId = (int)$this->db->lastInsertId();
        }

        // Insert/update riga file
        $size  = filesize($absPath) ?: 0;
        $mtime = filemtime($absPath) ?: time();
        $etag  = bin2hex(random_bytes(8));
        $pathHash = md5($relPath);

        $stmt = $this->db->prepare(
            "SELECT fileid FROM nextcloud.oc_filecache WHERE storage = ? AND path_hash = ?"
        );
        $stmt->execute([$storageId, $pathHash]);
        $existingFileId = $stmt->fetchColumn();

        if ($existingFileId !== false) {
            // Overwrite: aggiorna size/mtime/etag (path/parent invariati)
            $stmt = $this->db->prepare(
                "UPDATE nextcloud.oc_filecache
                 SET size = ?, mtime = ?, storage_mtime = ?, etag = ?, mimetype = ?, mimepart = ?
                 WHERE fileid = ?"
            );
            $stmt->execute([$size, $mtime, $mtime, $etag, $mimeFile, $mimePart, (int)$existingFileId]);
        } else {
            // permissions=27 per file (read+update+delete+share = 1+2+8+16)
            $stmt = $this->db->prepare(
                "INSERT INTO nextcloud.oc_filecache
                    (storage, path, path_hash, parent, name,
                     mimetype, mimepart, size, mtime, storage_mtime,
                     encrypted, unencrypted_size, etag, permissions)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 27)"
            );
            $stmt->execute([
                $storageId, $relPath, $pathHash, $parentId, $fileName,
                $mimeFile, $mimePart, $size, $mtime, $mtime, $etag
            ]);
        }

        // Touch etag di TUTTI i parent (NC walks parent etag chain per change
        // detection — se un parent etag non cambia, il client non rifresha).
        $stmt = $this->db->prepare(
            "UPDATE nextcloud.oc_filecache SET etag = ? WHERE fileid = ?"
        );
        $touchPath = '';
        foreach ($dirSegments as $seg) {
            $touchPath = $touchPath === '' ? $seg : "{$touchPath}/{$seg}";
            $h = md5($touchPath);
            $sel = $this->db->prepare("SELECT fileid FROM nextcloud.oc_filecache WHERE storage = ? AND path_hash = ?");
            $sel->execute([$storageId, $h]);
            $fid = $sel->fetchColumn();
            if ($fid !== false) {
                $stmt->execute([bin2hex(random_bytes(8)), (int)$fid]);
            }
        }
    }
}