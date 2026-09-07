import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ provider: { upsert: vi.fn() }, rateLimitBucket: { upsert: vi.fn() } }));
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    provider = mocks.provider;
    rateLimitBucket = mocks.rateLimitBucket;
  },
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ NODE_ENV: "production" }),
  modelFor: () => "configured-model",
}));

import { seedProviders } from "../../../prisma/seed";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  mocks.provider.upsert.mockResolvedValue({ rpmLimit: 17 });
  mocks.rateLimitBucket.upsert.mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

it("production bootstrap preserves provider and bucket configuration on every repeat", async () => {
  await seedProviders();
  await seedProviders();
  expect(mocks.provider.upsert).toHaveBeenCalledTimes(10);
  expect(mocks.rateLimitBucket.upsert).toHaveBeenCalledTimes(10);
  for (const [args] of mocks.provider.upsert.mock.calls) {
    expect(args.update).toEqual({});
    expect(args.create).toHaveProperty("code");
  }
  for (const [args] of mocks.rateLimitBucket.upsert.mock.calls) {
    expect(args.update).toEqual({});
    // A missing bucket inherits the existing provider's custom RPM, not defaults.
    expect(args.create.capacity).toBe(17);
    expect(args.create.tokens).toBe(17);
    expect(args.create.refillPerSec).toBe(17 / 60);
  }
});

it("keeps the opt-in development reference-data refresh behavior", async () => {
  await seedProviders(false);
  for (const [args] of mocks.provider.upsert.mock.calls) expect(Object.keys(args.update).length).toBeGreaterThan(0);
  for (const [args] of mocks.rateLimitBucket.upsert.mock.calls) {
    expect(args.update).toEqual({ capacity: 17, refillPerSec: 17 / 60 });
  }
});
