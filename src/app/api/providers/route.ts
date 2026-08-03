import type { NextRequest } from "next/server";

import { json, withAuth } from "@/lib/api/route-helpers";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/providers/registry";
import type { ProviderSummary } from "@/types/api";

export async function GET(request: NextRequest) {
  return withAuth(request, async ({ userId }) => {
    const [providers, credentials] = await Promise.all([
      prisma.provider.findMany({ where: { isActiveGlobal: true }, orderBy: { label: "asc" } }),
      prisma.providerCredential.findMany({ where: { userId }, select: { providerId: true } }),
    ]);

    const credentialed = new Set(credentials.map((c) => c.providerId));

    const rows: ProviderSummary[] = providers.map((p) => ({
      id: p.id,
      code: p.code,
      label: p.label,
      supportsParametric: p.supportsParametric,
      supportsGrounded: p.supportsGrounded,
      // The row wins when it is set; the registry supplies the env-resolved
      // default for a provider seeded before a model rename.
      defaultModel: p.defaultModel || getProvider(p.code)?.defaultModel() || "",
      hasCredential: credentialed.has(p.id),
    }));

    return json<ProviderSummary[]>(rows);
  });
}
