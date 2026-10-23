<?php
namespace App\Services;

use PDO;
use Redis;
use stdClass;
use App\Core\ProjectRegistry;

/**
 * ProjectService — identità/stato progetto. de-DB (2026-07-20): non legge più
 * la tabella progetti. Identità = registry Redis (ProjectRegistry) + manifest
 * del `.ibex`; stato = `project:{pid}:status` (Redis, volatile) con fallback filesystem.
 * La PDO resta iniettata (compat costruttore) ma non tocca la tabella dei progetti.
 */
class ProjectService {
    private PDO $db;
    private Redis $redis;
    const ACTIVE_BASE = '/appdata/ibex/active';

    public function __construct(PDO $db, Redis $redis) {
        $this->db = $db;
        $this->redis = $redis;
    }

    /**
     * Ricostruisce lo stdClass "progetto" da filesystem + registry (era SELECT *).
     * Ownership: il path active/{uid}/{id} è namespaced per uid; se cold, il registry
     * conferma il proprietario. Ritorna null se il progetto non esiste / non è dell'uid.
     */
    public function getProject(int $id, string $uid): ?stdClass {
        $activeRoot = self::ACTIVE_BASE . "/$uid/$id";
        $meta = ProjectRegistry::meta($this->redis, $id);   // ['uid','name'] | null
        $isActive = is_dir($activeRoot);

        // Ownership: se il registry conosce il pid, l'uid deve combaciare.
        // Se non lo conosce (registry non ancora ricostruito), l'esistenza di
        // active/{uid}/{id} è la prova (path uid-scoped).
        if ($meta !== null) {
            if (($meta['uid'] ?? null) !== $uid) return null;
        } elseif (!$isActive) {
            return null;
        }

        $o = new stdClass();
        // project_name: dal manifest caldo, altrimenti dal registry.
        $name = null;
        $manifest = null;
        $mp = "$activeRoot/manifest.json";
        if ($isActive && is_file($mp)) {
            $manifest = json_decode(@file_get_contents($mp), true) ?: [];
            $name = $manifest['project_name'] ?? null;
        }
        $o->project_name = $name ?? ($meta['name'] ?? null);

        // status: Redis (volatile), fallback filesystem.
        //   · active pronto (scene.blend|manifest) → 'ready'
        //   · NIENTE active + NIENTE status Redis → 'cold' (FIX 2026-07-21):
        //     un progetto chiuso da >1h (TTL status scaduto) + active purgato è
        //     FREDDO, va ESTRATTO — NON 'initializing'. Chiamarlo 'initializing'
        //     lo faceva cadere nel busy-check di editor():998 (loading-page + exit)
        //     PRIMA del trigger LOAD_PROJECT (:1005) → deadlock «Elaborazione in corso».
        //     'cold' NON è nel busy-check → editor() raggiunge il LOAD ed estrae.
        //     Gli stati "occupato" REALI restano Redis-driven (storeEmpty='queued',
        //     editor()/INIT='initializing', bake='baking') → loading-page invariata.
        $st = $this->redis->get("project:$id:status");
        if ($st === false || $st === null || $st === '') {
            $st = ($isActive && (is_file("$activeRoot/scene.blend") || is_file($mp))) ? 'ready' : 'cold';
        }
        $o->status = $st;

        // input_file_path: dal manifest (compat: alcuni consumer leggono ancora questa prop).
        $o->input_file_path = json_encode($manifest['input_files'] ?? []);
        // session_settings: non più nel DB. Il consumer 1b la legge dal manifest.
        $o->session_settings = null;

        return $o;
    }

    /** open_name (basename .ibex) → pid, scoping per owner. Deep-link "Apri in IBEX". */
    public function getIdByProjectName(string $name, string $uid): ?int {
        return ProjectRegistry::resolve($this->redis, $uid, $name);
    }

    public function determineStatus(int $id, string $uid): array {
        $redisStatus = $this->redis->get("project:$id:status");
        $error = $this->redis->get("project:$id:error");

        if ($error) {
            // PUNTO4-FETTA-B (2026-07-28) — si gata la CANCELLAZIONE, non la lettura.
            // Il `del` su una chiave nominata da un pid arbitrario era l'unica scrittura
            // cross-utente di questo percorso.
            // ⚠️ Oggi è IRRAGGIUNGIBILE: nessuno scrive mai `project:{pid}:error` (in www/
            // e worker/ esistono solo tre letture e questo del) → `$error` è sempre falso.
            // Il cancello c'è perché la chiave può guadagnare un writer domani, non perché
            // morda adesso.
            // A ‖ B, SENZA il ramo C: siamo nel percorso di POLL, e C su un progetto
            // freddo costerebbe una glob a OGNI battito. Fallire chiuso qui è innocuo —
            // il flag semplicemente non viene cancellato, nessun rifiuto all'utente.
            $mine = is_dir(self::ACTIVE_BASE . "/$uid/$id")
                 || (ProjectRegistry::ownerOf($this->redis, $id) === $uid);
            if ($mine) { $this->redis->del("project:$id:error"); }
            return ['status' => 'error', 'error' => $error];
        }
        if ($redisStatus === 'error') {
            return ['status' => 'error', 'error' => 'Errore di elaborazione'];
        }
        if ($redisStatus === 'ready' || $redisStatus === 'active') {
            return ['status' => 'ready'];
        }

        // Fallback filesystem: se l'active è pronto sul disco, il progetto è aperto.
        $activeRoot = self::ACTIVE_BASE . "/$uid/$id";
        if (is_file("$activeRoot/scene.blend") || is_file("$activeRoot/manifest.json")) {
            // marca 'active' in Redis (volatile) per i poll successivi
            $this->redis->setEx("project:$id:status", 3600, 'active');
            return ['status' => 'ready'];
        }

        // de-DB: niente più fallback DB. Se Redis è vuoto e il FS non c'è, è ancora in setup.
        return ['status' => $redisStatus ?: 'initializing'];
    }
}
