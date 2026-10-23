<?php
namespace App\Http\Middleware;

use Redis;
use Exception;
use App\Core\IbexConfig;

class NextcloudAuthBridge {
    /** PUNTO4-FETTA-C-2BIS (2026-07-28) — true SOLO se QUESTA richiesta ha autenticato
     *  con un JWT ES256 VALIDO (firma + scadenza verificate, uid dentro la whitelist).
     *
     *  Serve a `index.php` per le due azioni che arrivano SERVER-TO-SERVER dal proxy NC
     *  (`create_empty_project` via `page#create`, `rename_project` ramo lobby via
     *  `page#rename`): Guzzle non è un browser, quindi non manda né `Origin` né
     *  `Referer` — il cancello d'origine della FASE 2 (Inv. 128) le rifiuterebbe. Il
     *  loro cancello è il JWT, che un CSRF cookie-only non può forgiare.
     *
     *  🔑 Statica ma NON persistente: PHP azzera lo stato di classe a ogni richiesta
     *  (SAPI) → default `false`, nessun leak fra richieste. Si accende SOLO nel ramo
     *  JWT-valido, mai nei rami cookie/`ibex_token`: una sessione già stabilita non
     *  vale come prova di JWT, altrimenti il marcatore diventerebbe un lasciapassare
     *  permanente e il cancello sarebbe inutile. */
    public static bool $authViaJwt = false;

    /** Autoloader on-demand per firebase/php-jwt bundlato (namespace OCA\External\Vendor\Firebase\JWT). */
    private static function ensureJwtLib(): void {
        if (class_exists('OCA\\External\\Vendor\\Firebase\\JWT\\JWT', false)) return;
        spl_autoload_register(function (string $class): void {
            $prefix = 'OCA\\External\\Vendor\\Firebase\\JWT\\';
            if (strpos($class, $prefix) === 0) {
                $file = __DIR__ . '/../../lib/Firebase/JWT/' . substr($class, strlen($prefix)) . '.php';
                if (is_file($file)) require_once $file;
            }
        });
    }

    public function handle($request, $next) {
        // 1. FIX COOKIE IFRAME
        if (session_status() === PHP_SESSION_NONE) {
            // SESSION_DOMAIN vuoto → nessun attributo Domain (cookie solo per l'host corrente).
            $cookieParams = [
                'lifetime' => 86400,
                'path' => '/',
                'secure' => true,
                'httponly' => true,
                'samesite' => 'None'
            ];
            $cookieDomain = IbexConfig::sessionDomain();
            if ($cookieDomain !== '') { $cookieParams['domain'] = $cookieDomain; }
            session_set_cookie_params($cookieParams);
            session_start();
        }

        // 2. CHECK SESSIONE STANDARD (Cookie)
        if (!empty($_SESSION['nc_uid'])) {
            return $next($request);
        }

        // 3. CHECK TOKEN REDIS (Bypass per Fetch/XHR Mesh)
        // Risolve "Accesso Negato" durante il download delle mesh (XHR senza handshake).
        if (!empty($_GET['ibex_token'])) {
            try {
                $redis = new Redis();
                if ($redis->connect(IbexConfig::redisHost(), 6379, 0.5)) {
                    $rp = getenv('IBEX_REDIS_PASS'); if ($rp) { $redis->auth($rp); }
                    $token = $_GET['ibex_token'];
                    $cachedUid = $redis->get("auth_token:$token");
                    if ($cachedUid) {
                        $_SESSION['nc_uid'] = $cachedUid;
                        return $next($request);
                    }
                }
            } catch (Exception $e) {
                // Fail silent su Redis, proseguiamo
            }
        }

        // 4. HANDSHAKE via JWT firmato (External Sites {jwt}) — UNICO metodo di login.
        //    uid DENTRO il token firmato ES256; firma + scadenza verificate dalla libreria.
        //    Chiavi statiche ELIMINATE (Fase 3, 2026-06-14): niente piu' ?key=, env, secrets file.
        //    Chiave PUBBLICA ES256 di External Sites da IbexConfig (env NEXTCLOUD_SSO_PUBKEY_B64):
        //    pubblica, NON un segreto. Se manca → nessun login, stesso esito di un token non valido.
        $ssoPem = IbexConfig::ssoPublicKeyPem();
        if (!empty($_GET['jwt']) && $ssoPem === '') {
            error_log("[IBEX-AUTH] chiave pubblica SSO non configurata (NEXTCLOUD_SSO_PUBKEY_B64)");
        }
        if (!empty($_GET['jwt']) && $ssoPem !== '') {
            self::ensureJwtLib();
            try {
                $decoded = \OCA\External\Vendor\Firebase\JWT\JWT::decode(
                    (string)$_GET['jwt'],
                    new \OCA\External\Vendor\Firebase\JWT\Key($ssoPem, 'ES256')
                );
                $jwtUid = $decoded->userdata->uid ?? null;
                if (is_string($jwtUid) && preg_match('/^[a-zA-Z0-9._@-]{1,64}$/', $jwtUid)) {
                    $_SESSION['auth_user'] = $jwtUid;
                    $_SESSION['nc_uid']    = $jwtUid;
                    self::$authViaJwt = true;   // PUNTO4-FETTA-C-2BIS — l'unico punto di accensione
                    error_log("[IBEX-AUTH] Handshake JWT OK: uid={$jwtUid}");
                    // Redirect togliendo SOLO jwt, preservando action/id/open_name
                    $reqUri = $_SERVER["REQUEST_URI"];
                    $path   = strtok($reqUri, '?');
                    $qpos   = strpos($reqUri, '?');
                    $qs     = '';
                    if ($qpos !== false) {
                        parse_str(substr($reqUri, $qpos + 1), $qp);
                        unset($qp['jwt']);
                        if (!empty($qp)) { $qs = '?' . http_build_query($qp); }
                    }
                    // S4 «IBEX semplice» (2026-07-10): le chiamate API one-shot
                    // (json=1, es. create_empty_project dal proxy NC page#create)
                    // NON vengono redirette: il client server-to-server di NC
                    // (Guzzle) segue i redirect SENZA cookie jar → perderebbe la
                    // sessione appena creata e morirebbe sull'auth-wall (:105).
                    // Il ramo vive SOLO dentro jwt-valido; per il browser nulla cambia.
                    if (isset($_GET['json'])) {
                        // API one-shot: si procede DIRETTAMENTE alla route (come i
                        // rami sessione/token: return $next). Il redirect qui sotto
                        // perderebbe la sessione col client server-to-server di NC
                        // (Guzzle segue i redirect senza cookie jar → auth-wall).
                        return $next($request);
                    }
                    header("Location: " . $path . $qs);
                    exit;
                } else {
                    error_log("[IBEX-AUTH] JWT valido ma uid mancante/invalido nel claim.");
                }
            } catch (\Throwable $e) {
                error_log("[IBEX-AUTH] JWT non valido: " . $e->getMessage());
            }
        }

        // 5. ACCESSO NEGATO
        error_log("[IBEX-AUTH] Accesso negato: nessuna sessione/token/JWT valido.");
        header("HTTP/1.1 403 Forbidden");
        echo '<div style="display:flex;justify-content:center;align-items:center;height:100vh;background:#0d0d0d;color:#ff6f3f;font-family:sans-serif;">';
        echo '<h1>Accesso Negato. Avviare IBEX da Nextcloud.</h1>';
        echo '</div>';
        exit;
    }
}
