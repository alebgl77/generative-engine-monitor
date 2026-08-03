import { modelFor } from "@/lib/env";
import { ProviderError } from "@/lib/errors";
import { extractTextUrls, providerFetch } from "./http";
import {
  AIProvider,
  KeyValidation,
  ProviderCapabilities,
  ProviderQueryInput,
  ProviderResponse,
  ProviderSource,
  TIMEOUT_MS,
  systemPrompt,
} from "./types";

const CODE = "perplexity";
const ENDPOINT = "https://api.perplexity.ai/chat/completions";
const VALIDATE_TIMEOUT_MS = 15_000;

interface PerplexityChoice {
  message?: { role?: string; content?: string };
  finish_reason?: string;
}

interface PerplexitySearchResult {
  title?: string;
  url?: string;
  date?: string | null;
}

interface PerplexityResponse {
  choices?: PerplexityChoice[];
  search_results?: PerplexitySearchResult[];
  citations?: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class PerplexityProvider implements AIProvider {
  code = CODE;
  label = "Perplexity";
  capabilities: ProviderCapabilities = { parametric: false, grounded: true };

  defaultModel(): string {
    return modelFor(CODE);
  }

  async runQuery(input: ProviderQueryInput): Promise<ProviderResponse> {
    if (input.mode === "PARAMETRIC") {
      throw new ProviderError(
        "UNSUPPORTED_MODE",
        CODE,
        "Perplexity interroge toujours le web : le mode paramétrique n'a pas de sens pour ce moteur"
      );
    }

    const model = input.model ?? this.defaultModel();

    const data = await providerFetch<PerplexityResponse>({
      providerCode: CODE,
      url: ENDPOINT,
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: {
        model,
        messages: [
          { role: "system", content: systemPrompt(input.locale) },
          { role: "user", content: input.query },
        ],
        temperature: 0.7,
        max_tokens: 1500,
      },
      signal: input.signal,
      timeoutMs: TIMEOUT_MS[input.mode],
    });

    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    const finishReason = choice?.finish_reason;

    return {
      text,
      rawJson: data as unknown as Record<string, unknown>,
      sources: mergeSources(nativeSources(data), text),
      model,
      finishReason,
      truncated: finishReason === "length",
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
    };
  }

  async validateKey(apiKey: string, signal?: AbortSignal): Promise<KeyValidation> {
    try {
      await providerFetch<unknown>({
        providerCode: CODE,
        url: ENDPOINT,
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: {
          model: this.defaultModel(),
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        },
        signal: signal ?? new AbortController().signal,
        timeoutMs: VALIDATE_TIMEOUT_MS,
      });
      return { valid: true };
    } catch (err) {
      return {
        valid: false,
        error:
          err instanceof ProviderError ? err.message : "Vérification de la clé Perplexity impossible",
      };
    }
  }
}

/** `citations` is the vendor's deprecated shape and only fills the gap when
 * `search_results` is missing — it carries URLs without titles. */
function nativeSources(data: PerplexityResponse): ProviderSource[] {
  const fromSearch: ProviderSource[] = [];
  for (const result of data.search_results ?? []) {
    if (typeof result.url !== "string" || result.url.length === 0) continue;
    fromSearch.push({ url: result.url, title: result.title || undefined, kind: "NATIVE" });
  }
  if (fromSearch.length > 0) return fromSearch;

  const fromLegacy: ProviderSource[] = [];
  for (const url of data.citations ?? []) {
    if (typeof url !== "string" || url.length === 0) continue;
    fromLegacy.push({ url, kind: "NATIVE" });
  }
  return fromLegacy;
}

/** Native citations outrank anything merely written in the answer. */
function mergeSources(native: ProviderSource[], text: string): ProviderSource[] {
  const merged: ProviderSource[] = [];
  const seen = new Set<string>();

  for (const source of native) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    merged.push(source);
  }
  for (const source of extractTextUrls(text)) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    merged.push(source);
  }

  return merged;
}
