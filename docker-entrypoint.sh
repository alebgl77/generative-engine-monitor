#!/bin/sh
set -eu

# Only the dedicated one-shot service may migrate. Either failure must block
# Compose dependents, so no web/worker starts after partial setup.
if [ "${1:-}" = "migrate" ]; then
  ./node_modules/.bin/prisma migrate deploy
  exec node --import tsx prisma/seed.ts
fi

exec "$@"
