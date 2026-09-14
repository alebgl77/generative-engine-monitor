import type { JobKind, SamplingMode } from "@prisma/client";

/**
 * Queue contract.
 *
 * Granularity is one job per RunSample: a sample is exactly one paid API call,
 * so timeout, retry, backoff, rate limiting and cancellation all apply at that
 * natural boundary. Per-task jobs would re-issue calls we already paid for on
 * retry; per-run jobs would give zero parallelism and let one dead key sink
 * everything.
 *
 * Run completion is driven by counters decremented in the same transaction as
 * the result write, never by polling: pendingSamples hits 0 -> AGGREGATE_TASK,
 * pendingTasks hits 0 -> AGGREGATE_RUN.
 */

export interface RunSamplePayload {
  sampleId: string;
  taskId: string;
  runId: string;
  projectId: string;
  queryText: string;
  providerCode: string;
  mode: SamplingMode;
  locale: { country: string; language: string };
  scoringVersion: string;
  extractionVersion: string;
  model?: string;
}

export interface AggregateTaskPayload {
  taskId: string;
  runId: string;
  scoringVersion: string;
  promoteVersion?: boolean;
}

export interface AggregateRunPayload {
  runId: string;
  scoringVersion: string;
  promoteVersion?: boolean;
}

export interface RescoreSamplePayload {
  sampleId: string;
  taskId: string;
  runId: string;
  projectId: string;
  targetScoringVersion: string;
  targetExtractionVersion: string;
}

export type JobPayload =
  | RunSamplePayload
  | AggregateTaskPayload
  | AggregateRunPayload
  | RescoreSamplePayload;

export interface JobLease {
  id: string;
  lockedBy: string;
  leaseVersion: number;
  runId: string | null;
}

export interface ClaimedJob extends JobLease {
  id: string;
  kind: JobKind;
  runId: string | null;
  projectId: string;
  taskId: string | null;
  sampleId: string | null;
  providerCode: string;
  attempts: number;
  maxAttempts: number;
  payload: JobPayload;
}

export interface JobContext {
  /** Aborted on shutdown, lease loss, or run cancellation. */
  signal: AbortSignal;
  workerId: string;
}

export type JobHandler = (job: ClaimedJob, ctx: JobContext) => Promise<void>;

/** Aggregate jobs are not provider-bound; this keeps the claim query uniform. */
export const INTERNAL_PROVIDER_CODE = "internal";

/**
 * Retry policy. A throttle is NOT a failure: when the token bucket refuses, the
 * job is requeued with its attempt counter rolled back, so rate limiting never
 * eats the retry budget meant for real errors.
 */
export const RETRY = {
  maxAttempts: 4,
  baseDelaySec: 5,
  maxDelaySec: 600,
  /** Multiplied by U(0.5, 1.5) to avoid a thundering herd after an outage. */
  jitter: 0.5,
} as const;

export const LEASE = {
  durationSec: 90,
  heartbeatSec: 25,
  sweepIntervalSec: 30,
  /** Time allowed for in-flight jobs to finish on SIGTERM before leases are released. */
  shutdownGraceSec: 25,
} as const;

export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(RETRY.maxDelaySec, RETRY.baseDelaySec * 2 ** attempt);
  const factor = 1 - RETRY.jitter + random() * (RETRY.jitter * 2);
  return Math.round(exponential * factor);
}
