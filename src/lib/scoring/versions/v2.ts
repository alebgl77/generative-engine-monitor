import type { MentionType, Sentiment } from "@prisma/client";
import type { MentionOccurrence } from "@/lib/parsing/types";
import type {
  SampleFeatures,
  SampleScoreResult,
  ScoreContribution,
  ScoreEvidence,
  ScoringVersion,
} from "@/lib/scoring/types";

/**
 * Scoring v2 — released. Never edited: every score already computed under "v2"
 * must stay reproducible. New behaviour goes in a new version file.
 */

type RuleId =
  | "presence"
  | "prominence"
  | "frequency"
  | "shareOfVoice"
  | "citation"
  | "sentiment"
  | "competitorLead";

/** Signed rules carry their floor, positive rules their maximum. */
const WEIGHTS: Record<RuleId, number> = {
  presence: 35,
  prominence: 15,
  frequency: 10,
  shareOfVoice: 20,
  citation: 15,
  sentiment: -10,
  competitorLead: -8,
};

const LABELS: Record<RuleId, string> = {
  presence: "Présence",
  prominence: "Proéminence",
  frequency: "Fréquence",
  shareOfVoice: "Part de voix",
  citation: "Citations de la marque",
  sentiment: "Sentiment",
  competitorLead: "Avance des concurrents",
};

/** Rules that absorb the citation budget when retrieval carries no signal. */
const REDISTRIBUTION_TARGETS: readonly RuleId[] = [
  "presence",
  "prominence",
  "frequency",
  "shareOfVoice",
];

const REDISTRIBUTION_TARGET_SET: ReadonlySet<string> = new Set(REDISTRIBUTION_TARGETS);

const REDISTRIBUTION_FACTOR =
  (REDISTRIBUTION_TARGETS.reduce((sum, id) => sum + WEIGHTS[id], 0) + WEIGHTS.citation) /
  REDISTRIBUTION_TARGETS.reduce((sum, id) => sum + WEIGHTS[id], 0);

const PRESENCE_TIER: Record<MentionType, number> = {
  EXACT: 1,
  ALIAS: 0.85,
  DOMAIN: 0.7,
  APPROXIMATE: 0.35,
};

/** Mention count at which the frequency rule saturates. */
const FREQUENCY_SATURATION = 6;
/** Brand-domain citations needed for full marks. */
const CITATION_TARGET = 2;

const SENTIMENT_POINTS: Record<Sentiment, number> = {
  POSITIVE: 5,
  NEUTRAL: 0,
  MIXED: -2,
  NEGATIVE: -10,
};

/** Ties resolve to the harsher verdict: a split opinion is not an endorsement. */
const SENTIMENT_TIE_BREAK: readonly Sentiment[] = ["NEGATIVE", "MIXED", "NEUTRAL", "POSITIVE"];

const PROMINENCE_POSITION_WEIGHT = 0.6;
const PROMINENCE_RANK_WEIGHT = 0.4;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function offsetsOf(mentions: MentionOccurrence[]): number[] {
  return mentions.map((m) => m.charOffset).sort((a, b) => a - b);
}

function makeRule(
  ruleId: RuleId,
  rawValue: number,
  evidence: ScoreEvidence,
  applicable = true
): ScoreContribution {
  const weight = WEIGHTS[ruleId];
  return {
    ruleId,
    label: LABELS[ruleId],
    weight,
    rawValue: applicable ? rawValue : 0,
    contribution: applicable ? Math.abs(weight) * rawValue : 0,
    applicable,
    redistributed: false,
    evidence,
  };
}

function majoritySentiment(mentions: MentionOccurrence[]): Sentiment | null {
  const counts = new Map<Sentiment, number>();
  for (const m of mentions) {
    if (!m.sentiment) continue;
    counts.set(m.sentiment, (counts.get(m.sentiment) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: Sentiment | null = null;
  let bestCount = -1;
  for (const candidate of SENTIMENT_TIE_BREAK) {
    const count = counts.get(candidate) ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function scoreSample(features: SampleFeatures): SampleScoreResult {
  const brandIds = new Set(features.brandIds);
  const brandMentions = features.mentions.filter((m) => brandIds.has(m.entityId));
  const competitorMentions = features.mentions.filter((m) => !brandIds.has(m.entityId));

  const brandOccurrences = brandMentions.length;
  const competitorOccurrences = competitorMentions.length;
  const brandPresent = brandOccurrences > 0;

  const competitorFirsts = new Map<string, MentionOccurrence>();
  for (const m of competitorMentions) {
    const seen = competitorFirsts.get(m.entityId);
    const earlier =
      !seen ||
      m.orderRank < seen.orderRank ||
      (m.orderRank === seen.orderRank && m.charOffset < seen.charOffset);
    if (earlier) competitorFirsts.set(m.entityId, m);
  }
  const competitorCount = competitorFirsts.size;

  const brandOrderRank = brandPresent
    ? brandMentions.reduce((min, m) => Math.min(min, m.orderRank), Number.POSITIVE_INFINITY)
    : null;

  const brandCitations = features.citations.filter((c) => c.isBrandDomain);
  const citationCount = features.citations.length;
  const brandDomainCited = brandCitations.length > 0;

  const shareOfVoice = (brandOccurrences + 1) / (brandOccurrences + competitorOccurrences + 2);

  const bestTier = brandMentions.reduce((max, m) => Math.max(max, PRESENCE_TIER[m.mentionType]), 0);
  const tierMentions = brandMentions.filter((m) => PRESENCE_TIER[m.mentionType] === bestTier);
  const presence = brandPresent
    ? makeRule("presence", bestTier, { charOffsets: offsetsOf(tierMentions) })
    : makeRule("presence", 0, { note: "Marque absente de la réponse." }, false);

  const firstBrandMention = brandMentions.reduce<MentionOccurrence | null>(
    (first, m) => (!first || m.charOffset < first.charOffset ? m : first),
    null
  );
  let prominence: ScoreContribution;
  if (firstBrandMention && brandOrderRank !== null) {
    const positionScore = 1 - clamp(firstBrandMention.normalizedPosition, 0, 1);
    const rankScore = firstBrandMention.inFirstSentence
      ? 1
      : 1 / (1 + Math.max(0, brandOrderRank));
    const raw = clamp(
      PROMINENCE_POSITION_WEIGHT * positionScore + PROMINENCE_RANK_WEIGHT * rankScore,
      0,
      1
    );
    prominence = makeRule("prominence", raw, {
      charOffsets: [firstBrandMention.charOffset],
      note: `Première mention au rang ${brandOrderRank + 1}${
        firstBrandMention.inFirstSentence ? ", dans la première phrase" : ""
      }.`,
    });
  } else {
    prominence = makeRule("prominence", 0, { note: "Marque absente de la réponse." }, false);
  }

  const frequency = brandPresent
    ? makeRule(
        "frequency",
        Math.min(1, Math.log(1 + brandOccurrences) / Math.log(FREQUENCY_SATURATION)),
        { charOffsets: offsetsOf(brandMentions) }
      )
    : makeRule("frequency", 0, { note: "Marque absente de la réponse." }, false);

  // Applies even when the brand is absent: an all-competitor answer is exactly what it measures.
  const share = makeRule("shareOfVoice", shareOfVoice, {
    charOffsets: offsetsOf(features.mentions),
    note: `${brandOccurrences} mention(s) de la marque contre ${competitorOccurrences} pour les concurrents.`,
  });

  /*
   * The citation rule needs something to have been retrieved. In PARAMETRIC mode
   * nothing is, and a GROUNDED answer with zero sources tells us about the
   * provider, not about the brand — scoring either 0/15 would make the two axes
   * incomparable. In both cases the budget is redistributed instead.
   */
  const citationApplicable =
    brandPresent && features.mode === "GROUNDED" && citationCount > 0;
  let citation: ScoreContribution;
  if (citationApplicable) {
    citation = makeRule(
      "citation",
      Math.min(1, brandCitations.length / CITATION_TARGET),
      brandDomainCited
        ? { citationIds: brandCitations.map((c) => c.normalizedUrl) }
        : {
            citationIds: features.citations.map((c) => c.normalizedUrl),
            note: `Aucune des ${citationCount} sources citées n'appartient au domaine de la marque.`,
          }
    );
  } else {
    citation = makeRule(
      "citation",
      0,
      {
        note: !brandPresent
          ? "Marque absente de la réponse."
          : features.mode === "PARAMETRIC"
            ? "Mode paramétrique : aucune source à citer."
            : "Aucune source retournée par le fournisseur.",
      },
      false
    );
  }

  const sentimentValue = brandPresent ? majoritySentiment(brandMentions) : null;
  let sentiment: ScoreContribution;
  if (sentimentValue) {
    const points = SENTIMENT_POINTS[sentimentValue];
    sentiment = makeRule("sentiment", points / Math.abs(WEIGHTS.sentiment), {
      charOffsets: offsetsOf(brandMentions.filter((m) => m.sentiment === sentimentValue)),
      note: `Sentiment majoritaire : ${sentimentValue}.`,
    });
  } else {
    sentiment = makeRule(
      "sentiment",
      0,
      {
        note: brandPresent
          ? "Sentiment non évalué sur cet échantillon."
          : "Marque absente de la réponse.",
      },
      false
    );
  }

  const effectiveBrandRank = brandOrderRank ?? Number.POSITIVE_INFINITY;
  const leaders = Array.from(competitorFirsts.values()).filter(
    (m) => m.orderRank < effectiveBrandRank
  );
  const leadRatio = competitorCount > 0 ? leaders.length / competitorCount : 0;
  const competitorLead = makeRule("competitorLead", -leadRatio, {
    charOffsets: offsetsOf(leaders),
    note:
      competitorCount === 0
        ? "Aucun concurrent mentionné."
        : `${leaders.length} concurrent(s) sur ${competitorCount} cité(s) avant la marque.`,
  });

  const contributions: ScoreContribution[] = [
    presence,
    prominence,
    frequency,
    share,
    citation,
    sentiment,
    competitorLead,
  ];

  if (brandPresent && !citationApplicable) {
    for (const c of contributions) {
      if (!REDISTRIBUTION_TARGET_SET.has(c.ruleId)) continue;
      c.contribution *= REDISTRIBUTION_FACTOR;
      c.redistributed = true;
    }
  }

  const total = contributions.reduce((sum, c) => sum + c.contribution, 0);

  return {
    score: clamp(total, 0, 100),
    brandPresent,
    brandOrderRank,
    brandOccurrences,
    competitorCount,
    citationCount,
    brandDomainCited,
    shareOfVoice,
    contributions,
  };
}

export const v2: ScoringVersion = {
  version: "v2",
  extractionVersion: "v2",
  scoreSample,
};
