import { logger } from "@/lib/logger";
import { release } from "@/lib/queue/client";
import { LEASE, type JobLease } from "@/lib/queue/types";

/**
 * Graceful stop.
 *
 * A worker that simply dies leaves its jobs holding a lease nobody will renew,
 * and the queue only notices when that lease expires — up to 90 seconds of a
 * run standing still on a deploy. So the last act of a shutdown is to hand the
 * leases back explicitly, and the very last resort is to let the operator force
 * the issue with a second signal.
 */

export interface InFlightJob {
  id: string;
  lease: JobLease;
  controller: AbortController;
  /** Settles when the handler has finished, successfully or not. */
  done: Promise<unknown>;
}

export interface ShutdownHandle {
  stopping(): boolean;
}

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** Time given to an aborted handler to record its own outcome before its lease is taken back. */
const SETTLE_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unreferenced so the timer alone can never hold the process open.
    setTimeout(resolve, ms).unref();
  });
}

function allSettled(jobs: InFlightJob[]): Promise<unknown> {
  return Promise.allSettled(jobs.map((job) => job.done));
}

export function installShutdownHandlers(
  controller: AbortController,
  inFlight: () => InFlightJob[],
  onStopping: () => Promise<void> = async () => undefined
): ShutdownHandle {
  let stopping = false;

  async function drain(): Promise<void> {
    await Promise.race([allSettled(inFlight()), delay(LEASE.shutdownGraceSec * 1000)]);

    const overrunning = inFlight();
    if (overrunning.length > 0) {
      logger.warn("aborting jobs still running at the end of the grace period", {
        count: overrunning.length,
      });
      for (const job of overrunning) job.controller.abort();
      await Promise.race([allSettled(overrunning), delay(SETTLE_MS)]);
    }

    const stranded = inFlight();
    for (const job of stranded) {
      try {
        await release(job.lease);
      } catch (err) {
        logger.error("could not hand back a lease on shutdown", { jobId: job.id, error: err });
      }
    }
    if (stranded.length > 0) {
      logger.info("leases handed back for immediate pickup", { count: stranded.length });
    }
  }

  function onSignal(signal: string): void {
    if (stopping) {
      logger.warn("second signal received, exiting now", { signal });
      process.exit(1);
    }

    stopping = true;
    logger.info("shutdown requested, no longer claiming", {
      signal,
      inFlight: inFlight().length,
      graceSec: LEASE.shutdownGraceSec,
    });
    controller.abort();

    void onStopping().catch((error) => logger.error("could not clear worker health", { error })).then(drain)
      .catch((err) => logger.error("shutdown drain failed", { error: err }))
      .then(() => {
        logger.info("worker stopped");
        process.exit(0);
      });
  }

  for (const signal of SIGNALS) {
    process.on(signal, () => onSignal(signal));
  }

  return { stopping: () => stopping };
}
