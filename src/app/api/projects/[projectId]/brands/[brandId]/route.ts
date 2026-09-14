import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { assertBelongs, json, parseBody, withProject } from "@/lib/api/route-helpers";
import { badRequest } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ projectId: string; brandId: string }> };

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

/** Both ids are part of the lookup, so a brand id from another project is a
 * 404 rather than a cross-project write. */
async function assertBrandBelongs(projectId: string, brandId: string): Promise<void> {
  const brand = await prisma.brand.findFirst({
    where: { id: brandId, projectId, archivedAt: null },
    select: { projectId: true },
  });
  assertBelongs(brand, projectId, "Marque");
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { projectId, brandId } = await params;
  return withProject(request, projectId, async ({ project }) => {
    await assertBrandBelongs(project.id, brandId);
    const body = await parseBody(request, updateSchema);

    const data: Prisma.BrandUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.domain !== undefined) data.domain = body.domain;
    if (body.aliases !== undefined) data.aliases = body.aliases;

    if (Object.keys(data).length === 0) throw badRequest("Aucun champ à mettre à jour");

    const brand = await prisma.brand.update({ where: { id: brandId, projectId: project.id, archivedAt: null }, data });
    return json(brand);
  });
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const { projectId, brandId } = await params;
  return withProject(request, projectId, async ({ project }) => {
    await assertBrandBelongs(project.id, brandId);
    await prisma.brand.updateMany({ where: { id: brandId, projectId: project.id, archivedAt: null }, data: { archivedAt: new Date() } });
    return json({ success: true });
  });
}
