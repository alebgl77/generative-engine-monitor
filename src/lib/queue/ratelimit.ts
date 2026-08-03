import { prisma } from "@/lib/prisma";
import { SQL_NOW } from "@/lib/queue/client";

/**
 * Token bucket persisted in PostgreSQL.
 *
 * The state lives in the database, not in the process, because the limit that
 * matters is the provider's: three worker containers sharing one API key must
 * share one bucket. Refill is computed lazily inside the consuming statement,
 * so there is no ticker to run and no drift between processes.
 */

/**
 * Consumes tokens if the bucket, refilled up to now, holds enough. The refill
 * expression is repeated in the WHERE clause on purpose: check and debit have
 * to happen in the same statement, or two workers both pass the check.
 *
 * Returns false when throttled — including when the bucket does not exist. A
 * missing bucket fails closed: callers create theirs with `ensureBucket` at
 * startup, and an unknown provider must not get an unlimited allowance.
 */
export async function tryConsume(key: string, tokens = 1): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ tokens: number }[]>`
    UPDATE rate_limit_buckets
       SET tokens = LEAST(
                      capacity,
                      tokens + EXTRACT(EPOCH FROM (${SQL_NOW} - refilled_at)) * refill_per_sec
                    ) - ${tokens}::double precision,
           refilled_at = ${SQL_NOW}
     WHERE key = ${key}
       AND LEAST(
             capacity,
             tokens + EXTRACT(EPOCH FROM (${SQL_NOW} - refilled_at)) * refill_per_sec
           ) >= ${tokens}::double precision
    RETURNING tokens`;

  return rows.length > 0;
}

/**
 * Creates the bucket, or realigns an existing one with the current
 * configuration. The token balance is deliberately left untouched on update: a
 * worker restart loop would otherwise refill the bucket on every boot and turn
 * the rate limit off exactly when the provider is struggling.
 */
export async function ensureBucket(
  key: string,
  capacity: number,
  refillPerSec: number
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO rate_limit_buckets (key, capacity, tokens, refill_per_sec, refilled_at)
    VALUES (
      ${key},
      ${capacity}::double precision,
      ${capacity}::double precision,
      ${refillPerSec}::double precision,
      ${SQL_NOW}
    )
    ON CONFLICT (key) DO UPDATE
       SET capacity = EXCLUDED.capacity,
           refill_per_sec = EXCLUDED.refill_per_sec`;
}

/**
 * Per-user keys keep one project's burst from starving another's when both use
 * their own credential against the same provider.
 */
export function bucketKeyForProvider(providerCode: string, userId?: string): string {
  return userId ? `provider:${providerCode}:user:${userId}` : `provider:${providerCode}`;
}

/**
 * In-process concurrency bound, complementing the database bucket: the bucket
 * caps the rate, this caps how many calls are in flight at once inside one
 * worker.
 */
export class Semaphore {
  private readonly max: number;
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Semaphore requires a positive integer, received ${max}`);
    }
    this.max = max;
    this.available = max;
  }

  get free(): number {
    return this.available;
  }

  get pending(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // The permit is handed straight to the waiter; counting it back first
      // would let a newcomer overtake the queue and exceed the bound.
      next();
      return;
    }
    this.available = Math.min(this.max, this.available + 1);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
