import type { Prisma } from "@prisma/client";
import { SQL_NOW, enqueue } from "@/lib/queue/client";
import { INTERNAL_PROVIDER_CODE } from "@/lib/queue/types";
import { QUERY_CLUSTER_METHOD } from "@/lib/scoring/cluster-stats";

interface FinalizeInput {
  sampleId: string; taskId: string; runId: string; projectId: string;
  scoringVersion: string; succeeded: boolean; errorCode?: string; errorMessage?: string;
}

/** The guarded sample status transition owns every counter. Caller holds the job lease. */
export async function finalizeSample(tx: Prisma.TransactionClient, input: FinalizeInput): Promise<boolean> {
  const status = input.succeeded ? "COMPLETED" : "FAILED";
  const changed = await tx.$queryRaw<{ id: string }[]>`
    UPDATE run_samples SET status = ${status}::"SampleStatus",
      error_code = ${input.errorCode ?? null}::text,
      error_message = ${input.errorMessage?.slice(0, 1000) ?? null}::text, completed_at = ${SQL_NOW}
    WHERE id = ${input.sampleId} AND status IN ('PENDING'::"SampleStatus", 'RUNNING'::"SampleStatus")
    RETURNING id`;
  if (!changed.length) return false;
  const task = await tx.runTask.update({ where: { id: input.taskId }, data: {
    pendingSamples: { decrement: 1 },
    ...(input.succeeded ? { doneSamples: { increment: 1 } } : { failedSamples: { increment: 1 } }),
  } });
  await tx.run.update({ where: { id: input.runId }, data:
    input.succeeded ? { doneSamples: { increment: 1 } } : { failedSamples: { increment: 1 } },
  });
  if (task.pendingSamples === 0) await enqueue([{
    kind: "AGGREGATE_TASK", runId: input.runId, projectId: input.projectId,
    taskId: input.taskId, providerCode: INTERNAL_PROVIDER_CODE, priority: 10,
    dedupeKey: `aggregate-task:${input.taskId}:${input.scoringVersion}:${QUERY_CLUSTER_METHOD}`,
    payload: { taskId: input.taskId, runId: input.runId, scoringVersion: input.scoringVersion },
  }], tx);
  return true;
}
