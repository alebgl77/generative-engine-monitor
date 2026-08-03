/**
 * URL normalisation for citation deduplication.
 *
 * Two citations pointing at the same page must collapse into one row, otherwise
 * a single source cited twice inflates the citation count and the score derived
 * from it. Normalisation is therefore part of the measurement, and any change to
 * it belongs to a new extraction version.
 */

/**
 * Allowlist rather than a tracking blocklist: any parameter outside this set is
 * dropped, which covers utm_*, gclid, fbclid, ref, source, mc_cid, mc_eid and
 * every session id we have not seen yet.
 */
const MEANINGFUL_PARAMS: ReadonlySet<string> = new Set([
  "id",
  "page",
  "slug",
  "category",
  "q",
  "query",
  "tab",
  "section",
]);

/**
 * Hardcoded rather than a full Public Suffix List: it covers the suffixes our
 * corpus actually contains, and misclassifies the rest as two-label domains.
 */
const MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "com.mx",
  "co.za",
  "co.in",
]);

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

export function normalizeUrl(raw: string): { normalized: string; domain: string } | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const domain = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!HOST_PATTERN.test(domain)) return null;

  const kept: [string, string][] = [];
  parsed.searchParams.forEach((value, key) => {
    const name = key.toLowerCase();
    if (MEANINGFUL_PARAMS.has(name)) kept.push([name, value]);
  });
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  const query = kept.map(([key, value]) => `${key}=${value}`).join("&");
  const path = parsed.pathname.replace(/\/+$/, "");
  const normalized = `${domain}${path}${query ? `?${query}` : ""}`.toLowerCase();

  return { normalized, domain };
}

export function registrableDomain(host: string): string {
  const clean = (host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^/?#]*@/, "")
    .split(/[/?#]/)[0]
    .split(":")[0]
    .replace(/^www\./, "")
    .replace(/^\.+|\.+$/g, "");

  const labels = clean.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");

  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

export function sameDomain(a: string, b: string): boolean {
  const left = registrableDomain(a);
  const right = registrableDomain(b);
  return left.length > 0 && left === right;
}
