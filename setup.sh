#!/bin/sh
set -e

# Local (non-Docker) setup. Generates real secrets on first run rather than
# shipping working defaults — a placeholder encryption key that happens to work
# is a placeholder that reaches production.

if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env

  echo "Installing dependencies..."
  npm install --silent

  echo "Generating secrets..."
  npx tsx scripts/keygen.ts --write

  echo
  echo ".env created with freshly generated secrets."
  echo "Point DATABASE_URL at your PostgreSQL instance, then run ./setup.sh again."
  exit 0
fi

echo "Installing dependencies..."
npm install

echo "Generating Prisma client..."
npx prisma generate

echo "Applying migrations..."
npx prisma migrate deploy

# Always seeds the providers and their rate-limit buckets — without them no run
# can be planned. The demo project stays behind SEED_DEMO, which the script
# reads from .env itself.
echo "Seeding reference data..."
npx tsx prisma/seed.ts

echo
echo "Ready."
echo "  npm run dev      # web application on http://localhost:3000"
echo "  npm run worker   # run executor — analyses do not progress without it"
