import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { json, parseBody, withProject } from "@/lib/api/route-helpers";
import { badRequest, notFound } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { lockRunOwner, preserveDailyReservation } from "@/lib/runs/limits";
import type { ProjectSummary } from "@/types/api";

type RouteContext = { params: Promise<{ projectId: string }> };

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
  targetCountry: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "code pays ISO à 2 lettres attendu")
    .optional(),
  targetLanguage: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{2}$/, "code langue ISO à 2 lettres attendu")
    .optional(),
  repetitions: z
    .number()
    .int("nombre entier attendu")
    .min(1, "au moins 1 répétition")
    .max(10, "10 répétitions au maximum")
    .optional(),
  samplingModes: z
    .array(z.enum(["PARAMETRIC", "GROUNDED"]))
    .min(1, "au moins un mode d'échantillonnage")
    .transform((modes) => Array.from(new Set(modes)))
    .optional(),
});

const projectShape = {
  _count: { select: { brands: { where: { archivedAt: null } }, competitors: { where: { archivedAt: null } }, queries: { where: { archivedAt: null } } } },
  runs: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
} as const;

interface ProjectRow {
  id: string;
  name: string;
  domain: string | null;
  targetCountry: string;
  targetLanguage: string;
  repetitions: number;
  samplingModes: ProjectSummary["samplingModes"];
  activeScoringVersion: string;
  createdAt: Date;
  _count: { brands: number; competitors: number; queries: number };
  runs: { createdAt: Date }[];
}

function toProjectSummary(p: ProjectRow): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    domain: p.domain,
    targetCountry: p.targetCountry,
    targetLanguage: p.targetLanguage,
    repetitions: p.repetitions,
    samplingModes: p.samplingModes,
    activeScoringVersion: p.activeScoringVersion,
    createdAt: p.createdAt.toISOString(),
    counts: {
      brands: p._count.brands,
      competitors: p._count.competitors,
      queries: p._count.queries,
    },
    lastRunAt: p.runs[0]?.createdAt.toISOString() ?? null,
  };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { projectId } = await params;
  return withProject(request, projectId, async ({ project }) => {
    const row = await prisma.project.findUnique({
      where: { id: project.id },
      include: projectShape,
    });
    if (!row) throw notFound("Projet");
    return json<ProjectSummary>(toProjectSummary(row));
  });
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { projectId } = await params;
  return withProject(request, projectId, async ({ project }) => {
    const body = await parseBody(request, updateSchema);

    const data: Prisma.ProjectUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.domain !== undefined) data.domain = body.domain;
    if (body.targetCountry !== undefined) data.targetCountry = body.targetCountry;
    if (body.targetLanguage !== undefined) data.targetLanguage = body.targetLanguage;
    if (body.repetitions !== undefined) data.repetitions = body.repetitions;
    if (body.samplingModes !== undefined) data.samplingModes = body.samplingModes;

    if (Object.keys(data).length === 0) throw badRequest("Aucun champ à mettre à jour");

    const updated = await prisma.project.update({
      where: { id: project.id },
      data,
      include: projectShape,
    });

    return json<ProjectSummary>(toProjectSummary(updated));
  });
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const { projectId } = await params;
  return withProject(request, projectId, async ({ project, userId }) => {
    await prisma.$transaction(async (tx) => {
      await lockRunOwner(tx, userId);
      await preserveDailyReservation(tx, userId);
      await tx.project.delete({ where: { id: project.id } });
    });
    return json({ success: true });
  });
}
