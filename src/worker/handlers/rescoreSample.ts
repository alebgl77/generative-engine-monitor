import { prisma } from "@/lib/prisma";
import { complete, enqueue, fail } from "@/lib/queue/client";
import {
  INTERNAL_PROVIDER_CODE,
  type AggregateRunPayload,
  type AggregateTaskPayload,
  type JobHandler,
  type RescoreSamplePayload,
} from "@/lib/queue/types";
import { persistSampleAnalysis } from "@/lib/runs/persist";
import type { ProviderSource } from "@/lib/providers/types";
import { logger } from "@/lib/logger";

/**
 * Replays one stored answer under a target version. No provider is called: the
 * handler reads the persisted text and re-runs extraction, sentiment and
 * scoring over it, which is what makes a version migration free.
 */
export const rescoreSampleHandler: JobHandler = async (job, ctx) => {
  const payload = job.payload as RescoreSamplePayload;

  try {
    const sample = await prisma.runSample.findUnique({
      where: { id: payload.sampleId },
      select: {
        id: true,
        taskId: true,
        runId: true,
        projectId: true,
        response: { select: { rawText: true } },
        task: { select: { mode: true } },
      },
    });

    // Nothing to replay: a sample that never produced an answer has no evidence
    // a new version could read differently.
    if (!sample?.response) {
      await complete(job.id);
      return;
    }

    const project = await prisma.project.findUnique({
      where: { id: sample.projectId },
      select: { userId: true },
    });
    if (!project) {
      await complete(job.id);
      return;
    }

    // Native citations are the durable record of what the provider actually
    // retrieved. Reading them back preserves grounding evidence across a
    // rescore, where the raw payload's shape is provider-specific and versioned.
    const nativeCitations = await prisma.citation.findMany({
      where: { sampleId: sample.id, sourceKind: "NATIVE" },
      select: { url: true, title: true, normalizedUrl: true, position: true },
      orderBy: [{ position: "asc" }, { normalizedUrl: "asc" }],
    });

    const seen = new Set<string>();
    const providerSources: ProviderSource[] = [];
    for (const citation of nativeCitations) {
      if (seen.has(citation.normalizedUrl)) continue;
      seen.add(citation.normalizedUrl);
      providerSources.push({
        url: citation.url,
        title: citation.title ?? undefined,
        kind: "NATIVE",
      });
    }

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
    });

    await scheduleAggregationIfComplete(sample, payload.targetScoringVersion);
    await complete(job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("rescore sample job failed", {
      jobId: job.id,
      sampleId: payload.sampleId,
      message,
    });
    await fail(job.id, { code: "RESCORE", message, retryable: true });
  }
};

/**
 * Progress is measured rather than counted down: a replay has no dedicated
 * counter, and comparing scored samples to replayable ones is self-healing if a
 * job is retried. A tie between two workers enqueues the aggregation twice,
 * which is harmless — it is idempotent and guarded against re-finalising a run.
 */
async function scheduleAggregationIfComplete(
  sample: { taskId: string; runId: string; projectId: string },
  scoringVersion: string
): Promise<void> {
  const [taskReplayable, taskScored] = await Promise.all([
    prisma.runSample.count({ where: { taskId: sample.taskId, response: { isNot: null } } }),
    prisma.sampleScore.count({ where: { taskId: sample.taskId, scoringVersion } }),
  ]);
  if (taskScored < taskReplayable) return;

  const taskPayload: AggregateTaskPayload = {
    taskId: sample.taskId,
    runId: sample.runId,
    scoringVersion,
  };
  await enqueue([
    {
      kind: "AGGREGATE_TASK",
      runId: sample.runId,
      projectId: sample.projectId,
      taskId: sample.taskId,
      providerCode: INTERNAL_PROVIDER_CODE,
      payload: taskPayload,
    },
  ]);

  const [runReplayable, runScored] = await Promise.all([
    prisma.runSample.count({ where: { runId: sample.runId, response: { isNot: null } } }),
    prisma.sampleScore.count({ where: { runId: sample.runId, scoringVersion } }),
  ]);
  if (runScored < runReplayable) return;

  const runPayload: AggregateRunPayload = { runId: sample.runId, scoringVersion };
  await enqueue([
    {
      kind: "AGGREGATE_RUN",
      runId: sample.runId,
      projectId: sample.projectId,
      providerCode: INTERNAL_PROVIDER_CODE,
      payload: runPayload,
    },
  ]);
}
