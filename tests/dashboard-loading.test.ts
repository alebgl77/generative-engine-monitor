// @vitest-environment jsdom

import { act, createElement, StrictMode, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SamplingMode } from "@prisma/client";
import type {
  ProjectSummary,
  QueriesResponse,
  RunDetailResponse,
  RunSummary,
  SourcesResponse,
} from "@/types/api";
import QueriesPage from "@/app/(dashboard)/projects/[projectId]/queries/page";
import SourcesPage from "@/app/(dashboard)/projects/[projectId]/sources/page";
import RunsPage from "@/app/(dashboard)/projects/[projectId]/runs/page";
import SettingsPage from "@/app/(dashboard)/projects/[projectId]/settings/page";

const navigation = vi.hoisted(() => ({ projectId: "project-a", toast: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ projectId: navigation.projectId }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: navigation.toast }) }));

interface PendingRequest {
  url: string;
  init?: RequestInit;
  resolve: (response: Response) => void;
}

let container: HTMLDivElement;
let root: Root | null;
let requests: PendingRequest[];

beforeEach(() => {
  navigation.projectId = "project-a";
  requests = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Deliberately deliver responses even after abort: a completed fetch / JSON
  // callback can already be queued when navigation cleans up its effect.
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) =>
    new Promise<Response>((resolve) => requests.push({ url, init, resolve }))
  ));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await unmount();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function render(Page: ComponentType, strict = false) {
  await act(async () => {
    root!.render(strict ? createElement(StrictMode, null, createElement(Page)) : createElement(Page));
  });
}

async function unmount() {
  await act(async () => root?.unmount());
  root = null;
}

function sent(url: string, method = "GET") {
  return requests.filter((request) => request.url === url && (request.init?.method ?? "GET") === method);
}

function request(url: string, index = 0, method = "GET") {
  const result = sent(url, method)[index];
  if (!result) throw new Error(`Missing ${method} ${url}, request ${index + 1}`);
  return result;
}

async function answer(pending: PendingRequest, payload: unknown, status = 200) {
  await act(async () => pending.resolve(Response.json(payload, { status })));
}

function button(text: string) {
  const result = [...container.querySelectorAll("button")].find((element) =>
    (element.getAttribute("aria-label") ?? element.textContent)?.includes(text)
  );
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function repetitions() {
  const select = container.querySelector<HTMLSelectElement>("#repetitions");
  if (!select) throw new Error("Missing repetitions selector");
  return select;
}

async function chooseRepetitions(value: number) {
  await act(async () => {
    repetitions().value = String(value);
    repetitions().dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function modeCheckbox(text: string) {
  const label = [...container.querySelectorAll("label")].find((element) => element.textContent?.startsWith(text));
  const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error(`Missing sampling mode: ${text}`);
  return checkbox;
}

function queryData(text: string): QueriesResponse {
  return {
    runId: "run-1",
    scoringVersion: "test",
    rows: [{ queryId: text, text, cells: [], brandPresenceRate: 0, competitors: [], avgCitations: 0 }],
  };
}

function sourceData(domain: string): SourcesResponse {
  return {
    runId: "run-1",
    rows: [{ domain, citationCount: 1, sampleCount: 1, citationShare: 1, isBrandDomain: false, modes: [], providers: [], queries: [] }],
  };
}

describe.each([
  { name: "queries", Page: QueriesPage, data: queryData },
  { name: "sources", Page: SourcesPage, data: sourceData },
])("$name loading", ({ name, Page, data }) => {
  const url = (projectId = "project-a") => `/api/projects/${projectId}/dashboard/${name}`;

  it("loads initially and retries a failed request through the visible button", async () => {
    await render(Page);
    expect(sent(url())).toHaveLength(1);
    await answer(request(url()), { error: "Service temporairement indisponible" }, 503);
    expect(container.textContent).toContain("Service temporairement indisponible");

    await click(button("Réessayer"));
    expect(container.textContent).not.toContain("Service temporairement indisponible");
    await answer(request(url(), 1), data("current.example.test"));
    expect(container.textContent).toContain("current.example.test");
    expect(container.textContent).not.toContain("Réessayer");
  });

  it("ignores an old project's response after navigation", async () => {
    await render(Page);
    await answer(request(url()), data("previous.example.test"));
    expect(container.textContent).toContain("previous.example.test");
    navigation.projectId = "project-b";
    await render(Page);
    expect(container.textContent).not.toContain("previous.example.test");
    const old = request(url("project-b"));
    navigation.projectId = "project-c";
    await render(Page);
    expect(old.init?.signal?.aborted).toBe(true);

    await answer(request(url("project-c")), data("project-c.example.test"));
    await answer(old, data("stale.example.test"));
    expect(container.textContent).toContain("project-c.example.test");
    expect(container.textContent).not.toContain("stale.example.test");
  });

  it("survives StrictMode cleanup without accepting the discarded request", async () => {
    await render(Page, true);
    expect(sent(url())).toHaveLength(2);
    expect(request(url()).init?.signal?.aborted).toBe(true);
    await answer(request(url(), 1), data("current.example.test"));
    await answer(request(url()), { error: "Obsolete failure" }, 503);
    expect(container.textContent).toContain("current.example.test");
    expect(container.textContent).not.toContain("Obsolete failure");

    await unmount();
    expect(request(url(), 1).init?.signal?.aborted).toBe(true);
  });
});

function run(id: string, status: "COMPLETED" | "RUNNING" = "COMPLETED", done = 3): RunSummary {
  return {
    id, status, scoringVersion: id, repetitions: 3, modes: ["PARAMETRIC"],
    createdAt: "2026-10-23T12:00:00Z", startedAt: null, completedAt: null,
    progress: { totalTasks: 1, totalSamples: 3, doneSamples: done, failedSamples: 0 },
    taskCounts: { total: 1, byStatus: { PENDING: 0, RUNNING: status === "RUNNING" ? 1 : 0, COMPLETED: status === "COMPLETED" ? 1 : 0, PARTIAL: 0, FAILED: 0, CANCELLED: 0 } },
    tasks: [{
      id: `task-${id}`, mode: "PARAMETRIC", status,
      query: { id: `query-${id}`, text: `Question ${id}` },
      provider: { code: "mock", label: "Mock" },
      samples: { total: 3, done, failed: 0 }, score: null, errorMessage: null,
    }],
  };
}

function detail(summary: RunSummary, text: string): RunDetailResponse {
  return {
    ...summary,
    tasksDetail: summary.tasks.map((task) => ({
      ...task,
      samples: [{
        id: `sample-${summary.id}`, sampleIndex: 0, status: "COMPLETED", model: "mock",
        latencyMs: 10, errorMessage: null, text, textTruncated: false,
        score: 42, contributions: [], mentions: [], citations: [],
      }],
    })),
  };
}

describe("run loading", () => {
  const url = "/api/projects/project-a/runs";

  it.each([200, 503])("ignores an obsolete detail response (%s) after selecting another run", async (status) => {
    const first = run("run-a");
    const second = run("run-b");
    await render(RunsPage);
    await answer(request(url), { runs: [first, second] });
    await click(button("scoring run-a"));
    await click(button("Question run-a"));
    const old = request(`${url}/run-a`);

    await click(button("scoring run-b"));
    await click(button("Question run-b"));
    expect(old.init?.signal?.aborted).toBe(true);
    await answer(request(`${url}/run-b`), detail(second, "Current run B answer"));
    await answer(old, status === 200 ? detail(first, "Obsolete run A answer") : { error: "Obsolete detail error" }, status);
    expect(container.textContent).toContain("Current run B answer");
    expect(container.textContent).not.toContain("Obsolete run A answer");
    expect(container.textContent).not.toContain("Obsolete detail error");
  });

  it("keeps existing samples visible while polling and stops polling on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = run("active", "RUNNING", 1);
    const next = run("active", "RUNNING", 2);
    await render(RunsPage);
    await answer(request(url), { runs: [first] });
    await click(button("scoring active"));
    await click(button("Question active"));
    await answer(request(`${url}/active`), detail(first, "Existing answer"));

    await act(async () => { vi.advanceTimersByTime(5000); });
    await answer(request(url, 1), { runs: [next] });
    expect(sent(`${url}/active`)).toHaveLength(2);
    expect(container.textContent).toContain("Existing answer");
    expect(container.textContent).not.toContain("Aucun échantillon exploitable");
    await answer(request(`${url}/active`, 1), detail(next, "Updated answer"));
    expect(container.textContent).toContain("Updated answer");
    expect(container.textContent).not.toContain("Existing answer");

    await unmount();
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(sent(url)).toHaveLength(2);
  });

  it("restarts the initial request after StrictMode cleanup", async () => {
    await render(RunsPage, true);
    expect(sent(url)).toHaveLength(2);
    expect(request(url).init?.signal?.aborted).toBe(true);
    await answer(request(url, 1), { runs: [run("current")] });
    await answer(request(url), { runs: [run("obsolete")] });
    expect(container.textContent).toContain("scoring current");
    expect(container.textContent).not.toContain("scoring obsolete");
  });

  it("fetches the newly created run without reusing an older pending list request", async () => {
    const existing = run("existing");
    const created = run("created", "RUNNING", 0);
    await render(RunsPage);
    await answer(request(url), { runs: [existing] });
    await click(button("Actualiser"));
    const old = request(url, 1);
    await click(button("Nouvelle analyse"));
    await answer(request(url, 0, "POST"), {
      runId: created.id, totalTasks: 1, totalSamples: 3, skipped: [],
    });

    expect(sent(url)).toHaveLength(3);
    expect(old.init?.signal?.aborted).toBe(true);
    await answer(request(url, 2), { runs: [created, existing] });
    await answer(old, { runs: [existing] });
    expect(container.textContent).toContain("scoring created");
    expect(container.textContent).toContain("scoring existing");
  });

  it("retries a failed detail on refresh even when run counters are unchanged", async () => {
    const summary = run("unchanged");
    await render(RunsPage);
    await answer(request(url), { runs: [summary] });
    await click(button("scoring unchanged"));
    await click(button("Question unchanged"));
    await answer(request(`${url}/unchanged`), { error: "Temporary detail failure" }, 503);
    expect(container.textContent).toContain("Temporary detail failure");

    await click(button("Actualiser"));
    await answer(request(url, 1), { runs: [summary] });
    expect(sent(`${url}/unchanged`)).toHaveLength(2);
    await answer(request(`${url}/unchanged`, 1), detail(summary, "Recovered answer"));
    expect(container.textContent).toContain("Recovered answer");
    expect(container.textContent).not.toContain("Temporary detail failure");
  });

  it("does not refresh or notify when a mutation finishes after unmount", async () => {
    await render(RunsPage);
    await answer(request(url), { runs: [] });
    await click(button("Nouvelle analyse"));
    const mutation = request(url, 0, "POST");
    await unmount();
    await answer(mutation, { runId: "created", totalTasks: 1, totalSamples: 3, skipped: [] });
    expect(sent(url)).toHaveLength(1);
    expect(navigation.toast).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });
});

async function answerSettingsBatch(round: number, options: {
  repetitions?: number;
  samplingModes?: SamplingMode[];
  brands?: { id: string; name: string; domain: string | null }[];
} = {}) {
  const project: ProjectSummary = {
    id: "project-a", name: "Project A", domain: null,
    targetCountry: "FR", targetLanguage: "fr",
    repetitions: options.repetitions ?? 3,
    samplingModes: options.samplingModes ?? ["PARAMETRIC", "GROUNDED"],
    activeScoringVersion: "test", createdAt: "2026-10-23T12:00:00Z",
    counts: { brands: 1, competitors: 0, queries: 0 }, lastRunAt: null,
  };
  const payloads: [string, unknown][] = [
    ["/api/projects/project-a", project],
    ["/api/projects/project-a/brands", options.brands ?? [{ id: "brand-1", name: "Existing brand", domain: null }]],
    ["/api/projects/project-a/competitors", []],
    ["/api/projects/project-a/queries", []],
    ["/api/providers", []],
    ["/api/providers/credentials", []],
  ];
  await act(async () => {
    for (const [url, payload] of payloads) request(url, round).resolve(Response.json(payload));
  });
}

describe("sampling edits", () => {
  const url = "/api/projects/project-a";
  const dirtyLabel = "Modifications non enregistrées";

  it("preserves edits made while an unrelated mutation refreshes settings", async () => {
    await render(SettingsPage);
    await answerSettingsBatch(0);
    expect(repetitions().value).toBe("3");
    await click(button("Supprimer"));
    await answer(request(`${url}/brands/brand-1`, 0, "DELETE"), {});
    expect(sent(url)).toHaveLength(2);

    await chooseRepetitions(5);
    await click(modeCheckbox("Groundé"));
    await answerSettingsBatch(1, { brands: [] });
    expect(repetitions().value).toBe("5");
    expect(modeCheckbox("Groundé").checked).toBe(false);
    expect(container.textContent).toContain(dirtyLabel);
    expect(container.textContent).not.toContain("Existing brand");
  });

  it("keeps edits made during PUT dirty until their own save succeeds", async () => {
    await render(SettingsPage);
    await answerSettingsBatch(0);
    await chooseRepetitions(5);
    await click(button("Enregistrer"));
    const firstSave = request(url, 0, "PUT");
    expect(JSON.parse(String(firstSave.init?.body))).toEqual({ repetitions: 5, samplingModes: ["PARAMETRIC", "GROUNDED"] });

    await chooseRepetitions(7);
    await click(modeCheckbox("Groundé"));
    await answer(firstSave, {});
    await answerSettingsBatch(1, { repetitions: 5 });
    expect(repetitions().value).toBe("7");
    expect(modeCheckbox("Groundé").checked).toBe(false);
    expect(container.textContent).toContain(dirtyLabel);

    await click(button("Enregistrer"));
    const secondSave = request(url, 1, "PUT");
    expect(JSON.parse(String(secondSave.init?.body))).toEqual({ repetitions: 7, samplingModes: ["PARAMETRIC"] });
    await answer(secondSave, {});
    await answerSettingsBatch(2, { repetitions: 7, samplingModes: ["PARAMETRIC"] });
    expect(repetitions().value).toBe("7");
    expect(modeCheckbox("Groundé").checked).toBe(false);
    expect(container.textContent).not.toContain(dirtyLabel);
  });

  it("ignores the first StrictMode load even after the second has completed", async () => {
    await render(SettingsPage, true);
    expect(sent(url)).toHaveLength(2);
    await answerSettingsBatch(1, { repetitions: 6 });
    await answerSettingsBatch(0, { repetitions: 1, brands: [{ id: "obsolete", name: "Obsolete brand", domain: null }] });
    expect(repetitions().value).toBe("6");
    expect(container.textContent).toContain("Existing brand");
    expect(container.textContent).not.toContain("Obsolete brand");
    expect(navigation.toast).not.toHaveBeenCalled();
  });
});
