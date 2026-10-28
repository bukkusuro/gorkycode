#!/bin/sh
# Run on 10.40.50.200 after both A records point to 46.191.157.73.
set -eu
config_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sudo certbot certonly --webroot -w /var/www/letsencrypt \
    --cert-name voxacode.online -d voxacode.online -d www.voxacode.online \
    --non-interactive --deploy-hook 'nginx -t && systemctl reload nginx'
sudo cp -p /etc/nginx/sites-available/voxacode.online \
    /etc/nginx/sites-available/voxacode.online.before-https
sudo install -m 644 "$config_dir/voxacode.https.conf" \
    /etc/nginx/sites-available/voxacode.online
if ! sudo nginx -t; then
    sudo cp -p /etc/nginx/sites-available/voxacode.online.before-https \
        /etc/nginx/sites-available/voxacode.online
    exit 1
fi
sudo systemctl reload nginx
