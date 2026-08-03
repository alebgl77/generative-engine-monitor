import type { SamplingMode } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = "postgresql://gem:gem@localhost:5432/gem_test";
process.env.NEXTAUTH_SECRET = "test-nextauth-secret-value";
process.env.CREDENTIAL_KEYS = JSON.stringify({ "1": Buffer.alloc(32, 0x33).toString("base64") });
process.env.CREDENTIAL_KEY_CURRENT = "1";
process.env.CREDENTIAL_FINGERPRINT_PEPPER = "test-fingerprint-pepper-value";
process.env.OPENAI_MODEL = "openai-test-model";
process.env.ANTHROPIC_MODEL = "claude-test-model";
process.env.GEMINI_MODEL = "gemini-test-model";
process.env.PERPLEXITY_MODEL = "perplexity-test-model";

import { ProviderError } from "@/lib/errors";
import { ClaudeProvider } from "@/lib/providers/claude";
import { GeminiProvider } from "@/lib/providers/gemini";
import { MockProvider } from "@/lib/providers/mock";
import { OpenAIProvider } from "@/lib/providers/openai";
import { PerplexityProvider } from "@/lib/providers/perplexity";
import type { AIProvider, ProviderQueryInput, ProviderResponse } from "@/lib/providers/types";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const captured: CapturedRequest[] = [];

function stubJson(payload: unknown, status = 200): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    captured.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : {},
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function stubFailure(status: number, body = '{"error":"nope"}'): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    captured.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : {},
    });
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  });
}

function input(mode: SamplingMode, overrides: Partial<ProviderQueryInput> = {}): ProviderQueryInput {
  return {
    query: "meilleur crm pour pme",
    mode,
    apiKey: "sk-secret-key",
    locale: { country: "FR", language: "fr" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function lastRequest(): CapturedRequest {
  const request = captured.at(-1);
  if (!request) throw new Error("aucune requête capturée");
  return request;
}

afterEach(() => {
  vi.unstubAllGlobals();
  captured.length = 0;
});

const OPENAI_PAYLOAD = {
  id: "resp_1",
  status: "completed",
  output: [
    { type: "web_search_call", status: "completed" },
    {
      type: "message",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Salesforce domine le haut du marché. ",
          annotations: [
            { type: "url_citation", url: "https://www.g2.com/categories/crm", title: "G2 — CRM" },
            { type: "file_citation", url: "https://ignored.example/file" },
          ],
        },
        {
          type: "output_text",
          text: "Voir [G2 — CRM](https://www.g2.com/categories/crm) et https://www.appvizer.fr/crm.",
          annotations: [],
        },
      ],
    },
  ],
  usage: { input_tokens: 120, output_tokens: 340 },
};

const CLAUDE_PAYLOAD = {
  id: "msg_1",
  content: [
    {
      type: "web_search_tool_result",
      content: [
        { url: "https://www.capterra.fr/crm", title: "Capterra — CRM" },
        { url: "", title: "vide" },
      ],
    },
    {
      type: "text",
      text: "HubSpot convient aux équipes marketing. ",
      citations: [
        {
          type: "web_search_result_location",
          url: "https://blog.hubspot.fr/crm",
          title: "HubSpot — CRM",
        },
        { type: "char_location", url: "https://ignored.example/doc" },
      ],
    },
    {
      type: "text",
      text: "Détail sur [Capterra — CRM](https://www.capterra.fr/crm) ou https://www.appvizer.fr/crm.",
      citations: null,
    },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 90, output_tokens: 210 },
};

const GEMINI_PAYLOAD = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [
          { text: "Pipedrive est apprécié des PME. " },
          {
            text: "Comparatif [Appvizer](https://www.appvizer.fr/crm) et https://www.journaldunet.com/crm.",
          },
        ],
      },
      finishReason: "STOP",
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: "https://www.appvizer.fr/crm", title: "Appvizer — CRM" } },
          { web: { uri: "https://www.lesechos.fr/crm" } },
          { web: {} },
        ],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 44, candidatesTokenCount: 88 },
};

const PERPLEXITY_PAYLOAD = {
  id: "cmpl_1",
  choices: [
    {
      message: {
        role: "assistant",
        content:
          "Zoho CRM et [Sellsy](https://www.sellsy.com/crm) sont cités, voir aussi https://www.trustradius.com/crm.",
      },
      finish_reason: "stop",
    },
  ],
  search_results: [
    { title: "Sellsy — CRM", url: "https://www.sellsy.com/crm", date: null },
    { title: "Les Échos — CRM", url: "https://www.lesechos.fr/crm" },
  ],
  citations: ["https://legacy.example/ignored"],
  usage: { prompt_tokens: 61, completion_tokens: 150 },
};

describe("OpenAIProvider", () => {
  it("sends no tools key in PARAMETRIC mode", async () => {
    stubJson(OPENAI_PAYLOAD);

    await new OpenAIProvider().runQuery(input("PARAMETRIC"));

    expect(Object.keys(lastRequest().body)).not.toContain("tools");
    expect(lastRequest().body.model).toBe("openai-test-model");
  });

  it("turns on its own web search in GROUNDED mode", async () => {
    stubJson(OPENAI_PAYLOAD);

    await new OpenAIProvider().runQuery(input("GROUNDED"));

    expect(lastRequest().body.tools).toEqual([{ type: "web_search" }]);
  });

  it("concatenates the output_text parts and ranks native citations first", async () => {
    stubJson(OPENAI_PAYLOAD);

    const response = await new OpenAIProvider().runQuery(input("GROUNDED"));

    expect(response.text).toBe(
      "Salesforce domine le haut du marché. Voir [G2 — CRM](https://www.g2.com/categories/crm) et https://www.appvizer.fr/crm."
    );
    expect(response.sources).toEqual([
      { url: "https://www.g2.com/categories/crm", title: "G2 — CRM", kind: "NATIVE" },
      { url: "https://www.appvizer.fr/crm", kind: "BARE_URL" },
    ]);
    expect(response.model).toBe("openai-test-model");
    expect(response.finishReason).toBe("completed");
    expect(response.truncated).toBe(false);
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 340 });
    expect(response.rawJson.id).toBe("resp_1");
  });

  it("flags an answer cut short by the token budget", async () => {
    stubJson({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        { type: "message", status: "incomplete", content: [{ type: "output_text", text: "Sales" }] },
      ],
    });

    const response = await new OpenAIProvider().runQuery(input("PARAMETRIC"));

    expect(response.truncated).toBe(true);
    expect(response.text).toBe("Sales");
    expect(response.usage).toBeUndefined();
  });

  it("survives a payload with no output at all", async () => {
    stubJson({});

    const response = await new OpenAIProvider().runQuery(input("PARAMETRIC"));

    expect(response.text).toBe("");
    expect(response.sources).toEqual([]);
  });
});

describe("ClaudeProvider", () => {
  it("sends no tools key in PARAMETRIC mode", async () => {
    stubJson(CLAUDE_PAYLOAD);

    await new ClaudeProvider().runQuery(input("PARAMETRIC"));

    expect(Object.keys(lastRequest().body)).not.toContain("tools");
    expect(lastRequest().body.model).toBe("claude-test-model");
  });

  it("attaches its own web search tool in GROUNDED mode", async () => {
    stubJson(CLAUDE_PAYLOAD);

    await new ClaudeProvider().runQuery(input("GROUNDED"));

    expect(lastRequest().body.tools).toEqual([
      { type: "web_search_20260318", name: "web_search", max_uses: 5 },
    ]);
  });

  it("joins the text blocks and merges tool results with inline citations", async () => {
    stubJson(CLAUDE_PAYLOAD);

    const response = await new ClaudeProvider().runQuery(input("GROUNDED"));

    expect(response.text).toBe(
      "HubSpot convient aux équipes marketing. Détail sur [Capterra — CRM](https://www.capterra.fr/crm) ou https://www.appvizer.fr/crm."
    );
    expect(response.sources).toEqual([
      { url: "https://www.capterra.fr/crm", title: "Capterra — CRM", kind: "NATIVE" },
      { url: "https://blog.hubspot.fr/crm", title: "HubSpot — CRM", kind: "NATIVE" },
      { url: "https://www.appvizer.fr/crm", kind: "BARE_URL" },
    ]);
    expect(response.finishReason).toBe("end_turn");
    expect(response.truncated).toBe(false);
    expect(response.usage).toEqual({ inputTokens: 90, outputTokens: 210 });
  });

  it("flags an answer stopped on max_tokens", async () => {
    stubJson({ content: [{ type: "text", text: "HubSpot" }], stop_reason: "max_tokens" });

    const response = await new ClaudeProvider().runQuery(input("PARAMETRIC"));

    expect(response.truncated).toBe(true);
  });
});

describe("GeminiProvider", () => {
  it("sends no tools key in PARAMETRIC mode", async () => {
    stubJson(GEMINI_PAYLOAD);

    await new GeminiProvider().runQuery(input("PARAMETRIC"));

    expect(Object.keys(lastRequest().body)).not.toContain("tools");
  });

  it("turns on Google Search in GROUNDED mode", async () => {
    stubJson(GEMINI_PAYLOAD);

    await new GeminiProvider().runQuery(input("GROUNDED"));

    expect(lastRequest().body.tools).toEqual([{ googleSearch: {} }]);
  });

  it("passes the API key as a header and keeps it out of the URL", async () => {
    stubJson(GEMINI_PAYLOAD);

    await new GeminiProvider().runQuery(input("GROUNDED"));

    const request = lastRequest();
    expect(request.headers["x-goog-api-key"]).toBe("sk-secret-key");
    expect(request.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent"
    );
    expect(request.url).not.toContain("key=");
    expect(request.url).not.toContain("sk-secret-key");
    expect(request.url).not.toContain("?");
  });

  it("joins the candidate parts and keeps grounding chunks ahead of text links", async () => {
    stubJson(GEMINI_PAYLOAD);

    const response = await new GeminiProvider().runQuery(input("GROUNDED"));

    expect(response.text).toBe(
      "Pipedrive est apprécié des PME. Comparatif [Appvizer](https://www.appvizer.fr/crm) et https://www.journaldunet.com/crm."
    );
    expect(response.sources).toEqual([
      { url: "https://www.appvizer.fr/crm", title: "Appvizer — CRM", kind: "NATIVE" },
      { url: "https://www.lesechos.fr/crm", title: undefined, kind: "NATIVE" },
      { url: "https://www.journaldunet.com/crm", kind: "BARE_URL" },
    ]);
    expect(response.model).toBe("gemini-test-model");
    expect(response.finishReason).toBe("STOP");
    expect(response.truncated).toBe(false);
    expect(response.usage).toEqual({ inputTokens: 44, outputTokens: 88 });
  });

  it("flags an answer stopped on MAX_TOKENS", async () => {
    stubJson({
      candidates: [{ content: { parts: [{ text: "Pipedrive" }] }, finishReason: "MAX_TOKENS" }],
    });

    const response = await new GeminiProvider().runQuery(input("PARAMETRIC"));

    expect(response.truncated).toBe(true);
    expect(response.usage).toBeUndefined();
  });
});

describe("PerplexityProvider", () => {
  it("refuses PARAMETRIC without spending a call", async () => {
    stubJson(PERPLEXITY_PAYLOAD);

    const error = await new PerplexityProvider()
      .runQuery(input("PARAMETRIC"))
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("UNSUPPORTED_MODE");
    expect((error as ProviderError).retryable).toBe(false);
    expect(captured).toHaveLength(0);
    expect(new PerplexityProvider().capabilities).toEqual({ parametric: false, grounded: true });
  });

  it("queries its search-native model in GROUNDED mode, search being intrinsic", async () => {
    stubJson(PERPLEXITY_PAYLOAD);

    await new PerplexityProvider().runQuery(input("GROUNDED"));

    expect(lastRequest().body.model).toBe("perplexity-test-model");
    expect(Object.keys(lastRequest().body)).not.toContain("tools");
  });

  it("prefers search_results over the legacy citations array", async () => {
    stubJson(PERPLEXITY_PAYLOAD);

    const response = await new PerplexityProvider().runQuery(input("GROUNDED"));

    expect(response.text).toBe(
      "Zoho CRM et [Sellsy](https://www.sellsy.com/crm) sont cités, voir aussi https://www.trustradius.com/crm."
    );
    expect(response.sources).toEqual([
      { url: "https://www.sellsy.com/crm", title: "Sellsy — CRM", kind: "NATIVE" },
      { url: "https://www.lesechos.fr/crm", title: "Les Échos — CRM", kind: "NATIVE" },
      { url: "https://www.trustradius.com/crm", kind: "BARE_URL" },
    ]);
    expect(response.sources.map((s) => s.url)).not.toContain("https://legacy.example/ignored");
    expect(response.usage).toEqual({ inputTokens: 61, outputTokens: 150 });
  });

  it("falls back on the legacy citations array when search_results is absent", async () => {
    stubJson({
      choices: [{ message: { content: "Axonaut est une option." }, finish_reason: "length" }],
      citations: ["https://www.axonaut.com/crm", ""],
    });

    const response = await new PerplexityProvider().runQuery(input("GROUNDED"));

    expect(response.sources).toEqual([{ url: "https://www.axonaut.com/crm", kind: "NATIVE" }]);
    expect(response.truncated).toBe(true);
    expect(response.usage).toBeUndefined();
  });
});

describe("validateKey", () => {
  const providers: AIProvider[] = [
    new OpenAIProvider(),
    new ClaudeProvider(),
    new GeminiProvider(),
    new PerplexityProvider(),
  ];

  for (const provider of providers) {
    it(`${provider.code} reports a refused key instead of throwing`, async () => {
      stubFailure(401);

      const result = await provider.validateKey("sk-wrong");

      expect(result.valid).toBe(false);
      expect(typeof result.error).toBe("string");
      expect(result.error).not.toBe("");
      expect(result.error).not.toContain("sk-wrong");
    });

    it(`${provider.code} reports an unreachable API instead of throwing`, async () => {
      vi.stubGlobal("fetch", async () => {
        throw new TypeError("fetch failed");
      });

      const result = await provider.validateKey("sk-live");

      expect(result.valid).toBe(false);
      expect(typeof result.error).toBe("string");
    });

    it(`${provider.code} accepts a key the API answered for`, async () => {
      stubJson({ data: [], content: [], candidates: [], choices: [] });

      expect(await provider.validateKey("sk-live")).toEqual({ valid: true });
    });
  }
});

describe("MockProvider", () => {
  const provider = new MockProvider();

  function run(mode: SamplingMode, seed: string): Promise<ProviderResponse> {
    return provider.runQuery(input(mode, { model: seed }));
  }

  it("replays the same fixture for the same seed", async () => {
    const first = await run("GROUNDED", "0");
    const second = await run("GROUNDED", "0");

    expect(second.text).toBe(first.text);
    expect(second.sources).toEqual(first.sources);
    expect(second.rawJson).toEqual(first.rawJson);
  });

  it("varies across seeds so repetitions are not identical", async () => {
    const texts = new Set<string>();
    for (const seed of ["0", "1", "2"]) {
      texts.add((await run("GROUNDED", seed)).text);
    }

    expect(texts.size).toBeGreaterThan(1);
  });

  it("varies across modes for one seed", async () => {
    const parametric = await run("PARAMETRIC", "0");
    const grounded = await run("GROUNDED", "0");

    expect(grounded.text).not.toBe(parametric.text);
  });

  it("cites sources only in GROUNDED mode", async () => {
    const grounded = await run("GROUNDED", "0");
    const parametric = await run("PARAMETRIC", "0");

    expect(grounded.sources.length).toBeGreaterThan(0);
    expect(grounded.sources.every((source) => source.kind === "NATIVE")).toBe(true);
    expect(grounded.sources.every((source) => source.url.startsWith("https://"))).toBe(true);
    expect(parametric.sources).toEqual([]);
  });

  it("never calls the network and honours an abort", async () => {
    const failing = vi.fn();
    vi.stubGlobal("fetch", failing);
    const controller = new AbortController();
    controller.abort();

    await run("GROUNDED", "0");
    const error = await provider
      .runQuery(input("GROUNDED", { signal: controller.signal }))
      .then(() => null)
      .catch((err: unknown) => err);

    expect(failing).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("CANCELLED");
  });
});
