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
  },
  runQuery: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/providers/registry", () => ({
  getProvider: (code: string) => (code === "unknown" ? undefined : { runQuery: mocks.runQuery }),
}));
vi.mock("@/lib/crypto/credentials", () => ({ decryptCredential: () => "sk-test" }));

import { judgeSentiment } from "@/lib/sentiment/judge";

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
    expect(result.get("b1")).toEqual({ sentiment: "POSITIVE", score: 0.8, confidence: 0.9 });
  });

  it("deduplicates contexts that differ only by whitespace", async () => {
    mocks.prisma.sentimentJudgment.findMany.mockImplementation(cachedAs({ sentiment: "NEUTRAL", score: 0 }));

    await judgeSentiment(
      [
        { entityId: "b1", entityName: "Acme", context: "  une   réponse " },
        { entityId: "b1", entityName: "Acme", context: "une réponse" },
      ],
      { userId: "u1" }
    );

    const [{ where }] = mocks.prisma.sentimentJudgment.findMany.mock.calls[0];
    expect(where.cacheKey.in).toHaveLength(1);
  });

  it("keeps the most negative verdict when contexts disagree", async () => {
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

    expect(result.get("b1")?.sentiment).toBe("NEGATIVE");
  });

  it("prefers MIXED over NEUTRAL — a split opinion is not an endorsement", async () => {
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

    expect(result.get("b1")?.sentiment).toBe("MIXED");
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

    expect(result.get("b1")).toEqual({ sentiment: "NEGATIVE", score: -1, confidence: 1 });
    const [{ data }] = mocks.prisma.sentimentJudgment.createMany.mock.calls[0];
    expect(data).toHaveLength(1);
    expect(data[0].judgeVersion).toBe("judge-v1");
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

  it("ignores a verdict pointing at an item that was never sent", async () => {
    mocks.runQuery.mockResolvedValue({
      text: '[{"index":7,"sentiment":"POSITIVE","score":1,"confidence":1}]',
    });

    const result = await judgeSentiment([{ entityId: "b1", entityName: "Acme", context: "bien" }], {
      userId: "u1",
    });

    expect(result.size).toBe(0);
  });
});
