import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { badRequest, notFound, tooManyRequests } from "@/lib/errors";

const positiveLimit = z.coerce.number().int().positive().max(1_000_000);
const schema = z.object({
  MAX_SAMPLES_PER_RUN: positiveLimit.default(1000),
  MAX_SAMPLES_PER_USER_DAY: positiveLimit.default(10000),
  MAX_ACTIVE_RUNS_PER_USER: positiveLimit.default(3),
  MAX_QUERIES_PER_PROJECT: positiveLimit.default(1000),
});
export function getRunLimits(env: Record<string, string | undefined> = process.env) {
  return schema.parse(env);
}

/** All allocators lock this owner row before reading mutable allowance state. */
export async function lockRunOwner(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const owners = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
  if (owners.length === 0) throw notFound("Utilisateur");
}

export function plannedSampleCount(queries: number, cells: number, repeats: number): number {
  const total = queries * cells * repeats;
  if (![queries, cells, repeats, total].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw badRequest("Plan d'échantillonnage invalide");
  }
  if (total > getRunLimits().MAX_SAMPLES_PER_RUN) {
    throw tooManyRequests("Limite d'échantillons par opération dépassée");
  }
  return total;
}

/** Reserves UTC-day volume atomically; cancellation/project deletion never refunds it. */
export async function assertRunAllowance(
  tx: Prisma.TransactionClient,
  userId: string,
  additional: number,
  opts: { launchingRun: boolean; now?: Date }
): Promise<void> {
  const limits = getRunLimits();
  if (!Number.isSafeInteger(additional) || additional < 0 || additional > limits.MAX_SAMPLES_PER_RUN) {
    throw tooManyRequests("Limite d'échantillons par opération dépassée");
  }
  if (additional === 0) return;
  await reserveVolume(tx, userId, additional, opts, false);
}

/** Before a project cascade, retain the legacy floor even above today's ceiling. */
export async function preserveDailyReservation(tx: Prisma.TransactionClient, userId: string, now?: Date): Promise<void> {
  await reserveVolume(tx, userId, 0, { launchingRun: false, now }, true);
}

async function reserveVolume(
  tx: Prisma.TransactionClient, userId: string, additional: number,
  opts: { launchingRun: boolean; now?: Date }, preserving: boolean
): Promise<void> {
  const limits = getRunLimits();
  const now = opts.now ?? new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const key = `reserved-samples:${userId}:${start.toISOString().slice(0, 10)}`;
  const bucket = await tx.rateLimitBucket.findUnique({ where: { key } });
  const active = opts.launchingRun
    ? await tx.run.count({ where: { project: { userId }, status: { in: ["PENDING", "RUNNING", "CANCELLING"] } } })
    : 0;
  if (opts.launchingRun && active >= limits.MAX_ACTIVE_RUNS_PER_USER) {
    throw tooManyRequests("Nombre maximal d'analyses simultanées atteint");
  }

  let reserved: number;
  if (bucket) {
    reserved = bucket.capacity - bucket.tokens;
  } else {
    // One-time transition floor from durable rows predating this reservation key.
    const projects = await tx.project.findMany({ where: { userId }, select: { id: true } });
    const projectIds = projects.map((project) => project.id);
    const [fresh, replays] = await Promise.all([
      tx.runSample.count({ where: { projectId: { in: projectIds }, createdAt: { gte: start } } }),
      tx.job.count({ where: { projectId: { in: projectIds }, kind: "RESCORE_SAMPLE", createdAt: { gte: start } } }),
    ]);
    reserved = fresh + replays;
  }
  // Raising a configured ceiling cannot refill an already established daily key.
  const capacity = Math.min(bucket?.capacity ?? limits.MAX_SAMPLES_PER_USER_DAY, limits.MAX_SAMPLES_PER_USER_DAY);
  if (!Number.isFinite(reserved) || reserved < 0 || (!preserving && reserved + additional > capacity)) {
    throw tooManyRequests("Limite quotidienne de volume réservé atteinte");
  }
  const data = { capacity, tokens: capacity - reserved - additional, refillPerSec: 0, refilledAt: now };
  await tx.rateLimitBucket.upsert({ where: { key }, create: { key, ...data }, update: data });
}
