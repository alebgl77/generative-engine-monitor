import type { CitationSource, MentionType } from "@prisma/client";
import type {
  EntityToMatch,
  ExtractedCitation,
  ExtractionResult,
  Extractor,
  MentionOccurrence,
} from "@/lib/parsing/types";
import { normalizeUrl, sameDomain } from "@/lib/parsing/url";
import { extractTextUrls } from "@/lib/providers/http";

/**
 * Extraction v3.
 *
 * Mentions are resolved once across every tracked entity rather than entity by
 * entity: a textual span belongs to a single entity, and a fuzzy match never
 * survives on a span another entity spells out.
 *
 * Released and therefore frozen: mentions stored under "v3" must stay
 * reproducible, so any change of behaviour ships as a new version file.
 */

const CONTEXT_RADIUS = 100;
/** Below this, a split is assumed to come from an abbreviation ("M. Dupont"). */
const MIN_SENTENCE_CHARS = 10;
/** Fuzzy matching on short names produces more noise than signal. */
const MIN_APPROXIMATE_LENGTH = 5;

const CONFIDENCE: Record<MentionType, number> = {
  EXACT: 1.0,
  ALIAS: 0.9,
  DOMAIN: 0.8,
  APPROXIMATE: 0.4,
};

const MENTION_PRIORITY: Record<MentionType, number> = {
  EXACT: 0,
  ALIAS: 1,
  DOMAIN: 2,
  APPROXIMATE: 3,
};

/** A source the provider vouched for outranks a link the model typed. */
const CITATION_PRIORITY: Record<CitationSource, number> = {
  NATIVE: 0,
  INLINE_MARKDOWN: 1,
  BARE_URL: 2,
};

/**
 * Regexes are built through the constructor rather than as literals so that the
 * `u` flag, the lookbehinds and the property escapes stay independent of the
 * compilation target.
 */
const COMBINING_MARKS = new RegExp("\\p{M}", "gu");
const WORD_TOKEN_SOURCE = "[\\p{L}\\p{N}]+";
const SENTENCE_BREAK_SOURCE = "(?<=[.!?…])\\s+";

interface FoldedText {
  text: string;
  /** offsets[i] = index in the ORIGINAL string of the character folded at i. */
  offsets: number[];
}

/**
 * Diacritic- and case-insensitive copy of the text, kept aligned with the
 * original: offsets reported to the UI must index the answer as the provider
 * returned it, not a normalised rewrite of it.
 */
function foldText(source: string): FoldedText {
  let text = "";
  const offsets: number[] = [];

  for (let index = 0; index < source.length; ) {
    const codePoint = source.codePointAt(index);
    const char = codePoint === undefined ? source.charAt(index) : String.fromCodePoint(codePoint);
    const folded = char.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
    for (let i = 0; i < folded.length; i += 1) offsets.push(index);
    text += folded;
    index += char.length;
  }

  return { text, offsets };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Unicode-aware word boundary: `\b` is ASCII-only, so it splits "café" and
 * refuses names carrying punctuation such as "C#", ".NET" or "Node.js".
 */
function boundedPattern(needle: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(needle)}(?![\\p{L}\\p{N}])`, "gu");
}

interface Candidate {
  type: MentionType;
  start: number;
  end: number;
}

/** A candidate carrying the entity that produced it, for cross-entity arbitration. */
interface EntityCandidate extends Candidate {
  entityIndex: number;
  entityId: string;
}

function originalOffset(folded: FoldedText, foldedIndex: number, originalLength: number): number {
  return foldedIndex < folded.offsets.length ? folded.offsets[foldedIndex] : originalLength;
}

function matchNeedle(
  folded: FoldedText,
  originalLength: number,
  needle: string,
  type: MentionType
): Candidate[] {
  const results: Candidate[] = [];
  const foldedNeedle = foldText(needle.trim()).text;
  if (!foldedNeedle) return results;

  const pattern = boundedPattern(foldedNeedle);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(folded.text)) !== null) {
    results.push({
      type,
      start: originalOffset(folded, match.index, originalLength),
      end: originalOffset(folded, match.index + match[0].length, originalLength),
    });
  }
  return results;
}

function domainNeedle(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.+$/, "");
}

/** Bounded Levenshtein: returns as soon as a second edit would be required. */
function withinEditDistanceOne(a: string, b: string): boolean {
  if (a === b) return true;

  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (long.length - short.length > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short.charAt(i) === long.charAt(j)) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (short.length === long.length) i += 1;
    j += 1;
  }

  return edits + (short.length - i) + (long.length - j) <= 1;
}

/**
 * Fuzzy matching works on whole tokens, never on substrings: a substring rule
 * makes a short brand match inside unrelated words.
 */
function approximateCandidates(
  folded: FoldedText,
  originalLength: number,
  foldedName: string
): Candidate[] {
  const results: Candidate[] = [];
  if (foldedName.length < MIN_APPROXIMATE_LENGTH) return results;

  const pattern = new RegExp(WORD_TOKEN_SOURCE, "gu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(folded.text)) !== null) {
    const token = match[0];
    if (Math.abs(token.length - foldedName.length) > 1) continue;
    if (!withinEditDistanceOne(token, foldedName)) continue;
    results.push({
      type: "APPROXIMATE",
      start: originalOffset(folded, match.index, originalLength),
      end: originalOffset(folded, match.index + token.length, originalLength),
    });
  }
  return results;
}

function entityCandidates(
  entity: EntityToMatch,
  folded: FoldedText,
  originalLength: number
): Candidate[] {
  const candidates: Candidate[] = [];
  candidates.push(...matchNeedle(folded, originalLength, entity.name, "EXACT"));

  for (const alias of entity.aliases) {
    candidates.push(...matchNeedle(folded, originalLength, alias, "ALIAS"));
  }

  if (entity.domain) {
    const needle = domainNeedle(entity.domain);
    if (needle) candidates.push(...matchNeedle(folded, originalLength, needle, "DOMAIN"));
  }

  candidates.push(
    ...approximateCandidates(folded, originalLength, foldText(entity.name.trim()).text)
  );

  return candidates;
}

function overlaps(a: Candidate, b: Candidate): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Arbitrates every span of the answer between every entity at once.
 *
 * Two rules: a token that another entity spells out under its own name, alias or
 * domain is that entity's mention and not a misspelling of a second one, and a
 * span that several entities claim is credited once, to the strongest match.
 */
function resolveCandidates(candidates: EntityCandidate[]): EntityCandidate[] {
  const spelledOut = candidates.filter((candidate) => candidate.type !== "APPROXIMATE");
  const eligible = candidates.filter(
    (candidate) =>
      candidate.type !== "APPROXIMATE" ||
      !spelledOut.some((anchor) => overlaps(candidate, anchor))
  );

  const ranked = [...eligible].sort(
    (a, b) =>
      MENTION_PRIORITY[a.type] - MENTION_PRIORITY[b.type] ||
      b.end - b.start - (a.end - a.start) ||
      a.entityId.localeCompare(b.entityId) ||
      a.start - b.start
  );

  const accepted: EntityCandidate[] = [];
  for (const candidate of ranked) {
    if (accepted.some((kept) => overlaps(candidate, kept))) continue;
    accepted.push(candidate);
  }
  return accepted;
}

function sentenceStarts(text: string): number[] {
  const starts = [0];
  const pattern = new RegExp(SENTENCE_BREAK_SOURCE, "gu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const nextStart = match.index + match[0].length;
    if (nextStart >= text.length) break;
    if (match.index - starts[starts.length - 1] < MIN_SENTENCE_CHARS) continue;
    starts.push(nextStart);
  }
  return starts;
}

function sentenceIndexAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function buildContext(text: string, start: number, end: number): string {
  const from = Math.max(0, start - CONTEXT_RADIUS);
  const to = Math.min(text.length, end + CONTEXT_RADIUS);
  let snippet = text.slice(from, to).replace(/\s+/g, " ").trim();
  if (from > 0) snippet = `…${snippet}`;
  if (to < text.length) snippet = `${snippet}…`;
  return snippet;
}

function buildMentions(
  text: string,
  entities: EntityToMatch[],
  starts: number[]
): MentionOccurrence[] {
  const folded = foldText(text);
  const candidates: EntityCandidate[] = [];

  entities.forEach((entity, entityIndex) => {
    for (const candidate of entityCandidates(entity, folded, text.length)) {
      candidates.push({ ...candidate, entityIndex, entityId: entity.id });
    }
  });

  const byEntity = new Map<number, Candidate[]>();
  for (const candidate of resolveCandidates(candidates)) {
    const kept = byEntity.get(candidate.entityIndex);
    if (kept) kept.push(candidate);
    else byEntity.set(candidate.entityIndex, [candidate]);
  }

  const found: { entity: EntityToMatch; inputIndex: number; occurrences: Candidate[] }[] = [];
  entities.forEach((entity, inputIndex) => {
    const occurrences = byEntity.get(inputIndex);
    if (!occurrences || occurrences.length === 0) return;
    occurrences.sort((a, b) => a.start - b.start);
    found.push({ entity, inputIndex, occurrences });
  });

  const ranked = found
    .slice()
    .sort(
      (a, b) => a.occurrences[0].start - b.occurrences[0].start || a.inputIndex - b.inputIndex
    );
  const rankByEntity = new Map<string, number>();
  ranked.forEach((item, rank) => rankByEntity.set(item.entity.id, rank));

  const mentions: MentionOccurrence[] = [];
  for (const item of found) {
    item.occurrences.forEach((occurrence, occurrenceIndex) => {
      const sentenceIndex = sentenceIndexAt(starts, occurrence.start);
      mentions.push({
        entityId: item.entity.id,
        entityName: item.entity.name,
        kind: item.entity.kind,
        mentionType: occurrence.type,
        occurrenceIndex,
        charOffset: occurrence.start,
        sentenceIndex,
        normalizedPosition: text.length > 0 ? occurrence.start / text.length : 0,
        inFirstSentence: sentenceIndex === 0,
        orderRank: rankByEntity.get(item.entity.id) ?? 0,
        occurrencesTotal: item.occurrences.length,
        context: buildContext(text, occurrence.start, occurrence.end),
        confidence: CONFIDENCE[occurrence.type],
      });
    });
  }

  mentions.sort(
    (a, b) =>
      a.charOffset - b.charOffset ||
      a.orderRank - b.orderRank ||
      a.entityId.localeCompare(b.entityId)
  );
  return mentions;
}

function buildCitations(
  text: string,
  providerSources: { url: string; title?: string; kind: CitationSource }[],
  brandDomains: string[]
): ExtractedCitation[] {
  const merged: { url: string; title?: string; kind: CitationSource }[] = [
    ...providerSources,
    ...extractTextUrls(text),
  ];

  const byUrl = new Map<string, ExtractedCitation>();
  const order: string[] = [];

  for (const source of merged) {
    const normalized = normalizeUrl(source.url);
    if (!normalized) continue;

    const existing = byUrl.get(normalized.normalized);
    if (!existing) {
      order.push(normalized.normalized);
      byUrl.set(normalized.normalized, {
        url: source.url,
        normalizedUrl: normalized.normalized,
        domain: normalized.domain,
        title: source.title,
        position: 0,
        isBrandDomain: brandDomains.some((brandDomain) =>
          sameDomain(normalized.domain, brandDomain)
        ),
        sourceKind: source.kind,
      });
      continue;
    }

    if (CITATION_PRIORITY[source.kind] < CITATION_PRIORITY[existing.sourceKind]) {
      existing.sourceKind = source.kind;
      existing.url = source.url;
      if (source.title) existing.title = source.title;
    } else if (!existing.title && source.title) {
      existing.title = source.title;
    }
  }

  const citations: ExtractedCitation[] = [];
  order.forEach((key, index) => {
    const citation = byUrl.get(key);
    if (!citation) return;
    citation.position = index + 1;
    citations.push(citation);
  });
  return citations;
}

export const extractorV3: Extractor = {
  version: "v3",

  extract(input): ExtractionResult {
    const text = input.text ?? "";
    const starts = sentenceStarts(text);

    return {
      extractionVersion: "v3",
      mentions: buildMentions(text, input.entities, starts),
      citations: buildCitations(text, input.providerSources, input.brandDomains),
      textLength: text.length,
      sentenceCount: text.length === 0 ? 0 : starts.length,
    };
  },
};
