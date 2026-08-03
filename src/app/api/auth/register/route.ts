import { NextResponse, type NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/api/route-helpers";
import { AppError, tooManyRequests } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { clientIp, forwardedForHeader } from "@/lib/net/client-ip";
import { prisma } from "@/lib/prisma";
import { ensureBucket, tryConsume } from "@/lib/queue/ratelimit";

/**
 * The only unauthenticated mutation in the API, so it carries its own guards:
 * a per-IP token bucket and a duplicate-email answer that reveals nothing about
 * which addresses already have an account.
 */

const BCRYPT_COST = 12;
const REGISTRATIONS_PER_HOUR = 5;

const LETTER = /[a-zÀ-ɏ]/i;
const DIGIT = /\d/;

const bodySchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, "254 caractères maximum")
    .email("adresse e-mail invalide"),
  password: z
    .string()
    .min(10, "au moins 10 caractères")
    .max(200, "200 caractères maximum")
    .refine(
      (v) => LETTER.test(v) && DIGIT.test(v),
      "doit contenir au moins une lettre et un chiffre"
    ),
  name: z.string().trim().max(100, "100 caractères maximum").optional(),
});

/**
 * Registrations are bounded twice. The per-address bucket only exists when a
 * trusted proxy makes an address knowable; the global bucket is what actually
 * holds when it does not, because a client that can invent its own address can
 * otherwise mint an unlimited allowance one header at a time.
 */
const REGISTRATIONS_PER_HOUR_GLOBAL = 30;

function errorResponse(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json({ error: err.publicMessage }, { status: err.status });
  }
  if (err instanceof z.ZodError) {
    const detail = err.issues.map((i) => `${i.path.join(".") || "corps"}: ${i.message}`).join("; ");
    return NextResponse.json({ error: `Requête invalide — ${detail}` }, { status: 400 });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return NextResponse.json(
      { error: "Inscription impossible avec ces informations." },
      { status: 409 }
    );
  }
  logger.error("échec inattendu de l'inscription", {
    error: err instanceof Error ? err.message : String(err),
  });
  return NextResponse.json({ error: "Erreur interne" }, { status: 500 });
}

export async function POST(request: NextRequest) {
  try {
    // Consumed first, so a caller inventing addresses cannot step around it.
    await ensureBucket(
      "register:global",
      REGISTRATIONS_PER_HOUR_GLOBAL,
      REGISTRATIONS_PER_HOUR_GLOBAL / 3600
    );
    if (!(await tryConsume("register:global"))) {
      throw tooManyRequests("Trop d'inscriptions en cours. Réessayez dans une heure.");
    }

    const ip = clientIp(request);
    if (ip) {
      const bucketKey = `register:${ip}`;
      await ensureBucket(bucketKey, REGISTRATIONS_PER_HOUR, REGISTRATIONS_PER_HOUR / 3600);
      if (!(await tryConsume(bucketKey))) {
        throw tooManyRequests(
          "Trop de tentatives d'inscription depuis cette adresse. Réessayez dans une heure."
        );
      }
    }

    const body = await parseBody(request, bodySchema);
    const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);

    // The unique index is the only authority on availability: a prior lookup
    // would leave a window in which two requests both find the address free.
    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        name: body.name && body.name.length > 0 ? body.name : null,
      },
      select: { id: true, email: true, name: true },
    });

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.AUTH_REGISTER,
      targetType: "user",
      targetId: user.id,
      // `ip` is what this process could vouch for; the raw header is what the
      // client asserted. Keeping them apart is the difference between an
      // observation and a claim.
      metadata: { email: user.email, forwardedFor: forwardedForHeader(request) },
      ip,
      userAgent: request.headers.get("user-agent"),
    });

    return NextResponse.json(user, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
