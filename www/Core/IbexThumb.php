<?php
namespace App\Core;

/**
 * IbexThumb (IBX2, 2026-07-20) — lettore della SOLA thumbnail dal .ibex, lato
 * ibex-app (web-facing). Usa esclusivamente IBEX_THUMB_KEY: NON conosce, non
 * legge e non può decifrare il payload (ARCHIVE_KEY vive solo nel worker).
 *
 * Formato letto (deve combaciare byte-per-byte con worker/modules/ibex_crypto.py):
 *   gen-1 (ver=0x01): "IBX2"|ver|thumb_nonce(12)|thumb_len(4 BE)|GCM(png)  AAD="IBX2\x01"
 *   gen-2 (ver=0x02, PASSO B): "IBX2"|ver|project_id(4 BE)|session_digest(32)
 *                              |thumb_nonce(12)|thumb_len(4 BE)|GCM(png)     AAD="IBX2\x02"
 *   gen-3 (ver=0x03, IBEX-GEN3-28-7): "IBX2"|ver|project_id(4 BE)|session_digest(32)
 *                              |burn_nonce(12)|burn_len(4 BE)|GCM(json burn)
 *                              |thumb_nonce(12)|thumb_len(4 BE)|GCM(png)     AAD="IBX2\x03"
 *                              Il burn si SALTA con fseek: la thumb resta a costo ~30-60 KB.
 *   | ...payload (NON toccato). Il lettore fa branch su `ver` PRIMA di ogni offset.
 *
 * Lettura PARZIALE: legge magic+ver (5 B), poi solo i meta della generazione e i
 * thumb_len byte del ciphertext. Su storage locale/FUSE è I/O di ~pochi KB, non
 * l'intero archivio.
 */
final class IbexThumb {
    private const MAGIC2      = "IBX2";
    private const VERSION2    = "\x01";      // gen-1: thumb subito dopo il prefisso 21
    private const VERSION2_DG = "\x02";      // gen-2 (PASSO B): pid(4)+digest(32) in testa
    private const VERSION3    = "\x03";      // gen-3 (IBEX-GEN3-28-7): + segmento burn prima della thumb
    private const AAD         = "IBX2\x01";  // AAD segmento thumb gen-1 (= magic+ver)
    private const AAD_DG      = "IBX2\x02";  // AAD segmento thumb gen-2
    private const AAD_G3      = "IBX2\x03";  // AAD dei TRE segmenti gen-3 (burn, thumb, payload)
    private const PREFIX      = 21;          // gen-1: 4 + 1 + 12 + 4
    private const PREFIX_DG   = 57;          // gen-2: 4 + 1 + 4(pid) + 32(digest) + 12 + 4
    private const TAG_LEN     = 16;          // GCM tag (cryptography/AESGCM lo appende in coda)
    private const MAX_THUMB   = 2097152;     // 2 MiB: ceiling difensivo (una PNG 256² è ~30-60 KB)
    private const MAX_BURN    = 65536;       // 64 KiB: ceiling difensivo sul json del burn — allineato al Python

    /** Chiave thumbnail (base64 → 32 byte). Solo qui in PHP; MAI l'archive key. */
    private static function key(): string {
        $raw = getenv('IBEX_THUMB_KEY');
        if (!$raw) throw new \RuntimeException('IBEX_THUMB_KEY non impostata');
        $key = base64_decode($raw, true);
        if ($key === false || strlen($key) !== 32) {
            throw new \RuntimeException('IBEX_THUMB_KEY non e 32 byte dopo base64');
        }
        return $key;
    }

    /**
     * Ritorna i byte PNG della thumbnail, oppure null se:
     *   - il file non è IBX2 (IBX1/zip legacy → nessuna thumb),
     *   - thumb_len == 0 (progetto mai risalvato in IBX2),
     *   - troncamento / lunghezza fuori range / decrypt fallito.
     * Non lancia sui casi "assente": lancia solo se manca la chiave (misconfig).
     */
    public static function readThumbPng(string $absPath): ?string {
        if (!is_file($absPath)) return null;
        $h = @fopen($absPath, 'rb');
        if ($h === false) return null;
        try {
            // Branch su `ver` PRIMA di calcolare qualsiasi offset (parità col worker).
            $head = self::freadExact($h, 5);                              // magic(4) + ver(1)
            if ($head === null || substr($head, 0, 4) !== self::MAGIC2) return null;  // IBX1/zip → no thumb
            $ver = substr($head, 4, 1);
            if ($ver === self::VERSION2) {                               // gen-1: | tnonce(12) | tlen(4) | thumb...
                $meta = self::freadExact($h, 12 + 4);
                if ($meta === null) return null;
                $tnonce = substr($meta, 0, 12);
                $tlen   = unpack('N', substr($meta, 12, 4))[1];          // uint32 BE
                $aad    = self::AAD;
            } elseif ($ver === self::VERSION2_DG) {                      // gen-2: | pid(4) | digest(32) | tnonce(12) | tlen(4) | thumb...
                $meta = self::freadExact($h, 4 + 32 + 12 + 4);
                if ($meta === null) return null;
                $tnonce = substr($meta, 4 + 32, 12);
                $tlen   = unpack('N', substr($meta, 4 + 32 + 12, 4))[1];
                $aad    = self::AAD_DG;
            } elseif ($ver === self::VERSION3) {                         // gen-3: | pid(4) | digest(32) | bnonce(12) | blen(4) | burn | tnonce(12) | tlen(4) | thumb...
                if (self::freadExact($h, 4 + 32) === null) return null;   // pid+digest: scartati (come gen-2)
                $bmeta = self::freadExact($h, 12 + 4);                    // bnonce (non serve qui) + blen
                if ($bmeta === null) return null;
                $blen = unpack('N', substr($bmeta, 12, 4))[1];
                if ($blen > self::MAX_BURN) return null;                  // burn corrotto -> placeholder
                // IBEX-GEN3-28-7: il segmento burn si SALTA, non si legge -> il costo
                // per card di lobby resta quello della sola thumb (~30-60 KB).
                if ($blen > 0 && fseek($h, $blen, SEEK_CUR) !== 0) return null;
                $tmeta = self::freadExact($h, 12 + 4);
                if ($tmeta === null) return null;
                $tnonce = substr($tmeta, 0, 12);
                $tlen   = unpack('N', substr($tmeta, 12, 4))[1];
                $aad    = self::AAD_G3;
            } else {
                return null;                                             // versione IBX2 sconosciuta
            }
            // tlen==0 assente · <=16 solo-tag/PNG-vuoto · >cap corrotto → placeholder
            if ($tlen <= self::TAG_LEN || $tlen > self::MAX_THUMB) return null;
            $tct = self::freadExact($h, $tlen);
            if ($tct === null) return null;
            return self::decrypt($tct, $tnonce, $aad);
        } finally {
            fclose($h);
        }
    }

    /**
     * IBEX-GEN3-28-7 — record di burn dall'header gen-3, o null.
     * Lettura PARZIALE: prefisso fisso (5 + 4 + 32 + 12 + 4 = 57 B) + i soli $blen
     * byte del ciphertext. Il payload non viene MAI toccato (ARCHIVE_KEY non vive
     * qui). Speculare a `ibex_crypto.read_burn` lato worker.
     *
     * ⚠ SOFT-FAIL TOTALE, a differenza di readThumbPng: qui anche una
     * IBEX_THUMB_KEY mancante torna null invece di lanciare. Motivo: questo metodo
     * nasce per un FALLBACK (il record vive anche su Redis) — farlo lanciare
     * trasformerebbe un degrado in un 500. readThumbPng resta rumoroso di proposito.
     *
     * ⚠ NESSUN CHIAMANTE in questa fetta: e' parita' di formato col Python,
     * esattamente come `ibex_crypto.read_thumb`. Il consumatore di prodotto
     * (fallback in `projectsStatus`) arriva nella sessione B.
     */
    public static function readBurn(string $absPath): ?array {
        if (!is_file($absPath)) return null;
        $h = @fopen($absPath, 'rb');
        if ($h === false) return null;
        try {
            $head = self::freadExact($h, 5);                              // magic(4) + ver(1)
            if ($head === null || substr($head, 0, 4) !== self::MAGIC2) return null;
            if (substr($head, 4, 1) !== self::VERSION3) return null;      // il burn esiste SOLO in gen-3
            if (self::freadExact($h, 4 + 32) === null) return null;       // pid+digest: saltati
            $bmeta = self::freadExact($h, 12 + 4);
            if ($bmeta === null) return null;
            $bnonce = substr($bmeta, 0, 12);
            $blen   = unpack('N', substr($bmeta, 12, 4))[1];
            // blen==0 assente · <=16 solo-tag/vuoto · >cap corrotto
            if ($blen <= self::TAG_LEN || $blen > self::MAX_BURN) return null;
            $bct = self::freadExact($h, $blen);
            if ($bct === null) return null;
            $json = self::decrypt($bct, $bnonce, self::AAD_G3);
            if ($json === null) return null;
            $arr = json_decode($json, true);
            return is_array($arr) ? $arr : null;
        } catch (\Throwable $e) {
            return null;                                                  // soft-fail: mai eccezioni al chiamante
        } finally {
            fclose($h);
        }
    }

    /**
     * PUNTO4-FETTA-B (2026-07-28) — `project_id` dall'header IBX2, o null.
     *
     * È la TERZA FONTE del predicato di proprietà (`EditorController::_ownsProject`):
     * quando `active/{uid}/{pid}` non esiste (progetto FREDDO) **e** il registry Redis è
     * muto (`ibex-redis` gira `--appendonly no` e senza volume: un recreate lo azzera, e
     * `_registry_rebuild` riparte solo al BOOT di un worker), questa è l'unica sede che
     * sa ancora dire di chi è un pid — perché vive DENTRO l'archivio dell'utente.
     *
     * 🔑 NESSUNA CHIAVE, 9 BYTE. `project_id` sta ai byte 5-8 come uint32 BE **in
     * chiaro**: non è dentro un segmento GCM. Non legge burn, non legge thumb, non
     * sfiora il payload. `readThumbPng` e `readBurn` attraversano quegli stessi byte e
     * li SCARTANO (`:77`, `:126`); questo metodo li legge e non tocca nient'altro.
     *
     * ⚠️ Lettura INDIPENDENTE da quella del janitor: il `41` di `read_header_meta`
     * (Python) non è coinvolto e NON va toccato per far posto a questa.
     *
     * gen-1 (0x01) non ha il pid nell'header → null. IBX1 / zip in chiaro / file corto /
     * illeggibile / assente → null. SOFT-FAIL TOTALE, mai un'eccezione al chiamante: un
     * predicato di autorizzazione non deve poter trasformare un disco lento in un 500.
     */
    public static function readProjectId(string $absPath): ?int {
        if (!is_file($absPath)) return null;
        $h = @fopen($absPath, 'rb');
        if ($h === false) return null;
        try {
            $head = self::freadExact($h, 5);                          // magic(4) + ver(1)
            if ($head === null || substr($head, 0, 4) !== self::MAGIC2) return null;
            $ver = substr($head, 4, 1);
            // Il pid esiste da gen-2 in poi, agli STESSI byte 5-8 in entrambe (§26).
            if ($ver !== self::VERSION2_DG && $ver !== self::VERSION3) return null;
            $raw = self::freadExact($h, 4);
            if ($raw === null) return null;
            $pid = unpack('N', $raw)[1];                              // uint32 BE, in chiaro
            return $pid > 0 ? (int)$pid : null;
        } catch (\Throwable $e) {
            return null;
        } finally {
            fclose($h);
        }
    }

    /**
     * Core GCM: (ciphertext+tag, nonce) → PNG | null. Usato da readThumbPng
     * (lettura per path, ibex-app) E dall'eventuale endpoint "decrypt-only"
     * (topologia D: la lobby NC legge il ciphertext via OCP\Files e lo passa
     * a ibex-app per la decifra — la THUMB_KEY vive SOLO qui). Nessun leak: su
     * tag/AAD errati, ciphertext vuoto o fuori range → null.
     */
    public static function decrypt(string $tct, string $tnonce, string $aad = self::AAD): ?string {
        if (strlen($tct) <= self::TAG_LEN || strlen($tct) > self::MAX_THUMB) return null;
        if (strlen($tnonce) !== 12) return null;
        $ct  = substr($tct, 0, -self::TAG_LEN);
        $tag = substr($tct, -self::TAG_LEN);
        $png = openssl_decrypt($ct, 'aes-256-gcm', self::key(), OPENSSL_RAW_DATA, $tnonce, $tag, $aad);
        return ($png === false || $png === '') ? null : $png;
    }

    /** fread che ritorna ESATTAMENTE $n byte o null (gestisce read parziali/EOF). */
    private static function freadExact($h, int $n): ?string {
        $buf = '';
        while (strlen($buf) < $n) {
            $chunk = fread($h, $n - strlen($buf));
            if ($chunk === false || $chunk === '') break;
            $buf .= $chunk;
        }
        return strlen($buf) === $n ? $buf : null;
    }
}
