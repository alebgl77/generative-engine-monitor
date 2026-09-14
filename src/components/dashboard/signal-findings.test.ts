import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalFinding } from "@/lib/dashboard/signal-insights";
import {
  MEASUREMENT_PASSPORT_NOTICE,
  MEASUREMENT_PASSPORT_SCHEMA,
  type MeasurementAxisPayload,
  type MeasurementPassportPayload,
} from "@/lib/dashboard/measurement-passport";

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useMemo: <T>(factory: () => T) => factory(),
    useState: <T>(initial: T) => [initial, vi.fn()],
  };
});

import { MeasurementPassport } from "./signal-findings";

interface TestElement {
  type: unknown;
  props: {
    children?: unknown;
    onClick?: () => void;
  };
}

function isElement(value: unknown): value is TestElement {
  return typeof value === "object" && value !== null && "props" in value;
}

function textContent(value: unknown): string {
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return isElement(value) ? textContent(value.props.children) : "";
}

function findButton(value: unknown, label: string): TestElement {
  if (Array.isArray(value)) {
    for (const child of value) {
      try {
        return findButton(child, label);
      } catch {
        // Continue through the rendered tree.
      }
    }
  } else if (isElement(value)) {
    if (value.type === "button" && textContent(value).includes(label)) {
      return value;
    }
    return findButton(value.props.children, label);
  }
  throw new Error(`Button not found: ${label}`);
}

function axis(mode: MeasurementAxisPayload["mode"]): MeasurementAxisPayload {
  return {
    mode,
    median: mode === "GROUNDED" ? 42 : 37,
    interval: { low: 35, high: 45 },
    stability: 0.8,
    n: 3,
    rawN: 3,
    cellN: 1,
    nUnit: "queries",
    lowN: false,
    method: "bootstrap",
    brandPresenceRate: 1,
  };
}

function passport(exportedAt: string): MeasurementPassportPayload {
  return {
    schemaVersion: MEASUREMENT_PASSPORT_SCHEMA,
    app: { name: "Generative Engine Monitor", version: "2.0.0-test" },
    exportedAt,
    project: { name: "Veille France" },
    brands: { names: ["GEM"] },
    measurement: {
      classification: "grounded-recovery",
      query: "Question test",
      provider: { code: "mock", label: "Mock" },
      gapPoints: 5,
      axes: [axis("GROUNDED"), axis("PARAMETRIC")],
      notice: MEASUREMENT_PASSPORT_NOTICE,
    },
    method: { scoringVersion: "score-v3" },
    run: {
      status: "COMPLETED",
      completedAt: "2026-09-08T09:00:00.000Z",
      progress: {
        totalTasks: 2,
        totalSamples: 6,
        doneSamples: 6,
        failedSamples: 0,
      },
    },
  };
}

const finding = {
  lowN: false,
  queryText: "Question test",
  providerLabel: "Mock",
  gap: 5,
} as SignalFinding;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MeasurementPassport export actions", () => {
  it("copies Markdown with the click timestamp, not the preview timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-08T10:20:30.000Z");
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const rendered = MeasurementPassport({
      finding,
      payload: passport(new Date().toISOString()),
    });

    vi.setSystemTime("2026-09-09T11:22:33.000Z");
    findButton(rendered, "Copier en Markdown").props.onClick?.();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toContain(
      "- Export : 2026-09-09T11:22:33.000Z"
    );
    expect(writeText.mock.calls[0]?.[0]).not.toContain(
      "- Export : 2026-09-08T10:20:30.000Z"
    );
  });

  it("downloads JSON and names it with the click timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-08T23:59:59.000Z");
    const link = {
      href: "",
      download: "",
      hidden: false,
      click: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue(link),
      body: { appendChild: vi.fn() },
    });
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:measurement-passport");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const rendered = MeasurementPassport({
      finding,
      payload: passport(new Date().toISOString()),
    });

    vi.setSystemTime("2026-09-09T00:00:01.000Z");
    findButton(rendered, "Télécharger JSON").props.onClick?.();

    expect(link.download).toBe(
      "gem-passport-question-test-mock-2026-09-09.json"
    );
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(JSON.parse(await blob.text())).toMatchObject({
      exportedAt: "2026-09-09T00:00:01.000Z",
    });
    expect(await blob.text()).not.toContain("2026-09-08T23:59:59.000Z");
  });
});
