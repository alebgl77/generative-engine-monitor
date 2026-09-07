import { describe, expect, it } from "vitest";
import type { QueryCell } from "@/types/api";
import type { SignalFinding } from "./signal-insights";
import {
  buildMeasurementPassport,
  measurementPassportFilename,
  renderMeasurementPassportMarkdown,
  serializeMeasurementPassport,
} from "./measurement-passport";

function measuredCell(
  mode: QueryCell["mode"],
  overrides: Partial<QueryCell> = {}
): QueryCell & { median: number } {
  const median = overrides.median ?? (mode === "GROUNDED" ? 0 : 12.5);
  return {
    providerCode: "engine/a",
    providerLabel: "Engine | Europe",
    mode,
    taskId: `private-task-${mode}`,
    status: "COMPLETED",
    ciLow: null,
    ciHigh: null,
    stability: null,
    n: 2,
    lowN: true,
    brandPresenceRate: 0,
    ...overrides,
    median,
  };
}

function finding(overrides: Partial<SignalFinding> = {}): SignalFinding {
  const grounded = measuredCell("GROUNDED");
  const parametric = measuredCell("PARAMETRIC");
  return {
    id: "private-query:engine/a:grounded-erosion",
    kind: "grounded-erosion",
    queryId: "private-query",
    queryText: "Comparatif café | hôtel / été",
    providerCode: "engine/a",
    providerLabel: "Engine | Europe",
    grounded,
    parametric,
    gap: grounded.median - parametric.median,
    lowN: true,
    sortMagnitude: 12.5,
    ...overrides,
  };
}

function passport() {
  return buildMeasurementPassport({
    finding: finding(),
    projectName: "Veille France",
    brandNames: [],
    scoringVersion: "score-v3",
    run: {
      status: "PARTIAL",
      completedAt: null,
      progress: {
        totalTasks: 4,
        totalSamples: 8,
        doneSamples: 6,
        failedSamples: 2,
      },
    },
    exportedAt: "2026-09-08T10:20:30.000Z",
    appVersion: "2.0.0-test",
  });
}

describe("measurement passport", () => {
  it("builds a deterministic canonical payload without internal identifiers", () => {
    const payload = passport();
    const json = serializeMeasurementPassport(payload);

    expect(payload).toMatchObject({
      schemaVersion: "gem.measurement-passport/v1",
      app: { name: "Generative Engine Monitor", version: "2.0.0-test" },
      exportedAt: "2026-09-08T10:20:30.000Z",
      measurement: {
        query: "Comparatif café | hôtel / été",
        gapPoints: -12.5,
      },
    });
    expect(serializeMeasurementPassport(payload)).toBe(json);
    expect(payload.measurement.axes.map((axis) => axis.mode)).toEqual([
      "GROUNDED",
      "PARAMETRIC",
    ]);
    expect(json).not.toContain("private-task");
    expect(json).not.toContain("private-query");
    expect(json).not.toContain("runId");
    expect(json.endsWith("\n")).toBe(true);
  });

  it("renders every missing value as indisponible while preserving real zeroes", () => {
    const markdown = renderMeasurementPassportMarkdown(passport());

    expect(markdown).toContain("Marques : indisponible");
    expect(markdown).toContain("terminé indisponible");
    expect(markdown).toContain("| GROUNDÉ | 0 | indisponible | indisponible");
    expect(markdown).toContain("| PARAMÉTRIQUE | 12,5 | indisponible");
    expect(markdown).toContain("Comparaison descriptive et non causale");
    expect(markdown).toContain("Engine \\| Europe");
    expect(markdown).not.toContain("private-task");
  });

  it("injects the supplied timestamp instead of reading the clock", () => {
    const first = passport();
    const second = buildMeasurementPassport({
      finding: finding(),
      projectName: "Veille France",
      brandNames: [],
      scoringVersion: "score-v3",
      run: first.run,
      exportedAt: new Date("2026-01-02T03:04:05.000Z"),
      appVersion: "2.0.0-test",
    });

    expect(second.exportedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("sanitizes the JSON download name and removes path separators", () => {
    const payload = passport();
    payload.measurement.query = "../../Été CON: rapport? * final";
    payload.measurement.provider.code = "vendor/../../alpha";

    const filename = measurementPassportFilename(payload);

    expect(filename).toBe(
      "gem-passport-ete-con-rapport-final-vendor-alpha-2026-09-08.json"
    );
    expect(filename).not.toMatch(/[\\/:*?\"<>|]/);
    expect(filename.length).toBeLessThan(100);
  });

  it("sorts every measured brand name without collapsing the project to one brand", () => {
    const payload = buildMeasurementPassport({
      finding: finding(),
      projectName: "Veille France",
      brandNames: ["Zèbre", "Alpha"],
      scoringVersion: "score-v3",
      run: passport().run,
      exportedAt: "2026-09-08T10:20:30.000Z",
      appVersion: "2.0.0-test",
    });

    expect(payload.brands.names).toEqual(["Alpha", "Zèbre"]);
    expect(renderMeasurementPassportMarkdown(payload)).toContain(
      "Marques : Alpha, Zèbre"
    );
  });

  it("renders user-controlled Markdown metacharacters as literal evidence", () => {
    const malicious = "![x](https://example.test/pixel) `code` | ligne\nsuivante";
    const payload = buildMeasurementPassport({
      finding: finding({ queryText: malicious }),
      projectName: malicious,
      brandNames: [malicious],
      scoringVersion: "score-v3",
      run: passport().run,
      exportedAt: "2026-09-08T10:20:30.000Z",
      appVersion: "2.0.0-test",
    });

    const markdown = renderMeasurementPassportMarkdown(payload);
    expect(markdown).not.toContain("![x](https://example.test/pixel)");
    expect(markdown).toContain(
      "\\!\\[x\\]\\(https://example\\.test/pixel\\) \\`code\\` \\| ligne suivante"
    );
  });
});
