import type { SamplingMode } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { ExtractedCitation, MentionOccurrence } from "@/lib/parsing/types";
import { stability } from "@/lib/scoring/stats";
import type { SampleFeatures, SampleScoreResult } from "@/lib/scoring/types";
import { stabilityV3, v3 } from "@/lib/scoring/versions/v3";

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

describe("v3 identity", () => {
  it("declares the extraction version it reads", () => {
    expect(v3.version).toBe("v3");
    expect(v3.extractionVersion).toBe("v3");
  });

  it("returns one contribution per rule, each labelled", () => {
    const result = v3.scoreSample(features({ mentions: brandMentions(1) }));
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
    const result = v3.scoreSample(features({ mentions: brandMentions(2) }));
    expect(total(result)).toBeCloseTo(result.score, 10);
  });

  it("holds on a grounded sample with citations", () => {
    const result = v3.scoreSample(
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

  it("clamps the score to zero when the signed rules take the total below it", () => {
    const result = v3.scoreSample(
      features({ mentions: competitorMentions(8, { leads: true }) })
    );
    expect(total(result)).toBeLessThan(0);
    expect(result.score).toBe(0);
  });

  it("keeps the score inside [0,100] on the most favourable sample", () => {
    const result = v3.scoreSample(
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
    const absent = v3.scoreSample(features({ mentions: competitorMentions(1) }));
    const present = v3.scoreSample(
      features({ mentions: [...brandMentions(1), ...competitorMentions(1)] })
    );
    expect(absent.brandPresent).toBe(false);
    expect(present.brandPresent).toBe(true);
    expect(absent.score).toBeLessThan(present.score);
  });

  it("orders the mention tiers EXACT > ALIAS > DOMAIN", () => {
    const scores = (["EXACT", "ALIAS", "DOMAIN"] as const).map(
      (mentionType) =>
        v3.scoreSample(features({ mentions: [mention({ entityId: BRAND, mentionType })] })).score
    );
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });

  it("keeps the best tier when the brand is matched several ways", () => {
    const mixed = v3.scoreSample(
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
    expect(mixed.brandPresent).toBe(true);
    expect(rule(mixed, "presence").rawValue).toBe(1);
  });
});

describe("presence rests on a spelled-out match", () => {
  const approximateOnly = features({
    mentions: [mention({ entityId: BRAND, mentionType: "APPROXIMATE" })],
  });

  it("does not report the brand as present on a fuzzy match alone", () => {
    const result = v3.scoreSample(approximateOnly);
    expect(result.brandPresent).toBe(false);
  });

  it("marks every brand rule inapplicable and redistributes nothing", () => {
    const result = v3.scoreSample(approximateOnly);
    for (const ruleId of ["presence", "prominence", "frequency", "citation", "sentiment"]) {
      expect(rule(result, ruleId).applicable).toBe(false);
      expect(rule(result, ruleId).contribution).toBe(0);
    }
    for (const contribution of result.contributions) {
      expect(contribution.redistributed).toBe(false);
    }
    expect(result.brandOrderRank).toBeNull();
  });

  it("scores far below a sample where the brand is spelled out", () => {
    const approximate = v3.scoreSample(approximateOnly);
    const exact = v3.scoreSample(
      features({ mentions: [mention({ entityId: BRAND, mentionType: "EXACT" })] })
    );
    expect(approximate.score).toBeLessThan(exact.score);
  });

  it("still reports the brand as present when one occurrence is spelled out", () => {
    const result = v3.scoreSample(
      features({
        mentions: [
          mention({ entityId: BRAND, mentionType: "APPROXIMATE" }),
          mention({
            entityId: BRAND,
            mentionType: "ALIAS",
            occurrenceIndex: 1,
            charOffset: 40,
            normalizedPosition: 40 / 600,
          }),
        ],
      })
    );
    expect(result.brandPresent).toBe(true);
  });
});

describe("frequency", () => {
  it("saturates: ten mentions barely beat five", () => {
    const one = v3.scoreSample(features({ mentions: brandMentions(1) }));
    const five = v3.scoreSample(features({ mentions: brandMentions(5) }));
    const ten = v3.scoreSample(features({ mentions: brandMentions(10) }));

    expect(rule(five, "frequency").rawValue).toBeGreaterThan(rule(one, "frequency").rawValue);
    expect(rule(ten, "frequency").rawValue).toBe(rule(five, "frequency").rawValue);
    expect(ten.score).toBeGreaterThan(five.score);
  });
});

describe("shareOfVoice", () => {
  it("falls as competitor mentions rise", () => {
    const results = [0, 3, 9].map((count) =>
      v3.scoreSample(features({ mentions: [...brandMentions(3), ...competitorMentions(count)] }))
    );
    expect(results[0].shareOfVoice).toBeGreaterThan(results[1].shareOfVoice);
    expect(results[1].shareOfVoice).toBeGreaterThan(results[2].shareOfVoice);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("applies even when the brand is absent", () => {
    const result = v3.scoreSample(features({ mentions: competitorMentions(4) }));
    expect(rule(result, "shareOfVoice").applicable).toBe(true);
    expect(result.shareOfVoice).toBeCloseTo(1 / 6, 10);
  });
});

describe("competitorLead", () => {
  it("penalises competitors named before the brand", () => {
    const behind = v3.scoreSample(
      features({
        mentions: [
          ...brandMentions(1).map((m) => ({ ...m, orderRank: 2 })),
          ...competitorMentions(2, { leads: true }),
        ],
      })
    );
    const ahead = v3.scoreSample(
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
      v3.scoreSample(features({ mentions: brandMentions(2).map((m) => ({ ...m, sentiment })) }));
    expect(rule(build("POSITIVE"), "sentiment").contribution).toBeGreaterThan(0);
    expect(rule(build("NEGATIVE"), "sentiment").contribution).toBeLessThan(0);
    expect(rule(build(undefined), "sentiment").applicable).toBe(false);
  });

  it("resolves a tie to the harsher verdict", () => {
    const result = v3.scoreSample(
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
    v3.scoreSample(features({ mode: "GROUNDED", mentions, citations }));

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
    const result = v3.scoreSample(
      features({
        mode: "GROUNDED",
        mentions: competitorMentions(1),
        citations: [citation({ normalizedUrl: "acme.com/a", isBrandDomain: true })],
      })
    );
    expect(rule(result, "citation").applicable).toBe(false);
  });
});

describe("only retrieved sources count as retrieval", () => {
  const mentions = brandMentions(3);
  const parametric = v3.scoreSample(features({ mode: "PARAMETRIC", mentions, citations: [] }));

  it("scores a grounded answer carrying a typed URL like one carrying none", () => {
    const typed = v3.scoreSample(
      features({
        mode: "GROUNDED",
        mentions,
        citations: [
          citation({ normalizedUrl: "fr.wikipedia.org/wiki/ERP", sourceKind: "BARE_URL" }),
        ],
      })
    );
    const sourceless = v3.scoreSample(features({ mode: "GROUNDED", mentions, citations: [] }));
    expect(typed.score).toBe(sourceless.score);
    expect(typed.score).toBe(parametric.score);
  });

  it("keeps the citation budget redistributed when every source is typed", () => {
    const typed = v3.scoreSample(
      features({
        mode: "GROUNDED",
        mentions,
        citations: [
          citation({ normalizedUrl: "fr.wikipedia.org/wiki/ERP", sourceKind: "BARE_URL" }),
          citation({ normalizedUrl: "blog.example.org/a", sourceKind: "INLINE_MARKDOWN" }),
        ],
      })
    );
    expect(rule(typed, "citation").applicable).toBe(false);
    for (const ruleId of ["presence", "prominence", "frequency", "shareOfVoice"]) {
      expect(rule(typed, ruleId).redistributed).toBe(true);
      expect(rule(typed, ruleId).contribution).toBe(rule(parametric, ruleId).contribution);
    }
  });

  it("does not credit a brand URL the model typed itself", () => {
    const typed = v3.scoreSample(
      features({
        mode: "GROUNDED",
        mentions,
        citations: [
          citation({
            normalizedUrl: "acme.com/pricing",
            isBrandDomain: true,
            sourceKind: "BARE_URL",
          }),
        ],
      })
    );
    expect(typed.brandDomainCited).toBe(false);
    expect(rule(typed, "citation").applicable).toBe(false);
    expect(typed.score).toBe(parametric.score);
  });

  it("counts only the retrieved sources in its note", () => {
    const mixed = v3.scoreSample(
      features({
        mode: "GROUNDED",
        mentions,
        citations: [
          citation({ normalizedUrl: "presse.example.org/a", position: 1 }),
          citation({ normalizedUrl: "fr.wikipedia.org/wiki/ERP", sourceKind: "BARE_URL", position: 2 }),
          citation({ normalizedUrl: "blog.example.org/b", sourceKind: "INLINE_MARKDOWN", position: 3 }),
        ],
      })
    );
    expect(rule(mixed, "citation").applicable).toBe(true);
    expect(rule(mixed, "citation").evidence.note).toContain("Aucune des 1 sources");
    expect(rule(mixed, "citation").evidence.citationIds).toEqual(["presse.example.org/a"]);
    expect(mixed.citationCount).toBe(3);
  });

  it("leaves the retrieval gap free of a typed-link artefact", () => {
    const gapWithTypedLink =
      v3.scoreSample(
        features({
          mode: "GROUNDED",
          mentions,
          citations: [
            citation({ normalizedUrl: "fr.wikipedia.org/wiki/ERP", sourceKind: "BARE_URL" }),
          ],
        })
      ).score - parametric.score;
    expect(gapWithTypedLink).toBe(0);
  });
});

describe("mode comparability", () => {
  const mentions = brandMentions(3);

  it("marks the citation rule inapplicable in parametric mode", () => {
    const result = v3.scoreSample(features({ mode: "PARAMETRIC", mentions }));
    expect(rule(result, "citation").applicable).toBe(false);
    expect(rule(result, "citation").contribution).toBe(0);
    expect(rule(result, "citation").redistributed).toBe(false);
  });

  it("redistributes the citation budget onto the rules that can carry it", () => {
    const result = v3.scoreSample(features({ mode: "PARAMETRIC", mentions }));
    for (const ruleId of ["presence", "prominence", "frequency", "shareOfVoice"]) {
      expect(rule(result, ruleId).redistributed).toBe(true);
    }
    const applied = v3.scoreSample(
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

  it("keeps the comparison stable across both modes for identical mentions", () => {
    const both: SamplingMode[] = ["PARAMETRIC", "GROUNDED"];
    const scores = both.map(
      (mode) =>
        v3.scoreSample(features({ mode, mentions: [...mentions, ...competitorMentions(2)] })).score
    );
    expect(scores[1]).toBe(scores[0]);
  });
});

describe("summary fields", () => {
  it("reports a null order rank when the brand is absent", () => {
    const result = v3.scoreSample(features({ mentions: competitorMentions(2) }));
    expect(result.brandOrderRank).toBeNull();
    expect(result.brandOccurrences).toBe(0);
    expect(result.competitorCount).toBe(2);
  });

  it("reports the earliest rank of the brand when it is present", () => {
    const result = v3.scoreSample(
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

  it("counts citations and flags a retrieved brand-domain citation", () => {
    const result = v3.scoreSample(
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

describe("stabilityV3", () => {
  it("reports perfect stability on identical samples", () => {
    expect(stabilityV3([80, 80, 80])).toBe(1);
    expect(stabilityV3([70])).toBe(1);
  });

  it("does not read a tied pair as a stable cell", () => {
    expect(stabilityV3([100, 100, 0])).toBeLessThan(0.5);
    expect(stabilityV3([100, 100, 0])).toBeLessThan(stability([100, 100, 0]));
  });

  it("falls as the spread widens", () => {
    const tight = stabilityV3([70, 72, 74]);
    const loose = stabilityV3([50, 72, 94]);
    expect(tight).toBeGreaterThan(loose);
  });

  it("stays inside [0,1]", () => {
    for (const xs of [[0, 100], [0, 50, 100], [12, 12, 12, 99], [3]]) {
      const value = stabilityV3(xs);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("refuses an empty sample", () => {
    expect(() => stabilityV3([])).toThrow();
  });
});
