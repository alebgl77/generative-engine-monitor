process.env.LOG_LEVEL = "error";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { LEASE } from "@/lib/queue/types";

const mocks = vi.hoisted(() => ({ release: vi.fn() }));

vi.mock("@/lib/queue/client", () => ({ release: mocks.release }));

import { installShutdownHandlers, type InFlightJob } from "@/worker/shutdown";

function pending(id: string): InFlightJob & { settle: () => void } {
  const controller = new AbortController();
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { id, lease: { id, runId: "r1", lockedBy: "w1", leaseVersion: 4 }, controller, done, settle };
}

let exit: MockInstance<(code?: string | number | null | undefined) => never>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.release.mockResolvedValue(undefined);
  exit = vi.spyOn(process, "exit").mockImplementation(((): never => undefined as never) as never);
});

afterEach(() => {
  vi.useRealTimers();
  exit.mockRestore();
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
});

describe("installShutdownHandlers", () => {
  it("stops claiming and aborts the loop on the first signal", () => {
    const loop = new AbortController();
    const handle = installShutdownHandlers(loop, () => []);

    expect(handle.stopping()).toBe(false);
    process.emit("SIGTERM");

    expect(handle.stopping()).toBe(true);
    expect(loop.signal.aborted).toBe(true);
  });

  it("lets an in-flight job finish inside the grace period and releases nothing", async () => {
    const job = pending("j1");
    const inFlight = new Map<string, InFlightJob>([["j1", job]]);
    installShutdownHandlers(new AbortController(), () => Array.from(inFlight.values()));

    process.emit("SIGTERM");
    inFlight.delete("j1");
    job.settle();

    await vi.advanceTimersByTimeAsync(100);

    expect(job.controller.signal.aborted).toBe(false);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("aborts and hands back the lease of a job that overruns the grace period", async () => {
    const job = pending("j1");
    const inFlight = new Map<string, InFlightJob>([["j1", job]]);
    installShutdownHandlers(new AbortController(), () => Array.from(inFlight.values()));

    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(LEASE.shutdownGraceSec * 1000 + 5_000);

    expect(job.controller.signal.aborted).toBe(true);
    expect(mocks.release).toHaveBeenCalledWith(job.lease);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not release a job that recorded its own outcome after being aborted", async () => {
    const job = pending("j1");
    const inFlight = new Map<string, InFlightJob>([["j1", job]]);
    installShutdownHandlers(new AbortController(), () => Array.from(inFlight.values()));

    job.controller.signal.addEventListener("abort", () => {
      inFlight.delete("j1");
      job.settle();
    });

    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(LEASE.shutdownGraceSec * 1000 + 5_000);

    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("exits hard on a second signal", () => {
    installShutdownHandlers(new AbortController(), () => []);

    process.emit("SIGTERM");
    process.emit("SIGINT");

    expect(exit).toHaveBeenCalledWith(1);
  });
  it("clears health at shutdown before releasing leases", async () => {
    const clearHealth = vi.fn().mockResolvedValue(undefined);
    installShutdownHandlers(new AbortController(), () => [], clearHealth);
    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    expect(clearHealth).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
