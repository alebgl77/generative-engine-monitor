import type { NextRequest } from "next/server";

import { json, withProject } from "@/lib/api/route-helpers";
import { prisma } from "@/lib/prisma";
import type { QueriesResponse, QueryCell } from "@/types/api";

type RouteContext = { params: Promise<{ projectId: string }> };

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

interface CompetitorAccumulator {
  name: string;
  weighted: number;
  weight: number;
}

interface RowAccumulator {
  queryId: string;
  text: string;
  cells: QueryCell[];
  presenceWeighted: number;
  presenceWeight: number;
  citationWeighted: number;
  citationWeight: number;
  competitors: Map<string, CompetitorAccumulator>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { projectId } = await params;
  return withProject(request, projectId, async ({ project }) => {
    // A partial or cancelled run measured fewer cells than planned; every cell it
    // did measure was paid for, and its status travels with the rows.
    const run = await prisma.run.findFirst({
      where: { projectId: project.id, status: { in: ["COMPLETED", "PARTIAL", "CANCELLED"] } },
      orderBy: { createdAt: "desc" },
    });

    if (!run) {
      const empty: QueriesResponse = {
        scoringVersion: project.activeScoringVersion,
        runId: null,
        rows: [],
      };
      return json(empty);
    }

    const [tasks, citationsPerTask] = await Promise.all([
      prisma.runTask.findMany({
        where: { runId: run.id },
        orderBy: [
          { query: { createdAt: "asc" } },
          { provider: { code: "asc" } },
          { mode: "asc" },
        ],
        include: {
          query: { select: { id: true, text: true, createdAt: true } },
          provider: { select: { code: true, label: true } },
          scores: { where: { scoringVersion: run.scoringVersion } },
          shares: {
            where: { scoringVersion: run.scoringVersion, entityKind: "COMPETITOR" },
          },
        },
      }),
      prisma.sampleScore.groupBy({
        by: ["taskId"],
        where: { runId: run.id, scoringVersion: run.scoringVersion },
        _avg: { citationCount: true },
        _count: true,
      }),
    ]);

    const citationsByTask = new Map(
      citationsPerTask.map((row) => [
        row.taskId,
        { avg: row._avg.citationCount ?? 0, samples: row._count },
      ])
    );

    const rows = new Map<string, RowAccumulator>();

    for (const task of tasks) {
      const row: RowAccumulator = rows.get(task.queryId) ?? {
        queryId: task.queryId,
        text: task.query.text,
        cells: [],
        presenceWeighted: 0,
        presenceWeight: 0,
        citationWeighted: 0,
        citationWeight: 0,
        competitors: new Map<string, CompetitorAccumulator>(),
      };

      const score = task.scores[0];
      // A cell is emitted for every planned task, scored or not: an empty cell
      // with its status is what tells the reader a provider failed there.
      row.cells.push({
        providerCode: task.provider.code,
        providerLabel: task.provider.label,
        mode: task.mode,
        taskId: task.id,
        status: task.status,
        median: score?.median ?? 0,
        ciLow: score?.ciLow ?? 0,
        ciHigh: score?.ciHigh ?? 0,
        stability: score?.stability ?? 0,
        n: score?.n ?? 0,
        lowN: score?.lowN ?? true,
        brandPresenceRate: score?.brandPresenceRate ?? 0,
      });

      if (score) {
        row.presenceWeighted += score.brandPresenceRate * score.n;
        row.presenceWeight += score.n;
      }

      const citations = citationsByTask.get(task.id);
      if (citations) {
        row.citationWeighted += citations.avg * citations.samples;
        row.citationWeight += citations.samples;
      }

      for (const share of task.shares) {
        const entry: CompetitorAccumulator = row.competitors.get(share.entityId) ?? {
          name: share.entityName,
          weighted: 0,
          weight: 0,
        };
        entry.weighted += share.mentionShare * share.sampleCount;
        entry.weight += share.sampleCount;
        row.competitors.set(share.entityId, entry);
      }

      rows.set(task.queryId, row);
    }

    const payload: QueriesResponse = {
      scoringVersion: run.scoringVersion,
      runId: run.id,
      rows: Array.from(rows.values()).map((row) => ({
        queryId: row.queryId,
        text: row.text,
        cells: row.cells,
        brandPresenceRate: ratio(row.presenceWeighted, row.presenceWeight),
        competitors: Array.from(row.competitors.values())
          .map((c) => ({ name: c.name, mentionShare: ratio(c.weighted, c.weight) }))
          .sort((a, b) => b.mentionShare - a.mentionShare || a.name.localeCompare(b.name)),
        avgCitations: ratio(row.citationWeighted, row.citationWeight),
      })),
    };

    return json(payload);
  });
}
