import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { assertBelongs, json, parseBody, withProject } from "@/lib/api/route-helpers";
import { badRequest } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ projectId: string; competitorId: string }> };

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253, "253 caractères maximum")
  .transform((v) => v.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, ""))
  .refine(
    (v) => v === "" || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v),
    "doit ressembler à un nom de domaine (exemple.fr)"
  )
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

const updateSchema = z.object({
  name: z.string().trim().min(1, "nom requis").max(120, "120 caractères maximum").optional(),
  domain: domainSchema,
  aliases: z
    .array(z.string().trim().min(1, "alias vide").max(80, "80 caractères maximum"))
    .max(20, "20 alias au maximum")
    .transform((list) => Array.from(new Set(list)))
    .optional(),
});

/** Both ids are part of the lookup, so a competitor id from another project is
 * a 404 rather than a cross-project write. */
async function assertCompetitorBelongs(projectId: string, competitorId: string): Promise<void> {
  const competitor = await prisma.competitor.findFirst({
    where: { id: competitorId, projectId },
    select: { projectId: true },
  });
  assertBelongs(competitor, projectId, "Concurrent");
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { projectId, competitorId } = await params;
  return withProject(request, projectId, async ({ project }) => {
    await assertCompetitorBelongs(project.id, competitorId);
    const body = await parseBody(request, updateSchema);

    const data: Prisma.CompetitorUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.domain !== undefined) data.domain = body.domain;
    if (body.aliases !== undefined) data.aliases = body.aliases;

    if (Object.keys(data).length === 0) throw badRequest("Aucun champ à mettre à jour");

    const competitor = await prisma.competitor.update({
      where: { id: competitorId },
      data,
    });
    return json(competitor);
  });
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const { projectId, competitorId } = await params;
  return withProject(request, projectId, async ({ project }) => {
    await assertCompetitorBelongs(project.id, competitorId);
    await prisma.competitor.deleteMany({
      where: { id: competitorId, projectId: project.id },
    });
    return json({ success: true });
  });
}
