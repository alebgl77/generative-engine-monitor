import type { Extractor } from "@/lib/parsing/types";
import { extractorV2 } from "@/lib/parsing/extract/v2";
import { extractorV3 } from "@/lib/parsing/extract/v3";

/** A released version is immutable: new matching behaviour gets a new entry, never an edit. */
const EXTRACTORS: Record<string, Extractor> = {
  v2: extractorV2,
  v3: extractorV3,
};

export const CURRENT_EXTRACTION_VERSION = "v3";

export function getExtractor(version: string): Extractor {
  const extractor = EXTRACTORS[version];
  if (!extractor) {
    throw new Error(`Version d'extraction inconnue: ${version}`);
  }
  return extractor;
}
