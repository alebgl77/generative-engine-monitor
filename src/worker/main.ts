import "dotenv/config";

import os from "node:os";

import type { JobKind } from "@prisma/client";

import { getEnv } from "@/lib/env";
import { codeFromThrown, isRetryable } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getAllProviders } from "@/lib/providers/registry";
import { claim, fail, heartbeat, LostLease } from "@/lib/queue/client";
import { Semaphore, bucketKeyForProvider, ensureBucket } from "@/lib/queue/ratelimit";
import { runSweep } from "@/lib/queue/sweeper";
import { INTERNAL_PROVIDER_CODE, LEASE, type ClaimedJob, type JobHandler } from "@/lib/queue/types";
import { aggregateRunHandler } from "@/worker/handlers/aggregateRun";
import { aggregateTaskHandler } from "@/worker/handlers/aggregateTask";
import { rescoreSampleHandler } from "@/worker/handlers/rescoreSample";
import { runSampleHandler, failSampleJob } from "@/worker/handlers/runSample";
import { installShutdownHandlers, type InFlightJob } from "@/worker/shutdown";
import { applyHeartbeat, claimKey, forgetClaim } from "@/worker/inflight";
import { clearWorkerHealth, recordWorkerHealthy } from "@/worker/health";

/**
 * Worker entry point.
 *
 * The loop only ever claims what it can immediately run: a per-provider
 * semaphore sized from the database bounds concurrency inside this process,
 * while the shared token bucket bounds the rate across all of them. Everything
 * else — retries, cancellation, recovery — belongs to the queue, so a worker can
 * be killed at any instant without the run losing its place.
 */

const HANDLERS: Record<JobKind, JobHandler> = {
  RUN_SAMPLE: runSampleHandler,
  AGGREGATE_TASK: aggregateTaskHandler,
  AGGREGATE_RUN: aggregateRunHandler,
  RESCORE_SAMPLE: rescoreSampleHandler,
};

/** Aggregate jobs are database-only; this bounds them without a provider limit. */
const INTERNAL_CONCURRENCY = 4;
const IDLE_SLEEP_MS = 1_000;
const BUSY_SLEEP_MS = 200;
/**
 * Floor between two claim rounds. A throttled job is requeued immediately and
 * without penalty, which is correct but would otherwise let a rate-limited
 * provider turn the loop into a claim/release spin against the database.
 */
const CLAIM_PACE_MS = 50;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function logResolvedModels(): void {
  const env = getEnv();
  logger.info("resolved models", {
    providers: getAllProviders().map((provider) => ({
      code: provider.code,
      model: provider.defaultModel(),
    })),
    sentimentJudge: {
      enabled: env.SENTIMENT_ENABLED,
      provider: env.SENTIMENT_JUDGE_PROVIDER,
      model: env.SENTIMENT_JUDGE_MODEL,
    },
  });
}

/**
 * One semaphore and one token bucket per provider row. The bucket is created
 * here because a missing bucket fails closed: without it every job for that
 * provider would be requeued forever.
 */
async function buildLimits(): Promise<Map<string, Semaphore>> {
  const providers = await prisma.provider.findMany({
    select: { code: true, rpmLimit: true, maxConcurrency: true },
  });

  const semaphores = new Map<string, Semaphore>();
  for (const provider of providers) {
    const rpm = Math.max(1, provider.rpmLimit);
    semaphores.set(provider.code, new Semaphore(Math.max(1, provider.maxConcurrency)));
    await ensureBucket(bucketKeyForProvider(provider.code), rpm, rpm / 60);
  }
  semaphores.set(INTERNAL_PROVIDER_CODE, new Semaphore(INTERNAL_CONCURRENCY));

  return semaphores;
}

async function beat(inFlight: Map<string, InFlightJob>): Promise<void> {
  const entries = Array.from(inFlight.values());
  if (entries.length === 0) return;

  try {
    applyHeartbeat(entries, await heartbeat(entries.map((entry) => entry.lease)));
  } catch (err) {
    // A blip on the heartbeat is not proof the lease is gone; the sweeper is the
    // authority on that, so nothing is aborted here.
    logger.error("heartbeat failed", { error: err });
  }
}

async function sweep(): Promise<void> {
  try {
    const summary = await runSweep();
    if (summary.requeued || summary.dead || summary.orphanSamples || summary.cancelledRuns) {
      logger.info("sweep recovered work", { ...summary });
    }
  } catch (err) {
    logger.error("sweep failed", { error: err });
  }
}

async function markHealthy(): Promise<void> {
  try { await recordWorkerHealthy(); }
  catch (error) { logger.error("worker health file update failed", { error }); }
}

async function main(): Promise<void> {
  await clearWorkerHealth();
  const env = getEnv();
  const workerId = env.WORKER_ID || `${os.hostname()}-${process.pid}`;

  logger.info("worker starting", { workerId, batchSize: env.WORKER_BATCH_SIZE });
  logResolvedModels();

  const semaphores = await buildLimits();
  const internal = semaphores.get(INTERNAL_PROVIDER_CODE) as Semaphore;

  logger.info("startup sweep", { ...(await runSweep()) });

  const loop = new AbortController();
  const inFlight = new Map<string, InFlightJob>();
  const shutdown = installShutdownHandlers(loop, () => Array.from(inFlight.values()), clearWorkerHealth);

  const heartbeatTimer = setInterval(() => void beat(inFlight), LEASE.heartbeatSec * 1000);
  const sweepTimer = setInterval(() => void sweep(), LEASE.sweepIntervalSec * 1000);

  function dispatch(job: ClaimedJob): void {
    const controller = new AbortController();
    const semaphore = semaphores.get(job.providerCode) ?? internal;
    const entry: InFlightJob = { id: job.id, lease: job, controller, done: Promise.resolve() };
    inFlight.set(claimKey(job), entry);

    entry.done = semaphore
      .run(async () => {
        try {
          await HANDLERS[job.kind](job, { signal: controller.signal, workerId });
        } catch (err) {
          if (err instanceof LostLease) return;
          logger.error("job handler threw", { jobId: job.id, kind: job.kind, error: err });
          await (job.kind === "RUN_SAMPLE" ? failSampleJob : fail)(job, {
            code: codeFromThrown(err),
            message: err instanceof Error ? err.message : String(err),
            retryable: isRetryable(err),
          });
        }
      })
      .catch((err) => logger.error("job could not be closed", { jobId: job.id, error: err }))
      .finally(() => {
        forgetClaim(inFlight, entry);
      });
  }

  try {
    while (!shutdown.stopping()) {
      const free = Array.from(semaphores.entries()).filter(([, semaphore]) => semaphore.free > 0);
      if (free.length === 0) {
        try {
          await prisma.$queryRaw`SELECT 1`;
          if (!shutdown.stopping()) await markHealthy();
        } catch (error) {
          logger.error("worker liveness probe failed", { error });
        }
        await sleep(BUSY_SLEEP_MS, loop.signal);
        continue;
      }

      const capacity = free.reduce((total, [, semaphore]) => total + semaphore.free, 0);

      let jobs: ClaimedJob[];
      try {
        jobs = await claim({
          workerId,
          providerCodes: free.map(([code]) => code),
          limit: Math.min(env.WORKER_BATCH_SIZE, capacity),
        });
        if (!shutdown.stopping()) await markHealthy();
      } catch (err) {
        logger.error("claim failed", { error: err });
        await sleep(IDLE_SLEEP_MS, loop.signal);
        continue;
      }

      if (jobs.length === 0) {
        await sleep(IDLE_SLEEP_MS, loop.signal);
        continue;
      }

      for (const job of jobs) dispatch(job);
      await sleep(CLAIM_PACE_MS, loop.signal);
    }
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(sweepTimer);
  }
}

main().catch((err) => {
  logger.error("worker stopped on an unrecoverable error", { error: err });
  process.exit(1);
});
