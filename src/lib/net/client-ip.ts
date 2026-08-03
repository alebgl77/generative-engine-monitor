import type { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";

/**
 * Resolves the caller's address from forwarded headers, and only as far as the
 * deployment is actually configured to trust them.
 *
 * `X-Forwarded-For` is appended to by each hop, so its leftmost element is
 * always whatever the client chose to send: reading index 0 hands an attacker a
 * free identity, and a fresh rate-limit bucket with every request. The value is
 * therefore read from the right, counting back exactly as many hops as the
 * operator declared in TRUSTED_PROXY_HOPS.
 *
 * With no proxy declared, the header carries no information this process can
 * vouch for and is ignored entirely. Callers must treat a null result as "no
 * per-client identity available" and fall back to a coarser guard rather than
 * to a shared bucket that any client could exhaust for everyone.
 */
export function clientIp(request: NextRequest): string | null {
  const hops = getEnv().TRUSTED_PROXY_HOPS;
  if (hops <= 0) return null;

  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) {
    // A single trusted proxy that sets only X-Real-IP is a common setup.
    return hops === 1 ? normalise(request.headers.get("x-real-ip")) : null;
  }

  const chain = forwarded
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  // The rightmost entry was written by our own proxy; each further hop to the
  // left was written by the one before it.
  const index = chain.length - hops;
  if (index < 0) return null;
  return normalise(chain[index]);
}

/** The raw header, kept for the audit trail so an assertion stays
 * distinguishable from an observation. */
export function forwardedForHeader(request: NextRequest): string | null {
  return request.headers.get("x-forwarded-for");
}

function normalise(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 45) return null;
  return trimmed;
}
