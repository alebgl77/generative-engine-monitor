# 04 — Référence API

Toutes les routes vivent sous `src/app/api/`. Les formes de réponse sont déclarées dans `src/types/api.ts`, importé aussi bien par les handlers que par les pages.

## Conventions

**Authentification.** Le middleware ne protège que les pages. Chaque route API porte sa propre garde : `withAuth` exige une session, `withProject` exige en plus la propriété du projet. Les identifiants d'entités enfants sont recherchés avec leur `projectId`, si bien qu'un identifiant valide appartenant à un autre projet donne un `404` et non une écriture croisée.

**Erreurs.** Toute erreur renvoie `{ "error": "message en français" }` (`ApiErrorResponse`).

| Statut | Cas |
|---|---|
| `400` | corps JSON invalide, validation Zod, aucun champ à mettre à jour, précondition métier |
| `401` | session absente |
| `403` | le projet appartient à un autre utilisateur |
| `404` | ressource inexistante ou hors du projet |
| `409` | conflit d'unicité à l'inscription |
| `429` | seau à jetons épuisé |
| `500` | échec inattendu ; le détail va aux logs, jamais au client |

Les échecs de validation sont détaillés champ par champ : `Requête invalide — name: nom requis`.

**Normalisation.** Un champ `domain` accepte une URL complète et en conserve l'hôte : le schéma retire le préfixe de protocole, le chemin et le point final, met en minuscules, valide la forme et convertit la chaîne vide en `null`. Les tableaux `aliases` sont trimés, bornés à 20 éléments de 80 caractères et dédupliqués.

---

## Authentification

### `GET|POST /api/auth/[...nextauth]`

Handler NextAuth (fournisseur `credentials`, session JWT de 7 jours). Il expose les points d'entrée standard : `/api/auth/signin`, `/api/auth/callback/credentials`, `/api/auth/session`, `/api/auth/signout`.

### `POST /api/auth/register`

La seule mutation non authentifiée de l'API, et la seule à porter ses propres gardes.

```json
{ "email": "user@example.com", "password": "motdepasse1", "name": "Nom" }
```

- `email` : trimé, minusculé, 254 caractères maximum, format vérifié.
- `password` : 10 à 200 caractères, au moins une lettre et un chiffre.
- `name` : facultatif, 100 caractères maximum.

**`201`** → `{ "id": "...", "email": "...", "name": "..." | null }`

Un seau à jetons par adresse IP limite à 5 inscriptions par heure (`429`). L'unicité est laissée à l'index de la base : une vérification préalable laisserait une fenêtre où deux requêtes trouveraient l'adresse libre. Un doublon renvoie `409` avec un message qui ne révèle pas quelles adresses possèdent déjà un compte.

---

## Projets

### `GET /api/projects`

**`200`** → `ProjectSummary[]`, triés par date de mise à jour décroissante.

```ts
interface ProjectSummary {
  id: string; name: string; domain: string | null;
  targetCountry: string; targetLanguage: string;
  repetitions: number; samplingModes: SamplingMode[];
  activeScoringVersion: string; createdAt: string;
  counts: { brands: number; competitors: number; queries: number };
  lastRunAt: string | null;
}
```

`userId` en est délibérément absent : le client n'en a pas besoin, et le renvoyer ferait de chaque réponse un oracle de propriété.

### `POST /api/projects`

```json
{
  "name": "Mon site",
  "domain": "monsite.fr",
  "targetCountry": "FR",
  "targetLanguage": "fr",
  "repetitions": 3,
  "samplingModes": ["PARAMETRIC", "GROUNDED"]
}
```

`name` est requis (120 caractères maximum). `targetCountry` est un code ISO à deux lettres majuscules, `targetLanguage` à deux lettres minuscules. `repetitions` est un entier de 1 à 10. `samplingModes` contient au moins un mode et est dédupliqué. Les autres champs prennent les valeurs par défaut ci-dessus.

**`201`** → `ProjectSummary`

### `GET /api/projects/:projectId`

**`200`** → `ProjectSummary`

### `PUT /api/projects/:projectId`

Corps partiel, mêmes règles qu'à la création, tous les champs facultatifs. Un corps sans champ connu donne `400`.

**`200`** → `ProjectSummary`

### `DELETE /api/projects/:projectId`

**`200`** → `{ "success": true }`. Cascade sur marques, concurrents, requêtes, analyses et toute leur évidence.

---

## Marques et concurrents

Les deux ressources partagent la même forme.

### `GET /api/projects/:projectId/brands` · `…/competitors`

**`200`** → tableau des lignes Prisma, triées par date de création croissante : `{ id, projectId, name, domain, aliases, createdAt }`.

### `POST /api/projects/:projectId/brands` · `…/competitors`

```json
{ "name": "Ma marque", "domain": "mamarque.fr", "aliases": ["MaMarque", "MM"] }
```

`name` requis, 120 caractères maximum. **`201`** → la ligne créée.

### `PUT /api/projects/:projectId/brands/:brandId` · `…/competitors/:competitorId`

Corps partiel : `name`, `domain`, `aliases`. Un corps vide donne `400`.

**`200`** → la ligne mise à jour.

### `DELETE /api/projects/:projectId/brands/:brandId` · `…/competitors/:competitorId`

**`200`** → `{ "success": true }`

---

## Requêtes

### `GET /api/projects/:projectId/queries`

**`200`** → `{ id, projectId, text, isActive, createdAt }[]`, par date de création croissante.

### `POST /api/projects/:projectId/queries`

Deux formes, l'une ou l'autre obligatoire :

```json
{ "text": "meilleur CRM pour PME" }
```

```json
{ "queries": ["meilleur CRM pour PME", "alternative à Salesforce"] }
```

Le mode volumique accepte jusqu'à 200 entrées de 500 caractères, filtre les chaînes vides et déduplique. La création passe par une transaction et renvoie **les lignes créées**, jamais « les N dernières » — relire ainsi rendrait l'insertion concurrente d'un autre utilisateur.

**`201`** → la ligne créée pour `text`, le tableau des lignes créées pour `queries`.

### `PUT /api/projects/:projectId/queries/:queryId`

```json
{ "text": "…", "isActive": false }
```

Les deux champs sont facultatifs, un corps vide donne `400`. Désactiver plutôt que supprimer conserve l'historique des runs qui contenaient la requête.

**`200`** → la ligne mise à jour.

### `DELETE /api/projects/:projectId/queries/:queryId`

**`200`** → `{ "success": true }`

---

## Analyses

### `POST /api/projects/:projectId/runs`

Sans corps. Planifie une analyse à partir de l'état courant du projet.

**`202`** → `RunCreatedResponse`

```ts
interface RunCreatedResponse {
  runId: string;
  totalTasks: number;
  totalSamples: number;
  /** Cellules écartées parce que le moteur ne sert pas ce mode. */
  skipped: { providerCode: string; mode: SamplingMode; reason: string }[];
}
```

`202` et non `201` : le plan est durable, l'exécution appartient aux workers.

Un seau à jetons par utilisateur plafonne à 20 lancements par heure et est débité avant toute planification (`429`). `400` si aucune requête active, si aucun moteur n'est disponible, ou si aucune combinaison moteur/mode n'est exécutable.

### `GET /api/projects/:projectId/runs`

Les 20 analyses les plus récentes, décroissantes.

**`200`** → `RunsResponse`

```ts
interface RunSummary {
  id: string; status: RunStatus; scoringVersion: string;
  repetitions: number; modes: SamplingMode[];
  progress: { totalTasks: number; totalSamples: number; doneSamples: number; failedSamples: number };
  createdAt: string; startedAt: string | null; completedAt: string | null;
  tasks: RunTaskSummary[];
}

interface RunTaskSummary {
  id: string; mode: SamplingMode; status: TaskStatus;
  query: { id: string; text: string };
  provider: { code: string; label: string };
  samples: { total: number; done: number; failed: number };
  score: AxisSummary | null;
  errorMessage: string | null;
}
```

Le score d'une tâche est celui de la version de scoring **du run**, pas de la version active du projet : une analyse se relit avec les nombres qu'elle a produits.

### `GET /api/projects/:projectId/runs/:runId`

**`200`** → `RunDetailResponse` : un `RunSummary` complété de `tasksDetail`, où chaque tâche porte le détail de ses échantillons.

```ts
interface SampleDetail {
  id: string; sampleIndex: number; status: string;
  model: string | null; latencyMs: number | null; errorMessage: string | null;
  text: string | null;                    // tronqué à 4000 caractères
  score: number | null;
  contributions: ScoreContribution[];     // la décomposition telle que persistée
  mentions: { entityId: string; entityName: string; kind: "BRAND" | "COMPETITOR";
              mentionType: string; charOffset: number; occurrencesTotal: number;
              orderRank: number; sentiment: Sentiment | null; context: string }[];
  citations: { url: string; domain: string; title: string | null;
               isBrandDomain: boolean; sourceKind: string }[];
}
```

C'est la vue d'explicabilité : la réponse, les mentions avec leurs décalages, les citations avec leur origine, et le score décomposé règle par règle. Mentions et citations sont filtrées sur la version d'extraction du run — un échantillon rejoué sous un extracteur plus récent porte les deux générations de lignes.

`404` si l'analyse n'appartient pas au projet.

### `POST /api/projects/:projectId/runs/:runId/cancel`

Sans corps.

**`200`** → `{ "runId": "...", "status": RunStatus, "message": "..." }`

L'annulation est coopérative : les appels en attente sont abandonnés immédiatement, ceux en vol s'arrêtent à leur prochain heartbeat. Le statut renvoyé est relu après la demande, donc typiquement `CANCELLING`. Une seconde demande sur un run déjà en `CANCELLING` est acceptée sans effet supplémentaire. `400` si le run est déjà terminal (`COMPLETED`, `PARTIAL`, `FAILED`, `CANCELLED`).

---

## Replay

### `POST /api/projects/:projectId/rescore`

```json
{ "runId": "…", "scoringVersion": "v2" }
```

Les deux champs sont facultatifs. Sans `runId`, tous les échantillons du projet disposant d'une réponse stockée sont rejoués. Sans `scoringVersion`, la version courante est utilisée. Une version inconnue donne `400` avec la liste des versions disponibles.

**`202`** → `{ "jobs": number, "scoringVersion": string, "runId": string | null, "message": string }`

Aucun crédit API n'est consommé : le replay relit le texte déjà stocké. Le travail passe par la file de jobs, et hérite donc de sa progression, de ses reprises et de son annulation. `400` si l'analyse visée est encore en cours (`PENDING`, `RUNNING`, `CANCELLING`).

---

## Dashboard

Les trois routes lisent la dernière analyse `COMPLETED` **ou** `PARTIAL` du projet. Une analyse partielle a mesuré tout le reste : l'exclure viderait le dashboard pour la mauvaise raison. Sans analyse exploitable, elles renvoient `200` avec une charge vide.

### `GET /api/projects/:projectId/dashboard/overview`

**`200`** → `OverviewResponse`

```ts
interface OverviewResponse {
  scoringVersion: string;
  latestRun: { id: string; status: RunStatus; progress: RunProgress; completedAt: string | null } | null;
  grounded: AxisSummary | null;
  parametric: AxisSummary | null;
  retrievalGap: number | null;      // grounded.median - parametric.median
  totalQueries: number;
  shareOfVoice: EntityShare[];
  topSources: SourceRow[];          // 10 domaines
  scoreByProviderMode: ProviderModeScore[];
}

interface AxisSummary {
  median: number; ciLow: number; ciHigh: number;
  stability: number; n: number; lowN: boolean; brandPresenceRate: number;
}
```

`retrievalGap` vaut `null` si l'un des deux axes est absent. Les parts de voix par mode sont regroupées en pondérant par `sampleCount`, pour qu'un mode moins échantillonné ne domine pas le classement.

`scoreByProviderMode` agrège les **scores d'échantillons** de la cellule, lus depuis `sample_scores` et restreints aux échantillons `COMPLETED`, avec une graine dérivée de l'identité de la cellule — l'intervalle est donc stable d'une lecture à l'autre. Ce sont les scores persistés qui sont relus, jamais recalculés. Bootstrapper une médiane de médianes de tâches ferait compter `n` en requêtes ici et en échantillons dans `AxisSummary` : `n` compte des échantillons partout, sur cette route comme dans les agrégats écrits par le worker.

### `GET /api/projects/:projectId/dashboard/queries`

**`200`** → `QueriesResponse`

```ts
interface QueryRow {
  queryId: string; text: string;
  cells: QueryCell[];              // une par (moteur, mode) planifié
  brandPresenceRate: number;
  competitors: { name: string; mentionShare: number }[];
  avgCitations: number;
}
```

Une cellule est émise pour **chaque tâche planifiée**, scorée ou non : une cellule vide portant son `status` est ce qui indique au lecteur qu'un moteur a échoué à cet endroit.

### `GET /api/projects/:projectId/dashboard/sources`

**`200`** → `SourcesResponse` : `{ runId, rows }`, tous les domaines cités, décroissants.

```ts
interface SourceRow {
  domain: string; citationCount: number; sampleCount: number;
  citationShare: number; isBrandDomain: boolean;
  modes: SamplingMode[]; providers: string[]; queries: string[];
}
```

---

## Export

### `GET /api/projects/:projectId/export?format=csv|json`

Exporte la dernière analyse exploitable, une ligne par tâche : requête, moteur, mode, médiane, bornes de l'intervalle, stabilité, `n`, drapeau `lowN`, taux de présence de la marque, concurrents avec leur part de mentions, URL citées.

- `format=csv` (défaut) → `text/csv; charset=utf-8`, séparateur virgule, fins de ligne CRLF, BOM en tête sans lequel Excel lit les en-têtes accentués en Latin-1.
- `format=json` → charge `{ project, runId, scoringVersion, exportedAt, rows }`.

Les deux réponses portent un `Content-Disposition: attachment`. Le nom de fichier est dérivé du nom du projet après translittération et filtrage des caractères non alphanumériques : c'est une donnée utilisateur qui atterrit dans un en-tête.

Toute cellule CSV commençant par `=`, `+`, `-`, `@`, une tabulation ou un retour chariot est préfixée d'une apostrophe : les noms de concurrents et les URL viennent de sorties de modèles, et un tableur les interpréterait comme des formules.

`400` s'il n'existe aucune analyse terminée. L'export est journalisé dans `audit_logs`.

---

## Moteurs et identifiants

### `GET /api/providers`

**`200`** → `ProviderSummary[]` — les moteurs actifs globalement, avec l'indication d'une clé enregistrée pour l'utilisateur courant.

```ts
interface ProviderSummary {
  id: string; code: string; label: string;
  supportsParametric: boolean; supportsGrounded: boolean;
  defaultModel: string; hasCredential: boolean;
}
```

`defaultModel` provient de la ligne en base quand elle est renseignée, sinon du registre, qui résout la variable d'environnement.

### `GET /api/providers/credentials`

**`200`** → `CredentialSummary[]`

```ts
interface CredentialSummary {
  id: string; providerId: string; providerCode: string; providerLabel: string;
  maskedKey: string;              // "••••1234"
  keyVersion: number;
  isValid: boolean;
  lastValidatedAt: string | null;
  validationError: string | null;
}
```

**Aucune route ne renvoie une clé en clair.**

### `POST /api/providers/credentials`

```json
{ "providerId": "…", "apiKey": "sk-…" }
```

La clé est vérifiée auprès du moteur (budget de 15 secondes) **avant** d'être stockée : l'accepter sur parole déplacerait l'échec au premier run, où découvrir une faute de frappe coûte une campagne entière de tâches échouées. Elle est ensuite chiffrée en AES-256-GCM avec la paire `(userId, providerId)` en données additionnelles authentifiées. Une clé refusée est stockée quand même, avec sa raison, pour que la page de configuration montre ce qui ne va pas plutôt que de perdre ce que l'utilisateur a saisi. L'upsert est borné par `(userId, providerId)`, donc réenvoyer une clé la remplace.

**`201`** → `CredentialSummary`

### `POST /api/providers/credentials/:credentialId`

Revalide une clé stockée. Le texte clair n'existe que dans l'appel : il n'est ni renvoyé, ni journalisé, ni audité. Un déchiffrement impossible — clé de chiffrement retirée, ligne altérée — donne un verdict invalide portant « Clé illisible : elle doit être ressaisie » plutôt qu'une erreur `500`.

**`200`** → `CredentialSummary`

### `DELETE /api/providers/credentials/:credentialId`

**`200`** → `{ "success": true }`. La suppression est bornée par `userId`.
