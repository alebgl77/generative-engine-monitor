import type { Prisma } from "@prisma/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/lib/queue/client", () => ({ enqueue: mocks.enqueue, SQL_NOW: "clock_timestamp()" }));
import { finalizeSample } from "@/lib/runs/finalize";

it("keeps live task aggregation method-keyed without requesting version promotion", async () => {
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: "s1" }]),
    runTask: { update: vi.fn().mockResolvedValue({ pendingSamples: 0 }) },
    run: { update: vi.fn().mockResolvedValue({}) } } as unknown as Prisma.TransactionClient;
  await finalizeSample(tx, { sampleId: "s1", taskId: "t1", runId: "r1", projectId: "p1", scoringVersion: "v3", succeeded: true });
  expect(mocks.enqueue).toHaveBeenCalledWith([expect.objectContaining({
    kind: "AGGREGATE_TASK", dedupeKey: "aggregate-task:t1:v3:query-cluster-v1",
    payload: { taskId: "t1", runId: "r1", scoringVersion: "v3" },
  })], tx);
});
