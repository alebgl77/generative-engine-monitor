import type { NextRequest } from "next/server";
import { z } from "zod";

import { json, parseBody, withAuth } from "@/lib/api/route-helpers";
import { prisma } from "@/lib/prisma";
import type { ProjectSummary } from "@/types/api";

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

const createSchema = z.object({
  name: z.string().trim().min(1, "nom requis").max(120, "120 caractères maximum"),
  domain: domainSchema,
  targetCountry: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "code pays ISO à 2 lettres attendu")
    .default("FR"),
  targetLanguage: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{2}$/, "code langue ISO à 2 lettres attendu")
    .default("fr"),
  repetitions: z
    .number()
    .int("nombre entier attendu")
    .min(1, "au moins 1 répétition")
    .max(10, "10 répétitions au maximum")
    .default(3),
  samplingModes: z
    .array(z.enum(["PARAMETRIC", "GROUNDED"]))
    .min(1, "au moins un mode d'échantillonnage")
    .transform((modes) => Array.from(new Set(modes)))
    .default(["PARAMETRIC", "GROUNDED"]),
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

/** `userId` is deliberately absent: the client never needs it and echoing it
 * back turns every response into an ownership oracle. */
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

export async function GET(request: NextRequest) {
  return withAuth(request, async ({ userId }) => {
    const projects = await prisma.project.findMany({
      where: { userId },
      include: projectShape,
      orderBy: { updatedAt: "desc" },
    });
    return json<ProjectSummary[]>(projects.map(toProjectSummary));
  });
}

export async function POST(request: NextRequest) {
  return withAuth(request, async ({ userId }) => {
    const body = await parseBody(request, createSchema);

    const project = await prisma.project.create({
      data: {
        userId,
        name: body.name,
        domain: body.domain ?? null,
        targetCountry: body.targetCountry,
        targetLanguage: body.targetLanguage,
        repetitions: body.repetitions,
        samplingModes: body.samplingModes,
      },
      include: projectShape,
    });

    return json<ProjectSummary>(toProjectSummary(project), 201);
  });
}
