#!/usr/bin/env bash
# Deploy edvibe-school-mcp to the personal staging server.
#
# Flow: push local main to GitHub → SSH to server → pull → npm ci → restart.
# Server must already be git-cloned and the systemd service configured.
# See CONTEXT.md → "Развёртывание" and PLAN.md → "Личный HTTP-стенд Руслана".
#
# Usage:
#   ./scripts/deploy.sh
#
# Exit codes:
#   0 — success
#   1 — push failed
#   2 — remote sync failed
set -euo pipefail

SERVER="root@185.180.230.233"
REMOTE_PATH="/var/www/edvibe.sungurov.com/edvibe-school-mcp"
SERVICE="edvibe-mcp"

echo "→ Pushing local main to origin..."
git push origin main || { echo "✗ git push failed"; exit 1; }

echo "→ SSH to server: git pull + npm ci + restart..."
ssh "$SERVER" bash -s << REMOTE || { echo "✗ remote sync failed"; exit 2; }
set -euo pipefail
cd "$REMOTE_PATH"
echo "  git pull..."
git pull --ff-only origin main
echo "  npm ci --omit=dev..."
npm ci --omit=dev
echo "  chown..."
chown -R www-data:www-data "$REMOTE_PATH"
echo "  systemctl restart..."
systemctl restart "$SERVICE"
sleep 1
echo "  health check..."
curl -sf http://localhost:9000/healthz && echo "  ok" || { echo "  ✗ health check failed"; exit 1; }
REMOTE

echo "✓ Deploy complete."
echo "  Health: https://edvibe.sungurov.com/healthz"
echo "  MCP:    https://edvibe.sungurov.com/mcp"
