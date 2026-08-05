import type { NextRequest } from "next/server";

import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { json, withAuth } from "@/lib/api/route-helpers";
import { decryptCredential, maskKey } from "@/lib/crypto/credentials";
import { ProviderError, badRequest, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/providers/registry";
import type { AIProvider, KeyValidation } from "@/lib/providers/types";
import type { CredentialSummary } from "@/types/api";

type RouteContext = { params: Promise<{ credentialId: string }> };

const VALIDATION_TIMEOUT_MS = 15_000;

const providerSelect = { select: { code: true, label: true } } as const;

interface CredentialRow {
  id: string;
  providerId: string;
  lastFour: string;
  keyVersion: number;
  isValid: boolean;
  lastValidatedAt: Date | null;
  validationError: string | null;
  provider: { code: string; label: string };
}

function toSummary(cred: CredentialRow): CredentialSummary {
  return {
    id: cred.id,
    providerId: cred.providerId,
    providerCode: cred.provider.code,
    providerLabel: cred.provider.label,
    maskedKey: maskKey(cred.lastFour),
    keyVersion: cred.keyVersion,
    isValid: cred.isValid,
    lastValidatedAt: cred.lastValidatedAt?.toISOString() ?? null,
    validationError: cred.validationError,
  };
}

async function checkKey(provider: AIProvider, apiKey: string): Promise<KeyValidation> {
  try {
    return await provider.validateKey(apiKey, AbortSignal.timeout(VALIDATION_TIMEOUT_MS));
  } catch (err) {
    logger.warn("vérification de clé fournisseur impossible", {
      providerCode: provider.code,
      code: err instanceof ProviderError ? err.code : "UNKNOWN",
    });
    const reason = err instanceof ProviderError ? err.code : "UNKNOWN";
    return { valid: false, error: `Vérification impossible (${reason})` };
  }
}

/** POST re-checks a stored key against its provider. The plaintext exists only
 * inside this call: it is never returned, logged or audited. */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const { credentialId } = await params;
  return withAuth(request, async ({ userId, ip, userAgent }) => {
    const credential = await prisma.providerCredential.findFirst({
      where: { id: credentialId, userId },
      include: { provider: providerSelect },
    });
    if (!credential) throw notFound("Identifiant fournisseur");

    const implementation = getProvider(credential.provider.code);
    if (!implementation) throw badRequest("Fournisseur non pris en charge");

    let validation: KeyValidation;
    try {
      const apiKey = decryptCredential(credential, {
        userId,
        providerId: credential.providerId,
      });
      validation = await checkKey(implementation, apiKey);
    } catch {
      logger.warn("déchiffrement d'une clé fournisseur impossible", {
        credentialId: credential.id,
        keyVersion: credential.keyVersion,
      });
      validation = { valid: false, error: "Clé illisible : elle doit être ressaisie." };
    }

    const updated = await prisma.providerCredential.update({
      where: { id: credential.id },
      data: {
        isValid: validation.valid,
        lastValidatedAt: new Date(),
        validationError: validation.valid
          ? null
          : validation.error ?? "Clé refusée par le fournisseur",
      },
      include: { provider: providerSelect },
    });

    if (credential.isValid && !validation.valid) {
      await recordAudit({
        userId,
        action: AUDIT_ACTIONS.CREDENTIAL_INVALIDATE,
        targetType: "provider_credential",
        targetId: credential.id,
        metadata: { providerCode: credential.provider.code },
        ip,
        userAgent,
      });
    }

    return json<CredentialSummary>(toSummary(updated));
  });
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const { credentialId } = await params;
  return withAuth(request, async ({ userId, ip, userAgent }) => {
    const credential = await prisma.providerCredential.findFirst({
      where: { id: credentialId, userId },
      include: { provider: providerSelect },
    });
    if (!credential) throw notFound("Identifiant fournisseur");

    await prisma.providerCredential.deleteMany({ where: { id: credential.id, userId } });

    await recordAudit({
      userId,
      action: AUDIT_ACTIONS.CREDENTIAL_DELETE,
      targetType: "provider_credential",
      targetId: credential.id,
      metadata: { providerCode: credential.provider.code },
      ip,
      userAgent,
    });

    return json({ success: true });
  });
}
