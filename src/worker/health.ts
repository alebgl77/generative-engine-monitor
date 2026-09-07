import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

let generation = 0;
let pending: Promise<void> = Promise.resolve();

export function workerHealthFile(): string {
  return process.env.WORKER_HEALTH_FILE || join(tmpdir(), "gem-worker", "heartbeat.json");
}

/** Call only after a successful worker loop/DB operation, never from a timer. */
export function recordWorkerHealthy(): Promise<void> {
  const currentGeneration = generation;
  const file = workerHealthFile();
  const updatedAt = Date.now();
  const write = pending.catch(() => undefined).then(async () => {
    if (currentGeneration !== generation) return;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ updatedAt }), { mode: 0o600 });
      if (currentGeneration === generation) await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  });
  pending = write;
  return write;
}

/** Invalidate queued writes before clearing startup/shutdown process state. */
export function clearWorkerHealth(): Promise<void> {
  generation += 1;
  const file = workerHealthFile();
  const clear = pending.catch(() => undefined).then(() => rm(file, { force: true }));
  pending = clear;
  return clear;
}
