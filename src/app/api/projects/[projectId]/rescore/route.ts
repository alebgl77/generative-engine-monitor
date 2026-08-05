import type { NextRequest } from "next/server";
import { z } from "zod";

import { json, parseBody, withProject } from "@/lib/api/route-helpers";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { badRequest, notFound, tooManyRequests } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { ensureBucket, tryConsume } from "@/lib/queue/ratelimit";
import { CURRENT_SCORING_VERSION, listScoringVersions } from "@/lib/scoring/registry";
import { IN_FLIGHT_RUN_STATUSES, rescoreProject, rescoreRun } from "@/lib/scoring/rescore";

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * Deliberately tighter than the launch limit. Replaying a project enqueues one
 * job per sample in its entire history, and each one may consult the sentiment
 * judge — a paid call. A replay costs less than a run, but it is not free, and
 * it is the only endpoint that can enqueue unbounded work from a single click.
 */
const RESCORES_PER_HOUR = 5;

const bodySchema = z.object({
  runId: z.string().min(1).optional(),
  scoringVersion: z.string().min(1).optional(),
});

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { projectId } = await params;
  return withProject(request, projectId, async ({ project, userId, ip, userAgent }) => {
    const bucketKey = `rescores:${userId}`;
    await ensureBucket(bucketKey, RESCORES_PER_HOUR, RESCORES_PER_HOUR / 3600);
    if (!(await tryConsume(bucketKey))) {
      throw tooManyRequests(
        `Limite de replay atteinte (${RESCORES_PER_HOUR} par heure). Réessayez plus tard.`
      );
    }

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
        message: `${jobs} réponse(s) seront rejouées en version ${scoringVersion} à partir du texte déjà stocké : aucune réponse n'est redemandée à un moteur. L'analyse de sentiment consulte en revanche son juge pour les extraits absents de son cache, et ces appels-là sont facturés — une nouvelle version d'extraction change les extraits, donc le cache ne sert plus.`,
      },
      202
    );
  });
}
