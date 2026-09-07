import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    SENTIMENT_ENABLED: true,
    SENTIMENT_JUDGE_PROVIDER: "openai",
    SENTIMENT_JUDGE_MODEL: "judge-model",
  },
  prisma: {
    sentimentJudgment: { findMany: vi.fn(), createMany: vi.fn() },
    provider: { findUnique: vi.fn() },
    providerCredential: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  runQuery: vi.fn(),
  tryConsume: vi.fn(),
  warn: vi.fn(),
  assertLease: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn } }));
vi.mock("@/lib/providers/registry", () => ({
  getProvider: (code: string) => (code === "unknown" ? undefined : { runQuery: mocks.runQuery }),
}));
vi.mock("@/lib/crypto/credentials", () => ({ decryptCredential: () => "sk-test" }));
vi.mock("@/lib/queue/ratelimit", () => ({
  tryConsume: mocks.tryConsume,
  bucketKeyForProvider: (code: string) => `provider:${code}`,
}));
vi.mock("@/lib/queue/client", () => ({
  assertLease: mocks.assertLease,
  LostLease: class LostLease extends Error {},
}));
import { LostLease } from "@/lib/queue/client";

import { judgeSentiment, sentimentKey } from "@/lib/sentiment/judge";

const validCredential = {
  id: "cred1",
  providerId: "p1",
  isValid: true,
  cipherText: Buffer.alloc(0),
  iv: Buffer.alloc(0),
  authTag: Buffer.alloc(0),
  keyVersion: 1,
};

function cachedAs(...verdicts: { sentiment: string; score: number }[]) {
  return async ({ where }: { where: { cacheKey: { in: string[] } } }) =>
    where.cacheKey.in.map((cacheKey, index) => ({
      cacheKey,
      sentiment: verdicts[index]?.sentiment ?? "NEUTRAL",
      score: verdicts[index]?.score ?? 0,
      confidence: 0.9,
    }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.SENTIMENT_ENABLED = true;
  mocks.env.SENTIMENT_JUDGE_PROVIDER = "openai";
  mocks.prisma.sentimentJudgment.findMany.mockResolvedValue([]);
  mocks.prisma.sentimentJudgment.createMany.mockResolvedValue({ count: 0 });
  mocks.prisma.provider.findUnique.mockResolvedValue({ id: "p1" });
  mocks.prisma.providerCredential.findUnique.mockResolvedValue(validCredential);
  mocks.tryConsume.mockResolvedValue(true);
  mocks.assertLease.mockResolvedValue(undefined);
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.prisma));
});

describe("judgeSentiment", () => {
  it("does nothing at all when sentiment is disabled", async () => {
    mocks.env.SENTIMENT_ENABLED = false;

    const result = await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "bien" }], {
      userId: "u1",
    });

    expect(result.size).toBe(0);
    expect(mocks.prisma.sentimentJudgment.findMany).not.toHaveBeenCalled();
    expect(mocks.runQuery).not.toHaveBeenCalled();
  });

  it("serves fully cached mentions without calling the judge", async () => {
    mocks.prisma.sentimentJudgment.findMany.mockImplementation(
      cachedAs({ sentiment: "POSITIVE", score: 0.8 })
    );

    const result = await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "excellent" }], {
      userId: "u1",
    });

    expect(mocks.runQuery).not.toHaveBeenCalled();
    expect(result.get(sentimentKey("b1", "excellent"))).toEqual({ sentiment: "POSITIVE", score: 0.8, confidence: 0.9 });
  });

  it("deduplicates contexts that differ only by whitespace", async () => {
    mocks.prisma.sentimentJudgment.findMany.mockImplementation(cachedAs({ sentiment: "NEUTRAL", score: 0 }));

    const result = await judgeSentiment(
      [
        { entityId: "b1", entityName: "Acme", context: "  une   réponse " },
        { entityId: "b1", entityName: "Acme", context: "une réponse" },
      ],
      { userId: "u1" }
    );

    const [{ where }] = mocks.prisma.sentimentJudgment.findMany.mock.calls[0];
    expect(where.cacheKey.in).toHaveLength(1);
    expect(result.size).toBe(1);
    expect(result.has(sentimentKey("b1", "une réponse"))).toBe(true);
  });

  it("keeps contrasting contexts for one entity separate without a negativity selection", async () => {
    mocks.prisma.sentimentJudgment.findMany.mockImplementation(
      cachedAs({ sentiment: "POSITIVE", score: 0.9 }, { sentiment: "NEGATIVE", score: -0.7 })
    );

    const result = await judgeSentiment(
      [
        { entityId: "b1", entityName: "Acme", context: "le meilleur" },
        { entityId: "b1", entityName: "Acme", context: "à éviter" },
      ],
      { userId: "u1" }
    );

    expect(result.size).toBe(2);
    expect(result.get(sentimentKey("b1", "le meilleur"))?.sentiment).toBe("POSITIVE");
    expect(result.get(sentimentKey("b1", "à éviter"))?.sentiment).toBe("NEGATIVE");
    expect(result.has("b1")).toBe(false);
  });

  it("does not overwrite a neutral context with a separate mixed context", async () => {
    mocks.prisma.sentimentJudgment.findMany.mockImplementation(
      cachedAs({ sentiment: "NEUTRAL", score: 0 }, { sentiment: "MIXED", score: 0.1 })
    );

    const result = await judgeSentiment(
      [
        { entityId: "b1", entityName: "Acme", context: "un acteur du marché" },
        { entityId: "b1", entityName: "Acme", context: "rapide mais cher" },
      ],
      { userId: "u1" }
    );

    expect(result.get(sentimentKey("b1", "un acteur du marché"))?.sentiment).toBe("NEUTRAL");
    expect(result.get(sentimentKey("b1", "rapide mais cher"))?.sentiment).toBe("MIXED");
  });

  it("returns nothing rather than throwing when the user has no valid credential", async () => {
    mocks.prisma.providerCredential.findUnique.mockResolvedValue({ ...validCredential, isValid: false });

    const result = await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "bien" }], {
      userId: "u1",
    });

    expect(result.size).toBe(0);
    expect(mocks.runQuery).not.toHaveBeenCalled();
  });

  it("parses a fenced JSON reply, persists it and clamps out-of-range values", async () => {
    mocks.runQuery.mockResolvedValue({
      text: '```json\n[{"index":0,"sentiment":"NEGATIVE","score":-4,"confidence":2}]\n```',
    });

    const result = await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "décevant" }], {
      userId: "u1",
    });

    expect(result.get(sentimentKey("b1", "décevant"))).toEqual({ sentiment: "NEGATIVE", score: -1, confidence: 1 });
    const [{ data }] = mocks.prisma.sentimentJudgment.createMany.mock.calls[0];
    expect(data).toHaveLength(1);
    expect(data[0].judgeVersion).toBe("judge-v2-context");
  });

  it("asks the judge in PARAMETRIC mode with the configured model", async () => {
    mocks.runQuery.mockResolvedValue({ text: "[]" });

    await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "bien" }], { userId: "u1" });

    const [input] = mocks.runQuery.mock.calls[0];
    expect(input.mode).toBe("PARAMETRIC");
    expect(input.model).toBe("judge-model");
    expect(input.locale).toEqual({ country: "FR", language: "fr" });
  });

  it("returns nothing on an unparseable reply", async () => {
    mocks.runQuery.mockResolvedValue({ text: "Je ne peux pas répondre." });

    const result = await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "bien" }], {
      userId: "u1",
    });

    expect(result.size).toBe(0);
    expect(mocks.prisma.sentimentJudgment.createMany).not.toHaveBeenCalled();
  });

  it("never throws when the provider call fails", async () => {
    mocks.runQuery.mockRejectedValue(new Error("HTTP 500"));

    await expect(
      judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "bien" }], { userId: "u1" })
    ).resolves.toEqual(new Map());
  });

  it("does not log provider errors that can echo private excerpts or credentials", async () => {
    mocks.runQuery.mockRejectedValue(new Error("private excerpt sk-private-key"));
    await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "private excerpt" }], { userId: "u1" });
    expect(mocks.warn).toHaveBeenCalledWith("sentiment judge unavailable", {
      providerCode: "openai", errorType: "Error",
    });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/private excerpt|sk-private-key/);
  });

  it("returns no invented judgments on a private cache read failure", async () => {
    mocks.prisma.sentimentJudgment.findMany.mockRejectedValue(new Error("private cache payload"));
    expect(await judgeSentiment([
      { entityId: "b1", entityName: "Acme", context: "private excerpt" },
    ], { userId: "u1" })).toEqual(new Map());
    expect(mocks.runQuery).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/private/);
  });

  it("ignores a verdict pointing at an item that was never sent", async () => {
    mocks.runQuery.mockResolvedValue({
      text: '[{"index":7,"sentiment":"POSITIVE","score":1,"confidence":1}]',
    });

    const result = await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "bien" }], {
      userId: "u1",
    });

    expect(result.size).toBe(0);
  });

  it("deduplicates fresh judgments and reuses the content-addressed cache across calls", async () => {
    mocks.runQuery.mockResolvedValue({
      text: '[{"index":0,"sentiment":"POSITIVE","score":0.8,"confidence":0.9}]',
    });
    const items = [
      { entityId: "b1", entityName: "Acme", context: "excellent" },
      { entityId: "b1", entityName: "Acme", context: "  excellent " },
    ];
    const first = await judgeSentiment(items, { userId: "u1" });
    const [{ data }] = mocks.prisma.sentimentJudgment.createMany.mock.calls[0];
    expect(data).toHaveLength(1);
    expect(Object.keys(data[0]).sort()).toEqual(["cacheKey", "confidence", "judgeVersion", "score", "sentiment"]);
    mocks.prisma.sentimentJudgment.findMany.mockResolvedValue(data);
    const second = await judgeSentiment(items, { userId: "u1" });
    expect(second).toEqual(first);
    expect(mocks.runQuery).toHaveBeenCalledTimes(1);
  });

  it("preserves available cached contexts when an optional fresh judgment fails", async () => {
    mocks.prisma.sentimentJudgment.findMany.mockImplementation(
      async ({ where }: { where: { cacheKey: { in: string[] } } }) => [{
        cacheKey: where.cacheKey.in[0], sentiment: "POSITIVE", score: 0.8, confidence: 0.9,
      }]
    );
    mocks.runQuery.mockRejectedValue(new Error("unavailable"));
    const result = await judgeSentiment([
      { entityId: "b1", entityName: "Acme", context: "excellent" },
      { entityId: "b1", entityName: "Acme", context: "nouvel avis" },
    ], { userId: "u1" });
    expect(result.size).toBe(1);
    expect(result.get(sentimentKey("b1", "excellent"))?.sentiment).toBe("POSITIVE");
    expect(result.has(sentimentKey("b1", "nouvel avis"))).toBe(false);
  });

  it("leaves a missing verdict absent instead of inventing a neutral one", async () => {
    mocks.runQuery.mockResolvedValue({
      text: '[{"index":0,"sentiment":"POSITIVE","score":0.8,"confidence":0.9}]',
    });
    const result = await judgeSentiment([
      { entityId: "b1", entityName: "Acme", context: "excellent" },
      { entityId: "b1", entityName: "Acme", context: "autre avis" },
    ], { userId: "u1" });
    expect(result.size).toBe(1);
    expect(result.has(sentimentKey("b1", "autre avis"))).toBe(false);
  });

  it("retains occurrence identity when different long contexts share truncated judge input", async () => {
    mocks.prisma.sentimentJudgment.findMany.mockImplementation(cachedAs({ sentiment: "NEUTRAL", score: 0 }));
    const prefix = "x".repeat(400);
    const result = await judgeSentiment([
      { entityId: "b1", entityName: "Acme", context: `${prefix} positive` },
      { entityId: "b1", entityName: "Acme", context: `${prefix} negative` },
    ], { userId: "u1" });
    expect(result.size).toBe(2);
    const [{ where }] = mocks.prisma.sentimentJudgment.findMany.mock.calls[0];
    expect(where.cacheKey.in).toHaveLength(1);
  });
});

describe("sentimentKey", () => {
  it("is deterministic, whitespace-normalized and includes entity identity", () => {
    expect(sentimentKey("b1", " nice  product ")).toBe(sentimentKey("b1", "nice product"));
    expect(sentimentKey("b1", "nice product")).not.toBe(sentimentKey("b2", "nice product"));
    expect(sentimentKey("b1", "nice product")).not.toBe(sentimentKey("b1", "poor product"));
  });

  it("does not collide on separators or expose context text in its key", () => {
    expect(sentimentKey("a|b", "c")).not.toBe(sentimentKey("a", "b|c"));
    expect(sentimentKey("b1", "private context")).toMatch(/^[a-f0-9]{64}$/);
  });
});

/**
 * The judge spends the user's key against the provider's quota, so it answers to
 * the same bucket the samples do. It used to be the one paid call no throttle
 * could see.
 */
describe("judgeSentiment rate limiting", () => {
  it("fences cache writes after a provider call and propagates stale ownership", async () => {
    mocks.runQuery.mockResolvedValue({ text: '[{"index":0,"sentiment":"POSITIVE","score":0.5,"confidence":0.9}]' });
    mocks.assertLease.mockRejectedValue(new LostLease("job1"));
    await expect(judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "bien" }], {
      userId: "u1", lease: { id: "job1", lockedBy: "old", leaseVersion: 1, runId: "r1" },
    })).rejects.toBeInstanceOf(LostLease);
    expect(mocks.prisma.sentimentJudgment.createMany).not.toHaveBeenCalled();
  });

  it("checks ownership before and after a transactional cache write", async () => {
    mocks.runQuery.mockResolvedValue({ text: '[{"index":0,"sentiment":"POSITIVE","score":0.5,"confidence":0.9}]' });
    await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "bien" }], {
      userId: "u1", lease: { id: "job1", lockedBy: "owner", leaseVersion: 1, runId: "r1" },
    });
    expect(mocks.assertLease).toHaveBeenCalledTimes(2);
    expect(mocks.assertLease.mock.invocationCallOrder[0]).toBeLessThan(mocks.prisma.sentimentJudgment.createMany.mock.invocationCallOrder[0]);
    expect(mocks.prisma.sentimentJudgment.createMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.assertLease.mock.invocationCallOrder[1]);
  });

  it("charges the provider bucket before spending a call", async () => {
    mocks.runQuery.mockResolvedValue({
      text: '[{"index":0,"sentiment":"POSITIVE","score":0.5,"confidence":0.9}]',
    });

    await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "bien" }], {
      userId: "u1",
    });

    expect(mocks.tryConsume).toHaveBeenCalledWith("provider:openai");
    const consumedAt = mocks.tryConsume.mock.invocationCallOrder[0];
    const calledAt = mocks.runQuery.mock.invocationCallOrder[0];
    expect(consumedAt).toBeLessThan(calledAt);
  });

  it("skips sentiment instead of spending when the bucket is empty", async () => {
    mocks.tryConsume.mockResolvedValue(false);

    const result = await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "bien" }], {
      userId: "u1",
    });

    expect(mocks.runQuery).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
    // Being turned away must not poison the cache with a verdict nobody made.
    expect(mocks.prisma.sentimentJudgment.createMany).not.toHaveBeenCalled();
  });

  it("does not charge the bucket when every mention is already cached", async () => {
    mocks.prisma.sentimentJudgment.findMany.mockImplementation(
      cachedAs({ sentiment: "POSITIVE", score: 0.8 })
    );

    await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "excellent" }], {
      userId: "u1",
    });

    expect(mocks.tryConsume).not.toHaveBeenCalled();
  });
});
