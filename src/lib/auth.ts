import { NextAuthOptions, getServerSession as nextAuthGetServerSession } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { clientIp } from "@/lib/net/client-ip";
import { ensureBucket, tryConsume } from "@/lib/queue/ratelimit";
import { logger } from "@/lib/logger";

/**
 * A dummy hash of the right cost, compared against when the account does not
 * exist. Without it, a missing user returns in microseconds while an existing
 * one takes the full bcrypt round, which is enough to enumerate valid emails.
 */
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.7tCVSCS0dh0RCLPHRb1AaSFMOFhFcMy";

const LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_SEC = 300;

/**
 * Kept strictly below `LOGIN_ATTEMPTS`, on the same window, so that both the
 * burst and the sustained rate a single address is allowed stay under what the
 * account's own bucket refills. One source therefore runs out of its own
 * allowance before it can drain someone else's, and cannot hold a known account
 * shut; several sources still meet the per-account limit, which is the point of
 * that bucket.
 */
const LOGIN_ATTEMPTS_PER_ADDRESS = 8;

/** The longest address worth carrying at all — the RFC 5321 path limit. */
const MAX_EMAIL_LENGTH = 254;

/** Beyond this, the address is folded into a digest before it becomes a key. */
const MAX_EMAIL_KEY_LENGTH = 120;

/**
 * A bucket key is a primary key, so its length must not be the caller's to
 * choose. Ordinary addresses stay readable; anything longer is keyed by a
 * fixed-width digest, which discriminates just as well.
 */
function bucketKeyForEmail(email: string): string {
  if (email.length <= MAX_EMAIL_KEY_LENGTH) {
    return `login:email:${email}`;
  }
  return `login:email:sha256:${createHash("sha256").update(email).digest("hex")}`;
}

/**
 * The address bucket is charged first: once a source is out of allowance, the
 * account's own bucket is left untouched rather than spent on that source's
 * behalf.
 */
async function loginAllowed(email: string, address: string | null): Promise<boolean> {
  if (address) {
    const addressKey = `login:addr:${address}`;
    await ensureBucket(
      addressKey,
      LOGIN_ATTEMPTS_PER_ADDRESS,
      LOGIN_ATTEMPTS_PER_ADDRESS / LOGIN_WINDOW_SEC
    );
    if (!(await tryConsume(addressKey, 1))) {
      return false;
    }
  }

  const key = bucketKeyForEmail(email);
  await ensureBucket(key, LOGIN_ATTEMPTS, LOGIN_ATTEMPTS / LOGIN_WINDOW_SEC);
  return tryConsume(key, 1);
}

/**
 * The credentials provider hands over the request as header records rather than
 * a `NextRequest`. `clientIp` reads exactly one header, so re-presenting those
 * records as a header carrier is enough to apply the same trusted-hop rules
 * used everywhere else — and to inherit the same null answer when no proxy is
 * declared.
 *
 * A record that cannot be turned into headers yields no address rather than an
 * error: sign-in must not depend on the shape of a header the caller controls.
 */
function addressOf(request: { headers?: Record<string, unknown> }): string | null {
  const raw = request.headers;
  if (!raw) return null;

  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        headers.set(name, value);
      } else if (Array.isArray(value)) {
        // Node reports a repeated header as an array; the chain semantics of
        // X-Forwarded-For are the same whether the hops arrived split or joined.
        const parts = value.filter((part): part is string => typeof part === "string");
        headers.set(name, parts.join(", "));
      }
    }

    return clientIp({ headers } as unknown as NextRequest);
  } catch {
    return null;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email", placeholder: "vous@exemple.fr" },
        password: { label: "Mot de passe", type: "password" },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email.trim().toLowerCase();

        // An address this long cannot belong to an account, so it is turned away
        // before it reaches a bucket, a query or the audit trail.
        if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) {
          return null;
        }

        const address = addressOf(request);

        if (!(await loginAllowed(email, address))) {
          logger.warn("login throttled", { email });
          await recordAudit({
            action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
            targetType: "user",
            metadata: { email, reason: "throttled" },
            ip: address,
          });
          return null;
        }

        const user = await prisma.user.findUnique({ where: { email } });
        const hash = user?.passwordHash ?? DUMMY_HASH;
        const passwordValid = await bcrypt.compare(credentials.password, hash);

        if (!user || !passwordValid) {
          await recordAudit({
            userId: user?.id ?? null,
            action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
            targetType: "user",
            metadata: { email, reason: "invalid_credentials" },
            ip: address,
          });
          return null;
        }

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24 * 7,
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
};

export function getServerSession() {
  return nextAuthGetServerSession(authOptions);
}

/** Alias used across API routes. */
export const getServerAuth = getServerSession;
