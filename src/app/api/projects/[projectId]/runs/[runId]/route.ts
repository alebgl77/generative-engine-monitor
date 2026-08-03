import type { NextRequest } from "next/server";
import type { Prisma, Run, TaskScore } from "@prisma/client";
import { z } from "zod";

import { json, parseQuery, withProject } from "@/lib/api/route-helpers";
import { notFound } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { ScoreContribution } from "@/lib/scoring/types";
import type {
  AxisSummary,
  RunDetailResponse,
  RunTaskCounts,
  RunTaskSummary,
  SampleDetail,
} from "@/types/api";

type RouteContext = { params: { projectId: string; runId: string } };

/** The explainability panel needs the answer, not the whole answer. */
const TEXT_LIMIT = 4000;

/**
 * Tasks expanded per request. Each one carries its samples with their evidence,
 * and the panel is refetched while the run advances, so the page is explicit and
 * the caller walks a large run with `offset`.
 */
const DEFAULT_TASK_LIMIT = 25;
const MAX_TASK_LIMIT = 100;

const querySchema = z.object({
  limit: z.coerce
    .number()
    .int("nombre entier attendu")
    .min(1, "au moins 1 tâche")
    .max(MAX_TASK_LIMIT, `${MAX_TASK_LIMIT} tâches au maximum`)
    .default(DEFAULT_TASK_LIMIT),
  offset: z.coerce
    .number()
    .int("nombre entier attendu")
    .min(0, "décalage positif attendu")
    .default(0),
});

const taskInclude = {
  query: { select: { id: true, text: true } },
  provider: { select: { code: true, label: true } },
  scores: true,
  samples: {
    orderBy: { sampleIndex: "asc" },
    include: {
      response: { select: { rawText: true } },
      scores: true,
      citations: { orderBy: [{ position: "asc" }, { normalizedUrl: "asc" }] },
      brandMentions: { include: { brand: { select: { name: true } } } },
      competitorMentions: { include: { competitor: { select: { name: true } } } },
    },
  },
} satisfies Prisma.RunTaskInclude;

/** Plan order: the reader walks queries, then engines, then modes. */
const taskOrder: Prisma.RunTaskOrderByWithRelationInput[] = [
  { query: { createdAt: "asc" } },
  { provider: { code: "asc" } },
  { mode: "asc" },
];

type TaskDetail = Prisma.RunTaskGetPayload<{ include: typeof taskInclude }>;
type SampleRow = TaskDetail["samples"][number];

function emptyTaskCounts(): RunTaskCounts {
  return {
    total: 0,
    byStatus: {
      PENDING: 0,
      RUNNING: 0,
      COMPLETED: 0,
      PARTIAL: 0,
      FAILED: 0,
      CANCELLED: 0,
    },
  };
}

function toAxisSummary(score: TaskScore | undefined): AxisSummary | null {
  if (!score) return null;
  return {
    median: score.median,
    ciLow: score.ciLow,
    ciHigh: score.ciHigh,
    stability: score.stability,
    n: score.n,
    lowN: score.lowN,
    brandPresenceRate: score.brandPresenceRate,
  };
}

/** The breakdown is persisted as scored, and rendered as persisted. */
function toContributions(value: Prisma.JsonValue | undefined): ScoreContribution[] {
  return Array.isArray(value) ? (value as unknown as ScoreContribution[]) : [];
}

function toSampleDetail(sample: SampleRow, run: Run): SampleDetail {
  const score = sample.scores.find((s) => s.scoringVersion === run.scoringVersion);

  // Evidence is unique per extraction version; a sample replayed under a newer
  // extractor holds both generations of rows, and only the run's own is its own.
  const mentions: SampleDetail["mentions"] = [
    ...sample.brandMentions
      .filter((m) => m.extractionVersion === run.extractionVersion)
      .map((m) => ({
        entityId: m.brandId,
        entityName: m.brand.name,
        kind: "BRAND" as const,
        mentionType: m.mentionType,
        charOffset: m.charOffset,
        occurrencesTotal: m.occurrencesTotal,
        orderRank: m.orderRank,
        sentiment: m.sentiment,
        context: m.context,
      })),
    ...sample.competitorMentions
      .filter((m) => m.extractionVersion === run.extractionVersion)
      .map((m) => ({
        entityId: m.competitorId,
        entityName: m.competitor.name,
        kind: "COMPETITOR" as const,
        mentionType: m.mentionType,
        charOffset: m.charOffset,
        occurrencesTotal: m.occurrencesTotal,
        orderRank: m.orderRank,
        sentiment: m.sentiment,
        context: m.context,
      })),
  ].sort((a, b) => a.charOffset - b.charOffset || a.entityName.localeCompare(b.entityName));

  // The excerpt is what the offsets below index; the flag tells the panel that
  // evidence may point past its end.
  const rawText = sample.response?.rawText ?? null;

  return {
    id: sample.id,
    sampleIndex: sample.sampleIndex,
    status: sample.status,
    model: sample.model,
    latencyMs: sample.latencyMs,
    errorMessage: sample.errorMessage,
    text: rawText === null ? null : rawText.slice(0, TEXT_LIMIT),
    textTruncated: rawText !== null && rawText.length > TEXT_LIMIT,
    score: score?.score ?? null,
    contributions: toContributions(score?.contributions),
    mentions,
    citations: sample.citations
      .filter((c) => c.extractionVersion === run.extractionVersion)
      .map((c) => ({
        url: c.url,
        domain: c.domain,
        title: c.title,
        isBrandDomain: c.isBrandDomain,
        sourceKind: c.sourceKind,
      })),
  };
}

function toTaskSummary(task: TaskDetail, run: Run): RunTaskSummary {
  return {
    id: task.id,
    mode: task.mode,
    status: task.status,
    query: { id: task.query.id, text: task.query.text },
    provider: { code: task.provider.code, label: task.provider.label },
    samples: {
      total: task.plannedSamples,
      done: task.doneSamples,
      failed: task.failedSamples,
    },
    score: toAxisSummary(task.scores.find((s) => s.scoringVersion === run.scoringVersion)),
    errorMessage: task.errorMessage,
  };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  return withProject(request, params.projectId, async ({ project }) => {
    const { limit, offset } = parseQuery(request, querySchema);

    const run = await prisma.run.findFirst({
      where: { id: params.runId, projectId: project.id },
    });
    if (!run) throw notFound("Analyse");

    const [taskRows, grouped] = await Promise.all([
      prisma.runTask.findMany({
        where: { runId: run.id },
        orderBy: taskOrder,
        skip: offset,
        take: limit,
        include: taskInclude,
      }),
      prisma.runTask.groupBy({
        by: ["status"],
        where: { runId: run.id },
        _count: { _all: true },
      }),
    ]);

    const taskCounts = emptyTaskCounts();
    for (const row of grouped) {
      taskCounts.byStatus[row.status] += row._count._all;
      taskCounts.total += row._count._all;
    }

    const tasks = taskRows.map((task) => toTaskSummary(task, run));
    // `tasksDetail` restates each summary with its samples expanded; the
    // contract types that as an intersection, which the summary's own sample
    // counters cannot inhabit.
    const tasksDetail = taskRows.map((task, index) => ({
      ...tasks[index],
      samples: task.samples.map((sample) => toSampleDetail(sample, run)),
    })) as RunDetailResponse["tasksDetail"];

    const payload: RunDetailResponse = {
      id: run.id,
      status: run.status,
      scoringVersion: run.scoringVersion,
      repetitions: run.repetitions,
      modes: run.modes,
      progress: {
        totalTasks: run.totalTasks,
        totalSamples: run.totalSamples,
        doneSamples: run.doneSamples,
        failedSamples: run.failedSamples,
      },
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      taskCounts,
      tasks,
      tasksDetail,
    };

    return json(payload);
  });
}
