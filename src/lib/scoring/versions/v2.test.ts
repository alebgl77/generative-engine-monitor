import type { SamplingMode } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { ExtractedCitation, MentionOccurrence } from "@/lib/parsing/types";
import type { SampleFeatures, SampleScoreResult } from "@/lib/scoring/types";
import { v2 } from "@/lib/scoring/versions/v2";

const BRAND = "brand";

function mention(
  partial: Partial<MentionOccurrence> & { entityId: string }
): MentionOccurrence {
  return {
    entityName: partial.entityId,
    kind: partial.entityId === BRAND ? "BRAND" : "COMPETITOR",
    mentionType: "EXACT",
    occurrenceIndex: 0,
    charOffset: 0,
    sentenceIndex: 0,
    normalizedPosition: 0,
    inFirstSentence: true,
    orderRank: 0,
    occurrencesTotal: 1,
    context: "",
    confidence: 1,
    ...partial,
  };
}

function citation(partial: Partial<ExtractedCitation> & { normalizedUrl: string }): ExtractedCitation {
  return {
    url: `https://${partial.normalizedUrl}`,
    domain: partial.normalizedUrl.split("/")[0],
    position: 1,
    isBrandDomain: false,
    sourceKind: "NATIVE",
    ...partial,
  };
}

function features(partial: Partial<SampleFeatures> = {}): SampleFeatures {
  return {
    mode: "PARAMETRIC",
    brandIds: [BRAND],
    mentions: [],
    citations: [],
    textLength: 600,
    ...partial,
  };
}

/** N brand occurrences sharing one first mention at the very top of the answer. */
function brandMentions(count: number): MentionOccurrence[] {
  return Array.from({ length: count }, (_, index) =>
    mention({
      entityId: BRAND,
      occurrenceIndex: index,
      occurrencesTotal: count,
      charOffset: index * 40,
      normalizedPosition: (index * 40) / 600,
      inFirstSentence: index === 0,
      sentenceIndex: index,
    })
  );
}

function competitorMentions(count: number, options: { leads?: boolean } = {}): MentionOccurrence[] {
  return Array.from({ length: count }, (_, index) =>
    mention({
      entityId: `competitor-${index}`,
      orderRank: options.leads ? 0 : index + 1,
      occurrenceIndex: 0,
      occurrencesTotal: 1,
      charOffset: 300 + index * 10,
      normalizedPosition: (300 + index * 10) / 600,
      inFirstSentence: false,
      sentenceIndex: 4,
    })
  );
}

function rule(result: SampleScoreResult, ruleId: string) {
  const found = result.contributions.find((c) => c.ruleId === ruleId);
  if (!found) throw new Error(`missing rule ${ruleId}`);
  return found;
}

function total(result: SampleScoreResult): number {
  return result.contributions.reduce((sum, c) => sum + c.contribution, 0);
}

describe("v2 identity", () => {
  it("declares the extraction version it reads", () => {
    expect(v2.version).toBe("v2");
    expect(v2.extractionVersion).toBe("v2");
  });

  it("returns one contribution per rule, each labelled", () => {
    const result = v2.scoreSample(features({ mentions: brandMentions(1) }));
    expect(result.contributions.map((c) => c.ruleId)).toEqual([
      "presence",
      "prominence",
      "frequency",
      "shareOfVoice",
      "citation",
      "sentiment",
      "competitorLead",
    ]);
    for (const contribution of result.contributions) {
      expect(contribution.label).not.toBe("");
      expect(Number.isFinite(contribution.contribution)).toBe(true);
    }
  });
});

describe("contributions sum to the score", () => {
  it("holds on a plain parametric sample", () => {
    const result = v2.scoreSample(features({ mentions: brandMentions(2) }));
    expect(total(result)).toBeCloseTo(result.score, 10);
  });

  it("holds on a grounded sample with citations", () => {
    const result = v2.scoreSample(
      features({
        mode: "GROUNDED",
        mentions: brandMentions(2),
        citations: [
          citation({ normalizedUrl: "acme.com/pricing", isBrandDomain: true, position: 1 }),
          citation({ normalizedUrl: "presse.example.com/a", position: 2 }),
        ],
      })
    );
    expect(total(result)).toBeCloseTo(result.score, 10);
  });

  it("holds on a sample carrying every signed rule", () => {
    const result = v2.scoreSample(
      features({
        mode: "GROUNDED",
        mentions: [
          ...brandMentions(2).map((m) => ({ ...m, sentiment: "NEGATIVE" as const })),
          ...competitorMentions(2, { leads: true }),
        ],
        citations: [citation({ normalizedUrl: "acme.com/x", isBrandDomain: true })],
      })
    );
    expect(total(result)).toBeCloseTo(result.score, 10);
  });

  it("clamps the score to zero when the signed rules take the total below it", () => {
    const result = v2.scoreSample(
      features({ mentions: competitorMentions(8, { leads: true }) })
    );
    expect(total(result)).toBeLessThan(0);
    expect(result.score).toBe(0);
  });

  it("keeps the score inside [0,100] on the most favourable sample", () => {
    const result = v2.scoreSample(
      features({
        mode: "GROUNDED",
        mentions: brandMentions(8).map((m) => ({ ...m, sentiment: "POSITIVE" as const })),
        citations: [
          citation({ normalizedUrl: "acme.com/a", isBrandDomain: true, position: 1 }),
          citation({ normalizedUrl: "acme.com/b", isBrandDomain: true, position: 2 }),
        ],
      })
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe("presence", () => {
  it("scores an absent brand below a present one", () => {
    const absent = v2.scoreSample(features({ mentions: competitorMentions(1) }));
    const present = v2.scoreSample(
      features({ mentions: [...brandMentions(1), ...competitorMentions(1)] })
    );
    expect(absent.brandPresent).toBe(false);
    expect(present.brandPresent).toBe(true);
    expect(absent.score).toBeLessThan(present.score);
  });

  it("marks the rule inapplicable when the brand is absent", () => {
    const result = v2.scoreSample(features({ mentions: competitorMentions(1) }));
    expect(rule(result, "presence").applicable).toBe(false);
    expect(rule(result, "presence").contribution).toBe(0);
  });

  it("orders the mention tiers EXACT > ALIAS > DOMAIN > APPROXIMATE", () => {
    const scores = (["EXACT", "ALIAS", "DOMAIN", "APPROXIMATE"] as const).map(
      (mentionType) =>
        v2.scoreSample(
          features({ mentions: [mention({ entityId: BRAND, mentionType })] })
        ).score
    );
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBeGreaterThan(scores[3]);
  });

  it("keeps the best tier when the brand is matched several ways", () => {
    const mixed = v2.scoreSample(
      features({
        mentions: [
          mention({ entityId: BRAND, mentionType: "APPROXIMATE", occurrencesTotal: 2 }),
          mention({
            entityId: BRAND,
            mentionType: "EXACT",
            occurrenceIndex: 1,
            occurrencesTotal: 2,
            charOffset: 40,
            normalizedPosition: 40 / 600,
          }),
        ],
      })
    );
    expect(rule(mixed, "presence").rawValue).toBe(1);
  });
});

describe("prominence", () => {
  it("rewards an earlier first mention", () => {
    const early = v2.scoreSample(
      features({
        mentions: [
          mention({
            entityId: BRAND,
            charOffset: 30,
            normalizedPosition: 0.05,
            inFirstSentence: false,
            sentenceIndex: 1,
          }),
        ],
      })
    );
    const late = v2.scoreSample(
      features({
        mentions: [
          mention({
            entityId: BRAND,
            charOffset: 480,
            normalizedPosition: 0.8,
            inFirstSentence: false,
            sentenceIndex: 6,
          }),
        ],
      })
    );
    expect(rule(early, "prominence").contribution).toBeGreaterThan(
      rule(late, "prominence").contribution
    );
    expect(early.score).toBeGreaterThan(late.score);
  });

  it("rewards being named before the competitors", () => {
    const first = v2.scoreSample(
      features({
        mentions: [
          mention({ entityId: BRAND, orderRank: 0, inFirstSentence: false, sentenceIndex: 2 }),
        ],
      })
    );
    const fourth = v2.scoreSample(
      features({
        mentions: [
          mention({ entityId: BRAND, orderRank: 3, inFirstSentence: false, sentenceIndex: 2 }),
        ],
      })
    );
    expect(rule(first, "prominence").contribution).toBeGreaterThan(
      rule(fourth, "prominence").contribution
    );
  });

  it("reads the first mention by offset, not the first row", () => {
    const result = v2.scoreSample(
      features({
        mentions: [
          mention({ entityId: BRAND, charOffset: 480, normalizedPosition: 0.8, occurrenceIndex: 1 }),
          mention({ entityId: BRAND, charOffset: 10, normalizedPosition: 0.02, occurrenceIndex: 0 }),
        ],
      })
    );
    expect(rule(result, "prominence").evidence.charOffsets).toEqual([10]);
  });
});

describe("frequency", () => {
  it("saturates: ten mentions barely beat five", () => {
    const one = v2.scoreSample(features({ mentions: brandMentions(1) }));
    const five = v2.scoreSample(features({ mentions: brandMentions(5) }));
    const ten = v2.scoreSample(features({ mentions: brandMentions(10) }));

    expect(rule(five, "frequency").rawValue).toBeGreaterThan(rule(one, "frequency").rawValue);
    expect(rule(ten, "frequency").rawValue).toBe(rule(five, "frequency").rawValue);

    expect(ten.score).toBeGreaterThan(five.score);
    expect(ten.score - five.score).toBeLessThan(0.25 * (five.score - one.score));
  });

  it("counts brand occurrences only", () => {
    const result = v2.scoreSample(
      features({ mentions: [...brandMentions(3), ...competitorMentions(4)] })
    );
    expect(result.brandOccurrences).toBe(3);
  });
});

describe("shareOfVoice", () => {
  it("falls as competitor mentions rise", () => {
    const results = [0, 3, 9].map((count) =>
      v2.scoreSample(
        features({ mentions: [...brandMentions(3), ...competitorMentions(count)] })
      )
    );
    expect(results[0].shareOfVoice).toBeGreaterThan(results[1].shareOfVoice);
    expect(results[1].shareOfVoice).toBeGreaterThan(results[2].shareOfVoice);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });

  it("applies even when the brand is absent", () => {
    const result = v2.scoreSample(features({ mentions: competitorMentions(4) }));
    expect(rule(result, "shareOfVoice").applicable).toBe(true);
    expect(result.shareOfVoice).toBeCloseTo(1 / 6, 10);
  });

  it("counts distinct competitors, not their occurrences", () => {
    const result = v2.scoreSample(
      features({
        mentions: [
          ...brandMentions(1),
          mention({ entityId: "competitor-0", orderRank: 1, charOffset: 100 }),
          mention({ entityId: "competitor-0", orderRank: 1, charOffset: 200, occurrenceIndex: 1 }),
          mention({ entityId: "competitor-1", orderRank: 2, charOffset: 300 }),
        ],
      })
    );
    expect(result.competitorCount).toBe(2);
    expect(result.shareOfVoice).toBeCloseTo(2 / 6, 10);
  });
});

describe("competitorLead", () => {
  it("penalises competitors named before the brand", () => {
    const behind = v2.scoreSample(
      features({
        mentions: [
          ...brandMentions(1).map((m) => ({ ...m, orderRank: 2 })),
          ...competitorMentions(2, { leads: true }),
        ],
      })
    );
    const ahead = v2.scoreSample(
      features({ mentions: [...brandMentions(1), ...competitorMentions(2)] })
    );
    expect(rule(behind, "competitorLead").contribution).toBeLessThan(0);
    expect(rule(ahead, "competitorLead").contribution).toBeCloseTo(0, 10);
    expect(behind.score).toBeLessThan(ahead.score);
  });
});

describe("sentiment", () => {
  it("adds points for a positive majority and removes them for a negative one", () => {
    const build = (sentiment: "POSITIVE" | "NEGATIVE" | undefined) =>
      v2.scoreSample(
        features({ mentions: brandMentions(2).map((m) => ({ ...m, sentiment })) })
      );
    expect(rule(build("POSITIVE"), "sentiment").contribution).toBeGreaterThan(0);
    expect(rule(build("NEGATIVE"), "sentiment").contribution).toBeLessThan(0);
    expect(rule(build(undefined), "sentiment").applicable).toBe(false);
  });

  it("resolves a tie to the harsher verdict", () => {
    const result = v2.scoreSample(
      features({
        mentions: [
          { ...brandMentions(2)[0], sentiment: "POSITIVE" as const },
          { ...brandMentions(2)[1], sentiment: "NEGATIVE" as const },
        ],
      })
    );
    expect(rule(result, "sentiment").contribution).toBeLessThan(0);
  });
});

describe("citation", () => {
  const grounded = (citations: ExtractedCitation[], mentions = brandMentions(1)) =>
    v2.scoreSample(features({ mode: "GROUNDED", mentions, citations }));

  it("reads the citations, not the mentions", () => {
    const result = grounded(
      [
        citation({ normalizedUrl: "comparatif.example.com/crm", position: 1 }),
        citation({ normalizedUrl: "presse.example.org/a", position: 2 }),
      ],
      [mention({ entityId: BRAND, mentionType: "DOMAIN" })]
    );
    expect(result.brandDomainCited).toBe(false);
    expect(rule(result, "citation").applicable).toBe(true);
    expect(rule(result, "citation").contribution).toBe(0);
  });

  it("rewards brand-domain citations up to its target", () => {
    const none = grounded([citation({ normalizedUrl: "presse.example.org/a" })]);
    const one = grounded([
      citation({ normalizedUrl: "acme.com/a", isBrandDomain: true, position: 1 }),
    ]);
    const two = grounded([
      citation({ normalizedUrl: "acme.com/a", isBrandDomain: true, position: 1 }),
      citation({ normalizedUrl: "acme.com/b", isBrandDomain: true, position: 2 }),
    ]);
    const three = grounded([
      citation({ normalizedUrl: "acme.com/a", isBrandDomain: true, position: 1 }),
      citation({ normalizedUrl: "acme.com/b", isBrandDomain: true, position: 2 }),
      citation({ normalizedUrl: "acme.com/c", isBrandDomain: true, position: 3 }),
    ]);
    expect(rule(none, "citation").contribution).toBe(0);
    expect(rule(one, "citation").contribution).toBeGreaterThan(0);
    expect(rule(two, "citation").contribution).toBeGreaterThan(
      rule(one, "citation").contribution
    );
    expect(rule(three, "citation").rawValue).toBe(rule(two, "citation").rawValue);
    expect(three.citationCount).toBe(3);
  });

  it("does not apply when the brand is absent", () => {
    const result = v2.scoreSample(
      features({
        mode: "GROUNDED",
        mentions: competitorMentions(1),
        citations: [citation({ normalizedUrl: "acme.com/a", isBrandDomain: true })],
      })
    );
    expect(rule(result, "citation").applicable).toBe(false);
  });
});

describe("mode comparability", () => {
  const mentions = brandMentions(3);

  it("marks the citation rule inapplicable in parametric mode", () => {
    const result = v2.scoreSample(features({ mode: "PARAMETRIC", mentions }));
    expect(rule(result, "citation").applicable).toBe(false);
    expect(rule(result, "citation").contribution).toBe(0);
    expect(rule(result, "citation").redistributed).toBe(false);
  });

  it("redistributes the citation budget onto the rules that can carry it", () => {
    const result = v2.scoreSample(features({ mode: "PARAMETRIC", mentions }));
    for (const ruleId of ["presence", "prominence", "frequency", "shareOfVoice"]) {
      expect(rule(result, ruleId).redistributed).toBe(true);
    }
    const applied = v2.scoreSample(
      features({
        mode: "GROUNDED",
        mentions,
        citations: [citation({ normalizedUrl: "acme.com/a", isBrandDomain: true })],
      })
    );
    for (const ruleId of ["presence", "prominence", "frequency", "shareOfVoice"]) {
      expect(rule(applied, ruleId).redistributed).toBe(false);
    }
    expect(rule(result, "presence").contribution).toBeGreaterThan(
      rule(applied, "presence").contribution
    );
  });

  it("gives a parametric and a source-less grounded sample the same score", () => {
    const parametric = v2.scoreSample(features({ mode: "PARAMETRIC", mentions, citations: [] }));
    const grounded = v2.scoreSample(features({ mode: "GROUNDED", mentions, citations: [] }));
    expect(grounded.score).toBe(parametric.score);
    expect(rule(grounded, "citation").applicable).toBe(false);
    for (const ruleId of ["presence", "prominence", "frequency", "shareOfVoice"]) {
      expect(rule(grounded, ruleId).contribution).toBe(rule(parametric, ruleId).contribution);
    }
  });

  it("keeps the comparison stable across both modes for identical mentions", () => {
    const both: SamplingMode[] = ["PARAMETRIC", "GROUNDED"];
    const scores = both.map(
      (mode) =>
        v2.scoreSample(
          features({ mode, mentions: [...mentions, ...competitorMentions(2)] })
        ).score
    );
    expect(scores[1]).toBe(scores[0]);
  });
});

describe("summary fields", () => {
  it("reports a null order rank when the brand is absent", () => {
    const result = v2.scoreSample(features({ mentions: competitorMentions(2) }));
    expect(result.brandOrderRank).toBeNull();
    expect(result.brandOccurrences).toBe(0);
    expect(result.competitorCount).toBe(2);
  });

  it("reports the earliest rank of the brand when it is present", () => {
    const result = v2.scoreSample(
      features({
        mentions: [
          mention({ entityId: BRAND, orderRank: 2, charOffset: 200, occurrenceIndex: 0 }),
          mention({ entityId: BRAND, orderRank: 2, charOffset: 300, occurrenceIndex: 1 }),
          ...competitorMentions(2, { leads: true }),
        ],
      })
    );
    expect(result.brandOrderRank).toBe(2);
    expect(result.brandOccurrences).toBe(2);
  });

  it("reports a zero rank for a brand named first", () => {
    const result = v2.scoreSample(
      features({ mentions: [...brandMentions(1), ...competitorMentions(3)] })
    );
    expect(result.brandOrderRank).toBe(0);
  });

  it("counts citations and flags a brand-domain citation", () => {
    const result = v2.scoreSample(
      features({
        mode: "GROUNDED",
        mentions: brandMentions(1),
        citations: [
          citation({ normalizedUrl: "acme.com/a", isBrandDomain: true, position: 1 }),
          citation({ normalizedUrl: "presse.example.org/b", position: 2 }),
        ],
      })
    );
    expect(result.citationCount).toBe(2);
    expect(result.brandDomainCited).toBe(true);
  });
});
