<?php
namespace App\Http\Middleware;

use App\Core\IbexConfig;

class AllowNextcloudFrame {
    public function handle($request, $next) {
        // Pulisce qualsiasi policy pregressa per evitare cortocircuiti
        header_remove('X-Frame-Options');
        header_remove('Content-Security-Policy');
        
        // Autorizza esplicitamente l'istanza Nextcloud configurata (NEXTCLOUD_URL);
        // se manca, solo 'self'.
        $ncOrigin = IbexConfig::nextcloudOrigin();
        header("Content-Security-Policy: frame-ancestors 'self'" . ($ncOrigin !== '' ? " {$ncOrigin}" : ''));

        return $next($request);
    }
}