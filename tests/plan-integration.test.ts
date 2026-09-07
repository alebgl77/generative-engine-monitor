import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture before Prisma can load .env. No configured database means an explicit skip.
const DATABASE_CONFIGURED = Boolean(process.env.DATABASE_URL);
const fixture = vi.hoisted(() => ({ userId: "", projectId: "", queryId: "", brandId: "", providerId: "",
  model: "model-at-plan", rejectEnqueue: false }));
vi.mock("@/lib/providers/registry", () => ({
  getProvider: () => ({ defaultModel: () => fixture.model, capabilities: { parametric: true, grounded: true } }),
  supportsMode: () => true,
}));
vi.mock("@/lib/queue/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/queue/client")>("@/lib/queue/client");
  return { ...actual, enqueue: vi.fn(async (...args: Parameters<typeof actual.enqueue>) => {
    if (fixture.rejectEnqueue) throw new Error("injected enqueue rollback");
    return actual.enqueue(...args);
  }) };
});
// Exercise the actual DELETE transaction; only HTTP authentication is replaced.
vi.mock("@/lib/api/route-helpers", () => ({
  json: (body: unknown) => Response.json(body), parseBody: vi.fn(),
  withProject: async (_request: unknown, projectId: string,
    handler: (ctx: { project: { id: string }; userId: string }) => Promise<Response>) =>
    handler({ project: { id: projectId }, userId: fixture.userId }),
}));

let db!: (typeof import("@/lib/prisma"))["prisma"];
let planRun!: (typeof import("@/lib/runs/plan"))["planRun"];
let requestHash!: (typeof import("@/lib/runs/snapshots"))["requestHash"];
let deleteProject!: (typeof import("@/app/api/projects/[projectId]/route"))["DELETE"];
const suffix = randomUUID();
const providerCode = `plan-test-${suffix}`;
const timeout = 30_000;

async function addProject() {
  const project = await db.project.create({ data: { userId: fixture.userId, name: "Plan integration",
    repetitions: 1, samplingModes: ["PARAMETRIC"],
    queries: { create: { text: "original question" } },
    brands: { create: { name: "Original brand", domain: "original.example", aliases: ["Original"] } },
  }, include: { queries: true, brands: true } });
  fixture.projectId = project.id;
  fixture.queryId = project.queries[0].id;
  fixture.brandId = project.brands[0].id;
  return project;
}
async function removeProject() {
  return deleteProject(new Request(`http://localhost/api/projects/${fixture.projectId}`) as Parameters<typeof deleteProject>[0],
    { params: Promise.resolve({ projectId: fixture.projectId }) });
}
async function reservation() {
  return db.rateLimitBucket.findFirst({ where: { key: { startsWith: `reserved-samples:${fixture.userId}:` } } });
}

describe.skipIf(!DATABASE_CONFIGURED)("PostgreSQL plan snapshots and durable reservations", () => {
  beforeAll(async () => {
    if (!DATABASE_CONFIGURED) return;
    ({ prisma: db } = await import("@/lib/prisma"));
    ({ planRun } = await import("@/lib/runs/plan"));
    ({ requestHash } = await import("@/lib/runs/snapshots"));
    ({ DELETE: deleteProject } = await import("@/app/api/projects/[projectId]/route"));
    const provider = await db.provider.create({ data: { code: providerCode, label: "Isolated test provider",
      supportsParametric: true, supportsGrounded: true } });
    fixture.providerId = provider.id;
  }, timeout);

  beforeEach(async () => {
    if (!DATABASE_CONFIGURED) return;
    vi.stubEnv("MAX_SAMPLES_PER_RUN", "1000");
    vi.stubEnv("MAX_SAMPLES_PER_USER_DAY", "10000");
    vi.stubEnv("MAX_ACTIVE_RUNS_PER_USER", "3");
    vi.stubEnv("MAX_QUERIES_PER_PROJECT", "1000");
    fixture.rejectEnqueue = false;
    fixture.model = "model-at-plan";
    const user = await db.user.create({ data: { email: `plan-${randomUUID()}@example.invalid`, passwordHash: "test-only" } });
    fixture.userId = user.id;
    // Inert credential bytes are never decrypted: this suite does not execute providers.
    await db.providerCredential.create({ data: { userId: user.id, providerId: fixture.providerId,
      cipherText: Buffer.alloc(1), iv: Buffer.alloc(12), authTag: Buffer.alloc(16), keyVersion: 1,
      fingerprint: randomUUID(), lastFour: "test", isValid: true } });
    await addProject();
  }, timeout);

  afterEach(async () => {
    if (!DATABASE_CONFIGURED || !fixture.userId) return;
    fixture.rejectEnqueue = false;
    await db.$transaction(async (tx) => {
      await tx.user.deleteMany({ where: { id: fixture.userId } });
      await tx.rateLimitBucket.deleteMany({ where: { key: { startsWith: `reserved-samples:${fixture.userId}:` } } });
    });
    fixture.userId = "";
    vi.unstubAllEnvs();
  }, timeout);

  afterAll(async () => {
    if (!DATABASE_CONFIGURED || !db) return;
    if (fixture.providerId) await db.provider.delete({ where: { id: fixture.providerId } });
    await db.$disconnect();
  }, timeout);

  it("keeps query/entity/locale/model snapshots and specification hashes after catalogue edits and archives", async () => {
    await db.project.update({ where: { id: fixture.projectId }, data: { repetitions: 2, samplingModes: ["PARAMETRIC", "GROUNDED"] } });
    const planned = await planRun(fixture.projectId);
    expect(planned.totalSamples).toBe(4);
    const before = await db.run.findUniqueOrThrow({ where: { id: planned.runId }, include: { tasks: { include: { samples: true } }, jobs: true } });
    const archived = new Date();
    await db.query.update({ where: { id: fixture.queryId }, data: { text: "changed question", archivedAt: archived, isActive: false } });
    await db.brand.update({ where: { id: fixture.brandId }, data: { name: "Changed brand", domain: "changed.example", archivedAt: archived } });
    await db.project.update({ where: { id: fixture.projectId }, data: { targetCountry: "US", targetLanguage: "en" } });
    fixture.model = "changed-model";
    const after = await db.run.findUniqueOrThrow({ where: { id: planned.runId }, include: { tasks: { include: { samples: true } }, jobs: true } });
    expect(after.configSnapshot).toEqual(before.configSnapshot);
    expect(after.configSnapshot).toMatchObject({ reconstructed: false, locale: { country: "FR", language: "fr" },
      entities: [expect.objectContaining({ name: "Original brand", domain: "original.example" })],
      providers: [expect.objectContaining({ model: "model-at-plan" })] });
    for (const task of after.tasks) {
      expect(task.queryTextSnapshot).toBe("original question");
      expect(task.localeSnapshot).toEqual({ country: "FR", language: "fr" });
      for (const sample of task.samples) expect(sample.promptHash).toBe(requestHash({ queryText: "original question",
        locale: { country: "FR", language: "fr" }, providerCode, mode: task.mode, model: "model-at-plan" }));
    }
    for (const job of after.jobs) expect(job.payload).toMatchObject({ model: "model-at-plan", queryText: "original question" });
    await db.query.create({ data: { projectId: fixture.projectId, text: "replacement question" } });
    const second = await planRun(fixture.projectId);
    const secondRun = await db.run.findUniqueOrThrow({ where: { id: second.runId }, include: { tasks: true } });
    expect(secondRun.configSnapshot).toMatchObject({ entities: [], providers: [expect.objectContaining({ model: "changed-model" })] });
    expect(secondRun.tasks.every((task) => task.queryTextSnapshot === "replacement question")).toBe(true);
  }, timeout);

  it("admits exactly three of four concurrent launches for the same owner", async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => planRun(fixture.projectId)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 429 }) })]);
    expect(await db.run.count({ where: { projectId: fixture.projectId } })).toBe(3);
    const bucket = await reservation();
    expect(bucket!.capacity - bucket!.tokens).toBe(3);
  }, timeout);

  it("serializes concurrent daily reservations without over-allocation", async () => {
    vi.stubEnv("MAX_SAMPLES_PER_USER_DAY", "2");
    vi.stubEnv("MAX_ACTIVE_RUNS_PER_USER", "10");
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => planRun(fixture.projectId)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(await db.runSample.count({ where: { projectId: fixture.projectId } })).toBe(2);
    expect((await reservation())?.tokens).toBe(0);
  }, timeout);

  it("does not refund a new reservation when the project is deleted", async () => {
    vi.stubEnv("MAX_SAMPLES_PER_USER_DAY", "1");
    await planRun(fixture.projectId);
    expect((await removeProject()).status).toBe(200);
    await addProject();
    await expect(planRun(fixture.projectId)).rejects.toMatchObject({ status: 429 });
    expect((await reservation())?.tokens).toBe(0);
  }, timeout);

  it("rolls back the reservation and entire plan when durable enqueue fails", async () => {
    fixture.rejectEnqueue = true;
    await expect(planRun(fixture.projectId)).rejects.toThrow("injected enqueue rollback");
    expect(await reservation()).toBeNull();
    expect(await db.run.count({ where: { projectId: fixture.projectId } })).toBe(0);
    expect(await db.runSample.count({ where: { projectId: fixture.projectId } })).toBe(0);
    expect(await db.job.count({ where: { projectId: fixture.projectId } })).toBe(0);
  }, timeout);

  it("materializes legacy consumption before the first post-upgrade project DELETE", async () => {
    vi.stubEnv("MAX_SAMPLES_PER_USER_DAY", "10");
    await db.run.create({ data: { projectId: fixture.projectId, status: "COMPLETED", scoringVersion: "v3", extractionVersion: "v2",
      repetitions: 10, modes: ["PARAMETRIC"], totalTasks: 1, totalSamples: 10,
      tasks: { create: { projectId: fixture.projectId, queryId: fixture.queryId, providerId: fixture.providerId,
        mode: "PARAMETRIC", plannedSamples: 10, pendingSamples: 0,
        samples: { create: [] } } } } }).then(async (run) => {
      const task = await db.runTask.findFirstOrThrow({ where: { runId: run.id } });
      await db.runSample.createMany({ data: Array.from({ length: 10 }, (_, sampleIndex) => ({ taskId: task.id,
        runId: run.id, projectId: fixture.projectId, sampleIndex, status: "COMPLETED" as const })) });
    });
    expect(await reservation()).toBeNull();
    expect((await removeProject()).status).toBe(200);
    const bucket = await reservation();
    expect(bucket!.capacity - bucket!.tokens).toBe(10);
    await addProject();
    await expect(planRun(fixture.projectId)).rejects.toMatchObject({ status: 429 });
  }, timeout);
});
