import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { runSample: { findUnique: vi.fn(), count: vi.fn() }, project: { findUnique: vi.fn() },
    sampleScore: { count: vi.fn() }, job: { count: vi.fn() }, $transaction: vi.fn() },
  assertLease: vi.fn(), complete: vi.fn(), enqueue: vi.fn(), fail: vi.fn(), persist: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("@/lib/queue/client", () => ({ assertLease: mocks.assertLease, complete: mocks.complete,
  enqueue: mocks.enqueue, fail: mocks.fail, LostLease: class extends Error {} }));
vi.mock("@/lib/runs/persist", () => ({ persistSampleAnalysis: mocks.persist }));
vi.mock("@/lib/runs/snapshots", () => ({ responseSources: () => [] }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { rescoreSampleHandler } from "@/worker/handlers/rescoreSample";

const job = { id: "current-job", runId: "r1", taskId: "t1", projectId: "p1",
  lockedBy: "worker", leaseVersion: 1, payload: { sampleId: "s1", taskId: "t1", runId: "r1", projectId: "p1",
    targetScoringVersion: "v3", targetExtractionVersion: "v2" },
} as unknown as Parameters<typeof rescoreSampleHandler>[0];
const context = { signal: new AbortController().signal } as Parameters<typeof rescoreSampleHandler>[1];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.db));
  mocks.db.runSample.findUnique.mockResolvedValue({ id: "s1", taskId: "t1", runId: "r1", projectId: "p1",
    response: { rawText: "stored answer", rawJson: {}, providerSources: [] },
    task: { mode: "PARAMETRIC", provider: { code: "mock" } } });
  mocks.db.project.findUnique.mockResolvedValue({ userId: "u1" });
  mocks.db.runSample.count.mockResolvedValue(3);
  mocks.db.sampleScore.count.mockResolvedValue(3);
  mocks.db.job.count.mockResolvedValue(0);
  mocks.assertLease.mockResolvedValue(undefined);
  mocks.complete.mockResolvedValue(undefined);
  mocks.persist.mockResolvedValue(undefined);
  mocks.enqueue.mockResolvedValue(1);
});

describe("replay promotion completion barrier", () => {
  it("does not consume the aggregate key while a sibling is still RUNNING despite complete scores", async () => {
    mocks.db.job.count.mockResolvedValue(1);
    await rescoreSampleHandler(job, context);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(job, mocks.db);
    expect(mocks.db.job.count.mock.calls[0][0].where).toMatchObject({
      id: { not: "current-job" }, dedupeKey: { not: null }, status: { not: "SUCCEEDED" },
      payload: { path: ["targetScoringVersion"], equals: "v3" },
    });
  });

  it("lets the last finisher enqueue exactly one modern run aggregation and complete atomically", async () => {
    await rescoreSampleHandler(job, context);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({
      kind: "AGGREGATE_RUN", dedupeKey: "aggregate-run:r1:v3:query-cluster-v1",
      payload: { runId: "r1", scoringVersion: "v3", promoteVersion: true },
    })], mocks.db);
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(job, mocks.db);
    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(mocks.complete.mock.invocationCallOrder[0]);
    expect(mocks.assertLease.mock.invocationCallOrder[1]).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0]);
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("does not aggregate missing target scores even when all sibling jobs have finished", async () => {
    mocks.db.sampleScore.count.mockResolvedValue(2);
    await rescoreSampleHandler(job, context);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(job, mocks.db);
  });
});
