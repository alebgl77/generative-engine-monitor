import type { Prisma } from "@prisma/client";
import { finalizeSample } from "@/lib/runs/finalize";
import { z } from "zod";
import { decryptCredential } from "@/lib/crypto/credentials";
import { codeFromThrown, isRetryable, ProviderError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/providers/registry";
import { assertLease, LostLease, SQL_NOW, complete, fail, release, type JobFailure } from "@/lib/queue/client";
import { bucketKeyForProvider, tryConsume } from "@/lib/queue/ratelimit";
import { type ClaimedJob, type JobHandler } from "@/lib/queue/types";
import { persistSampleAnalysis } from "@/lib/runs/persist";
import { responseSources } from "@/lib/runs/snapshots";

const payloadSchema = z.object({
  sampleId: z.string().min(1), taskId: z.string().min(1), runId: z.string().min(1),
  projectId: z.string().min(1), queryText: z.string().min(1), providerCode: z.string().min(1),
  mode: z.enum(["PARAMETRIC", "GROUNDED"]),
  locale: z.object({ country: z.string(), language: z.string() }),
  scoringVersion: z.string().min(1), extractionVersion: z.string().min(1), model: z.string().optional(),
});

/** Persist the response first; analysis retries never purchase another answer. */
export const runSampleHandler: JobHandler = async (job, ctx) => {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    await failSampleJob(job, { code: "BAD_REQUEST", message: "Payload invalide", retryable: false });
    return;
  }
  const payload = parsed.data;
  if (payload.sampleId !== job.sampleId || payload.taskId !== job.taskId || payload.runId !== job.runId || payload.projectId !== job.projectId) {
    await failSampleJob(job, { code: "BAD_REQUEST", message: "Payload identity does not match its job", retryable: false });
    return;
  }
  let analysisStarted = false;
  let credential: { id: string; updatedAt: Date } | null = null;
  try {
    if (ctx.signal.aborted) { await handleAbort(job); return; }
    const sample = await prisma.$transaction(async (tx) => {
      await assertLease(tx, job);
      const row = await tx.runSample.findUniqueOrThrow({
        where: { id: payload.sampleId }, include: { response: true },
      });
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(row.status)) {
        await complete(job, tx);
        return null;
      }
      await tx.runSample.update({ where: { id: row.id }, data: {
        status: "RUNNING", startedAt: row.startedAt ?? new Date(), attempt: job.attempts,
      } });
      return row;
    });
    if (!sample) return;
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: payload.projectId }, select: { userId: true },
    });
    let response = sample.response;
    if (!response) {
      const provider = getProvider(payload.providerCode);
      if (!provider) throw new ProviderError("BAD_REQUEST", payload.providerCode, "Moteur indisponible");
      let apiKey = "mock";
      if (payload.providerCode !== "mock") {
        const providerRow = await prisma.provider.findUniqueOrThrow({ where: { code: payload.providerCode } });
        const key = await prisma.providerCredential.findUnique({
          where: { userId_providerId: { userId: project.userId, providerId: providerRow.id } },
        });
        if (!key?.isValid) throw new ProviderError("AUTH", payload.providerCode, "Aucune clé API valide pour ce moteur");
        credential = key;
        try { apiKey = decryptCredential(key, { userId: project.userId, providerId: key.providerId }); }
        catch { throw new ProviderError("AUTH", payload.providerCode, "Clé API illisible"); }
      }
      if (!(await tryConsume(bucketKeyForProvider(payload.providerCode)))) { await release(job); return; }
      // A provider cannot join our transaction: a crash after its reply but before
      // commit remains an ambiguous paid outcome, never an exactly-once guarantee.
      await prisma.$transaction((tx) => assertLease(tx, job));
      if (ctx.signal.aborted) { await handleAbort(job); return; }
      const startedAt = Date.now();
      const answer = await provider.runQuery({
        query: payload.queryText, mode: payload.mode, apiKey, locale: payload.locale,
        model: payload.model, signal: ctx.signal,
      });
      response = await prisma.$transaction(async (tx) => {
        await assertLease(tx, job);
        const saved = await tx.aIResponse.create({ data: {
          sampleId: sample.id, rawText: answer.text, rawJson: answer.rawJson as Prisma.InputJsonValue,
          providerSources: answer.sources as unknown as Prisma.InputJsonValue,
          finishReason: answer.finishReason ?? null, truncated: answer.truncated,
        } });
        await tx.runSample.update({ where: { id: sample.id }, data: {
          model: answer.model, latencyMs: Date.now() - startedAt,
          tokensIn: answer.usage?.inputTokens ?? null, tokensOut: answer.usage?.outputTokens ?? null,
        } });
        await assertLease(tx, job);
        return saved;
      });
    }
    analysisStarted = true;
    await persistSampleAnalysis({
      sampleId: sample.id, taskId: payload.taskId, runId: payload.runId,
      projectId: payload.projectId, userId: project.userId, mode: payload.mode,
      text: response.rawText, providerSources: responseSources(response, payload.providerCode),
      scoringVersion: payload.scoringVersion, extractionVersion: payload.extractionVersion,
      signal: ctx.signal, lease: job,
    });
    await prisma.$transaction(async (tx) => {
      await assertLease(tx, job);
      const score = await tx.sampleScore.findUnique({ where: {
        sampleId_scoringVersion: { sampleId: sample.id, scoringVersion: payload.scoringVersion },
      } });
      if (!score) throw new Error("Analysis produced no SampleScore");
      await finalizeSample(tx, { ...payload, succeeded: true });
      await complete(job, tx);
    });
  } catch (error) {
    if (error instanceof LostLease) return;
    if (ctx.signal.aborted) { await handleAbort(job); return; }
    const code = analysisStarted ? "ANALYSIS" : codeFromThrown(error);
    await failSampleJob(job, {
      code, message: error instanceof Error ? error.message : String(error),
      retryable: analysisStarted || isRetryable(error),
      retryAfterSec: error instanceof ProviderError ? error.retryAfterSec : undefined,
    }, credential);
    logger.warn("sample attempt failed", { sampleId: payload.sampleId, code, attempts: job.attempts });
  }
};


/** Also used by the worker's last-resort catch, so no terminal error strands counters. */
export async function failSampleJob(
  job: ClaimedJob, error: JobFailure, credential?: { id: string; updatedAt: Date } | null
): Promise<"requeued" | "exhausted" | "lost"> {
  return fail(job, error, async (tx) => {
    if (!job.sampleId || !job.taskId || !job.runId) return;
    const run = await tx.run.findUniqueOrThrow({ where: { id: job.runId } });
    await finalizeSample(tx, {
      sampleId: job.sampleId, taskId: job.taskId, runId: job.runId, projectId: job.projectId,
      scoringVersion: run.scoringVersion, succeeded: false, errorCode: error.code, errorMessage: error.message,
    });
    if (error.code !== "AUTH" || !credential) return;
    // A late 401 must not invalidate a key rotated while the call was in flight.
    const invalidated = await tx.providerCredential.updateMany({
      where: { id: credential.id, updatedAt: credential.updatedAt },
      data: { isValid: false, validationError: error.message.slice(0, 1000), lastValidatedAt: new Date() },
    });
    if (!invalidated.count) return;
    await tx.auditLog.create({ data: {
      projectId: job.projectId, action: "credential.invalidate", targetType: "provider_credential",
      targetId: credential.id, metadata: { providerCode: job.providerCode, runId: job.runId },
    } });
    const cancelled = await tx.$queryRaw<{ sample_id: string | null; task_id: string | null }[]>`
      UPDATE jobs SET status = 'CANCELLED'::"JobStatus", completed_at = ${SQL_NOW}, updated_at = ${SQL_NOW}
      WHERE run_id = ${job.runId} AND provider_code = ${job.providerCode} AND status = 'QUEUED'::"JobStatus"
      RETURNING sample_id, task_id`;
    for (const row of cancelled) {
      if (row.sample_id && row.task_id) await finalizeSample(tx, {
        sampleId: row.sample_id, taskId: row.task_id, runId: job.runId, projectId: job.projectId,
        scoringVersion: run.scoringVersion, succeeded: false, errorCode: "AUTH", errorMessage: "Clé API invalidée",
      });
    }
  });
}

async function handleAbort(job: ClaimedJob): Promise<void> {
  try {
    const cancelled = await prisma.$transaction(async (tx) => {
      await assertLease(tx, job, true);
      const run = job.runId ? await tx.run.findUnique({ where: { id: job.runId } }) : null;
      if (!run?.cancelRequestedAt) return false;
      if (job.sampleId) await tx.runSample.updateMany({
        where: { id: job.sampleId, status: { in: ["PENDING", "RUNNING"] } },
        data: { status: "CANCELLED", completedAt: new Date() },
      });
      await assertLease(tx, job, true);
      await tx.job.update({ where: { id: job.id }, data: {
        status: "CANCELLED", completedAt: new Date(), lockedBy: null, leaseExpiresAt: null,
      } });
      return true;
    });
    if (!cancelled) await release(job);
  } catch (error) { if (!(error instanceof LostLease)) throw error; }
}
