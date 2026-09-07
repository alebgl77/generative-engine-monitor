import type { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRunAllowance, getRunLimits, plannedSampleCount, preserveDailyReservation } from "@/lib/runs/limits";

afterEach(() => vi.unstubAllEnvs());

describe("run budget validation", () => {
  it("has bounded production defaults", () => {
    expect(getRunLimits({})).toEqual({ MAX_SAMPLES_PER_RUN: 1000, MAX_SAMPLES_PER_USER_DAY: 10000,
      MAX_ACTIVE_RUNS_PER_USER: 3, MAX_QUERIES_PER_PROJECT: 1000 });
  });
  it.each(["0", "-1", "1.5", "Infinity", "bad", "1000001"])("rejects invalid configured limits %s", (value) => {
    expect(() => getRunLimits({ MAX_SAMPLES_PER_RUN: value })).toThrow();
  });
  it("checks the actual product including repetitions before materialization", () => {
    expect(plannedSampleCount(100, 2, 5)).toBe(1000);
    expect(() => plannedSampleCount(101, 2, 5)).toThrow(/Limite/);
  });
  it.each([0, -1, Infinity, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER])("rejects invalid products %s", (n) => {
    expect(() => plannedSampleCount(n, 2, 3)).toThrow();
  });
});

function allowanceDb(bucket: { capacity: number; tokens: number } | null) {
  return { rateLimitBucket: { findUnique: vi.fn().mockResolvedValue(bucket), upsert: vi.fn().mockResolvedValue({}) },
    project: { findMany: vi.fn().mockResolvedValue([{ id: "p1" }]) },
    runSample: { count: vi.fn().mockResolvedValue(10) }, job: { count: vi.fn().mockResolvedValue(0) },
    run: { count: vi.fn().mockResolvedValue(0) } };
}

describe("conservative reservation transitions", () => {
  it("preserves a legacy floor even above a lowered ceiling before deletion", async () => {
    vi.stubEnv("MAX_SAMPLES_PER_USER_DAY", "5");
    const db = allowanceDb(null);
    await preserveDailyReservation(db as unknown as Prisma.TransactionClient, "u1");
    expect(db.rateLimitBucket.upsert.mock.calls[0][0].create).toMatchObject({ capacity: 5, tokens: -5, refillPerSec: 0 });
  });

  it("does not refill an exhausted established day when the configured ceiling increases", async () => {
    vi.stubEnv("MAX_SAMPLES_PER_USER_DAY", "10");
    const db = allowanceDb({ capacity: 1, tokens: 0 });
    await expect(assertRunAllowance(db as unknown as Prisma.TransactionClient, "u1", 1, { launchingRun: false })).rejects.toMatchObject({ status: 429 });
    expect(db.rateLimitBucket.upsert).not.toHaveBeenCalled();
  });

  it("does not create a reservation for an already-deduplicated request", async () => {
    const db = allowanceDb(null);
    await assertRunAllowance(db as unknown as Prisma.TransactionClient, "u1", 0, { launchingRun: false });
    expect(db.rateLimitBucket.findUnique).not.toHaveBeenCalled();
    expect(db.rateLimitBucket.upsert).not.toHaveBeenCalled();
  });
});
