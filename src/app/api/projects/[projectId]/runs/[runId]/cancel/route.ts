import type { NextRequest } from "next/server";
import type { RunStatus } from "@prisma/client";

import { json, withProject } from "@/lib/api/route-helpers";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { badRequest, notFound } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requestCancel } from "@/lib/runs/plan";

type RouteContext = { params: Promise<{ projectId: string; runId: string }> };

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
]);

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { projectId, runId } = await params;
  return withProject(request, projectId, async ({ project, userId, ip, userAgent }) => {
    const run = await prisma.run.findFirst({
      where: { id: runId, projectId: project.id },
      select: { id: true, status: true },
    });
    if (!run) throw notFound("Analyse");

    if (TERMINAL.has(run.status)) {
      throw badRequest("Cette analyse est déjà terminée et ne peut plus être annulée.");
    }

    if (run.status !== "CANCELLING") {
      await requestCancel(run.id);
      await recordAudit({
        userId,
        projectId: project.id,
        action: AUDIT_ACTIONS.RUN_CANCEL,
        targetType: "run",
        targetId: run.id,
        ip,
        userAgent,
      });
    }

    // Cancellation is cooperative: queued work is dropped at once, in-flight
    // calls abort at their next heartbeat, so the final status is read back.
    const current = await prisma.run.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true },
    });

    return json({
      runId: run.id,
      status: current.status,
      message:
        "Annulation demandée : les appels en attente sont abandonnés, ceux en cours s'arrêtent d'eux-mêmes.",
    });
  });
}
