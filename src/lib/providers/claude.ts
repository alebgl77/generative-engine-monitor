import type { SamplingMode } from "@prisma/client";

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

const PROVIDER_CODE = "claude";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1500;
const WEB_SEARCH_TOOL = { type: "web_search_20260318", name: "web_search", max_uses: 5 };
/** Key validation is interactive: a settings form must not hang on a full call budget. */
const VALIDATE_TIMEOUT_MS = 15_000;

interface ClaudeCitation {
  type?: string;
  url?: string;
  title?: string;
}

interface ClaudeSearchResult {
  url?: string;
  title?: string;
}

interface ClaudeBlock {
  type?: string;
  text?: string;
  citations?: ClaudeCitation[] | null;
  content?: ClaudeSearchResult[] | unknown;
}

interface ClaudePayload {
  content?: ClaudeBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  [key: string]: unknown;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function headers(apiKey: string): Record<string, string> {
  return { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
}

export class ClaudeProvider implements AIProvider {
  readonly code = PROVIDER_CODE;
  readonly label = "Anthropic Claude";
  readonly capabilities: ProviderCapabilities = { parametric: true, grounded: true };

  defaultModel(): string {
    return modelFor(PROVIDER_CODE);
  }

  async runQuery(input: ProviderQueryInput): Promise<ProviderResponse> {
    this.assertMode(input.mode);

    const model = input.model ?? this.defaultModel();

    // No `temperature`: recent Claude models reject any non-default value with a 400.
    const body: Record<string, unknown> = {
      model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(input.locale),
      messages: [{ role: "user", content: input.query }],
    };
    if (input.mode === "GROUNDED") {
      body.tools = [WEB_SEARCH_TOOL];
    }

    const payload = await providerFetch<ClaudePayload>({
      providerCode: this.code,
      url: MESSAGES_URL,
      method: "POST",
      headers: headers(input.apiKey),
      body,
      signal: input.signal,
      timeoutMs: TIMEOUT_MS[input.mode],
      notFoundMeans: "model",
    });

    const data: ClaudePayload = payload && typeof payload === "object" ? payload : {};

    const parts: string[] = [];
    const native: ProviderSource[] = [];
    const seen = new Set<string>();

    const push = (url: unknown, title: unknown): void => {
      if (typeof url !== "string" || !url || seen.has(url)) return;
      seen.add(url);
      native.push({
        url,
        title: typeof title === "string" && title ? title : undefined,
        kind: "NATIVE",
      });
    };

    for (const block of asArray<ClaudeBlock>(data.content)) {
      if (!block) continue;
      if (block.type === "text") {
        if (typeof block.text === "string") parts.push(block.text);
        for (const citation of asArray<ClaudeCitation>(block.citations)) {
          if (!citation || citation.type !== "web_search_result_location") continue;
          push(citation.url, citation.title);
        }
        continue;
      }
      if (block.type === "web_search_tool_result") {
        for (const result of asArray<ClaudeSearchResult>(block.content)) {
          if (!result) continue;
          push(result.url, result.title);
        }
      }
    }

    const text = parts.join("");
    const sources: ProviderSource[] = [...native];
    for (const found of extractTextUrls(text)) {
      if (seen.has(found.url)) continue;
      seen.add(found.url);
      sources.push({ url: found.url, title: found.title, kind: found.kind });
    }

    const finishReason = typeof data.stop_reason === "string" ? data.stop_reason : undefined;
    const inputTokens = numberOrUndefined(data.usage?.input_tokens);
    const outputTokens = numberOrUndefined(data.usage?.output_tokens);

    return {
      text,
      rawJson: data as Record<string, unknown>,
      sources,
      model,
      finishReason,
      truncated: finishReason === "max_tokens",
      usage:
        inputTokens === undefined && outputTokens === undefined
          ? undefined
          : { inputTokens, outputTokens },
    };
  }

  async validateKey(apiKey: string, signal?: AbortSignal): Promise<KeyValidation> {
    try {
      // Anthropic exposes no cheap models-list endpoint, so the probe is a
      // one-token completion against the configured model.
      await providerFetch<unknown>({
        providerCode: this.code,
        url: MESSAGES_URL,
        method: "POST",
        headers: headers(apiKey),
        body: {
          model: this.defaultModel(),
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        },
        signal: signal ?? new AbortController().signal,
        timeoutMs: VALIDATE_TIMEOUT_MS,
        notFoundMeans: "model",
      });
      return { valid: true };
    } catch (err) {
      if (err instanceof ProviderError) {
        return {
          valid: false,
          error: err.code === "AUTH" ? "Clé API refusée" : "Vérification impossible pour le moment",
        };
      }
      return { valid: false, error: "Vérification impossible pour le moment" };
    }
  }

  private assertMode(mode: SamplingMode): void {
    const supported = mode === "GROUNDED" ? this.capabilities.grounded : this.capabilities.parametric;
    if (!supported) {
      throw new ProviderError(
        "UNSUPPORTED_MODE",
        this.code,
        `Mode ${mode} non supporté par ${this.label}`
      );
    }
  }
}
