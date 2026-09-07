import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";

export type Migration = { name: string; checksums: string[] };
export type AppliedMigration = {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
};

export function migrationStateMatches(expected: Migration[], applied: AppliedMigration[]): boolean {
  if (expected.length === 0) return false;
  const active = applied.filter((migration) => migration.rolled_back_at === null);
  if (active.length !== expected.length || active.some((migration) => !migration.finished_at)) return false;
  return expected.every((migration) => active.some((row) =>
    row.migration_name === migration.name && migration.checksums.includes(row.checksum)));
}

/** Prisma hashes bytes; a Windows/Linux checkout may only change line endings. */
export function migrationChecksums(sql: string): string[] {
  const lf = sql.replace(/\r\n/g, "\n");
  return [...new Set([sql, lf, lf.replace(/\n/g, "\r\n")]
    .map((text) => createHash("sha256").update(text).digest("hex")))];
}

/** Share a stalled check and bound each response without accumulating DB work. */
export function createReadinessProbe(check: () => Promise<boolean>, timeoutMs = 2_500) {
  let pending: Promise<boolean> | undefined;
  return (): Promise<boolean> => {
    if (pending) return pending;
    pending = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        pending = undefined;
        resolve(ready);
      };
      // Keep the timed-out false promise until DB work actually settles. This
      // also avoids attaching a new promise listener on each failed request.
      void Promise.resolve().then(check).then(finish, () => finish(false));
    });
    return pending;
  };
}

let manifest: Promise<Migration[]> | undefined;

function migrationManifest(): Promise<Migration[]> {
  return manifest ??= (async () => {
    const root = join(process.cwd(), "prisma", "migrations");
    const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    return Promise.all(directories.map(async ({ name }) => ({
      name,
      checksums: migrationChecksums(await readFile(join(root, name, "migration.sql"), "utf8")),
    })));
  })().catch((error) => { manifest = undefined; throw error; });
}

export const isReady = createReadinessProbe(async () => {
  const expected = await migrationManifest();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '1500ms'`;
    const applied = await tx.$queryRaw<AppliedMigration[]>`
      SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"
    `;
    if (!migrationStateMatches(expected, applied)) return false;
    // Parse the schema-critical columns too; an edited migration journal alone
    // must not make a pre-upgrade or partially restored schema appear ready.
    await tx.$queryRaw`
      SELECT j.lease_version, r.config_snapshot, t.query_text_snapshot,
             s.raw_n, rs.cell_n, a.provider_sources
      FROM jobs j, runs r, run_tasks t, task_scores s, run_scores rs, ai_responses a
      LIMIT 0
    `;
    return true;
  }, { maxWait: 1_500, timeout: 2_000 });
});
