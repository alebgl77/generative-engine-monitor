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

const CODE = "gemini";
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const VALIDATE_TIMEOUT_MS = 15_000;

interface GeminiPart {
  text?: string;
}

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
  groundingMetadata?: { groundingChunks?: GeminiGroundingChunk[] };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GeminiProvider implements AIProvider {
  code = CODE;
  label = "Google Gemini";
  capabilities: ProviderCapabilities = { parametric: true, grounded: true };

  defaultModel(): string {
    return modelFor(CODE);
  }

  async runQuery(input: ProviderQueryInput): Promise<ProviderResponse> {
    const model = input.model ?? this.defaultModel();

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: systemPrompt(input.locale) }] },
      contents: [{ role: "user", parts: [{ text: input.query }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1500 },
    };
    if (input.mode === "GROUNDED") {
      body.tools = [{ googleSearch: {} }];
    }

    const data = await providerFetch<GeminiResponse>({
      providerCode: CODE,
      url: `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`,
      method: "POST",
      // Header auth only: a key placed in the query string leaks into proxy,
      // CDN and access logs.
      headers: { "x-goog-api-key": input.apiKey },
      body,
      signal: input.signal,
      timeoutMs: TIMEOUT_MS[input.mode],
      notFoundMeans: "model",
    });

    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? "").join("");
    const finishReason = candidate?.finishReason;

    const native: ProviderSource[] = [];
    for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
      const uri = chunk.web?.uri;
      if (typeof uri !== "string" || uri.length === 0) continue;
      native.push({ url: uri, title: chunk.web?.title || undefined, kind: "NATIVE" });
    }

    return {
      text,
      rawJson: data as unknown as Record<string, unknown>,
      sources: mergeSources(native, text),
      model,
      finishReason,
      truncated: finishReason === "MAX_TOKENS",
      usage: data.usageMetadata
        ? {
            inputTokens: data.usageMetadata.promptTokenCount,
            outputTokens: data.usageMetadata.candidatesTokenCount,
          }
        : undefined,
    };
  }

  async validateKey(apiKey: string, signal?: AbortSignal): Promise<KeyValidation> {
    try {
      await providerFetch<unknown>({
        providerCode: CODE,
        url: `${API_ROOT}/models`,
        method: "GET",
        headers: { "x-goog-api-key": apiKey },
        signal: signal ?? new AbortController().signal,
        timeoutMs: VALIDATE_TIMEOUT_MS,
      });
      return { valid: true };
    } catch (err) {
      return {
        valid: false,
        error:
          err instanceof ProviderError ? err.message : "Vérification de la clé Gemini impossible",
      };
    }
  }
}

/** Native grounding metadata outranks anything merely written in the answer. */
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
