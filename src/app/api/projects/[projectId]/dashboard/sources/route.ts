import type { NextRequest } from "next/server";
import type { SamplingMode } from "@prisma/client";

import { json, withProject } from "@/lib/api/route-helpers";
import { prisma } from "@/lib/prisma";
import type { SourceRow, SourcesResponse } from "@/types/api";

type RouteContext = { params: Promise<{ projectId: string }> };

interface DomainAccumulator {
  domain: string;
  citationCount: number;
  isBrandDomain: boolean;
  samples: Set<string>;
  modes: Set<SamplingMode>;
  providers: Set<string>;
  queries: Set<string>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { projectId } = await params;
  return withProject(request, projectId, async ({ project }) => {
    // A partial or cancelled run stopped early; the citations it collected before
    // stopping are measurements all the same.
    const run = await prisma.run.findFirst({
      where: { projectId: project.id, status: { in: ["COMPLETED", "PARTIAL", "CANCELLED"] } },
      orderBy: { createdAt: "desc" },
    });

    if (!run) {
      const empty: SourcesResponse = { runId: null, rows: [] };
      return json(empty);
    }

    const citations = await prisma.citation.findMany({
      where: { runId: run.id, extractionVersion: run.extractionVersion },
      select: {
        domain: true,
        isBrandDomain: true,
        sampleId: true,
        sample: {
          select: {
            task: {
              select: {
                mode: true,
                provider: { select: { code: true } },
                query: { select: { text: true } },
              },
            },
          },
        },
      },
    });

    const byDomain = new Map<string, DomainAccumulator>();
    for (const citation of citations) {
      const entry: DomainAccumulator = byDomain.get(citation.domain) ?? {
        domain: citation.domain,
        citationCount: 0,
        isBrandDomain: false,
        samples: new Set<string>(),
        modes: new Set<SamplingMode>(),
        providers: new Set<string>(),
        queries: new Set<string>(),
      };
      entry.citationCount += 1;
      entry.isBrandDomain = entry.isBrandDomain || citation.isBrandDomain;
      entry.samples.add(citation.sampleId);
      entry.modes.add(citation.sample.task.mode);
      entry.providers.add(citation.sample.task.provider.code);
      entry.queries.add(citation.sample.task.query.text);
      byDomain.set(citation.domain, entry);
    }

    const rows: SourceRow[] = Array.from(byDomain.values())
      .map((entry) => ({
        domain: entry.domain,
        citationCount: entry.citationCount,
        sampleCount: entry.samples.size,
        citationShare: citations.length > 0 ? entry.citationCount / citations.length : 0,
        isBrandDomain: entry.isBrandDomain,
        modes: Array.from(entry.modes).sort(),
        providers: Array.from(entry.providers).sort(),
        queries: Array.from(entry.queries).sort(),
      }))
      .sort((a, b) => b.citationCount - a.citationCount || a.domain.localeCompare(b.domain));

    const payload: SourcesResponse = { runId: run.id, rows };
    return json(payload);
  });
}
