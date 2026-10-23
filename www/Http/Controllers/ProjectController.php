<?php
namespace App\Http\Controllers;

use PDO;
use Redis;
use App\Core\ProjectRegistry;
use App\Core\IbexConfig;
use Exception;

// S8 (2026-07-10): rimossi use ZipArchive/RecursiveIterator* (orfani di
// finalize, purgato S7).
class ProjectController {
    private $db;
    private $redis;

    public function __construct() {
        $host = getenv('DB_HOST'); $dbname = getenv('DB_NAME'); $user = getenv('DB_USER'); $pass = getenv('DB_PASS');
        try {
            $this->db = new PDO("mysql:host=$host;dbname=$dbname;charset=utf8mb4", $user, $pass);
            $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $this->redis = new Redis();
            try { $this->redis->connect(IbexConfig::redisHost(), 6379, 2.5); $rp = getenv('IBEX_REDIS_PASS'); if ($rp) { $this->redis->auth($rp); } } catch (Exception $e) {}
        } catch (Exception $e) {
            // Silenzioso o log, ma non crashare costruttore
        }
    }

    // ═══ S7 PURGA (2026-07-10): create/store/index/delete/finalize RIMOSSI
    // (vecchia dashboard/lobby PHP — sostituita dalla shell NC ibex_workspace).
    // Originale integrale: era in _quarantine/2026-07/ProjectController-pre-s7.php
    // (quarantena rimossa 28/7; recupero = snapshot ZFS). ═══

    /** Redirect alla lobby Nextcloud (IbexConfig::lobbyUrl()); 500 se NEXTCLOUD_URL non è configurato. */
    private function redirectToLobby(): void {
        $lobby = IbexConfig::lobbyUrl();
        if ($lobby === '') { http_response_code(500); echo 'NEXTCLOUD_URL non configurato'; exit; }
        header("Location: $lobby");
        exit;
    }

    public function exit_safe() {
        // S6 (Q4, 2026-07-10): l'uscita standalone atterra sulla lobby NC
        // (ibex_workspace), non più sulla vecchia dashboard (purga in S7).
        // In embed questo path non è raggiungibile (header editor nascosto).
        $uid = $_SESSION['nc_uid'] ?? null;
        $id = $_GET['id'] ?? null;
        if (!$uid || !$id || !ctype_digit((string)$id)) { $this->redirectToLobby(); }

        $activeDir = "/appdata/ibex/active/$uid/$id";
        // de-DB: ownership = path uid-scoping + registry. active/{uid}/{id} è namespaced per uid;
        // se assente (cold), il registry deve confermare che uid possiede il pid.
        $owner = ProjectRegistry::ownerOf($this->redis, (int)$id);
        if (!is_dir($activeDir) && $owner !== null && $owner !== $uid) { $this->redirectToLobby(); }
        if (is_dir($activeDir)) {
            $this->rrmdir($activeDir);
        }
        $this->redirectToLobby();
    }

    /**
     * S1 «IBEX semplice» (2026-07-10) — creazione progetto VUOTO.
     * Corpo transazionale identico a store() SENZA la guardia file:
     * files=[] è legittimo (worker INIT 0-mesh già green — logic_builder:133,
     * scene.blend vuota + pivots {} + manifest input_files:[]).
     * Nome auto "Senza titolo {N}" UNICO per utente, calcolato in
     * transazione con FOR UPDATE (le schede shell risolvono per nome).
     */
    public function storeEmpty() {
        $uid = $_SESSION['nc_uid'];

        try {
            // de-DB 2026-07-20: nessun INSERT/lastInsertId/transazione. pid da INCR Redis,
            // nome «Senza titolo N» via lock Redis (ex FOR UPDATE), identità nel registry.
            // La verità durevole (project_id/name/uid) la scrive il worker nel manifest a INIT.
            $projectId   = ProjectRegistry::allocatePid($this->redis);
            $projectName = ProjectRegistry::nextUntitled($this->redis, $uid);
            ProjectRegistry::bind($this->redis, $uid, $projectName, $projectId);
            $this->redis->setEx("project:$projectId:status", 3600, 'queued');

            // lPush INIT_PROJECT (invariato): il worker crea active/ + .ibex + manifest.
            try {
                $pushed = $this->redis->lPush('ibex_tasks', json_encode([
                    'action' => 'INIT_PROJECT',
                    'uid' => $uid,
                    'project_id' => $projectId,
                    'project_name' => $projectName,
                    'files' => []
                ]));
                if (!$pushed) throw new Exception('Redis lPush fallito');
            } catch (\Throwable $qe) {
                $this->redis->setEx("project:$projectId:status", 3600, 'error');
                if (isset($_GET['json'])) {
                    header('Content-Type: application/json');
                    echo json_encode(['success' => false, 'error' => 'Errore coda worker: ' . $qe->getMessage()]);
                    exit;
                }
                // S7: la vecchia lobby non esiste più — path non-JSON residuale → lobby NC.
                $this->redirectToLobby();
            }

            // S4: risposta JSON per la creazione via proxy shell NC (page#create). Byte-identica.
            if (isset($_GET['json'])) {
                header('Content-Type: application/json');
                echo json_encode(['success' => true, 'id' => (int)$projectId, 'name' => $projectName]);
                exit;
            }
            header("Location: /?action=editor&id=" . $projectId);
            exit;
        } catch (Exception $e) {
            if (isset($_GET['json'])) {
                header('Content-Type: application/json');
                echo json_encode(['success' => false, 'error' => $e->getMessage()]);
                exit;
            }
            // S7: path non-JSON residuale → lobby NC.
            $this->redirectToLobby();
        }
    }

    // ==========================================
    // 💎 IL CARICATORE HOT-SWAP (V4.2 ANTI-CORRUZIONE + JSON SIDECAR)
    // ==========================================
    public function serve_file() {
        $uid = $_SESSION['nc_uid'] ?? null;
        session_write_close(); // Rilascia il lock file-sessione prima di streamare file grandi — permette fetch paralleli
        $projectId = $_GET['project_id'] ?? null;
        $fileName = $_GET['file'] ?? null;

        if (!$uid || !$projectId || !ctype_digit((string)$projectId) || !$fileName) {
            header("HTTP/1.1 400 Bad Request"); exit;
        }

        // de-DB ownership (hot-path): i path serviti sono già namespaced per uid
        // (active/{uid}/{projectId}, /data/nextcloud-storage/{uid}/files/). Gate leggero:
        // active/{uid}/{projectId} deve esistere (il cold-path realpath-sandbox a valle
        // resta la difesa contro traversal). Registry come conferma per il caso cold.
        $owner = ProjectRegistry::ownerOf($this->redis, (int)$projectId);
        if ($owner !== null && $owner !== $uid) { http_response_code(403); exit; }
        if ($owner === null && !is_dir("/appdata/ibex/active/$uid/$projectId")) { http_response_code(403); exit; }

        $cleanName = basename($fileName);
        $ext = strtolower(pathinfo($cleanName, PATHINFO_EXTENSION));

        // ColorReady L11.3 (2026-07-24): il color-source {stem}.ply è SOLO server-side
        // (viaggia nel .ibex, alimenta compress_stl → colore nel .drc). Il client fetcha
        // SEMPRE E SOLO .drc/.stl — mai il .ply. Rendiamo l'invariante REALE: senza questo
        // guard `serve_file` servirebbe {stem}.ply all'owner autenticato (nessun leak oltre
        // lo status quo — è la sua stessa scansione — ma l'invariante «PLY mai al browser»
        // deve essere imposta lato server, non solo convenzione client).
        if ($ext === 'ply') { http_response_code(404); exit; }

        // FIX IBEX V8: I JSON dei metadati pesano pochissimo (es. 40 byte). Gli STL devono superare i 100.
        $minSize = ($ext === 'json') ? 10 : 100; 
        
        // Modalità esplicita "from=baked": serve solo da active_path/baked/ (export V2.0).
        // Nessun fallback a preview/ o cold — se manca, 404. La UI lo usa per offrire
        // il download dell'export finale dopo BAKE_PROJECT.
        $fromBaked = (($_GET['from'] ?? '') === 'baked');
        $bakedPath = "/appdata/ibex/active/$uid/$projectId/baked/$cleanName";

        // Modalità esplicita "from=master": salta la priority su preview/ e serve
        // direttamente i master STL/DRC da active_path/. Usato dal frontend quando
        // l'utente rimuove nodi dal DAG → la queue diventa vuota (o orfana per un
        // target) e serve ripristinare visivamente lo stato scanner-space senza
        // toccare preview/ lato server. Fallback cold se master mancante.
        $fromMaster = (($_GET['from'] ?? '') === 'master');

        // 1. Cerca nella Sandbox di Anteprima
        $previewPath = "/appdata/ibex/active/$uid/$projectId/preview/$cleanName";
        // 2. Cerca nella cartella del progetto attivo
        $activePath = "/appdata/ibex/active/$uid/$projectId/$cleanName";
        // 3. Fallback nel Nextcloud — sandbox check (pattern ex-FileService, quarantenato S8)
        //    Blocca path traversal: ../, symlink fugaci, e qualunque path che esca da
        //    /data/nextcloud-storage/$uid/. realpath() resolve i symlink prima del check.
        $coldStoragePath = "/data/nextcloud-storage/$uid/files/" . ltrim($fileName, '/');
        $coldRealPath = realpath($coldStoragePath);
        $coldBaseReal = realpath("/data/nextcloud-storage/$uid/files");
        if (!$coldRealPath || !$coldBaseReal || strpos($coldRealPath, $coldBaseReal . '/') !== 0) {
            $storagePath = null; // fuori sandbox o path inesistente → blocca fallback cold
        } else {
            $storagePath = $coldStoragePath;
        }

        clearstatcache(true, $bakedPath);
        clearstatcache(true, $previewPath);
        clearstatcache(true, $activePath);

        $fileToServe = null;

        if ($fromBaked) {
            // Modalità esplicita: solo baked/, niente fallback
            if (file_exists($bakedPath) && filesize($bakedPath) > $minSize) {
                $fileToServe = $bakedPath;
            } else {
                header("HTTP/1.1 404 Not Found");
                exit;
            }
        } elseif ($fromMaster) {
            // Modalità esplicita "from=master": salta preview/, parte direttamente
            // da active/ (master scanner-space). Fallback a cold se master mancante.
            if (file_exists($activePath) && filesize($activePath) > $minSize) {
                $fileToServe = $activePath;
            } elseif ($storagePath !== null && file_exists($storagePath) && filesize($storagePath) > $minSize) {
                $fileToServe = $storagePath;
            } else {
                header("HTTP/1.1 404 Not Found");
                exit;
            }
        } elseif (file_exists($previewPath) && filesize($previewPath) > $minSize) {
            $fileToServe = $previewPath;
        } elseif (file_exists($activePath) && filesize($activePath) > $minSize) {
            $fileToServe = $activePath;
        } elseif ($storagePath !== null && file_exists($storagePath) && filesize($storagePath) > $minSize) {
            $fileToServe = $storagePath;
        } else {
            header("HTTP/1.1 404 Not Found");
            exit;
        }

        // SPEGNIMENTO MOTORE ERRORI: Nessun "Warning" testuale deve finire nel binario 3D
        error_reporting(0);
        if (ob_get_level()) ob_end_clean();

        // CACHE POLICY DIFFERENZIATA:
        // - Preview STL (da preview/): no-store — cambiano ad ogni bake preview.
        // - Master STL / JSON (da active/ o cloud): ETag + max-age=60 per reload rapido.
        //   Il frontend usa &bustCache=t= solo per l'hot-swap post-bake, quindi il
        //   caricamento iniziale può riutilizzare la cache del browser se l'ETag coincide.
        $isPreview = ($fileToServe === $previewPath);
        if ($isPreview) {
            header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
            header("Pragma: no-cache");
        } else {
            $mtime = filemtime($fileToServe);
            $etag  = '"' . md5($mtime . filesize($fileToServe)) . '"';
            // ColorReady L11.3 (2026-07-24): abbassato 86400 → 60 (ripristina l'intento del
            // commento a :211). Un .drc master rigenerato CON colore ha lo STESSO URL del
            // colorless già in cache: con max-age=86400 il browser lo servirebbe stantìo fino
            // a 24h. Con max-age=60 + must-revalidate + ETag (mtime+size → cambia col colore),
            // dopo 60s il browser rivalida (304 se invariato, re-fetch se il .drc è cambiato)
            // → il colore compare senza hard-refresh manuale.
            header("Cache-Control: private, max-age=60, must-revalidate");
            header("ETag: $etag");
            header("Last-Modified: " . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
            $ifNoneMatch = trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '');
            $ifModSince  = $_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '';
            if ($ifNoneMatch === $etag || ($ifModSince && strtotime($ifModSince) >= $mtime)) {
                http_response_code(304);
                exit;
            }
        }

        // FORZATURA MIME TYPE
        if ($ext === 'json') {
            header("Content-Type: application/json");
        } elseif (in_array($ext, ['stl', 'obj', 'ply', 'drc'])) {
            header("Content-Type: application/octet-stream");
        } else {
            header("Content-Type: " . mime_content_type($fileToServe));
        }
        
        header("Content-Length: " . filesize($fileToServe));
        readfile($fileToServe);
        exit;
    }

    /**
     * IBX2 thumbnail (2026-07-20, opzione B). Serve il PNG dell'anteprima dal
     * .ibex, lato ibex-app (che ha IBEX_THUMB_KEY, NON l'archive key).
     *
     * 🔴 NIENTE DI IDENTIFICANTE NELLA QUERY STRING: il progetto è indicato dal
     *    fileid NUMERICO (?f=), non dal nome (che può contenere il riferimento
     *    paziente). Il NOME non compare MAI in URL / log nginx / history / Referer.
     * Identità: uid dal JWT (bridge → $_SESSION['nc_uid']); path DERIVATO dal DB
     * (oc_filecache), mai preso dalla richiesta. Ownership = il fileid deve
     * appartenere alla home storage dell'uid (join st.id='home::uid'), stesso
     * spirito del guard di renameProject.
     * Fallback pulito: IBX1 / thumb_len==0 / corrotto / non-tuo → 404 (la card
     * cade sul placeholder SVG lato shell, nessun errore visibile).
     * Cache SOLO browser: ETag(mtime) + private,max-age. ⛔ MAI Redis (appendonly
     * = dato clinico decifrato a riposo).
     */
    public function thumb() {
        $uid = $_SESSION['nc_uid'] ?? null;
        if (session_status() === PHP_SESSION_ACTIVE) session_write_close();  // no lock: img concorrenti
        $fid = isset($_GET['f']) ? (int)$_GET['f'] : 0;
        if (!$uid || $fid <= 0) { http_response_code(400); exit; }

        // Path del .ibex DERIVATO dal fileid, uid-scoped. oc_filecache/oc_storages
        // sono nel DB 'nextcloud' (cross-db, come renameProject). Il join su
        // st.id='home::uid' È l'ownership: un fileid altrui non matcha.
        $rel = false;
        try {
            $st = $this->db->prepare(
                "SELECT fc.path FROM nextcloud.oc_filecache fc
                   JOIN nextcloud.oc_storages st ON fc.storage = st.numeric_id
                  WHERE fc.fileid = ? AND st.id = ? AND fc.path LIKE 'files/IBEX/%.ibex'
                  LIMIT 1"
            );
            $st->execute([$fid, "home::$uid"]);
            $rel = $st->fetchColumn();
        } catch (\Throwable $e) { $rel = false; }
        if (!$rel) { http_response_code(404); exit; }   // non tuo / non .ibex / assente

        // sandbox realpath (difesa in profondità, come serve_file): il path non
        // arriva MAI dalla richiesta, ma questa guardia blinda anche una riga
        // filecache anomala con '..' o symlink.
        $abs  = "/data/nextcloud-storage/$uid/$rel";
        $real = realpath($abs);
        $base = realpath("/data/nextcloud-storage/$uid/files");
        if ($real === false || $base === false || strpos($real, $base . '/') !== 0) {
            http_response_code(404); exit;
        }

        // ETag = mtime del .ibex → cambia ad ogni salvataggio (thumb mai stantia).
        $mt   = @filemtime($real);
        $etag = '"ibxt-' . $fid . '-' . ($mt ?: 0) . '"';
        error_reporting(0);
        if (ob_get_level()) ob_end_clean();       // niente warning nel PNG binario
        if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
            http_response_code(304);
            header("ETag: $etag");
            header('Cache-Control: private, max-age=86400');
            exit;
        }

        // Decifra SOLO la thumb (THUMB_KEY). null = IBX1 / thumb_len==0 / corrotto.
        // Una IBEX_THUMB_KEY mancante fa lanciare (500 rumoroso = misconfig deploy):
        // scelta voluta, è un errore di configurazione, non un fallback normale.
        $png = \App\Core\IbexThumb::readThumbPng($real);
        if ($png === null) { http_response_code(404); exit; }   // → placeholder SVG lato shell

        header('Content-Type: image/png');
        header('Cache-Control: private, max-age=86400');
        header("ETag: $etag");
        header('Content-Length: ' . strlen($png));
        echo $png;
        exit;
    }

    private function rrmdir($dir) {
        if (is_dir($dir)) {
            $objects = scandir($dir);
            foreach ($objects as $object) {
                if ($object != "." && $object != "..") {
                    if (is_dir($dir . DIRECTORY_SEPARATOR . $object) && !is_link($dir . "/" . $object))
                        $this->rrmdir($dir . DIRECTORY_SEPARATOR . $object);
                    else
                        @unlink($dir . DIRECTORY_SEPARATOR . $object);
                }
            }
            rmdir($dir);
        }
    }
}