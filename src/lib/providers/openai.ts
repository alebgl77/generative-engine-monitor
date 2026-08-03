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

const PROVIDER_CODE = "openai";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODELS_URL = "https://api.openai.com/v1/models";
const MAX_OUTPUT_TOKENS = 1500;
/** Key validation is interactive: a settings form must not hang on a full call budget. */
const VALIDATE_TIMEOUT_MS = 15_000;

const TRUNCATION_MARKERS = ["max_output_tokens", "max_tokens", "length", "incomplete"];

interface ResponsesAnnotation {
  type?: string;
  url?: string;
  title?: string;
}

interface ResponsesContentPart {
  type?: string;
  text?: string;
  annotations?: ResponsesAnnotation[];
}

interface ResponsesOutputItem {
  type?: string;
  status?: string;
  content?: ResponsesContentPart[];
}

interface ResponsesPayload {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
  [key: string]: unknown;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function indicatesTruncation(...reasons: (string | undefined)[]): boolean {
  return reasons.some((reason) => {
    if (!reason) return false;
    const normalized = reason.toLowerCase();
    return TRUNCATION_MARKERS.some((marker) => normalized.includes(marker));
  });
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class OpenAIProvider implements AIProvider {
  readonly code = PROVIDER_CODE;
  readonly label = "OpenAI ChatGPT";
  readonly capabilities: ProviderCapabilities = { parametric: true, grounded: true };

  defaultModel(): string {
    return modelFor(PROVIDER_CODE);
  }

  async runQuery(input: ProviderQueryInput): Promise<ProviderResponse> {
    this.assertMode(input.mode);

    const model = input.model ?? this.defaultModel();

    const body: Record<string, unknown> = {
      model,
      input: [
        { role: "system", content: systemPrompt(input.locale) },
        { role: "user", content: input.query },
      ],
      max_output_tokens: MAX_OUTPUT_TOKENS,
    };
    if (input.mode === "GROUNDED") {
      body.tools = [{ type: "web_search" }];
    }

    const payload = await providerFetch<ResponsesPayload>({
      providerCode: this.code,
      url: RESPONSES_URL,
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body,
      signal: input.signal,
      timeoutMs: TIMEOUT_MS[input.mode],
      notFoundMeans: "model",
    });

    const data: ResponsesPayload = payload && typeof payload === "object" ? payload : {};

    const parts: string[] = [];
    const native: ProviderSource[] = [];
    const seen = new Set<string>();
    let messageStatus: string | undefined;

    for (const item of asArray<ResponsesOutputItem>(data.output)) {
      if (!item || item.type !== "message") continue;
      if (messageStatus === undefined && typeof item.status === "string") {
        messageStatus = item.status;
      }
      for (const part of asArray<ResponsesContentPart>(item.content)) {
        if (!part || part.type !== "output_text") continue;
        if (typeof part.text === "string") parts.push(part.text);
        for (const annotation of asArray<ResponsesAnnotation>(part.annotations)) {
          if (!annotation || annotation.type !== "url_citation") continue;
          const url = typeof annotation.url === "string" ? annotation.url : "";
          if (!url || seen.has(url)) continue;
          seen.add(url);
          native.push({
            url,
            title: typeof annotation.title === "string" && annotation.title ? annotation.title : undefined,
            kind: "NATIVE",
          });
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

    const finishReason =
      messageStatus ?? (typeof data.status === "string" ? data.status : undefined);
    const inputTokens = numberOrUndefined(data.usage?.input_tokens);
    const outputTokens = numberOrUndefined(data.usage?.output_tokens);

    return {
      text,
      rawJson: data as Record<string, unknown>,
      sources,
      model,
      finishReason,
      truncated: indicatesTruncation(finishReason, data.incomplete_details?.reason),
      usage:
        inputTokens === undefined && outputTokens === undefined
          ? undefined
          : { inputTokens, outputTokens },
    };
  }

  async validateKey(apiKey: string, signal?: AbortSignal): Promise<KeyValidation> {
    try {
      await providerFetch<unknown>({
        providerCode: this.code,
        url: MODELS_URL,
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: signal ?? new AbortController().signal,
        timeoutMs: VALIDATE_TIMEOUT_MS,
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
