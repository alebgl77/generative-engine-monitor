import type { JobStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SQL_NOW } from "@/lib/queue/client";
import { finalizeSample } from "@/lib/runs/finalize";
import { LEASE, RETRY } from "@/lib/queue/types";

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
  const candidates = await prisma.$queryRaw<{
    id: string; task_id: string; run_id: string; project_id: string; scoring_version: string;
  }[]>`
    SELECT s.id, s.task_id, s.run_id, s.project_id, r.scoring_version
    FROM run_samples s JOIN runs r ON r.id = s.run_id
    WHERE s.status IN ('PENDING'::"SampleStatus", 'RUNNING'::"SampleStatus")
      AND r.cancel_requested_at IS NULL
      AND COALESCE(s.started_at, s.created_at) < ${SQL_NOW} - make_interval(secs => ${LEASE.durationSec}::double precision)
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.sample_id = s.id AND j.status IN ('QUEUED'::"JobStatus", 'RUNNING'::"JobStatus"))
    ORDER BY s.run_id, s.id LIMIT 100`;
  let repaired = 0;
  for (const sample of candidates) {
    repaired += await prisma.$transaction(async (tx) => {
      // Recovery uses the same run -> job -> sample lock order as workers.
      const runs = await tx.$queryRaw<{ cancel_requested_at: Date | null }[]>`
        SELECT cancel_requested_at FROM runs WHERE id = ${sample.run_id} FOR UPDATE`;
      if (!runs.length || runs[0].cancel_requested_at) return 0;
      const jobs = await tx.$queryRaw<{ status: JobStatus }[]>`
        SELECT status FROM jobs WHERE sample_id = ${sample.id} FOR UPDATE`;
      if (jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING")) return 0;
      const changed = await finalizeSample(tx, {
        sampleId: sample.id, taskId: sample.task_id, runId: sample.run_id, projectId: sample.project_id,
        scoringVersion: sample.scoring_version, succeeded: false,
        errorCode: ORPHAN_ERROR_CODE, errorMessage: ORPHAN_ERROR_MESSAGE,
      });
      return changed ? 1 : 0;
    });
  }
  return repaired;
}

/**
 * Closes a cancellation once nothing is left in flight. Leftover QUEUED jobs
 * are swept first: a job requeued by `sweepExpiredLeases` after the user hit
 * cancel would otherwise be executed, and the run would never reach CANCELLED.
 */
export async function finalizeStuckCancellations(): Promise<number> {
  const candidates = await prisma.run.findMany({ where: { status: "CANCELLING" }, select: { id: true }, take: 100 });
  let closed = 0;
  for (const run of candidates) closed += await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM runs WHERE id = ${run.id} FOR UPDATE`;
    if (locked[0]?.status !== "CANCELLING") return 0;
    await tx.job.updateMany({ where: { runId: run.id, status: "QUEUED" }, data: {
      status: "CANCELLED", completedAt: new Date(), lockedBy: null, leaseExpiresAt: null,
    } });
    if (await tx.job.count({ where: { runId: run.id, status: "RUNNING" } })) return 0;
    await tx.runSample.updateMany({ where: { runId: run.id, status: { in: ["PENDING", "RUNNING"] } }, data: {
      status: "CANCELLED", completedAt: new Date(),
    } });
    await tx.$executeRaw`
      UPDATE run_tasks t SET pending_samples = 0,
        done_samples = (SELECT count(*)::int FROM run_samples s WHERE s.task_id = t.id AND s.status = 'COMPLETED'),
        failed_samples = (SELECT count(*)::int FROM run_samples s WHERE s.task_id = t.id AND s.status = 'FAILED'),
        status = CASE WHEN t.status IN ('PENDING','RUNNING') THEN 'CANCELLED'::"TaskStatus" ELSE t.status END,
        completed_at = COALESCE(t.completed_at, ${SQL_NOW})
      WHERE t.run_id = ${run.id}`;
    const [doneSamples, failedSamples] = await Promise.all([
      tx.runSample.count({ where: { runId: run.id, status: "COMPLETED" } }),
      tx.runSample.count({ where: { runId: run.id, status: "FAILED" } }),
    ]);
    await tx.run.update({ where: { id: run.id }, data: {
      status: "CANCELLED", completedAt: new Date(), pendingTasks: 0, doneSamples, failedSamples,
    } });
    return 1;
  });
  return closed;
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
