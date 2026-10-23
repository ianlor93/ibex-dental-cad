<?php
namespace App\Core;

/**
 * IbexConfig — unica sede che legge dall'ambiente l'istanza Nextcloud, la chiave
 * SSO, il dominio del cookie e l'host Redis. Nessun altro file PHP legge
 * NEXTCLOUD_URL / NEXTCLOUD_SSO_PUBKEY_B64 / SESSION_DOMAIN / REDIS_HOST.
 *
 * Stesso meccanismo del resto dell'app: getenv() (php-fpm con clear_env=no,
 * custom-cont-init.d/10-clear-env.sh). Ogni metodo restituisce '' quando la
 * variabile manca o non è valida: chi chiama decide il comportamento sicuro
 * (nessun header CORS, frame-ancestors solo 'self', cookie host-only, ...).
 */
class IbexConfig
{
    /** NEXTCLOUD_URL senza '/' finale, es. https://cloud.example.com. '' se assente. */
    public static function nextcloudUrl(): string
    {
        return rtrim(trim((string)getenv('NEXTCLOUD_URL')), '/');
    }

    /**
     * Origine (schema + host + porta) di NEXTCLOUD_URL, nella forma in cui il browser
     * la serializza: minuscola, porta di default omessa. Usata per CORS, CSP
     * frame-ancestors e postMessage. '' se l'URL manca o non è http(s) con host.
     */
    public static function nextcloudOrigin(): string
    {
        $url = self::nextcloudUrl();
        if ($url === '') return '';
        $p = parse_url($url);
        if (!is_array($p) || empty($p['scheme']) || empty($p['host'])) return '';
        $scheme = strtolower($p['scheme']);
        if ($scheme !== 'http' && $scheme !== 'https') return '';
        if (isset($p['user']) || isset($p['pass'])) return '';
        $origin = $scheme . '://' . strtolower($p['host']);
        if (isset($p['port'])) {
            $default = ($scheme === 'https') ? 443 : 80;
            if ((int)$p['port'] !== $default) $origin .= ':' . (int)$p['port'];
        }
        return $origin;
    }

    /** Lobby IBEX dentro Nextcloud. '' se NEXTCLOUD_URL manca o non è valido. */
    public static function lobbyUrl(): string
    {
        if (self::nextcloudOrigin() === '') return '';
        return self::nextcloudUrl() . '/apps/ibex_workspace/';
    }

    /**
     * Dominio del cookie di sessione (es. .example.com). '' = cookie solo per l'host
     * corrente (nessun attributo Domain). Un valore con caratteri fuori da
     * [A-Za-z0-9.-] è scartato: finirebbe dentro l'header Set-Cookie.
     */
    public static function sessionDomain(): string
    {
        $d = trim((string)getenv('SESSION_DOMAIN'));
        if ($d === '' || !preg_match('/^\.?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/', $d)) return '';
        return $d;
    }

    /**
     * Chiave PUBBLICA ES256 di External Sites (PEM), da NEXTCLOUD_SSO_PUBKEY_B64
     * (il PEM in base64 su una riga). Pubblica, NON un segreto. '' se manca o se il
     * base64 non è valido (decodifica stretta). Un PEM malformato lo rifiuta poi la
     * libreria JWT → stesso esito di un token non valido.
     */
    public static function ssoPublicKeyPem(): string
    {
        $raw = trim((string)getenv('NEXTCLOUD_SSO_PUBKEY_B64'));
        if ($raw === '') return '';
        $pem = base64_decode($raw, true);
        if ($pem === false || trim($pem) === '') return '';
        return $pem;
    }

    /** Host Redis di IBEX; default 'ibex-redis' (nome del servizio nel compose). */
    public static function redisHost(): string
    {
        $h = trim((string)getenv('REDIS_HOST'));
        return $h !== '' ? $h : 'ibex-redis';
    }
}
