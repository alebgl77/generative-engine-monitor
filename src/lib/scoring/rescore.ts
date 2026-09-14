import type { Prisma, RunStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueue } from "@/lib/queue/client";
import { INTERNAL_PROVIDER_CODE, type RescoreSamplePayload } from "@/lib/queue/types";
import { getScoringVersion, listScoringVersions } from "@/lib/scoring/registry";
import type { ScoringVersion } from "@/lib/scoring/types";
import { AppError, badRequest, notFound, tooManyRequests } from "@/lib/errors";
import { assertRunAllowance, getRunLimits, lockRunOwner } from "@/lib/runs/limits";
import { QUERY_CLUSTER_METHOD } from "@/lib/scoring/cluster-stats";

export interface RescoreResult {
  jobs: number;
  aggregateJobs: number;
  eligible: number;
  alreadyScheduled: number;
  excludedAnalysisFailed: number;
  skippedCancelledRuns: number;
  promoted: boolean;
}
export const IN_FLIGHT_RUN_STATUSES: readonly RunStatus[] = ["PENDING", "RUNNING", "CANCELLING"];

function resolveTarget(version: string): ScoringVersion {
  try { return getScoringVersion(version); }
  catch { throw badRequest(`Version de scoring inconnue : « ${version} ». Versions disponibles : ${listScoringVersions().join(", ")}.`); }
}

async function scheduleReplay(projectId: string, runId: string | undefined, target: ScoringVersion): Promise<RescoreResult> {
  const owner = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } });
  if (!owner) throw notFound("Projet");
  return prisma.$transaction(async (tx) => {
    await lockRunOwner(tx, owner.userId);
    if (runId) {
      const run = await tx.run.findFirst({ where: { id: runId, projectId }, select: { status: true, cancelRequestedAt: true } });
      if (!run) throw notFound("Analyse");
      if (IN_FLIGHT_RUN_STATUSES.includes(run.status)) throw badRequest("Cette analyse est encore en cours.");
      if (run.status === "CANCELLED" || run.cancelRequestedAt) {
        throw new AppError(409, "Analyse annulée : replay exclu ; les compteurs historiques restent inchangés.");
      }
    }
    const eligibleRun = { status: { notIn: [...IN_FLIGHT_RUN_STATUSES, "CANCELLED" as const] }, cancelRequestedAt: null };
    const where: Prisma.RunSampleWhereInput = {
      projectId, ...(runId ? { runId } : {}), status: "COMPLETED", response: { isNot: null },
      task: { run: eligibleRun }, scores: { none: { scoringVersion: target.version } },
    };
    const [eligible, excludedAnalysisFailed, skippedCancelledRuns] = await Promise.all([
      tx.runSample.count({ where }),
      tx.runSample.count({ where: { projectId, ...(runId ? { runId } : {}), status: "FAILED", response: { isNot: null } } }),
      tx.run.count({ where: { projectId, ...(runId ? { id: runId } : {}), OR: [{ status: "CANCELLED" }, { cancelRequestedAt: { not: null } }] } }),
    ]);
    if (eligible > getRunLimits().MAX_SAMPLES_PER_RUN) {
      throw tooManyRequests("Replay trop volumineux : sélectionnez une analyse respectant la limite par opération.");
    }
    if (eligible === 0) {
      const refresh = await enqueueAggregateRefresh(tx, projectId, runId, target.version);
      if (refresh.jobs === 0 && refresh.alreadyScheduled === 0 && (excludedAnalysisFailed || skippedCancelledRuns)) {
        throw new AppError(409, `Aucune cible rejouable ; ${excludedAnalysisFailed} réponse(s) brute(s) avec analyse terminale échouée et ${skippedCancelledRuns} analyse(s) annulée(s) exclues. Réparation opérateur distincte requise.`);
      }
      const promoted = refresh.jobs === 0 && refresh.alreadyScheduled === 0
        ? await tryPromoteScoringVersion(tx, projectId, target.version) : false;
      return { ...refresh, aggregateJobs: refresh.jobs, eligible, excludedAnalysisFailed, skippedCancelledRuns, promoted };
    }
    const samples = await tx.runSample.findMany({
      where, select: { id: true, taskId: true, runId: true, projectId: true }, orderBy: { id: "asc" },
    });
    const keys = samples.map((sample) => `rescore:${sample.id}:${target.version}`);
    const scheduled = await tx.job.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true, status: true } });
    const blocked = scheduled.filter((job) => ["FAILED", "DEAD", "CANCELLED", "SUCCEEDED"].includes(job.status));
    if (blocked.length) {
      throw new AppError(409, `${blocked.length} cible(s) bloquée(s) : traitement terminé sans score cible. Ancienne version conservée ; intervention opérateur ou nouvelle version de scoring requise.`);
    }
    const existing = new Set(scheduled.map((job) => job.dedupeKey));
    const pending = samples.filter((sample) => !existing.has(`rescore:${sample.id}:${target.version}`));
    await assertRunAllowance(tx, owner.userId, pending.length, { launchingRun: false });
    const jobs = await enqueue(pending.map((sample) => {
      const payload: RescoreSamplePayload = { sampleId: sample.id, taskId: sample.taskId, runId: sample.runId,
        projectId, targetScoringVersion: target.version, targetExtractionVersion: target.extractionVersion };
      return { kind: "RESCORE_SAMPLE" as const, runId: sample.runId, projectId, taskId: sample.taskId,
        sampleId: null, providerCode: INTERNAL_PROVIDER_CODE, payload, dedupeKey: `rescore:${sample.id}:${target.version}` };
    }), tx);
    const refresh = await enqueueAggregateRefresh(tx, projectId, runId, target.version,
      new Set(samples.map((sample) => sample.runId)), getRunLimits().MAX_SAMPLES_PER_RUN - eligible);
    return { jobs: jobs + refresh.jobs, aggregateJobs: refresh.jobs, eligible,
      alreadyScheduled: scheduled.length + refresh.alreadyScheduled, excludedAnalysisFailed, skippedCancelledRuns, promoted: false };
  }, { timeout: 30_000, maxWait: 10_000 });
}

export async function rescoreRun(runId: string, targetScoringVersion: string): Promise<RescoreResult> {
  const target = resolveTarget(targetScoringVersion);
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { projectId: true } });
  if (!run) throw notFound("Analyse");
  return scheduleReplay(run.projectId, runId, target);
}
export async function rescoreProject(projectId: string, targetScoringVersion: string): Promise<RescoreResult> {
  return scheduleReplay(projectId, undefined, resolveTarget(targetScoringVersion));
}

/** A method upgrade reuses immutable SampleScores and never calls a provider/judge. */
async function enqueueAggregateRefresh(
  tx: Prisma.TransactionClient, projectId: string, runId: string | undefined, version: string,
  replayingRuns: ReadonlySet<string> = new Set(), availableVolume = getRunLimits().MAX_SAMPLES_PER_RUN
) {
  const limit = getRunLimits().MAX_SAMPLES_PER_RUN;
  const runs = await tx.run.findMany({ where: { projectId, ...(runId ? { id: runId } : {}),
    status: { notIn: [...IN_FLIGHT_RUN_STATUSES, "CANCELLED"] }, cancelRequestedAt: null,
    tasks: { some: { samples: { some: { status: "COMPLETED" } } } },
  }, select: { id: true }, take: limit + 1 });
  if (runs.length > limit) throw tooManyRequests("Trop d'analyses à vérifier : sélectionnez une analyse.");
  const jobs: Parameters<typeof enqueue>[0] = [];
  let alreadyScheduled = 0;
  let volume = 0;
  for (const run of runs) {
    // Their final replay schedules modern aggregation; other complete runs still
    // need a database-only refresh in this same project operation.
    if (replayingRuns.has(run.id)) continue;
    // A repeated API request must not bypass the last-finisher worker barrier.
    // The owner lock prevents a concurrent planner; SUCCEEDED is irreversible.
    const canonical = { runId: run.id, kind: "RESCORE_SAMPLE" as const,
      dedupeKey: { not: null }, payload: { path: ["targetScoringVersion"], equals: version } };
    // One statement snapshot: separate pending/failed reads could both miss a
    // RUNNING -> DEAD transition between statements.
    const replayStates = await tx.job.groupBy({ by: ["status"], where: canonical, _count: { _all: true } });
    let blockedReplays = 0;
    let pendingReplays = 0;
    for (const state of replayStates) {
      if (state.status === "QUEUED" || state.status === "RUNNING") pendingReplays += state._count._all;
      else if (state.status !== "SUCCEEDED") blockedReplays += state._count._all;
    }
    if (blockedReplays > 0) {
      throw new AppError(409, "Replay canonique terminé en échec : ancienne version conservée, intervention opérateur requise.");
    }
    if (pendingReplays > 0) { alreadyScheduled += pendingReplays; continue; }
    if (await runVersionReady(tx, run.id, version)) continue;
    const [successful, scored] = await Promise.all([
      tx.runSample.count({ where: { runId: run.id, status: "COMPLETED" } }),
      tx.sampleScore.count({ where: { runId: run.id, scoringVersion: version, sample: { status: "COMPLETED" } } }),
    ]);
    if (successful === 0 || successful !== scored) {
      throw new AppError(409, "Scores cibles incomplets sans réponse rejouable : réparation opérateur requise.");
    }
    volume += successful;
    if (volume > availableVolume) throw tooManyRequests("Recalcul trop volumineux : sélectionnez une analyse.");
    const dedupeKey = `aggregate-run:${run.id}:${version}:${QUERY_CLUSTER_METHOD}`;
    const existing = await tx.job.findUnique({ where: { dedupeKey }, select: { status: true } });
    if (existing) {
      if (existing.status === "QUEUED" || existing.status === "RUNNING") { alreadyScheduled += 1; continue; }
      throw new AppError(409, "Agrégation moderne terminée mais incomplète : intervention opérateur requise.");
    }
    jobs.push({ kind: "AGGREGATE_RUN", runId: run.id, projectId, providerCode: INTERNAL_PROVIDER_CODE,
      dedupeKey, payload: { runId: run.id, scoringVersion: version, promoteVersion: true } });
  }
  return { jobs: jobs.length ? await enqueue(jobs, tx) : 0, alreadyScheduled };
}

/** Scores and aggregates must cover every successful sample, not just one mode. */
async function runVersionReady(db: Prisma.TransactionClient, runId: string, version: string): Promise<boolean> {
  const [successful, scored, tasks, taskScores, runScores] = await Promise.all([
    db.runSample.count({ where: { runId, status: "COMPLETED" } }),
    db.sampleScore.count({ where: { runId, scoringVersion: version, sample: { status: "COMPLETED" } } }),
    db.runTask.findMany({ where: { runId, samples: { some: { status: "COMPLETED" } } }, select: { id: true, mode: true } }),
    db.taskScore.findMany({ where: { runId, scoringVersion: version }, select: { taskId: true, rawN: true, ciMethod: true } }),
    db.runScore.findMany({ where: { runId, scoringVersion: version }, select: { mode: true, rawN: true, ciMethod: true } }),
  ]);
  if (successful === 0) return false;
  if (scored !== successful) return false;
  const counts = await db.sampleScore.groupBy({ by: ["taskId"],
    where: { runId, scoringVersion: version, sample: { status: "COMPLETED" } }, _count: { _all: true } });
  const byTask = new Map(counts.map((row) => [row.taskId, row._count._all]));
  const byMode = new Map<string, number>();
  for (const task of tasks) byMode.set(task.mode, (byMode.get(task.mode) ?? 0) + (byTask.get(task.id) ?? 0));
  return tasks.every((task) => taskScores.some((score) => score.taskId === task.id && score.rawN === byTask.get(task.id) && score.ciMethod === QUERY_CLUSTER_METHOD)) &&
    Array.from(byMode).every(([mode, count]) => runScores.some((score) => score.mode === mode && score.rawN === count && score.ciMethod === QUERY_CLUSTER_METHOD));
}

/** Never mix a partially computed target with original evidence. */
export async function resolveRunScoringVersion(
  run: { id: string; scoringVersion: string }, activeVersion: string,
  db: Prisma.TransactionClient = prisma
): Promise<string> {
  if (activeVersion === run.scoringVersion) return activeVersion;
  return await runVersionReady(db, run.id, activeVersion) ? activeVersion : run.scoringVersion;
}

/** Caller holds the owner lock; failed or incomplete targets cannot be promoted. */
export async function tryPromoteScoringVersion(tx: Prisma.TransactionClient, projectId: string, version: string): Promise<boolean> {
  const runs = await tx.run.findMany({
    where: { projectId, status: { notIn: [...IN_FLIGHT_RUN_STATUSES, "CANCELLED"] }, cancelRequestedAt: null,
      tasks: { some: { samples: { some: { status: "COMPLETED" } } } } }, select: { id: true },
  });
  if (runs.length === 0) return false;
  const incomplete = await tx.job.count({ where: { projectId, kind: "RESCORE_SAMPLE",
    runId: { in: runs.map((run) => run.id) }, dedupeKey: { not: null },
    payload: { path: ["targetScoringVersion"], equals: version }, status: { not: "SUCCEEDED" } } });
  if (incomplete > 0) return false;
  for (const run of runs) if (!(await runVersionReady(tx, run.id, version))) return false;
  await tx.project.update({ where: { id: projectId }, data: { activeScoringVersion: version } });
  return true;
}

export async function promoteScoringVersion(projectId: string, version: string): Promise<void> {
  const target = resolveTarget(version);
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } });
  if (!project) throw notFound("Projet");
  await prisma.$transaction(async (tx) => {
    await lockRunOwner(tx, project.userId);
    if (!(await tryPromoteScoringVersion(tx, projectId, target.version))) {
      throw new AppError(409, "Version cible incomplète : l'ancienne version reste active.");
    }
  });
}
