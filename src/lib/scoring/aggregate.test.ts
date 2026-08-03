process.env.LOG_LEVEL = "error";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SampleStatus } from "@prisma/client";

const mocks = vi.hoisted(() => {
  const tx = {
    runTask: { updateMany: vi.fn() },
    run: { update: vi.fn() },
    voiceShare: { deleteMany: vi.fn(), createMany: vi.fn() },
  };
  return {
    tx,
    prisma: {
      runTask: { findUnique: vi.fn(), findMany: vi.fn() },
      runSample: { groupBy: vi.fn() },
      sampleScore: { findMany: vi.fn() },
      taskScore: { upsert: vi.fn() },
      run: { findUnique: vi.fn(), updateMany: vi.fn() },
      runScore: { upsert: vi.fn() },
      brand: { findMany: vi.fn() },
      competitor: { findMany: vi.fn() },
      brandMention: { findMany: vi.fn() },
      competitorMention: { findMany: vi.fn() },
      citation: { findMany: vi.fn() },
      $transaction: vi.fn(),
    },
    enqueue: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/queue/client", () => ({ enqueue: mocks.enqueue }));

import { aggregateRun, aggregateTask } from "@/lib/scoring/aggregate";
import { seedFor } from "@/lib/scoring/stats";

const VERSION = "v2";

/** Shapes a `groupBy(["status"])` result from a plain status tally. */
function statusRows(counts: Partial<Record<SampleStatus, number>>) {
  return Object.entries(counts).map(([status, n]) => ({
    status: status as SampleStatus,
    _count: { _all: n },
  }));
}

function sampleScores(scores: number[], taskId = "t1") {
  return scores.map((score, index) => ({
    sampleId: `${taskId}-s${index}`,
    taskId,
    score,
    brandPresent: score > 0,
  }));
}

/** The row a `TaskScore`/`RunScore` upsert would create. */
function created(call: unknown[]): Record<string, unknown> {
  return (call[0] as { create: Record<string, unknown> }).create;
}

function updatedStatus(call: unknown[]): unknown {
  return (call[0] as { data: { status: unknown } }).data.status;
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(mocks.tx)
  );
  mocks.tx.runTask.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.run.update.mockResolvedValue({ pendingTasks: 2, projectId: "p1" });
  mocks.tx.voiceShare.deleteMany.mockResolvedValue({ count: 0 });
  mocks.tx.voiceShare.createMany.mockResolvedValue({ count: 0 });

  mocks.prisma.runTask.findUnique.mockResolvedValue({
    id: "t1",
    runId: "r1",
    projectId: "p1",
    mode: "PARAMETRIC",
  });
  mocks.prisma.runTask.findMany.mockResolvedValue([
    { id: "t1", mode: "PARAMETRIC" },
    { id: "t2", mode: "GROUNDED" },
  ]);
  mocks.prisma.sampleScore.findMany.mockResolvedValue(sampleScores([40, 55, 70]));
  mocks.prisma.runSample.groupBy.mockResolvedValue(statusRows({ COMPLETED: 3 }));
  mocks.prisma.taskScore.upsert.mockResolvedValue({});

  mocks.prisma.run.findUnique.mockResolvedValue({ id: "r1", projectId: "p1", status: "RUNNING" });
  mocks.prisma.run.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.runScore.upsert.mockResolvedValue({});
  mocks.prisma.brand.findMany.mockResolvedValue([{ id: "b1", name: "Acme", domain: "acme.fr" }]);
  mocks.prisma.competitor.findMany.mockResolvedValue([
    { id: "c1", name: "Rivale", domain: "rivale.fr" },
  ]);
  mocks.prisma.brandMention.findMany.mockResolvedValue([]);
  mocks.prisma.competitorMention.findMany.mockResolvedValue([]);
  mocks.prisma.citation.findMany.mockResolvedValue([]);
});

describe("aggregateTask", () => {
  it("closes a task whose samples all succeeded as COMPLETED", async () => {
    mocks.prisma.runSample.groupBy.mockResolvedValue(statusRows({ COMPLETED: 3 }));

    await aggregateTask("t1", VERSION);

    expect(updatedStatus(mocks.tx.runTask.updateMany.mock.calls[0])).toBe("COMPLETED");
    expect(created(mocks.prisma.taskScore.upsert.mock.calls[0]).nFailed).toBe(0);
  });

  it("closes a task with some failed samples as PARTIAL", async () => {
    mocks.prisma.sampleScore.findMany.mockResolvedValue(sampleScores([40, 55]));
    mocks.prisma.runSample.groupBy.mockResolvedValue(statusRows({ COMPLETED: 2, FAILED: 1 }));

    await aggregateTask("t1", VERSION);

    expect(updatedStatus(mocks.tx.runTask.updateMany.mock.calls[0])).toBe("PARTIAL");
    const row = created(mocks.prisma.taskScore.upsert.mock.calls[0]);
    expect(row.n).toBe(2);
    expect(row.nFailed).toBe(1);
  });

  it("closes a task whose every sample failed as FAILED, with no score row", async () => {
    mocks.prisma.sampleScore.findMany.mockResolvedValue([]);
    mocks.prisma.runSample.groupBy.mockResolvedValue(statusRows({ FAILED: 3 }));

    await aggregateTask("t1", VERSION);

    expect(updatedStatus(mocks.tx.runTask.updateMany.mock.calls[0])).toBe("FAILED");
    expect(mocks.prisma.taskScore.upsert).not.toHaveBeenCalled();
  });

  it("closes a task nothing was ever asked of as CANCELLED", async () => {
    mocks.prisma.sampleScore.findMany.mockResolvedValue([]);
    mocks.prisma.runSample.groupBy.mockResolvedValue(statusRows({ CANCELLED: 3 }));

    await aggregateTask("t1", VERSION);

    expect(updatedStatus(mocks.tx.runTask.updateMany.mock.calls[0])).toBe("CANCELLED");
  });

  it("seeds the interval from the task identity alone", async () => {
    await aggregateTask("t1", VERSION);

    expect(created(mocks.prisma.taskScore.upsert.mock.calls[0]).bootstrapSeed).toBe(
      seedFor(["t1", "PARAMETRIC", VERSION])
    );
  });

  it("produces the same interval every time the same task is aggregated", async () => {
    await aggregateTask("t1", VERSION);
    await aggregateTask("t1", VERSION);

    const [first, second] = mocks.prisma.taskScore.upsert.mock.calls.map(created);
    expect(second.bootstrapSeed).toBe(first.bootstrapSeed);
    expect(second.median).toBe(first.median);
    expect(second.ciLow).toBe(first.ciLow);
    expect(second.ciHigh).toBe(first.ciHigh);
  });

  it("keeps the seed independent of the measured values", async () => {
    await aggregateTask("t1", VERSION);
    mocks.prisma.sampleScore.findMany.mockResolvedValue(sampleScores([1, 2, 99]));
    await aggregateTask("t1", VERSION);

    const [first, second] = mocks.prisma.taskScore.upsert.mock.calls.map(created);
    expect(second.bootstrapSeed).toBe(first.bootstrapSeed);
    expect(second.median).not.toBe(first.median);
  });

  it("gives two different tasks two different seeds", async () => {
    await aggregateTask("t1", VERSION);
    mocks.prisma.runTask.findUnique.mockResolvedValue({
      id: "t2",
      runId: "r1",
      projectId: "p1",
      mode: "GROUNDED",
    });
    await aggregateTask("t2", VERSION);

    const [first, second] = mocks.prisma.taskScore.upsert.mock.calls.map(created);
    expect(second.bootstrapSeed).not.toBe(first.bootstrapSeed);
  });

  it("hands the run over to aggregation once the last task lands", async () => {
    mocks.tx.run.update.mockResolvedValue({ pendingTasks: 0, projectId: "p1" });

    await aggregateTask("t1", VERSION);

    const [jobs, tx] = mocks.enqueue.mock.calls[0];
    expect(jobs[0]).toMatchObject({
      kind: "AGGREGATE_RUN",
      runId: "r1",
      providerCode: "internal",
      payload: { runId: "r1", scoringVersion: VERSION },
    });
    expect(tx).toBe(mocks.tx);
  });

  it("counts a task down only once, whatever the number of aggregations", async () => {
    mocks.tx.runTask.updateMany.mockResolvedValue({ count: 0 });

    await aggregateTask("t1", VERSION);

    expect(mocks.tx.run.update).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("does nothing when the task is gone", async () => {
    mocks.prisma.runTask.findUnique.mockResolvedValue(null);

    await aggregateTask("t1", VERSION);

    expect(mocks.prisma.taskScore.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("aggregateRun", () => {
  const twoModes = [...sampleScores([40, 60], "t1"), ...sampleScores([70, 90], "t2")];

  beforeEach(() => {
    mocks.prisma.sampleScore.findMany.mockResolvedValue(twoModes);
    mocks.prisma.runSample.groupBy.mockResolvedValue(statusRows({ COMPLETED: 4 }));
  });

  it("scores each sampling mode separately and never pools them", async () => {
    await aggregateRun("r1", VERSION);

    expect(mocks.prisma.runScore.upsert).toHaveBeenCalledTimes(2);
    const rows = mocks.prisma.runScore.upsert.mock.calls.map(created);
    expect(rows.map((row) => row.mode).sort()).toEqual(["GROUNDED", "PARAMETRIC"]);
    for (const row of rows) {
      expect(row.n).toBe(2);
      expect(row.runId).toBe("r1");
    }
    const parametric = rows.find((row) => row.mode === "PARAMETRIC");
    const grounded = rows.find((row) => row.mode === "GROUNDED");
    expect(parametric?.median).toBe(50);
    expect(grounded?.median).toBe(80);
  });

  it("seeds each mode from the run identity and the mode", async () => {
    await aggregateRun("r1", VERSION);

    const rows = mocks.prisma.runScore.upsert.mock.calls.map(created);
    for (const row of rows) {
      expect(row.bootstrapSeed).toBe(seedFor(["r1", String(row.mode), VERSION]));
    }
    expect(rows[0].bootstrapSeed).not.toBe(rows[1].bootstrapSeed);
  });

  it("closes a run whose samples all succeeded as COMPLETED", async () => {
    await aggregateRun("r1", VERSION);

    expect(updatedStatus(mocks.prisma.run.updateMany.mock.calls[0])).toBe("COMPLETED");
  });

  it("closes a run with some failed samples as PARTIAL", async () => {
    mocks.prisma.runSample.groupBy.mockResolvedValue(statusRows({ COMPLETED: 3, FAILED: 1 }));

    await aggregateRun("r1", VERSION);

    expect(updatedStatus(mocks.prisma.run.updateMany.mock.calls[0])).toBe("PARTIAL");
  });

  it("closes a run whose every sample failed as FAILED", async () => {
    mocks.prisma.sampleScore.findMany.mockResolvedValue([]);
    mocks.prisma.runSample.groupBy.mockResolvedValue(statusRows({ FAILED: 4 }));

    await aggregateRun("r1", VERSION);

    expect(updatedStatus(mocks.prisma.run.updateMany.mock.calls[0])).toBe("FAILED");
    expect(mocks.prisma.runScore.upsert).not.toHaveBeenCalled();
  });

  it("closes a run the user cancelled as CANCELLED, whatever the samples did", async () => {
    mocks.prisma.run.findUnique.mockResolvedValue({
      id: "r1",
      projectId: "p1",
      status: "CANCELLING",
    });
    mocks.prisma.runSample.groupBy.mockResolvedValue(statusRows({ COMPLETED: 3, CANCELLED: 1 }));

    await aggregateRun("r1", VERSION);

    expect(updatedStatus(mocks.prisma.run.updateMany.mock.calls[0])).toBe("CANCELLED");
    expect(mocks.prisma.runScore.upsert).toHaveBeenCalledTimes(2);
  });

  it("replaces the shares of voice per mode, at run and task grain", async () => {
    mocks.prisma.brandMention.findMany.mockResolvedValue([
      { sampleId: "t1-s0", brandId: "b1", orderRank: 1 },
    ]);
    mocks.prisma.competitorMention.findMany.mockResolvedValue([
      { sampleId: "t1-s0", competitorId: "c1", orderRank: 2 },
    ]);
    mocks.prisma.citation.findMany.mockResolvedValue([
      { sampleId: "t1-s0", domain: "www.acme.fr" },
    ]);

    await aggregateRun("r1", VERSION);

    expect(mocks.tx.voiceShare.deleteMany).toHaveBeenCalledWith({
      where: { runId: "r1", scoringVersion: VERSION },
    });

    const rows = mocks.tx.voiceShare.createMany.mock.calls[0][0].data as {
      taskId: string | null;
      mode: string;
      entityKind: string;
      entityId: string;
      citationShare: number;
    }[];

    const runGrain = rows.filter((row) => row.taskId === null);
    expect(runGrain.map((row) => row.mode).sort()).toEqual([
      "GROUNDED",
      "GROUNDED",
      "PARAMETRIC",
      "PARAMETRIC",
    ]);
    expect(rows.some((row) => row.taskId === "t1")).toBe(true);

    const brandParametric = runGrain.find(
      (row) => row.mode === "PARAMETRIC" && row.entityKind === "BRAND"
    );
    expect(brandParametric?.citationShare).toBe(1);
  });

  it("does nothing when the run is gone", async () => {
    mocks.prisma.run.findUnique.mockResolvedValue(null);

    await aggregateRun("r1", VERSION);

    expect(mocks.prisma.runScore.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.run.updateMany).not.toHaveBeenCalled();
  });
});
