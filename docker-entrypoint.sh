#!/bin/sh
set -e

# Exactly one container migrates and seeds. Two processes racing `migrate deploy`
# against the same database can leave the migration lock inconsistent, so the
# worker starts with RUN_MIGRATIONS=false and waits for the schema instead.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Applying migrations..."
  npx prisma migrate deploy

  # Providers and their rate-limit buckets are reference data, not sample data:
  # with an empty providers table no run can be planned at all. The seed script
  # gates the demo project behind SEED_DEMO on its own.
  echo "Seeding reference data..."
  npx tsx prisma/seed.ts
else
  echo "Waiting for the database schema..."
  attempt=0
  until npx prisma migrate status >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 60 ]; then
      echo "Schema still unavailable after 5 minutes, giving up." >&2
      exit 1
    fi
    sleep 5
  done
  echo "Schema ready."
fi

exec "$@"
