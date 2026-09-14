import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = {
    project: { findUnique: vi.fn(), update: vi.fn() },
    run: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    runSample: { count: vi.fn(), findMany: vi.fn() },
    sampleScore: { count: vi.fn(), groupBy: vi.fn() },
    runTask: { findMany: vi.fn() }, taskScore: { findMany: vi.fn() }, runScore: { findMany: vi.fn() },
    job: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    $transaction: vi.fn(),
  };
  return { db, enqueue: vi.fn(), lock: vi.fn(), reserve: vi.fn() };
});
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("@/lib/queue/client", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/lib/runs/limits", () => ({ lockRunOwner: mocks.lock, assertRunAllowance: mocks.reserve,
  getRunLimits: () => ({ MAX_SAMPLES_PER_RUN: 1000 }) }));

import { promoteScoringVersion, rescoreProject, rescoreRun, resolveRunScoringVersion } from "@/lib/scoring/rescore";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.db));
  mocks.db.project.findUnique.mockResolvedValue({ userId: "u1" });
  mocks.db.project.update.mockResolvedValue({});
  mocks.db.run.findUnique.mockResolvedValue({ projectId: "p1" });
  mocks.db.run.findFirst.mockResolvedValue({ status: "COMPLETED", cancelRequestedAt: null });
  mocks.db.run.findMany.mockResolvedValue([{ id: "r1" }]);
  mocks.db.run.count.mockResolvedValue(0);
  mocks.db.runSample.count.mockImplementation(async ({ where }) => where.status === "FAILED" ? 0 : where.scores ? 1 : 3);
  mocks.db.runSample.findMany.mockResolvedValue([{ id: "s1", taskId: "t1", runId: "r1", projectId: "p1" }]);
  mocks.db.sampleScore.count.mockResolvedValue(3);
  mocks.db.sampleScore.groupBy.mockResolvedValue([{ taskId: "t1", _count: { _all: 3 } }]);
  mocks.db.runTask.findMany.mockResolvedValue([{ id: "t1", mode: "PARAMETRIC" }]);
  mocks.db.taskScore.findMany.mockResolvedValue([{ taskId: "t1", rawN: 3, ciMethod: "query-cluster-v1" }]);
  mocks.db.runScore.findMany.mockResolvedValue([{ mode: "PARAMETRIC", rawN: 3, ciMethod: "query-cluster-v1" }]);
  mocks.db.job.findMany.mockResolvedValue([]);
  mocks.db.job.findUnique.mockResolvedValue(null);
  mocks.db.job.count.mockResolvedValue(0);
  mocks.db.job.groupBy.mockResolvedValue([]);
  mocks.enqueue.mockImplementation(async (jobs: unknown[]) => jobs.length);
  mocks.lock.mockResolvedValue(undefined);
  mocks.reserve.mockResolvedValue(undefined);
});

describe("bounded immutable replay", () => {
  it("locks the owner, budgets new jobs and uses permanent sample/version keys", async () => {
    expect(await rescoreRun("r1", "v3")).toMatchObject({ jobs: 1, aggregateJobs: 0, eligible: 1 });
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.db.runSample.count.mock.invocationCallOrder[0]);
    expect(mocks.reserve).toHaveBeenCalledWith(mocks.db, "u1", 1, { launchingRun: false });
    expect(mocks.enqueue.mock.calls[0][0][0]).toMatchObject({ dedupeKey: "rescore:s1:v3", kind: "RESCORE_SAMPLE", sampleId: null });
    expect(mocks.db.runSample.findMany.mock.calls[0][0].where).toMatchObject({ status: "COMPLETED", scores: { none: { scoringVersion: "v3" } } });
  });

  it("does not reserve duplicate jobs", async () => {
    mocks.db.job.findMany.mockResolvedValue([{ dedupeKey: "rescore:s1:v3", status: "QUEUED" }]);
    expect(await rescoreRun("r1", "v3")).toMatchObject({ jobs: 0, alreadyScheduled: 1 });
    expect(mocks.reserve).toHaveBeenCalledWith(mocks.db, "u1", 0, { launchingRun: false });
    expect(mocks.enqueue.mock.calls[0][0]).toEqual([]);
  });

  it.each(["FAILED", "DEAD", "CANCELLED", "SUCCEEDED"])("returns a conflict for a terminal missing-score target: %s", async (status) => {
    mocks.db.job.findMany.mockResolvedValue([{ dedupeKey: "rescore:s1:v3", status }]);
    await expect(rescoreRun("r1", "v3")).rejects.toMatchObject({ status: 409 });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("checks cardinality before fetching/materializing jobs", async () => {
    mocks.db.runSample.count.mockImplementation(async ({ where }) => where.scores ? 1001 : 0);
    await expect(rescoreRun("r1", "v3")).rejects.toMatchObject({ status: 429 });
    expect(mocks.db.runSample.findMany).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each(["RUNNING", "CANCELLING", "CANCELLED"])("does not enqueue an in-flight/cancelled run: %s", async (status) => {
    mocks.db.run.findFirst.mockResolvedValue({ status, cancelRequestedAt: status === "CANCELLED" ? new Date() : null });
    await expect(rescoreRun("r1", "v3")).rejects.toThrow();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("reports raw-but-analysis-failed responses as excluded, not repaired", async () => {
    mocks.db.runSample.count.mockImplementation(async ({ where }) => where.status === "FAILED" ? 2 : 0);
    mocks.db.run.findMany.mockResolvedValue([]);
    await expect(rescoreRun("r1", "v3")).rejects.toMatchObject({ status: 409, publicMessage: expect.stringContaining("2 réponse(s) brute(s)") });
  });
});

describe("atomic version readiness", () => {
  it("promotes only complete raw populations and aggregates", async () => {
    await promoteScoringVersion("p1", "v3");
    expect(mocks.db.project.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { activeScoringVersion: "v3" } });
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.db.job.count.mock.invocationCallOrder[0]);
  });

  it("ignores superseded migration duplicates with null dedupe keys", async () => {
    const jobs = [{ dedupeKey: "rescore:s1:v3", status: "SUCCEEDED" }, { dedupeKey: null, status: "CANCELLED" }];
    mocks.db.job.count.mockImplementation(async ({ where }) => jobs.filter((job) =>
      (where.dedupeKey?.not !== null || job.dedupeKey !== null) && job.status !== where.status.not).length);
    await promoteScoringVersion("p1", "v3");
    expect(mocks.db.project.update).toHaveBeenCalledTimes(1);
    expect(mocks.db.job.count.mock.calls[0][0].where.runId).toEqual({ in: ["r1"] });
  });

  it("preserves the active version after any pending or failed canonical replay", async () => {
    mocks.db.job.count.mockResolvedValue(1);
    await expect(promoteScoringVersion("p1", "v3")).rejects.toMatchObject({ status: 409 });
    expect(mocks.db.project.update).not.toHaveBeenCalled();
  });

  it.each(["sample", "task", "run", "method"])("does not promote a stale or partial %s population", async (scope) => {
    if (scope === "sample") mocks.db.sampleScore.count.mockResolvedValue(2);
    if (scope === "task") mocks.db.taskScore.findMany.mockResolvedValue([{ taskId: "t1", rawN: 2, ciMethod: "query-cluster-v1" }]);
    if (scope === "run") mocks.db.runScore.findMany.mockResolvedValue([{ mode: "PARAMETRIC", rawN: 2, ciMethod: "query-cluster-v1" }]);
    if (scope === "method") mocks.db.runScore.findMany.mockResolvedValue([{ mode: "PARAMETRIC", rawN: 3, ciMethod: "legacy-pooled-bootstrap" }]);
    await expect(promoteScoringVersion("p1", "v3")).rejects.toMatchObject({ status: 409 });
    expect(await resolveRunScoringVersion({ id: "r1", scoringVersion: "v2" }, "v3")).toBe("v2");
    expect(mocks.db.project.update).not.toHaveBeenCalled();
  });

  it("requires the task method too, even when raw counts are complete", async () => {
    mocks.db.taskScore.findMany.mockResolvedValue([{ taskId: "t1", rawN: 3, ciMethod: "percentile_bootstrap_b2000" }]);
    await expect(promoteScoringVersion("p1", "v3")).rejects.toMatchObject({ status: 409 });
  });
});

describe("aggregation-only method refresh", () => {
  beforeEach(() => {
    mocks.db.runSample.count.mockImplementation(async ({ where }) => where.status === "FAILED" || where.scores ? 0 : 3);
    mocks.db.runScore.findMany.mockResolvedValue([{ mode: "PARAMETRIC", rawN: 3, ciMethod: "legacy-pooled-bootstrap" }]);
  });

  it("rebuilds legacy full-count aggregates using a new method key without buying new answers", async () => {
    expect(await rescoreRun("r1", "v3")).toMatchObject({ jobs: 1, aggregateJobs: 1, eligible: 0 });
    expect(mocks.enqueue.mock.calls[0][0]).toEqual([expect.objectContaining({ kind: "AGGREGATE_RUN", dedupeKey: "aggregate-run:r1:v3:query-cluster-v1" })]);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.db.runSample.findMany).not.toHaveBeenCalled();
    expect(mocks.db.job.findUnique).toHaveBeenCalledWith({ where: { dedupeKey: "aggregate-run:r1:v3:query-cluster-v1" }, select: { status: true } });
    expect(mocks.enqueue.mock.calls[0][0][0].payload.promoteVersion).toBe(true);
  });

  it("switches back to original v3 from active v2 immediately when v3 is complete", async () => {
    mocks.db.project.findUnique.mockResolvedValue({ userId: "u1", activeScoringVersion: "v2" });
    mocks.db.run.findFirst.mockResolvedValue({ status: "COMPLETED", cancelRequestedAt: null, scoringVersion: "v3" });
    mocks.db.runScore.findMany.mockResolvedValue([{ mode: "PARAMETRIC", rawN: 3, ciMethod: "query-cluster-v1" }]);
    expect(await rescoreRun("r1", "v3")).toMatchObject({ jobs: 0, promoted: true });
    expect(mocks.db.project.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { activeScoringVersion: "v3" } });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("does not pretend to repair a terminal modern aggregation silently", async () => {
    mocks.db.job.findUnique.mockResolvedValue({ status: "SUCCEEDED" });
    await expect(rescoreRun("r1", "v3")).rejects.toMatchObject({ status: 409 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("waits for canonical replay completion on a second request after all scores were persisted", async () => {
    mocks.db.job.groupBy.mockResolvedValue([{ status: "RUNNING", _count: { _all: 1 } }]);
    expect(await rescoreRun("r1", "v3")).toMatchObject({ jobs: 0, aggregateJobs: 0, alreadyScheduled: 1, promoted: false });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.db.project.update).not.toHaveBeenCalled();
    expect(mocks.db.job.groupBy.mock.calls[0][0].where).toMatchObject({ runId: "r1", dedupeKey: { not: null },
      payload: { path: ["targetScoringVersion"], equals: "v3" } });
  });

  it("rejects a terminal failed canonical replay even when its score was persisted", async () => {
    mocks.db.job.groupBy.mockResolvedValue([{ status: "DEAD", _count: { _all: 1 } }]);
    await expect(rescoreRun("r1", "v3")).rejects.toMatchObject({ status: 409 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("schedules a mixed project replay and its other legacy aggregate in one operation", async () => {
    mocks.db.run.findMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
    mocks.db.runSample.count.mockImplementation(async ({ where }) => where.status === "FAILED" ? 0 : where.scores ? 1 : 3);
    expect(await rescoreProject("p1", "v3")).toMatchObject({ jobs: 2, aggregateJobs: 1, eligible: 1 });
    const jobs = mocks.enqueue.mock.calls.flatMap(([batch]) => batch);
    expect(jobs).toEqual([
      expect.objectContaining({ kind: "RESCORE_SAMPLE", runId: "r1" }),
      expect.objectContaining({ kind: "AGGREGATE_RUN", dedupeKey: "aggregate-run:r2:v3:query-cluster-v1" }),
    ]);
    expect(mocks.reserve).toHaveBeenCalledWith(mocks.db, "u1", 1, { launchingRun: false });
  });
});
