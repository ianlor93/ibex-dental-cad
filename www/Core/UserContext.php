<?php
namespace App\Core;

use PDO;

/**
 * UserContext (2026-05-05) — riconoscimento dei ruoli utente dai gruppi Nextcloud.
 *
 *   - L'uid 'admin' è SEMPRE root (non passa per oc_group_user).
 *   - Gli altri ruoli sono determinati dalla membership in oc_group_user
 *     (tabella Nextcloud, gid case-sensitive).
 *
 * IBEX policy:
 *   - isAdmin($uid)  → 'admin' OR gruppo 'Amministrazione'
 *     Privilegio: pubblicare/eliminare preset nel pool condiviso.
 */
class UserContext
{
    /**
     * uid='admin' OR membro 'Amministrazione'.
     * Permette di pubblicare/eliminare preset DAG nel pool condiviso.
     */
    public static function isAdmin(PDO $db, string $uid): bool
    {
        if ($uid === '') return false;
        if ($uid === 'admin') return true;
        try {
            $stmt = $db->prepare(
                "SELECT 1 FROM nextcloud.oc_group_user WHERE uid = ? AND gid = ? LIMIT 1"
            );
            $stmt->execute([$uid, 'Amministrazione']);
            return (bool)$stmt->fetchColumn();
        } catch (\Exception $e) {
            return false;
        }
    }
}
