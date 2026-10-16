#!/usr/bin/env bash
# Builds and re-deploys both PM2 apps without ever taking support-client and support-server down at the same
# time. Run from anywhere; it cd's to the repo root itself.
#
#   support-client (Next.js, port 4000) runs as a 2-instance PM2 cluster (see ecosystem.config.cjs), so
#   `pm2 reload` on it is a true rolling reload: the port stays answerable throughout.
#
#   support-server (Express/Socket.io, port 5000) keeps in-memory state (presence, reminders) and must stay a
#   single instance, so reloading it is a plain restart with a few hundred ms gap. The app's own error handling
#   (lib/api.ts's NetworkError, surfaced by AppShell and the inbox page as a retry state) covers that gap for
#   anyone using the app at that moment — this script just makes sure it's the ONLY thing down, never both.
set -euo pipefail
cd "$(dirname "$0")/.."

wait_healthy() {
  local url=$1 name=$2 tries=${3:-30}
  for _ in $(seq 1 "$tries"); do
    if curl -sf -o /dev/null "$url"; then
      echo "    $name is responding"
      return 0
    fi
    sleep 1
  done
  echo "    $name did not become healthy within ${tries}s" >&2
  return 1
}

echo "==> Installing dependencies"
npm install --workspaces

echo "==> Type-checking server"
npm run typecheck --workspace=server

echo "==> Building client (also type-checks it)"
npm run build --workspace=client

echo "==> Reloading support-client (rolling, cluster mode — should stay up throughout)"
pm2 reload ecosystem.config.cjs --only support-client --update-env
wait_healthy "http://127.0.0.1:4000/inbox" "support-client"

echo "==> Restarting support-server (brief gap; single instance by design — see ecosystem.config.cjs)"
pm2 restart ecosystem.config.cjs --only support-server --update-env
wait_healthy "http://127.0.0.1:5000/health" "support-server"

echo "==> Deploy complete"
pm2 status
