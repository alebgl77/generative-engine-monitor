import { createHash } from "node:crypto";

import type { Sentiment } from "@prisma/client";
import { z } from "zod";

import { decryptCredential } from "@/lib/crypto/credentials";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/providers/registry";
import { bucketKeyForProvider, tryConsume } from "@/lib/queue/ratelimit";

/**
 * Sentiment judging, content-addressed.
 *
 * A run asks the same query several times, so the excerpts surrounding a brand
 * are near-identical across repetitions: keying the cache on the normalised
 * (entity, excerpt) pair turns what would be one judge call per mention into one
 * per distinct opinion, for the whole history of the project.
 *
 * Nothing here may throw. Sentiment is enrichment layered on top of an API call
 * that has already been paid for; failing the scoring pipeline because the judge
 * is unavailable would turn a successful sample into a wasted one.
 */

export const JUDGE_VERSION = "judge-v1";

export interface SentimentVerdict {
  sentiment: Sentiment;
  score: number;
  confidence: number;
}

export interface JudgeItem {
  entityId: string;
  entityName: string;
  context: string;
}

const SENTIMENT_VALUES = ["POSITIVE", "NEUTRAL", "NEGATIVE", "MIXED"] as const;

/**
 * Higher is more negative. A split opinion is not an endorsement, so MIXED
 * outranks NEUTRAL: when two excerpts disagree about the same entity, the
 * darker reading is the one that survives.
 */
const NEGATIVITY: Record<Sentiment, number> = {
  POSITIVE: 0,
  NEUTRAL: 1,
  MIXED: 2,
  NEGATIVE: 3,
};

/** Excerpts longer than this add prompt cost without adding signal. */
const MAX_CONTEXT_CHARS = 400;
/** One call means one prompt; a pathological answer must not build an unbounded one. */
const MAX_ITEMS_PER_CALL = 50;

const verdictSchema = z.object({
  index: z.number().int().nonnegative(),
  sentiment: z.enum(SENTIMENT_VALUES),
  score: z.number().finite(),
  confidence: z.number().finite(),
});

const replySchema = z.array(verdictSchema);

function normalizeContext(context: string): string {
  return context.replace(/\s+/g, " ").trim().slice(0, MAX_CONTEXT_CHARS);
}

function cacheKeyFor(entityName: string, context: string): string {
  return createHash("sha256")
    .update(`${JUDGE_VERSION}|${entityName}|${context}`, "utf8")
    .digest("hex");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function judgeSentiment(
  items: JudgeItem[],
  opts: { userId: string; signal?: AbortSignal }
): Promise<Map<string, SentimentVerdict>> {
  const empty = new Map<string, SentimentVerdict>();
  if (!getEnv().SENTIMENT_ENABLED || items.length === 0) return empty;

  const normalized = items.map((item) => {
    const context = normalizeContext(item.context);
    return {
      entityId: item.entityId,
      entityName: item.entityName,
      context,
      cacheKey: cacheKeyFor(item.entityName, context),
    };
  });

  const distinct = new Map<string, { entityName: string; context: string }>();
  for (const item of normalized) {
    if (!distinct.has(item.cacheKey)) {
      distinct.set(item.cacheKey, { entityName: item.entityName, context: item.context });
    }
  }

  const verdicts = new Map<string, SentimentVerdict>();
  try {
    const cached = await prisma.sentimentJudgment.findMany({
      where: { cacheKey: { in: Array.from(distinct.keys()) }, judgeVersion: JUDGE_VERSION },
      select: { cacheKey: true, sentiment: true, score: true, confidence: true },
    });
    for (const row of cached) {
      verdicts.set(row.cacheKey, {
        sentiment: row.sentiment,
        score: row.score,
        confidence: row.confidence,
      });
    }
  } catch (err) {
    logger.warn("sentiment cache unreadable", { error: err instanceof Error ? err.message : String(err) });
    return empty;
  }

  const misses = Array.from(distinct.entries()).filter(([key]) => !verdicts.has(key));
  if (misses.length > 0) {
    const fresh = await judgeMisses(misses.slice(0, MAX_ITEMS_PER_CALL), opts);
    if (fresh === null) return empty;
    fresh.forEach((verdict, key) => verdicts.set(key, verdict));
  }

  const byEntity = new Map<string, SentimentVerdict>();
  for (const item of normalized) {
    const verdict = verdicts.get(item.cacheKey);
    if (!verdict) continue;
    const current = byEntity.get(item.entityId);
    if (!current || isMoreNegative(verdict, current)) byEntity.set(item.entityId, verdict);
  }
  return byEntity;
}

function isMoreNegative(candidate: SentimentVerdict, current: SentimentVerdict): boolean {
  const delta = NEGATIVITY[candidate.sentiment] - NEGATIVITY[current.sentiment];
  return delta > 0 || (delta === 0 && candidate.score < current.score);
}

/** Returns null when the judge could not be consulted at all. */
async function judgeMisses(
  misses: [string, { entityName: string; context: string }][],
  opts: { userId: string; signal?: AbortSignal }
): Promise<Map<string, SentimentVerdict> | null> {
  const env = getEnv();
  const providerCode = env.SENTIMENT_JUDGE_PROVIDER;

  try {
    const provider = getProvider(providerCode);
    if (!provider) {
      logger.warn("sentiment judge provider is not implemented", { providerCode });
      return null;
    }

    const apiKey = await resolveJudgeKey(providerCode, opts.userId);
    if (!apiKey) return null;

    // The judge spends the same key, against the same provider quota, as the
    // samples do — so it answers to the same bucket. Without this it was the one
    // paid call in the system that no throttle could see, and a replay under a
    // new extraction version misses the cache by construction, which is exactly
    // when it fires most. Being turned away is not an error: sentiment is
    // enrichment, and the caller already treats null as "not consulted".
    if (!(await tryConsume(bucketKeyForProvider(providerCode)))) {
      logger.warn("sentiment judge throttled, sentiment skipped", { providerCode });
      return null;
    }

    const response = await provider.runQuery({
      query: buildPrompt(misses.map(([, item]) => item)),
      mode: "PARAMETRIC",
      apiKey,
      locale: { country: "FR", language: "fr" },
      signal: opts.signal ?? new AbortController().signal,
      model: env.SENTIMENT_JUDGE_MODEL,
    });

    const parsed = replySchema.safeParse(extractJsonArray(response.text));
    if (!parsed.success) {
      logger.warn("sentiment judge returned an unusable reply", {
        providerCode,
        issue: parsed.error.issues[0]?.message,
      });
      return null;
    }

    const fresh = new Map<string, SentimentVerdict>();
    const rows: {
      cacheKey: string;
      judgeVersion: string;
      sentiment: Sentiment;
      score: number;
      confidence: number;
    }[] = [];

    for (const verdict of parsed.data) {
      const entry = misses[verdict.index];
      if (!entry) continue;
      const [cacheKey] = entry;
      if (fresh.has(cacheKey)) continue;
      const value: SentimentVerdict = {
        sentiment: verdict.sentiment,
        score: clamp(verdict.score, -1, 1),
        confidence: clamp(verdict.confidence, 0, 1),
      };
      fresh.set(cacheKey, value);
      rows.push({ cacheKey, judgeVersion: JUDGE_VERSION, ...value });
    }

    if (rows.length > 0) {
      await prisma.sentimentJudgment.createMany({ data: rows, skipDuplicates: true });
    }
    return fresh;
  } catch (err) {
    logger.warn("sentiment judge unavailable", {
      providerCode,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function resolveJudgeKey(providerCode: string, userId: string): Promise<string | null> {
  if (providerCode === "mock") return "mock";

  const providerRow = await prisma.provider.findUnique({
    where: { code: providerCode },
    select: { id: true },
  });
  if (!providerRow) return null;

  const credential = await prisma.providerCredential.findUnique({
    where: { userId_providerId: { userId, providerId: providerRow.id } },
  });
  if (!credential || !credential.isValid) return null;

  return decryptCredential(credential, { userId, providerId: providerRow.id });
}

function buildPrompt(items: { entityName: string; context: string }[]): string {
  const lines = items.map(
    (item, index) => `${index}. entity: ${item.entityName}\n   excerpt: ${item.context}`
  );

  return [
    "You classify how an entity is portrayed inside an excerpt of an AI-generated answer.",
    "Judge the portrayal of the named entity only, not the overall tone of the excerpt.",
    "",
    "Answer with JSON and nothing else: an array holding one object per item, in this shape:",
    '[{"index":0,"sentiment":"POSITIVE|NEUTRAL|NEGATIVE|MIXED","score":-1..1,"confidence":0..1}]',
    "score is the polarity (-1 hostile, 0 neutral, 1 enthusiastic); confidence is how sure you are.",
    "Use MIXED when the excerpt praises and criticises the entity at once.",
    "No prose, no markdown, no explanation.",
    "",
    "Items:",
    ...lines,
  ].join("\n");
}

function extractJsonArray(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}
