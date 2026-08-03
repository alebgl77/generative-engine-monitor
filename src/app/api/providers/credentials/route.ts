import type { NextRequest } from "next/server";
import { z } from "zod";

import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { json, parseBody, withAuth } from "@/lib/api/route-helpers";
import { encryptCredential, maskKey } from "@/lib/crypto/credentials";
import { ProviderError, badRequest, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/providers/registry";
import type { AIProvider, KeyValidation } from "@/lib/providers/types";
import type { CredentialSummary } from "@/types/api";

const VALIDATION_TIMEOUT_MS = 15_000;

const createSchema = z.object({
  providerId: z.string().min(1, "fournisseur requis"),
  apiKey: z.string().trim().min(1, "clé API requise").max(500, "500 caractères maximum"),
});

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

/**
 * A key is checked against the provider before it is stored. Accepting it on
 * sight moves the failure to the first run, where it costs a full campaign of
 * failed tasks to discover a typo.
 */
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

const providerSelect = { select: { code: true, label: true } } as const;

export async function GET(request: NextRequest) {
  return withAuth(request, async ({ userId }) => {
    const credentials = await prisma.providerCredential.findMany({
      where: { userId },
      include: { provider: providerSelect },
      orderBy: { createdAt: "asc" },
    });
    return json<CredentialSummary[]>(credentials.map(toSummary));
  });
}

export async function POST(request: NextRequest) {
  return withAuth(request, async ({ userId, ip, userAgent }) => {
    const body = await parseBody(request, createSchema);

    const provider = await prisma.provider.findUnique({ where: { id: body.providerId } });
    if (!provider) throw notFound("Fournisseur");

    const implementation = getProvider(provider.code);
    if (!implementation) throw badRequest("Fournisseur non pris en charge");

    const validation = await checkKey(implementation, body.apiKey);
    const secret = encryptCredential(body.apiKey, { userId, providerId: provider.id });
    // An invalid key is stored anyway, with its reason, so the settings page can
    // show what is wrong instead of losing what the user typed.
    const state = {
      isValid: validation.valid,
      lastValidatedAt: new Date(),
      validationError: validation.valid
        ? null
        : validation.error ?? "Clé refusée par le fournisseur",
    };

    const credential = await prisma.providerCredential.upsert({
      where: { userId_providerId: { userId, providerId: provider.id } },
      create: { userId, providerId: provider.id, ...secret, ...state },
      update: { ...secret, ...state },
      include: { provider: providerSelect },
    });

    await recordAudit({
      userId,
      action: AUDIT_ACTIONS.CREDENTIAL_CREATE,
      targetType: "provider_credential",
      targetId: credential.id,
      metadata: { providerCode: provider.code, isValid: validation.valid },
      ip,
      userAgent,
    });

    return json<CredentialSummary>(toSummary(credential), 201);
  });
}
