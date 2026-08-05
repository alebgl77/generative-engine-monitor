import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which engines a run is planned against.
 *
 * The mock engine answers from fixtures, and nothing downstream tells its
 * samples apart from a real one: `aggregateRun` groups sample scores by mode
 * alone. A fixture answer therefore lands in the run median, in the bootstrap
 * interval, in `n` and in every share-of-voice denominator, and its fixture URLs
 * become citations carrying real domains. These tests pin the one rule that
 * keeps a published measurement honest — mock is planned only when it is the
 * only engine available.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    project: { findUniqueOrThrow: vi.fn() },
    providerCredential: { findMany: vi.fn() },
    provider: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  enqueue: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/queue/client", () => ({ enqueue: mocks.enqueue }));

import { planRun } from "@/lib/runs/plan";

const MOCK_PROVIDER = {
  id: "p-mock",
  code: "mock",
  label: "Mock (démo)",
  isActiveGlobal: true,
};

const OPENAI_PROVIDER = {
  id: "p-openai",
  code: "openai",
  label: "OpenAI",
  isActiveGlobal: true,
};

/** Captures the provider codes the transaction actually enqueued work for. */
function plannedProviderCodes(): string[] {
  const codes = new Set<string>();
  for (const [jobs] of mocks.enqueue.mock.calls) {
    for (const job of jobs as { providerCode: string }[]) codes.add(job.providerCode);
  }
  return [...codes].sort();
}

function transactionStub() {
  let taskSeq = 0;
  let sampleSeq = 0;
  return async (fn: (tx: unknown) => Promise<string>) =>
    fn({
      run: { create: async () => ({ id: "run-1" }) },
      runTask: { create: async () => ({ id: `task-${++taskSeq}` }) },
      runSample: { create: async () => ({ id: `sample-${++sampleSeq}` }) },
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.project.findUniqueOrThrow.mockResolvedValue({
    id: "proj-1",
    userId: "u1",
    repetitions: 1,
    samplingModes: ["PARAMETRIC"],
    targetCountry: "FR",
    targetLanguage: "fr",
    queries: [{ id: "q1", text: "meilleur CRM" }],
    user: { id: "u1" },
  });
  mocks.prisma.provider.findUnique.mockResolvedValue(MOCK_PROVIDER);
  mocks.prisma.$transaction.mockImplementation(transactionStub());
});

describe("planRun engine selection", () => {
  it("plans the mock engine when the project has no valid key", async () => {
    mocks.prisma.providerCredential.findMany.mockResolvedValue([]);

    const plan = await planRun("proj-1");

    expect(plannedProviderCodes()).toEqual(["mock"]);
    expect(plan.totalSamples).toBe(1);
  });

  it("drops the mock engine as soon as a real key answers for the project", async () => {
    mocks.prisma.providerCredential.findMany.mockResolvedValue([
      { provider: OPENAI_PROVIDER, isValid: true },
    ]);

    const plan = await planRun("proj-1");

    expect(plannedProviderCodes()).toEqual(["openai"]);
    // The count a user reads as the cost of the run must not carry a fixture.
    expect(plan.totalSamples).toBe(1);
  });

  it("does not even look the mock engine up when a real key exists", async () => {
    mocks.prisma.providerCredential.findMany.mockResolvedValue([
      { provider: OPENAI_PROVIDER, isValid: true },
    ]);

    await planRun("proj-1");

    expect(mocks.prisma.provider.findUnique).not.toHaveBeenCalled();
  });

  it("refuses to plan when there is neither a key nor an active mock engine", async () => {
    mocks.prisma.providerCredential.findMany.mockResolvedValue([]);
    mocks.prisma.provider.findUnique.mockResolvedValue({
      ...MOCK_PROVIDER,
      isActiveGlobal: false,
    });

    await expect(planRun("proj-1")).rejects.toThrow(/Aucun moteur disponible/);
  });

  it("drops the mock engine even when it holds a credential of its own", async () => {
    // The demo seed creates exactly this: a valid mock credential. Filtering on
    // credentials alone would let fixtures back in through the demo account.
    mocks.prisma.providerCredential.findMany.mockResolvedValue([
      { provider: MOCK_PROVIDER, isValid: true },
      { provider: OPENAI_PROVIDER, isValid: true },
    ]);

    const plan = await planRun("proj-1");

    expect(plannedProviderCodes()).toEqual(["openai"]);
    expect(plan.totalSamples).toBe(1);
  });

  it("still plans the mock engine when its credential is the only one", async () => {
    mocks.prisma.providerCredential.findMany.mockResolvedValue([
      { provider: MOCK_PROVIDER, isValid: true },
    ]);

    await planRun("proj-1");

    expect(plannedProviderCodes()).toEqual(["mock"]);
  });

  it("ignores a credential whose provider was deactivated globally", async () => {
    mocks.prisma.providerCredential.findMany.mockResolvedValue([
      { provider: { ...OPENAI_PROVIDER, isActiveGlobal: false }, isValid: true },
    ]);

    // The only usable engine left is the mock one, so it comes back.
    await planRun("proj-1");

    expect(plannedProviderCodes()).toEqual(["mock"]);
  });
});
