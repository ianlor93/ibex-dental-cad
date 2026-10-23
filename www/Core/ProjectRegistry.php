<?php
namespace App\Core;

use Redis;

/**
 * ProjectRegistry (de-DB, 2026-07-20) — indice d'identità dei progetti IBEX su Redis,
 * al posto della tabella progetti (eliminata come 2ª fonte di verità).
 *
 * La VERITÀ DUREVOLE resta l'insieme dei `.ibex` (manifest.json con `project_id` +
 * `project_name`). Redis è solo un INDICE veloce, ricostruibile scandendo i `.ibex`
 * (rebuild worker al warmup).
 *
 * ⚠️ PUNTO4-FETTA-A (2026-07-28) — qui c'era un'affermazione FALSA dal 13/7:
 * «`ibex-redis` è `appendonly yes` → l'indice sopravvive ai restart; un FLUSHALL
 * richiede il rebuild worker per ripopolarlo». La verità:
 *   · `ibex-redis` gira `--appendonly no` E SENZA VOLUME (docker-compose.yml:48;
 *     la stanza `ibex-redis` non ha alcuna chiave `volumes:`).
 *   · L'indice vive quindi SOLO nel `dump.rdb` del layer del container: sopravvive
 *     a `docker restart`, MUORE a un `recreate` / `up -d` / update dell'immagine.
 *   · Non serve un FLUSHALL per perderlo, e il ripopolamento non è a comando: lo fa
 *     `_registry_rebuild` (worker.py) al BOOT di un processo worker, one-shot sotto
 *     sentinella `ibex:registry_rebuilt` (SET NX ex=86400). Redis ricreata + worker
 *     mai riavviati = registro vuoto a tempo indeterminato.
 *
 * Pattern coerente con UserContext: metodi statici, unica sede delle stringhe-chiave.
 *
 * Chiavi:
 *   ibex:next_pid                → counter (INCR) — rimpiazza AUTO_INCREMENT/lastInsertId
 *   ibex:name2pid:{uid}  (hash)  → {project_name: pid}  — open_name→pid, dedup, naming
 *   ibex:pid2meta:{pid}  (hash)  → {uid, name}          — ownership + anagrafe
 *   ibex:projects:{uid}  (set)   → {pid, ...}           — enumerazione per-utente
 */
class ProjectRegistry {

    const K_NEXT   = 'ibex:next_pid';
    const NC_BASE  = '/data/nextcloud-storage';

    private static function kName2Pid($uid) { return 'ibex:name2pid:' . $uid; }
    private static function kPid2Meta($pid) { return 'ibex:pid2meta:' . $pid; }
    private static function kProjects($uid) { return 'ibex:projects:' . $uid; }

    /** Nuovo pid numerico (INCR). Il counter è seminato una-tantum al MAX storico. */
    public static function allocatePid(Redis $r): int {
        return (int)$r->incr(self::K_NEXT);
    }

    /** Registra un progetto nell'indice (crea/import). */
    public static function bind(Redis $r, string $uid, string $name, int $pid): void {
        try {
            $r->multi()
              ->hSet(self::kName2Pid($uid), $name, (string)$pid)
              ->hSet(self::kPid2Meta($pid), 'uid', $uid)
              ->hSet(self::kPid2Meta($pid), 'name', $name)
              ->sAdd(self::kProjects($uid), (string)$pid)
              ->exec();
        } catch (\Throwable $e) {
            $r->hSet(self::kName2Pid($uid), $name, (string)$pid);
            $r->hSet(self::kPid2Meta($pid), 'uid', $uid);
            $r->hSet(self::kPid2Meta($pid), 'name', $name);
            $r->sAdd(self::kProjects($uid), (string)$pid);
        }
    }


    /** open_name → pid (o null). Rimpiazza SELECT id WHERE project_name AND nc_uid. */
    public static function resolve(Redis $r, string $uid, string $name): ?int {
        $pid = $r->hGet(self::kName2Pid($uid), $name);
        return ($pid !== false && $pid !== null && $pid !== '') ? (int)$pid : null;
    }

    /** Metadati identità di un pid: ['uid'=>..,'name'=>..] o null. */
    public static function meta(Redis $r, int $pid): ?array {
        $m = $r->hGetAll(self::kPid2Meta($pid));
        return (is_array($m) && isset($m['uid'])) ? $m : null;
    }

    /** Proprietario di un pid (uid) o null. */
    public static function ownerOf(Redis $r, int $pid): ?string {
        $u = $r->hGet(self::kPid2Meta($pid), 'uid');
        return ($u !== false && $u !== null && $u !== '') ? (string)$u : null;
    }

    /** Rinomina coordinata dell'indice (il file .ibex e il manifest li muove il chiamante).
     *  ATOMICA (lobby-rename 2026-07-20): i 3 sub-write vivono in un MULTI/EXEC — un
     *  crash a metà non può più lasciare name2pid con NÉ il vecchio NÉ il nuovo nome
     *  (era il sotto-gap del check #2 "fallimento parziale"). Fallback non-atomico se
     *  ->multi() non è disponibile (client Redis esotico). */
    public static function rename(Redis $r, string $uid, string $old, string $new, int $pid): void {
        try {
            $r->multi()
              ->hDel(self::kName2Pid($uid), $old)
              ->hSet(self::kName2Pid($uid), $new, (string)$pid)
              ->hSet(self::kPid2Meta($pid), 'name', $new)
              ->exec();
        } catch (\Throwable $e) {
            $r->hDel(self::kName2Pid($uid), $old);
            $r->hSet(self::kName2Pid($uid), $new, (string)$pid);
            $r->hSet(self::kPid2Meta($pid), 'name', $new);
        }
    }

    /** Rimuove un progetto dall'indice (delete-via-Files / janitor orfano). */
    public static function unbind(Redis $r, string $uid, string $name, int $pid): void {
        try {
            $r->multi()
              ->hDel(self::kName2Pid($uid), $name)
              ->del(self::kPid2Meta($pid))
              ->sRem(self::kProjects($uid), (string)$pid)
              ->exec();
        } catch (\Throwable $e) {
            $r->hDel(self::kName2Pid($uid), $name);
            $r->del(self::kPid2Meta($pid));
            $r->sRem(self::kProjects($uid), (string)$pid);
        }
    }

    /**
     * Prossimo nome «Senza titolo N» per-utente, race-safe via lock Redis.
     * Rimpiazza il `SELECT ... LIKE 'Senza titolo %' FOR UPDATE`. N è il max tra i nomi
     * nell'indice E i .ibex sul filesystem (difesa contro indice disallineato).
     */
    public static function nextUntitled(Redis $r, string $uid): string {
        $lockKey = 'ibex_lock_create_' . $uid;
        $token   = bin2hex(random_bytes(8));
        // Attesa breve del lock (max ~2s): la creazione è rara, la contesa minima.
        $have = false;
        for ($i = 0; $i < 20; $i++) {
            if ($r->set($lockKey, $token, ['nx', 'ex' => 10])) { $have = true; break; }
            usleep(100000);
        }
        try {
            $maxN = 0;
            // (a) nomi già nell'indice
            $names = $r->hKeys(self::kName2Pid($uid)) ?: [];
            // (b) .ibex sul filesystem (indice potenzialmente incompleto da freddo)
            $dir = self::NC_BASE . '/' . $uid . '/files/IBEX';
            foreach (glob($dir . '/Senza titolo *.ibex') ?: [] as $f) {
                $names[] = preg_replace('/\.ibex$/i', '', basename($f));
            }
            foreach ($names as $n) {
                if (preg_match('/^Senza titolo (\d+)$/', (string)$n, $mm)) {
                    $maxN = max($maxN, (int)$mm[1]);
                }
            }
            return 'Senza titolo ' . ($maxN + 1);
        } finally {
            // Rilascio solo se ancora nostro (evita di sbloccare un lock altrui).
            if ($have && $r->get($lockKey) === $token) {
                $r->del($lockKey);
            }
        }
    }
}
