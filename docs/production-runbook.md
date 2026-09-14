# Production runbook

Each operator installs and maintains their own self-hosted instance, database,
volumes and secrets; no central hosted service is provided. Start with the
[self-hosted installation guide](02-installation.md#installer-sa-propre-instance).
Public source code does not imply a public instance or public data. Backups,
updates and secret retention are each operator's responsibility.

This release changes queue lease ownership and immutable measurement history.
Upgrading an existing or restored database requires a maintenance window: stop **all old web and worker processes before
applying migrations**. Old writers and new lease generations are not compatible;
this upgrade must not use rolling deployment. No deployment is performed by CI.

## Runtime contract

- Build targets: `web` is Next standalone plus `public` and `.next/static`;
  `worker` runs TypeScript with the production `tsx` dependency and `tsconfig`
  path aliases; `migrate` alone carries the locked Prisma CLI/build dependencies.
  All targets run as non-root UID 1001 and include OpenSSL/Prisma native engines.
- Web and worker do not run migrations. The one-shot migrator applies every
  migration and bootstraps missing reference providers/buckets without updating
  existing operator configuration; both services depend on its successful
  completion. A failed migration or seed must leave them stopped.
- PostgreSQL has no host-published port. Web binds to loopback by default and can
  stay private. Network access requires an operator-managed HTTPS reverse proxy;
  see [access mode and HTTPS](#access-mode-and-https).
- Node, PostgreSQL `timezone` and `log_timezone` use UTC. On managed PostgreSQL,
  configure UTC at database/role/session level and verify `SHOW timezone` with
  the actual application role. Existing Prisma timestamps are timezone-naive.
- Compose waits for service health/completion, not just process creation.
  See [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/).
  Next standalone does not include static/public assets automatically; see
  [Next output documentation](https://nextjs.org/docs/app/api-reference/config/next-config-js/output).

## Access mode and HTTPS

Local use needs no domain or public proxy: keep `APP_BIND_ADDRESS=127.0.0.1` and
use a local browser or an SSH tunnel. Set `NEXTAUTH_URL` to that browser origin,
for example `http://127.0.0.1:3000`; keep `TRUSTED_PROXY_HOPS=0` for direct access.
HTTP is only for loopback access, including the local ends of an SSH tunnel.

For direct network access, including a LAN, use operator-managed HTTPS. Configure
the proxy, its certificate and the final HTTPS origin in `NEXTAUTH_URL`; keep the
backend private so clients cannot bypass the proxy. Set `TRUSTED_PROXY_HOPS` to
the actual trusted chain, not a client-supplied value. Recreate `web` after changing
its environment. Complete private account bootstrap before exposing this access.

## Secrets and preparation

Copy `.env.production.example` to an untracked `.env.production`, restrict it to
the operator account (`chmod 600`), and supply every blank required value through
your secret manager. Do not overwrite an existing configuration or use
`.env.example` development credentials.

Generate an independent high-entropy database password. On the preparation host,
Node 22 and the locked dependencies (`npm ci`) are needed for `npm run keygen`.
It prints the session secret, credential encryption keyring, current key version
and fingerprint pepper: copy them into the new instance's protected
`.env.production` as described under [secrets](02-installation.md#secrets).
Its `--write` option targets only `.env`, not `.env.production`; production images
do not include the generator. Do not regenerate secrets during an upgrade. Preserve old
encryption-key versions when rotating: existing rows and restored backups still
need them. Losing those keys makes encrypted provider credentials unrecoverable.
Store keyring backups separately from the database backup with restricted access.

`DATABASE_URL` is explicit, not concatenated from secrets. URI-encode its username
and password; for this Compose stack the host is `postgres`, port `5432`. Include
`connect_timeout=3&pool_timeout=3&connection_limit=10` in the query string, tuning
the aggregate pool budget for all web/worker replicas and the database capacity.
Use the managed provider's required TLS settings for an external database.
`NEXTAUTH_URL` must match the chosen [access origin](#access-mode-and-https).
Provider API keys belong in the encrypted credential UI, not an image, Git, CI,
or build arguments. Requests send analysis content to the selected providers and
incur charges on the operator's provider accounts; self-hosting is not local AI.

Production Compose defaults to `REGISTRATION_ENABLED=false`. Follow
[access control and private first-account setup](access-control.md) before
exposing the reverse proxy; do not temporarily open registration publicly.

## Controlled deployment

Examples below are POSIX shell commands run by the authorized operator in the
release checkout. `dc` always uses the protected environment. Keep a stable,
instance-specific Compose project name and volume; never reuse a development
database. Choose exactly one preparation path below, then use the shared
migration/startup gate. Do not delete volumes to retry an installation or upgrade.

For a new instance, set a unique `COMPOSE_PROJECT_NAME` in `.env.production`,
for example `gem-private`; retain the existing deployment's name on upgrades.
Avoid a conflicting exported variable or `-p` override; see Docker's
[project-name configuration](https://docs.docker.com/compose/how-tos/environment-variables/envvars/#compose_project_name).
If several instances share a host, assign each an unused, distinct `APP_PORT`
and match its browser port in `NEXTAUTH_URL` and any SSH tunnel.

```sh
dc() { docker compose --env-file .env.production -f docker-compose.prod.yml "$@"; }
dc config --quiet || exit 1
```

### First installation (empty database)

This path is only for a new, empty database/volume. An existing or restored
database must use [upgrades](#upgrades-existing-or-restored-database), even on a new
host. Complete the protected configuration above, with registration closed and
private loopback access. Build the targets and start only PostgreSQL:

```sh
dc build web worker migrate || exit 1
dc up -d --wait postgres || exit 1
```

Once PostgreSQL is healthy, continue with the [migration/startup gate](#migration-and-writer-startup).
No pre-upgrade backup exists for an empty database. After successful startup,
complete [private first-account setup](access-control.md) and establish the
backup/restore procedure below before relying on the instance for real data.

### Upgrades (existing or restored database)

Before building, retain the exact previous source revision, images/digests and
compatible secrets/keyring for rollback. Review migration SQL and disk headroom,
rehearse on a restored isolated database, and record a rollback decision point.
Keep the same Compose project name and volume as the existing deployment;
changing either can target an empty stack while leaving old workers active.

```sh
dc build web worker migrate || exit 1
```

Building does not stop old writers. At the maintenance window, block incoming
traffic/run creation, at the reverse proxy if present, and stop every old replica, including
workers launched outside this Compose project. Keep the database running.

```sh
dc stop web worker || exit 1
dc ps --all || exit 1
```

Verify no old web/worker process remains. Worker grace is 25 seconds plus 2 seconds
for aborted handlers to settle; Compose allows 120 seconds for draining and lease
release. Do not immediately follow graceful stop with a forced kill.

Confirm PostgreSQL is healthy, without starting any writers:

```sh
dc up -d --wait postgres || exit 1
```

Take and verify the [pre-migration backup](#backups-restore-and-pitr) with all
writers stopped. Only then continue with the shared gate below.

### Migration and writer startup

Run this only after completing the first-installation or upgrade preparation.
Explicitly recreate the one-shot migrator so an old successful container cannot
stand in for this release. Its invocation excludes the already-running dependency so
`--exit-code-from` cannot stop PostgreSQL when the one-shot service exits.
PostgreSQL must remain healthy throughout. The checked exit code below stops the
shell on migration/seed failure: no following writer-start command can run.

```sh
dc up --no-deps --force-recreate --exit-code-from migrate migrate || exit 1
dc logs migrate || exit 1
```

Check the successful migrator logs before continuing. Never mark an incomplete
migration as applied merely to unblock startup. On failure leave web/worker
stopped, inspect the logs and follow recovery below; an upgrade must retain its
pre-migration backup, and a failed first install must not be retried by deleting
its volume.

Production bootstrap is create-only and safe to repeat: missing providers and
buckets are created, existing models/capabilities/RPM/concurrency and bucket state
are unchanged. A missing bucket uses its provider's actual RPM. Demo seeding is
disabled. Outside Compose, use `NODE_ENV=production npm run db:deploy && NODE_ENV=production npm run db:seed`
with the same protected environment and all writers stopped; start web/worker
only if both succeed. Do not use development seed mode against production.

```sh
if ! (
  dc up -d --wait --wait-timeout 120 web worker || exit 1
  dc ps --all || exit 1
  curl --fail http://127.0.0.1:3000/api/health/live || exit 1
  curl --fail http://127.0.0.1:3000/api/health/ready || exit 1
  dc exec -T worker node scripts/worker-health.mjs || exit 1
); then
  if ! dc stop web worker; then
    printf '%s\n' 'Writer stop failed: manually stop and verify ALL writers; keep access closed.' >&2
    exit 1
  fi
  dc ps --all || exit 1
  printf '%s\n' 'Startup checks failed: keep traffic blocked and diagnose before retrying.' >&2
  exit 1
fi
```

The [Compose wait options](https://docs.docker.com/reference/cli/docker/compose/up/)
allow up to 120 seconds for the services to become healthy before the probes;
on failure, the block attempts to stop web/worker and exits nonzero, without
stopping PostgreSQL or changing volumes. If automatic stop fails, manually stop
and verify every writer while keeping access closed; shutdown is not guaranteed
by the failed command. This documented wait does not establish real Docker
qualification, which remains unexecuted.

Adjust the HTTP port to `APP_PORT`. For multiple workers inspect each container's
health, not just the first replica. For a first installation, now complete the
[private account bootstrap](access-control.md) before considering network access;
keeping the instance private is valid. Verify login and a small **mock-only** run,
exports and, on upgrades, historical snapshots before removing maintenance mode.
Use an account without provider credentials for the mock-only check. Do not run
`tests/smoke-production.mjs` against production: it requires an isolated loopback
test database and explicit fixture-mutation consent.

## Health and incident response

- `/api/health/live`: `200 {"status":"ok"}` means the web process can answer.
- `/api/health/ready`: `200 {"status":"ready"}` only when the DB responds,
  all packaged migrations have completed with matching checksums (LF/CRLF
  conversions accepted), and schema-critical columns parse. Otherwise it returns
  `503 {"status":"unavailable"}` without DB host, credentials or error text.
  Probes have a bounded response time and share an in-flight DB check.
- Worker heartbeat is a private atomic file renewed only after successful
  loop/DB work, including idle polling. Startup/shutdown clears it. The CLI exits
  nonzero for a missing, malformed, future or older-than-30-second heartbeat.
  One worker process per container is required. Separate processes on one host
  must each use a distinct `WORKER_HEALTH_FILE`; never share heartbeat volumes.
- Docker marks unhealthy containers but **does not automatically restart them
  solely because health is unhealthy**. `restart: unless-stopped` covers process
  exits. Connect health events to the actual alerting/orchestration system.

Alert on persistent web-not-ready/worker-unhealthy (>60 seconds), any new `DEAD`
job, queue age growth, repeated lease loss, migration failure, DB capacity, disk
space, backup age, restore failure and provider error/rate-limit spikes. A healthy
worker is not proof that providers respond or runs finish; monitor business-level
completion too. Read-only queue triage, using an operator DB session in UTC:

```sql
SELECT kind, status, COUNT(*) FROM jobs
WHERE status IN ('DEAD', 'QUEUED', 'RUNNING') GROUP BY kind, status;
SELECT MIN(available_at) AS oldest_ready_job FROM jobs
WHERE status = 'QUEUED' AND available_at <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
```

Inspect dead-letter errors and the associated run/sample before replay. A paid
provider request may have succeeded before a process died; delivery is at-least-
once, not a promise of provider-side exactly-once billing. Do not mass-requeue
`DEAD` jobs or rerun acquisitions to recover an analysis-only failure. Prefer the
versioned rescore/recovery path against stored raw responses when appropriate.

## Backups, restore and PITR

Database volumes are persistence, not backups. Establish encrypted off-host backups
with access control, retention, checksums and alerts. Take a custom-format logical
dump before this upgrade, retain role/grant definitions as needed, and preserve
the compatible keyring separately. Example on the already stopped old writers:

```sh
dc exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > pre-upgrade.dump || exit 1
```

Check the command exit code, nonzero backup size and checksum. Upload through the
approved backup system; do not leave plaintext dumps in this repository. Logical
dumps alone cannot provide point-in-time recovery.

Rehearse restoration regularly into a **new isolated database/volume**, never by
overwriting the live volume. Use a compatible PostgreSQL client and
`pg_restore --exit-on-error --no-owner --no-acl --dbname=<isolated-target>` with
the backup file, then reapply the required ownership/grants. Validate migration
journal, row counts, foreign keys, encrypted-credential decryptability, raw
responses, immutable snapshots and a mock-only end-to-end run. Record actual
restore duration, recovery point and evidence; a backup listing is not a restore
test. Keep the old volume untouched until recovery is independently accepted.

For PITR, configure the database platform's base backups plus continuous WAL
archiving, retention and monitoring. Rehearse restoration to a selected timestamp
and verify data at that recovery point. This Compose file does **not** configure
WAL archiving/PITR. Operators must select and prove it before relying on an RPO.

## Failure and rollback

If a migration fails, keep all writers stopped. Inspect the actual SQL transaction
state and `_prisma_migrations`, then either correct and resume through Prisma's
documented recovery procedure or restore the pre-upgrade backup into a new
database. Never edit deployed migration files or checksums to hide divergence.

An image rollback after a successful schema upgrade is not automatically safe:
old lease writers must not run against this release's upgraded database. Either
deploy a reviewed forward fix, or restore the pre-upgrade database **and** matching
old image/keyring together. Restoring drops writes after the chosen recovery
point; obtain explicit incident-owner approval before this data-loss decision.
Keep the failed database for forensic analysis. Verify health, access and mock
workflow before traffic resumes.

## Retention, limits and operating targets

Define approved retention separately for raw provider responses, immutable run
history, credentials, audit logs, application logs and backups. Archiving a query,
brand or competitor preserves historical analysis; it is not erasure. No automatic
raw-response/history purge is introduced here. Any purge must honor project/user
boundaries, dependencies, audit retention and deletion obligations, be reviewed,
backed up and tested. Avoid deleting source evidence needed for future rescores.

`MAX_SAMPLES_PER_RUN`, `MAX_SAMPLES_PER_USER_DAY`, `MAX_ACTIVE_RUNS_PER_USER` and
`MAX_QUERIES_PER_PROJECT` are non-monetary admission bounds. They are not hard
currency budgets: provider prices, retries and sentiment calls may change spend.
Use provider-side spending controls, alerting and an operator kill switch too.

Proposed initial objectives, to validate under representative load: 99.9% monthly
web readiness; API p95 under 500 ms / p99 under 2 seconds excluding generation;
ready queue age under 60 seconds at normal capacity; alert within 60 seconds on
unhealthy workers; RPO <=15 minutes and RTO <=60 minutes only once PITR/restore
drills prove them. Measure by endpoint/provider and separate infrastructure
outages from upstream-provider failures. These are targets, not measured results.

## Validation boundary and external work

CI uses the locked install, Prisma generate/migrate/seed, lint, typecheck, full
Vitest with PostgreSQL (integration enabled), standalone build, mock-only HTTP
smoke and dependency audit. CI credentials are disposable and never provider keys.

The separate `containers` CI job builds all three production targets and runs
`scripts/container-smoke.sh` on Linux Docker. It checks successful migrator exit,
web readiness, worker health, runtime UID 1001, the existing mock-only HTTP workflow
and a real migration authentication failure in a second fresh project. The latter
must leave both web and worker never started, not merely stopped afterwards.
The smoke uses generated project names, explicit disposable configuration and no
production environment file. Only its test override publishes PostgreSQL on a
random loopback port; a test client uses Linux host networking to retain the
existing smoke's loopback-only safeguards. It uses port 3100 for HTTP, so that
port must be free. Every operation is time-bounded; cleanup targets only the
generated test projects and their volumes. Failure logs (not rendered environment
configuration) are retained for seven days as a CI artifact. No registry login,
image push, production secrets or paid-provider calls are used. This follows
[Docker's test-before-push guidance](https://docs.docker.com/build/ci/github-actions/test-before-push/),
without the push step.

**Actual local container qualification has not been executed.** Docker CLI is
unavailable in the current Windows environment and the Docker Desktop WSL distro
is stopped; no engine was installed or started. Shell parsing and mocked script
control-flow checks do not qualify Linux/Alpine image builds, Prisma native engines
or Compose behavior. Require a successful Docker CI job before claiming those
checks pass. Restart/drain signals still need a dedicated operational drill.
Local PostgreSQL checks do not establish container validation, PITR, load/P99,
production readiness SLOs or real-provider behavior. Remaining operator work includes HTTPS/proxy configuration
for network exposure (no domain is required for loopback/SSH-only use), secret
provisioning, restricted network access, backup/PITR scheduling and restore drills,
monitoring/alert delivery, capacity/load tests and an authorized deployment.
