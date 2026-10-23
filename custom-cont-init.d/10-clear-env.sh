#!/bin/sh
# Fase 2 / P2 (2026-06-14): clear_env=no -> i worker php-fpm ereditano le env del container (DB_*)
sed -i 's/^;*[[:space:]]*clear_env[[:space:]]*=.*/clear_env = no/' /etc/php84/php-fpm.d/*.conf
