import { describe, expect, it } from "vitest";
import {
  aggregate,
  bootstrapMedianCI,
  iqr,
  mad,
  makeRng,
  mean,
  median,
  quantile,
  seedFor,
  stability,
} from "@/lib/scoring/stats";
import { LOW_N_RUN, LOW_N_TASK } from "@/lib/scoring/types";

/** Hand-computed reference vector: median 3, mean 22, MAD 1, IQR 2. */
const SKEWED = [3, 100, 1, 4, 2];

describe("quantile", () => {
  it("matches type-7 reference values", () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10);
    expect(quantile([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25, 10);
    expect(quantile([15, 20, 35, 40, 50], 0.4)).toBeCloseTo(29, 10);
    expect(quantile([15, 20, 35, 40, 50], 0)).toBe(15);
    expect(quantile([15, 20, 35, 40, 50], 1)).toBe(50);
  });

  it("does not depend on input order", () => {
    expect(quantile([40, 15, 50, 20, 35], 0.4)).toBeCloseTo(29, 10);
  });

  it("does not mutate its input", () => {
    const xs = [3, 1, 2];
    quantile(xs, 0.5);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("rejects an empty sample and an out-of-range probability", () => {
    expect(() => quantile([], 0.5)).toThrow(/empty sample/);
    expect(() => quantile([1, 2], 1.5)).toThrow(/\[0,1\]/);
    expect(() => quantile([1, 2], Number.NaN)).toThrow(/\[0,1\]/);
  });
});

describe("median", () => {
  it("returns the middle value on an odd sample", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median(SKEWED)).toBe(3);
  });

  it("interpolates on an even sample", () => {
    expect(median([1, 2, 3, 4])).toBeCloseTo(2.5, 10);
    expect(median([10, 20])).toBeCloseTo(15, 10);
  });

  it("returns the single value at n = 1", () => {
    expect(median([42])).toBe(42);
  });

  it("resists an outlier that moves the mean", () => {
    expect(median(SKEWED)).toBe(3);
    expect(mean(SKEWED)).toBe(22);
  });

  it("rejects an empty sample", () => {
    expect(() => median([])).toThrow(/empty sample/);
  });
});

describe("mean, mad and iqr", () => {
  it("match the hand-computed vector", () => {
    expect(mean(SKEWED)).toBe(22);
    expect(mad(SKEWED)).toBe(1);
    expect(iqr(SKEWED)).toBe(2);
  });

  it("are zero on a constant vector", () => {
    expect(mad([7, 7, 7, 7])).toBe(0);
    expect(iqr([7, 7, 7, 7])).toBe(0);
    expect(mean([7, 7, 7, 7])).toBe(7);
  });

  it("computes the interquartile range with type-7 quartiles", () => {
    expect(iqr([1, 2, 3, 4])).toBeCloseTo(1.5, 10);
  });

  it("rejects empty samples", () => {
    expect(() => mean([])).toThrow(/empty sample/);
    expect(() => mad([])).toThrow(/empty sample/);
    expect(() => iqr([])).toThrow(/empty sample/);
  });
});

describe("makeRng", () => {
  it("produces the same sequence for the same seed", () => {
    const first = makeRng("seed-a");
    const second = makeRng("seed-a");
    const left = Array.from({ length: 32 }, () => first());
    const right = Array.from({ length: 32 }, () => second());
    expect(left).toEqual(right);
  });

  it("produces a different sequence for a different seed", () => {
    const left = Array.from({ length: 32 }, makeRng("seed-a"));
    const right = Array.from({ length: 32 }, makeRng("seed-b"));
    expect(left).not.toEqual(right);
  });

  it("stays within [0,1) and does not stall on a repeated value", () => {
    const rng = makeRng("seed-c");
    const draws = Array.from({ length: 500 }, () => rng());
    for (const value of draws) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(new Set(draws).size).toBeGreaterThan(400);
  });
});

describe("bootstrapMedianCI", () => {
  const sample = [42, 55, 48, 61, 39, 50, 47, 58, 44, 52];

  it("returns the same interval for the same data and seed across repeated calls", () => {
    const first = bootstrapMedianCI(sample, { seed: "run-1|task-7" });
    const second = bootstrapMedianCI(sample, { seed: "run-1|task-7" });
    const third = bootstrapMedianCI(sample, { seed: "run-1|task-7" });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("stays reproducible with explicit resampling parameters", () => {
    const opts = { seed: "run-2|task-1", b: 500, alpha: 0.1 };
    expect(bootstrapMedianCI(sample, opts)).toEqual(bootstrapMedianCI(sample, opts));
  });

  it("narrows as the confidence level drops", () => {
    const wide = bootstrapMedianCI(sample, { seed: "alpha", alpha: 0.05 });
    const narrow = bootstrapMedianCI(sample, { seed: "alpha", alpha: 0.5 });
    expect(narrow.ciHigh - narrow.ciLow).toBeLessThanOrEqual(wide.ciHigh - wide.ciLow);
  });

  it("brackets the observed median within the observed range", () => {
    const { ciLow, ciHigh } = bootstrapMedianCI(sample, { seed: "bracket" });
    expect(ciLow).toBeLessThanOrEqual(median(sample));
    expect(median(sample)).toBeLessThanOrEqual(ciHigh);
    expect(ciLow).toBeGreaterThanOrEqual(Math.min(...sample));
    expect(ciHigh).toBeLessThanOrEqual(Math.max(...sample));
  });

  it("returns a degenerate interval at n = 1", () => {
    expect(bootstrapMedianCI([73], { seed: "single" })).toEqual({ ciLow: 73, ciHigh: 73 });
  });

  it("returns a degenerate interval on a constant sample", () => {
    expect(bootstrapMedianCI([12, 12, 12, 12], { seed: "flat" })).toEqual({
      ciLow: 12,
      ciHigh: 12,
    });
  });

  it("widens as dispersion rises", () => {
    const tight = bootstrapMedianCI([49, 50, 50, 51, 50, 50, 49, 51], { seed: "w" });
    const loose = bootstrapMedianCI([10, 50, 50, 90, 50, 50, 10, 90], { seed: "w" });
    expect(loose.ciHigh - loose.ciLow).toBeGreaterThan(tight.ciHigh - tight.ciLow);
  });

  it("rejects invalid parameters", () => {
    expect(() => bootstrapMedianCI([], { seed: "s" })).toThrow(/empty sample/);
    expect(() => bootstrapMedianCI([1, 2], { seed: "s", b: 0 })).toThrow(/positive integer/);
    expect(() => bootstrapMedianCI([1, 2], { seed: "s", b: 1.5 })).toThrow(/positive integer/);
    expect(() => bootstrapMedianCI([1, 2], { seed: "s", alpha: 0 })).toThrow(/\(0,1\)/);
    expect(() => bootstrapMedianCI([1, 2], { seed: "s", alpha: 1 })).toThrow(/\(0,1\)/);
  });
});

describe("stability", () => {
  it("is 1 on a perfectly repeatable task", () => {
    expect(stability([50, 50, 50])).toBe(1);
  });

  it("falls as dispersion rises", () => {
    const tight = stability([48, 50, 52]);
    const wide = stability([40, 50, 60]);
    const wider = stability([20, 50, 80]);
    expect(tight).toBeGreaterThan(wide);
    expect(wide).toBeGreaterThan(wider);
  });

  it("is clamped to [0,1]", () => {
    expect(stability([0, 0, 0, 100, 100, 100])).toBe(0);
    for (const xs of [[50], [0, 100], [1, 2, 3, 99]]) {
      const value = stability(xs);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("is not collapsed by a single outlier", () => {
    expect(stability([50, 50, 50, 50, 50, 0])).toBeGreaterThan(0.9);
  });

  it("rejects an empty sample", () => {
    expect(() => stability([])).toThrow(/empty sample/);
  });
});

describe("aggregate", () => {
  const sample = [42, 55, 48, 61, 39];

  it("reports the distribution and echoes its seed", () => {
    const result = aggregate(sample, { seed: "seed-x", lowNThreshold: LOW_N_TASK });
    expect(result.n).toBe(5);
    expect(result.median).toBe(median(sample));
    expect(result.mean).toBe(mean(sample));
    expect(result.mad).toBe(mad(sample));
    expect(result.iqr).toBe(iqr(sample));
    expect(result.stability).toBe(stability(sample));
    expect(result.bootstrapSeed).toBe("seed-x");
  });

  it("sets lowN from its threshold", () => {
    expect(aggregate([1, 2, 3], { seed: "s", lowNThreshold: LOW_N_TASK }).lowN).toBe(true);
    expect(aggregate(sample, { seed: "s", lowNThreshold: LOW_N_TASK }).lowN).toBe(false);
    expect(aggregate(sample, { seed: "s", lowNThreshold: LOW_N_RUN }).lowN).toBe(true);
    expect(aggregate([9], { seed: "s", lowNThreshold: 1 }).lowN).toBe(false);
  });

  it("is reproducible for the same data and seed", () => {
    const first = aggregate(sample, { seed: "same", lowNThreshold: LOW_N_TASK });
    const second = aggregate(sample, { seed: "same", lowNThreshold: LOW_N_TASK });
    expect(second).toEqual(first);
  });

  it("rejects an empty sample", () => {
    expect(() => aggregate([], { seed: "s", lowNThreshold: LOW_N_TASK })).toThrow(/empty sample/);
  });
});

describe("seedFor", () => {
  it("derives a stable seed from its parts", () => {
    expect(seedFor(["run-1", "task-2"])).toBe(seedFor(["run-1", "task-2"]));
    expect(seedFor(["run-1", "task-2"])).not.toBe(seedFor(["run-1", "task-3"]));
    expect(seedFor(["run-1", "task-2"])).not.toBe(seedFor(["task-2", "run-1"]));
  });
});
