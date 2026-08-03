import type { CitationSource, MentionType, Sentiment } from "@prisma/client";

/**
 * Extraction contract.
 *
 * Extraction is versioned independently of scoring: a change in how we find
 * mentions changes the evidence, and old evidence must stay reproducible. The
 * version string is persisted on every mention and citation row, and takes part
 * in their unique keys.
 */

export interface EntityToMatch {
  id: string;
  name: string;
  domain?: string | null;
  aliases: string[];
  kind: "BRAND" | "COMPETITOR";
}

/**
 * One row per occurrence, not per entity. Prominence and frequency are only
 * measurable if every occurrence carries its own position.
 */
export interface MentionOccurrence {
  entityId: string;
  entityName: string;
  kind: "BRAND" | "COMPETITOR";
  mentionType: MentionType;
  occurrenceIndex: number;
  charOffset: number;
  sentenceIndex: number;
  /** charOffset / textLength, in [0,1]. 0 = very top of the answer. */
  normalizedPosition: number;
  inFirstSentence: boolean;
  /** Rank of this entity's first appearance among ALL entities. 0 = named first. */
  orderRank: number;
  occurrencesTotal: number;
  context: string;
  confidence: number;
  sentiment?: Sentiment;
  sentimentScore?: number;
}

export interface ExtractedCitation {
  url: string;
  normalizedUrl: string;
  domain: string;
  title?: string;
  position: number;
  isBrandDomain: boolean;
  sourceKind: CitationSource;
}

export interface ExtractionResult {
  extractionVersion: string;
  mentions: MentionOccurrence[];
  citations: ExtractedCitation[];
  textLength: number;
  sentenceCount: number;
}

export interface Extractor {
  version: string;
  extract(input: {
    text: string;
    entities: EntityToMatch[];
    /** Provider-declared sources, merged with URLs found in the text. */
    providerSources: { url: string; title?: string; kind: CitationSource }[];
    brandDomains: string[];
  }): ExtractionResult;
}
