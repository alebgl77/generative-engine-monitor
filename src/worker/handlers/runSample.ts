import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { decryptCredential } from "@/lib/crypto/credentials";
import { ProviderError, codeFromThrown, isRetryable } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/providers/registry";
import type { AIProvider } from "@/lib/providers/types";
import { SQL_NOW, complete, enqueue, fail, release } from "@/lib/queue/client";
import { bucketKeyForProvider, tryConsume } from "@/lib/queue/ratelimit";
import { INTERNAL_PROVIDER_CODE, type ClaimedJob, type JobHandler } from "@/lib/queue/types";
import { persistSampleAnalysis } from "@/lib/runs/persist";

/**
 * One paid API call, from claim to score.
 *
 * The run's progress is carried entirely by the counters written in the same
 * transaction as the sample's terminal state: `pending_samples` reaching zero is
 * what enqueues the task aggregation. Nothing polls, so every exit path of this
 * handler must either move the sample to a terminal state exactly once, or leave
 * both the sample and the job untouched for another attempt.
 */

const payloadSchema = z.object({
  sampleId: z.string().min(1),
  taskId: z.string().min(1),
  runId: z.string().min(1),
  projectId: z.string().min(1),
  queryText: z.string().min(1),
  providerCode: z.string().min(1),
  mode: z.enum(["PARAMETRIC", "GROUNDED"]),
  locale: z.object({ country: z.string(), language: z.string() }),
  scoringVersion: z.string().min(1),
  extractionVersion: z.string().min(1),
});

type Payload = z.infer<typeof payloadSchema>;

/** Aggregation is short and unblocks the run's report, so it jumps the sample queue. */
const AGGREGATE_PRIORITY = 10;

const MISSING_KEY_MESSAGE =
  "Aucune clé API valide pour ce moteur — ajoutez-en une dans la configuration";
const DEAD_KEY_MESSAGE =
  "Clé API invalidée : les appels restants de ce moteur ont été annulés pour cette analyse";

/**
 * Everything the call needs, or `null` when the job was already closed — the
 * sample was reconciled, the setup is terminally wrong, or the provider's bucket
 * is empty. Gathering it in one place keeps every read that precedes the paid
 * call under a single failure policy.
 */
interface CallSetup {
  provider: AIProvider;
  userId: string;
  apiKey: string;
  credentialId: string | null;
}

async function prepareCall(job: ClaimedJob, payload: Payload): Promise<CallSetup | null> {
  const started = await prisma.runSample.updateMany({
    where: { id: payload.sampleId, status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "RUNNING", startedAt: new Date(), attempt: job.attempts },
  });
  if (started.count === 0) {
    // Already cancelled or reconciled by the sweeper: paying for it again would
    // buy a result nothing will ever read.
    await complete(job.id);
    return null;
  }

  const provider = getProvider(payload.providerCode);
  if (!provider) {
    await terminate(job, payload, "BAD_REQUEST", `Moteur « ${payload.providerCode} » indisponible`);
    return null;
  }

  const project = await prisma.project.findUnique({
    where: { id: payload.projectId },
    select: { userId: true },
  });
  if (!project) {
    await terminate(job, payload, "BAD_REQUEST", "Projet introuvable");
    return null;
  }

  let apiKey: string;
  let credentialId: string | null = null;
  if (payload.providerCode === "mock") {
    apiKey = "mock";
  } else {
    const credential = await loadCredential(payload.providerCode, project.userId);
    if (!credential) {
      await terminate(job, payload, "AUTH", MISSING_KEY_MESSAGE);
      return null;
    }
    try {
      apiKey = decryptCredential(credential, {
        userId: project.userId,
        providerId: credential.providerId,
      });
    } catch (err) {
      logger.error("stored credential could not be decrypted", {
        providerCode: payload.providerCode,
        userId: project.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      await terminate(job, payload, "AUTH", MISSING_KEY_MESSAGE);
      return null;
    }
    credentialId = credential.id;
  }

  if (!(await tryConsume(bucketKeyForProvider(payload.providerCode)))) {
    // A throttle is not a failure: the job goes back to the pool with its
    // attempt returned, and the sample stays in flight.
    await release(job.id);
    return null;
  }

  return { provider, userId: project.userId, apiKey, credentialId };
}

export const runSampleHandler: JobHandler = async (job, ctx) => {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    await abandonMalformed(job, parsed.error.issues[0]?.message ?? "payload invalide");
    return;
  }
  const payload = parsed.data;

  if (ctx.signal.aborted) {
    await handleAbort(job, payload);
    return;
  }

  let setup: CallSetup | null;
  try {
    setup = await prepareCall(job, payload);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    // Nothing was bought yet and the setup reads say nothing about this sample's
    // outcome: the attempt goes back to the pool instead of being spent, and the
    // sample stays in flight for whoever claims the job next.
    logger.warn("sample setup failed, attempt returned to the pool", {
      sampleId: payload.sampleId,
      providerCode: payload.providerCode,
      error: err instanceof Error ? err.message : String(err),
    });
    await release(job.id);
    return;
  }
  if (!setup) return;

  const { provider, userId, apiKey, credentialId } = setup;

  const startedAt = Date.now();
  try {
    const response = await provider.runQuery({
      query: payload.queryText,
      mode: payload.mode,
      apiKey,
      locale: payload.locale,
      signal: ctx.signal,
    });
    const latencyMs = Date.now() - startedAt;

    // Scoring runs BEFORE the terminal transaction. That transaction enqueues
    // the task's aggregation the moment this is the last outstanding sample, and
    // a peer worker can claim it immediately — if the score were written
    // afterwards, the aggregate would be computed one sample short. Analysis is
    // idempotent and derives only from the in-memory answer, so it is safe here.
    try {
      await persistSampleAnalysis({
        sampleId: payload.sampleId,
        taskId: payload.taskId,
        runId: payload.runId,
        projectId: payload.projectId,
        userId,
        mode: payload.mode,
        text: response.text,
        providerSources: response.sources.map((source) => ({
          url: source.url,
          title: source.title,
          kind: source.kind,
        })),
        scoringVersion: payload.scoringVersion,
        extractionVersion: payload.extractionVersion,
        signal: ctx.signal,
      });
    } catch (err) {
      // The call is paid for and its raw answer is about to be stored: replaying
      // the job would buy the same text twice, so the score is left to a rescore.
      logger.error("sample analysis failed, raw response kept for rescoring", {
        sampleId: payload.sampleId,
        runId: payload.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const outcome = await prisma.$transaction(async (tx) => {
      await tx.aIResponse.upsert({
        where: { sampleId: payload.sampleId },
        create: {
          sampleId: payload.sampleId,
          rawText: response.text,
          rawJson: response.rawJson as Prisma.InputJsonValue,
          finishReason: response.finishReason ?? null,
          truncated: response.truncated,
        },
        update: {
          rawText: response.text,
          rawJson: response.rawJson as Prisma.InputJsonValue,
          finishReason: response.finishReason ?? null,
          truncated: response.truncated,
        },
      });

      return finalizeSample(tx, {
        sampleId: payload.sampleId,
        taskId: payload.taskId,
        runId: payload.runId,
        projectId: payload.projectId,
        scoringVersion: payload.scoringVersion,
        succeeded: true,
        model: response.model,
        latencyMs,
        tokensIn: response.usage?.inputTokens ?? null,
        tokensOut: response.usage?.outputTokens ?? null,
      });
    });

    await complete(job.id);
    logger.debug("sample completed", {
      sampleId: payload.sampleId,
      providerCode: payload.providerCode,
      mode: payload.mode,
      latencyMs,
      counted: outcome.changed,
    });
  } catch (err) {
    if (ctx.signal.aborted) {
      await handleAbort(job, payload);
      return;
    }

    const code = err instanceof ProviderError ? err.code : codeFromThrown(err);
    const message = err instanceof Error ? err.message : String(err);
    const retryAfterSec = err instanceof ProviderError ? err.retryAfterSec : undefined;

    await finalize(payload, code, message);

    if (code === "AUTH" && credentialId) {
      await invalidateCredential(credentialId, userId, payload, message);
      await cancelProviderJobs(payload);
    }

    logger.warn("sample failed", {
      sampleId: payload.sampleId,
      providerCode: payload.providerCode,
      code,
      attempts: job.attempts,
    });
    await fail(job.id, { code, message, retryable: isRetryable(err), retryAfterSec });
  }
};

async function loadCredential(providerCode: string, userId: string) {
  const providerRow = await prisma.provider.findUnique({
    where: { code: providerCode },
    select: { id: true },
  });
  if (!providerRow) return null;

  const credential = await prisma.providerCredential.findUnique({
    where: { userId_providerId: { userId, providerId: providerRow.id } },
  });
  if (!credential || !credential.isValid) return null;
  return credential;
}

interface FinalizeInput {
  sampleId: string;
  taskId: string;
  runId: string;
  projectId: string;
  scoringVersion: string;
  succeeded: boolean;
  model?: string | null;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * Moves the sample to its terminal state and adjusts the counters that carry the
 * run. The status guard is what makes it safe to call twice: a job retried after
 * its transaction committed, or after the sweeper reconciled the sample, finds
 * nothing to update and leaves the counters alone.
 */
async function finalizeSample(
  tx: Prisma.TransactionClient,
  input: FinalizeInput
): Promise<{ changed: boolean; pendingSamples: number }> {
  const status = input.succeeded ? "COMPLETED" : "FAILED";

  const updated = await tx.$queryRaw<{ id: string }[]>`
    UPDATE run_samples
       SET status = ${status}::"SampleStatus",
           model = ${input.model ?? null}::text,
           latency_ms = ${input.latencyMs ?? null}::int,
           tokens_in = ${input.tokensIn ?? null}::int,
           tokens_out = ${input.tokensOut ?? null}::int,
           error_code = ${input.errorCode ?? null}::text,
           error_message = ${input.errorMessage ?? null}::text,
           completed_at = ${SQL_NOW}
     WHERE id = ${input.sampleId}
       AND status IN ('PENDING'::"SampleStatus", 'RUNNING'::"SampleStatus")
    RETURNING id`;

  if (updated.length === 0) return { changed: false, pendingSamples: -1 };

  const counters = await tx.$queryRaw<{ pending_samples: number }[]>`
    UPDATE run_tasks
       SET pending_samples = GREATEST(pending_samples - 1, 0),
           done_samples = done_samples + ${input.succeeded ? 1 : 0}::int,
           failed_samples = failed_samples + ${input.succeeded ? 0 : 1}::int
     WHERE id = ${input.taskId}
    RETURNING pending_samples`;

  await tx.run.update({
    where: { id: input.runId },
    data: input.succeeded ? { doneSamples: { increment: 1 } } : { failedSamples: { increment: 1 } },
  });

  const pendingSamples = counters[0]?.pending_samples ?? -1;
  if (pendingSamples === 0) {
    await enqueue(
      [
        {
          kind: "AGGREGATE_TASK",
          runId: input.runId,
          projectId: input.projectId,
          taskId: input.taskId,
          providerCode: INTERNAL_PROVIDER_CODE,
          priority: AGGREGATE_PRIORITY,
          payload: {
            taskId: input.taskId,
            runId: input.runId,
            scoringVersion: input.scoringVersion,
          },
        },
      ],
      tx
    );
  }

  return { changed: true, pendingSamples };
}

async function finalize(payload: Payload, errorCode: string, errorMessage: string): Promise<void> {
  await prisma.$transaction((tx) =>
    finalizeSample(tx, {
      sampleId: payload.sampleId,
      taskId: payload.taskId,
      runId: payload.runId,
      projectId: payload.projectId,
      scoringVersion: payload.scoringVersion,
      succeeded: false,
      errorCode,
      errorMessage,
    })
  );
}

/** Terminal before any call was made: no retry can change the outcome. */
async function terminate(
  job: ClaimedJob,
  payload: Payload,
  errorCode: string,
  errorMessage: string
): Promise<void> {
  await finalize(payload, errorCode, errorMessage);
  await fail(job.id, { code: errorCode, message: errorMessage, retryable: false });
}

/**
 * The payload is unreadable, so the sample is identified from the job row
 * instead. Leaving it pending would stall the run for good, which is worse than
 * recording a failure nobody can act on.
 */
async function abandonMalformed(job: ClaimedJob, reason: string): Promise<void> {
  logger.error("run sample job carries an unusable payload", { jobId: job.id, reason });

  const { sampleId, taskId, runId, projectId } = job;
  if (sampleId && taskId && runId) {
    try {
      const run = await prisma.run.findUnique({
        where: { id: runId },
        select: { scoringVersion: true },
      });
      await prisma.$transaction((tx) =>
        finalizeSample(tx, {
          sampleId,
          taskId,
          runId,
          projectId,
          scoringVersion: run?.scoringVersion ?? "",
          succeeded: false,
          errorCode: "BAD_REQUEST",
          errorMessage: "Tâche illisible : cet appel doit être relancé",
        })
      );
    } catch (err) {
      logger.error("could not finalize a malformed sample", { jobId: job.id, error: err });
    }
  }

  await fail(job.id, { code: "BAD_REQUEST", message: reason, retryable: false });
}

/**
 * An abort means either the user cancelled the run, or this worker is losing the
 * job (shutdown, lease loss). Only the first is terminal for the sample: in the
 * second case the sample must stay in flight so the next attempt can complete
 * it, and releasing it here would be a race against whoever owns it now.
 */
async function handleAbort(job: ClaimedJob, payload: Payload): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: payload.runId },
    select: { cancelRequestedAt: true },
  });

  if (!run?.cancelRequestedAt) {
    logger.debug("sample interrupted, left to the next attempt", { sampleId: payload.sampleId });
    return;
  }

  await prisma.runSample.updateMany({
    where: { id: payload.sampleId, status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  await release(job.id);
}

async function invalidateCredential(
  credentialId: string,
  userId: string,
  payload: Payload,
  reason: string
): Promise<void> {
  await prisma.providerCredential.update({
    where: { id: credentialId },
    data: { isValid: false, validationError: reason, lastValidatedAt: new Date() },
  });
  await recordAudit({
    userId,
    projectId: payload.projectId,
    action: AUDIT_ACTIONS.CREDENTIAL_INVALIDATE,
    targetType: "provider_credential",
    targetId: credentialId,
    metadata: { providerCode: payload.providerCode, runId: payload.runId, reason },
  });
}

/**
 * Stops the run from spending its remaining calls on a key we now know is dead.
 * Cancelling the jobs is not enough: their samples would stay pending forever
 * and the run would never reach zero, so the counters are corrected — and the
 * tasks thereby completed are aggregated — in the same statement.
 */
async function cancelProviderJobs(payload: Payload): Promise<void> {
  const rows = await prisma.$queryRaw<
    { task_id: string; pending_samples: number; n: number }[]
  >`
    WITH cancelled_jobs AS (
      UPDATE jobs
         SET status = 'CANCELLED'::"JobStatus",
             completed_at = ${SQL_NOW},
             locked_by = NULL,
             lease_expires_at = NULL,
             updated_at = ${SQL_NOW}
       WHERE run_id = ${payload.runId}
         AND provider_code = ${payload.providerCode}
         AND status = 'QUEUED'::"JobStatus"
      RETURNING sample_id
    ),
    cancelled_samples AS (
      UPDATE run_samples s
         SET status = 'CANCELLED'::"SampleStatus",
             error_code = 'AUTH',
             error_message = ${DEAD_KEY_MESSAGE},
             completed_at = ${SQL_NOW}
        FROM cancelled_jobs c
       WHERE s.id = c.sample_id
         AND s.status IN ('PENDING'::"SampleStatus", 'RUNNING'::"SampleStatus")
      RETURNING s.task_id AS task_id
    ),
    per_task AS (
      SELECT task_id, count(*)::int AS n FROM cancelled_samples GROUP BY task_id
    )
    UPDATE run_tasks t
       SET pending_samples = GREATEST(t.pending_samples - p.n, 0),
           failed_samples = t.failed_samples + p.n
      FROM per_task p
     WHERE t.id = p.task_id
    RETURNING t.id AS task_id, t.pending_samples AS pending_samples, p.n AS n`;

  const cancelled = rows.reduce((total, row) => total + row.n, 0);
  if (cancelled === 0) return;

  await prisma.run.update({
    where: { id: payload.runId },
    data: { failedSamples: { increment: cancelled } },
  });

  const finished = rows.filter((row) => row.pending_samples === 0);
  if (finished.length > 0) {
    await enqueue(
      finished.map((row) => ({
        kind: "AGGREGATE_TASK" as const,
        runId: payload.runId,
        projectId: payload.projectId,
        taskId: row.task_id,
        providerCode: INTERNAL_PROVIDER_CODE,
        priority: AGGREGATE_PRIORITY,
        payload: {
          taskId: row.task_id,
          runId: payload.runId,
          scoringVersion: payload.scoringVersion,
        },
      }))
    );
  }

  logger.warn("remaining calls cancelled after a rejected API key", {
    runId: payload.runId,
    providerCode: payload.providerCode,
    cancelled,
  });
}
