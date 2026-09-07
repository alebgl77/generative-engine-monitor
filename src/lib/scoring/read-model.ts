import type { Run, TaskScore } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getScoringVersion } from "@/lib/scoring/registry";
import { resolveRunScoringVersion } from "@/lib/scoring/rescore";
import type { AxisSummary } from "@/types/api";

type ScoreRow = Pick<TaskScore, "median" | "ciLow" | "ciHigh" | "stability" | "n" | "lowN" | "brandPresenceRate" | "ciMethod" | "rawN"> & { cellN?: number };

export function toAxisSummary(score: ScoreRow | undefined): AxisSummary | null {
  if (!score || score.n === 0) return null;
  return {
    median: score.median, ciLow: score.ciLow, ciHigh: score.ciHigh,
    stability: score.stability, n: score.n, rawN: score.rawN,
    cellN: score.cellN ?? null, ciMethod: score.ciMethod,
    nUnit: score.ciMethod === "query-cluster-v1" ? "queries" : "samples",
    lowN: score.lowN, brandPresenceRate: score.brandPresenceRate,
  };
}

/** A read-only projection: selecting a target never mutates original run metadata. */
export async function runForReading(run: Run, activeVersion: string): Promise<Run> {
  const scoringVersion = await resolveRunScoringVersion(run, activeVersion);
  return { ...run, scoringVersion, extractionVersion: getScoringVersion(scoringVersion).extractionVersion };
}

export async function analysisCoverage(run: Pick<Run, "id" | "totalSamples" | "scoringVersion">) {
  const [nSuccessful, nScored] = await Promise.all([
    prisma.runSample.count({ where: { runId: run.id, status: "COMPLETED" } }),
    prisma.sampleScore.count({ where: { runId: run.id, scoringVersion: run.scoringVersion, sample: { status: "COMPLETED" } } }),
  ]);
  return { nPlanned: run.totalSamples, nSuccessful, nScored, missingAnalysis: Math.max(0, nSuccessful - nScored) };
}
