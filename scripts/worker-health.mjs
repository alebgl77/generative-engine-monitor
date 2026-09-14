import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export function heartbeatIsFresh(raw, now = Date.now(), maxAgeMs = 30_000) {
  try {
    const { updatedAt } = JSON.parse(raw);
    return Number.isSafeInteger(updatedAt) && updatedAt > 0 &&
      Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 &&
      updatedAt <= now && now - updatedAt <= maxAgeMs;
  } catch {
    return false;
  }
}

export async function checkWorkerHealth() {
  try {
    const file = process.env.WORKER_HEALTH_FILE || join(tmpdir(), "gem-worker", "heartbeat.json");
    const maxAgeMs = Number(process.env.WORKER_HEALTH_MAX_AGE_MS || 30_000);
    return heartbeatIsFresh(await readFile(file, "utf8"), Date.now(), maxAgeMs);
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await checkWorkerHealth() ? 0 : 1;
}
