# 06 — Mesure : extraction et scoring

Deux couches versionnées indépendamment. L'**extraction** transforme un texte de réponse en évidence : où la marque apparaît, sous quelle forme, à quelle position, quelles sources ont été citées. Le **scoring** transforme cette évidence en un nombre décomposé règle par règle. La première produit des faits, la seconde une opinion sur ces faits — et un changement d'opinion ne doit pas réécrire les faits.

---

## Extraction

`src/lib/parsing/`. Deux versions sont enregistrées, `v2` et `v3` ; `CURRENT_EXTRACTION_VERSION` désigne `v3` (`extract/v3.ts`). Les deux partagent le repliement du texte, les types de correspondance et la normalisation d'URL décrits ci-dessous ; `v3` résout les mentions en une passe sur toutes les entités suivies plutôt qu'entité par entité, si bien qu'un segment appartient à une seule entité et qu'une correspondance approximative ne survit pas là où une autre entité est écrite en toutes lettres.

### Repliement du texte

La recherche se fait sur une copie insensible à la casse et aux diacritiques, obtenue par décomposition NFD puis suppression des marques combinantes. Cette copie **reste alignée sur l'originale** : un tableau d'offsets associe chaque caractère replié à son index dans le texte tel que le fournisseur l'a renvoyé. Les décalages remontés à l'interface indexent donc la réponse réelle, jamais une réécriture normalisée — c'est ce qui permet de surligner exactement le passage responsable d'une contribution.

### Types de correspondance

Une occurrence porte l'un de quatre types, par confiance décroissante.

| Type | Ce qui déclenche | Confiance |
|---|---|---|
| `EXACT` | le nom de l'entité | 1.0 |
| `ALIAS` | l'un des alias déclarés | 0.9 |
| `DOMAIN` | le domaine de l'entité apparaît dans le texte | 0.8 |
| `APPROXIMATE` | jeton à distance d'édition 1 du nom | 0.4 |

Les candidats sont collectés pour tous les types, triés par priorité puis par position, et un candidat qui **chevauche** un candidat déjà retenu est écarté. « Zoho CRM » ne produit donc pas simultanément une correspondance exacte et une correspondance approximative sur le même segment.

### Frontières de mots

Les motifs sont encadrés par des assertions Unicode `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])` plutôt que par `\b`, qui est ASCII : `\b` scinde « café » et refuse les noms portant de la ponctuation comme `C#`, `.NET` ou `Node.js`. Les expressions régulières sont construites par constructeur et non écrites en littéraux, pour que le drapeau `u`, les lookbehinds et les échappements de propriété restent indépendants de la cible de compilation.

### Correspondance approximative

Elle opère sur des **jetons entiers**, jamais sur des sous-chaînes : une règle par sous-chaîne fait correspondre une marque courte à l'intérieur de mots sans rapport. Deux garde-fous : les noms de moins de 5 caractères en sont exclus — le bruit y dépasse le signal — et les jetons dont la longueur diffère de plus d'un caractère sont écartés avant tout calcul. La distance d'édition est bornée : la fonction s'arrête dès qu'une seconde correction serait nécessaire.

### Position et rang

Chaque occurrence enregistre :

- `charOffset` — index dans le texte d'origine ;
- `sentenceIndex` et `inFirstSentence` — la segmentation coupe après `.`, `!`, `?`, `…` suivis d'une espace, en ignorant les coupures qui produiraient une phrase de moins de 10 caractères, ce qui absorbe les abréviations du type « M. Dupont » ;
- `normalizedPosition` — `charOffset / textLength`, dans `[0,1]`, où 0 désigne le tout début de la réponse ;
- `orderRank` — rang de la **première apparition de l'entité parmi toutes les entités**, 0 signifiant nommée en premier ; les égalités sont tranchées par l'ordre d'entrée, donc de manière déterministe ;
- `occurrenceIndex` et `occurrencesTotal` — rang de l'occurrence et compte total pour cette entité ;
- `context` — 100 caractères de part et d'autre, espaces compactés, entouré d'ellipses lorsqu'il est tronqué. C'est ce qui alimente le juge de sentiment et l'affichage d'évidence.

Une ligne est écrite **par occurrence**, pas par entité. C'est ce qui rend la proéminence et la fréquence mesurables plutôt que déclaratives.

### Citations

Les sources déclarées par le fournisseur et les URL trouvées dans le texte sont fusionnées, puis dédupliquées sur l'URL normalisée. En cas de collision, la source de plus forte valeur probante l'emporte (`NATIVE` > `INLINE_MARKDOWN` > `BARE_URL`) et son intitulé est conservé s'il en existe un. La `position` finale suit l'ordre de première rencontre, en base 1.

### Normalisation d'URL

`src/lib/parsing/url.ts`. Deux citations pointant la même page doivent se réduire à une ligne, faute de quoi une source citée deux fois gonfle le compte de citations et le score qui en dérive. La normalisation fait donc partie de la mesure, et toute évolution appartient à une nouvelle version d'extraction.

- Schéma implicite `https://` si absent ; seuls `http` et `https` sont acceptés.
- Hôte en minuscules, `www.` retiré, forme validée par motif.
- **Liste blanche de paramètres** — `id`, `page`, `slug`, `category`, `q`, `query`, `tab`, `section` — plutôt qu'une liste noire de traqueurs : tout paramètre hors de cet ensemble est écarté, ce qui couvre `utm_*`, `gclid`, `fbclid`, `ref`, `source` et tout identifiant de session encore inconnu. Les paramètres retenus sont triés, donc l'ordre d'écriture n'influe pas.
- Barres obliques finales retirées.

`registrableDomain` réduit un hôte à son domaine enregistrable pour comparer un domaine de citation à celui d'une marque. Il s'appuie sur une liste de suffixes composés (`co.uk`, `com.au`, `co.jp`, …) plutôt que sur la Public Suffix List complète : elle couvre les suffixes réellement présents dans le corpus, et classe le reste en domaine à deux étiquettes.

---

## Scoring

`src/lib/scoring/`. Deux versions sont enregistrées, `v2` et `v3` ; `CURRENT_SCORING_VERSION` désigne `v3` (`versions/v3.ts`). Le score d'un échantillon vaut 0 à 100. Les poids, les formules et la redistribution ci-dessous sont identiques dans les deux versions ; elles diffèrent sur deux points, signalés là où ils se posent : ce qui compte comme marque présente, et ce qui compte comme source citée.

### Les règles

| Règle | Poids | Formule |
|---|---|---|
| `presence` | 35 | meilleur palier de correspondance : `EXACT` 1, `ALIAS` 0.85, `DOMAIN` 0.7, `APPROXIMATE` 0.35 |
| `prominence` | 15 | `0.6 × (1 − normalizedPosition) + 0.4 × rangScore`, où `rangScore` vaut 1 dans la première phrase, sinon `1 / (1 + orderRank)` |
| `frequency` | 10 | `min(1, ln(1 + n) / ln(6))` — saturation à 6 occurrences |
| `shareOfVoice` | 20 | `(marque + 1) / (marque + concurrents + 2)` — lissage de Laplace, pour qu'une réponse ne mentionnant qu'une seule entité ne donne pas un extrême |
| `citation` | 15 | `min(1, citations du domaine de la marque / 2)` |
| `sentiment` | signé, plancher −10 | `POSITIVE` +5, `NEUTRAL` 0, `MIXED` −2, `NEGATIVE` −10 |
| `competitorLead` | signé, plancher −8 | `− (concurrents nommés avant la marque / concurrents mentionnés)` |

`shareOfVoice` s'applique même lorsque la marque est absente : une réponse entièrement composée de concurrents est exactement ce que cette règle mesure. Les autres règles positives sont marquées inapplicables en l'absence de la marque, avec la note correspondante.

La marque est tenue pour présente dès qu'une occurrence lui est rattachée en `v2` ; en `v3`, une occurrence `APPROXIMATE` seule n'y suffit pas. La présence alimente `brandPresenceRate`, un chiffre de première page : elle repose donc sur une correspondance que la réponse a réellement écrite, une correspondance approximative n'étant qu'une hypothèse sur un jeton.

Le sentiment majoritaire tranche les égalités vers le verdict le plus sévère : une opinion partagée n'est pas une recommandation, donc `NEGATIVE` > `MIXED` > `NEUTRAL` > `POSITIVE` à égalité de comptes.

`competitorLead` compte les concurrents **distincts** dont la première mention précède celle de la marque, rapportés au nombre de concurrents mentionnés. Marque absente, tous les concurrents mentionnés la devancent.

`citation` est la règle dont la lecture diffère entre les deux versions enregistrées. En `v2`, une source `NATIVE` et un lien relevé dans le texte pèsent identiquement, seule la déduplication par URL normalisée les ayant départagés. En `v3`, seules les sources `NATIVE` sont créditées et comptent pour l'applicabilité de la règle : une URL que le modèle a tapée dans sa réponse fait partie de la réponse, et la créditer rendrait une réponse d'allure paramétrique indiscernable d'une réponse groundée. L'évidence est identique dans les deux cas ; c'est le barème qui change, donc un fichier de version distinct.

### Redistribution paramétrique

La règle `citation` a besoin que quelque chose ait été récupéré. En mode paramétrique, rien ne l'est par construction ; en mode groundé, une réponse renvoyée sans aucune source renseigne sur le fournisseur, pas sur la marque. Lui attribuer 0 sur 15 dans ces deux cas plafonnerait mécaniquement l'axe paramétrique à 85 points, et l'écart de récupération ne mesurerait plus qu'un artefact de barème.

Le budget de la règle est donc **redistribué** aux quatre règles positives encore applicables — `presence`, `prominence`, `frequency`, `shareOfVoice` — au prorata de leurs poids :

```
facteur = (35 + 15 + 10 + 20 + 15) / (35 + 15 + 10 + 20) = 95 / 80 = 1.1875
```

Chaque contribution concernée est multipliée par ce facteur et porte le drapeau `redistributed`, pour que la décomposition reste lisible et que l'interface puisse expliquer pourquoi une règle vaut plus que son poids nominal. La redistribution ne s'applique que si la marque est présente : sans elle, il n'y a rien à redistribuer.

Les deux axes s'expriment ainsi sur la même échelle, et leur différence garde un sens.

### Décomposition

`scoreSample` renvoie, pour chaque règle, une `ScoreContribution` :

```ts
interface ScoreContribution {
  ruleId: string;
  label: string;            // libellé français affiché
  weight: number;           // maximum de la règle, ou son plancher si négatif
  rawValue: number;         // sortie normalisée, [0,1] ou [-1,1]
  contribution: number;     // points signés réellement ajoutés
  applicable: boolean;      // faux quand la règle n'a pas de prise sur ce contexte
  redistributed: boolean;   // vrai quand elle a absorbé un budget redistribué
  evidence: { charOffsets?: number[]; citationIds?: string[]; note?: string };
}
```

Cette liste est **persistée telle qu'elle a été calculée**, puis rendue telle qu'elle a été persistée. Aucune vue ne la recalcule : ce qui est affiché est ce qui a été scoré.

### Sentiment

`src/lib/sentiment/judge.ts`. Un juge LLM évalue la tonalité des passages citant une entité, en utilisant la clé que l'utilisateur a déjà enregistrée pour le moteur configuré.

- **Cache adressé par contenu.** La fenêtre de contexte est la seule entrée du juge : des extraits identiques entre répétitions et entre runs touchent le cache, ce qui est le cas de la plupart. Un run de trois répétitions ne paie donc pas trois fois la même opinion.
- **Toujours facultatif.** Rien ici ne remonte d'exception : le sentiment est un enrichissement posé sur un appel déjà payé, et faire échouer le scoring parce que le juge est indisponible transformerait un échantillon réussi en échantillon perdu. Sans verdict, la règle est marquée inapplicable.
- Les extraits sont bornés à 400 caractères et les lots à 50 éléments par appel : une réponse pathologique ne doit pas construire un prompt non borné.
- La version du juge est enregistrée sur chaque mention, aux côtés du verdict.

`SENTIMENT_ENABLED=false` désactive entièrement la règle.

---

## Statistiques

`src/lib/scoring/stats.ts`. Fonctions pures : aucune E/S, aucune horloge, aucun aléa global.

### Pourquoi une distribution

![](../public/assets/sampling.png)

Deux appels identiques au même modèle ne produisent pas la même réponse. Un tirage unique est un tirage, pas une mesure. Chaque cellule est donc échantillonnée `repetitions` fois et résumée par :

| Grandeur | Calcul |
|---|---|
| `median` | quantile empirique de type 7, celui de R et de NumPy |
| `mean` | conservée pour la comparaison, jamais affichée seule |
| `ciLow` / `ciHigh` | bootstrap percentile sur la médiane, B = 2000, α = 0.05 |
| `mad` | écart absolu médian — point de rupture de 50 %, contrairement à la variance |
| `iqr` | Q3 − Q1 |
| `stability` | `clamp(1 − 1.4826 × mad / 25, 0, 1)` |
| `lowN` | `n < 5` au grain tâche, `n < 30` au grain run |

**Percentile plutôt que BCa** : le terme d'accélération de BCa repose sur un jackknife de la médiane, instable et parfois indéfini aux tailles d'échantillon que ce produit exécute réellement — `n = 3` est une tâche légitime.

**Stabilité fondée sur la MAD** : un échantillon aberrant isolé ne peut pas l'effondrer. Le facteur 1.4826 fait de la MAD un estimateur consistant de l'écart type sous une loi normale ; la dispersion est ramenée à zéro de stabilité à 25 points de score.

**`lowN`** ne masque rien : l'interface affiche alors une bande directionnelle au lieu d'un chiffre. L'intervalle reste calculé, mais il se lit comme une indication, pas comme une affirmation.

### Reproductibilité

Le bootstrap tire d'un xorshift128+ initialisé par une graine de chaîne (hachage FNV-1a par mot, état 64 bits tenu en paires d'uint32 — l'arithmétique BigInt coûterait plus cher que tout le bootstrap qu'elle alimente). La graine dérive de l'**identité** de l'agrégat, jamais d'une horloge :

```
seedFor([taskId, mode, scoringVersion])         // grain tâche
seedFor([runId, mode, scoringVersion])          // grain run
seedFor([runId, providerCode, mode])            // cellule (moteur, mode) composée en lecture
```

La cellule composée en lecture agrège les scores d'échantillons de la cellule, lus dans l'ordre de `sampleId` : `n` compte des échantillons aux trois niveaux, et l'intervalle ne dépend donc pas de l'ordre que la base a choisi de rendre.

Elle est ensuite persistée aux côtés du résultat. Rejouer un run rend donc exactement les mêmes bornes : sans cette garantie, « l'intervalle a bougé » ne se distinguerait jamais de « la marque a bougé ».

### Agrégation

`src/lib/scoring/aggregate.ts` remonte les scores d'échantillons vers deux grains :

- **Tâche** — `aggregateTask` écrit un `TaskScore` : médiane, intervalle, dispersion, stabilité, `nFailed` et `brandPresenceRate` sur les échantillons de la cellule.
- **Run** — `aggregateRun` écrit une ligne `RunScore` par mode, les deux axes n'étant jamais fondus, **et** toutes les lignes `VoiceShare`, au grain run comme au grain tâche.

Les parts de voix appartiennent entièrement à l'agrégation du run. Elles dérivent des mêmes mentions et des mêmes citations aux deux grains, et sont remplacées en bloc — `deleteMany` puis `createMany` sur `(runId, scoringVersion)` — parce que leur clé unique porte un `taskId` nullable que PostgreSQL traite comme distinct : un upsert accumulerait des doublons au grain run au lieu de les apparier. Le remplacement est transactionnel, donc aucun lecteur n'observe un run sans ses parts de voix.

Elles mesurent, pour la marque et chaque concurrent : `mentionShare` (occurrences rapportées au total), `presenceRate` (proportion d'échantillons où l'entité apparaît), `citationShare` (citations dont le domaine appartient à l'entité) et `avgOrderRank`. `sampleCount` accompagne chaque ligne pour servir de poids lors des regroupements en lecture.

L'agrégation est idempotente : les écritures sont des upserts, et le seul effet non idempotent — le décompte de `pendingTasks` — est gardé par la transition de statut qu'il accompagne, dans la même transaction. Un job repris, ou un replay d'un run déjà terminé, ne trouve plus de tâche à faire transiter et laisse le compteur intact.

---

## Replay et immuabilité des versions

### La règle

**Un fichier de version publié n'est jamais modifié.** Ni sous `scoring/versions/`, ni sous `parsing/extract/`. Tout changement de comportement est un nouveau fichier, enregistré dans le registre correspondant, et c'est ainsi que `v3` a livré ses deux écarts de barème sans toucher à `v2`. C'est la seule garantie de versionnement qui survive aux futurs remaniements des utilitaires partagés — un score persisté sous « v2 » doit rester reproductible sous « v2 ».

La version d'extraction et la version de scoring participent aux clés uniques de l'évidence et des scores : un échantillon rejoué sous un extracteur plus récent porte **les deux générations de lignes**, et chaque run ne lit que la sienne. Deux versions se comparent donc sur le même corpus au lieu de se détruire l'une l'autre.

### Comment un replay s'exécute

`POST /api/projects/:projectId/rescore` enfile un job `RESCORE_SAMPLE` par échantillon disposant d'une réponse stockée, par tranches de 500 pour ne jamais construire une instruction démesurée. Le handler :

1. relit `ai_responses.raw_text` ;
2. relit les citations `NATIVE` déjà extraites — elles sont le témoignage durable de ce que le fournisseur a réellement récupéré, la forme de la charge utile brute étant spécifique à chaque fournisseur et à chaque époque ;
3. appelle `persistSampleAnalysis`, exactement la même fonction que l'exécution en direct ;
4. met en file l'agrégation de la tâche, puis celle du run.

**Aucun fournisseur n'est appelé.** Un replay de dix mille échantillons hérite du débit, des reprises, de la progression et de l'annulation d'un run réel, sans consommer un crédit.

### Promotion

Rejouer et promouvoir sont deux gestes distincts. `promoteScoringVersion` fait d'une version celle que lisent les dashboards du projet ; elle ne se justifie qu'une fois les scores de cette version calculés. Les analyses conservent la version sous laquelle elles ont été planifiées : promouvoir ne réécrit pas l'histoire.
