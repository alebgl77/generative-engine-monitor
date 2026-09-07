import { fail, LostLease } from "@/lib/queue/client";
import type { AggregateRunPayload, JobHandler } from "@/lib/queue/types";
import { aggregateRun } from "@/lib/scoring/aggregate";
import { logger } from "@/lib/logger";

export const aggregateRunHandler: JobHandler = async (job) => {
  const payload = job.payload as AggregateRunPayload;

  try {
    await aggregateRun(payload.runId, payload.scoringVersion, job, payload.promoteVersion === true);
  } catch (error) {
    if (error instanceof LostLease) return;
    const message = error instanceof Error ? error.message : String(error);
    logger.error("aggregate run job failed", { jobId: job.id, runId: payload.runId, message });
    await fail(job, { code: "AGGREGATE", message, retryable: true });
  }
};
