import { Prisma } from "@prisma/client";
import type { JobKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  LEASE,
  RETRY,
  backoffSeconds,
  type ClaimedJob,
  type JobPayload,
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
export const SQL_NOW = Prisma.sql`(now() AT TIME ZONE 'utc')`;

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
  alive: string[];
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
export async function heartbeat(jobIds: string[], workerId: string): Promise<HeartbeatResult> {
  if (jobIds.length === 0) return { alive: [], cancelled: [] };

  const rows = await prisma.$queryRaw<{ id: string; cancelled: boolean }[]>`
    UPDATE jobs j
       SET lease_expires_at = ${SQL_NOW} + make_interval(secs => ${LEASE.durationSec}::double precision),
           heartbeat_at = ${SQL_NOW},
           updated_at = ${SQL_NOW}
      FROM jobs cur
      LEFT JOIN runs r ON r.id = cur.run_id
     WHERE cur.id = j.id
       AND j.id = ANY(${jobIds}::text[])
       AND j.locked_by = ${workerId}
       AND j.status = 'RUNNING'::"JobStatus"
    RETURNING j.id AS id, (r.cancel_requested_at IS NOT NULL) AS cancelled`;

  return {
    alive: rows.map((row) => row.id),
    cancelled: rows.filter((row) => row.cancelled).map((row) => row.id),
  };
}

export async function complete(jobId: string, tx?: QueueDb): Promise<void> {
  const db: QueueDb = tx ?? prisma;
  await db.job.updateMany({
    where: { id: jobId },
    data: {
      status: "SUCCEEDED",
      completedAt: new Date(),
      lockedBy: null,
      leaseExpiresAt: null,
    },
  });
}

/**
 * Terminal or retried, depending on the classification of the error and on the
 * remaining attempt budget. `attempts` was already incremented by `claim`, so
 * the comparison counts the attempt that just failed.
 */
export async function fail(jobId: string, err: JobFailure): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { attempts: true, maxAttempts: true },
  });
  if (!job) return;

  const willRetry = err.retryable && job.attempts < job.maxAttempts;
  const lastError = truncateError(err.message);
  const now = new Date();

  if (!willRetry) {
    // Guarded on RUNNING so a job the sweeper already recovered is not
    // clobbered by the late verdict of a worker that lost its lease.
    await prisma.job.updateMany({
      where: { id: jobId, status: "RUNNING" },
      data: {
        status: "FAILED",
        completedAt: now,
        lastError,
        lastErrorCode: err.code,
        lockedBy: null,
        leaseExpiresAt: null,
      },
    });
    return;
  }

  const delaySec = Math.max(0, err.retryAfterSec ?? backoffSeconds(job.attempts));
  await prisma.job.updateMany({
    where: { id: jobId, status: "RUNNING" },
    data: {
      status: "QUEUED",
      availableAt: new Date(now.getTime() + delaySec * 1000),
      lastError,
      lastErrorCode: err.code,
      lockedBy: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    },
  });
}

/**
 * Requeues immediately and gives the attempt back. Shutdown and throttling are
 * not failures: they must never consume the retry budget meant for real errors.
 */
export async function release(jobId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE jobs
       SET status = 'QUEUED'::"JobStatus",
           available_at = ${SQL_NOW},
           attempts = GREATEST(attempts - 1, 0),
           locked_by = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           updated_at = ${SQL_NOW}
     WHERE id = ${jobId}
       AND status = 'RUNNING'::"JobStatus"`;
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
