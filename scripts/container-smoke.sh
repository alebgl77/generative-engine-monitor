#!/usr/bin/env bash
set -Eeuo pipefail

# Linux Docker host only. Never loads .env or uses an existing Compose project.
if [[ "${CONTAINER_SMOKE_ALLOW_MUTATION:-}" != "1" ]]; then
  echo "Set CONTAINER_SMOKE_ALLOW_MUTATION=1 only on a disposable Docker test host." >&2
  exit 1
fi
command -v docker >/dev/null
command -v timeout >/dev/null

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/gem-container-smoke.XXXXXXXX")
suffix=${test_dir##*.}
project="gem-smoke-${suffix,,}"
[[ "$project" =~ ^gem-smoke-[a-z0-9]{8}$ ]]
blocked_project="${project}-blocked"
smoke_container="${project}-http"
log_dir=${CONTAINER_SMOKE_LOG_DIR:-"$test_dir/logs"}
mkdir -p -- "$log_dir"

# Disposable test-only secrets and mutation settings, never inherited values.
export POSTGRES_USER=gem POSTGRES_PASSWORD=container-smoke-only POSTGRES_DB=gem_smoke
export DATABASE_URL='postgresql://gem:container-smoke-only@postgres:5432/gem_smoke?connect_timeout=3&pool_timeout=3&connection_limit=10'
export NEXTAUTH_URL=http://127.0.0.1:3100 APP_BIND_ADDRESS=127.0.0.1 APP_PORT=3100
export NEXTAUTH_SECRET=container-smoke-session-secret-only
export CREDENTIAL_KEYS='{"1":"Y2ktb25seS1rZXktbm90LXVzZWQtaW4tcHJvZHVjdCE="}'
export CREDENTIAL_KEY_CURRENT=1 CREDENTIAL_FINGERPRINT_PEPPER=container-smoke-pepper-only
export REGISTRATION_ENABLED=true SENTIMENT_ENABLED=false SEED_DEMO=false
export LOG_LEVEL=warn TRUSTED_PROXY_HOPS=0 WORKER_REPLICAS=1 WORKER_BATCH_SIZE=5
export MAX_SAMPLES_PER_RUN=1000 MAX_SAMPLES_PER_USER_DAY=10000 MAX_ACTIVE_RUNS_PER_USER=3 MAX_QUERIES_PER_PROJECT=1000

# Only this disposable stack publishes PostgreSQL, on a random loopback port.
# Explicit image names let the negative project reuse all three tested builds.
cat > "$test_dir/compose.yml" <<EOF
services:
  postgres:
    ports: ["127.0.0.1::5432"]
  web:
    image: ${project}-web
    pull_policy: never
  worker:
    image: ${project}-worker
    pull_policy: never
  migrate:
    image: ${project}-migrate
    pull_policy: never
EOF
cat > "$test_dir/blocked.yml" <<'EOF'
services:
  migrate:
    environment:
      DATABASE_URL: postgresql://nonexistent:denied@postgres:5432/gem_smoke?connect_timeout=3&pool_timeout=3
EOF

dc() {
  local name=$1
  shift
  local files=(-f "$repo_dir/docker-compose.prod.yml" -f "$test_dir/compose.yml")
  if [[ "$name" == "$blocked_project" ]]; then files+=(-f "$test_dir/blocked.yml"); fi
  timeout "${command_timeout:-180}" docker compose --env-file /dev/null --project-name "$name" "${files[@]}" "$@"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  timeout 30 docker container rm -f "$smoke_container" >/dev/null 2>&1
  for name in "$project" "$blocked_project"; do
    dc "$name" logs --no-color > "$log_dir/$name.log" 2>&1
    dc "$name" ps --all > "$log_dir/$name-status.log" 2>&1
    # Names are generated above, never supplied by a caller or production env.
    dc "$name" down --volumes --remove-orphans --timeout 120 >> "$log_dir/cleanup.log" 2>&1
    if [[ "$?" != 0 ]]; then status=1; fi
  done
  if [[ "$status" != 0 ]]; then echo "Container smoke failed; logs: $log_dir" >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

dc "$project" config --quiet
command_timeout=900 dc "$project" build web worker migrate > "$log_dir/build.log" 2>&1
dc "$project" up -d --no-build --wait --wait-timeout 150 web worker > "$log_dir/startup.log" 2>&1
migrator=$(dc "$project" ps --all --quiet migrate)
[[ -n "$migrator" ]]
[[ "$(timeout 30 docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "$migrator")" == "exited:0" ]]

for service in web worker; do
  container=$(dc "$project" ps --quiet "$service")
  [[ -n "$container" ]]
  [[ "$(timeout 30 docker inspect --format '{{.State.Health.Status}}' "$container")" == "healthy" ]]
  [[ "$(dc "$project" exec -T "$service" id -u)" == "1001" ]]
done
dc "$project" exec -T worker node scripts/worker-health.mjs
dc "$project" exec -T web node -e "fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The existing smoke requires loopback for HTTP and DB. Linux host networking
# retains those safeguards while using the image's Prisma/native dependencies.
postgres_address=$(dc "$project" port postgres 5432)
[[ "$postgres_address" =~ ^127\.0\.0\.1:([0-9]+)$ ]]
postgres_port=${BASH_REMATCH[1]}
timeout 480 docker run --rm --name "$smoke_container" --network host --entrypoint node \
  --env SMOKE_ALLOW_MUTATION=1 --env SMOKE_BASE_URL="$NEXTAUTH_URL" \
  --env "DATABASE_URL=postgresql://gem:container-smoke-only@127.0.0.1:$postgres_port/gem_smoke?connect_timeout=3&pool_timeout=3" \
  --mount "type=bind,src=$repo_dir/tests/smoke-production.mjs,dst=/app/container-smoke.mjs,readonly" \
  "${project}-migrate" /app/container-smoke.mjs > "$log_dir/http-smoke.log" 2>&1

# Release the shared HTTP test port, so a bind failure cannot masquerade as a
# working migration gate in the negative project.
dc "$project" stop web worker

# A fresh, separate database and a real Prisma authentication failure must stop
# dependency startup. A timeout or any briefly-started writer is not a pass.
if dc "$blocked_project" up -d --no-build web worker > "$log_dir/migration-gate.log" 2>&1; then
  echo "Invalid migration credentials unexpectedly permitted startup." >&2
  exit 1
else
  status=$?
  [[ "$status" != 124 && "$status" != 137 ]]
fi
migrator=$(dc "$blocked_project" ps --all --quiet migrate)
[[ -n "$migrator" ]]
[[ "$(timeout 30 docker inspect --format '{{.State.Status}}' "$migrator")" == "exited" ]]
migrator_exit_code=$(timeout 30 docker inspect --format '{{.State.ExitCode}}' "$migrator")
[[ "$migrator_exit_code" =~ ^[1-9][0-9]*$ ]]
for service in web worker; do
  container=$(dc "$blocked_project" ps --all --quiet "$service")
  if [[ -n "$container" ]]; then
    [[ "$(timeout 30 docker inspect --format '{{.State.StartedAt}}' "$container")" == "0001-01-01T00:00:00Z" ]]
    # Keep inspect failure distinct from a successfully inspected empty error.
    state_error=$(timeout 30 docker inspect --format '{{.State.Error}}' "$container")
    [[ -z "$state_error" ]]
  fi
done
echo "PASS container smoke: three images, migrator completion, readiness, worker health, non-root runtime, mock HTTP workflow and failed-migration startup gate."
