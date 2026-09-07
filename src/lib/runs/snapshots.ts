import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { EntityToMatch } from "@/lib/parsing/types";
import type { ProviderSource } from "@/lib/providers/types";
import { systemPrompt } from "@/lib/providers/types";

export const REQUEST_TEMPLATE_VERSION = "provider-request-v1";
export interface RunConfigSnapshot {
  version: 1;
  reconstructed: boolean;
  entities: EntityToMatch[];
  locale: { country: string; language: string };
  providers: { id: string; code: string; model: string; modes: string[] }[];
  requestTemplateVersion: string;
}

export function readRunSnapshot(value: Prisma.JsonValue): RunConfigSnapshot {
  const snapshot = value as unknown as RunConfigSnapshot;
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.entities)) {
    throw new Error("Run configuration snapshot missing; migrate historical rows before replay");
  }
  return snapshot;
}

/** Fingerprint of the immutable request specification, not of secrets or HTTP serialization. */
export function requestHash(input: { queryText: string; locale: { country: string; language: string }; providerCode: string; mode: string; model: string }): string {
  return createHash("sha256").update(JSON.stringify({
    template: REQUEST_TEMPLATE_VERSION, query: input.queryText,
    locale: input.locale, system: systemPrompt(input.locale), provider: input.providerCode,
    mode: input.mode, model: input.model,
  })).digest("hex");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

/** Recover native metadata only from recognized provider shapes; never invent provenance. */
export function responseSources(response: { providerSources: Prisma.JsonValue | null; rawJson: Prisma.JsonValue }, providerCode: string): ProviderSource[] {
  if (Array.isArray(response.providerSources)) {
    return response.providerSources.map((source) => {
      const row = object(source);
      if (typeof row.url !== "string" || !["NATIVE", "INLINE_MARKDOWN", "BARE_URL"].includes(String(row.kind))) {
        throw new Error("Invalid durable provider source");
      }
      return { url: row.url, ...(typeof row.title === "string" ? { title: row.title } : {}), kind: row.kind as ProviderSource["kind"] };
    });
  }
  const raw = object(response.rawJson);
  const sources: ProviderSource[] = [];
  const add = (value: unknown) => {
    const row = object(value);
    if (typeof row.url === "string" && row.url) sources.push({ url: row.url, ...(typeof row.title === "string" ? { title: row.title } : {}), kind: "NATIVE" });
  };
  if (providerCode === "openai" && Array.isArray(raw.output)) {
    for (const item of raw.output) for (const part of array(object(item).content)) {
      for (const annotation of array(object(part).annotations)) if (object(annotation).type === "url_citation") add(annotation);
    }
  } else if (providerCode === "claude" && Array.isArray(raw.content)) {
    for (const item of raw.content) {
      const block = object(item);
      for (const citation of array(block.citations)) add(citation);
      if (block.type === "web_search_tool_result") for (const result of array(block.content)) add(result);
    }
  } else if (providerCode === "gemini" && Array.isArray(raw.candidates)) {
    for (const candidate of raw.candidates) for (const chunk of array(object(object(candidate).groundingMetadata).groundingChunks)) {
      const web = object(object(chunk).web); add({ url: web.uri, title: web.title });
    }
  } else if (providerCode === "perplexity" && (Array.isArray(raw.search_results) || Array.isArray(raw.citations) || Array.isArray(raw.choices))) {
    if (array(raw.search_results).length) for (const item of array(raw.search_results)) add(item);
    else for (const url of array(raw.citations)) add({ url });
  } else if (providerCode === "mock" && Array.isArray(raw.sources)) {
    for (const url of raw.sources) add({ url });
  } else {
    throw new Error(`Legacy raw provenance unavailable for ${providerCode}; replay cannot certify missing native sources`);
  }
  return [...new Map(sources.map((source) => [source.url, source])).values()];
}
