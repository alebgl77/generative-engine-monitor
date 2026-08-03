import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RETRY, type RunSamplePayload } from "@/lib/queue/types";

/**
 * Queue guarantees that only a real PostgreSQL can demonstrate: row-level
 * locking, lease expiry, and the exact effect of each statement on the columns
 * the worker loop depends on.
 *
 * The suite needs a migrated database and is skipped when DATABASE_URL is not
 * set, so a checkout without one still runs the rest of the test suite. Two
 * details make that guard hold: the database modules are imported from inside
 * the suite, because loading the Prisma client reads the project's .env file
 * into the process environment; and every hook re-checks the condition, because
 * suite hooks execute even when the tests they wrap are skipped.
 */

const DATABASE_CONFIGURED = Boolean(process.env.DATABASE_URL);

let db!: (typeof import("@/lib/prisma"))["prisma"];
let queue!: typeof import("@/lib/queue/client");
let sweeper!: typeof import("@/lib/queue/sweeper");

/** Isolates these rows from anything else living in the database. */
const suffix = randomUUID().slice(0, 8);
const providerCode = `itest-${suffix}`;

const TIMEOUT_MS = 30_000;
const MINUTE_MS = 60_000;

const fixture = {
  userId: "",
  projectId: "",
  queryId: "",
  providerId: "",
  runId: "",
  taskId: "",
};

function payloadFor(sampleId: string): RunSamplePayload {
  return {
    sampleId,
    taskId: fixture.taskId,
    runId: fixture.runId,
    projectId: fixture.projectId,
    queryText: "meilleur crm",
    providerCode,
    mode: "PARAMETRIC",
    locale: { country: "FR", language: "fr" },
    scoringVersion: "v2",
    extractionVersion: "v2",
  };
}

/** Creates `count` samples and their jobs, returning the job ids in a stable order. */
async function queueJobs(count: number): Promise<string[]> {
  const samples: { id: string }[] = [];
  for (let index = 0; index < count; index++) {
    samples.push(
      await db.runSample.create({
        data: {
          taskId: fixture.taskId,
          runId: fixture.runId,
          projectId: fixture.projectId,
          sampleIndex: index,
        },
        select: { id: true },
      })
    );
  }

  await queue.enqueue(
    samples.map((sample) => ({
      kind: "RUN_SAMPLE" as const,
      runId: fixture.runId,
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      sampleId: sample.id,
      providerCode,
      payload: payloadFor(sample.id),
    }))
  );

  const jobs = await db.job.findMany({
    where: { sampleId: { in: samples.map((sample) => sample.id) } },
    select: { id: true, sampleId: true },
  });
  const bySample = new Map(jobs.map((job) => [job.sampleId, job.id]));
  return samples.map((sample) => bySample.get(sample.id) as string);
}

function expired(): Date {
  return new Date(Date.now() - 5 * MINUTE_MS);
}

function stillValid(): Date {
  return new Date(Date.now() + 5 * MINUTE_MS);
}

describe.skipIf(!DATABASE_CONFIGURED)("queue on PostgreSQL", () => {
  beforeAll(async () => {
    if (!DATABASE_CONFIGURED) return;

    ({ prisma: db } = await import("@/lib/prisma"));
    queue = await import("@/lib/queue/client");
    sweeper = await import("@/lib/queue/sweeper");

    const user = await db.user.create({
      data: { email: `queue-${suffix}@integration.test`, passwordHash: "integration" },
      select: { id: true },
    });
    fixture.userId = user.id;

    const project = await db.project.create({
      data: { userId: user.id, name: `Queue ${suffix}` },
      select: { id: true },
    });
    fixture.projectId = project.id;

    const query = await db.query.create({
      data: { projectId: project.id, text: "meilleur crm" },
      select: { id: true },
    });
    fixture.queryId = query.id;

    const provider = await db.provider.create({
      data: { code: providerCode, label: `Integration ${suffix}` },
      select: { id: true },
    });
    fixture.providerId = provider.id;

    const run = await db.run.create({
      data: {
        projectId: project.id,
        status: "RUNNING",
        scoringVersion: "v2",
        extractionVersion: "v2",
        repetitions: 3,
        modes: ["PARAMETRIC"],
      },
      select: { id: true },
    });
    fixture.runId = run.id;

    const task = await db.runTask.create({
      data: {
        runId: run.id,
        projectId: project.id,
        queryId: query.id,
        providerId: provider.id,
        mode: "PARAMETRIC",
        plannedSamples: 4,
        pendingSamples: 4,
      },
      select: { id: true },
    });
    fixture.taskId = task.id;
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (!DATABASE_CONFIGURED) return;

    await db.job.deleteMany({ where: { providerCode } });
    if (fixture.userId) await db.user.deleteMany({ where: { id: fixture.userId } });
    await db.provider.deleteMany({ where: { code: providerCode } });
    await db.$disconnect();
  }, TIMEOUT_MS);

  beforeEach(async () => {
    if (!DATABASE_CONFIGURED) return;

    await db.job.deleteMany({ where: { providerCode } });
    await db.runSample.deleteMany({ where: { taskId: fixture.taskId } });
  }, TIMEOUT_MS);

  it(
    "never hands the same job to two workers claiming at once",
    async () => {
      const ids = await queueJobs(4);

      const [first, second] = await Promise.all([
        queue.claim({ workerId: "worker-a", providerCodes: [providerCode], limit: 4 }),
        queue.claim({ workerId: "worker-b", providerCodes: [providerCode], limit: 4 }),
      ]);

      const claimed = [...first, ...second].map((job) => job.id);
      expect(claimed.length).toBeGreaterThan(0);
      expect(new Set(claimed).size).toBe(claimed.length);

      const owners = new Map<string, string>();
      for (const job of first) owners.set(job.id, "worker-a");
      for (const job of second) owners.set(job.id, "worker-b");

      const rows = await db.job.findMany({ where: { id: { in: ids } } });
      for (const row of rows) {
        const owner = owners.get(row.id);
        if (!owner) {
          expect(row.status).toBe("QUEUED");
          expect(row.lockedBy).toBeNull();
          expect(row.attempts).toBe(0);
          continue;
        }
        expect(row.status).toBe("RUNNING");
        expect(row.lockedBy).toBe(owner);
        expect(row.attempts).toBe(1);
        expect(row.leaseExpiresAt).not.toBeNull();
      }
    },
    TIMEOUT_MS
  );

  it(
    "claims nothing once every job of the provider is held",
    async () => {
      await queueJobs(2);
      await queue.claim({ workerId: "worker-a", providerCodes: [providerCode], limit: 10 });

      const late = await queue.claim({
        workerId: "worker-b",
        providerCodes: [providerCode],
        limit: 10,
      });

      expect(late).toEqual([]);
    },
    TIMEOUT_MS
  );

  it(
    "enqueues a sample once, however many times it is planned",
    async () => {
      const ids = await queueJobs(2);
      const jobs = await db.job.findMany({
        where: { id: { in: ids } },
        select: { sampleId: true },
      });

      const inserted = await queue.enqueue(
        jobs.map((job) => ({
          kind: "RUN_SAMPLE" as const,
          runId: fixture.runId,
          projectId: fixture.projectId,
          taskId: fixture.taskId,
          sampleId: job.sampleId,
          providerCode,
          payload: payloadFor(job.sampleId as string),
        }))
      );

      expect(inserted).toBe(0);
      expect(await db.job.count({ where: { providerCode } })).toBe(2);
    },
    TIMEOUT_MS
  );

  it(
    "returns an expired lease to the pool and kills a job out of attempts",
    async () => {
      const [retryable, exhausted, healthy] = await queueJobs(3);

      await db.job.update({
        where: { id: retryable },
        data: {
          status: "RUNNING",
          lockedBy: "dead-worker",
          attempts: 1,
          leaseExpiresAt: expired(),
          heartbeatAt: expired(),
        },
      });
      await db.job.update({
        where: { id: exhausted },
        data: {
          status: "RUNNING",
          lockedBy: "dead-worker",
          attempts: RETRY.maxAttempts,
          leaseExpiresAt: expired(),
          heartbeatAt: expired(),
        },
      });
      await db.job.update({
        where: { id: healthy },
        data: {
          status: "RUNNING",
          lockedBy: "live-worker",
          attempts: 1,
          leaseExpiresAt: stillValid(),
          heartbeatAt: new Date(),
        },
      });

      const summary = await sweeper.sweepExpiredLeases();
      expect(summary.requeued).toBeGreaterThanOrEqual(1);
      expect(summary.dead).toBeGreaterThanOrEqual(1);

      const back = await db.job.findUniqueOrThrow({ where: { id: retryable } });
      expect(back.status).toBe("QUEUED");
      expect(back.attempts).toBe(1);
      expect(back.lockedBy).toBeNull();
      expect(back.leaseExpiresAt).toBeNull();
      expect(back.heartbeatAt).toBeNull();
      expect(back.lastErrorCode).toBe("lease_expired");
      expect(back.availableAt.getTime()).toBeGreaterThan(Date.now());

      const dead = await db.job.findUniqueOrThrow({ where: { id: exhausted } });
      expect(dead.status).toBe("DEAD");
      expect(dead.completedAt).not.toBeNull();
      expect(dead.lockedBy).toBeNull();

      const alive = await db.job.findUniqueOrThrow({ where: { id: healthy } });
      expect(alive.status).toBe("RUNNING");
      expect(alive.lockedBy).toBe("live-worker");
    },
    TIMEOUT_MS
  );

  it(
    "gives the attempt back when a job is released, and requeues it immediately",
    async () => {
      const [id] = await queueJobs(1);
      await db.job.update({
        where: { id },
        data: {
          status: "RUNNING",
          lockedBy: "worker-a",
          attempts: 2,
          leaseExpiresAt: stillValid(),
          heartbeatAt: new Date(),
        },
      });

      await queue.release(id);

      const row = await db.job.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("QUEUED");
      expect(row.attempts).toBe(1);
      expect(row.lockedBy).toBeNull();
      expect(row.leaseExpiresAt).toBeNull();
      expect(row.heartbeatAt).toBeNull();

      const reclaimed = await queue.claim({
        workerId: "worker-b",
        providerCodes: [providerCode],
        limit: 1,
      });
      expect(reclaimed.map((job) => job.id)).toEqual([id]);
      expect(reclaimed[0].attempts).toBe(2);
    },
    TIMEOUT_MS
  );

  it(
    "never drives the attempt counter below zero when releasing",
    async () => {
      const [id] = await queueJobs(1);
      await db.job.update({
        where: { id },
        data: { status: "RUNNING", lockedBy: "worker-a", attempts: 0 },
      });

      await queue.release(id);

      const row = await db.job.findUniqueOrThrow({ where: { id } });
      expect(row.attempts).toBe(0);
      expect(row.status).toBe("QUEUED");
    },
    TIMEOUT_MS
  );

  it(
    "leaves a job it does not hold untouched when releasing",
    async () => {
      const [id] = await queueJobs(1);
      await db.job.update({ where: { id }, data: { attempts: 2 } });

      await queue.release(id);

      const row = await db.job.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("QUEUED");
      expect(row.attempts).toBe(2);
    },
    TIMEOUT_MS
  );

  it(
    "leaves no queued job behind when a run is cancelled",
    async () => {
      const [first, second, running] = await queueJobs(3);
      await db.job.update({
        where: { id: running },
        data: {
          status: "RUNNING",
          lockedBy: "worker-a",
          attempts: 1,
          leaseExpiresAt: stillValid(),
        },
      });

      const cancelled = await queue.cancelRunJobs(fixture.runId);

      expect(cancelled).toBe(2);
      expect(await db.job.count({ where: { runId: fixture.runId, status: "QUEUED" } })).toBe(0);

      for (const id of [first, second]) {
        const row = await db.job.findUniqueOrThrow({ where: { id } });
        expect(row.status).toBe("CANCELLED");
        expect(row.completedAt).not.toBeNull();
      }

      // The in-flight call is left to its worker: it learns about the
      // cancellation from its heartbeat and records the outcome itself.
      const inFlight = await db.job.findUniqueOrThrow({ where: { id: running } });
      expect(inFlight.status).toBe("RUNNING");

      const claimable = await queue.claim({
        workerId: "worker-b",
        providerCodes: [providerCode],
        limit: 10,
      });
      expect(claimable).toEqual([]);
    },
    TIMEOUT_MS
  );
});
