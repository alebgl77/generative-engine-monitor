import type { Prisma, SamplingMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueue } from "@/lib/queue/client";
import type { RunSamplePayload } from "@/lib/queue/types";
import { getProvider, supportsMode } from "@/lib/providers/registry";
import { CURRENT_SCORING_VERSION } from "@/lib/scoring/registry";
import { CURRENT_EXTRACTION_VERSION } from "@/lib/parsing/registry";
import { badRequest } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Run planning.
 *
 * A run is fully materialised up front — every task and every sample row exists
 * before the first API call — and the whole plan is enqueued in the same
 * transaction. Nothing is created lazily, so progress is a counter rather than a
 * guess, and a worker crash cannot lose work that was never written down.
 */

export interface PlanResult {
  runId: string;
  totalTasks: number;
  totalSamples: number;
  skipped: { providerCode: string; mode: SamplingMode; reason: string }[];
}

export async function planRun(projectId: string): Promise<PlanResult> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      queries: { where: { isActive: true }, orderBy: { createdAt: "asc" } },
      user: { select: { id: true } },
    },
  });

  if (project.queries.length === 0) {
    throw badRequest("Aucune requête active — ajoutez au moins une requête avant de lancer une analyse.");
  }

  // The mock provider is always available: it needs no key, which is what makes
  // the product demonstrable end to end without spending anything.
  const credentials = await prisma.providerCredential.findMany({
    where: { userId: project.userId, isValid: true },
    include: { provider: true },
  });
  const mock = await prisma.provider.findUnique({ where: { code: "mock" } });

  const byId = new Map<string, (typeof credentials)[number]["provider"]>();
  for (const c of credentials) {
    if (c.provider.isActiveGlobal) byId.set(c.provider.id, c.provider);
  }
  if (mock?.isActiveGlobal) byId.set(mock.id, mock);

  const providers = [...byId.values()];
  if (providers.length === 0) {
    throw badRequest("Aucun moteur disponible — ajoutez une clé API valide dans la configuration.");
  }

  const skipped: PlanResult["skipped"] = [];
  const cells: { providerId: string; providerCode: string; mode: SamplingMode }[] = [];

  for (const provider of providers) {
    const impl = getProvider(provider.code);
    if (!impl) {
      logger.warn("provider row has no implementation", { code: provider.code });
      continue;
    }
    for (const mode of project.samplingModes) {
      if (!supportsMode(impl, mode)) {
        // Not an error: Perplexity is search-native and has no parametric mode.
        skipped.push({
          providerCode: provider.code,
          mode,
          reason: `${provider.label} ne peut pas répondre en mode ${mode === "PARAMETRIC" ? "paramétrique" : "groundé"}`,
        });
        continue;
      }
      cells.push({ providerId: provider.id, providerCode: provider.code, mode });
    }
  }

  if (cells.length === 0) {
    throw badRequest(
      "Aucune combinaison moteur/mode exécutable — vérifiez les modes d'échantillonnage du projet."
    );
  }

  const repetitions = project.repetitions;
  const totalTasks = cells.length * project.queries.length;
  const totalSamples = totalTasks * repetitions;

  const runId = await prisma.$transaction(async (tx) => {
    const run = await tx.run.create({
      data: {
        projectId: project.id,
        status: "RUNNING",
        scoringVersion: CURRENT_SCORING_VERSION,
        extractionVersion: CURRENT_EXTRACTION_VERSION,
        repetitions,
        modes: project.samplingModes,
        totalTasks,
        pendingTasks: totalTasks,
        totalSamples,
        startedAt: new Date(),
      },
    });

    const jobs: Parameters<typeof enqueue>[0] = [];

    for (const query of project.queries) {
      for (const cell of cells) {
        const task = await tx.runTask.create({
          data: {
            runId: run.id,
            projectId: project.id,
            queryId: query.id,
            providerId: cell.providerId,
            mode: cell.mode,
            plannedSamples: repetitions,
            pendingSamples: repetitions,
          },
        });

        const samples = await Promise.all(
          Array.from({ length: repetitions }, (_, index) =>
            tx.runSample.create({
              data: {
                taskId: task.id,
                runId: run.id,
                projectId: project.id,
                sampleIndex: index,
              },
              select: { id: true },
            })
          )
        );

        for (const sample of samples) {
          const payload: RunSamplePayload = {
            sampleId: sample.id,
            taskId: task.id,
            runId: run.id,
            projectId: project.id,
            queryText: query.text,
            providerCode: cell.providerCode,
            mode: cell.mode,
            locale: { country: project.targetCountry, language: project.targetLanguage },
            scoringVersion: CURRENT_SCORING_VERSION,
            extractionVersion: CURRENT_EXTRACTION_VERSION,
          };
          jobs.push({
            kind: "RUN_SAMPLE",
            runId: run.id,
            projectId: project.id,
            taskId: task.id,
            sampleId: sample.id,
            providerCode: cell.providerCode,
            payload,
          });
        }
      }
    }

    await enqueue(jobs, tx as unknown as Prisma.TransactionClient);
    return run.id;
  }, {
    // Materialising every sample of a large run is a lot of inserts; the default
    // 5s interactive-transaction budget is not enough.
    timeout: 30_000,
    maxWait: 10_000,
  });

  logger.info("run planned", { runId, totalTasks, totalSamples, skipped: skipped.length });

  return { runId, totalTasks, totalSamples, skipped };
}

/** Cancellation is cooperative: queued jobs are dropped immediately, running
 * ones learn from their next heartbeat and abort themselves. */
export async function requestCancel(runId: string): Promise<void> {
  const { cancelRunJobs } = await import("@/lib/queue/client");
  await prisma.$transaction(async (tx) => {
    await tx.run.update({
      where: { id: runId },
      data: { status: "CANCELLING", cancelRequestedAt: new Date() },
    });
    await cancelRunJobs(runId, tx as unknown as Prisma.TransactionClient);
    await tx.runSample.updateMany({
      where: { runId, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    await tx.runTask.updateMany({
      where: { runId, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
  });
  logger.info("run cancellation requested", { runId });
}
