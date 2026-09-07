import type { NextRequest } from "next/server";
import { z } from "zod";

import { json, parseBody, withProject } from "@/lib/api/route-helpers";
import { badRequest, tooManyRequests } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getRunLimits, lockRunOwner } from "@/lib/runs/limits";

type RouteContext = { params: Promise<{ projectId: string }> };

const queryText = z
  .string()
  .trim()
  .min(1, "texte requis")
  .max(500, "500 caractères maximum");

const createSchema = z
  .object({
    text: queryText.optional(),
    queries: z
      .array(z.string().trim().max(500, "500 caractères maximum"))
      .max(200, "200 requêtes au maximum par envoi")
      .transform((list) => Array.from(new Set(list.filter((t) => t.length > 0))))
      .refine((list) => list.length > 0, "au moins une requête non vide")
      .optional(),
  })
  .refine(
    (body) => body.text !== undefined || body.queries !== undefined,
    "fournissez « text » ou « queries »"
  );

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { projectId } = await params;
  return withProject(request, projectId, async ({ project }) => {
    const queries = await prisma.query.findMany({
      where: { projectId: project.id, archivedAt: null },
      orderBy: { createdAt: "asc" },
    });
    return json(queries);
  });
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { projectId } = await params;
  return withProject(request, projectId, async ({ project, userId }) => {
    const body = await parseBody(request, createSchema);
    const bulk = body.queries !== undefined;
    const texts = body.queries ?? (body.text !== undefined ? [body.text] : []);
    if (texts.length === 0) throw badRequest("Aucune requête à créer");

    // The rows the transaction returns are the rows that were created. Reading
    // back "the last N" instead would hand back someone else's concurrent
    // insert.
    const created = await prisma.$transaction(async (tx) => {
      await lockRunOwner(tx, userId);
      const count = await tx.query.count({ where: { projectId: project.id, archivedAt: null } });
      if (count + texts.length > getRunLimits().MAX_QUERIES_PER_PROJECT) {
        throw tooManyRequests("Limite de requêtes par projet atteinte");
      }
      return Promise.all(texts.map((text) => tx.query.create({ data: { projectId: project.id, text } })));
    });

    return json(bulk ? created : created[0], 201);
  });
}
