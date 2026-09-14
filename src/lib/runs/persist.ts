import type { Prisma, SamplingMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getExtractor } from "@/lib/parsing/registry";
import { getScoringVersion } from "@/lib/scoring/registry";
import type { EntityToMatch, MentionOccurrence, ExtractionResult } from "@/lib/parsing/types";
import type { CitationSourceKind } from "@/lib/providers/types";
import { JUDGE_VERSION, judgeSentiment, sentimentKey } from "@/lib/sentiment/judge";
import { assertLease, LostLease } from "@/lib/queue/client";
import type { JobLease } from "@/lib/queue/types";
import { readRunSnapshot } from "@/lib/runs/snapshots";
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
  lease?: JobLease;
}

export interface PersistResult {
  score: number;
  brandPresent: boolean;
  mentionCount: number;
  citationCount: number;
}

export async function persistSampleAnalysis(input: PersistInput): Promise<PersistResult> {
  const existing = await prisma.$transaction(async (tx) => {
    if (input.lease) await assertLease(tx, input.lease);
    return tx.sampleScore.findUnique({ where: {
      sampleId_scoringVersion: { sampleId: input.sampleId, scoringVersion: input.scoringVersion },
    } });
  });
  if (existing) return {
    score: existing.score, brandPresent: existing.brandPresent,
    mentionCount: existing.brandOccurrences + existing.competitorCount, citationCount: existing.citationCount,
  };
  const run = await prisma.run.findUniqueOrThrow({ where: { id: input.runId }, select: { configSnapshot: true } });
  const entities: EntityToMatch[] = readRunSnapshot(run.configSnapshot).entities;
  const brands = entities.filter((entity) => entity.kind === "BRAND");
  const brandIds = brands.map((brand) => brand.id);
  const brandDomains = brands.map((brand) => brand.domain).filter((domain): domain is string => Boolean(domain));

  const stored = await storedEvidence(prisma, input, entities);
  let extraction = stored ?? getExtractor(input.extractionVersion).extract({
    text: input.text,
    entities,
    providerSources: input.providerSources,
    brandDomains,
  });

  let mentions = stored ? extraction.mentions : await withSentiment(extraction.mentions, input);

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
  let result = scoring.scoreSample({
    mode: input.mode,
    brandIds,
    mentions,
    citations: extraction.citations,
    textLength: extraction.textLength,
  });

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (input.lease) await assertLease(tx, input.lease);
    // Serialize competing target versions for the same immutable response.
    await tx.$queryRaw`SELECT id FROM run_samples WHERE id = ${input.sampleId} FOR UPDATE`;
    const existingScore = await tx.sampleScore.findUnique({ where: {
      sampleId_scoringVersion: { sampleId: input.sampleId, scoringVersion: input.scoringVersion },
    } });
    if (existingScore) {
      result = { ...result, score: existingScore.score, brandPresent: existingScore.brandPresent };
      return;
    }
    const previous = await storedEvidence(tx, input, entities);
    if (previous) {
      // Full persisted evidence is authoritative, including legacy rows whose
      // reconstructed catalog snapshot no longer reproduces their extraction.
      extraction = previous;
      mentions = previous.mentions;
      const preservedBrandIds = [...new Set([...brandIds, ...mentions.filter((mention) => mention.kind === "BRAND").map((mention) => mention.entityId)])];
      result = scoring.scoreSample({ mode: input.mode, brandIds: preservedBrandIds, mentions, citations: previous.citations, textLength: previous.textLength });
    }
    if (!previous && brandMentionRows.length) await tx.brandMention.createMany({ data: brandMentionRows, skipDuplicates: true });
    if (!previous && competitorMentionRows.length)
      await tx.competitorMention.createMany({ data: competitorMentionRows, skipDuplicates: true });
    if (!previous && citationRows.length) await tx.citation.createMany({ data: citationRows, skipDuplicates: true });

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
    if (input.lease) await assertLease(tx, input.lease);
  });

  return {
    score: result.score,
    brandPresent: result.brandPresent,
    mentionCount: mentions.length,
    citationCount: extraction.citations.length,
  };
}

async function storedEvidence(
  db: Prisma.TransactionClient, input: PersistInput, entities: EntityToMatch[]
): Promise<ExtractionResult | null> {
  const where = { sampleId: input.sampleId, extractionVersion: input.extractionVersion };
  if (!(await db.sampleScore.findFirst({ where, select: { id: true } }))) return null;
  const [brands, competitors, citations] = await Promise.all([
    db.brandMention.findMany({ where, orderBy: [{ charOffset: "asc" }, { occurrenceIndex: "asc" }] }),
    db.competitorMention.findMany({ where, orderBy: [{ charOffset: "asc" }, { occurrenceIndex: "asc" }] }),
    db.citation.findMany({ where, orderBy: [{ position: "asc" }, { normalizedUrl: "asc" }] }),
  ]);
  const rows = [
    ...brands.map((row) => ({ ...row, entityId: row.brandId, kind: "BRAND" as const })),
    ...competitors.map((row) => ({ ...row, entityId: row.competitorId, kind: "COMPETITOR" as const })),
  ];
  return {
    extractionVersion: input.extractionVersion, textLength: input.text.length, sentenceCount: 0,
    mentions: rows.map((row) => ({
      entityId: row.entityId, entityName: entities.find((entity) => entity.id === row.entityId)?.name ?? row.entityId,
      kind: row.kind, mentionType: row.mentionType, occurrenceIndex: row.occurrenceIndex,
      charOffset: row.charOffset, sentenceIndex: row.sentenceIndex, normalizedPosition: row.normalizedPosition,
      inFirstSentence: row.inFirstSentence, orderRank: row.orderRank, occurrencesTotal: row.occurrencesTotal,
      context: row.context, confidence: row.confidence,
      sentiment: row.sentiment ?? undefined, sentimentScore: row.sentimentScore ?? undefined,
    })).sort((a, b) => a.charOffset - b.charOffset || a.entityId.localeCompare(b.entityId)),
    citations: citations.map((row) => ({
      url: row.url, normalizedUrl: row.normalizedUrl, domain: row.domain, title: row.title ?? undefined,
      position: row.position ?? 0, isBrandDomain: row.isBrandDomain, sourceKind: row.sourceKind,
    })),
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
      { userId: input.userId, signal: input.signal, lease: input.lease }
    );
    if (verdicts.size === 0) return mentions;
    return mentions.map((m) => {
      const verdict = verdicts.get(sentimentKey(m.entityId, m.context));
      return verdict
        ? { ...m, sentiment: verdict.sentiment, sentimentScore: verdict.score }
        : m;
    });
  } catch (err) {
    if (err instanceof LostLease) throw err;
    logger.warn("sentiment judge unavailable, scoring without it", {
      sampleId: input.sampleId,
      error: err instanceof Error ? err.message : String(err),
    });
    return mentions;
  }
}
