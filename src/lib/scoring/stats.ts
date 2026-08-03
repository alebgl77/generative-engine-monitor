import { createHash } from "node:crypto";
import type { Aggregate } from "@/lib/scoring/types";

/**
 * Distribution statistics for a stochastic system.
 *
 * Two constraints shape this file:
 *
 * 1. No point estimate is ever reported alone. A single sample of an LLM answer
 *    is a draw, not a measurement, so every summary carries an interval.
 * 2. The interval is reproducible bit-for-bit. The bootstrap draws from a seeded
 *    PRNG and the seed is persisted alongside the result, so replaying a run
 *    yields the same bounds — otherwise "the CI moved" could never be
 *    distinguished from "the brand moved".
 *
 * Pure functions only: no I/O, no clock, no global random.
 */

const DEFAULT_BOOTSTRAP_B = 2000;
const DEFAULT_ALPHA = 0.05;

/** Makes MAD a consistent estimator of sigma for a normal distribution. */
const MAD_TO_SIGMA = 1.4826;
/** Spread, in score points, at which stability reaches 0. */
const STABILITY_SPREAD_CAP = 25;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function assertNonEmpty(xs: ArrayLike<number>, fn: string): void {
  if (xs.length === 0) throw new Error(`${fn}: empty sample`);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Type-7 empirical quantile (the R and NumPy default) on a sorted array. */
function quantileOfSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function quantile(xs: number[], p: number): number {
  assertNonEmpty(xs, "quantile");
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`quantile: p must be in [0,1], received ${p}`);
  }
  const sorted = [...xs].sort((a, b) => a - b);
  return quantileOfSorted(sorted, p);
}

export function median(xs: number[]): number {
  assertNonEmpty(xs, "median");
  return quantile(xs, 0.5);
}

export function mean(xs: number[]): number {
  assertNonEmpty(xs, "mean");
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Median absolute deviation: a breakdown point of 50%, unlike the variance. */
export function mad(xs: number[]): number {
  assertNonEmpty(xs, "mad");
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

export function iqr(xs: number[]): number {
  assertNonEmpty(xs, "iqr");
  const sorted = [...xs].sort((a, b) => a - b);
  return quantileOfSorted(sorted, 0.75) - quantileOfSorted(sorted, 0.25);
}

function hashWord(seed: string, index: number): number {
  const input = `${seed}#${index}`;
  let h = FNV_OFFSET_BASIS >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), FNV_PRIME) >>> 0;
    h = Math.imul(h ^ ((c >>> 8) & 0xff), FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/**
 * xorshift128+, seeded from a string. 64-bit state is kept as pairs of uint32
 * because BigInt arithmetic costs more than the whole bootstrap it feeds.
 */
export function makeRng(seed: string): () => number {
  let s0hi = hashWord(seed, 0);
  let s0lo = hashWord(seed, 1);
  let s1hi = hashWord(seed, 2);
  let s1lo = hashWord(seed, 3);
  if ((s0hi | s0lo | s1hi | s1lo) === 0) s0lo = 1;

  const next = (): number => {
    let xhi = s0hi;
    let xlo = s0lo;
    const yhi = s1hi;
    const ylo = s1lo;

    const rlo = (xlo + ylo) >>> 0;
    const carry = xlo + ylo > 0xffffffff ? 1 : 0;
    const rhi = (xhi + yhi + carry) >>> 0;

    s0hi = yhi;
    s0lo = ylo;

    const shiftedHi = ((xhi << 23) | (xlo >>> 9)) >>> 0;
    const shiftedLo = (xlo << 23) >>> 0;
    xhi = (xhi ^ shiftedHi) >>> 0;
    xlo = (xlo ^ shiftedLo) >>> 0;

    s1hi = (xhi ^ yhi ^ (xhi >>> 18) ^ (yhi >>> 5)) >>> 0;
    s1lo = (xlo ^ ylo ^ ((xlo >>> 18) | (xhi << 14)) ^ ((ylo >>> 5) | (yhi << 27))) >>> 0;

    return (rhi * 2097152 + (rlo >>> 11)) / 9007199254740992;
  };

  for (let i = 0; i < 16; i++) next();
  return next;
}

/**
 * Percentile bootstrap on the median.
 *
 * Deliberately not BCa: its acceleration term relies on a jackknife of the
 * median, which is unstable and can be undefined at the sample sizes this
 * product actually runs (n = 3 is a legitimate task).
 */
export function bootstrapMedianCI(
  xs: number[],
  opts: { seed: string; b?: number; alpha?: number }
): { ciLow: number; ciHigh: number } {
  const n = xs.length;
  if (n === 0) throw new Error("bootstrapMedianCI: empty sample");
  if (n === 1) return { ciLow: xs[0], ciHigh: xs[0] };

  const b = opts.b ?? DEFAULT_BOOTSTRAP_B;
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  if (!Number.isInteger(b) || b < 1) {
    throw new Error(`bootstrapMedianCI: b must be a positive integer, received ${b}`);
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new Error(`bootstrapMedianCI: alpha must be in (0,1), received ${alpha}`);
  }

  const rng = makeRng(opts.seed);
  const draw = new Float64Array(n);
  const medians = new Float64Array(b);

  for (let i = 0; i < b; i++) {
    for (let j = 0; j < n; j++) draw[j] = xs[Math.floor(rng() * n)];
    draw.sort();
    medians[i] = quantileOfSorted(draw, 0.5);
  }
  medians.sort();

  return {
    ciLow: quantileOfSorted(medians, alpha / 2),
    ciHigh: quantileOfSorted(medians, 1 - alpha / 2),
  };
}

/** 0..1 consistency indicator. MAD-based, so one outlier cannot collapse it. */
export function stability(xs: number[]): number {
  assertNonEmpty(xs, "stability");
  return clamp(1 - (MAD_TO_SIGMA * mad(xs)) / STABILITY_SPREAD_CAP, 0, 1);
}

export function aggregate(
  xs: number[],
  opts: {
    seed: string;
    lowNThreshold: number;
    /**
     * Dispersion estimator supplied by the scoring version. Omitting it keeps
     * the MAD-only default, so a distribution aggregated under an older version
     * replays to the same number.
     */
    stability?: (xs: number[]) => number;
  }
): Aggregate {
  assertNonEmpty(xs, "aggregate");
  const { ciLow, ciHigh } = bootstrapMedianCI(xs, { seed: opts.seed });
  const stabilityOf = opts.stability ?? stability;
  return {
    n: xs.length,
    median: median(xs),
    mean: mean(xs),
    ciLow,
    ciHigh,
    mad: mad(xs),
    iqr: iqr(xs),
    stability: stabilityOf(xs),
    lowN: xs.length < opts.lowNThreshold,
    bootstrapSeed: opts.seed,
  };
}

/** Stable seed for an aggregate, derived from its identity rather than a clock. */
export function seedFor(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
