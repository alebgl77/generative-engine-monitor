import type { NextRequest } from "next/server";
import type { Prisma, Run, TaskScore } from "@prisma/client";

import { json, withProject } from "@/lib/api/route-helpers";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { tooManyRequests } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { ensureBucket, tryConsume } from "@/lib/queue/ratelimit";
import { planRun } from "@/lib/runs/plan";
import type {
  AxisSummary,
  RunCreatedResponse,
  RunSummary,
  RunTaskCounts,
  RunTaskSummary,
  RunsResponse,
} from "@/types/api";

type RouteContext = { params: { projectId: string } };

const RUNS_PER_HOUR = 20;
const RUNS_LISTED = 20;
/**
 * Tasks embedded per run. A project with fifty queries plans hundreds of tasks
 * per run, and this list is polled every few seconds while a run advances, so
 * the response carries a page of them plus the counters for the rest.
 */
const TASKS_LISTED = 25;

const taskInclude = {
  query: { select: { id: true, text: true } },
  provider: { select: { code: true, label: true } },
  scores: true,
} satisfies Prisma.RunTaskInclude;

/** Plan order: the reader walks queries, then engines, then modes. */
const taskOrder: Prisma.RunTaskOrderByWithRelationInput[] = [
  { query: { createdAt: "asc" } },
  { provider: { code: "asc" } },
  { mode: "asc" },
];

type TaskRow = Prisma.RunTaskGetPayload<{ include: typeof taskInclude }>;

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

function toTaskSummary(task: TaskRow, scoringVersion: string): RunTaskSummary {
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
    // A run keeps the scoring version it was planned under, so a project that
    // has since moved on still reads its history with the numbers it produced.
    score: toAxisSummary(task.scores.find((s) => s.scoringVersion === scoringVersion)),
    errorMessage: task.errorMessage,
  };
}

function toRunSummary(run: Run, tasks: TaskRow[], taskCounts: RunTaskCounts): RunSummary {
  return {
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
    tasks: tasks.map((task) => toTaskSummary(task, run.scoringVersion)),
  };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  return withProject(request, params.projectId, async ({ project }) => {
    const runs = await prisma.run.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: RUNS_LISTED,
    });

    if (runs.length === 0) {
      const empty: RunsResponse = { runs: [] };
      return json(empty);
    }

    const [grouped, tasksPerRun] = await Promise.all([
      prisma.runTask.groupBy({
        by: ["runId", "status"],
        where: { runId: { in: runs.map((run) => run.id) } },
        _count: { _all: true },
      }),
      Promise.all(
        runs.map((run) =>
          prisma.runTask.findMany({
            where: { runId: run.id },
            orderBy: taskOrder,
            take: TASKS_LISTED,
            include: taskInclude,
          })
        )
      ),
    ]);

    const countsByRun = new Map<string, RunTaskCounts>();
    for (const row of grouped) {
      const counts = countsByRun.get(row.runId) ?? emptyTaskCounts();
      counts.byStatus[row.status] += row._count._all;
      counts.total += row._count._all;
      countsByRun.set(row.runId, counts);
    }

    const payload: RunsResponse = {
      runs: runs.map((run, index) =>
        toRunSummary(run, tasksPerRun[index], countsByRun.get(run.id) ?? emptyTaskCounts())
      ),
    };
    return json(payload);
  });
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  return withProject(request, params.projectId, async ({ project, userId, ip, userAgent }) => {
    // Every run spends real provider credits, so the throttle is charged before
    // anything is planned rather than after.
    const bucketKey = `runs:${userId}`;
    await ensureBucket(bucketKey, RUNS_PER_HOUR, RUNS_PER_HOUR / 3600);
    if (!(await tryConsume(bucketKey))) {
      throw tooManyRequests(
        `Limite de lancement atteinte (${RUNS_PER_HOUR} analyses par heure). Réessayez plus tard.`
      );
    }

    const plan = await planRun(project.id);

    await recordAudit({
      userId,
      projectId: project.id,
      action: AUDIT_ACTIONS.RUN_START,
      targetType: "run",
      targetId: plan.runId,
      metadata: {
        totalTasks: plan.totalTasks,
        totalSamples: plan.totalSamples,
        skipped: plan.skipped,
      },
      ip,
      userAgent,
    });

    const payload: RunCreatedResponse = {
      runId: plan.runId,
      totalTasks: plan.totalTasks,
      totalSamples: plan.totalSamples,
      skipped: plan.skipped,
    };
    // The workers own execution: the request returns as soon as the plan is durable.
    return json(payload, 202);
  });
}
