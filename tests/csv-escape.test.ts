import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The export route is driven end to end: the CSV escaping contract only matters
 * once it is applied to the rows the handler actually builds, so ownership,
 * persistence and audit are stubbed and everything else runs for real.
 */

const mocks = vi.hoisted(() => ({
  format: "csv" as "csv" | "json",
  project: { id: "proj-1", name: "Café Crème / Bêta", userId: "user-1", activeScoringVersion: "v2" },
  run: {
    id: "run-1",
    scoringVersion: "v2",
    extractionVersion: "x1",
    status: "COMPLETED",
  } as Record<string, unknown> | null,
  tasks: [] as unknown[],
  prisma: {
    run: { findFirst: vi.fn() },
    runTask: { findMany: vi.fn() },
  },
  recordAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/audit", () => ({
  recordAudit: mocks.recordAudit,
  AUDIT_ACTIONS: { EXPORT_DOWNLOAD: "export.download" },
}));
vi.mock("@/lib/api/route-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/route-helpers")>(
    "@/lib/api/route-helpers"
  );
  return {
    ...actual,
    parseQuery: () => ({ format: mocks.format }),
    withProject: async (
      _request: unknown,
      _projectId: string,
      handler: (ctx: {
        project: typeof mocks.project;
        userId: string;
        ip: string | null;
        userAgent: string | null;
      }) => Promise<Response>
    ) =>
      handler({
        project: mocks.project,
        userId: mocks.project.userId,
        ip: "203.0.113.7",
        userAgent: "vitest",
      }),
  };
});

import { GET } from "@/app/api/projects/[projectId]/export/route";

interface TaskFixture {
  queryText: string;
  providerCode: string;
  providerLabel: string;
  mode: "PARAMETRIC" | "GROUNDED";
  competitors?: { entityName: string; mentionShare: number }[];
  citations?: string[];
  score?: Record<string, unknown> | null;
}

function task(fixture: TaskFixture) {
  return {
    queryTextSnapshot: fixture.queryText,
    query: { text: fixture.queryText },
    provider: { code: fixture.providerCode, label: fixture.providerLabel },
    mode: fixture.mode,
    scores:
      fixture.score === null
        ? []
        : [
            {
              median: 62.5,
              ciLow: 51.25,
              ciHigh: 70,
              stability: 0.842,
              n: 3,
              rawN: 3,
              ciMethod: "legacy-pooled-bootstrap",
              lowN: false,
              brandPresenceRate: 0.667,
              ...fixture.score,
            },
          ],
    shares: (fixture.competitors ?? []).map((c) => ({ ...c })),
    samples: [{ citations: (fixture.citations ?? []).map((url) => ({ url })) }],
  };
}

function get(): Promise<Response> {
  const request = new Request("http://localhost/api/projects/proj-1/export?format=csv");
  return GET(request as NextRequest, { params: Promise.resolve({ projectId: "proj-1" }) });
}

const BOM = String.fromCharCode(0xfeff);

/** Decoded from the raw bytes: a plain `text()` would swallow the leading BOM. */
async function csvBody(): Promise<string> {
  const bytes = await (await get()).arrayBuffer();
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/** The body carries a BOM for Excel and CRLF line endings; neither is content. */
async function csvRows(): Promise<string[]> {
  const body = await csvBody();
  expect(body.startsWith(BOM)).toBe(true);
  return body.slice(1).replace(/\r\n$/, "").split("\r\n");
}

/** Splits a CSV line whose every field is quoted, undoing the doubled quotes. */
function fieldsOf(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") {
      fields.push(current);
      current = "";
    } else current += char;
  }
  fields.push(current);
  return fields;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.format = "csv";
  mocks.prisma.run.findFirst.mockImplementation(async () => mocks.run);
  mocks.prisma.runTask.findMany.mockImplementation(async () => mocks.tasks);
  mocks.tasks = [];
});

describe("CSV export escaping", () => {
  it("passes an ordinary field through unchanged", async () => {
    mocks.tasks = [
      task({
        queryText: "meilleur crm pour pme",
        providerCode: "openai",
        providerLabel: "OpenAI ChatGPT",
        mode: "GROUNDED",
        competitors: [{ entityName: "HubSpot", mentionShare: 0.5 }],
        citations: ["https://www.g2.com/categories/crm"],
      }),
    ];

    const [, row] = await csvRows();
    const fields = fieldsOf(row);

    expect(fields[0]).toBe("meilleur crm pour pme");
    expect(fields[1]).toBe("OpenAI ChatGPT");
    expect(fields[2]).toBe("groundé");
    expect(fields[3]).toBe("62.50");
    expect(fields[7]).toBe("3");
    expect(fields[8]).toBe("3");
    expect(fields[9]).toBe("legacy-pooled-bootstrap");
    expect(fields[10]).toBe("samples");
    expect(fields[11]).toBe("non");
    expect(fields[13]).toBe("HubSpot (50.0 %)");
    expect(fields[14]).toBe("https://www.g2.com/categories/crm");
  });

  it("neutralises every character a spreadsheet would read as a formula", async () => {
    const dangerous = ["=1+1", "+33 1 23 45", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"];
    mocks.tasks = dangerous.map((text, index) =>
      task({
        queryText: text,
        providerCode: `p${index}`,
        providerLabel: text,
        mode: "PARAMETRIC",
        competitors: [{ entityName: text, mentionShare: 1 }],
        citations: [text],
      })
    );

    const rows = await csvRows();
    expect(rows).toHaveLength(dangerous.length + 1);

    rows.slice(1).forEach((row, index) => {
      const fields = fieldsOf(row);
      const raw = dangerous[index];
      for (const position of [0, 1, 13, 14]) {
        const field = fields[position];
        expect(field.startsWith("'")).toBe(true);
        expect(field.slice(1).startsWith(raw)).toBe(true);
        expect(/^[=+\-@\t\r]/.test(field)).toBe(false);
      }
    });
  });

  it("leaves a formula character alone when it is not in first position", async () => {
    mocks.tasks = [
      task({
        queryText: "crm 100% gratuit = illusion",
        providerCode: "openai",
        providerLabel: "OpenAI ChatGPT",
        mode: "PARAMETRIC",
      }),
    ];

    const fields = fieldsOf((await csvRows())[1]);

    expect(fields[0]).toBe("crm 100% gratuit = illusion");
  });

  it("quotes and doubles a field carrying a comma, a quote or a newline", async () => {
    mocks.tasks = [
      task({
        queryText: 'crm "open source", tarifs\nannuels',
        providerCode: "openai",
        providerLabel: "OpenAI, Inc.",
        mode: "PARAMETRIC",
      }),
    ];

    const body = await csvBody();
    const rows = await csvRows();
    const fields = fieldsOf(rows[1]);

    expect(body).toContain('"crm ""open source"", tarifs\nannuels"');
    // The embedded newline stays inside its quoted field and does not open a record.
    expect(rows).toHaveLength(2);
    expect(fields).toHaveLength(15);
    expect(fields[0]).toBe('crm "open source", tarifs\nannuels');
    expect(fields[1]).toBe("OpenAI, Inc.");
  });

  it("quotes the header line the same way", async () => {
    const [header] = await csvRows();

    expect(header.startsWith('"Requête","Moteur","Mode"')).toBe(true);
    expect(fieldsOf(header)).toHaveLength(15);
  });

  it("renders a task without score as empty cells rather than nulls", async () => {
    mocks.tasks = [
      task({
        queryText: "crm gratuit",
        providerCode: "claude",
        providerLabel: "Anthropic Claude",
        mode: "PARAMETRIC",
        score: null,
      }),
    ];

    const fields = fieldsOf((await csvRows())[1]);

    expect(fields[3]).toBe("");
    expect(fields[4]).toBe("");
    expect(fields[5]).toBe("");
    expect(fields[6]).toBe("");
    expect(fields[7]).toBe("0");
    expect(fields[8]).toBe("0");
    expect(fields[11]).toBe("oui");
    expect(fields[12]).toBe("");
    expect(fields.join("")).not.toContain("null");
  });

  it("serves the CSV as a download with a sanitised filename", async () => {
    const response = await get();

    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Cafe-Creme-Beta-run-1.csv"'
    );
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "export.download", targetId: "run-1" })
    );
  });

  it("does not display a legacy empty-population row as a measured zero", async () => {
    mocks.tasks = [task({ queryText: "unanswered", providerCode: "mock", providerLabel: "Mock", mode: "PARAMETRIC",
      score: { n: 0, rawN: 0, median: 0, ciLow: 0, ciHigh: 0, stability: 0 } })];
    const fields = fieldsOf((await csvRows())[1]);
    expect(fields.slice(3, 7)).toEqual(["", "", "", ""]);
    expect(fields[7]).toBe("0");
    expect(fields[9]).toBe("unavailable");
  });
});
