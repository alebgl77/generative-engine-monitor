import type { JobStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SQL_NOW, enqueue } from "@/lib/queue/client";
import { INTERNAL_PROVIDER_CODE, LEASE, RETRY } from "@/lib/queue/types";

/**
 * Recovery pass, run periodically by every worker.
 *
 * Nothing here polls for progress: the sweeper only repairs states that no
 * process is left to repair. A worker killed mid-call leaves a job holding an
 * expired lease and a sample stuck in RUNNING, and those two rows are exactly
 * what makes the crash invisible to the user until someone puts them back.
 */

const LEASE_ERROR_CODE = "lease_expired";
const LEASE_ERROR_MESSAGE =
  "Bail expiré : le worker chargé de cet appel s'est interrompu sans le terminer";
const ORPHAN_ERROR_CODE = "orphaned";
const ORPHAN_ERROR_MESSAGE =
  "Traitement interrompu : aucun worker ne prenait plus cet échantillon en charge";

/**
 * How long a bucket has to sit untouched before it is a candidate for removal.
 * Every window in the application refills in minutes, so six hours is far past
 * the point where a bucket could still be holding anyone back.
 */
const IDLE_BUCKET_SEC = 6 * 3600;

/**
 * Buckets created at worker startup and consumed without being re-created are
 * off limits: deleting one would make `tryConsume` fail closed on every call
 * that provider handles until the worker is restarted.
 */
const MANAGED_BUCKET_PREFIX = "provider:";

export interface SweepSummary {
  requeued: number;
  dead: number;
  orphanSamples: number;
  cancelledRuns: number;
  purgedBuckets: number;
}

/**
 * Jobs whose lease expired go back to the pool with a fresh backoff, except
 * those that already burned their attempt budget: those become DEAD and are
 * never retried automatically, because a job that killed its worker on every
 * attempt will keep doing so.
 *
 * The backoff is expressed in SQL to keep this a single statement; it mirrors
 * `backoffSeconds`, with `random()` drawn per row so a mass expiry does not
 * come back as one synchronised wave.
 */
export async function sweepExpiredLeases(): Promise<{ requeued: number; dead: number }> {
  const rows = await prisma.$queryRaw<{ status: JobStatus }[]>`
    UPDATE jobs
       SET status = CASE
                      WHEN attempts >= max_attempts THEN 'DEAD'::"JobStatus"
                      ELSE 'QUEUED'::"JobStatus"
                    END,
           available_at = CASE
                            WHEN attempts >= max_attempts THEN available_at
                            ELSE ${SQL_NOW} + make_interval(secs =>
                              LEAST(
                                ${RETRY.maxDelaySec}::double precision,
                                ${RETRY.baseDelaySec}::double precision
                                  * power(2::double precision, attempts::double precision)
                              ) * (${1 - RETRY.jitter}::double precision + random() * ${RETRY.jitter * 2}::double precision)
                            )
                          END,
           completed_at = CASE
                            WHEN attempts >= max_attempts THEN ${SQL_NOW}
                            ELSE NULL
                          END,
           locked_by = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           last_error = ${LEASE_ERROR_MESSAGE},
           last_error_code = ${LEASE_ERROR_CODE},
           updated_at = ${SQL_NOW}
     WHERE status = 'RUNNING'::"JobStatus"
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < ${SQL_NOW}
    RETURNING status`;

  const dead = rows.filter((row) => row.status === "DEAD").length;
  return { requeued: rows.length - dead, dead };
}

/**
 * A sample left RUNNING with no QUEUED or RUNNING job behind it has no owner
 * and never will: it is marked failed and its task's counters are corrected in
 * the same statement, so a killed worker cannot leave a run pending forever.
 *
 * The grace period covers the window between a job reaching a terminal state
 * and its sample being written, which are not always the same transaction.
 */
export async function reconcileOrphanSamples(): Promise<number> {
  const rows = await prisma.$queryRaw<OrphanReconciliation[]>`
    WITH orphan AS (
      UPDATE run_samples s
         SET status = 'FAILED'::"SampleStatus",
             error_code = ${ORPHAN_ERROR_CODE},
             error_message = ${ORPHAN_ERROR_MESSAGE},
             completed_at = ${SQL_NOW}
       WHERE s.status = 'RUNNING'::"SampleStatus"
         AND COALESCE(s.started_at, s.created_at)
             < ${SQL_NOW} - make_interval(secs => ${LEASE.durationSec}::double precision)
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
            WHERE j.sample_id = s.id
              AND j.status IN ('QUEUED'::"JobStatus", 'RUNNING'::"JobStatus")
         )
      RETURNING s.task_id AS task_id
    ),
    per_task AS (
      SELECT task_id, count(*)::int AS n FROM orphan GROUP BY task_id
    )
    UPDATE run_tasks t
       SET pending_samples = GREATEST(t.pending_samples - p.n, 0),
           failed_samples = t.failed_samples + p.n
      FROM per_task p
     WHERE t.id = p.task_id
    RETURNING p.n AS n,
              t.id AS task_id,
              t.run_id AS run_id,
              t.project_id AS project_id,
              t.pending_samples AS pending_samples`;

  // RETURNING yields post-update values, so a task whose last outstanding sample
  // was the orphaned one comes back at zero. Nothing else would ever schedule
  // its aggregation, and the run would stay RUNNING for good.
  const drained = rows.filter((row) => row.pending_samples === 0);
  if (drained.length > 0) {
    await scheduleAggregationFor(drained);
  }

  return rows.reduce((total, row) => total + row.n, 0);
}

interface OrphanReconciliation {
  n: number;
  task_id: string;
  run_id: string;
  project_id: string;
  pending_samples: number;
}

/**
 * The sweeper has no job payload to read a scoring version from, so it takes the
 * one the run was planned with — the same value every handler of that run uses.
 */
async function scheduleAggregationFor(tasks: OrphanReconciliation[]): Promise<void> {
  const runIds = Array.from(new Set(tasks.map((t) => t.run_id)));
  const runs = await prisma.run.findMany({
    where: { id: { in: runIds } },
    select: { id: true, scoringVersion: true },
  });
  const versionOf = new Map(runs.map((r) => [r.id, r.scoringVersion]));

  const jobs = tasks
    .map((task) => {
      const scoringVersion = versionOf.get(task.run_id);
      if (!scoringVersion) return null;
      return {
        kind: "AGGREGATE_TASK" as const,
        runId: task.run_id,
        projectId: task.project_id,
        taskId: task.task_id,
        providerCode: INTERNAL_PROVIDER_CODE,
        priority: 10,
        payload: { taskId: task.task_id, runId: task.run_id, scoringVersion },
      };
    })
    .filter((job): job is NonNullable<typeof job> => job !== null);

  if (jobs.length > 0) {
    await enqueue(jobs);
  }
}

/**
 * Closes a cancellation once nothing is left in flight. Leftover QUEUED jobs
 * are swept first: a job requeued by `sweepExpiredLeases` after the user hit
 * cancel would otherwise be executed, and the run would never reach CANCELLED.
 */
export async function finalizeStuckCancellations(): Promise<number> {
  await prisma.$executeRaw`
    UPDATE jobs j
       SET status = 'CANCELLED'::"JobStatus",
           completed_at = ${SQL_NOW},
           locked_by = NULL,
           lease_expires_at = NULL,
           updated_at = ${SQL_NOW}
     WHERE j.status = 'QUEUED'::"JobStatus"
       AND EXISTS (
         SELECT 1 FROM runs r
          WHERE r.id = j.run_id
            AND r.status = 'CANCELLING'::"RunStatus"
       )`;

  return prisma.$executeRaw`
    UPDATE runs r
       SET status = 'CANCELLED'::"RunStatus",
           completed_at = ${SQL_NOW}
     WHERE r.status = 'CANCELLING'::"RunStatus"
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
          WHERE j.run_id = r.id
            AND j.status IN ('QUEUED'::"JobStatus", 'RUNNING'::"JobStatus")
       )`;
}

/**
 * Buckets are created on demand — one per login address, per registration
 * address, per user starting runs — and nothing else would ever remove them.
 *
 * A bucket back at capacity carries no state: whoever it belonged to is owed
 * the full allowance, which is exactly what the caller's `ensureBucket` hands
 * back if the key shows up again. Fullness is read through the same lazy refill
 * the consuming statement applies, since the stored balance is only rewritten
 * when tokens are actually spent. Anything still holding a debt is left alone,
 * so a throttle can never be lifted by deleting its bucket.
 */
export async function purgeIdleRateLimitBuckets(): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM rate_limit_buckets
     WHERE refilled_at < ${SQL_NOW} - make_interval(secs => ${IDLE_BUCKET_SEC}::double precision)
       AND key NOT LIKE ${`${MANAGED_BUCKET_PREFIX}%`}
       AND tokens + EXTRACT(EPOCH FROM (${SQL_NOW} - refilled_at)) * refill_per_sec >= capacity`;
}

/**
 * Order matters: leases first, so a job that just came back to the pool still
 * protects its sample from being declared an orphan; cancellations last, so a
 * run whose final job just died is finalised in the same pass. The bucket purge
 * touches nothing the rest of the pass reads.
 */
export async function runSweep(): Promise<SweepSummary> {
  const leases = await sweepExpiredLeases();
  const orphanSamples = await reconcileOrphanSamples();
  const cancelledRuns = await finalizeStuckCancellations();
  const purgedBuckets = await purgeIdleRateLimitBuckets();

  return {
    requeued: leases.requeued,
    dead: leases.dead,
    orphanSamples,
    cancelledRuns,
    purgedBuckets,
  };
}
