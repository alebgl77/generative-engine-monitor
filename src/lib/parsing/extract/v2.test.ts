import type { CitationSource } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { extractorV2 } from "@/lib/parsing/extract/v2";
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
  return extractorV2.extract({
    text,
    entities,
    providerSources: options.providerSources ?? [],
    brandDomains: options.brandDomains ?? [],
  });
}

const ACME = entity({ id: "brand", name: "Acme" });

describe("extractorV2 identity", () => {
  it("stamps its version and measures the answer", () => {
    const text = "Acme domine le marché français. Beta suit de très près.";
    const result = extract(text, [ACME]);
    expect(result.extractionVersion).toBe("v2");
    expect(extractorV2.version).toBe("v2");
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
    const text = "Équipe créative à Genève : Acme se démarque.";
    const result = extract(text, [ACME]);
    expect(text.normalize("NFC").length).toBeLessThan(text.length);
    expect(result.mentions).toHaveLength(1);
    const { charOffset } = result.mentions[0];
    expect(charOffset).toBe(text.indexOf("Acme"));
    expect(text.slice(charOffset, charOffset + "Acme".length)).toBe("Acme");
  });

  it("keeps every occurrence aligned in a text mixing accent forms", () => {
    const text =
      "Créé en 2019, Acme s'impose. Les équipes citent Acme, puis Acme à nouveau.";
    const result = extract(text, [ACME]);
    expect(result.mentions).toHaveLength(3);
    for (const mention of result.mentions) {
      expect(text.slice(mention.charOffset, mention.charOffset + 4)).toBe("Acme");
    }
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

  it("does not match a name followed by another letter", () => {
    const result = extract("Zohoo est une tout autre chose.", [entity({ id: "e", name: "Zoho" })]);
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

  it("does not split an accented word at the boundary", () => {
    const result = extract("Le cafeteria du coin sert des boissons.", [
      entity({ id: "e", name: "Café" }),
    ]);
    expect(result.mentions).toEqual([]);
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

  it("does not match .NET inside a hostname", () => {
    const result = extract("Le dépôt est sur example.net depuis longtemps.", [
      entity({ id: "dotnet", name: ".NET" }),
    ]);
    expect(result.mentions).toEqual([]);
  });

  it("does not match Node.js inside a longer identifier", () => {
    const result = extract("Le paquet node.jsonify est déprécié.", [
      entity({ id: "node", name: "Node.js" }),
    ]);
    expect(result.mentions).toEqual([]);
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

  it("normalises the position of each occurrence into [0,1]", () => {
    const mentions = extract(text, [ACME]).mentions;
    for (const mention of mentions) {
      expect(mention.normalizedPosition).toBeGreaterThanOrEqual(0);
      expect(mention.normalizedPosition).toBeLessThanOrEqual(1);
      expect(mention.normalizedPosition).toBeCloseTo(mention.charOffset / text.length, 10);
    }
    expect(mentions[0].normalizedPosition).toBeLessThan(mentions[2].normalizedPosition);
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

  it("gives every occurrence of an entity the rank of its first appearance", () => {
    const text = "Beta ouvre le classement. Acme suit. Acme revient plus loin.";
    const result = extract(text, [
      ACME,
      entity({ id: "beta", name: "Beta", kind: "COMPETITOR" }),
    ]);
    const acme = result.mentions.filter((m) => m.entityId === "brand");
    expect(acme).toHaveLength(2);
    expect(acme.map((m) => m.orderRank)).toEqual([1, 1]);
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

  it("flags only the mentions of the first sentence", () => {
    const result = extract(text, entities);
    const first = new Map(result.mentions.map((m) => [m.entityId, m.inFirstSentence]));
    expect(first.get("brand")).toBe(true);
    expect(first.get("beta")).toBe(false);
    expect(first.get("gamma")).toBe(false);
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
        { url: "https://www.acme.com/a-propos", kind: "NATIVE" },
        { url: "https://acme.competitor.com/vs-acme", kind: "NATIVE" },
        { url: "https://notacme.com/avis", kind: "NATIVE" },
        { url: "https://acme.co.uk/uk", kind: "NATIVE" },
      ],
      brandDomains: ["acme.com"],
    });
    expect(result.citations.map((c) => c.isBrandDomain)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
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
