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
