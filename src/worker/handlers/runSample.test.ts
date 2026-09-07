process.env.LOG_LEVEL = "error";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/errors";
import type { ClaimedJob } from "@/lib/queue/types";

const mocks = vi.hoisted(() => {
  const tx = {
    runSample: { findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    aIResponse: { create: vi.fn() }, sampleScore: { findUnique: vi.fn() },
    runTask: { update: vi.fn() }, run: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    project: { findUniqueOrThrow: vi.fn() }, provider: { findUniqueOrThrow: vi.fn() },
    providerCredential: { findUnique: vi.fn(), updateMany: vi.fn() },
    job: { update: vi.fn() }, auditLog: { create: vi.fn() }, $queryRaw: vi.fn(),
  };
  return { tx, prisma: { ...tx, $transaction: vi.fn() },
    runQuery: vi.fn(), tryConsume: vi.fn(), complete: vi.fn(), fail: vi.fn(),
    release: vi.fn(), enqueue: vi.fn(), assertLease: vi.fn(), persistSampleAnalysis: vi.fn(),
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/providers/registry", () => ({
  getProvider: (code: string) => code === "ghost" ? undefined : { runQuery: mocks.runQuery },
}));
vi.mock("@/lib/crypto/credentials", () => ({ decryptCredential: () => "sk-test" }));
vi.mock("@/lib/queue/ratelimit", () => ({ tryConsume: mocks.tryConsume, bucketKeyForProvider: (code: string) => code }));
vi.mock("@/lib/queue/client", () => ({
  SQL_NOW: "now()", complete: mocks.complete, fail: mocks.fail, release: mocks.release,
  enqueue: mocks.enqueue, assertLease: mocks.assertLease,
  LostLease: class LostLease extends Error {},
}));
vi.mock("@/lib/runs/persist", () => ({ persistSampleAnalysis: mocks.persistSampleAnalysis }));
import { LostLease } from "@/lib/queue/client";
import { runSampleHandler } from "@/worker/handlers/runSample";

const payload = {
  sampleId: "s1", taskId: "t1", runId: "r1", projectId: "pr1", queryText: "CRM",
  providerCode: "openai", mode: "PARAMETRIC" as const, locale: { country: "FR", language: "fr" },
  scoringVersion: "v3", extractionVersion: "v2", model: "requested-model",
};
const job = (overrides: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id: "j1", kind: "RUN_SAMPLE", runId: "r1", projectId: "pr1", taskId: "t1",
  sampleId: "s1", providerCode: "openai", attempts: 1, maxAttempts: 4,
  lockedBy: "w1", leaseVersion: 1, payload, ...overrides,
});
const ctx = () => ({ signal: new AbortController().signal, workerId: "w1" });
const answer = {
  text: "Acme", rawJson: { output: [] }, sources: [{ url: "https://acme.fr", kind: "NATIVE" }],
  model: "actual-model", usage: { inputTokens: 10, outputTokens: 20 }, truncated: false,
};
let sample: { id: string; status: string; startedAt: null; response: unknown };
beforeEach(() => {
  vi.resetAllMocks();
  sample = { id: "s1", status: "PENDING", startedAt: null, response: null };
  mocks.prisma.$transaction.mockImplementation(async (fn) => fn(mocks.tx));
  mocks.tx.runSample.findUniqueOrThrow.mockImplementation(async () => sample);
  mocks.tx.runSample.update.mockImplementation(async ({ data }) => Object.assign(sample, data));
  mocks.tx.runSample.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.aIResponse.create.mockImplementation(async ({ data }) => (sample.response = data));
  mocks.tx.runTask.update.mockResolvedValue({ pendingSamples: 0 });
  mocks.tx.run.findUnique.mockResolvedValue({ cancelRequestedAt: null });
  mocks.tx.run.findUniqueOrThrow.mockResolvedValue({ scoringVersion: "v3" });
  mocks.tx.project.findUniqueOrThrow.mockResolvedValue({ userId: "u1" });
  mocks.tx.provider.findUniqueOrThrow.mockResolvedValue({ id: "p1" });
  mocks.tx.providerCredential.findUnique.mockResolvedValue({ id: "key1", providerId: "p1", isValid: true, updatedAt: new Date(0) });
  mocks.tx.providerCredential.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.sampleScore.findUnique.mockResolvedValue({ score: 42 });
  mocks.tx.$queryRaw.mockResolvedValue([{ id: "s1" }]);
  mocks.tryConsume.mockResolvedValue(true);
  mocks.runQuery.mockResolvedValue(answer);
  mocks.fail.mockImplementation(async (lease, error, terminal) => {
    if (error.retryable && lease.attempts < lease.maxAttempts) return "requeued";
    await terminal?.(mocks.tx);
    return "exhausted";
  });
});

describe("runSample fenced durable lifecycle", () => {
  it("persists raw answer and sources before analysis, then completes in terminal transaction", async () => {
    mocks.persistSampleAnalysis.mockImplementation(async () => {
      expect(sample.response).toMatchObject({ rawText: "Acme", providerSources: answer.sources });
      expect(mocks.complete).not.toHaveBeenCalled();
    });
    await runSampleHandler(job(), ctx());
    expect(mocks.tx.aIResponse.create).toHaveBeenCalledTimes(1);
    expect(mocks.runQuery).toHaveBeenCalledWith(expect.objectContaining({ model: "requested-model" }));
    expect(mocks.tx.runSample.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ model: "actual-model", tokensIn: 10 }) }));
    expect(mocks.tx.run.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { doneSamples: { increment: 1 } } });
    expect(mocks.complete).toHaveBeenCalledWith(job(), mocks.tx);
  });
  it("first retryable provider failure does not terminalize; second attempt calls provider again and succeeds once", async () => {
    mocks.runQuery.mockRejectedValueOnce(new ProviderError("SERVER", "openai", "503"));
    await runSampleHandler(job(), ctx());
    expect(mocks.tx.run.update).not.toHaveBeenCalled();
    expect(mocks.tx.aIResponse.create).not.toHaveBeenCalled();
    await runSampleHandler(job({ attempts: 2, leaseVersion: 2 }), ctx());
    expect(mocks.runQuery).toHaveBeenCalledTimes(2);
    expect(mocks.tx.run.update).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it("retries failed analysis from durable raw response without re-paying the provider", async () => {
    mocks.persistSampleAnalysis.mockRejectedValueOnce(new Error("analysis"));
    await runSampleHandler(job(), ctx());
    expect(mocks.fail).toHaveBeenCalledWith(job(), expect.objectContaining({ code: "ANALYSIS", retryable: true }), expect.any(Function));
    expect(mocks.tx.run.update).not.toHaveBeenCalled();
    await runSampleHandler(job({ attempts: 2, leaseVersion: 2 }), ctx());
    expect(mocks.runQuery).toHaveBeenCalledTimes(1);
    expect(mocks.tx.aIResponse.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.run.update).toHaveBeenCalledTimes(1);
  });
  it("exhausted analysis leaves response durable and sample failed, never completed", async () => {
    mocks.persistSampleAnalysis.mockRejectedValue(new Error("analysis"));
    await runSampleHandler(job({ attempts: 4 }), ctx());
    expect(sample.response).not.toBeNull();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.tx.run.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { failedSamples: { increment: 1 } } });
  });
  it("never completes a successful call that produced no SampleScore", async () => {
    mocks.tx.sampleScore.findUnique.mockResolvedValue(null);
    await runSampleHandler(job(), ctx());
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(job(), expect.objectContaining({ code: "ANALYSIS", retryable: true }), expect.any(Function));
  });
  it("rejects lost lease before making any network call", async () => {
    mocks.assertLease.mockRejectedValue(new LostLease("j1"));
    await runSampleHandler(job(), ctx());
    expect(mocks.runQuery).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
  });
  it("does not save a late provider reply after ownership changed", async () => {
    mocks.runQuery.mockImplementation(async () => {
      mocks.assertLease.mockRejectedValue(new LostLease("j1"));
      return answer;
    });
    await runSampleHandler(job(), ctx());
    expect(mocks.tx.aIResponse.create).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
  });
  it("does not terminalize analysis from a stale lease", async () => {
    mocks.persistSampleAnalysis.mockRejectedValue(new LostLease("j1"));
    await runSampleHandler(job(), ctx());
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.tx.run.update).not.toHaveBeenCalled();
  });
  it("returns throttled attempts without touching final counters", async () => {
    mocks.tryConsume.mockResolvedValue(false);
    await runSampleHandler(job(), ctx());
    expect(mocks.release).toHaveBeenCalledWith(job());
    expect(mocks.runQuery).not.toHaveBeenCalled();
    expect(mocks.tx.run.update).not.toHaveBeenCalled();
  });
  it("returns shutdown-aborted leases for immediate pickup", async () => {
    const controller = new AbortController(); controller.abort();
    await runSampleHandler(job(), { signal: controller.signal, workerId: "w1" });
    expect(mocks.release).toHaveBeenCalledWith(job());
    expect(mocks.runQuery).not.toHaveBeenCalled();
  });
  it("cancels the sample and job atomically after cancellation, without release", async () => {
    mocks.tx.run.findUnique.mockResolvedValue({ cancelRequestedAt: new Date() });
    const controller = new AbortController(); controller.abort();
    await runSampleHandler(job(), { signal: controller.signal, workerId: "w1" });
    expect(mocks.tx.runSample.updateMany).toHaveBeenCalled();
    expect(mocks.tx.job.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }));
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it("does not invalidate a credential rotated during the provider call", async () => {
    mocks.runQuery.mockRejectedValue(new ProviderError("AUTH", "openai", "401"));
    mocks.tx.providerCredential.updateMany.mockResolvedValue({ count: 0 });
    await runSampleHandler(job(), ctx());
    expect(mocks.tx.providerCredential.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "key1", updatedAt: new Date(0) } }));
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("terminalizes unreadable payload by authoritative job ids", async () => {
    await runSampleHandler(job({ payload: {} as never }), ctx());
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({ id: "j1" }), expect.objectContaining({ retryable: false }), expect.any(Function));
    expect(mocks.tx.run.update).toHaveBeenCalledTimes(1);
  });
  it("rejects a valid-looking payload pointing at another sample", async () => {
    await runSampleHandler(job({ payload: { ...payload, sampleId: "other-project-sample" } }), ctx());
    expect(mocks.runQuery).not.toHaveBeenCalled();
    expect(mocks.tx.runSample.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({ sampleId: "s1" }), expect.objectContaining({ code: "BAD_REQUEST" }), expect.any(Function));
  });
});
