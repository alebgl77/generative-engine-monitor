import type { RunStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { enqueue, type EnqueueJobInput } from "@/lib/queue/client";
import { INTERNAL_PROVIDER_CODE, type RescoreSamplePayload } from "@/lib/queue/types";
import { getScoringVersion, listScoringVersions } from "@/lib/scoring/registry";
import type { ScoringVersion } from "@/lib/scoring/types";
import { badRequest, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Replay: re-derives evidence and scores from answers already paid for.
 *
 * The work goes through the job queue instead of a loop so that a replay of ten
 * thousand samples inherits the throttling, retries and progress reporting of a
 * live run — and can be cancelled the same way. No provider is ever called: the
 * stored answer text is the only input.
 */

export interface RescoreResult {
  jobs: number;
}

/** Enqueued in slices so a large replay never builds one oversized statement. */
const ENQUEUE_CHUNK = 500;

/**
 * A run still producing samples is off limits: replaying a fraction of its
 * answers would aggregate the run early and publish a distribution built from
 * part of what was paid for.
 */
export const IN_FLIGHT_RUN_STATUSES: readonly RunStatus[] = [
  "PENDING",
  "RUNNING",
  "CANCELLING",
];

function resolveTarget(version: string): ScoringVersion {
  try {
    return getScoringVersion(version);
  } catch {
    throw badRequest(
      `Version de scoring inconnue : « ${version} ». Versions disponibles : ${listScoringVersions().join(", ")}.`
    );
  }
}

interface ReplayableSample {
  id: string;
  taskId: string;
  runId: string;
  projectId: string;
}

async function enqueueReplay(
  samples: ReplayableSample[],
  target: ScoringVersion
): Promise<number> {
  let enqueued = 0;

  for (let offset = 0; offset < samples.length; offset += ENQUEUE_CHUNK) {
    const slice = samples.slice(offset, offset + ENQUEUE_CHUNK);
    const jobs: EnqueueJobInput[] = slice.map((sample) => {
      const payload: RescoreSamplePayload = {
        sampleId: sample.id,
        taskId: sample.taskId,
        runId: sample.runId,
        projectId: sample.projectId,
        targetScoringVersion: target.version,
        targetExtractionVersion: target.extractionVersion,
      };
      return {
        kind: "RESCORE_SAMPLE",
        runId: sample.runId,
        projectId: sample.projectId,
        taskId: sample.taskId,
        // Deliberately not set on the row: `sampleId` is unique across jobs, and
        // the RUN_SAMPLE job that produced this answer already holds it.
        sampleId: null,
        providerCode: INTERNAL_PROVIDER_CODE,
        payload,
      };
    });
    enqueued += await enqueue(jobs);
  }

  return enqueued;
}

export async function rescoreRun(
  runId: string,
  targetScoringVersion: string
): Promise<RescoreResult> {
  const target = resolveTarget(targetScoringVersion);

  const run = await prisma.run.findUnique({ where: { id: runId }, select: { id: true } });
  if (!run) throw notFound("Analyse");

  const samples = await prisma.runSample.findMany({
    where: { runId, response: { isNot: null } },
    select: { id: true, taskId: true, runId: true, projectId: true },
    orderBy: { id: "asc" },
  });

  const jobs = await enqueueReplay(samples, target);
  logger.info("run rescore enqueued", { runId, scoringVersion: target.version, jobs });

  return { jobs };
}

export async function rescoreProject(
  projectId: string,
  targetScoringVersion: string
): Promise<RescoreResult> {
  const target = resolveTarget(targetScoringVersion);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound("Projet");

  const samples = await prisma.runSample.findMany({
    where: {
      projectId,
      response: { isNot: null },
      task: { run: { status: { notIn: [...IN_FLIGHT_RUN_STATUSES] } } },
    },
    select: { id: true, taskId: true, runId: true, projectId: true },
    orderBy: { id: "asc" },
  });

  const jobs = await enqueueReplay(samples, target);
  logger.info("project rescore enqueued", { projectId, scoringVersion: target.version, jobs });

  return { jobs };
}

/**
 * Makes a version the one the project's dashboards read. Promotion is separate
 * from replay on purpose: a version is only worth promoting once the scores it
 * produces exist.
 */
export async function promoteScoringVersion(projectId: string, version: string): Promise<void> {
  const target = resolveTarget(version);

  const updated = await prisma.project.updateMany({
    where: { id: projectId },
    data: { activeScoringVersion: target.version },
  });
  if (updated.count === 0) throw notFound("Projet");

  logger.info("scoring version promoted", { projectId, version: target.version });
}
