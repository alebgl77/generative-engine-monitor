import type { SamplingMode } from "@prisma/client";

/**
 * Provider contract.
 *
 * The central idea: the same query is asked twice, in two modes. PARAMETRIC
 * disables every search tool and measures what the model retained from
 * training. GROUNDED turns on the provider's native web search and measures
 * what it retrieves right now. Providers declare which modes they can serve —
 * Perplexity is search-native and has no parametric mode.
 */

export interface ProviderCapabilities {
  parametric: boolean;
  grounded: boolean;
}

export interface ProviderQueryInput {
  query: string;
  mode: SamplingMode;
  apiKey: string;
  /** Injected into the system prompt so answers reflect the project's market. */
  locale: { country: string; language: string };
  /** Aborted by the worker on timeout or run cancellation. */
  signal: AbortSignal;
  /** Overrides the provider default; resolved from env/DB by the caller. */
  model?: string;
}

export type CitationSourceKind = "NATIVE" | "INLINE_MARKDOWN" | "BARE_URL";

export interface ProviderSource {
  url: string;
  title?: string;
  /**
   * NATIVE means the provider's own grounding metadata vouched for this source.
   * The text-derived kinds are weaker evidence: a link written from memory is
   * not proof the model retrieved anything.
   */
  kind: CitationSourceKind;
}

export interface ProviderResponse {
  text: string;
  /** Stored verbatim — it is the substrate that makes rescoring possible. */
  rawJson: Record<string, unknown>;
  sources: ProviderSource[];
  model: string;
  finishReason?: string;
  truncated: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface KeyValidation {
  valid: boolean;
  /** Human-readable reason, surfaced in the settings UI when invalid. */
  error?: string;
}

export interface AIProvider {
  code: string;
  label: string;
  capabilities: ProviderCapabilities;
  /** Default model id for this provider, env-overridable. */
  defaultModel(): string;
  runQuery(input: ProviderQueryInput): Promise<ProviderResponse>;
  validateKey(apiKey: string, signal?: AbortSignal): Promise<KeyValidation>;
}

/** Per-mode call budget. Grounded calls run a search loop, so they need longer. */
export const TIMEOUT_MS: Record<SamplingMode, number> = {
  PARAMETRIC: 60_000,
  GROUNDED: 180_000,
};

export function systemPrompt(locale: { country: string; language: string }): string {
  return [
    "You are a knowledgeable assistant answering a consumer or professional research question.",
    `Answer in ${locale.language} for an audience located in ${locale.country}.`,
    "Recommend and name specific brands, products, vendors or services where they are genuinely relevant.",
    "Be concrete and factual. Do not invent sources.",
  ].join(" ");
}
