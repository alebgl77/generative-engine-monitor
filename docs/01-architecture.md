# 01 — Architecture

## Deux processus, une base

L'application se compose de deux processus qui ne partagent que PostgreSQL.

| Processus | Rôle | Commande |
|---|---|---|
| **web** | Next.js 16 App Router : pages, routes API, planification des analyses | `npm run dev` / `npm start` |
| **worker** | draine la file de jobs : appels fournisseurs, extraction, scoring, agrégation, replay | `npm run worker` |

Aucun appel fournisseur n'a lieu dans le cycle de vie d'une requête HTTP. Un appel groundé dispose d'un budget de 180 secondes, ce qui dépasse tout délai de passerelle raisonnable ; et surtout, un run représente `requêtes × moteurs × modes × répétitions` appels payants, dont l'exécution doit survivre au redéploiement du conteneur web. Le web planifie et lit, le worker exécute.

Le worker est réplicable : plusieurs instances drainent la même file sans coordination externe, la réclamation des jobs étant sérialisée par PostgreSQL.

```
Navigateur
    │  HTTPS
    ▼
Next.js  ── proxy (pages) ────── route helpers (session + propriété)
    │                                      │
    │ POST /runs → planRun()               │ GET /dashboard/* → lecture
    ▼                                      ▼
┌─────────────────────── PostgreSQL ───────────────────────┐
│  runs · run_tasks · run_samples · ai_responses           │
│  citations · brand_mentions · competitor_mentions        │
│  sample_scores · task_scores · run_scores · voice_shares │
│  jobs · rate_limit_buckets · provider_credentials        │
└──────────────────────────────────────────────────────────┘
    ▲                                       ▲
    │ claim / heartbeat / complete          │ sweep
    ▼                                       │
Worker ─ sémaphore par moteur ─ seau à jetons ─ appel HTTPS fournisseur
```

## Chemin d'une requête

### Lecture (les vues du dashboard)

1. `src/proxy.ts` protège les pages sous `/projects/**` via NextAuth. Il ne protège pas les routes API : chaque handler porte sa propre garde.
2. Le handler passe par `withAuth` ou `withProject` (`src/lib/api/route-helpers.ts`). `withProject` charge le projet, renvoie `404` s'il n'existe pas et `403` s'il appartient à quelqu'un d'autre.
3. La requête Prisma agrège des lignes déjà calculées. Les vues ne recalculent jamais le score d'un échantillon : elles lisent `sample_scores`, `task_scores`, `run_scores` et `voice_shares`, écrits par le worker.
4. La réponse est typée par `src/types/api.ts`, module partagé par les routes et les pages : un changement de forme devient une erreur de compilation des deux côtés.

Une exception assumée : la synthèse compose l'agrégat par couple (moteur, mode) en lecture, à partir des scores d'échantillons persistés de la cellule — pas des médianes de tâches, qui feraient compter `n` en requêtes ici et en échantillons sur les cartes d'axe, deux sens pour le même chiffre sur la même page. La graine dérive de l'identité de la cellule — `seedFor([runId, providerCode, mode])` — et l'intervalle est donc identique à chaque lecture du même run, non un nouveau tirage par requête. La lecture est ordonnée par `sampleId`, le bootstrap rééchantillonnant par index.

### Écriture (le lancement d'une analyse)

`POST /api/projects/:projectId/runs` :

1. Un seau à jetons par utilisateur plafonne les lancements (20 par heure). Il est débité **avant** toute planification : un run engage des crédits fournisseurs réels.
2. `planRun()` (`src/lib/runs/plan.ts`) résout les cellules exécutables : moteurs disposant d'une clé valide, plus le moteur `mock` qui n'en demande aucune, croisés avec les modes du projet. Une cellule qu'un moteur ne peut pas servir — Perplexity en paramétrique — est retournée dans `skipped` ; ce n'est pas une erreur.
3. Une transaction unique crée le `Run`, tous ses `RunTask`, tous ses `RunSample` et tous les jobs `RUN_SAMPLE`. Rien n'est créé paresseusement : la progression est un compteur, pas une estimation, et un crash de worker ne peut pas perdre du travail qui n'aurait jamais été écrit. La transaction dispose d'un budget de 30 secondes, la matérialisation d'un grand run représentant beaucoup d'insertions.
4. Le run mémorise les versions de scoring et d'extraction en vigueur au moment du plan, si bien qu'il reste interprétable après que le projet a adopté une version plus récente.
5. La route répond `202` avec `runId`, `totalTasks`, `totalSamples` et `skipped`.

## La file de jobs

`src/lib/queue/` — table `jobs`, aucune infrastructure supplémentaire.

Le grain est **un job par `RunSample`**, c'est-à-dire un job par appel payant. C'est la frontière naturelle du délai, de la reprise, du backoff, de la limitation de débit et de l'annulation. Un job par tâche rejouerait des appels déjà payés à chaque reprise ; un job par run ne donnerait aucun parallélisme et laisserait une clé morte couler l'ensemble.

### Réclamation

```sql
WITH candidate AS (
  SELECT id FROM jobs
  WHERE status = 'QUEUED' AND available_at <= now()
    AND provider_code = ANY($providerCodes)
  ORDER BY priority DESC, available_at ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $limit
)
UPDATE jobs j SET status = 'RUNNING', locked_by = $workerId,
                  lease_expires_at = now() + 90s, attempts = attempts + 1
  FROM candidate c WHERE j.id = c.id RETURNING j.*
```

`SKIP LOCKED` fait que des workers concurrents prennent des lots disjoints sans se bloquer. `attempts` est incrémenté à la réclamation, pas à l'échec : un worker qui meurt avant d'écrire quoi que ce soit a tout de même consommé une tentative, ce qui borne les jobs capables de tuer leur worker.

Toutes les comparaisons temporelles en SQL brut passent par `(now() AT TIME ZONE 'utc')`. Prisma stocke les `DateTime` en `timestamp(3)` d'horloge murale UTC ; un `now()` nu se convertirait selon le fuseau de la session et décalerait chaque bail et chaque backoff.

### Types de jobs

| Kind | Charge utile | Effet |
|---|---|---|
| `RUN_SAMPLE` | un échantillon à mesurer | appel fournisseur, extraction, scoring, transition terminale de l'échantillon |
| `AGGREGATE_TASK` | une tâche | médiane, IC, stabilité et taux de présence de la cellule, puis transition de la tâche |
| `AGGREGATE_RUN` | un run | agrégats par mode, parts de voix aux deux grains — run et tâche —, statut final |
| `RESCORE_SAMPLE` | un échantillon et une version cible | replay depuis le texte stocké, sans appel réseau |

Les jobs d'agrégation ne sont liés à aucun moteur : ils portent le code `internal`, ce qui garde la requête de réclamation uniforme et leur donne leur propre sémaphore. Ils passent en priorité 10 devant les échantillons, car ils sont courts et débloquent le rapport du run.

### Limitation de débit et concurrence

Deux mécanismes distincts :

- **Sémaphore en mémoire**, un par moteur, dimensionné par `providers.max_concurrency`. Il borne ce qu'un processus lance simultanément et détermine le nombre de jobs que la boucle réclame.
- **Seau à jetons persisté**, un par moteur, dimensionné par `providers.rpm_limit`. La limite qui compte est celle du fournisseur : trois conteneurs partageant une clé doivent partager un seau. Le remplissage est calculé paresseusement dans l'instruction consommatrice, sans horloge applicative ni dérive entre processus. Vérification et débit ont lieu dans la même instruction, faute de quoi deux workers passeraient tous deux le test. Un seau absent échoue en refus : un moteur inconnu ne reçoit pas une allocation illimitée.

Un refus du seau n'est **pas** un échec : le job est remis en file immédiatement avec sa tentative rendue (`release`), et l'échantillon reste en vol. Le budget de reprise est réservé aux vraies erreurs.

## La boucle du worker

`src/worker/main.ts`.

```
démarrage
  ├─ valide l'environnement, journalise les modèles résolus
  ├─ construit un sémaphore et un seau par moteur
  └─ balayage de démarrage (reprend ce qu'un arrêt brutal a laissé)

boucle (tant que non arrêté)
  ├─ capacité libre ? sinon pause 200 ms
  ├─ claim(limit = min(WORKER_BATCH_SIZE, capacité))
  ├─ rien ? pause 1 s
  └─ dispatch de chaque job sous son sémaphore, pause plancher 50 ms

timers
  ├─ heartbeat toutes les 25 s   (bail de 90 s)
  └─ balayage toutes les 30 s
```

Le plancher de 50 ms entre deux tours existe parce qu'un job étranglé revient en file sans pénalité : sans lui, un moteur en limitation transformerait la boucle en cycle claim/release contre la base.

### Bail et heartbeat

Un job réclamé porte un bail de 90 secondes. Toutes les 25 secondes, le worker prolonge en une seule instruction le bail de tous les jobs qu'il détient encore, et apprend dans la même réponse lesquels appartiennent à un run que l'utilisateur a demandé d'annuler :

```sql
UPDATE jobs j SET lease_expires_at = now() + 90s, heartbeat_at = now()
  FROM jobs cur LEFT JOIN runs r ON r.id = cur.run_id
 WHERE cur.id = j.id AND j.id = ANY($ids)
   AND j.locked_by = $workerId AND j.status = 'RUNNING'
RETURNING j.id, (r.cancel_requested_at IS NOT NULL) AS cancelled
```

Vivacité et annulation sont la même question pour un worker : elles coûtent une instruction, pas deux. Un job absent du résultat a perdu son bail — le worker avorte son `AbortController`, ce qui interrompt l'appel HTTP en cours. Un échec du heartbeat lui-même n'avorte rien : une coupure réseau passagère n'est pas la preuve que le bail est perdu, et le balayeur reste l'autorité sur ce point.

### Reprise des orphelins

`src/lib/queue/sweeper.ts`, exécuté au démarrage puis toutes les 30 secondes par chaque worker. Le balayeur ne surveille aucune progression : il ne répare que ce qu'aucun processus n'est plus là pour réparer. L'ordre des trois passes est significatif.

1. **`sweepExpiredLeases`** — les jobs `RUNNING` dont le bail a expiré retournent en file avec un backoff exponentiel jitté, calculé en SQL avec un `random()` par ligne pour qu'une expiration massive ne revienne pas en vague synchronisée. Ceux qui ont épuisé leur budget de tentatives passent `DEAD` et ne sont jamais repris automatiquement : un job qui a tué son worker à chaque tentative recommencera.
2. **`reconcileOrphanSamples`** — un échantillon `RUNNING` sans job `QUEUED` ni `RUNNING` derrière lui n'a plus de propriétaire et n'en aura plus. Il est marqué `FAILED` et les compteurs de sa tâche sont corrigés dans la même instruction, sinon le run resterait en attente indéfiniment. Un délai de grâce d'une durée de bail couvre la fenêtre entre l'état terminal d'un job et l'écriture de son échantillon, qui ne sont pas toujours la même transaction.
3. **`finalizeStuckCancellations`** — les jobs `QUEUED` d'un run en `CANCELLING` sont annulés, puis le run passe `CANCELLED` dès que plus rien n'est en vol.

Les baux d'abord : un job qui vient de revenir en file protège encore son échantillon d'être déclaré orphelin. Les annulations en dernier : un run dont le dernier job vient de mourir est finalisé dans la même passe.

### Annulation

L'annulation est **coopérative**.

1. `POST /api/projects/:projectId/runs/:runId/cancel` appelle `requestCancel()`, qui dans une transaction passe le run en `CANCELLING`, horodate `cancelRequestedAt`, annule tous les jobs `QUEUED` du run et bascule en `CANCELLED` les échantillons et tâches restés `PENDING`.
2. Les jobs `RUNNING` sont délibérément laissés tels quels : ils détiennent un appel payant en vol et l'apprennent à leur prochain heartbeat, ce qui leur permet d'avorter et d'enregistrer eux-mêmes leur résultat. Les forcer depuis l'extérieur laisserait un échantillon sans état terminal.
3. Un handler qui détecte l'avortement distingue les deux causes possibles : si le run porte une demande d'annulation, l'échantillon est terminal (`CANCELLED`) ; sinon il s'agit d'un arrêt du worker ou d'une perte de bail, et l'échantillon doit rester en vol pour que la tentative suivante le termine.
4. Le balayeur ferme le run quand plus aucun job n'est ni en file ni en cours.

### Arrêt gracieux

`src/worker/shutdown.ts` intercepte `SIGTERM` et `SIGINT`. La boucle cesse de réclamer, les jobs en vol disposent de 25 secondes pour finir, ceux qui débordent sont avortés puis disposent de 2 secondes pour enregistrer leur propre résultat ; les baux restants sont rendus explicitement. Sans cette restitution, un déploiement immobiliserait un run pendant la durée d'un bail complet. Un second signal force la sortie.

## Frontières et invariants

- **Une seule voie vers l'évidence et le score** : `persistSampleAnalysis` (`src/lib/runs/persist.ts`) sert aussi bien à l'exécution en direct qu'au replay. Rejouer un run doit produire exactement ce que l'exécuter aujourd'hui produirait, donc il ne peut pas exister deux implémentations susceptibles de diverger.
- **Les reprises appartiennent à la file, pas à la couche HTTP.** Une reprise coûte un appel payant : elle doit être visible dans le compteur de tentatives et dans le backoff du job, pas dissimulée dans un utilitaire.
- **Idempotence partout où un job peut être rejoué.** Les écritures d'évidence sont des suppressions puis insertions bornées par version d'extraction ; les scores sont des upserts ; le seul effet non idempotent — le décompte de `pendingTasks` — est gardé par la transition de statut qu'il accompagne, dans la même transaction.
- **Le scoring précède la transaction terminale.** Cette transaction met en file l'agrégation dès que l'échantillon est le dernier en attente, et un worker voisin peut la réclamer immédiatement : un score écrit après coup rendrait l'agrégat plus court d'un échantillon.
