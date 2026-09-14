import { Prisma } from "@prisma/client";
import type { JobKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  LEASE,
  RETRY,
  backoffSeconds,
  type ClaimedJob,
  type JobPayload,
  type JobLease,
} from "@/lib/queue/types";

/**
 * Durable job queue on PostgreSQL.
 *
 * Claiming is a single `FOR UPDATE SKIP LOCKED` statement: concurrent workers
 * take disjoint batches without blocking each other, and a claim is only ever
 * held under a heartbeat lease, so a worker that dies releases its jobs to the
 * sweeper instead of stranding them.
 */

/**
 * Prisma stores `DateTime` in `timestamp(3)` columns holding UTC wall clock.
 * Raw SQL must therefore compare against UTC rather than `now()`, whose
 * implicit cast to `timestamp` would use the session time zone and shift every
 * lease and backoff by the server's offset.
 */
export const SQL_NOW = Prisma.sql`(clock_timestamp() AT TIME ZONE 'utc')`;

/** Accepts the client or an interactive transaction client interchangeably. */
export type QueueDb = Prisma.TransactionClient;

export interface EnqueueJobInput {
  kind: JobKind;
  runId?: string | null;
  projectId: string;
  taskId?: string | null;
  sampleId?: string | null;
  providerCode: string;
  priority?: number;
  availableAt?: Date;
  payload: JobPayload;
  dedupeKey?: string;
}

export interface JobFailure {
  code: string;
  message: string;
  retryable: boolean;
  /** Honoured over the computed backoff when the provider sent a Retry-After. */
  retryAfterSec?: number;
}

export interface HeartbeatResult {
  /** Jobs still owned by this worker; includes the cancelled ones. */
  alive: { id: string; leaseVersion: number }[];
  /** Subset of `alive` whose run has a cancellation request pending. */
  cancelled: string[];
}

const MAX_ERROR_CHARS = 1000;

function truncateError(message: string): string {
  return message.length > MAX_ERROR_CHARS ? message.slice(0, MAX_ERROR_CHARS) : message;
}

interface ClaimedJobRow {
  id: string;
  kind: JobKind;
  run_id: string | null;
  project_id: string;
  task_id: string | null;
  sample_id: string | null;
  provider_code: string;
  attempts: number;
  max_attempts: number;
  locked_by: string;
  lease_version: number;
  payload: JobPayload;
}

function toClaimedJob(row: ClaimedJobRow): ClaimedJob {
  return {
    id: row.id,
    kind: row.kind,
    runId: row.run_id,
    projectId: row.project_id,
    taskId: row.task_id,
    sampleId: row.sample_id,
    providerCode: row.provider_code,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lockedBy: row.locked_by,
    leaseVersion: row.lease_version,
    payload: row.payload,
  };
}

/**
 * Bulk insert. The unique `sample_id` column makes RUN_SAMPLE enqueue
 * idempotent: a replanned or retried planning pass re-inserts the same rows and
 * the conflicting ones are skipped rather than duplicating paid API calls.
 */
export async function enqueue(jobs: EnqueueJobInput[], tx?: QueueDb): Promise<number> {
  if (jobs.length === 0) return 0;
  const db: QueueDb = tx ?? prisma;

  const result = await db.job.createMany({
    data: jobs.map((job) => ({
      kind: job.kind,
      runId: job.runId ?? null,
      projectId: job.projectId,
      taskId: job.taskId ?? null,
      sampleId: job.sampleId ?? null,
      providerCode: job.providerCode,
      priority: job.priority ?? 0,
      availableAt: job.availableAt ?? new Date(),
      maxAttempts: RETRY.maxAttempts,
      dedupeKey: job.dedupeKey ?? null,
      payload: job.payload as unknown as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });

  return result.count;
}

export async function claim(opts: {
  workerId: string;
  providerCodes: string[];
  limit: number;
}): Promise<ClaimedJob[]> {
  if (opts.providerCodes.length === 0 || opts.limit <= 0) return [];

  const rows = await prisma.$queryRaw<ClaimedJobRow[]>`
    WITH candidate AS (
      SELECT id FROM jobs
      WHERE status = 'QUEUED'::"JobStatus"
        AND available_at <= ${SQL_NOW}
        AND provider_code = ANY(${opts.providerCodes}::text[])
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = jobs.run_id AND r.cancel_requested_at IS NOT NULL)
      ORDER BY priority DESC, available_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${opts.limit}
    )
    UPDATE jobs j
       SET status = 'RUNNING'::"JobStatus",
           locked_by = ${opts.workerId},
           lease_expires_at = ${SQL_NOW} + make_interval(secs => ${LEASE.durationSec}::double precision),
           heartbeat_at = ${SQL_NOW},
           attempts = j.attempts + 1,
           lease_version = j.lease_version + 1,
           updated_at = ${SQL_NOW}
      FROM candidate c
     WHERE j.id = c.id
    RETURNING j.*`;

  return rows.map(toClaimedJob);
}

/**
 * Extends the lease of the jobs still owned by this worker and reports, in the
 * same round trip, which of them belong to a run the user asked to cancel.
 * Liveness and cancellation are the same question for a worker, so they cost
 * one statement, not two.
 */
export async function heartbeat(leases: JobLease[]): Promise<HeartbeatResult> {
  if (leases.length === 0) return { alive: [], cancelled: [] };
  const owners = Prisma.join(leases.map((lease) => Prisma.sql`(j.id = ${lease.id} AND j.locked_by = ${lease.lockedBy} AND j.lease_version = ${lease.leaseVersion})`), " OR ");

  const rows = await prisma.$queryRaw<{ id: string; lease_version: number; cancelled: boolean }[]>`
    UPDATE jobs j
       SET lease_expires_at = ${SQL_NOW} + make_interval(secs => ${LEASE.durationSec}::double precision),
           heartbeat_at = ${SQL_NOW},
           updated_at = ${SQL_NOW}
      FROM jobs cur
      LEFT JOIN runs r ON r.id = cur.run_id
     WHERE cur.id = j.id
       AND (${owners})
       AND j.status = 'RUNNING'::"JobStatus"
       AND j.lease_expires_at > ${SQL_NOW}
    RETURNING j.id AS id, j.lease_version, (r.cancel_requested_at IS NOT NULL) AS cancelled`;

  return {
    alive: rows.map((row) => ({ id: row.id, leaseVersion: row.lease_version })),
    cancelled: rows.filter((row) => row.cancelled).map((row) => row.id),
  };
}

export class LostLease extends Error {
  constructor(public readonly jobId: string) {
    super(`Job lease no longer owned: ${jobId}`);
    this.name = "LostLease";
  }
}

/** Lock order is run -> job, matching cancellation. No network inside this transaction. */
export async function assertLease(tx: QueueDb, lease: JobLease, allowCancelled = false): Promise<void> {
  if (lease.runId) {
    const runs = await tx.$queryRaw<{ cancel_requested_at: Date | null }[]>`
      SELECT cancel_requested_at FROM runs WHERE id = ${lease.runId} FOR UPDATE`;
    if (!runs.length || (!allowCancelled && runs[0].cancel_requested_at)) throw new LostLease(lease.id);
  }
  const owned = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM jobs
    WHERE id = ${lease.id} AND locked_by = ${lease.lockedBy}
      AND lease_version = ${lease.leaseVersion} AND status = 'RUNNING'::"JobStatus"
      AND lease_expires_at > ${SQL_NOW}
    FOR UPDATE`;
  if (owned.length !== 1) throw new LostLease(lease.id);
}

export async function complete(lease: JobLease, tx?: QueueDb): Promise<void> {
  if (!tx) return prisma.$transaction((db) => complete(lease, db));
  await assertLease(tx, lease);
  await tx.job.update({ where: { id: lease.id }, data: {
    status: "SUCCEEDED", completedAt: new Date(), lockedBy: null, leaseExpiresAt: null,
  } });
}

/**
 * Terminal or retried, depending on the classification of the error and on the
 * remaining attempt budget. `attempts` was already incremented by `claim`, so
 * the comparison counts the attempt that just failed.
 */
export async function fail(
  lease: JobLease,
  err: JobFailure,
  onExhausted?: (tx: QueueDb) => Promise<unknown>
): Promise<"requeued" | "exhausted" | "lost"> {
  try {
    return await prisma.$transaction(async (tx) => {
      await assertLease(tx, lease);
      const job = await tx.job.findUniqueOrThrow({ where: { id: lease.id } });
      const willRetry = err.retryable && job.attempts < job.maxAttempts;
      if (!willRetry && onExhausted) await onExhausted(tx);
      // Recheck at the end as expiry may have elapsed while the terminal callback ran.
      await assertLease(tx, lease);
      const now = new Date();
      const delaySec = Math.max(0, err.retryAfterSec ?? backoffSeconds(job.attempts));
      await tx.job.update({ where: { id: lease.id }, data: {
        status: willRetry ? "QUEUED" : "FAILED",
        completedAt: willRetry ? null : now,
        ...(willRetry ? { availableAt: new Date(now.getTime() + delaySec * 1000) } : {}),
        lastError: truncateError(err.message), lastErrorCode: err.code,
        lockedBy: null, leaseExpiresAt: null, heartbeatAt: null,
      } });
      return willRetry ? "requeued" : "exhausted";
    });
  } catch (error) {
    if (error instanceof LostLease) return "lost";
    throw error;
  }
}

/**
 * Requeues immediately and gives the attempt back. Shutdown and throttling are
 * not failures: they must never consume the retry budget meant for real errors.
 */
export async function release(lease: JobLease): Promise<void> {
  const changed = await prisma.$executeRaw`
    UPDATE jobs
       SET status = 'QUEUED'::"JobStatus",
           available_at = ${SQL_NOW},
           attempts = GREATEST(attempts - 1, 0),
           locked_by = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           updated_at = ${SQL_NOW}
     WHERE id = ${lease.id}
       AND locked_by = ${lease.lockedBy} AND lease_version = ${lease.leaseVersion}
       AND status = 'RUNNING'::"JobStatus" AND lease_expires_at > ${SQL_NOW}`;
  if (changed !== 1) throw new LostLease(lease.id);
}

/**
 * RUNNING jobs are deliberately left alone: they hold a paid call in flight and
 * learn about the cancellation from their next heartbeat, which lets them abort
 * and record the outcome themselves.
 */
export async function cancelRunJobs(runId: string, tx?: QueueDb): Promise<number> {
  const db: QueueDb = tx ?? prisma;
  const result = await db.job.updateMany({
    where: { runId, status: "QUEUED" },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  return result.count;
}
