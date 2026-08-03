/**
 * The sign-in and sign-up pages are rendered per request.
 *
 * They are the only routes Next.js would otherwise prerender at build time, and
 * a prerendered document cannot carry the per-request nonce that the Content
 * Security Policy demands of every inline script. Serving them from the static
 * cache would hand the browser a policy whose nonce matches nothing in the page,
 * so the framework bootstrap would be refused and the form would never bind its
 * submit handler.
 */
export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
