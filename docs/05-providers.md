# 05 — Moteurs

`src/lib/providers/`. Un moteur est un objet qui sait poser une question dans deux modes et rendre compte de ce qu'il a récupéré.

## Le contrat `AIProvider`

```ts
interface AIProvider {
  code: string;
  label: string;
  capabilities: ProviderCapabilities;      // { parametric: boolean; grounded: boolean }
  defaultModel(): string;                  // résolu depuis l'environnement
  runQuery(input: ProviderQueryInput): Promise<ProviderResponse>;
  validateKey(apiKey: string, signal?: AbortSignal): Promise<KeyValidation>;
}
```

```ts
interface ProviderQueryInput {
  query: string;
  mode: SamplingMode;
  apiKey: string;
  locale: { country: string; language: string };
  signal: AbortSignal;      // avorté par le worker sur délai ou annulation
  model?: string;           // remplace le défaut du moteur
}

interface ProviderResponse {
  text: string;
  rawJson: Record<string, unknown>;   // stocké verbatim
  sources: ProviderSource[];
  model: string;
  finishReason?: string;
  truncated: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}
```

`rawJson` est la charge utile complète du fournisseur, conservée telle quelle. C'est le substrat du replay : une charge pré-digérée interdirait à une future version d'extraction d'en redériver quoi que ce soit.

## Les deux modes

![](../public/assets/modes.png)

| Mode | Ce qu'on mesure | Comment il est obtenu |
|---|---|---|
| `PARAMETRIC` | ce que le modèle a retenu de son entraînement | tous les outils de recherche désactivés |
| `GROUNDED` | ce qu'il va chercher au moment de répondre | recherche web native du fournisseur activée |

Un moteur déclare les modes qu'il sait servir. La planification saute les cellules impossibles au lieu de les faire échouer : Perplexity interroge toujours le web, le mode paramétrique n'a pas de sens pour lui. Un appel dans un mode non supporté lève tout de même une `ProviderError("UNSUPPORTED_MODE")`, pour que le contrat tienne indépendamment de qui l'appelle.

Le prompt système est commun à tous les moteurs (`systemPrompt`) : il demande une réponse dans la langue du projet, pour une audience située dans le pays du projet, et invite à nommer des marques, produits ou prestataires quand ils sont réellement pertinents. Il est identique entre les deux modes — sans quoi l'écart de récupération mesurerait la différence entre deux consignes plutôt qu'entre deux sources de connaissance.

Le budget d'appel dépend du mode : 60 secondes en paramétrique, 180 en groundé, un appel groundé exécutant une boucle de recherche.

## Origine des citations

Une citation porte un `sourceKind` qui dit **quelle confiance lui accorder**.

| `sourceKind` | Origine | Valeur probante |
|---|---|---|
| `NATIVE` | métadonnées de grounding du fournisseur | le document a réellement été récupéré |
| `INLINE_MARKDOWN` | lien markdown dans le texte de la réponse | peut être récité de mémoire |
| `BARE_URL` | URL nue dans le texte | idem, sans même un intitulé |

Chaque implémentation extrait d'abord ses sources natives, puis complète avec les URL trouvées dans le texte (`extractTextUrls`), en écartant celles déjà connues. En cas de collision après normalisation, la source native l'emporte : un lien tapé de mémoire n'est pas la preuve d'une récupération.

L'origine est portée par la ligne de citation, restituée dans le détail d'un échantillon et exploitée par le replay, qui reconstitue les sources d'un fournisseur à partir des seules citations `NATIVE` — la charge utile brute étant spécifique à chaque fournisseur et à chaque époque.

Ce que la règle `citation` en fait dépend de la version de scoring, et les deux versions enregistrées dans `scoring/registry.ts` n'en font pas la même lecture :

| Version | Sources créditées | Applicabilité de la règle |
|---|---|---|
| `v2` | toutes les sources retenues pour l'échantillon, quelle qu'en soit l'origine | mode groundé, marque présente, au moins une source |
| `v3` (courante) | les seules sources `NATIVE` — ce que le fournisseur a réellement récupéré | mode groundé, marque présente, au moins une source `NATIVE` |

Le passage de l'une à l'autre est un **nouveau fichier de version**, pas une retouche : un fichier publié n'est jamais modifié, sans quoi les scores déjà persistés sous son nom cesseraient d'être reproductibles. Une analyse conserve la version sous laquelle elle a été planifiée, et les deux générations se comparent sur le même corpus par un replay.

### Par moteur

| Code | Libellé | Paramétrique | Groundé | Activation du grounding | Sources natives | Variable de modèle |
|---|---|---|---|---|---|---|
| `openai` | OpenAI ChatGPT | oui | oui | `tools: [{ type: "web_search" }]` sur l'API Responses | annotations `url_citation` des parties `output_text` | `OPENAI_MODEL` |
| `claude` | Anthropic Claude | oui | oui | outil `web_search` (5 usages maximum) | blocs `web_search_tool_result` et citations `web_search_result_location` | `ANTHROPIC_MODEL` |
| `gemini` | Google Gemini | oui | oui | `tools: [{ googleSearch: {} }]` | `groundingMetadata.groundingChunks[].web` | `GEMINI_MODEL` |
| `perplexity` | Perplexity | non | oui | natif, sans option | `search_results` ; repli sur `citations` (URL sans intitulé) quand le champ est absent | `PERPLEXITY_MODEL` |
| `mock` | Mock (démo) | oui | oui | modèles de réponse dédiés au mode | sources de fixture, marquées natives en mode groundé | aucune |

Les identifiants de modèle par défaut vivent dans `.env.example` et se surchargent par variable d'environnement. Un identifiant codé en dur devient une panne silencieuse le jour où le fournisseur retire le modèle ; le worker journalise donc les modèles résolus à son démarrage.

## Le moteur `mock`

Il n'exige aucune clé, n'est jamais écarté de la planification, et sert deux usages :

- **Démonstration à coût nul.** Ses fixtures produisent des réponses françaises réalistes sur un corpus de CRM, avec mentions multiples, ordres variables et sources citées, dans les deux modes. Toute la chaîne se démontre de bout en bout sans dépenser un centime.
- **Détermination des tests.** Les réponses ne dépendent que de la requête et de l'indice de répétition, ce qui donne un pipeline observable sans réseau.

Sa `validateKey` accepte tout, et son `defaultModel()` renvoie l'identifiant de fixture.

## Couche HTTP commune

`src/lib/providers/http.ts`. Chaque appel fournisseur y transite pour que délais, annulation et classification d'erreurs soient uniformes.

- Le signal de l'appelant et une échéance interne sont combinés par `AbortSignal.any` : le premier qui se déclenche interrompt la requête. Un avortement piloté par l'appelant est une annulation, l'échéance interne un délai dépassé — la distinction est faite explicitement.
- Le corps d'une réponse d'erreur est tronqué à 600 caractères : la page HTML d'erreur d'un fournisseur ne doit pas inonder la base.
- L'en-tête `Retry-After` est interprété, en secondes comme en date HTTP, et prime sur le backoff calculé.
- **Aucune reprise ici.** Une reprise coûte un appel payant : elle appartient à la file, où elle est visible dans le compteur de tentatives et le backoff du job, pas dissimulée dans un utilitaire.

### Taxonomie d'erreurs

`src/lib/errors.ts`. La classification pilote un comportement réel : `retryable` décide de la remise en file, `invalidatesCredential` décide d'arrêter de brûler les appels restants d'un run contre une clé qu'on sait morte.

| Code | Origine | Repris | Invalide la clé |
|---|---|---|---|
| `AUTH` | 401, 403 | non | oui |
| `RATE_LIMIT` | 429 | oui | non |
| `TIMEOUT` | 408, échéance dépassée | oui | non |
| `SERVER` | 5xx | oui | non |
| `NETWORK` | DNS, socket | oui | non |
| `BAD_REQUEST` | 4xx, 404 ambigu | non | non |
| `MODEL_NOT_FOUND` | 404 avec l'indice `model` | non | non |
| `UNSUPPORTED_MODE` | mode refusé par le moteur | non | non |
| `PARSE` | charge illisible | non | non |
| `CANCELLED` | avortement par l'appelant | non | non |
| `UNKNOWN` | reste | non | non |

Un 404 est ambigu : les appelants capables de distinguer un modèle absent d'une route absente passent l'indice `notFoundMeans: "model"`, et un modèle retiré se signale alors bruyamment plutôt que de se déguiser en requête malformée.

Sur une erreur `AUTH`, le handler d'échantillon invalide l'identifiant, journalise l'événement dans `audit_logs` et annule les jobs restants du même moteur pour ce run : poursuivre reviendrait à collectionner des échecs identiques.

## Validation des clés

`validateKey` effectue l'appel le moins coûteux qui prouve l'authentification, avec un budget de 15 secondes — un formulaire de configuration ne doit pas se figer sur le budget d'un appel complet.

| Moteur | Sonde |
|---|---|
| `openai` | `GET /v1/models` |
| `gemini` | `GET /v1beta/models` |
| `claude` | message minimal sur `/v1/messages` |
| `perplexity` | complétion minimale, `max_tokens: 1` |
| `mock` | accepte |

Une exception inattendue n'est jamais propagée à la route : elle devient un verdict invalide portant le code d'erreur, si bien que la page de configuration affiche une raison au lieu d'une erreur générique.

## Ajouter un moteur

1. **Implémenter** `AIProvider` dans `src/lib/providers/<code>.ts`. Passer tous les appels HTTP par `providerFetch`, extraire les sources natives avant de compléter par `extractTextUrls`, et renvoyer la charge utile complète dans `rawJson`.
2. **Déclarer les capacités** honnêtement : un mode annoncé mais non servi produit des cellules qui échouent au lieu d'être écartées à la planification.
3. **Résoudre le modèle** via `defaultModel()` et la configuration. Ajouter la variable à `src/lib/env.ts`, à la fonction `modelFor`, à `.env.example` et aux deux fichiers de composition.
4. **Enregistrer** l'instance dans `src/lib/providers/registry.ts`.
5. **Ajouter la ligne en base** dans `prisma/seed.ts` : `code`, `label`, capacités, `rpmLimit`, `maxConcurrency`. Le seed crée le seau à jetons associé — un seau absent échoue en refus et bloquerait tous les jobs du moteur.
6. **Tester** au moins : extraction des sources natives depuis une charge utile réaliste, classification des erreurs, comportement dans le mode non supporté.

Aucune modification n'est nécessaire dans la planification, la file, l'extraction, le scoring ni les vues : elles ne connaissent que le contrat.
