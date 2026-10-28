#!/usr/bin/env bash
# Sets up everything the test suites need on a fresh Linux machine or cloud session (idempotent):
# packages, the headless build, Postgres, MySQL 8 and MariaDB (and the connectors' real services,
# tests/services.yml), playwright-cli pointed at a local Chromium. Then: `source tests/env.sh`.
#   tests/setup-env.sh            everything
#   tests/setup-env.sh --no-gui   without playwright-cli
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d node_modules ] || npm ci
[ -d server/node_modules ] || npm ci --prefix server
[ -f server/headless/index.js ] || npm run build:headless

# Postgres: a local cluster when there is one (a cloud session has 16), else a container.
if command -v pg_lsclusters >/dev/null && pg_lsclusters -h | grep -q .; then
  pg_lsclusters -h | grep -q online || service postgresql start
  su postgres -c "psql -qc \"alter user postgres password 'postgres'\"" 2>/dev/null || true
  PG_LOCAL=1
fi

# Docker for the rest (a cloud session has the client and daemon, not started).
if ! docker info >/dev/null 2>&1; then
  (dockerd >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
docker compose -f tests/services.yml up -d --wait $([ -n "${PG_LOCAL:-}" ] && echo "mysql mariadb" || echo "")

if [ "${1:-}" != "--no-gui" ]; then
  command -v playwright-cli >/dev/null || npm install -g @playwright/cli@0.1.22
fi
echo "Ready: source tests/env.sh"
