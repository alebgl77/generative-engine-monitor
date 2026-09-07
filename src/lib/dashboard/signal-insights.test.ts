import { describe, expect, it } from "vitest";
import type { QueriesResponse, QueryCell } from "@/types/api";
import {
  deriveSignalFindings,
  findingDataCompatibility,
} from "./signal-insights";

function cell(
  providerCode: string,
  mode: QueryCell["mode"],
  overrides: Partial<QueryCell> = {}
): QueryCell {
  return {
    providerCode,
    providerLabel: providerCode.toUpperCase(),
    mode,
    taskId: `${providerCode}-${mode}`,
    status: "COMPLETED",
    median: mode === "GROUNDED" ? 65 : 45,
    ciLow: 40,
    ciHigh: 70,
    stability: 0.8,
    n: 4,
    rawN: 12,
    cellN: 1,
    ciMethod: "query-cluster-v1",
    nUnit: "queries",
    lowN: false,
    brandPresenceRate: 0.5,
    ...overrides,
  };
}

function response(
  rows: QueriesResponse["rows"],
  overrides: Partial<QueriesResponse> = {}
): QueriesResponse {
  return {
    scoringVersion: "score-v3",
    runId: "run-current",
    rows,
    ...overrides,
  };
}

describe("deriveSignalFindings", () => {
  it("pairs only matching query and provider cells", () => {
    const data = response([
      {
        queryId: "q1",
        text: "Quelle marque recommander ?",
        cells: [
          cell("alpha", "GROUNDED", { median: 72 }),
          cell("alpha", "PARAMETRIC", { median: 41 }),
          cell("beta", "GROUNDED", { median: 90 }),
        ],
        brandPresenceRate: 0.5,
        competitors: [],
        avgCitations: 1,
      },
    ]);

    const findings = deriveSignalFindings(data);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "grounded-recovery",
      providerCode: "alpha",
      gap: 31,
    });
  });

  it("omits a pair when either median is null instead of coercing it to zero", () => {
    const data = response([
      {
        queryId: "q-null",
        text: "Cellule incomplète",
        cells: [
          cell("alpha", "GROUNDED", { median: null, n: 0, lowN: true }),
          cell("alpha", "PARAMETRIC", { median: 50 }),
        ],
        brandPresenceRate: 0,
        competitors: [],
        avgCitations: 0,
      },
    ]);

    expect(deriveSignalFindings(data)).toEqual([]);
  });

  it("retains measured low-N values and marks the finding indicative", () => {
    const data = response([
      {
        queryId: "q-low",
        text: "Signal faible effectif",
        cells: [
          cell("alpha", "GROUNDED", { median: 61, n: 1, lowN: true }),
          cell("alpha", "PARAMETRIC", { median: 45, n: 1 }),
        ],
        brandPresenceRate: 0.5,
        competitors: [],
        avgCitations: 0,
      },
    ]);

    expect(deriveSignalFindings(data)[0]).toMatchObject({
      gap: 16,
      lowN: true,
    });
  });

  it("uses zero presence in both measured modes for broad invisibility", () => {
    const data = response([
      {
        queryId: "q-hidden",
        text: "Qui domine ce marché ?",
        cells: [
          cell("alpha", "GROUNDED", { median: 18, brandPresenceRate: 0 }),
          cell("alpha", "PARAMETRIC", { median: 15, brandPresenceRate: 0 }),
        ],
        brandPresenceRate: 0,
        competitors: [],
        avgCitations: 0,
      },
    ]);

    expect(deriveSignalFindings(data)[0]).toMatchObject({
      kind: "broad-invisibility",
      gap: 3,
    });
  });

  it("sorts equal findings deterministically by query then provider", () => {
    const rows: QueriesResponse["rows"] = ["Zulu", "Alpha"].map(
      (text, index) => ({
        queryId: `q${index}`,
        text,
        cells: [
          cell("beta", "GROUNDED", { median: 40 }),
          cell("beta", "PARAMETRIC", { median: 50 }),
          cell("alpha", "GROUNDED", { median: 40 }),
          cell("alpha", "PARAMETRIC", { median: 50 }),
        ],
        brandPresenceRate: 0.5,
        competitors: [],
        avgCitations: 0,
      })
    );

    expect(
      deriveSignalFindings(response(rows)).map(
        (finding) => `${finding.queryText}:${finding.providerCode}`
      )
    ).toEqual(["Alpha:alpha", "Alpha:beta", "Zulu:alpha", "Zulu:beta"]);
  });
});

describe("findingDataCompatibility", () => {
  it("rejects absent, different-run and different-method data", () => {
    expect(
      findingDataCompatibility(
        { runId: null, scoringVersion: "score-v3" },
        "run-current",
        "score-v3"
      )
    ).toBe("no-run");
    expect(
      findingDataCompatibility(
        { runId: "run-old", scoringVersion: "score-v3" },
        "run-current",
        "score-v3"
      )
    ).toBe("run-mismatch");
    expect(
      findingDataCompatibility(
        { runId: "run-current", scoringVersion: "score-v2" },
        "run-current",
        "score-v3"
      )
    ).toBe("version-mismatch");
    expect(
      findingDataCompatibility(
        { runId: "run-current", scoringVersion: "score-v3" },
        "run-current",
        "score-v3"
      )
    ).toBe("match");
  });
});
