import { prisma } from "@/lib/prisma";
import { assertLease, complete, enqueue, fail, LostLease, type QueueDb } from "@/lib/queue/client";
import {
  INTERNAL_PROVIDER_CODE,
  type AggregateRunPayload,
  type JobHandler,
  type RescoreSamplePayload,
} from "@/lib/queue/types";
import { persistSampleAnalysis } from "@/lib/runs/persist";
import { responseSources } from "@/lib/runs/snapshots";
import { logger } from "@/lib/logger";
import { QUERY_CLUSTER_METHOD } from "@/lib/scoring/cluster-stats";

/**
 * Replays one stored answer under a target version. No provider is called: the
 * handler reads the persisted text and re-runs extraction, sentiment and
 * scoring over it. Fresh optional sentiment judgments may still incur a cost.
 */
export const rescoreSampleHandler: JobHandler = async (job, ctx) => {
  const payload = job.payload as RescoreSamplePayload;

  try {
    await prisma.$transaction((tx) => assertLease(tx, job));
    const sample = await prisma.runSample.findUnique({
      where: { id: payload.sampleId },
      select: {
        id: true,
        taskId: true,
        runId: true,
        projectId: true,
        response: { select: { rawText: true, rawJson: true, providerSources: true } },
        task: { select: { mode: true, provider: { select: { code: true } } } },
      },
    });

    // Nothing to replay: a sample that never produced an answer has no evidence
    // a new version could read differently.
    if (!sample?.response) {
      await complete(job);
      return;
    }
    if (sample.runId !== job.runId || sample.taskId !== job.taskId || sample.projectId !== job.projectId) {
      throw new Error("Rescore payload identity does not match its job");
    }

    const project = await prisma.project.findUnique({
      where: { id: sample.projectId },
      select: { userId: true },
    });
    if (!project) {
      await complete(job);
      return;
    }

    // Native citations are the durable record of what the provider actually
    // retrieved. Reading them back preserves grounding evidence across a
    // rescore, where the raw payload's shape is provider-specific and versioned.
    const providerSources = responseSources(sample.response, sample.task.provider.code);

    await persistSampleAnalysis({
      sampleId: sample.id,
      taskId: sample.taskId,
      runId: sample.runId,
      projectId: sample.projectId,
      userId: project.userId,
      mode: sample.task.mode,
      text: sample.response.rawText,
      providerSources,
      scoringVersion: payload.targetScoringVersion,
      extractionVersion: payload.targetExtractionVersion,
      signal: ctx.signal,
      lease: job,
    });

    await prisma.$transaction(async (tx) => {
      await assertLease(tx, job);
      await scheduleAggregationIfComplete(sample, payload.targetScoringVersion, job.id, tx);
      await complete(job, tx);
    });
  } catch (error) {
    if (error instanceof LostLease) return;
    const message = error instanceof Error ? error.message : String(error);
    logger.error("rescore sample job failed", {
      jobId: job.id,
      sampleId: payload.sampleId,
      message,
    });
    await fail(job, { code: "RESCORE", message, retryable: true });
  }
};

/**
 * SampleScore persistence precedes job completion. The run lock serializes this
 * barrier: only the last canonical replay can enqueue promotion, and its own
 * completion commits in the same transaction. Run aggregation rebuilds the task
 * grain too, so no intermediate task job can consume the permanent run key early.
 */
async function scheduleAggregationIfComplete(
  sample: { taskId: string; runId: string; projectId: string },
  scoringVersion: string,
  currentJobId: string,
  tx: QueueDb
): Promise<void> {
  const [runReplayable, runScored] = await Promise.all([
    tx.runSample.count({ where: { runId: sample.runId, status: "COMPLETED" } }),
    tx.sampleScore.count({ where: { runId: sample.runId, scoringVersion, sample: { status: "COMPLETED" } } }),
  ]);
  if (runReplayable === 0 || runScored !== runReplayable) return;
  const unfinishedSiblings = await tx.job.count({ where: {
    runId: sample.runId, kind: "RESCORE_SAMPLE", id: { not: currentJobId },
    dedupeKey: { not: null }, payload: { path: ["targetScoringVersion"], equals: scoringVersion },
    status: { not: "SUCCEEDED" },
  } });
  if (unfinishedSiblings > 0) return;

  const runPayload: AggregateRunPayload = { runId: sample.runId, scoringVersion, promoteVersion: true };
  await enqueue([
    {
      kind: "AGGREGATE_RUN",
      runId: sample.runId,
      projectId: sample.projectId,
      providerCode: INTERNAL_PROVIDER_CODE,
      payload: runPayload,
      dedupeKey: `aggregate-run:${sample.runId}:${scoringVersion}:${QUERY_CLUSTER_METHOD}`,
    },
  ], tx);
}
