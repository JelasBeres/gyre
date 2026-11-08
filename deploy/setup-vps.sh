#!/usr/bin/env bash
# One-time server setup for Nucleo on AlmaLinux 8 (run as root on the VPS).
# Installs nginx, Node 22, pm2, certbot; opens 80/443; prepares /var/www/nucleoagent.com.
set -euo pipefail
export LC_ALL=C.UTF-8
DOMAIN=nucleoagent.com
APP=/var/www/$DOMAIN/app

dnf -y update
dnf -y install epel-release
dnf -y install nginx rsync git tar policycoreutils-python-utils certbot python3-certbot-nginx

if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf -y install nodejs
fi
npm i -g pm2 >/dev/null

mkdir -p "$APP"
install -m 644 "$APP/deploy/$DOMAIN.conf" /etc/nginx/conf.d/$DOMAIN.conf
# nginx must be allowed to talk to the Node port under SELinux
setsebool -P httpd_can_network_connect 1
nginx -t && systemctl enable --now nginx && systemctl reload nginx

firewall-cmd --permanent --add-service=http >/dev/null
firewall-cmd --permanent --add-service=https >/dev/null
firewall-cmd --reload >/dev/null

pm2 startup systemd -u root --hp /root >/dev/null || true
echo "setup done · next: deploy.sh from your machine, then certbot"
