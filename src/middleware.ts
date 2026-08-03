import { withAuth } from "next-auth/middleware";
import type { NextRequestWithAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";

/**
 * Content Security Policy and page authentication.
 *
 * The policy is emitted here rather than from next.config.mjs because it needs a
 * per-request nonce: the App Router ships its React payload through inline
 * <script> elements, so a static `script-src 'self'` would refuse the framework's
 * own bootstrap and leave every page unhydrated. Next.js reads the nonce from the
 * inbound `Content-Security-Policy` request header, which is why the value is set
 * on the request as well as on the response.
 *
 * The policy is applied first and the session check second. next-auth's wrapper
 * returns early for the sign-in page, its own API routes and static paths, so
 * nesting this inside it would leave exactly those documents — the login form
 * among them — without a policy and therefore without scripts.
 *
 * `strict-dynamic` lets the nonced bootstrap pull the chunks it needs without
 * enumerating them; browsers too old to understand it fall back to `self`.
 */

const isDev = process.env.NODE_ENV !== "production";

/** Only these pages require a session; everything else just needs a policy. */
const PROTECTED_PREFIX = "/projects";

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    // 'unsafe-eval' is required by the development overlay only.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Tailwind injects styles at runtime and offers no nonce hook.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The browser never talks to a provider API — every outbound call is made by
    // the server or the worker.
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

const requireSession = withAuth({
  callbacks: { authorized: ({ token }) => Boolean(token) },
  pages: { signIn: "/login" },
});

export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = buildCsp(nonce);

  if (request.nextUrl.pathname.startsWith(PROTECTED_PREFIX)) {
    // Returns a redirect when the session is missing, and nothing when it is
    // present, in which case the request falls through to be rendered.
    // The wrapper types its request as already carrying a decoded token; it
    // decodes one itself, so the plain request is what it actually expects.
    const denied = (await requireSession(request as NextRequestWithAuth, event)) as
      | NextResponse
      | undefined;
    if (denied) {
      denied.headers.set("content-security-policy", csp);
      return denied;
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // Document routes only. Static assets carry no inline script, and giving them
  // a per-request header would only defeat caching.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|assets/).*)"],
};
