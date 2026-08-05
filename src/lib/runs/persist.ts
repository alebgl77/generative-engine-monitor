import type { Prisma, SamplingMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getExtractor } from "@/lib/parsing/registry";
import { getScoringVersion } from "@/lib/scoring/registry";
import type { EntityToMatch, MentionOccurrence } from "@/lib/parsing/types";
import type { CitationSourceKind } from "@/lib/providers/types";
import { JUDGE_VERSION, judgeSentiment } from "@/lib/sentiment/judge";
import { logger } from "@/lib/logger";

/**
 * Turns one stored answer into evidence and a score.
 *
 * This is deliberately the single path used by both live execution and replay:
 * rescoring an old run must produce exactly what running it today would, so
 * there cannot be two implementations that drift apart.
 *
 * It reads only `text` and `providerSources` — never the network — which is why
 * a historical run can be rescored under a new version without asking any engine
 * to answer again. That is not the same as free: the sentiment judge below is a
 * paid call, and a new extraction version yields new excerpts, so its cache
 * cannot absorb them.
 */

export interface PersistInput {
  sampleId: string;
  taskId: string;
  runId: string;
  projectId: string;
  userId: string;
  mode: SamplingMode;
  text: string;
  providerSources: { url: string; title?: string; kind: CitationSourceKind }[];
  scoringVersion: string;
  extractionVersion: string;
  signal?: AbortSignal;
}

export interface PersistResult {
  score: number;
  brandPresent: boolean;
  mentionCount: number;
  citationCount: number;
}

export async function persistSampleAnalysis(input: PersistInput): Promise<PersistResult> {
  const [brands, competitors] = await Promise.all([
    prisma.brand.findMany({ where: { projectId: input.projectId } }),
    prisma.competitor.findMany({ where: { projectId: input.projectId } }),
  ]);

  const entities: EntityToMatch[] = [
    ...brands.map((b) => ({
      id: b.id,
      name: b.name,
      domain: b.domain,
      aliases: b.aliases,
      kind: "BRAND" as const,
    })),
    ...competitors.map((c) => ({
      id: c.id,
      name: c.name,
      domain: c.domain,
      aliases: c.aliases,
      kind: "COMPETITOR" as const,
    })),
  ];

  const brandIds = brands.map((b) => b.id);
  const brandDomains = brands.map((b) => b.domain).filter((d): d is string => Boolean(d));

  const extraction = getExtractor(input.extractionVersion).extract({
    text: input.text,
    entities,
    providerSources: input.providerSources,
    brandDomains,
  });

  const mentions = await withSentiment(extraction.mentions, input);

  const brandMentionRows = mentions
    .filter((m) => m.kind === "BRAND")
    .map((m) => ({
      sampleId: input.sampleId,
      runId: input.runId,
      projectId: input.projectId,
      brandId: m.entityId,
      extractionVersion: extraction.extractionVersion,
      mentionType: m.mentionType,
      occurrenceIndex: m.occurrenceIndex,
      charOffset: m.charOffset,
      sentenceIndex: m.sentenceIndex,
      normalizedPosition: m.normalizedPosition,
      inFirstSentence: m.inFirstSentence,
      orderRank: m.orderRank,
      occurrencesTotal: m.occurrencesTotal,
      context: m.context,
      confidence: m.confidence,
      sentiment: m.sentiment ?? null,
      sentimentScore: m.sentimentScore ?? null,
      sentimentJudgeVersion: m.sentiment ? JUDGE_VERSION : null,
    }));

  const competitorMentionRows = mentions
    .filter((m) => m.kind === "COMPETITOR")
    .map((m) => ({
      sampleId: input.sampleId,
      runId: input.runId,
      projectId: input.projectId,
      competitorId: m.entityId,
      extractionVersion: extraction.extractionVersion,
      mentionType: m.mentionType,
      occurrenceIndex: m.occurrenceIndex,
      charOffset: m.charOffset,
      sentenceIndex: m.sentenceIndex,
      normalizedPosition: m.normalizedPosition,
      inFirstSentence: m.inFirstSentence,
      orderRank: m.orderRank,
      occurrencesTotal: m.occurrencesTotal,
      context: m.context,
      confidence: m.confidence,
      sentiment: m.sentiment ?? null,
      sentimentScore: m.sentimentScore ?? null,
      sentimentJudgeVersion: m.sentiment ? JUDGE_VERSION : null,
    }));

  const citationRows = extraction.citations.map((c) => ({
    sampleId: input.sampleId,
    runId: input.runId,
    projectId: input.projectId,
    url: c.url,
    normalizedUrl: c.normalizedUrl,
    domain: c.domain,
    title: c.title ?? null,
    position: c.position,
    isBrandDomain: c.isBrandDomain,
    sourceKind: c.sourceKind,
    extractionVersion: extraction.extractionVersion,
  }));

  const scoring = getScoringVersion(input.scoringVersion);
  const result = scoring.scoreSample({
    mode: input.mode,
    brandIds,
    mentions,
    citations: extraction.citations,
    textLength: extraction.textLength,
  });

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Replay re-derives the same rows, so the write must be idempotent rather
    // than additive. The unique keys carry extractionVersion, which lets a new
    // extraction version coexist with the old evidence instead of destroying it.
    await tx.brandMention.deleteMany({
      where: { sampleId: input.sampleId, extractionVersion: extraction.extractionVersion },
    });
    await tx.competitorMention.deleteMany({
      where: { sampleId: input.sampleId, extractionVersion: extraction.extractionVersion },
    });
    await tx.citation.deleteMany({
      where: { sampleId: input.sampleId, extractionVersion: extraction.extractionVersion },
    });

    if (brandMentionRows.length) await tx.brandMention.createMany({ data: brandMentionRows });
    if (competitorMentionRows.length)
      await tx.competitorMention.createMany({ data: competitorMentionRows });
    if (citationRows.length) await tx.citation.createMany({ data: citationRows });

    const scoreData = {
      taskId: input.taskId,
      runId: input.runId,
      extractionVersion: extraction.extractionVersion,
      score: result.score,
      brandPresent: result.brandPresent,
      brandOrderRank: result.brandOrderRank,
      brandOccurrences: result.brandOccurrences,
      competitorCount: result.competitorCount,
      citationCount: result.citationCount,
      brandDomainCited: result.brandDomainCited,
      shareOfVoice: result.shareOfVoice,
      contributions: result.contributions as unknown as Prisma.InputJsonValue,
      computedAt: new Date(),
    };

    await tx.sampleScore.upsert({
      where: {
        sampleId_scoringVersion: {
          sampleId: input.sampleId,
          scoringVersion: input.scoringVersion,
        },
      },
      update: scoreData,
      create: { sampleId: input.sampleId, scoringVersion: input.scoringVersion, ...scoreData },
    });
  });

  return {
    score: result.score,
    brandPresent: result.brandPresent,
    mentionCount: mentions.length,
    citationCount: extraction.citations.length,
  };
}

/**
 * Sentiment is best-effort by design: the judge is an extra LLM call, and a
 * scoring pipeline that fails because an optional enrichment failed would turn a
 * paid, already-successful API call into a wasted one.
 */
async function withSentiment(
  mentions: MentionOccurrence[],
  input: PersistInput
): Promise<MentionOccurrence[]> {
  if (mentions.length === 0) return mentions;

  try {
    const verdicts = await judgeSentiment(
      mentions.map((m) => ({
        entityId: m.entityId,
        entityName: m.entityName,
        context: m.context,
      })),
      { userId: input.userId, signal: input.signal }
    );
    if (verdicts.size === 0) return mentions;
    return mentions.map((m) => {
      const verdict = verdicts.get(m.entityId);
      return verdict
        ? { ...m, sentiment: verdict.sentiment, sentimentScore: verdict.score }
        : m;
    });
  } catch (err) {
    logger.warn("sentiment judge unavailable, scoring without it", {
      sampleId: input.sampleId,
      error: err instanceof Error ? err.message : String(err),
    });
    return mentions;
  }
}
