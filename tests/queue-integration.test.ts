import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors";
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
  await db.runTask.update({ where: { id: fixture.taskId }, data: { plannedSamples: count, pendingSamples: count } });
  await db.run.update({ where: { id: fixture.runId }, data: { totalSamples: count } });
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

async function leaseFor(id: string) {
  const row = await db.job.findUniqueOrThrow({ where: { id } });
  return { id, lockedBy: row.lockedBy ?? "worker-a", leaseVersion: row.leaseVersion, runId: row.runId };
}
async function claimOne(workerId = "worker-a") {
  return (await queue.claim({ workerId, providerCodes: [providerCode], limit: 1 }))[0];
}
async function makeImmediatelyClaimable(id: string) {
  await db.job.update({ where: { id }, data: { availableAt: new Date(0) } });
}
async function mockCallJob() {
  const [id] = await queueJobs(1);
  const row = await db.job.findUniqueOrThrow({ where: { id } });
  await db.job.update({ where: { id }, data: { payload: { ...payloadFor(row.sampleId!), providerCode: "mock" } } });
  const registry = await import("@/lib/providers/registry");
  const provider = registry.getProvider("mock")!;
  const call = vi.spyOn(provider, "runQuery").mockResolvedValue({
    text: "A stored test response.", rawJson: { sources: [] }, sources: [],
    model: "test-model", truncated: false, usage: { inputTokens: 7, outputTokens: 11 },
  });
  const { runSampleHandler } = await import("@/worker/handlers/runSample");
  const { ensureBucket, bucketKeyForProvider } = await import("@/lib/queue/ratelimit");
  await ensureBucket(bucketKeyForProvider("mock"), 10000, 10000);
  return { id, sampleId: row.sampleId!, call, run: runSampleHandler };
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
        configSnapshot: { version: 1, reconstructed: false, entities: [], providers: [], locale: { country: "FR", language: "fr" }, requestTemplateVersion: "test" },
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
    vi.restoreAllMocks();
    await db.job.deleteMany({ where: { runId: fixture.runId } });
    await db.runSample.deleteMany({ where: { taskId: fixture.taskId } });
    await db.run.update({ where: { id: fixture.runId }, data: { status: "RUNNING", cancelRequestedAt: null, totalTasks: 1, pendingTasks: 1, doneSamples: 0, failedSamples: 0 } });
    await db.runTask.update({ where: { id: fixture.taskId }, data: { status: "PENDING", doneSamples: 0, failedSamples: 0 } });
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

      await queue.release(await leaseFor(id));

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
        data: { status: "RUNNING", lockedBy: "worker-a", attempts: 0, leaseExpiresAt: stillValid() },
      });

      await queue.release(await leaseFor(id));

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

      await expect(queue.release(await leaseFor(id))).rejects.toBeInstanceOf(queue.LostLease);

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

  it("monotonic generations fence same-worker ABA, stale completion, failure and release", async () => {
    await queueJobs(1);
    const first = await claimOne("same-worker");
    await queue.release(first);
    const second = await claimOne("same-worker");
    expect(second.attempts).toBe(first.attempts);
    expect(second.leaseVersion).toBe(first.leaseVersion + 1);
    await expect(queue.complete(first)).rejects.toBeInstanceOf(queue.LostLease);
    await expect(queue.release(first)).rejects.toBeInstanceOf(queue.LostLease);
    expect(await queue.fail(first, { code: "SERVER", message: "stale", retryable: true })).toBe("lost");
    const beat = await queue.heartbeat([first, second]);
    expect(beat.alive).toEqual([{ id: second.id, leaseVersion: second.leaseVersion }]);
    expect((await db.job.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("RUNNING");
  }, TIMEOUT_MS);

  it("an expired lease cannot renew itself or commit business writes before the sweeper", async () => {
    await queueJobs(1);
    const lease = await claimOne();
    await db.job.update({ where: { id: lease.id }, data: { leaseExpiresAt: expired() } });
    expect((await queue.heartbeat([lease])).alive).toEqual([]);
    await expect(db.$transaction(async (tx) => {
      await queue.assertLease(tx, lease);
      await tx.runSample.update({ where: { id: lease.sampleId! }, data: { model: "STALE" } });
    })).rejects.toBeInstanceOf(queue.LostLease);
    expect((await db.runSample.findUniqueOrThrow({ where: { id: lease.sampleId! } })).model).toBeNull();
  }, TIMEOUT_MS);

  it("lease checks serialize business commit against sweeper and reject late old generation", async () => {
    await queueJobs(1);
    const first = await claimOne();
    await db.job.update({ where: { id: first.id }, data: { leaseExpiresAt: expired() } });
    await sweeper.sweepExpiredLeases();
    await makeImmediatelyClaimable(first.id);
    const second = await claimOne("worker-b");
    expect(second.leaseVersion).toBeGreaterThan(first.leaseVersion);
    await expect(db.$transaction(async (tx) => {
      await queue.assertLease(tx, first);
      await tx.run.update({ where: { id: fixture.runId }, data: { doneSamples: { increment: 1 } } });
    })).rejects.toBeInstanceOf(queue.LostLease);
    await queue.complete(second);
    expect((await db.run.findUniqueOrThrow({ where: { id: fixture.runId } })).doneSamples).toBe(0);
  }, TIMEOUT_MS);

  it("a retryable provider failure remains pending; second claimed attempt really calls provider and succeeds", async () => {
    const test = await mockCallJob();
    test.call.mockRejectedValueOnce(new ProviderError("SERVER", "mock", "503"));
    await test.run(await claimOne(), { signal: new AbortController().signal, workerId: "worker-a" });
    expect((await db.job.findUniqueOrThrow({ where: { id: test.id } })).status).toBe("QUEUED");
    expect((await db.runTask.findUniqueOrThrow({ where: { id: fixture.taskId } })).pendingSamples).toBe(1);
    expect((await db.runSample.findUniqueOrThrow({ where: { id: test.sampleId } })).status).toBe("RUNNING");
    await makeImmediatelyClaimable(test.id);
    await test.run(await claimOne(), { signal: new AbortController().signal, workerId: "worker-a" });
    expect(test.call).toHaveBeenCalledTimes(2);
    expect((await db.job.findUniqueOrThrow({ where: { id: test.id } })).status).toBe("SUCCEEDED");
    const task = await db.runTask.findUniqueOrThrow({ where: { id: fixture.taskId } });
    expect([task.pendingSamples, task.doneSamples, task.failedSamples]).toEqual([0, 1, 0]);
    expect(await db.sampleScore.count({ where: { sampleId: test.sampleId } })).toBe(1);
    expect(await db.job.count({ where: { runId: fixture.runId, kind: "AGGREGATE_TASK" } })).toBe(1);
  }, TIMEOUT_MS);

  it("analysis retry resumes immutable paid response without another provider call", async () => {
    const test = await mockCallJob();
    const analysis = await import("@/lib/runs/persist");
    const spy = vi.spyOn(analysis, "persistSampleAnalysis").mockRejectedValueOnce(new Error("temporary analysis error"));
    await test.run(await claimOne(), { signal: new AbortController().signal, workerId: "worker-a" });
    const raw = await db.aIResponse.findUniqueOrThrow({ where: { sampleId: test.sampleId } });
    expect(raw.providerSources).toEqual([]);
    expect((await db.run.findUniqueOrThrow({ where: { id: fixture.runId } })).doneSamples).toBe(0);
    spy.mockRestore();
    await makeImmediatelyClaimable(test.id);
    await test.run(await claimOne(), { signal: new AbortController().signal, workerId: "worker-a" });
    expect(test.call).toHaveBeenCalledTimes(1);
    expect((await db.aIResponse.findUniqueOrThrow({ where: { sampleId: test.sampleId } })).id).toBe(raw.id);
    expect((await db.runSample.findUniqueOrThrow({ where: { id: test.sampleId } })).status).toBe("COMPLETED");
  }, TIMEOUT_MS);

  it("exhausted analysis is FAILED, retains raw and usage, and counts once", async () => {
    const test = await mockCallJob();
    const analysis = await import("@/lib/runs/persist");
    vi.spyOn(analysis, "persistSampleAnalysis").mockRejectedValue(new Error("permanent analysis error"));
    await db.job.update({ where: { id: test.id }, data: { maxAttempts: 1 } });
    const lease = await claimOne();
    await test.run(lease, { signal: new AbortController().signal, workerId: "worker-a" });
    expect((await db.job.findUniqueOrThrow({ where: { id: test.id } })).status).toBe("FAILED");
    const sample = await db.runSample.findUniqueOrThrow({ where: { id: test.sampleId }, include: { response: true } });
    expect(sample.status).toBe("FAILED");
    expect(sample.response?.rawText).toBe("A stored test response.");
    expect([sample.tokensIn, sample.tokensOut, sample.model]).toEqual([7, 11, "test-model"]);
    expect(await db.sampleScore.count({ where: { sampleId: sample.id } })).toBe(0);
    await test.run(lease, { signal: new AbortController().signal, workerId: "worker-a" });
    expect((await db.run.findUniqueOrThrow({ where: { id: fixture.runId } })).failedSamples).toBe(1);
  }, TIMEOUT_MS);

  it("expired exhausted job repairs even a PENDING sample and run counters exactly once", async () => {
    const [id] = await queueJobs(1);
    const lease = await claimOne();
    await db.job.update({ where: { id }, data: { attempts: 4, leaseExpiresAt: expired() } });
    await db.runSample.update({ where: { id: lease.sampleId! }, data: { createdAt: expired() } });
    await sweeper.sweepExpiredLeases();
    expect(await sweeper.reconcileOrphanSamples()).toBeGreaterThanOrEqual(1);
    await sweeper.reconcileOrphanSamples();
    const task = await db.runTask.findUniqueOrThrow({ where: { id: fixture.taskId } });
    const run = await db.run.findUniqueOrThrow({ where: { id: fixture.runId } });
    expect([task.pendingSamples, task.failedSamples, run.failedSamples]).toEqual([0, 1, 1]);
    expect(await db.job.count({ where: { runId: fixture.runId, kind: "AGGREGATE_TASK" } })).toBe(1);
  }, TIMEOUT_MS);

  it("cancel plus expiry drains pending samples and never resurrects a cancelled run", async () => {
    await queueJobs(2);
    const lease = await claimOne();
    await db.run.update({ where: { id: fixture.runId }, data: { status: "CANCELLING", cancelRequestedAt: new Date() } });
    await db.job.update({ where: { id: lease.id }, data: { leaseExpiresAt: expired() } });
    await sweeper.runSweep();
    expect((await db.run.findUniqueOrThrow({ where: { id: fixture.runId } })).status).toBe("CANCELLED");
    expect(await db.runSample.count({ where: { runId: fixture.runId, status: "CANCELLED" } })).toBe(2);
    expect(await db.job.count({ where: { runId: fixture.runId, status: { in: ["QUEUED", "RUNNING"] } } })).toBe(0);
    expect(await queue.claim({ workerId: "late", providerCodes: [providerCode], limit: 5 })).toEqual([]);
    await expect(queue.complete(lease)).rejects.toBeInstanceOf(queue.LostLease);
  }, TIMEOUT_MS);

  it("same extraction rescoring uses complete stored evidence, not reconstructed entity names or new raw extraction", async () => {
    const test = await mockCallJob();
    const lease = await claimOne();
    const brand = await db.brand.create({ data: { projectId: fixture.projectId, name: "Renamed catalog brand" } });
    await db.run.update({ where: { id: fixture.runId }, data: { configSnapshot: {
      version: 1, reconstructed: true, entities: [{ id: brand.id, name: "Renamed catalog brand", kind: "BRAND", aliases: [], domain: null }],
    } } });
    await db.sampleScore.create({ data: {
      sampleId: test.sampleId, taskId: fixture.taskId, runId: fixture.runId,
      scoringVersion: "v2", extractionVersion: "v2", score: 42, brandPresent: true, shareOfVoice: 1, contributions: [],
    } });
    await db.brandMention.create({ data: {
      sampleId: test.sampleId, runId: fixture.runId, projectId: fixture.projectId, brandId: brand.id, extractionVersion: "v2",
      mentionType: "EXACT", occurrenceIndex: 0, charOffset: 0, sentenceIndex: 0, normalizedPosition: 0,
      inFirstSentence: true, orderRank: 0, occurrencesTotal: 1, context: "Original brand", confidence: 1,
      sentiment: "POSITIVE", sentimentScore: 0.8, sentimentJudgeVersion: "legacy-judge",
    } });
    await db.citation.create({ data: {
      sampleId: test.sampleId, runId: fixture.runId, projectId: fixture.projectId, url: "https://original.example",
      normalizedUrl: "https://original.example/", domain: "original.example", sourceKind: "NATIVE", isBrandDomain: true, extractionVersion: "v2",
    } });
    const judge = await import("@/lib/sentiment/judge");
    const judgeSpy = vi.spyOn(judge, "judgeSentiment");
    const { persistSampleAnalysis } = await import("@/lib/runs/persist");
    await persistSampleAnalysis({
      sampleId: test.sampleId, taskId: fixture.taskId, runId: fixture.runId, projectId: fixture.projectId, userId: fixture.userId,
      mode: "PARAMETRIC", text: "No matching name or link in this reconstructed input.", providerSources: [],
      scoringVersion: "v3", extractionVersion: "v2", lease,
    });
    const scored = await db.sampleScore.findUniqueOrThrow({ where: { sampleId_scoringVersion: { sampleId: test.sampleId, scoringVersion: "v3" } } });
    expect(scored.brandPresent).toBe(true);
    expect(scored.brandOccurrences).toBe(1);
    expect(scored.citationCount).toBe(1);
    expect(scored.brandDomainCited).toBe(true);
    expect(judgeSpy).not.toHaveBeenCalled();
    expect((await db.sampleScore.findUniqueOrThrow({ where: { sampleId_scoringVersion: { sampleId: test.sampleId, scoringVersion: "v2" } } })).score).toBe(42);
    expect((await db.brandMention.findFirstOrThrow({ where: { sampleId: test.sampleId } })).sentimentJudgeVersion).toBe("legacy-judge");
  }, TIMEOUT_MS);

  it("lease stolen while sentiment is in flight prevents evidence and score writes", async () => {
    const test = await mockCallJob();
    const lease = await claimOne();
    const brand = await db.brand.create({ data: { projectId: fixture.projectId, name: "Acme" } });
    await db.run.update({ where: { id: fixture.runId }, data: { configSnapshot: {
      version: 1, reconstructed: false, entities: [{ id: brand.id, name: "Acme", kind: "BRAND", aliases: [], domain: null }],
    } } });
    const judge = await import("@/lib/sentiment/judge");
    vi.spyOn(judge, "judgeSentiment").mockImplementation(async () => {
      await db.job.update({ where: { id: lease.id }, data: { lockedBy: "replacement", leaseVersion: { increment: 1 } } });
      return new Map();
    });
    const { persistSampleAnalysis } = await import("@/lib/runs/persist");
    await expect(persistSampleAnalysis({
      sampleId: test.sampleId, taskId: fixture.taskId, runId: fixture.runId, projectId: fixture.projectId, userId: fixture.userId,
      mode: "PARAMETRIC", text: "Acme is the best.", providerSources: [], scoringVersion: "v3", extractionVersion: "v3", lease,
    })).rejects.toBeInstanceOf(queue.LostLease);
    expect(await db.sampleScore.count({ where: { sampleId: test.sampleId } })).toBe(0);
    expect(await db.brandMention.count({ where: { sampleId: test.sampleId } })).toBe(0);
  }, TIMEOUT_MS);

});
