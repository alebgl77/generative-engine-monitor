import type { Prisma } from "@prisma/client";

import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Append-only trail of the actions that matter for support and forensics.
 *
 * Auditing is observational: a failure to write the trail must never turn a
 * successful credential deletion or run start into an error for the user. The
 * write is therefore swallowed and reported to the logger instead.
 */

export const AUDIT_ACTIONS = {
  CREDENTIAL_CREATE: "credential.create",
  CREDENTIAL_DELETE: "credential.delete",
  CREDENTIAL_INVALIDATE: "credential.invalidate",
  RUN_START: "run.start",
  RUN_CANCEL: "run.cancel",
  RESCORE_START: "rescore.start",
  SCORING_PROMOTE: "scoring.promote",
  EXPORT_DOWNLOAD: "export.download",
  AUTH_REGISTER: "auth.register",
  AUTH_LOGIN_FAILED: "auth.login_failed",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditInput {
  userId?: string | null;
  projectId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        projectId: input.projectId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        metadata:
          input.metadata === undefined ? undefined : (input.metadata as Prisma.InputJsonObject),
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch (error) {
    logger.error("Écriture du journal d'audit impossible", {
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      userId: input.userId ?? null,
      projectId: input.projectId ?? null,
      error,
    });
  }
}
