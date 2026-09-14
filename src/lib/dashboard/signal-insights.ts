import type { QueriesResponse, QueryCell } from "@/types/api";

export const SIGNAL_GAP_THRESHOLD = 5;

export type SignalFindingKind =
  | "broad-invisibility"
  | "grounded-erosion"
  | "grounded-recovery";

export interface SignalFinding {
  id: string;
  kind: SignalFindingKind;
  queryId: string;
  queryText: string;
  providerCode: string;
  providerLabel: string;
  grounded: QueryCell & { median: number };
  parametric: QueryCell & { median: number };
  gap: number;
  lowN: boolean;
  sortMagnitude: number;
}

export type FindingDataCompatibility =
  | "match"
  | "no-run"
  | "run-mismatch"
  | "version-mismatch";

function isMeasuredCell(
  cell: QueryCell | undefined
): cell is QueryCell & { median: number } {
  return Boolean(
    cell &&
      cell.n > 0 &&
      cell.median !== null &&
      Number.isFinite(cell.median)
  );
}

function lexicalCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function kindPriority(kind: SignalFindingKind): number {
  if (kind === "broad-invisibility") return 0;
  if (kind === "grounded-erosion") return 1;
  return 2;
}

function classifyPair(
  grounded: QueryCell & { median: number },
  parametric: QueryCell & { median: number }
): Pick<SignalFinding, "kind" | "sortMagnitude"> | null {
  const gap = grounded.median - parametric.median;

  // Presence is measured independently in each cell. Exactly zero in both
  // channels is the only condition called "invisibility" here.
  if (
    grounded.brandPresenceRate === 0 &&
    parametric.brandPresenceRate === 0
  ) {
    return {
      kind: "broad-invisibility",
      sortMagnitude: Math.max(0, 100 - Math.max(grounded.median, parametric.median)),
    };
  }
  if (gap <= -SIGNAL_GAP_THRESHOLD) {
    return { kind: "grounded-erosion", sortMagnitude: Math.abs(gap) };
  }
  if (gap >= SIGNAL_GAP_THRESHOLD) {
    return { kind: "grounded-recovery", sortMagnitude: gap };
  }
  return null;
}

/**
 * Builds an editorial queue from real query cells. Pairing never crosses a
 * query or provider boundary, and a missing measurement removes the pair
 * instead of coercing it to zero.
 */
export function deriveSignalFindings(
  response: QueriesResponse,
  limit = 4
): SignalFinding[] {
  if (limit <= 0) return [];

  const findings: SignalFinding[] = [];

  for (const row of response.rows) {
    const providers = new Map<string, Map<QueryCell["mode"], QueryCell>>();
    for (const cell of row.cells) {
      const modes = providers.get(cell.providerCode) ?? new Map();
      // The API contract emits one cell per provider/mode. Keeping the first
      // makes malformed duplicates deterministic without blending evidence.
      if (!modes.has(cell.mode)) modes.set(cell.mode, cell);
      providers.set(cell.providerCode, modes);
    }

    for (const [providerCode, modes] of providers) {
      const grounded = modes.get("GROUNDED");
      const parametric = modes.get("PARAMETRIC");
      if (!isMeasuredCell(grounded) || !isMeasuredCell(parametric)) continue;

      const classification = classifyPair(grounded, parametric);
      if (!classification) continue;

      findings.push({
        id: `${row.queryId}:${providerCode}:${classification.kind}`,
        kind: classification.kind,
        queryId: row.queryId,
        queryText: row.text,
        providerCode,
        providerLabel: grounded.providerLabel,
        grounded,
        parametric,
        gap: grounded.median - parametric.median,
        lowN: grounded.lowN || parametric.lowN,
        sortMagnitude: classification.sortMagnitude,
      });
    }
  }

  return findings
    .sort(
      (left, right) =>
        kindPriority(left.kind) - kindPriority(right.kind) ||
        right.sortMagnitude - left.sortMagnitude ||
        lexicalCompare(left.queryText, right.queryText) ||
        lexicalCompare(left.providerCode, right.providerCode) ||
        lexicalCompare(left.id, right.id)
    )
    .slice(0, limit);
}

export function findingDataCompatibility(
  response: Pick<QueriesResponse, "runId" | "scoringVersion">,
  runId: string,
  scoringVersion: string
): FindingDataCompatibility {
  if (response.runId === null) return "no-run";
  if (response.runId !== runId) return "run-mismatch";
  if (response.scoringVersion !== scoringVersion) return "version-mismatch";
  return "match";
}
