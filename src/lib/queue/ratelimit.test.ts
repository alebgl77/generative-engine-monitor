import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import { Semaphore, bucketKeyForProvider, tryConsume } from "@/lib/queue/ratelimit";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every pending microtask chain settle before the next assertion. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tryConsume", () => {
  it("grants the call when the statement debits a row", async () => {
    mocks.prisma.$queryRaw.mockResolvedValue([{ tokens: 4 }]);

    await expect(tryConsume("provider:openai")).resolves.toBe(true);
    expect(mocks.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("refuses the call when nothing was debited", async () => {
    // An empty bucket and an unknown key are the same result here: both fail
    // closed rather than handing out an allowance nobody configured.
    mocks.prisma.$queryRaw.mockResolvedValue([]);

    await expect(tryConsume("provider:openai")).resolves.toBe(false);
    await expect(tryConsume("provider:ghost")).resolves.toBe(false);
  });

  it("checks and debits in a single statement", async () => {
    mocks.prisma.$queryRaw.mockResolvedValue([{ tokens: 0 }]);

    await tryConsume("provider:openai:user:u1", 3);

    expect(mocks.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [, ...values] = mocks.prisma.$queryRaw.mock.calls[0];
    expect(values).toContain("provider:openai:user:u1");
    expect(values).toContain(3);
  });

  it("consumes a single token by default", async () => {
    mocks.prisma.$queryRaw.mockResolvedValue([{ tokens: 9 }]);

    await tryConsume("provider:openai");

    const [, ...values] = mocks.prisma.$queryRaw.mock.calls[0];
    expect(values).toContain(1);
  });
});

describe("bucketKeyForProvider", () => {
  it("gives every provider its own bucket", () => {
    expect(bucketKeyForProvider("openai")).toBe("provider:openai");
    expect(bucketKeyForProvider("claude")).toBe("provider:claude");
  });

  it("gives every user its own bucket on a provider", () => {
    expect(bucketKeyForProvider("openai", "u1")).toBe("provider:openai:user:u1");
    expect(bucketKeyForProvider("openai", "u2")).not.toBe(bucketKeyForProvider("openai", "u1"));
  });
});

describe("Semaphore", () => {
  it("rejects a bound that would admit nothing or a fraction of a call", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  it("never runs more than its limit at once and admits the waiters in order", async () => {
    const limit = 2;
    const sem = new Semaphore(limit);
    const gates = Array.from({ length: 5 }, () => deferred());
    const started: number[] = [];
    let active = 0;
    let peak = 0;

    const runs = gates.map((gate, index) =>
      sem.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        started.push(index);
        await gate.promise;
        active -= 1;
      })
    );

    await tick();
    expect(started).toEqual([0, 1]);
    expect(sem.free).toBe(0);
    expect(sem.pending).toBe(3);

    gates[0].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    expect(peak).toBeLessThanOrEqual(limit);

    gates[1].resolve();
    gates[2].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    gates[3].resolve();
    gates[4].resolve();
    await Promise.all(runs);

    expect(peak).toBe(limit);
    expect(sem.free).toBe(limit);
    expect(sem.pending).toBe(0);
  });

  it("hands the permit back when the task throws", async () => {
    const sem = new Semaphore(1);

    await expect(sem.run(async () => Promise.reject(new Error("appel refusé")))).rejects.toThrow(
      "appel refusé"
    );

    expect(sem.free).toBe(1);
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("does not lift its ceiling when released more often than acquired", () => {
    const sem = new Semaphore(2);

    sem.release();
    sem.release();

    expect(sem.free).toBe(2);
  });

  it("keeps a queued waiter blocked until a permit is actually freed", async () => {
    const sem = new Semaphore(1);
    const gate = deferred();
    let secondStarted = false;

    const first = sem.run(async () => {
      await gate.promise;
    });
    const second = sem.run(async () => {
      secondStarted = true;
    });

    await tick();
    expect(secondStarted).toBe(false);

    gate.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });
});
