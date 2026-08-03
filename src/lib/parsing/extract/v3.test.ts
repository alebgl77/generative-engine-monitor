import type { CitationSource } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { extractorV3 } from "@/lib/parsing/extract/v3";
import type { EntityToMatch, ExtractionResult } from "@/lib/parsing/types";

function entity(partial: Partial<EntityToMatch> & { id: string; name: string }): EntityToMatch {
  return {
    domain: null,
    aliases: [],
    kind: "BRAND",
    ...partial,
  };
}

function extract(
  text: string,
  entities: EntityToMatch[],
  options: {
    providerSources?: { url: string; title?: string; kind: CitationSource }[];
    brandDomains?: string[];
  } = {}
): ExtractionResult {
  return extractorV3.extract({
    text,
    entities,
    providerSources: options.providerSources ?? [],
    brandDomains: options.brandDomains ?? [],
  });
}

const ACME = entity({ id: "brand", name: "Acme" });

describe("extractorV3 identity", () => {
  it("stamps its version and measures the answer", () => {
    const text = "Acme domine le marché français. Beta suit de très près.";
    const result = extract(text, [ACME]);
    expect(result.extractionVersion).toBe("v3");
    expect(extractorV3.version).toBe("v3");
    expect(result.textLength).toBe(text.length);
    expect(result.sentenceCount).toBe(2);
  });

  it("returns nothing on an empty answer", () => {
    const result = extract("", [ACME]);
    expect(result.mentions).toEqual([]);
    expect(result.citations).toEqual([]);
    expect(result.textLength).toBe(0);
    expect(result.sentenceCount).toBe(0);
  });
});

describe("case and diacritic insensitivity", () => {
  it("matches an accented name against unaccented text", () => {
    const text = "Le cafe du coin est une institution locale.";
    const result = extract(text, [entity({ id: "e", name: "Café" })]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].mentionType).toBe("EXACT");
    expect(result.mentions[0].charOffset).toBe(text.indexOf("cafe"));
  });

  it("matches an unaccented name against accented text", () => {
    const text = "Le Café du coin est une institution locale.";
    const result = extract(text, [entity({ id: "e", name: "cafe" })]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].mentionType).toBe("EXACT");
    expect(result.mentions[0].charOffset).toBe(text.indexOf("Café"));
  });

  it("matches regardless of case", () => {
    const result = extract("ACME et acme et AcMe sont la même marque.", [ACME]);
    expect(result.mentions).toHaveLength(3);
    for (const mention of result.mentions) expect(mention.mentionType).toBe("EXACT");
  });

  it("matches an alias case- and diacritic-insensitively", () => {
    const result = extract("ACME est cité comme leader.", [
      entity({ id: "e", name: "Acme Corporation", aliases: ["Acmé"] }),
    ]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].mentionType).toBe("ALIAS");
  });

  it("matches a domain written in the answer", () => {
    const result = extract("Tout est documenté sur acme.com pour les intégrateurs.", [
      entity({ id: "e", name: "Acme Corporation", domain: "https://www.acme.com/" }),
    ]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].mentionType).toBe("DOMAIN");
  });
});

describe("charOffset indexes the original text", () => {
  it("round-trips the matched substring when the name carries accents", () => {
    const text = "Le cafe du coin est une institution locale.";
    const name = "Café";
    const { charOffset } = extract(text, [entity({ id: "e", name })]).mentions[0];
    expect(text.slice(charOffset, charOffset + name.length)).toBe("cafe");
  });

  it("does not drift when combining marks precede the match", () => {
    // Accents written as separate combining code points: folding shortens the
    // string, so an offset taken on the folded copy would land four characters early.
    const text = "Équipe créative à Genève : Acme se démarque.".normalize("NFD");
    const result = extract(text, [ACME]);
    expect(text.normalize("NFC").length).toBeLessThan(text.length);
    expect(result.mentions).toHaveLength(1);
    const { charOffset } = result.mentions[0];
    expect(charOffset).toBe(text.indexOf("Acme"));
    expect(text.slice(charOffset, charOffset + "Acme".length)).toBe("Acme");
  });

  it("stays aligned across astral characters", () => {
    const text = "Bilan 🚀 du trimestre : Acme progresse encore.";
    const { charOffset } = extract(text, [ACME]).mentions[0];
    expect(text.slice(charOffset, charOffset + 4)).toBe("Acme");
  });
});

describe("word boundaries", () => {
  it("does not match a name inside a longer word", () => {
    const result = extract("Les outils demoncrmtools sont partout.", [
      entity({ id: "e", name: "MonCRM" }),
    ]);
    expect(result.mentions).toEqual([]);
  });

  it("does not match across a digit boundary", () => {
    const result = extract("La version Acme2024 est un autre produit.", [ACME]);
    expect(result.mentions).toEqual([]);
  });

  it("matches a name adjacent to punctuation", () => {
    const result = extract("Trois options : (Acme), Beta, Gamma.", [ACME]);
    expect(result.mentions).toHaveLength(1);
  });
});

describe("names carrying punctuation", () => {
  it("matches C#, .NET and Node.js as whole tokens", () => {
    const text = "J'utilise C# et .NET avec Node.js au quotidien.";
    const result = extract(text, [
      entity({ id: "csharp", name: "C#" }),
      entity({ id: "dotnet", name: ".NET" }),
      entity({ id: "node", name: "Node.js" }),
    ]);
    const byEntity = new Map(result.mentions.map((m) => [m.entityId, m]));
    expect(byEntity.get("csharp")?.charOffset).toBe(text.indexOf("C#"));
    expect(byEntity.get("dotnet")?.charOffset).toBe(text.indexOf(".NET"));
    expect(byEntity.get("node")?.charOffset).toBe(text.indexOf("Node.js"));
    for (const mention of result.mentions) expect(mention.mentionType).toBe("EXACT");
  });
});

describe("occurrences", () => {
  const text = "Acme domine le marché. Acme publie un guide. Enfin, Acme reste la référence.";

  it("returns one row per occurrence", () => {
    const result = extract(text, [ACME]);
    expect(result.mentions).toHaveLength(3);
  });

  it("carries the total on every row and an increasing index", () => {
    const mentions = extract(text, [ACME]).mentions;
    expect(mentions.map((m) => m.occurrencesTotal)).toEqual([3, 3, 3]);
    expect(mentions.map((m) => m.occurrenceIndex)).toEqual([0, 1, 2]);
    expect(mentions.map((m) => m.charOffset)).toEqual([
      text.indexOf("Acme"),
      text.indexOf("Acme", 1),
      text.lastIndexOf("Acme"),
    ]);
  });

  it("quotes the surrounding context", () => {
    const mentions = extract(text, [ACME]).mentions;
    expect(mentions[0].context).toContain("Acme domine le marché");
  });
});

describe("orderRank", () => {
  it("ranks entities by their first appearance across all entities", () => {
    const text = "Beta arrive en tête, puis Acme, puis Gamma.";
    const result = extract(text, [
      ACME,
      entity({ id: "beta", name: "Beta", kind: "COMPETITOR" }),
      entity({ id: "gamma", name: "Gamma", kind: "COMPETITOR" }),
    ]);
    const rank = new Map(result.mentions.map((m) => [m.entityId, m.orderRank]));
    expect(rank.get("beta")).toBe(0);
    expect(rank.get("brand")).toBe(1);
    expect(rank.get("gamma")).toBe(2);
  });

  it("does not rank entities that are absent", () => {
    const result = extract("Acme est seule sur ce segment.", [
      ACME,
      entity({ id: "beta", name: "Beta", kind: "COMPETITOR" }),
    ]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].orderRank).toBe(0);
  });
});

describe("sentences", () => {
  const text = "Acme domine le marché français. Beta suit de près. Gamma ferme la marche.";
  const entities = [
    ACME,
    entity({ id: "beta", name: "Beta", kind: "COMPETITOR" }),
    entity({ id: "gamma", name: "Gamma", kind: "COMPETITOR" }),
  ];

  it("indexes the sentence of each mention", () => {
    const result = extract(text, entities);
    const index = new Map(result.mentions.map((m) => [m.entityId, m.sentenceIndex]));
    expect(index.get("brand")).toBe(0);
    expect(index.get("beta")).toBe(1);
    expect(index.get("gamma")).toBe(2);
    expect(result.sentenceCount).toBe(3);
  });

  it("does not split on an abbreviation", () => {
    const result = extract("M. Dupont recommande Acme sans réserve.", [ACME]);
    expect(result.sentenceCount).toBe(1);
    expect(result.mentions[0].inFirstSentence).toBe(true);
  });
});

describe("approximate matching", () => {
  it("fires on a token one edit away from the name", () => {
    const result = extract("Beaucoup d'équipes utilisent Notin pour documenter.", [
      entity({ id: "e", name: "Notion" }),
    ]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].mentionType).toBe("APPROXIMATE");
    expect(result.mentions[0].confidence).toBeLessThan(1);
  });

  it("does not fire two edits away", () => {
    const result = extract("Beaucoup d'équipes utilisent Notix pour documenter.", [
      entity({ id: "e", name: "Notiun" }),
    ]);
    expect(result.mentions).toEqual([]);
  });

  it("does not fire on a short name", () => {
    const result = extract("Zoha est une tout autre marque.", [entity({ id: "e", name: "Zoho" })]);
    expect(result.mentions).toEqual([]);
  });

  it("does not fire inside a longer word", () => {
    const result = extract("Le terme notionnellement ne désigne rien ici.", [
      entity({ id: "e", name: "Notion" }),
    ]);
    expect(result.mentions).toEqual([]);
  });

  it("yields to an exact match on the same token", () => {
    const result = extract("Notion structure la documentation interne.", [
      entity({ id: "e", name: "Notion" }),
    ]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].mentionType).toBe("EXACT");
    expect(result.mentions[0].confidence).toBe(1);
  });
});

describe("a fuzzy match never overrides another entity's own name", () => {
  const FIGMA = entity({ id: "brand", name: "Figma" });
  const SIGMA = entity({ id: "sigma", name: "Sigma", kind: "COMPETITOR" });

  it("credits the competitor and leaves the brand out of the answer", () => {
    const result = extract("Sigma est un outil de BI tres apprecie des equipes data.", [
      FIGMA,
      SIGMA,
    ]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].entityId).toBe("sigma");
    expect(result.mentions[0].mentionType).toBe("EXACT");
    expect(result.mentions.some((m) => m.kind === "BRAND")).toBe(false);
  });

  it("suppresses the fuzzy match whichever order the entities arrive in", () => {
    const text = "Sigma est un outil de BI tres apprecie des equipes data.";
    const forward = extract(text, [FIGMA, SIGMA]);
    const reversed = extract(text, [SIGMA, FIGMA]);
    expect(forward.mentions).toEqual(reversed.mentions);
  });

  it("suppresses a fuzzy match landing on another entity's alias", () => {
    const result = extract("Sigma reste la référence des équipes analytiques.", [
      FIGMA,
      entity({ id: "other", name: "Analytique SA", aliases: ["Sigma"], kind: "COMPETITOR" }),
    ]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].entityId).toBe("other");
    expect(result.mentions[0].mentionType).toBe("ALIAS");
  });

  it("suppresses a fuzzy match landing on another entity's domain", () => {
    const result = extract("Le comparatif vit sur notlon.so depuis deux ans.", [
      entity({ id: "brand", name: "Notion" }),
      entity({ id: "other", name: "Analytique", domain: "notlon.so", kind: "COMPETITOR" }),
    ]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].entityId).toBe("other");
    expect(result.mentions[0].mentionType).toBe("DOMAIN");
  });

  it("keeps a fuzzy match on a token no other entity claims", () => {
    const result = extract("Sigma domine la BI. Figna reste la référence du design.", [
      FIGMA,
      SIGMA,
    ]);
    const brand = result.mentions.filter((m) => m.entityId === "brand");
    expect(brand).toHaveLength(1);
    expect(brand[0].mentionType).toBe("APPROXIMATE");
  });
});

describe("one span is credited once across entities", () => {
  it("keeps the longer name when two entities claim the same span", () => {
    const text = "Acme Rival propose une alternative. Acme domine encore le marché.";
    const result = extract(text, [
      ACME,
      entity({ id: "rival", name: "Acme Rival", kind: "COMPETITOR" }),
    ]);
    expect(result.mentions).toHaveLength(2);
    const [first, second] = result.mentions;
    expect(first.entityId).toBe("rival");
    expect(first.charOffset).toBe(text.indexOf("Acme Rival"));
    expect(second.entityId).toBe("brand");
    expect(second.charOffset).toBe(text.lastIndexOf("Acme"));
  });

  it("renumbers the occurrences of the entity that lost the span", () => {
    const text = "Acme Rival propose une alternative. Acme domine encore le marché.";
    const result = extract(text, [
      ACME,
      entity({ id: "rival", name: "Acme Rival", kind: "COMPETITOR" }),
    ]);
    const brand = result.mentions.filter((m) => m.entityId === "brand");
    expect(brand).toHaveLength(1);
    expect(brand[0].occurrenceIndex).toBe(0);
    expect(brand[0].occurrencesTotal).toBe(1);
  });

  it("prefers the exact name over another entity's alias on the same span", () => {
    const result = extract("Acme reste la référence du secteur.", [
      ACME,
      entity({ id: "rival", name: "Rival", aliases: ["Acme"], kind: "COMPETITOR" }),
    ]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].entityId).toBe("brand");
    expect(result.mentions[0].mentionType).toBe("EXACT");
  });

  it("resolves a perfect tie deterministically and only once", () => {
    const entities = [
      entity({ id: "b-second", name: "Acme" }),
      entity({ id: "a-first", name: "Acme", kind: "COMPETITOR" }),
    ];
    const result = extract("Acme reste la référence du secteur.", entities);
    const reversed = extract("Acme reste la référence du secteur.", [...entities].reverse());
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].entityId).toBe("a-first");
    expect(reversed.mentions.map((m) => m.entityId)).toEqual(["a-first"]);
  });

  it("drops an entity whose only span went to a stronger claim", () => {
    const result = extract("Acme Rival ouvre la comparaison.", [
      ACME,
      entity({ id: "rival", name: "Acme Rival", kind: "COMPETITOR" }),
    ]);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].entityId).toBe("rival");
    expect(result.mentions[0].orderRank).toBe(0);
  });
});

describe("citations", () => {
  const providerSources: { url: string; title?: string; kind: CitationSource }[] = [
    { url: "https://www.example.com/guide", title: "Guide comparatif", kind: "NATIVE" },
    { url: "https://blog.acme.com/etude", kind: "NATIVE" },
  ];

  it("collapses a native source and a bare URL of the same page", () => {
    const text = "Le comparatif complet : https://example.com/guide?utm_source=chat";
    const result = extract(text, [], { providerSources, brandDomains: ["acme.com"] });
    expect(result.citations).toHaveLength(2);
    const guide = result.citations.find((c) => c.normalizedUrl === "example.com/guide");
    expect(guide?.sourceKind).toBe("NATIVE");
    expect(guide?.title).toBe("Guide comparatif");
  });

  it("numbers citations from 1 in order of first appearance", () => {
    const text = "Le comparatif complet : https://example.com/guide?utm_source=chat";
    const result = extract(text, [], { providerSources, brandDomains: ["acme.com"] });
    expect(result.citations.map((c) => c.position)).toEqual([1, 2]);
    expect(result.citations[0].normalizedUrl).toBe("example.com/guide");
  });

  it("keeps a URL found only in the text as a bare URL", () => {
    const text = "Voir aussi https://autre.example.org/etude pour le détail.";
    const result = extract(text, [], { providerSources: [], brandDomains: ["acme.com"] });
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].sourceKind).toBe("BARE_URL");
    expect(result.citations[0].position).toBe(1);
  });

  it("prefers a markdown title over a bare URL for the same page", () => {
    const text = "Voir [l'étude Acme](https://blog.acme.com/etude) publiée en mars.";
    const result = extract(text, [], { providerSources: [], brandDomains: ["acme.com"] });
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].sourceKind).toBe("INLINE_MARKDOWN");
    expect(result.citations[0].title).toBe("l'étude Acme");
  });

  it("flags the brand domain and its subdomains only", () => {
    const result = extract("", [], {
      providerSources: [
        { url: "https://acme.com/pricing", kind: "NATIVE" },
        { url: "https://blog.acme.com/etude", kind: "NATIVE" },
        { url: "https://acme.competitor.com/vs-acme", kind: "NATIVE" },
        { url: "https://notacme.com/avis", kind: "NATIVE" },
      ],
      brandDomains: ["acme.com"],
    });
    expect(result.citations.map((c) => c.isBrandDomain)).toEqual([true, true, false, false]);
  });

  it("ignores unparseable sources", () => {
    const result = extract("", [], {
      providerSources: [
        { url: "javascript:alert(1)", kind: "NATIVE" },
        { url: "", kind: "NATIVE" },
        { url: "https://example.com/ok", kind: "NATIVE" },
      ],
      brandDomains: [],
    });
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].position).toBe(1);
  });
});
