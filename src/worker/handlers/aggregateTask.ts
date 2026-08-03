import { complete, fail } from "@/lib/queue/client";
import type { AggregateTaskPayload, JobHandler } from "@/lib/queue/types";
import { aggregateTask } from "@/lib/scoring/aggregate";
import { logger } from "@/lib/logger";

/**
 * Aggregation reads rows that were already paid for, so a retry costs nothing
 * but a little CPU — every failure here is worth retrying.
 */
export const aggregateTaskHandler: JobHandler = async (job) => {
  const payload = job.payload as AggregateTaskPayload;

  try {
    await aggregateTask(payload.taskId, payload.scoringVersion);
    await complete(job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("aggregate task job failed", { jobId: job.id, taskId: payload.taskId, message });
    await fail(job.id, { code: "AGGREGATE", message, retryable: true });
  }
};
