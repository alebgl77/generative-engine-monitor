import type { SamplingMode } from "@prisma/client";
import { AIProvider } from "./types";
import { OpenAIProvider } from "./openai";
import { PerplexityProvider } from "./perplexity";
import { ClaudeProvider } from "./claude";
import { GeminiProvider } from "./gemini";
import { MockProvider } from "./mock";

const providers: Record<string, AIProvider> = {
  openai: new OpenAIProvider(),
  perplexity: new PerplexityProvider(),
  claude: new ClaudeProvider(),
  gemini: new GeminiProvider(),
  mock: new MockProvider(),
};

export function getProvider(code: string): AIProvider | undefined {
  return providers[code];
}

export function getAllProviders(): AIProvider[] {
  return Object.values(providers);
}

/** Run planning uses this to skip cells a provider cannot serve at all. */
export function supportsMode(provider: AIProvider, mode: SamplingMode): boolean {
  if (mode === "PARAMETRIC") return provider.capabilities.parametric;
  return provider.capabilities.grounded;
}
