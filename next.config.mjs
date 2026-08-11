/**
 * Security headers that do not depend on the request.
 *
 * The Content-Security-Policy is deliberately absent here and is emitted by
 * src/proxy.ts instead: it carries a per-request nonce, and a second CSP
 * response header would be intersected with it by the browser, re-blocking the
 * very scripts the nonce exists to allow.
 */
const isDev = process.env.NODE_ENV !== "production";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  ...(isDev
    ? []
    : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` otherwise writes AGENTS.md and CLAUDE.md at the repository root
  // on every start. The project documents itself under docs/, and a generated
  // file that reappears after deletion only shows up as a dirty tree.
  agentRules: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
