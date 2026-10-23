<?php
// IBEX /health — Fase 1.5 / C4 (2026-06-12, rev.2)
// Endpoint pubblico, esente da validazione key (servito diretto da nginx).
// Verifica raggiungibilita' TCP di DB (3306) e ibex-redis (6379). Nessuna credenziale, nessuna scrittura.
require_once __DIR__ . '/Core/IbexConfig.php'; // health.php non passa dall'autoloader di index.php
use App\Core\IbexConfig;

header('Content-Type: application/json');
header('Cache-Control: no-store');

if (function_exists('apcu_inc')) {
    $k = 'ibex_health_' . floor(time() / 10);
    $seen = false; $n = apcu_inc($k, 1, $seen);
    if ($seen === false) { apcu_store($k, 1, 11); $n = 1; }
    if ($n > 30) { http_response_code(429); echo '{"status":"rate_limited"}'; exit; }
}

$out = ['status' => 'ok', 'db' => 'down', 'redis' => 'down'];
$ok = true;

$dbhost = getenv('DB_HOST');
$fp = @fsockopen($dbhost, 3306, $e1, $e2, 2);
if ($fp) {
    stream_set_timeout($fp, 2);
    $greet = fread($fp, 16);
    fclose($fp);
    if ($greet !== false && strlen($greet) > 0) { $out['db'] = 'up'; } else { $ok = false; }
} else { $ok = false; }

$fr = @fsockopen(IbexConfig::redisHost(), 6379, $e3, $e4, 2);
if ($fr) {
    stream_set_timeout($fr, 2);
    fwrite($fr, "PING\r\n");
    $resp = fgets($fr, 64);
    fclose($fr);
    if ($resp !== false && $resp !== '') { $out['redis'] = 'up'; } else { $ok = false; }
} else { $ok = false; }

if (!$ok) { $out['status'] = 'degraded'; http_response_code(503); }
echo json_encode($out);
