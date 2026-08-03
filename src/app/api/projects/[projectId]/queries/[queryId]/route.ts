import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { assertBelongs, json, parseBody, withProject } from "@/lib/api/route-helpers";
import { badRequest } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: { projectId: string; queryId: string } };

const updateSchema = z.object({
  text: z.string().trim().min(1, "texte requis").max(500, "500 caractères maximum").optional(),
  isActive: z.boolean().optional(),
});

/** Both ids are part of the lookup, so a query id from another project is a
 * 404 rather than a cross-project write. */
async function assertQueryBelongs(projectId: string, queryId: string): Promise<void> {
  const query = await prisma.query.findFirst({
    where: { id: queryId, projectId },
    select: { projectId: true },
  });
  assertBelongs(query, projectId, "Requête");
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  return withProject(request, params.projectId, async ({ project }) => {
    await assertQueryBelongs(project.id, params.queryId);
    const body = await parseBody(request, updateSchema);

    const data: Prisma.QueryUpdateInput = {};
    if (body.text !== undefined) data.text = body.text;
    if (body.isActive !== undefined) data.isActive = body.isActive;

    if (Object.keys(data).length === 0) throw badRequest("Aucun champ à mettre à jour");

    const query = await prisma.query.update({ where: { id: params.queryId }, data });
    return json(query);
  });
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  return withProject(request, params.projectId, async ({ project }) => {
    await assertQueryBelongs(project.id, params.queryId);
    await prisma.query.deleteMany({ where: { id: params.queryId, projectId: project.id } });
    return json({ success: true });
  });
}
