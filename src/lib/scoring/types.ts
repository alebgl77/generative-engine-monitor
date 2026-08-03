import type { SamplingMode } from "@prisma/client";
import type { ExtractedCitation, MentionOccurrence } from "@/lib/parsing/types";

/**
 * Scoring contract.
 *
 * Two rules govern this layer:
 *
 * 1. Every score is explainable. `scoreSample` returns the signed contribution
 *    of each rule together with the evidence that triggered it, and that
 *    breakdown is persisted, not recomputed for display.
 * 2. Every released version is immutable. `versions/v2.ts` is never edited once
 *    scores exist under it; new behaviour goes in a new file. That is the only
 *    versioning guarantee that survives future refactors of shared helpers.
 */

export interface ScoreEvidence {
  mentionIds?: string[];
  citationIds?: string[];
  charOffsets?: number[];
  note?: string;
}

export interface ScoreContribution {
  ruleId: string;
  label: string;
  /** Maximum points this rule can award (or the floor, if negative). */
  weight: number;
  /** Normalised rule output, [0,1] — or [-1,1] for signed modifiers. */
  rawValue: number;
  /** Signed points actually added to the score. */
  contribution: number;
  /**
   * False when the rule cannot apply in this context — notably `citation` in
   * PARAMETRIC mode, where there is nothing to retrieve.
   */
  applicable: boolean;
  /** True when this rule absorbed points redistributed from an inapplicable one. */
  redistributed: boolean;
  evidence: ScoreEvidence;
}

/** Everything a scoring version needs, decoupled from Prisma rows. */
export interface SampleFeatures {
  mode: SamplingMode;
  brandIds: string[];
  mentions: MentionOccurrence[];
  citations: ExtractedCitation[];
  textLength: number;
}

export interface SampleScoreResult {
  score: number;
  brandPresent: boolean;
  brandOrderRank: number | null;
  brandOccurrences: number;
  competitorCount: number;
  citationCount: number;
  brandDomainCited: boolean;
  shareOfVoice: number;
  contributions: ScoreContribution[];
}

/** Distribution summary. Never a bare point estimate — see stats.ts. */
export interface Aggregate {
  n: number;
  median: number;
  mean: number;
  ciLow: number;
  ciHigh: number;
  mad: number;
  iqr: number;
  /** 0..1. Derived from MAD, so one outlier sample cannot collapse it. */
  stability: number;
  /** True when n is too small for the interval to be a claim rather than a hint. */
  lowN: boolean;
  bootstrapSeed: string;
}

export interface ScoringVersion {
  version: string;
  /** Extraction version this scoring version expects to read. */
  extractionVersion: string;
  scoreSample(features: SampleFeatures): SampleScoreResult;
  /**
   * How this version turns a sample's dispersion into the 0..1 agreement
   * indicator. Optional: a version that omits it keeps the estimator the
   * statistics layer defaults to, which is what makes older scores replay
   * unchanged.
   */
  stability?(xs: number[]): number;
}

/** Below this many samples, a task-level interval is directional only. */
export const LOW_N_TASK = 5;
/** Below this many samples, a run-level interval is directional only. */
export const LOW_N_RUN = 30;
