# 07 — Pipeline d'exécution

## Vue d'ensemble

```
POST /runs
   │
   ├─ seau à jetons utilisateur (20 lancements/h)
   ├─ planRun() : résolution des cellules exécutables
   └─ transaction unique
        ├─ Run          (RUNNING)
        ├─ RunTask[]    (PENDING)   une par requête × moteur × mode
        ├─ RunSample[]  (PENDING)   une par répétition
        └─ Job[]        (QUEUED)    kind = RUN_SAMPLE, une par échantillon
   → 202

Worker : claim → RUN_SAMPLE
   ├─ échantillon → RUNNING
   ├─ clé déchiffrée (sauf mock)
   ├─ seau à jetons du moteur         ─ refus → release, tentative rendue
   ├─ appel fournisseur               ─ budget 60 s / 180 s selon le mode
   ├─ persistSampleAnalysis()         ─ extraction, sentiment, scoring
   └─ transaction terminale
        ├─ AIResponse enregistrée
        ├─ échantillon → COMPLETED | FAILED
        ├─ compteurs de la tâche et du run
        └─ pendingSamples == 0 → enfile AGGREGATE_TASK (priorité 10)

AGGREGATE_TASK
   ├─ TaskScore
   ├─ tâche → COMPLETED | PARTIAL | FAILED | CANCELLED
   └─ pendingTasks == 0 → enfile AGGREGATE_RUN

AGGREGATE_RUN
   ├─ RunScore par mode
   ├─ VoiceShare, aux deux grains : run (taskId nul) et tâche
   └─ run → COMPLETED | PARTIAL | FAILED | CANCELLED
```

Les parts de voix sont toutes écrites par `AGGREGATE_RUN`, y compris celles du grain tâche : elles se calculent sur les mêmes mentions et les mêmes citations, et le remplacement est un `deleteMany` puis `createMany` par `(runId, scoringVersion)` — la clé unique porte un `taskId` nullable, que PostgreSQL traite comme distinct, si bien qu'un upsert dupliquerait les lignes de grain run. Les écrire depuis les deux jobs ferait de plus courir le balayage du grain run contre les tâches encore en cours d'agrégation.

Rien ne surveille de progression. Chaque transition est portée par des compteurs décrémentés dans la transaction qui écrit le résultat : la fin d'un run est un événement, pas une observation.

## Cycle de vie d'un job

```
                 claim (attempts += 1)
   QUEUED ─────────────────────────────► RUNNING
      ▲                                     │
      │  fail(retryable) : backoff jitté    ├─► SUCCEEDED   complete()
      ├─────────────────────────────────────┤
      │  release() : attempts −= 1          ├─► FAILED      fail(non repris)
      ├─────────────────────────────────────┤              ou budget épuisé
      │  bail expiré, budget restant        ├─► CANCELLED   run annulé
      └─────────────────────────────────────┘
                                            └─► DEAD        bail perdu,
                                                            budget épuisé
```

### Reprises

| Paramètre | Valeur |
|---|---|
| Tentatives maximales | 4 |
| Délai de base | 5 s |
| Délai maximal | 600 s |
| Jitter | × U(0.5, 1.5) |

`délai = min(600, 5 × 2^tentatives) × facteur`. Le jitter évite qu'une panne fournisseur ne fasse revenir tous les jobs en une vague synchronisée. Un en-tête `Retry-After` renvoyé par le fournisseur prime sur ce calcul.

`attempts` est incrémenté à la **réclamation**, non à l'échec : un worker qui meurt sans rien écrire a tout de même consommé une tentative, ce qui borne les jobs capables de tuer leur worker. Les erreurs reprises sont `RATE_LIMIT`, `TIMEOUT`, `SERVER` et `NETWORK` ; les autres sont terminales sur-le-champ, une reprise ne pouvant rien changer à un `AUTH` ou un `BAD_REQUEST`.

### Ce qui n'est pas un échec

Deux situations remettent le job en file **sans consommer de tentative** (`release`) :

- **Refus du seau à jetons.** Une limitation de débit n'est pas une erreur : le budget de reprise est réservé aux vraies pannes.
- **Arrêt du worker ou perte de bail.** Le job change de propriétaire, il ne rate rien.

### `DEAD`

Un job dont le bail expire alors que son budget de tentatives est épuisé passe `DEAD` et n'est jamais repris automatiquement : un job qui a tué son worker à chaque tentative recommencera. C'est un état qui appelle une intervention humaine, et il est délibérément visible plutôt que silencieusement recyclé.

### Écritures gardées

`complete`, `fail` et `release` conditionnent leur mise à jour au statut `RUNNING`. Un worker qui a perdu son bail et rend son verdict en retard ne peut donc pas écraser un job que le balayeur a déjà repris.

## Cycle de vie d'un échantillon

```
PENDING ──► RUNNING ──┬──► COMPLETED   réponse obtenue et stockée
                      ├──► FAILED      erreur terminale, ou orphelin repris par le balayeur
                      └──► CANCELLED   run annulé
```

Chaque chemin de sortie du handler doit **soit** mener l'échantillon à un état terminal exactement une fois, **soit** laisser l'échantillon et le job intacts pour une tentative suivante. Il n'y a pas de troisième possibilité : un échantillon abandonné en `RUNNING` immobiliserait son run.

La transition terminale s'effectue par une mise à jour gardée sur `status IN ('PENDING','RUNNING')`. Si elle ne touche aucune ligne, les compteurs ne bougent pas — c'est ce qui rend le handler sûr à rejouer après un commit partiel ou une réconciliation du balayeur.

Détails notables du chemin d'exécution :

- **Le scoring précède la transaction terminale.** Celle-ci met en file l'agrégation dès que l'échantillon est le dernier en attente, et un worker voisin peut la réclamer immédiatement : un score écrit après coup produirait un agrégat plus court d'un échantillon. L'analyse est idempotente et ne dérive que de la réponse en mémoire, donc l'ordre est sûr.
- **Un échec d'analyse ne perd pas l'appel.** L'appel est payé et son texte brut est sur le point d'être stocké : rejouer le job rachèterait le même texte. Le score est donc laissé à un replay, et l'incident journalisé.
- **Un échantillon déjà terminal est simplement acquitté.** S'il a été annulé ou réconcilié entretemps, le repayer achèterait un résultat que plus personne ne lira.
- **Un `payload` illisible est fatal, pas bloquant.** L'échantillon est identifié depuis la ligne de job et marqué en échec : le laisser en attente immobiliserait le run pour de bon, ce qui est pire qu'un échec sur lequel personne ne peut agir.

### Clé invalidée en cours de run

Sur une erreur `AUTH`, le handler invalide l'identifiant, journalise l'événement, puis **annule les jobs restants du même moteur pour ce run**. Annuler les jobs ne suffirait pas : leurs échantillons resteraient en attente indéfiniment et le run n'atteindrait jamais zéro. La même instruction annule donc les jobs `QUEUED`, bascule leurs échantillons en `CANCELLED`, corrige les compteurs des tâches concernées et met en file l'agrégation des tâches ainsi achevées.

## Machine à états d'une analyse

```
                        planRun()
                            │
                            ▼
   PENDING ───────────► RUNNING ──────────────┬──► COMPLETED
   (défaut du schéma)      │                  ├──► PARTIAL
                           │                  └──► FAILED
                           │ cancel
                           ▼
                      CANCELLING ─────────────────► CANCELLED
```

`planRun` crée le run directement en `RUNNING` : son plan est intégralement matérialisé et ses jobs sont en file au moment du commit. `PENDING` reste la valeur par défaut du schéma.

Le statut final est calculé à l'agrégation du run, à partir du décompte des statuts d'échantillons.

| Condition | Statut |
|---|---|
| statut précédent `CANCELLING` ou `CANCELLED` | `CANCELLED` |
| aucun échantillon réussi | `FAILED` |
| au moins un échec ou une annulation | `PARTIAL` |
| sinon | `COMPLETED` |

L'ordre des tests importe : l'annulation prime, sinon un run annulé après quelques succès ressortirait `PARTIAL` et effacerait l'intention de l'utilisateur.

Les tâches suivent la même logique à leur échelle : `CANCELLED` si elles n'ont produit que des annulations, `FAILED` si aucun échantillon n'a abouti, `PARTIAL` s'il reste des échecs, `COMPLETED` sinon.

### `PARTIAL`

Une analyse dont certains échantillons ont échoué mais dont il en reste assez pour scorer n'est **jamais** rapportée `COMPLETED`. Elle reste exploitable : les vues du dashboard lisent la dernière analyse `COMPLETED` **ou** `PARTIAL`, car une analyse partielle a mesuré tout le reste et l'exclure viderait le dashboard pour la mauvaise raison. L'interface la signale explicitement, et le compte d'échantillons en échec est visible par tâche. Les intervalles s'élargissent d'eux-mêmes : `n` a diminué, et `lowN` bascule si le seuil est franchi.

### `CANCELLING`

État transitoire, jamais terminal, qui matérialise une intention pendant que du travail payé est encore en vol.

1. La demande passe le run en `CANCELLING`, horodate `cancelRequestedAt`, annule les jobs `QUEUED` et bascule échantillons et tâches restés `PENDING` en `CANCELLED`.
2. Les jobs `RUNNING` ne sont pas touchés : ils détiennent un appel payant et l'apprennent à leur prochain heartbeat — au plus 25 secondes — ce qui leur permet d'avorter et d'enregistrer eux-mêmes leur résultat.
3. Un handler avorté vérifie `cancelRequestedAt` pour distinguer une annulation d'une perte de bail. Annulation : l'échantillon est terminal. Perte de bail : il doit rester en vol, et le libérer ici serait une course contre celui qui le détient désormais.
4. Le balayeur ferme le run en `CANCELLED` quand plus aucun job n'est ni en file ni en cours. Il annule d'abord les jobs `QUEUED` restants : un job remis en file par le balayage des baux après le clic d'annulation serait sinon exécuté, et le run n'atteindrait jamais son état terminal.

Un run `CANCELLING` n'est pas rejouable : le replay refuse `PENDING`, `RUNNING` et `CANCELLING`.

## Progression

Les compteurs sont écrits dans la transaction qui écrit le résultat, ce qui les rend exacts sans polling.

| Niveau | Compteurs | Déclencheur |
|---|---|---|
| `RunTask` | `pendingSamples`, `doneSamples`, `failedSamples` | chaque échantillon terminal |
| `Run` | `doneSamples`, `failedSamples` | chaque échantillon terminal |
| `Run` | `pendingTasks` | chaque tâche transitée par `AGGREGATE_TASK` |

`pendingSamples` à 0 met en file `AGGREGATE_TASK` ; `pendingTasks` à 0 met en file `AGGREGATE_RUN`. Le décompte de `pendingTasks` est le seul effet non idempotent du pipeline : il est gardé par la transition de statut qu'il accompagne, dans la même transaction. Un job repris, ou l'agrégation d'un run déjà terminé, ne trouve plus de tâche à faire transiter et laisse le compteur intact.

Le balayeur corrige les compteurs des échantillons orphelins dans la même instruction que leur passage en échec : un worker tué ne peut pas laisser un run en attente perpétuelle.

## Le pipeline de replay

Un replay emprunte exactement le même appareillage.

```
POST /rescore
   └─ RESCORE_SAMPLE × N          (par tranches de 500, providerCode = "internal")

Worker : claim → RESCORE_SAMPLE
   ├─ relit ai_responses.raw_text
   ├─ relit les citations NATIVE déjà extraites
   ├─ persistSampleAnalysis()     — même fonction que l'exécution en direct
   └─ enfile AGGREGATE_TASK puis AGGREGATE_RUN
```

Aucun fournisseur n'est appelé, donc aucun seau à jetons de moteur n'intervient ; les jobs de replay partagent le sémaphore interne. Ils héritent en revanche des reprises, de la progression et de l'annulation d'un run réel. Un échantillon sans réponse stockée est acquitté sans travail : il n'a aucune évidence qu'une nouvelle version pourrait lire autrement.
