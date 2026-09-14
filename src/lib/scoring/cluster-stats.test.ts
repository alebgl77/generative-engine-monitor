import { describe, expect, it } from "vitest";
import {
  clusterBootstrap,
  pairedRetrievalDelta,
  type ClusterObservation,
  type RetrievalObservation,
} from "@/lib/scoring/cluster-stats";

const opts = { seed: "cluster-reference", b: 400 };
const observation = (queryId: string, providerId: string, value: number): ClusterObservation =>
  ({ queryId, providerId, value });
const retrieval = (
  queryId: string,
  providerId: string,
  mode: RetrievalObservation["mode"],
  value: number
): RetrievalObservation => ({ queryId, providerId, mode, value });

describe("clusterBootstrap", () => {
  const panel = [
    observation("q1", "p1", 0),
    observation("q1", "p2", 40),
    observation("q2", "p1", 100),
    observation("q2", "p2", 100),
    observation("q3", "p1", 0),
  ];

  it("equally weights providers then queries, not imbalanced repeat counts", () => {
    const result = clusterBootstrap([
      ...panel,
      ...Array.from({ length: 99 }, () => observation("q1", "p1", 0)),
    ], opts);
    expect(result.queryValues).toEqual([
      { queryId: "q1", value: 20 },
      { queryId: "q2", value: 100 },
      { queryId: "q3", value: 0 },
    ]);
    expect(result).toMatchObject({ n: 3, rawN: 104, cellN: 5, mean: 40, median: 20 });
  });

  it("does not inflate independent n or tighten the interval by copying repeats", () => {
    const original = clusterBootstrap(panel, opts);
    const copied = clusterBootstrap(Array.from({ length: 20 }, () => panel).flat(), opts);
    expect({ ...copied, rawN: original.rawN }).toEqual(original);
    expect(copied.lowN).toBe(true);
  });

  it("replays bit-for-bit even if input query/provider/repeat order changes", () => {
    const data = [...panel, observation("q1", "p1", 0.1), observation("q1", "p1", 0.2)];
    expect(clusterBootstrap([...data].reverse(), opts)).toEqual(clusterBootstrap(data, opts));
    expect(clusterBootstrap(data, opts)).toEqual(clusterBootstrap(data, opts));
  });

  it("states whether the interval estimates a mean or median", () => {
    const meanResult = clusterBootstrap(panel, { ...opts, statistic: "mean", alpha: 0.5 });
    const medianResult = clusterBootstrap(panel, { ...opts, statistic: "median", alpha: 0.5 });
    expect(meanResult.statistic).toBe("mean");
    expect(medianResult.statistic).toBe("median");
    expect([meanResult.ciLow, meanResult.ciHigh]).not.toEqual([medianResult.ciLow, medianResult.ciHigh]);
    expect(meanResult.method).toBe("query-cluster-v1");
  });

  it("returns missing summaries for an empty set, not a zero measurement", () => {
    expect(clusterBootstrap([], opts)).toMatchObject({
      n: 0, rawN: 0, cellN: 0, mean: null, median: null, ciLow: null, ciHigh: null,
      mad: null, iqr: null, stability: null, lowN: true, queryValues: [],
    });
  });

  it("withholds a CI for one independent query regardless of repeat volume", () => {
    const result = clusterBootstrap(Array.from({ length: 500 }, () => panel[0]), opts);
    expect(result).toMatchObject({ n: 1, rawN: 500, mean: 0, ciLow: null, ciHigh: null, lowN: true });
  });

  it("uses query count for the low-N threshold and permits constant distributions", () => {
    const result = clusterBootstrap([
      observation("q1", "p1", 10), observation("q2", "p1", 10),
    ], { ...opts, lowNThreshold: 2 });
    expect(result).toMatchObject({ n: 2, lowN: false, ciLow: 10, ciHigh: 10, stability: 1 });
  });

  it("does not mutate inputs and honors the supplied dispersion estimator", () => {
    const input = Object.freeze(panel.map((row) => Object.freeze({ ...row })));
    const result = clusterBootstrap(input, { ...opts, stability: (values) => values.length / 10 });
    expect(result.stability).toBe(0.3);
    expect(input).toEqual(panel);
  });

  it.each([Number.NaN, Infinity, -Infinity])("rejects nonfinite observations: %s", (value) => {
    expect(() => clusterBootstrap([observation("q", "p", value)], opts)).toThrow(/finite/);
  });

  it("rejects missing identifiers and numeric overflow", () => {
    expect(() => clusterBootstrap([observation(" ", "p", 1)], opts)).toThrow(/non-empty/);
    expect(() => clusterBootstrap([observation("q", "", 1)], opts)).toThrow(/non-empty/);
    expect(() => clusterBootstrap([
      observation("q", "p", Number.MAX_VALUE), observation("q", "p", Number.MAX_VALUE),
    ], opts)).toThrow(/overflow/);
  });

  it("validates bootstrap options even for empty or singleton inputs", () => {
    for (const rows of [[], [panel[0]]]) {
      for (const b of [0, -1, 1.5, Infinity, Number.NaN]) {
        expect(() => clusterBootstrap(rows, { ...opts, b })).toThrow(/positive integer/);
      }
      for (const alpha of [0, 1, -1, Infinity, Number.NaN]) {
        expect(() => clusterBootstrap(rows, { ...opts, alpha })).toThrow(/\(0,1\)/);
      }
      for (const lowNThreshold of [0, 1, 2.5, Infinity]) {
        expect(() => clusterBootstrap(rows, { ...opts, lowNThreshold })).toThrow(/integer >= 2/);
      }
    }
  });
});

describe("pairedRetrievalDelta", () => {
  const pairs = [
    retrieval("q1", "both", "PARAMETRIC", 10),
    retrieval("q1", "both", "GROUNDED", 30),
    retrieval("q2", "both", "PARAMETRIC", 20),
    retrieval("q2", "both", "GROUNDED", 10),
  ];

  it("excludes mode-only providers, unmatched queries and incompatible provider cells", () => {
    const result = pairedRetrievalDelta([
      ...pairs,
      retrieval("q1", "grounded-only", "GROUNDED", 100),
      retrieval("q2", "grounded-only", "GROUNDED", 100),
      retrieval("q3", "both", "PARAMETRIC", 100),
      retrieval("q4", "left", "PARAMETRIC", 100),
      retrieval("q4", "right", "GROUNDED", 0),
    ], {
      ...opts,
      providerModes: {
        both: ["PARAMETRIC", "GROUNDED"],
        "grounded-only": ["GROUNDED"],
        left: ["PARAMETRIC", "GROUNDED"],
        right: ["PARAMETRIC", "GROUNDED"],
      },
    });
    expect(result).toMatchObject({
      method: "paired-query-cluster-v1", statistic: "mean", mean: 5,
      n: 2, rawN: 9, cellN: 2, pairedQueries: 2, pairedCells: 2,
      excludedModeOnlyCells: 5, excludedUnsupportedCells: 2,
      excludedUnsupportedProviders: 1, unknownSupportProviders: 0,
      rawRepeats: { parametric: 4, grounded: 5 },
      pairedRepeats: { parametric: 2, grounded: 2 },
    });
  });

  it("averages repeats within each mode, paired providers within query, then queries", () => {
    const result = pairedRetrievalDelta([
      ...pairs,
      ...Array.from({ length: 20 }, () => retrieval("q1", "both", "GROUNDED", 30)),
      retrieval("q1", "second", "PARAMETRIC", 0),
      retrieval("q1", "second", "GROUNDED", 60),
    ], opts);
    expect(result.queryValues).toEqual([{ queryId: "q1", value: 40 }, { queryId: "q2", value: -10 }]);
    expect(result.mean).toBe(15);
    expect(result.pairedCells).toBe(3);
    expect(result.pairedQueries).toBe(2);
  });

  it("does not inflate n or narrow the CI when repeat copies are added", () => {
    const original = pairedRetrievalDelta(pairs, opts);
    const repeated = pairedRetrievalDelta(Array.from({ length: 50 }, () => pairs).flat(), opts);
    expect(repeated).toMatchObject({ n: 2, pairedQueries: 2, pairedCells: 2, rawN: 200 });
    expect(repeated.ciLow).toBe(original.ciLow);
    expect(repeated.ciHigh).toBe(original.ciHigh);
    expect(repeated.mean).toBe(original.mean);
  });

  it("uses observed pairs without inventing missing capability metadata", () => {
    const result = pairedRetrievalDelta(pairs, opts);
    expect(result).toMatchObject({ mean: 5, pairedQueries: 2, unknownSupportProviders: 1 });
    expect(pairedRetrievalDelta(pairs, { ...opts, providerModes: {} })).toEqual(result);
  });

  it("rejects explicitly unsupported providers even if both modes exist in historical input", () => {
    const result = pairedRetrievalDelta(pairs, { ...opts, providerModes: { both: ["GROUNDED"] } });
    expect(result).toMatchObject({
      mean: null, ciLow: null, ciHigh: null, pairedQueries: 0, pairedCells: 0,
      excludedUnsupportedProviders: 1, excludedUnsupportedCells: 2, excludedModeOnlyCells: 0,
    });
  });

  it("returns absent deltas on empty or unpaired input and absent CI for a single pair", () => {
    for (const rows of [[], [pairs[0]], [pairs[1]]]) {
      expect(pairedRetrievalDelta(rows, opts)).toMatchObject({
        mean: null, ciLow: null, ciHigh: null, n: 0, lowN: true,
      });
    }
    expect(pairedRetrievalDelta(pairs.slice(0, 2), opts)).toMatchObject({
      mean: 20, n: 1, ciLow: null, ciHigh: null, lowN: true,
    });
  });

  it("is deterministic, order invariant and rejects invalid input before exclusions", () => {
    expect(pairedRetrievalDelta([...pairs].reverse(), opts)).toEqual(pairedRetrievalDelta(pairs, opts));
    expect(() => pairedRetrievalDelta([
      retrieval("q1", "only", "GROUNDED", Number.NaN),
    ], opts)).toThrow(/finite/);
    expect(() => pairedRetrievalDelta([
      { ...pairs[0], mode: "unknown" as RetrievalObservation["mode"] },
    ], opts)).toThrow(/unknown mode/);
  });

  it("keeps composite identifiers distinct and ignores inherited capability properties", () => {
    const rows = [
      retrieval("a|b", "c", "PARAMETRIC", 10),
      retrieval("a", "b|c", "GROUNDED", 100),
      retrieval("q", "constructor", "PARAMETRIC", 0),
      retrieval("q", "constructor", "GROUNDED", 20),
    ];
    expect(pairedRetrievalDelta(rows, { ...opts, providerModes: {} })).toMatchObject({
      mean: 20, pairedCells: 1, unknownSupportProviders: 3, excludedModeOnlyCells: 2,
    });
  });
});
