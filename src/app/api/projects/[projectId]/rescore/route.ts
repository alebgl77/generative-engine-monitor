import type { NextRequest } from "next/server";
import { z } from "zod";

import { json, parseBody, withProject } from "@/lib/api/route-helpers";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { badRequest, notFound } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { CURRENT_SCORING_VERSION, listScoringVersions } from "@/lib/scoring/registry";
import { IN_FLIGHT_RUN_STATUSES, rescoreProject, rescoreRun } from "@/lib/scoring/rescore";

type RouteContext = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  runId: z.string().min(1).optional(),
  scoringVersion: z.string().min(1).optional(),
});

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { projectId } = await params;
  return withProject(request, projectId, async ({ project, userId, ip, userAgent }) => {
    const body = await parseBody(request, bodySchema);
    const scoringVersion = body.scoringVersion ?? CURRENT_SCORING_VERSION;

    if (!listScoringVersions().includes(scoringVersion)) {
      throw badRequest(
        `Version de scoring inconnue « ${scoringVersion} » — versions disponibles : ${listScoringVersions().join(", ")}.`
      );
    }

    if (body.runId) {
      const run = await prisma.run.findFirst({
        where: { id: body.runId, projectId: project.id },
        select: { id: true, status: true },
      });
      if (!run) throw notFound("Analyse");
      if (IN_FLIGHT_RUN_STATUSES.includes(run.status)) {
        throw badRequest("Cette analyse est encore en cours — attendez sa fin avant de la rejouer.");
      }
    }

    const { jobs } = body.runId
      ? await rescoreRun(body.runId, scoringVersion)
      : await rescoreProject(project.id, scoringVersion);

    await recordAudit({
      userId,
      projectId: project.id,
      action: AUDIT_ACTIONS.RESCORE_START,
      targetType: body.runId ? "run" : "project",
      targetId: body.runId ?? project.id,
      metadata: { scoringVersion, jobs },
      ip,
      userAgent,
    });

    return json(
      {
        jobs,
        scoringVersion,
        runId: body.runId ?? null,
        message: `${jobs} réponse(s) seront rejouées en version ${scoringVersion} à partir du texte déjà stocké : aucun crédit API n'est consommé.`,
      },
      202
    );
  });
}
