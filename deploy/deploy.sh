#!/usr/bin/env bash
# Deploy GYRE to the VPS: rsync the project, install prod deps, (re)start pm2.
# Usage: ./deploy/deploy.sh            (from the gyre/ folder)
# server/.env is never synced; copy it once with:  scp server/.env root@203.194.113.116:/var/www/gyre.trade/app/server/.env
set -euo pipefail
HOST=${HOST:-root@203.194.113.116}
DIR=/var/www/gyre.trade/app
cd "$(dirname "$0")/.."

rsync -az --delete --filter="protect /server/node_modules/" --filter="protect /cli/node_modules/" \
  --exclude node_modules --exclude .git/ --exclude server/.env --exclude server/data/ \
  --exclude konten-x/ --exclude brand/ --exclude '.DS_Store' \
  -e "ssh -o BatchMode=yes" ./ "$HOST:$DIR/"

ssh -o BatchMode=yes "$HOST" "export LC_ALL=C.UTF-8; set -e
  cd $DIR/server && npm install --omit=dev --no-audit --no-fund
  test -f .env || echo 'WARNING: server/.env missing on the VPS, the agent endpoints will answer 503'
  pm2 startOrRestart $DIR/deploy/ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do sleep 1; curl -fsS http://127.0.0.1:5520/api/health 2>/dev/null && break; done"
echo
echo "deployed → https://gyre.trade"
