import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost:5432/fixture");
  vi.stubEnv("NEXTAUTH_URL", "https://example.test");
  vi.stubEnv("NEXTAUTH_SECRET", "test-nextauth-secret-value");
  vi.stubEnv("CREDENTIAL_KEYS", JSON.stringify({ "1": Buffer.alloc(32, 0x11).toString("base64") }));
  vi.stubEnv("CREDENTIAL_KEY_CURRENT", "1");
  vi.stubEnv("CREDENTIAL_FINGERPRINT_PEPPER", "test-fingerprint-pepper-value");
  vi.stubEnv("SEED_DEMO", "false");
  vi.stubEnv("REGISTRATION_ENABLED", undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("registration environment setting", () => {
  it("preserves registration by default", async () => {
    const { getEnv } = await import("./env");
    expect(getEnv().REGISTRATION_ENABLED).toBe(true);
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("parses %s as the boolean %s", async (raw, expected) => {
    vi.stubEnv("REGISTRATION_ENABLED", raw);
    const { getEnv } = await import("./env");
    expect(getEnv().REGISTRATION_ENABLED).toBe(expected);
  });

  it.each(["", "TRUE", "FALSE", "1", "0", "yes", "false ", " true", "null"])(
    "rejects the invalid value %j rather than coercing it",
    async (raw) => {
      vi.stubEnv("REGISTRATION_ENABLED", raw);
      const { getEnv } = await import("./env");
      expect(() => getEnv()).toThrow(/REGISTRATION_ENABLED/);
    }
  );

  it.each(["true", "false"])("also supports explicit %s during production bootstrap", async (raw) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("REGISTRATION_ENABLED", raw);
    const { getEnv } = await import("./env");
    expect(getEnv().REGISTRATION_ENABLED).toBe(raw === "true");
  });

  it("requires a fresh process environment parse to change the setting", async () => {
    const { getEnv } = await import("./env");
    expect(getEnv().REGISTRATION_ENABLED).toBe(true);
    vi.stubEnv("REGISTRATION_ENABLED", "false");
    expect(getEnv().REGISTRATION_ENABLED).toBe(true);
    vi.resetModules();
    const fresh = await import("./env");
    expect(fresh.getEnv().REGISTRATION_ENABLED).toBe(false);
  });
});

describe("environment validation contracts", () => {
  it("preserves transformed boolean defaults and numeric coercions", async () => {
    vi.stubEnv("SENTIMENT_ENABLED", undefined);
    vi.stubEnv("SEED_DEMO", undefined);
    vi.stubEnv("TRUSTED_PROXY_HOPS", undefined);
    vi.stubEnv("WORKER_BATCH_SIZE", undefined);
    const { getEnv } = await import("./env");
    expect(getEnv()).toMatchObject({
      REGISTRATION_ENABLED: true, SENTIMENT_ENABLED: true, SEED_DEMO: false,
      TRUSTED_PROXY_HOPS: 0, WORKER_BATCH_SIZE: 5, CREDENTIAL_KEY_CURRENT: 1,
    });
  });

  it("coerces supplied numeric configuration without changing credential records", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    vi.stubEnv("WORKER_BATCH_SIZE", "10");
    const keys = { "1": Buffer.alloc(32, 0x11).toString("base64"), "2": Buffer.alloc(32, 0x22).toString("base64") };
    vi.stubEnv("CREDENTIAL_KEYS", JSON.stringify(keys));
    vi.stubEnv("CREDENTIAL_KEY_CURRENT", "2");
    const { getEnv } = await import("./env");
    expect(getEnv()).toMatchObject({
      TRUSTED_PROXY_HOPS: 2, WORKER_BATCH_SIZE: 10, CREDENTIAL_KEY_CURRENT: 2,
      CREDENTIAL_KEYS: keys,
    });
  });

  it.each([
    ["{", /CREDENTIAL_KEYS must be JSON/],
    [JSON.stringify({ bad: Buffer.alloc(32, 0x11).toString("base64") }), /CREDENTIAL_KEYS invalid/],
    [JSON.stringify({ "1": "short" }), /must be a base64-encoded 32-byte key/],
  ])("rejects malformed credential configuration: %s", async (raw, expected) => {
    vi.stubEnv("CREDENTIAL_KEYS", raw);
    const { getEnv } = await import("./env");
    expect(() => getEnv()).toThrow(expected);
  });

  it("retains the cross-field credential-key version guard", async () => {
    vi.stubEnv("CREDENTIAL_KEY_CURRENT", "2");
    const { getEnv } = await import("./env");
    expect(() => getEnv()).toThrow(/points to version 2, which is absent from CREDENTIAL_KEYS/);
  });

  it("retains the production demo-account guard after boolean transformation", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SEED_DEMO", "true");
    const { getEnv } = await import("./env");
    expect(() => getEnv()).toThrow(/must not be enabled in production/);
  });
});
