import type { NextRequest } from "next/server";
import { z } from "zod";

import { json, parseBody, withProject } from "@/lib/api/route-helpers";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: { projectId: string } };

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

// Validated element by element: the aliases feed the extractor, and a single
// non-string entry stored here surfaces much later as a failed run.
const aliasesSchema = z
  .array(z.string().trim().min(1, "alias vide").max(80, "80 caractères maximum"))
  .max(20, "20 alias au maximum")
  .transform((list) => Array.from(new Set(list)))
  .default([]);

const createSchema = z.object({
  name: z.string().trim().min(1, "nom requis").max(120, "120 caractères maximum"),
  domain: domainSchema,
  aliases: aliasesSchema,
});

export async function GET(request: NextRequest, { params }: RouteContext) {
  return withProject(request, params.projectId, async ({ project }) => {
    const competitors = await prisma.competitor.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "asc" },
    });
    return json(competitors);
  });
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  return withProject(request, params.projectId, async ({ project }) => {
    const body = await parseBody(request, createSchema);

    const competitor = await prisma.competitor.create({
      data: {
        projectId: project.id,
        name: body.name,
        domain: body.domain ?? null,
        aliases: body.aliases,
      },
    });

    return json(competitor, 201);
  });
}
