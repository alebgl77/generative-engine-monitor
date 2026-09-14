import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { SamplingMode } from "@prisma/client";
import { z } from "zod";

import { parseQuery, withProject } from "@/lib/api/route-helpers";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { badRequest } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { runForReading, analysisCoverage } from "@/lib/scoring/read-model";

type RouteContext = { params: Promise<{ projectId: string }> };

const querySchema = z.object({
  format: z.enum(["csv", "json"]).default("csv"),
});

interface ExportRow {
  query: string;
  providerCode: string;
  providerLabel: string;
  mode: SamplingMode;
  median: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  stability: number | null;
  n: number;
  rawN: number;
  ciMethod: string;
  nUnit: string;
  lowN: boolean;
  brandPresenceRate: number | null;
  competitors: { name: string; mentionShare: number }[];
  citations: string[];
}

const CSV_HEADERS = [
  "Requête",
  "Moteur",
  "Mode",
  "Médiane",
  "IC bas",
  "IC haut",
  "Stabilité",
  "N",
  "N brut",
  "Méthode intervalle",
  "Unité N",
  "N faible",
  "Taux de présence marque",
  "Concurrents",
  "Citations",
];

/**
 * A leading =, +, -, @, tab or CR turns a cell into a formula in Excel and
 * LibreOffice. Competitor names and citation URLs come from model output, so
 * every field is disarmed with a leading apostrophe before being quoted.
 */
function csvCell(value: string | number | boolean | null): string {
  const raw = value === null ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * The project name is user input and lands in a response header; anything that
 * could break out of the quoted filename or the header itself is dropped.
 */
function safeFilename(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : "projet";
}

function formatNumber(value: number | null, digits: number): string {
  return value === null ? "" : value.toFixed(digits);
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { projectId } = await params;
  return withProject(request, projectId, async ({ project, userId, ip, userAgent }) => {
    const { format } = parseQuery(request, querySchema);

    // Partial and cancelled runs are exportable: they hold fewer measurements
    // than planned, and each row carries its own `n` and `lowN` to say so.
    const originalRun = await prisma.run.findFirst({
      where: { projectId: project.id, status: { in: ["COMPLETED", "PARTIAL", "CANCELLED"] } },
      orderBy: { createdAt: "desc" },
    });
    if (!originalRun) throw badRequest("Aucune analyse exploitable à exporter.");

    const run = await runForReading(originalRun, project.activeScoringVersion);

    const tasks = await prisma.runTask.findMany({
      where: { runId: run.id },
      orderBy: [
        { query: { createdAt: "asc" } },
        { provider: { code: "asc" } },
        { mode: "asc" },
      ],
      include: {
        query: { select: { text: true } },
        provider: { select: { code: true, label: true } },
        scores: { where: { scoringVersion: run.scoringVersion } },
        shares: { where: { scoringVersion: run.scoringVersion, entityKind: "COMPETITOR" } },
        samples: {
          orderBy: { sampleIndex: "asc" },
          select: {
            citations: {
              where: { extractionVersion: run.extractionVersion },
              orderBy: [{ position: "asc" }, { normalizedUrl: "asc" }],
              select: { url: true },
            },
          },
        },
      },
    });

    const rows: ExportRow[] = tasks.map((task) => {
      const score = task.scores[0]?.n > 0 ? task.scores[0] : undefined;
      const citations = new Set<string>();
      for (const sample of task.samples) {
        for (const citation of sample.citations) citations.add(citation.url);
      }
      return {
        query: task.queryTextSnapshot,
        providerCode: task.provider.code,
        providerLabel: task.provider.label,
        mode: task.mode,
        median: score?.median ?? null,
        ciLow: score?.ciLow ?? null,
        ciHigh: score?.ciHigh ?? null,
        stability: score?.stability ?? null,
        n: score?.n ?? 0,
        rawN: score?.rawN ?? 0, ciMethod: score?.ciMethod ?? "unavailable",
        nUnit: score?.ciMethod === "query-cluster-v1" ? "queries" : "samples",
        lowN: score?.lowN ?? true,
        brandPresenceRate: score?.brandPresenceRate ?? null,
        competitors: task.shares
          .map((s) => ({ name: s.entityName, mentionShare: s.mentionShare }))
          .sort((a, b) => b.mentionShare - a.mentionShare || a.name.localeCompare(b.name)),
        citations: Array.from(citations),
      };
    });

    await recordAudit({
      userId,
      projectId: project.id,
      action: AUDIT_ACTIONS.EXPORT_DOWNLOAD,
      targetType: "run",
      targetId: run.id,
      metadata: { format, rows: rows.length },
      ip,
      userAgent,
    });

    const filename = `${safeFilename(project.name)}-${run.id}.${format}`;

    if (format === "json") {
      return NextResponse.json(
        {
          project: { id: project.id, name: project.name },
          runId: run.id,
          scoringVersion: run.scoringVersion,
          extractionVersion: run.extractionVersion,
          coverage: await analysisCoverage(run),
          exportedAt: new Date().toISOString(),
          rows,
        },
        { headers: { "Content-Disposition": `attachment; filename="${filename}"` } }
      );
    }

    const lines = [
      CSV_HEADERS.map(csvCell).join(","),
      ...rows.map((row) =>
        [
          csvCell(row.query),
          csvCell(row.providerLabel),
          csvCell(row.mode === "GROUNDED" ? "groundé" : "paramétrique"),
          csvCell(formatNumber(row.median, 2)),
          csvCell(formatNumber(row.ciLow, 2)),
          csvCell(formatNumber(row.ciHigh, 2)),
          csvCell(formatNumber(row.stability, 3)),
          csvCell(row.n),
          csvCell(row.rawN), csvCell(row.ciMethod), csvCell(row.nUnit),
          csvCell(row.lowN ? "oui" : "non"),
          csvCell(formatNumber(row.brandPresenceRate, 3)),
          csvCell(
            row.competitors
              .map((c) => `${c.name} (${(c.mentionShare * 100).toFixed(1)} %)`)
              .join(" | ")
          ),
          csvCell(row.citations.join(" | ")),
        ].join(",")
      ),
    ];

    // BOM first: without it Excel reads the accented headers as Latin-1.
    const body = `\uFEFF${lines.join("\r\n")}\r\n`;

    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  });
}
