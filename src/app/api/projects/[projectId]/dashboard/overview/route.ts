import type { NextRequest } from "next/server";
import type { RunScore, SamplingMode } from "@prisma/client";

import { json, withProject } from "@/lib/api/route-helpers";
import { prisma } from "@/lib/prisma";
import { getScoringVersion } from "@/lib/scoring/registry";
import { aggregate, seedFor } from "@/lib/scoring/stats";
import { LOW_N_RUN } from "@/lib/scoring/types";
import type {
  AxisSummary,
  EntityShare,
  OverviewResponse,
  ProviderModeScore,
  SourceRow,
} from "@/types/api";

type RouteContext = { params: Promise<{ projectId: string }> };

const TOP_SOURCES = 10;

function toAxisSummary(score: RunScore | undefined): AxisSummary | null {
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

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

interface ShareAccumulator {
  entityId: string;
  name: string;
  kind: EntityShare["kind"];
  mentionWeighted: number;
  citationWeighted: number;
  presenceWeighted: number;
  rankWeighted: number;
  rankWeight: number;
  weight: number;
}

interface DomainAccumulator {
  domain: string;
  citationCount: number;
  isBrandDomain: boolean;
  samples: Set<string>;
  modes: Set<SamplingMode>;
  providers: Set<string>;
  queries: Set<string>;
}

interface CellAccumulator {
  providerCode: string;
  providerLabel: string;
  mode: SamplingMode;
  /** Individual sample scores, so `n` counts the same unit everywhere. */
  scores: number[];
  present: number;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { projectId } = await params;
  return withProject(request, projectId, async ({ project }) => {
    const totalQueries = await prisma.query.count({
      where: { projectId: project.id, isActive: true },
    });

    // PARTIAL counts: a run with failed samples still measured everything else,
    // and hiding it would leave the dashboard empty for the wrong reason.
    const run = await prisma.run.findFirst({
      where: { projectId: project.id, status: { in: ["COMPLETED", "PARTIAL"] } },
      orderBy: { createdAt: "desc" },
    });

    if (!run) {
      const empty: OverviewResponse = {
        scoringVersion: project.activeScoringVersion,
        latestRun: null,
        grounded: null,
        parametric: null,
        retrievalGap: null,
        totalQueries,
        shareOfVoice: [],
        topSources: [],
        scoreByProviderMode: [],
      };
      return json(empty);
    }

    const [runScores, shares, taskScores, sampleScores, citations] = await Promise.all([
      prisma.runScore.findMany({
        where: { runId: run.id, scoringVersion: run.scoringVersion },
      }),
      prisma.voiceShare.findMany({
        where: { runId: run.id, taskId: null, scoringVersion: run.scoringVersion },
      }),
      prisma.taskScore.findMany({
        where: { runId: run.id, scoringVersion: run.scoringVersion },
        include: {
          task: {
            select: { mode: true, provider: { select: { code: true, label: true } } },
          },
        },
      }),
      prisma.sampleScore.findMany({
        // Only COMPLETED samples, matching the aggregation layer: a cancelled
        // sample can leave a score row behind that the counters never counted.
        where: {
          runId: run.id,
          scoringVersion: run.scoringVersion,
          sample: { status: "COMPLETED" },
        },
        select: { taskId: true, score: true, brandPresent: true },
        // The bootstrap resamples by index, so an unsorted read would hand the
        // same run a different interval on every request.
        orderBy: { sampleId: "asc" },
      }),
      prisma.citation.findMany({
        where: { runId: run.id, extractionVersion: run.extractionVersion },
        select: {
          domain: true,
          isBrandDomain: true,
          sampleId: true,
          sample: {
            select: {
              task: {
                select: {
                  mode: true,
                  provider: { select: { code: true } },
                  query: { select: { text: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    const grounded = toAxisSummary(runScores.find((s) => s.mode === "GROUNDED"));
    const parametric = toAxisSummary(runScores.find((s) => s.mode === "PARAMETRIC"));

    // The two axes are reported side by side and never averaged: their
    // difference is the only actionable diagnostic they carry together.
    const retrievalGap = grounded && parametric ? grounded.median - parametric.median : null;

    const shareByEntity = new Map<string, ShareAccumulator>();
    for (const share of shares) {
      const entry: ShareAccumulator = shareByEntity.get(share.entityId) ?? {
        entityId: share.entityId,
        name: share.entityName,
        kind: share.entityKind,
        mentionWeighted: 0,
        citationWeighted: 0,
        presenceWeighted: 0,
        rankWeighted: 0,
        rankWeight: 0,
        weight: 0,
      };
      // Run-grain shares exist once per mode; the modes are pooled by sample
      // count so a mode with fewer samples cannot dominate the ranking.
      entry.mentionWeighted += share.mentionShare * share.sampleCount;
      entry.citationWeighted += share.citationShare * share.sampleCount;
      entry.presenceWeighted += share.presenceRate * share.sampleCount;
      if (share.avgOrderRank !== null) {
        entry.rankWeighted += share.avgOrderRank * share.sampleCount;
        entry.rankWeight += share.sampleCount;
      }
      entry.weight += share.sampleCount;
      shareByEntity.set(share.entityId, entry);
    }

    const shareOfVoice: EntityShare[] = Array.from(shareByEntity.values())
      .map((e) => ({
        entityId: e.entityId,
        name: e.name,
        kind: e.kind,
        mentionShare: ratio(e.mentionWeighted, e.weight),
        citationShare: ratio(e.citationWeighted, e.weight),
        presenceRate: ratio(e.presenceWeighted, e.weight),
        avgOrderRank: e.rankWeight > 0 ? e.rankWeighted / e.rankWeight : null,
      }))
      .sort((a, b) => b.mentionShare - a.mentionShare || a.name.localeCompare(b.name));

    const byDomain = new Map<string, DomainAccumulator>();
    for (const citation of citations) {
      const entry: DomainAccumulator = byDomain.get(citation.domain) ?? {
        domain: citation.domain,
        citationCount: 0,
        isBrandDomain: false,
        samples: new Set<string>(),
        modes: new Set<SamplingMode>(),
        providers: new Set<string>(),
        queries: new Set<string>(),
      };
      entry.citationCount += 1;
      entry.isBrandDomain = entry.isBrandDomain || citation.isBrandDomain;
      entry.samples.add(citation.sampleId);
      entry.modes.add(citation.sample.task.mode);
      entry.providers.add(citation.sample.task.provider.code);
      entry.queries.add(citation.sample.task.query.text);
      byDomain.set(citation.domain, entry);
    }

    const topSources: SourceRow[] = Array.from(byDomain.values())
      .map((e) => ({
        domain: e.domain,
        citationCount: e.citationCount,
        sampleCount: e.samples.size,
        citationShare: ratio(e.citationCount, citations.length),
        isBrandDomain: e.isBrandDomain,
        modes: Array.from(e.modes).sort(),
        providers: Array.from(e.providers).sort(),
        queries: Array.from(e.queries).sort(),
      }))
      .sort((a, b) => b.citationCount - a.citationCount || a.domain.localeCompare(b.domain))
      .slice(0, TOP_SOURCES);

    // Each (provider, mode) cell aggregates the individual sample scores, not
    // the per-task medians. Bootstrapping a median of medians would report `n`
    // as a count of queries while the axis cards report a count of samples, so
    // the same figure on the same page would mean two different things.
    const cellOfTask = new Map<string, { providerCode: string; providerLabel: string; mode: SamplingMode }>();
    for (const score of taskScores) {
      cellOfTask.set(score.taskId, {
        providerCode: score.task.provider.code,
        providerLabel: score.task.provider.label,
        mode: score.task.mode,
      });
    }

    const byCell = new Map<string, CellAccumulator>();
    for (const score of sampleScores) {
      const cell = cellOfTask.get(score.taskId);
      if (!cell) continue;
      const key = `${cell.providerCode}|${cell.mode}`;
      const entry: CellAccumulator = byCell.get(key) ?? {
        providerCode: cell.providerCode,
        providerLabel: cell.providerLabel,
        mode: cell.mode,
        scores: [],
        present: 0,
      };
      entry.scores.push(score.score);
      if (score.brandPresent) entry.present += 1;
      byCell.set(key, entry);
    }

    const scoreByProviderMode: ProviderModeScore[] = Array.from(byCell.values())
      .filter((cell) => cell.scores.length > 0)
      .map((cell) => {
        // Seeded from the cell's identity, so the interval is the same on every
        // read of the same run rather than a new draw per request.
        const agg = aggregate(cell.scores, {
          seed: seedFor([run.id, cell.providerCode, cell.mode]),
          lowNThreshold: LOW_N_RUN,
          // Matches the aggregation layer: the estimator belongs to the run's
          // own scoring version, not to whichever one the project uses today.
          stability: getScoringVersion(run.scoringVersion).stability,
        });
        return {
          providerCode: cell.providerCode,
          providerLabel: cell.providerLabel,
          mode: cell.mode,
          median: agg.median,
          ciLow: agg.ciLow,
          ciHigh: agg.ciHigh,
          stability: agg.stability,
          n: agg.n,
          lowN: agg.lowN,
          brandPresenceRate: ratio(cell.present, cell.scores.length),
        };
      })
      .sort(
        (a, b) => a.providerCode.localeCompare(b.providerCode) || a.mode.localeCompare(b.mode)
      );

    const payload: OverviewResponse = {
      scoringVersion: run.scoringVersion,
      latestRun: {
        id: run.id,
        status: run.status,
        progress: {
          totalTasks: run.totalTasks,
          totalSamples: run.totalSamples,
          doneSamples: run.doneSamples,
          failedSamples: run.failedSamples,
        },
        completedAt: run.completedAt?.toISOString() ?? null,
      },
      grounded,
      parametric,
      retrievalGap,
      totalQueries,
      shareOfVoice,
      topSources,
      scoreByProviderMode,
    };

    return json(payload);
  });
}
