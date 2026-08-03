import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors";
import { extractTextUrls, providerFetch } from "@/lib/providers/http";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

const captured: CapturedRequest[] = [];

function respondWith(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {}
): void {
  vi.stubGlobal("fetch", async (url: string, requestInit: RequestInit) => {
    captured.push({ url, init: requestInit });
    return new Response(body, {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  });
}

/** Mimics a socket that stays open until one of the combined signals fires. */
function respondNever(): void {
  vi.stubGlobal("fetch", (url: string, requestInit: RequestInit) => {
    captured.push({ url, init: requestInit });
    const signal = requestInit.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  });
}

function call<T>(overrides: Partial<Parameters<typeof providerFetch>[0]> = {}): Promise<T> {
  return providerFetch<T>({
    providerCode: "openai",
    url: "https://api.example.test/v1/answers",
    body: { question: "meilleur crm" },
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    ...overrides,
  });
}

async function expectProviderError(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error("la requête aurait dû échouer");
}

afterEach(() => {
  vi.unstubAllGlobals();
  captured.length = 0;
});

describe("providerFetch", () => {
  it("returns the decoded payload and sends JSON with the caller's headers", async () => {
    respondWith(JSON.stringify({ answer: "ok" }));

    const payload = await call<{ answer: string }>({ headers: { Authorization: "Bearer sk-test" } });

    expect(payload).toEqual({ answer: "ok" });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://api.example.test/v1/answers");
    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    });
    expect(captured[0].init.body).toBe(JSON.stringify({ question: "meilleur crm" }));
  });

  it("sends no body at all on a GET", async () => {
    respondWith(JSON.stringify({ data: [] }));

    await call({ method: "GET", body: undefined });

    expect(captured[0].init.method).toBe("GET");
    expect(captured[0].init.body).toBeUndefined();
  });

  it("maps 401 to an AUTH error that condemns the credential", async () => {
    respondWith('{"error":"invalid api key"}', { status: 401 });

    const err = await expectProviderError(call());

    expect(err.code).toBe("AUTH");
    expect(err.status).toBe(401);
    expect(err.invalidatesCredential).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.providerCode).toBe("openai");
  });

  it("maps 403 to AUTH as well", async () => {
    respondWith("forbidden", { status: 403 });

    const err = await expectProviderError(call());

    expect(err.code).toBe("AUTH");
    expect(err.invalidatesCredential).toBe(true);
  });

  it("maps 429 to a retryable RATE_LIMIT and reads Retry-After in seconds", async () => {
    respondWith("slow down", { status: 429, headers: { "Retry-After": "30" } });

    const err = await expectProviderError(call());

    expect(err.code).toBe("RATE_LIMIT");
    expect(err.retryable).toBe(true);
    expect(err.invalidatesCredential).toBe(false);
    expect(err.retryAfterSec).toBe(30);
  });

  it("reads Retry-After in its HTTP-date form", async () => {
    const when = new Date(Date.now() + 120_000).toUTCString();
    respondWith("slow down", { status: 429, headers: { "Retry-After": when } });

    const err = await expectProviderError(call());

    expect(err.code).toBe("RATE_LIMIT");
    expect(err.retryAfterSec).toBeGreaterThanOrEqual(118);
    expect(err.retryAfterSec).toBeLessThanOrEqual(121);
  });

  it("never reports a negative wait for a Retry-After date already in the past", async () => {
    const when = new Date(Date.now() - 60_000).toUTCString();
    respondWith("slow down", { status: 429, headers: { "Retry-After": when } });

    const err = await expectProviderError(call());

    expect(err.retryAfterSec).toBe(0);
  });

  it("leaves the wait unset when Retry-After is absent or unreadable", async () => {
    respondWith("slow down", { status: 429 });
    expect((await expectProviderError(call())).retryAfterSec).toBeUndefined();

    respondWith("slow down", { status: 429, headers: { "Retry-After": "bientôt" } });
    expect((await expectProviderError(call())).retryAfterSec).toBeUndefined();
  });

  it("maps 500 to a retryable SERVER error", async () => {
    respondWith("upstream exploded", { status: 503 });

    const err = await expectProviderError(call());

    expect(err.code).toBe("SERVER");
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.invalidatesCredential).toBe(false);
  });

  it("maps 404 to MODEL_NOT_FOUND when the caller can tell a model from a route", async () => {
    respondWith('{"error":"model not found"}', { status: 404 });

    const err = await expectProviderError(call({ notFoundMeans: "model" }));

    expect(err.code).toBe("MODEL_NOT_FOUND");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("Modèle");
  });

  it("maps a bare 404 to BAD_REQUEST", async () => {
    respondWith("not found", { status: 404 });

    expect((await expectProviderError(call())).code).toBe("BAD_REQUEST");
  });

  it("maps a body that is not JSON to PARSE", async () => {
    respondWith("<html><body>Service temporarily unavailable</body></html>");

    const err = await expectProviderError(call());

    expect(err.code).toBe("PARSE");
    expect(err.status).toBe(200);
    expect(err.retryable).toBe(false);
  });

  it("truncates the stored details so an HTML error page cannot be kept whole", async () => {
    const page = `<html>${"x".repeat(20_000)}</html>`;
    respondWith(page, { status: 500 });

    const err = await expectProviderError(call());

    expect(err.details).toBeDefined();
    expect(err.details!.length).toBe(601);
    expect(err.details!.endsWith("…")).toBe(true);
    expect(err.details!.startsWith("<html>")).toBe(true);
  });

  it("keeps a short error body intact", async () => {
    respondWith("rate limited", { status: 429 });

    expect((await expectProviderError(call())).details).toBe("rate limited");
  });

  it("maps an abort coming from the caller to CANCELLED", async () => {
    respondNever();
    const controller = new AbortController();

    const promise = call({ signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();

    const err = await expectProviderError(promise);

    expect(err.code).toBe("CANCELLED");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("Requête annulée");
  });

  it("maps its own deadline to a retryable TIMEOUT", async () => {
    respondNever();

    const err = await expectProviderError(call({ timeoutMs: 20 }));

    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("Délai dépassé");
  });

  it("maps a transport failure to NETWORK", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });

    const err = await expectProviderError(call());

    expect(err.code).toBe("NETWORK");
    expect(err.retryable).toBe(true);
  });
});

describe("extractTextUrls", () => {
  it("reads a markdown link with its label", () => {
    expect(extractTextUrls("Voir [Capterra](https://capterra.fr/crm) pour le détail.")).toEqual([
      { url: "https://capterra.fr/crm", title: "Capterra", kind: "INLINE_MARKDOWN" },
    ]);
  });

  it("leaves the title unset when the markdown label is empty", () => {
    expect(extractTextUrls("[](https://g2.com/crm)")).toEqual([
      { url: "https://g2.com/crm", title: undefined, kind: "INLINE_MARKDOWN" },
    ]);
  });

  it("reads a bare URL and strips its trailing punctuation", () => {
    expect(extractTextUrls("Source : https://g2.com/categories/crm.")).toEqual([
      { url: "https://g2.com/categories/crm", kind: "BARE_URL" },
    ]);
    expect(extractTextUrls("Voir https://g2.com/crm, puis https://appvizer.fr/crm;")).toEqual([
      { url: "https://g2.com/crm", kind: "BARE_URL" },
      { url: "https://appvizer.fr/crm", kind: "BARE_URL" },
    ]);
  });

  it("keeps a URL once, as a markdown link, when it also appears bare", () => {
    const text = "D'abord [G2](https://g2.com/crm), ensuite https://g2.com/crm à nouveau.";

    expect(extractTextUrls(text)).toEqual([
      { url: "https://g2.com/crm", title: "G2", kind: "INLINE_MARKDOWN" },
    ]);
  });

  it("never repeats the same URL", () => {
    const text = "https://g2.com/crm et https://g2.com/crm et [x](https://g2.com/crm)";

    expect(extractTextUrls(text)).toHaveLength(1);
  });

  it("returns nothing for text without a link", () => {
    expect(extractTextUrls("Aucune source citée dans cette réponse.")).toEqual([]);
  });
});
