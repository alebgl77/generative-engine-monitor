import { ProviderError, codeFromStatus, codeFromThrown } from "@/lib/errors";

/**
 * Shared HTTP layer for provider calls.
 *
 * Every provider request goes through here so that timeouts, cancellation and
 * error classification are uniform. Retries deliberately live in the queue, not
 * here: a retry costs a paid API call and must be visible in the job's attempt
 * counter and backoff, not hidden inside a helper.
 */

export interface ProviderFetchOptions {
  providerCode: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  /** Aborted by the worker on timeout, shutdown or run cancellation. */
  signal: AbortSignal;
  timeoutMs: number;
  /** Disambiguates a 404: a missing model is terminal and worth reporting loudly. */
  notFoundMeans?: "model";
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
}

/** Truncated so a provider's HTML error page cannot flood the database. */
function truncate(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function providerFetch<T>(options: ProviderFetchOptions): Promise<T> {
  const { providerCode, url, method = "POST", headers = {}, body, signal, timeoutMs } = options;

  // Combine the caller's cancellation with our own deadline: whichever fires
  // first aborts the request.
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    // A caller-driven abort is a cancellation; our own deadline is a timeout.
    if (signal.aborted) {
      throw new ProviderError("CANCELLED", providerCode, "Requête annulée", { cause: err });
    }
    const code = codeFromThrown(err);
    throw new ProviderError(
      code,
      providerCode,
      code === "TIMEOUT"
        ? `Délai dépassé après ${Math.round(timeoutMs / 1000)}s`
        : `Échec réseau: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const code = codeFromStatus(response.status, options.notFoundMeans);
    throw new ProviderError(code, providerCode, providerMessage(code, providerCode, response.status), {
      status: response.status,
      retryAfterSec: parseRetryAfter(response.headers),
      details: truncate(text),
    });
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new ProviderError(
      "PARSE",
      providerCode,
      "Réponse illisible (JSON invalide)",
      { status: response.status, cause: err }
    );
  }
}

function providerMessage(code: string, providerCode: string, status: number): string {
  switch (code) {
    case "AUTH":
      return `Clé API ${providerCode} refusée (HTTP ${status})`;
    case "RATE_LIMIT":
      return `Quota ${providerCode} atteint (HTTP 429)`;
    case "MODEL_NOT_FOUND":
      return `Modèle ${providerCode} introuvable — il a probablement été retiré, vérifiez la variable d'environnement de modèle`;
    case "SERVER":
      return `Incident côté ${providerCode} (HTTP ${status})`;
    default:
      return `Erreur ${providerCode} (HTTP ${status})`;
  }
}

/** Markdown links and bare URLs found in answer text — weaker evidence than
 * native grounding metadata, kept separate for exactly that reason. */
export function extractTextUrls(text: string): { url: string; title?: string; kind: "INLINE_MARKDOWN" | "BARE_URL" }[] {
  const results: { url: string; title?: string; kind: "INLINE_MARKDOWN" | "BARE_URL" }[] = [];
  const seen = new Set<string>();

  const markdown = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdown.exec(text)) !== null) {
    const url = match[2];
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ url, title: match[1] || undefined, kind: "INLINE_MARKDOWN" });
  }

  const bare = /https?:\/\/[^\s<>()\[\]"']+/g;
  while ((match = bare.exec(text)) !== null) {
    const url = match[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ url, kind: "BARE_URL" });
  }

  return results;
}
