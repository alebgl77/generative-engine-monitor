# 03 — Base de données

Schéma : `prisma/schema.prisma`. PostgreSQL 16, Prisma 5. Les noms de colonnes sont en `snake_case` via `@map`, les modèles en `PascalCase`.

## Le grain de mesure

Trois niveaux, du plus grossier au plus fin. C'est la décision structurante de tout le schéma.

| Niveau | Table | Ce que c'est | Cardinalité |
|---|---|---|---|
| `Run` | `runs` | une campagne de mesure pour un projet | 1 par lancement |
| `RunTask` | `run_tasks` | une cellule : requête × moteur × mode | `requêtes × moteurs × modes` |
| `RunSample` | `run_samples` | **un appel API payant** | `tâches × répétitions` |

La cellule est l'unité d'agrégation ; l'échantillon est l'unité d'exécution, de coût, de reprise et de preuve.

### Pourquoi l'évidence pend à l'échantillon et les scores sont des distributions

Une **évidence** appartient à une réponse et à une seule. Une mention se situe au caractère 412 *de cette réponse-là* ; une citation a été renvoyée *par cet appel-là*. Rattacher ces lignes à la tâche obligerait à choisir un échantillon représentatif, c'est-à-dire à jeter la variance qu'on cherche précisément à mesurer.

Un **score**, à l'inverse, n'a de sens qu'en tant que distribution. Un moteur interrogé trois fois avec la même requête peut citer la marque en tête, puis pas du tout, puis en quatrième position. Le nombre publié est donc une médiane assortie d'un intervalle de confiance, calculée sur les scores d'échantillons — et ces scores d'échantillons, eux, sont bien stockés, car ils sont l'entrée de l'agrégat et la seule façon de le recalculer.

D'où la répartition :

```
RunSample ─┬─ AIResponse          (texte brut + JSON brut, 1:1)
           ├─ Citation[]          (évidence)
           ├─ BrandMention[]      (évidence, une ligne par occurrence)
           ├─ CompetitorMention[] (évidence, une ligne par occurrence)
           └─ SampleScore[]       (score brut, une ligne par version de scoring)

RunTask   ─┬─ TaskScore[]         (médiane, IC, MAD, IQR, stabilité)
           └─ VoiceShare[]        (part de voix au grain tâche)

Run       ─┬─ RunScore[]          (une ligne par mode : les deux axes ne fusionnent jamais)
           └─ VoiceShare[]        (part de voix au grain run, taskId null)
```

## Tables

### Authentification et projets

**`users`** — email unique, hash bcrypt (coût 12).

**`projects`** — porte la politique d'échantillonnage : `repetitions` (défaut 3) pilote la largeur de l'intervalle, `samplingModes` (défaut `[PARAMETRIC, GROUNDED]`) pilote la séparation des deux axes, `activeScoringVersion` désigne la version que lisent les dashboards. `targetCountry` et `targetLanguage` sont injectés dans le prompt système pour que les réponses reflètent le marché visé.

**`brands`** et **`competitors`** — nom, domaine facultatif, `aliases[]`. Les alias alimentent directement l'extracteur : un alias mal saisi devient une mention manquante, pas une erreur visible.

**`queries`** — texte et `isActive`. Seules les requêtes actives sont planifiées ; désactiver plutôt que supprimer conserve l'historique des runs qui les contenaient.

### Moteurs et identifiants

**`providers`** — `code` unique, `label`, drapeaux de capacité `supports_parametric` / `supports_grounded` qui décident des modes planifiables, `default_model`, `rpm_limit` et `max_concurrency` qui dimensionnent seau à jetons et sémaphore.

**`provider_credentials`** — une clé API chiffrée par couple `(userId, providerId)`, contrainte unique. Les colonnes `cipher_text`, `iv`, `auth_tag` portent un chiffré AES-256-GCM ; `key_version` indexe la carte `CREDENTIAL_KEYS` pour permettre la rotation sans interruption ; `fingerprint` est un HMAC poivré qui permet de repérer une clé déjà stockée sans rien déchiffrer ; `last_four` alimente l'affichage masqué. `is_valid`, `last_validated_at` et `validation_error` conservent le verdict du dernier contrôle.

### Analyses

**`runs`** — `scoring_version` et `extraction_version` sont figées au moment du plan, jamais lues depuis le projet à la volée : un run reste lisible avec les nombres qu'il a produits. Les compteurs `total_tasks`, `pending_tasks`, `total_samples`, `done_samples`, `failed_samples` portent la progression, décrémentés dans la transaction qui écrit le résultat. `cancel_requested_at` matérialise une demande d'annulation, que les workers découvrent à leur heartbeat.

**`run_tasks`** — clé unique `(runId, queryId, providerId, mode)` : replanifier un run ne peut pas dupliquer une cellule. Compteurs `planned_samples`, `pending_samples`, `done_samples`, `failed_samples`.

**`run_samples`** — clé unique `(taskId, sampleIndex)`. Métadonnées de l'appel : `model` réellement utilisé, `latency_ms`, `tokens_in` / `tokens_out`, `cost_micros`, `attempt`, `error_code`, `error_message`.

### Évidence

**`ai_responses`** — `raw_text` et `raw_json`, en 1:1 avec l'échantillon. `raw_json` est délibérément non nullable : c'est le substrat qui rend le replay possible. Les métadonnées natives de grounding doivent y être stockées verbatim, jamais pré-digérées, sinon une future version de scoring ne peut plus en redériver les citations.

**`citations`** — URL d'origine, `normalized_url` (déduplication), `domain`, `title`, `position`, `is_brand_domain`, et `source_kind` :

| `source_kind` | Signification |
|---|---|
| `NATIVE` | métadonnées de grounding du fournisseur : une source réellement récupérée |
| `INLINE_MARKDOWN` | lien markdown dans le texte de la réponse ; peut être récité plutôt que récupéré |
| `BARE_URL` | URL nue dans le texte |

Clé unique `(sampleId, normalizedUrl, extractionVersion)` : une même page citée deux fois ne compte qu'une fois, et deux versions d'extraction coexistent sans s'écraser.

**`brand_mentions`** et **`competitor_mentions`** — **une ligne par occurrence**, pas une par entité. C'est ce qui rend la proéminence et la fréquence mesurables. Chaque ligne porte `mention_type` (`EXACT`, `ALIAS`, `DOMAIN`, `APPROXIMATE`), `occurrence_index`, `char_offset`, `sentence_index`, `normalized_position` dans `[0,1]`, `in_first_sentence`, `order_rank` (rang de première apparition parmi toutes les entités, 0 = nommée en premier), `occurrences_total`, un extrait `context`, une `confidence`, et le verdict de sentiment avec la version du juge qui l'a produit. Clé unique `(sampleId, entityId, extractionVersion, occurrenceIndex)`.

### Scores

**`sample_scores`** — un score brut par couple `(sampleId, scoringVersion)`. Les caractéristiques utiles aux vues sont dénormalisées (`brand_present`, `brand_order_rank`, `brand_occurrences`, `competitor_count`, `citation_count`, `brand_domain_cited`, `share_of_voice`), et `contributions` porte la décomposition signée par règle avec les décalages de texte qui la justifient. Elle est stockée en JSONB plutôt qu'en table parce qu'elle est toujours lue comme un tout pour un échantillon donné, et jamais filtrée ni agrégée en SQL.

**`task_scores`** — agrégat sur les échantillons d'une cellule : `n`, `n_failed`, `median`, `mean`, `ci_low`, `ci_high`, `ci_method`, `mad`, `iqr`, `stability`, `low_n`, `brand_presence_rate`. `bootstrap_seed` est persistée pour que l'intervalle soit reproductible au bit près lors d'un replay : sans elle, « l'intervalle a bougé » ne se distinguerait pas de « la marque a bougé ».

**`run_scores`** — une ligne par couple `(run, mode)`. Les deux axes ne sont jamais fondus en un nombre unique : ils répondent à des questions différentes, et les moyenner effacerait le seul diagnostic actionnable qu'ils portent ensemble, l'écart de récupération.

**`voice_shares`** — part de voix au grain run (`task_id` nul) et au grain tâche. Porte `mention_share`, `presence_rate`, `citation_share`, `avg_order_rank` et `sample_count` pour la marque comme pour chaque concurrent. `sample_count` sert de poids lorsque les modes sont regroupés côté lecture, afin qu'un mode moins échantillonné ne domine pas le classement.

**`sentiment_judgments`** — cache adressé par contenu, clé `cache_key`. La fenêtre de contexte est la seule entrée du juge : des extraits identiques entre répétitions et entre runs touchent le cache, ce qui est le cas de la plupart.

### File et audit

**`jobs`** — voir [01 — Architecture](01-architecture.md). `sample_id` est unique : cette contrainte rend l'enfilement des jobs `RUN_SAMPLE` idempotent, une replanification réinsérant les mêmes lignes que `skipDuplicates` écarte au lieu de dupliquer des appels payants. Index sur `(status, provider_code, available_at, priority)` pour la réclamation, sur `(status, lease_expires_at)` pour le balayeur.

**`rate_limit_buckets`** — seau à jetons, rempli paresseusement en SQL pour rester correct entre processus.

**`audit_logs`** — inscriptions, création et invalidation d'identifiants, lancements et annulations d'analyses, replays, exports. `user_id` passe à `NULL` si le compte disparaît, la trace survit.

## Énumérations

| Enum | Valeurs |
|---|---|
| `SamplingMode` | `PARAMETRIC`, `GROUNDED` |
| `RunStatus` | `PENDING`, `RUNNING`, `COMPLETED`, `PARTIAL`, `FAILED`, `CANCELLING`, `CANCELLED` |
| `TaskStatus` | `PENDING`, `RUNNING`, `COMPLETED`, `PARTIAL`, `FAILED`, `CANCELLED` |
| `SampleStatus` | `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `JobStatus` | `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `DEAD` |
| `JobKind` | `RUN_SAMPLE`, `AGGREGATE_TASK`, `AGGREGATE_RUN`, `RESCORE_SAMPLE` |
| `CitationSource` | `NATIVE`, `INLINE_MARKDOWN`, `BARE_URL` |
| `MentionType` | `EXACT`, `ALIAS`, `DOMAIN`, `APPROXIMATE` |
| `Sentiment` | `POSITIVE`, `NEUTRAL`, `NEGATIVE`, `MIXED` |
| `EntityKind` | `BRAND`, `COMPETITOR` |

`PARTIAL` mérite une mention : une analyse dont certains échantillons ont échoué mais dont il en reste assez pour scorer n'est jamais rapportée comme `COMPLETED`. Les vues la traitent comme exploitable, l'interface la signale comme incomplète. `DEAD`, côté file, signifie qu'un job a perdu son bail au-delà de son budget de tentatives : il réclame une intervention humaine et n'est jamais repris automatiquement.

## Versionnement et coexistence

Les versions d'extraction et de scoring participent aux clés uniques de l'évidence et des scores. Un échantillon rejoué sous un extracteur plus récent porte donc **les deux générations de lignes**, et chaque run ne lit que la sienne. C'est ce qui permet de comparer deux versions sur le même corpus au lieu de détruire l'ancienne mesure pour obtenir la nouvelle.

## Suppressions en cascade

`User → Project → {Brand, Competitor, Query, Run} → RunTask → RunSample → {AIResponse, Citation, Mention, SampleScore, Job}`. Supprimer un projet efface toute son histoire de mesure ; les `audit_logs` d'un utilisateur supprimé survivent avec un `user_id` nul.

## Index notables

| Table | Index | Usage |
|---|---|---|
| `runs` | `(project_id, status, created_at DESC)` | dernier run exploitable d'un projet |
| `run_tasks` | `(project_id, query_id, mode, created_at DESC)` | évolution d'une requête dans le temps |
| `citations` | `(run_id, domain)`, `(project_id, domain)` | vue Sources |
| `sample_scores` | `(run_id, scoring_version)`, `(task_id, scoring_version)` | agrégation et replay |
| `jobs` | `(status, provider_code, available_at, priority)` | réclamation |
| `jobs` | `(status, lease_expires_at)` | balayage des baux expirés |
