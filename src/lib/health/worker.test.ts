import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { clearWorkerHealth, recordWorkerHealthy } from "@/worker/health";
import { checkWorkerHealth, heartbeatIsFresh } from "../../../scripts/worker-health.mjs";

let directory: string;
const originalPath = process.env.WORKER_HEALTH_FILE;
const originalMaxAge = process.env.WORKER_HEALTH_MAX_AGE_MS;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gem-health-test-"));
  process.env.WORKER_HEALTH_FILE = join(directory, "private", "heartbeat.json");
  delete process.env.WORKER_HEALTH_MAX_AGE_MS;
  await clearWorkerHealth();
});

afterEach(async () => {
  await clearWorkerHealth();
  await rm(directory, { recursive: true, force: true });
  if (originalPath === undefined) delete process.env.WORKER_HEALTH_FILE;
  else process.env.WORKER_HEALTH_FILE = originalPath;
  if (originalMaxAge === undefined) delete process.env.WORKER_HEALTH_MAX_AGE_MS;
  else process.env.WORKER_HEALTH_MAX_AGE_MS = originalMaxAge;
});

it("is unhealthy before a successful loop and after shutdown", async () => {
  expect(await checkWorkerHealth()).toBe(false);
  await recordWorkerHealthy();
  expect(await checkWorkerHealth()).toBe(true);
  const file = process.env.WORKER_HEALTH_FILE!;
  expect(Object.keys(JSON.parse(await readFile(file, "utf8")))).toEqual(["updatedAt"]);
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  await clearWorkerHealth();
  expect(await checkWorkerHealth()).toBe(false);
});

it("shutdown invalidates queued writes and a new startup can renew", async () => {
  const writes = [recordWorkerHealthy(), recordWorkerHealthy(), recordWorkerHealthy()];
  await clearWorkerHealth();
  await Promise.all(writes);
  expect(await checkWorkerHealth()).toBe(false);
  await recordWorkerHealthy();
  expect(await checkWorkerHealth()).toBe(true);
});

it("rejects malformed, future, expired timestamps and invalid expiry configuration", async () => {
  const now = 100_000;
  for (const raw of ["broken", "null", "{}", '{"updatedAt":"100000"}', '{"updatedAt":100001}', '{"updatedAt":69999}', '{"updatedAt":-1}']) {
    expect(heartbeatIsFresh(raw, now)).toBe(false);
  }
  expect(heartbeatIsFresh('{"updatedAt":70000}', now)).toBe(true);
  expect(heartbeatIsFresh('{"updatedAt":100000}', now, 0)).toBe(false);
  await recordWorkerHealthy();
  process.env.WORKER_HEALTH_MAX_AGE_MS = "not-a-number";
  expect(await checkWorkerHealth()).toBe(false);
});

it("propagates failed writes without poisoning subsequent startup", async () => {
  process.env.WORKER_HEALTH_FILE = directory;
  await expect(recordWorkerHealthy()).rejects.toThrow();
  process.env.WORKER_HEALTH_FILE = join(directory, "recovered.json");
  await clearWorkerHealth();
  await recordWorkerHealthy();
  expect(await checkWorkerHealth()).toBe(true);
});
