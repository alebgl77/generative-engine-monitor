import { iqr, mad, makeRng, mean, median, quantile, stability } from "@/lib/scoring/stats";

export const QUERY_CLUSTER_METHOD = "query-cluster-v1";
export const PAIRED_RETRIEVAL_METHOD = "paired-query-cluster-v1";

/** One successful repeat. Failures are missing observations, never zero scores. */
export interface ClusterObservation {
  queryId: string;
  providerId: string;
  value: number;
}

export interface ClusterBootstrapOptions {
  seed: string;
  b?: number;
  alpha?: number;
  lowNThreshold?: number;
  /** The interval targets this statistic of equal-weight query means. */
  statistic?: "mean" | "median";
  stability?: (xs: number[]) => number;
}

export interface ClusterEstimate {
  method: typeof QUERY_CLUSTER_METHOD;
  statistic: "mean" | "median";
  /** Independent query clusters, not repeat count. */
  n: number;
  rawN: number;
  cellN: number;
  mean: number | null;
  median: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  mad: number | null;
  iqr: number | null;
  stability: number | null;
  lowN: boolean;
  bootstrapSeed: string;
  queryValues: { queryId: string; value: number }[];
}

function validateObservation(observation: ClusterObservation): void {
  if (!observation.queryId.trim() || !observation.providerId.trim()) {
    throw new Error("clusterBootstrap: queryId and providerId must be non-empty");
  }
  if (!Number.isFinite(observation.value)) {
    throw new Error("clusterBootstrap: values must be finite");
  }
}

function ordered<T>(entries: Iterable<[string, T]>): [string, T][] {
  return Array.from(entries).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Numeric order also makes floating-point summation independent of row order. */
function orderedMean(values: number[]): number {
  const result = mean([...values].sort((left, right) => left - right));
  if (!Number.isFinite(result)) throw new Error("clusterBootstrap: mean overflow");
  return result;
}

/**
 * Estimate over a fixed, observed provider panel: first average repeats in a
 * query/provider cell, then equally weight providers within each query, then
 * equally weight queries. Only query means are resampled. More repeats do not
 * manufacture independent units or upweight a query with fewer failed calls.
 * Missing cells are not imputed; see docs/measurement-methodology.md.
 */
export function clusterBootstrap(
  observations: readonly ClusterObservation[],
  opts: ClusterBootstrapOptions
): ClusterEstimate {
  const b = opts.b ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const lowNThreshold = opts.lowNThreshold ?? 30;
  const statistic = opts.statistic ?? "median";
  if (!Number.isInteger(b) || b < 1) {
    throw new Error("clusterBootstrap: b must be a positive integer");
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new Error("clusterBootstrap: alpha must be in (0,1)");
  }
  if (!Number.isInteger(lowNThreshold) || lowNThreshold < 2) {
    throw new Error("clusterBootstrap: lowNThreshold must be an integer >= 2");
  }
  if (statistic !== "mean" && statistic !== "median") {
    throw new Error("clusterBootstrap: unknown statistic");
  }

  const queries = new Map<string, Map<string, number[]>>();
  for (const observation of observations) {
    validateObservation(observation);
    let providers = queries.get(observation.queryId);
    if (!providers) {
      providers = new Map();
      queries.set(observation.queryId, providers);
    }
    const repeats = providers.get(observation.providerId);
    if (repeats) repeats.push(observation.value);
    else providers.set(observation.providerId, [observation.value]);
  }

  let cellN = 0;
  const queryValues = ordered(queries).map(([queryId, providers]) => {
    cellN += providers.size;
    const cellMeans = ordered(providers).map(([, repeats]) => orderedMean(repeats));
    return { queryId, value: orderedMean(cellMeans) };
  });
  const values = queryValues.map(({ value }) => value);
  const n = values.length;
  let ciLow: number | null = null;
  let ciHigh: number | null = null;
  if (n >= 2) {
    const rng = makeRng(opts.seed);
    const estimates = new Array<number>(b);
    const estimate = statistic === "mean" ? orderedMean : median;
    for (let i = 0; i < b; i++) {
      const draw = Array.from({ length: n }, () => values[Math.floor(rng() * n)]);
      estimates[i] = estimate(draw);
    }
    ciLow = quantile(estimates, alpha / 2);
    ciHigh = quantile(estimates, 1 - alpha / 2);
  }

  return {
    method: QUERY_CLUSTER_METHOD,
    statistic,
    n,
    rawN: observations.length,
    cellN,
    mean: n > 0 ? orderedMean(values) : null,
    median: n > 0 ? median(values) : null,
    ciLow,
    ciHigh,
    mad: n > 0 ? mad(values) : null,
    iqr: n > 0 ? iqr(values) : null,
    stability: n > 0 ? (opts.stability ?? stability)(values) : null,
    lowN: n < lowNThreshold,
    bootstrapSeed: opts.seed,
    queryValues,
  };
}

export interface RetrievalObservation extends ClusterObservation {
  mode: "PARAMETRIC" | "GROUNDED";
}

interface RepeatCounts {
  parametric: number;
  grounded: number;
}

export interface PairedRetrievalEstimate extends Omit<ClusterEstimate, "method"> {
  method: typeof PAIRED_RETRIEVAL_METHOD;
  pairedQueries: number;
  pairedCells: number;
  excludedModeOnlyCells: number;
  excludedUnsupportedCells: number;
  excludedUnsupportedProviders: number;
  unknownSupportProviders: number;
  rawRepeats: RepeatCounts;
  pairedRepeats: RepeatCounts;
}

/**
 * Within-cell grounded minus parametric repeat means, averaged across paired
 * providers and then queries. A mode-only provider can never contribute a
 * between-provider difference. Unknown capability metadata is reported, not
 * guessed: an observed pair may still be used unless support explicitly rules
 * it out. The interval targets the mean query-level difference, not a median.
 */
export function pairedRetrievalDelta(
  observations: readonly RetrievalObservation[],
  opts: Omit<ClusterBootstrapOptions, "statistic"> & {
    providerModes?: Readonly<Record<string, readonly string[]>>;
  }
): PairedRetrievalEstimate {
  const cells = new Map<string, {
    queryId: string;
    providerId: string;
    parametric: number[];
    grounded: number[];
  }>();
  const unknownProviders = new Set<string>();
  const unsupportedProviders = new Set<string>();
  const rawRepeats: RepeatCounts = { parametric: 0, grounded: 0 };
  const pairedRepeats: RepeatCounts = { parametric: 0, grounded: 0 };

  for (const observation of observations) {
    validateObservation(observation);
    if (observation.mode !== "PARAMETRIC" && observation.mode !== "GROUNDED") {
      throw new Error("pairedRetrievalDelta: unknown mode");
    }
    const key = JSON.stringify([observation.queryId, observation.providerId]);
    let cell = cells.get(key);
    if (!cell) {
      cell = { queryId: observation.queryId, providerId: observation.providerId, parametric: [], grounded: [] };
      cells.set(key, cell);
    }
    const mode = observation.mode === "PARAMETRIC" ? "parametric" : "grounded";
    cell[mode].push(observation.value);
    rawRepeats[mode] += 1;
  }

  let excludedModeOnlyCells = 0;
  let excludedUnsupportedCells = 0;
  const differences: ClusterObservation[] = [];
  for (const cell of cells.values()) {
    const supported = opts.providerModes && Object.hasOwn(opts.providerModes, cell.providerId)
      ? opts.providerModes[cell.providerId]
      : undefined;
    if (supported === undefined) unknownProviders.add(cell.providerId);
    const unsupported = supported !== undefined &&
      !(supported.includes("PARAMETRIC") && supported.includes("GROUNDED"));
    const modeOnly = cell.parametric.length === 0 || cell.grounded.length === 0;
    if (modeOnly) excludedModeOnlyCells += 1;
    if (unsupported) {
      unsupportedProviders.add(cell.providerId);
      excludedUnsupportedCells += 1;
    }
    if (unsupported || modeOnly) continue;
    differences.push({
      queryId: cell.queryId,
      providerId: cell.providerId,
      value: orderedMean(cell.grounded) - orderedMean(cell.parametric),
    });
    pairedRepeats.parametric += cell.parametric.length;
    pairedRepeats.grounded += cell.grounded.length;
  }

  const summary = clusterBootstrap(differences, { ...opts, statistic: "mean" });
  return {
    ...summary,
    method: PAIRED_RETRIEVAL_METHOD,
    rawN: observations.length,
    pairedQueries: summary.n,
    pairedCells: summary.cellN,
    excludedModeOnlyCells,
    excludedUnsupportedCells,
    excludedUnsupportedProviders: unsupportedProviders.size,
    unknownSupportProviders: unknownProviders.size,
    rawRepeats,
    pairedRepeats,
  };
}
