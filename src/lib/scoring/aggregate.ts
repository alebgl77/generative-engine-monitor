import type {
  EntityKind,
  Prisma,
  RunStatus,
  SampleStatus,
  SamplingMode,
  TaskStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertLease, complete, enqueue } from "@/lib/queue/client";
import type { JobLease } from "@/lib/queue/types";
import { clusterBootstrap } from "@/lib/scoring/cluster-stats";
import { readRunSnapshot } from "@/lib/runs/snapshots";
import { lockRunOwner } from "@/lib/runs/limits";
import { tryPromoteScoringVersion } from "@/lib/scoring/rescore";
import { INTERNAL_PROVIDER_CODE, type AggregateRunPayload } from "@/lib/queue/types";
import { getScoringVersion } from "@/lib/scoring/registry";
import { seedFor } from "@/lib/scoring/stats";
import { LOW_N_RUN, LOW_N_TASK } from "@/lib/scoring/types";
import { logger } from "@/lib/logger";

/**
 * Rolls sample scores up to the task and run grains.
 *
 * Two invariants drive the shape of this file:
 *
 * 1. Aggregation is reproducible. Every bootstrap seed comes from the identity
 *    of what is being aggregated, never from a clock, so replaying a run under
 *    the same version yields the same interval bit for bit.
 * 2. Aggregation is idempotent. Jobs are retried, and a rescore re-runs the same
 *    computation over the same rows: writes are upserts, and the only
 *    non-idempotent effect — the pendingTasks countdown — is guarded by the task
 *    status transition it accompanies, inside one transaction.
 */

interface StatusTally {
  succeeded: number;
  failed: number;
  cancelled: number;
  pending: number;
}

function tally(rows: { status: SampleStatus; _count: { _all: number } }[]): StatusTally {
  const counts: StatusTally = { succeeded: 0, failed: 0, cancelled: 0, pending: 0 };
  for (const row of rows) {
    const n = row._count._all;
    if (row.status === "COMPLETED") counts.succeeded += n;
    else if (row.status === "FAILED") counts.failed += n;
    else if (row.status === "CANCELLED") counts.cancelled += n;
    else counts.pending += n;
  }
  return counts;
}

/**
 * `null` while samples are still outstanding: an aggregation triggered early —
 * by a replay, or by a job that ran ahead of its siblings — describes work in
 * progress, and closing the task on it would publish a partial distribution as
 * final.
 */
function taskStatusFrom(counts: StatusTally): TaskStatus | null {
  if (counts.pending > 0) return null;
  if (counts.succeeded === 0 && counts.failed === 0 && counts.cancelled > 0) return "CANCELLED";
  if (counts.succeeded === 0) return "FAILED";
  if (counts.failed > 0 || counts.cancelled > 0) return "PARTIAL";
  return "COMPLETED";
}

/** `null` leaves the run where it is: samples are still in flight. */
function runStatusFrom(previous: RunStatus, counts: StatusTally): RunStatus | null {
  if (counts.pending > 0) return null;
  if (previous === "CANCELLING" || previous === "CANCELLED") return "CANCELLED";
  if (counts.succeeded === 0) return "FAILED";
  if (counts.failed > 0 || counts.cancelled > 0) return "PARTIAL";
  return "COMPLETED";
}

interface TaskScoreInput {
  taskId: string;
  runId: string;
  mode: SamplingMode;
  scoringVersion: string;
  /** Read in a deterministic order: the bootstrap resamples by index. */
  scores: { score: number; brandPresent: boolean }[];
  nFailed: number;
}

/** The task-grain distribution. Seeded from the task identity, so it replays identically. */
async function upsertTaskScore(input: TaskScoreInput, db: Prisma.TransactionClient): Promise<void> {
  const { taskId, scoringVersion, scores } = input;

  const summary = clusterBootstrap(
    scores.map((s) => ({ queryId: taskId, providerId: taskId, value: s.score })),
    {
      seed: seedFor([taskId, input.mode, scoringVersion]),
      lowNThreshold: LOW_N_TASK,
      // The dispersion estimator belongs to the scoring version, so a
      // distribution aggregated under an older one replays to the same number.
      stability: getScoringVersion(scoringVersion).stability,
    }
  );
  const brandPresenceRate = scores.filter((s) => s.brandPresent).length / scores.length;

  const data = {
    runId: input.runId,
    n: summary.n,
    rawN: summary.rawN,
    nFailed: input.nFailed,
    median: summary.median!,
    mean: summary.mean!,
    ciLow: summary.ciLow,
    ciHigh: summary.ciHigh,
    ciMethod: summary.method,
    mad: summary.mad!,
    iqr: summary.iqr!,
    stability: summary.stability!,
    lowN: summary.lowN,
    brandPresenceRate,
    bootstrapSeed: summary.bootstrapSeed,
    computedAt: new Date(),
  };

  await db.taskScore.upsert({
    where: { taskId_scoringVersion: { taskId, scoringVersion } },
    update: data,
    create: { taskId, scoringVersion, ...data },
  });
}

async function aggregateTaskData(db: Prisma.TransactionClient, taskId: string, scoringVersion: string, lease?: JobLease, promoteVersion = false): Promise<void> {
  const task = await db.runTask.findUnique({
    where: { id: taskId },
    select: { id: true, runId: true, projectId: true, mode: true },
  });
  if (!task) {
    logger.warn("aggregate task: task no longer exists", { taskId });
    return;
  }
  if (lease && task.runId !== lease.runId) throw new Error("Aggregate task does not belong to the leased run");

  const [scores, statusRows] = await Promise.all([
    db.sampleScore.findMany({
      // A sample cancelled after its analysis was written leaves a score row
      // behind while the counters exclude it; only COMPLETED samples belong in
      // the distribution.
      where: { taskId, scoringVersion, sample: { status: "COMPLETED" } },
      select: { score: true, brandPresent: true },
      // The bootstrap resamples by index, so the interval depends on the order
      // of the input. Without an explicit sort PostgreSQL is free to return the
      // rows differently on a replay, and the same run would produce a
      // different confidence interval.
      orderBy: { sampleId: "asc" },
    }),
    db.runSample.groupBy({
      by: ["status"],
      where: { taskId },
      _count: { _all: true },
    }),
  ]);

  const counts = tally(statusRows);

  if (scores.length > 0) {
    await upsertTaskScore({
      taskId,
      runId: task.runId,
      mode: task.mode,
      scoringVersion,
      scores,
      nFailed: counts.failed,
    }, db);
  }

  const missingAnalysis = Math.max(0, counts.succeeded - scores.length);
  const status = taskStatusFrom({ ...counts, succeeded: scores.length, failed: counts.failed + missingAnalysis });
  if (!status) {
    logger.info("task scored, samples still in flight", {
      taskId,
      scoringVersion,
      n: scores.length,
      pending: counts.pending,
    });
    return;
  }

  await (async () => {
    const tx = db;
    // The guard makes the countdown exactly-once: a retried job, or a rescore of
    // an already finished run, finds no task left to transition and leaves
    // pendingTasks alone.
    const moved = await tx.runTask.updateMany({
      where: { id: taskId, status: { in: ["PENDING", "RUNNING"] } },
      data: { status, completedAt: new Date() },
    });
    if (moved.count === 0) return;

    const run = await tx.run.update({
      where: { id: task.runId },
      data: { pendingTasks: { decrement: 1 } },
      select: { pendingTasks: true, projectId: true },
    });
    if (run.pendingTasks > 0) return;

    const payload: AggregateRunPayload = { runId: task.runId, scoringVersion, ...(promoteVersion ? { promoteVersion: true } : {}) };
    await enqueue(
      [
        {
          kind: "AGGREGATE_RUN",
          runId: task.runId,
          projectId: run.projectId,
          providerCode: INTERNAL_PROVIDER_CODE,
          payload,
          dedupeKey: `aggregate-run:${task.runId}:${scoringVersion}:query-cluster-v1`,
        },
      ],
      tx as unknown as Prisma.TransactionClient
    );
  })();

  logger.info("task aggregated", {
    taskId,
    scoringVersion,
    status,
    n: scores.length,
    nFailed: counts.failed,
  });
}

interface EntityRef {
  id: string;
  name: string;
  kind: EntityKind;
  /** Normalised once: citation matching runs per sample and per entity. */
  domain: string | null;
}

interface SampleEvidence {
  /** `kind:id` -> number of mention occurrences in this sample. */
  occurrences: Map<string, number>;
  /** `kind:id` -> rank of the entity's first appearance among all entities. */
  orderRanks: Map<string, number>;
  citationDomains: string[];
}

interface ShareRow {
  entityKind: EntityKind;
  entityId: string;
  entityName: string;
  mentionShare: number;
  presenceRate: number;
  citationShare: number;
  avgOrderRank: number | null;
  sampleCount: number;
}

function entityKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, "");
}

function domainMatches(citationDomain: string, entityDomain: string): boolean {
  return citationDomain === entityDomain || citationDomain.endsWith(`.${entityDomain}`);
}

function emptyEvidence(): SampleEvidence {
  return { occurrences: new Map(), orderRanks: new Map(), citationDomains: [] };
}

function addMention(
  evidence: Map<string, SampleEvidence>,
  sampleId: string,
  key: string,
  orderRank: number
): void {
  let entry = evidence.get(sampleId);
  if (!entry) {
    entry = emptyEvidence();
    evidence.set(sampleId, entry);
  }
  entry.occurrences.set(key, (entry.occurrences.get(key) ?? 0) + 1);
  const known = entry.orderRanks.get(key);
  if (known === undefined || orderRank < known) entry.orderRanks.set(key, orderRank);
}

function computeShares(
  sampleIds: string[],
  entities: EntityRef[],
  evidence: Map<string, SampleEvidence>
): ShareRow[] {
  const accumulators = new Map<
    string,
    { occurrences: number; present: number; rankSum: number; rankCount: number; cited: number }
  >();
  for (const entity of entities) {
    accumulators.set(entityKey(entity.kind, entity.id), {
      occurrences: 0,
      present: 0,
      rankSum: 0,
      rankCount: 0,
      cited: 0,
    });
  }

  let totalOccurrences = 0;
  let totalCitations = 0;

  for (const sampleId of sampleIds) {
    const entry = evidence.get(sampleId);
    if (!entry) continue;

    for (const [key, occurrences] of Array.from(entry.occurrences)) {
      totalOccurrences += occurrences;
      const accumulator = accumulators.get(key);
      if (!accumulator) continue;
      accumulator.occurrences += occurrences;
      accumulator.present += 1;
      const rank = entry.orderRanks.get(key);
      if (rank !== undefined) {
        accumulator.rankSum += rank;
        accumulator.rankCount += 1;
      }
    }

    totalCitations += entry.citationDomains.length;
    for (const citationDomain of entry.citationDomains) {
      for (const entity of entities) {
        if (entity.domain && domainMatches(citationDomain, entity.domain)) {
          accumulators.get(entityKey(entity.kind, entity.id))!.cited += 1;
        }
      }
    }
  }

  const sampleCount = sampleIds.length;

  return entities.map((entity) => {
    const accumulator = accumulators.get(entityKey(entity.kind, entity.id))!;
    return {
      entityKind: entity.kind,
      entityId: entity.id,
      entityName: entity.name,
      mentionShare: totalOccurrences > 0 ? accumulator.occurrences / totalOccurrences : 0,
      presenceRate: sampleCount > 0 ? accumulator.present / sampleCount : 0,
      citationShare: totalCitations > 0 ? accumulator.cited / totalCitations : 0,
      avgOrderRank:
        accumulator.rankCount > 0 ? accumulator.rankSum / accumulator.rankCount : null,
      sampleCount,
    };
  });
}

/**
 * Rebuilds the task grain in the same transaction as the run grain, including
 * cancelled runs and database-only upgrades of historical interval methods.
 */
async function persistTaskScores(
  runId: string,
  scoringVersion: string,
  scores: { taskId: string; score: number; brandPresent: boolean }[],
  modeByTask: Map<string, SamplingMode>,
  db: Prisma.TransactionClient
): Promise<void> {
  const byTask = new Map<string, { score: number; brandPresent: boolean }[]>();
  for (const score of scores) {
    const bucket = byTask.get(score.taskId);
    if (bucket) bucket.push(score);
    else byTask.set(score.taskId, [score]);
  }
  if (byTask.size === 0) return;

  const statusRows = await db.runSample.groupBy({
    by: ["taskId", "status"],
    where: { runId },
    _count: { _all: true },
  });
  const failedByTask = new Map<string, number>();
  for (const row of statusRows) {
    if (row.status !== "FAILED") continue;
    failedByTask.set(row.taskId, (failedByTask.get(row.taskId) ?? 0) + row._count._all);
  }

  for (const [taskId, taskScores] of Array.from(byTask)) {
    const mode = modeByTask.get(taskId);
    if (!mode) continue;
    await upsertTaskScore({
      taskId,
      runId,
      mode,
      scoringVersion,
      scores: taskScores,
      nFailed: failedByTask.get(taskId) ?? 0,
    }, db);
  }
}

async function aggregateRunData(db: Prisma.TransactionClient, runId: string, scoringVersion: string, promoteVersion = false): Promise<void> {
  const run = await db.run.findUnique({
    where: { id: runId },
    select: { id: true, projectId: true, status: true, configSnapshot: true, scoringVersion: true },
  });
  if (!run) {
    logger.warn("aggregate run: run no longer exists", { runId });
    return;
  }

  const extractionVersion = getScoringVersion(scoringVersion).extractionVersion;

  const [tasks, scores, statusRows] = await Promise.all([
    db.runTask.findMany({ where: { runId }, select: { id: true, mode: true, queryId: true, providerId: true } }),
    db.sampleScore.findMany({
      // Only COMPLETED samples: a cancellation racing the analysis write can
      // leave a score row the counters never counted.
      where: { runId, scoringVersion, sample: { status: "COMPLETED" } },
      select: { sampleId: true, taskId: true, score: true, brandPresent: true },
      // Deterministic order: the bootstrap resamples by index, so an unsorted
      // read would make a replayed run report a different interval.
      orderBy: { sampleId: "asc" },
    }),
    db.runSample.groupBy({ by: ["status"], where: { runId }, _count: { _all: true } }),
  ]);

  const modeByTask = new Map(tasks.map((task) => [task.id, task.mode]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const scoresByMode = new Map<SamplingMode, { sampleId: string; taskId: string; score: number; brandPresent: boolean }[]>();
  const samplesByTask = new Map<string, string[]>();
  for (const score of scores) {
    const mode = modeByTask.get(score.taskId);
    if (!mode) continue;
    const bucket = scoresByMode.get(mode);
    if (bucket) bucket.push(score);
    else scoresByMode.set(mode, [score]);
    const taskBucket = samplesByTask.get(score.taskId);
    if (taskBucket) taskBucket.push(score.sampleId);
    else samplesByTask.set(score.taskId, [score.sampleId]);
  }

  for (const [mode, modeScores] of Array.from(scoresByMode)) {
    const summary = clusterBootstrap(
      modeScores.map((s) => { const task = taskById.get(s.taskId)!; return { queryId: task.queryId, providerId: task.providerId, value: s.score }; }),
      {
        seed: seedFor([runId, mode, scoringVersion]),
        lowNThreshold: LOW_N_RUN,
        stability: getScoringVersion(scoringVersion).stability,
      }
    );
    const brandPresenceRate =
      modeScores.filter((s) => s.brandPresent).length / modeScores.length;

    const data = {
      n: summary.n,
      rawN: summary.rawN,
      cellN: summary.cellN,
      ciMethod: summary.method,
      median: summary.median!,
      mean: summary.mean!,
      ciLow: summary.ciLow,
      ciHigh: summary.ciHigh,
      mad: summary.mad!,
      iqr: summary.iqr!,
      stability: summary.stability!,
      lowN: summary.lowN,
      brandPresenceRate,
      bootstrapSeed: summary.bootstrapSeed,
      computedAt: new Date(),
    };

    await db.runScore.upsert({
      where: { runId_mode_scoringVersion: { runId, mode, scoringVersion } },
      update: data,
      create: { runId, mode, scoringVersion, ...data },
    });
  }

  // Rebuild task aggregates too: a free method refresh must not depend on a
  // separately scheduled task job winning a race with run aggregation.
  await persistTaskScores(runId, scoringVersion, scores, modeByTask, db);

  const entities: EntityRef[] = readRunSnapshot(run.configSnapshot).entities.map((entity) => ({
    id: entity.id, name: entity.name, kind: entity.kind,
    domain: entity.domain ? normalizeDomain(entity.domain) : null,
  }));

  const scoredSampleIds = new Set(scores.map((s) => s.sampleId));

  const [brandMentions, competitorMentions, citations] = await Promise.all([
    db.brandMention.findMany({
      where: { runId, extractionVersion },
      select: { sampleId: true, brandId: true, orderRank: true },
    }),
    db.competitorMention.findMany({
      where: { runId, extractionVersion },
      select: { sampleId: true, competitorId: true, orderRank: true },
    }),
    db.citation.findMany({
      where: { runId, extractionVersion },
      select: { sampleId: true, domain: true },
    }),
  ]);

  const evidence = new Map<string, SampleEvidence>();
  for (const mention of brandMentions) {
    if (!scoredSampleIds.has(mention.sampleId)) continue;
    addMention(evidence, mention.sampleId, entityKey("BRAND", mention.brandId), mention.orderRank);
  }
  for (const mention of competitorMentions) {
    if (!scoredSampleIds.has(mention.sampleId)) continue;
    addMention(
      evidence,
      mention.sampleId,
      entityKey("COMPETITOR", mention.competitorId),
      mention.orderRank
    );
  }
  for (const citation of citations) {
    if (!scoredSampleIds.has(citation.sampleId)) continue;
    let entry = evidence.get(citation.sampleId);
    if (!entry) {
      entry = emptyEvidence();
      evidence.set(citation.sampleId, entry);
    }
    entry.citationDomains.push(normalizeDomain(citation.domain));
  }

  const shareRows: Prisma.VoiceShareCreateManyInput[] = [];

  if (entities.length > 0) {
    for (const [mode, modeScores] of Array.from(scoresByMode)) {
      const sampleIds = modeScores.map((s) => s.sampleId);
      for (const share of computeShares(sampleIds, entities, evidence)) {
        shareRows.push({ runId, taskId: null, mode, scoringVersion, ...share });
      }
    }

    for (const [taskId, sampleIds] of Array.from(samplesByTask)) {
      const mode = modeByTask.get(taskId);
      if (!mode) continue;
      for (const share of computeShares(sampleIds, entities, evidence)) {
        shareRows.push({ runId, taskId, mode, scoringVersion, ...share });
      }
    }
  }

  // Replace rather than upsert: the unique key carries a nullable taskId, and
  // Postgres treats NULLs as distinct, so run-grain rows would accumulate
  // duplicates instead of being matched. The swap is transactional, so a reader
  // never observes a run without its shares.
  await db.voiceShare.deleteMany({ where: { runId, scoringVersion } });
  if (shareRows.length > 0) await db.voiceShare.createMany({ data: shareRows });

  const counts = tally(statusRows);
  const missingAnalysis = Math.max(0, counts.succeeded - scores.length);
  const status = runStatusFrom(run.status, { ...counts, succeeded: scores.length, failed: counts.failed + missingAnalysis });

  if (status) {
    await db.run.updateMany({
      where: { id: runId, status: { in: ["PENDING", "RUNNING", "CANCELLING"] } },
      data: { status, completedAt: new Date() },
    });
  }

  if (status && missingAnalysis === 0 && (promoteVersion || scoringVersion !== run.scoringVersion)) {
    await tryPromoteScoringVersion(db, run.projectId, scoringVersion);
  }

  logger.info("run aggregated", {
    runId,
    scoringVersion,
    status: status ?? run.status,
    pending: counts.pending,
    modes: Array.from(scoresByMode.keys()),
    n: scores.length,
    shares: shareRows.length,
  });
}

/** All mutations and job completion share one lease-fenced transaction. */
export async function aggregateTask(taskId: string, scoringVersion: string, lease?: JobLease, promoteVersion = false): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (lease) await assertLease(tx, lease);
    await aggregateTaskData(tx, taskId, scoringVersion, lease, promoteVersion);
    if (lease) { await assertLease(tx, lease); await complete(lease, tx); }
  }, { timeout: 30_000, maxWait: 10_000 });
}

export async function aggregateRun(runId: string, scoringVersion: string, lease?: JobLease, promoteVersion = false): Promise<void> {
  if (lease && lease.runId !== runId) throw new Error("Aggregate run does not match the lease");
  // Owner metadata only before locking; mutable run/score state is read inside.
  const owner = await prisma.run.findUnique({ where: { id: runId }, select: { project: { select: { userId: true } } } });
  await prisma.$transaction(async (tx) => {
    // Same owner -> run -> job order as planning, avoiding promotion deadlocks.
    if (owner) await lockRunOwner(tx, owner.project.userId);
    if (lease) await assertLease(tx, lease);
    await aggregateRunData(tx, runId, scoringVersion, promoteVersion);
    if (lease) { await assertLease(tx, lease); await complete(lease, tx); }
  }, { timeout: 30_000, maxWait: 10_000 });
}
