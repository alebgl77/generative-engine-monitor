process.env.LOG_LEVEL = "error";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors";
import type { ClaimedJob } from "@/lib/queue/types";

const mocks = vi.hoisted(() => {
  const tx = {
    aIResponse: { upsert: vi.fn() },
    run: { update: vi.fn() },
    $queryRaw: vi.fn(),
  };
  return {
    tx,
    txResults: [] as unknown[],
    prisma: {
      runSample: { updateMany: vi.fn() },
      project: { findUnique: vi.fn() },
      provider: { findUnique: vi.fn() },
      providerCredential: { findUnique: vi.fn(), update: vi.fn() },
      run: { findUnique: vi.fn(), update: vi.fn() },
      $queryRaw: vi.fn(),
      $transaction: vi.fn(),
    },
    runQuery: vi.fn(),
    tryConsume: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    release: vi.fn(),
    enqueue: vi.fn(),
    recordAudit: vi.fn(),
    persistSampleAnalysis: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/providers/registry", () => ({
  getProvider: (code: string) => (code === "ghost" ? undefined : { runQuery: mocks.runQuery }),
}));
vi.mock("@/lib/crypto/credentials", () => ({ decryptCredential: () => "sk-live" }));
vi.mock("@/lib/queue/ratelimit", () => ({
  tryConsume: mocks.tryConsume,
  bucketKeyForProvider: (code: string) => `provider:${code}`,
}));
vi.mock("@/lib/queue/client", () => ({
  SQL_NOW: "now()",
  complete: mocks.complete,
  fail: mocks.fail,
  release: mocks.release,
  enqueue: mocks.enqueue,
}));
vi.mock("@/lib/runs/persist", () => ({ persistSampleAnalysis: mocks.persistSampleAnalysis }));
vi.mock("@/lib/audit", () => ({
  recordAudit: mocks.recordAudit,
  AUDIT_ACTIONS: { CREDENTIAL_INVALIDATE: "credential.invalidate" },
}));

import { runSampleHandler } from "@/worker/handlers/runSample";

const payload = {
  sampleId: "s1",
  taskId: "t1",
  runId: "r1",
  projectId: "pr1",
  queryText: "meilleur crm",
  providerCode: "openai",
  mode: "PARAMETRIC" as const,
  locale: { country: "FR", language: "fr" },
  scoringVersion: "v2",
  extractionVersion: "x1",
};

function makeJob(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: "j1",
    kind: "RUN_SAMPLE",
    runId: "r1",
    projectId: "pr1",
    taskId: "t1",
    sampleId: "s1",
    providerCode: "openai",
    attempts: 1,
    maxAttempts: 4,
    payload,
    ...overrides,
  };
}

function context(aborted = false) {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return { signal: controller.signal, workerId: "w1" };
}

const providerResponse = {
  text: "Acme est une bonne option.",
  rawJson: { ok: true },
  sources: [{ url: "https://acme.fr", title: "Acme", kind: "NATIVE" as const }],
  model: "gpt-test",
  finishReason: "completed",
  truncated: false,
  usage: { inputTokens: 10, outputTokens: 20 },
};

/** Queues the rows returned by the two statements of the terminal transaction. */
function txReturns(...results: unknown[]): void {
  mocks.txResults.length = 0;
  mocks.txResults.push(...results);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.txResults.length = 0;

  mocks.tx.$queryRaw.mockImplementation(async () => mocks.txResults.shift() ?? []);
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(mocks.tx)
  );
  mocks.prisma.runSample.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.project.findUnique.mockResolvedValue({ userId: "u1" });
  mocks.prisma.provider.findUnique.mockResolvedValue({ id: "p1" });
  mocks.prisma.providerCredential.findUnique.mockResolvedValue({
    id: "cred1",
    providerId: "p1",
    isValid: true,
  });
  mocks.prisma.run.findUnique.mockResolvedValue({ cancelRequestedAt: null, scoringVersion: "v2" });
  mocks.tryConsume.mockResolvedValue(true);
  mocks.runQuery.mockResolvedValue(providerResponse);
  mocks.persistSampleAnalysis.mockResolvedValue({
    score: 1,
    brandPresent: true,
    mentionCount: 1,
    citationCount: 1,
  });
  txReturns([{ id: "s1" }], [{ pending_samples: 2 }]);
});

describe("runSampleHandler", () => {
  it("returns a throttled job to the queue without failing the sample", async () => {
    mocks.tryConsume.mockResolvedValue(false);

    await runSampleHandler(makeJob(), context());

    expect(mocks.release).toHaveBeenCalledWith("j1");
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.runQuery).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("stores the answer, counts the sample and completes the job", async () => {
    await runSampleHandler(makeJob(), context());

    expect(mocks.tx.aIResponse.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.tx.run.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { doneSamples: { increment: 1 } },
    });
    expect(mocks.persistSampleAnalysis).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith("j1");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("enqueues the task aggregation when the last pending sample lands", async () => {
    txReturns([{ id: "s1" }], [{ pending_samples: 0 }]);

    await runSampleHandler(makeJob(), context());

    const [jobs, tx] = mocks.enqueue.mock.calls[0];
    expect(jobs[0]).toMatchObject({
      kind: "AGGREGATE_TASK",
      taskId: "t1",
      runId: "r1",
      providerCode: "internal",
      payload: { taskId: "t1", runId: "r1", scoringVersion: "v2" },
    });
    expect(tx).toBe(mocks.tx);
  });

  it("does not touch the counters when the sample already reached a terminal state", async () => {
    txReturns([]);

    await runSampleHandler(makeJob(), context());

    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.tx.run.update).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith("j1");
  });

  it("never pays for a sample the run already cancelled", async () => {
    mocks.prisma.runSample.updateMany.mockResolvedValue({ count: 0 });

    await runSampleHandler(makeJob(), context());

    expect(mocks.runQuery).not.toHaveBeenCalled();
    expect(mocks.tryConsume).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith("j1");
  });

  it("keeps the paid answer when the analysis fails", async () => {
    mocks.persistSampleAnalysis.mockRejectedValue(new Error("extraction cassée"));

    await runSampleHandler(makeJob(), context());

    expect(mocks.complete).toHaveBeenCalledWith("j1");
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("fails the sample and keeps the retry budget for a retryable provider error", async () => {
    mocks.runQuery.mockRejectedValue(new ProviderError("SERVER", "openai", "Incident (HTTP 503)"));

    await runSampleHandler(makeJob(), context());

    expect(mocks.tx.run.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { failedSamples: { increment: 1 } },
    });
    expect(mocks.fail).toHaveBeenCalledWith(
      "j1",
      expect.objectContaining({ code: "SERVER", retryable: true })
    );
    expect(mocks.prisma.providerCredential.update).not.toHaveBeenCalled();
    expect(mocks.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("invalidates the key and cancels the rest of that provider's run on AUTH", async () => {
    mocks.runQuery.mockRejectedValue(new ProviderError("AUTH", "openai", "Clé API refusée (HTTP 401)"));
    mocks.prisma.$queryRaw.mockResolvedValue([{ task_id: "t1", pending_samples: 0, n: 2 }]);

    await runSampleHandler(makeJob(), context());

    expect(mocks.prisma.providerCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cred1" },
        data: expect.objectContaining({ isValid: false }),
      })
    );
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "credential.invalidate", targetId: "cred1" })
    );
    expect(mocks.prisma.run.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { failedSamples: { increment: 2 } },
    });
    const [jobs] = mocks.enqueue.mock.calls.at(-1) as [{ kind: string; taskId: string }[]];
    expect(jobs[0]).toMatchObject({ kind: "AGGREGATE_TASK", taskId: "t1" });
    expect(mocks.fail).toHaveBeenCalledWith(
      "j1",
      expect.objectContaining({ code: "AUTH", retryable: false })
    );
  });

  it("fails terminally when no valid credential exists, without calling the provider", async () => {
    mocks.prisma.providerCredential.findUnique.mockResolvedValue(null);

    await runSampleHandler(makeJob(), context());

    expect(mocks.runQuery).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(
      "j1",
      expect.objectContaining({ code: "AUTH", retryable: false })
    );
  });

  it("runs the mock provider without any credential lookup", async () => {
    await runSampleHandler(
      makeJob({ providerCode: "mock", payload: { ...payload, providerCode: "mock" } }),
      context()
    );

    expect(mocks.prisma.providerCredential.findUnique).not.toHaveBeenCalled();
    expect(mocks.runQuery).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "mock" }));
  });

  it("cancels the sample and hands back the job when the run was cancelled", async () => {
    mocks.prisma.run.findUnique.mockResolvedValue({ cancelRequestedAt: new Date() });

    await runSampleHandler(makeJob(), context(true));

    expect(mocks.prisma.runSample.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) })
    );
    expect(mocks.release).toHaveBeenCalledWith("j1");
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.runQuery).not.toHaveBeenCalled();
  });

  it("leaves the sample in flight when the abort came from a shutdown", async () => {
    mocks.prisma.run.findUnique.mockResolvedValue({ cancelRequestedAt: null });

    await runSampleHandler(makeJob(), context(true));

    expect(mocks.prisma.runSample.updateMany).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("mid-call cancellation is not counted as a failure", async () => {
    const controller = new AbortController();
    mocks.prisma.run.findUnique.mockResolvedValue({ cancelRequestedAt: new Date() });
    mocks.runQuery.mockImplementation(async () => {
      controller.abort();
      throw new ProviderError("CANCELLED", "openai", "Requête annulée");
    });

    await runSampleHandler(makeJob(), { signal: controller.signal, workerId: "w1" });

    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith("j1");
  });

  it("closes an unreadable payload instead of stalling the run", async () => {
    await runSampleHandler(makeJob({ payload: { nope: true } as never }), context());

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.fail).toHaveBeenCalledWith(
      "j1",
      expect.objectContaining({ code: "BAD_REQUEST", retryable: false })
    );
  });

  it("fails terminally when the provider code has no implementation", async () => {
    await runSampleHandler(
      makeJob({ providerCode: "ghost", payload: { ...payload, providerCode: "ghost" } }),
      context()
    );

    expect(mocks.fail).toHaveBeenCalledWith(
      "j1",
      expect.objectContaining({ code: "BAD_REQUEST", retryable: false })
    );
  });
});
