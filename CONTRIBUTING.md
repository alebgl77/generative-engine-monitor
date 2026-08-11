# Contribuer

Merci de l'intérêt porté au projet. Ce document décrit comment faire tourner la pile, ce qu'on attend d'une contribution, et deux règles non négociables — l'immuabilité des versions publiées et la place des identifiants de modèle.

## Faire tourner la pile

```bash
./setup.sh                  # crée .env, installe, génère les secrets, s'arrête
#                             pointez DATABASE_URL dans le .env ainsi créé
./setup.sh                  # client Prisma, migrations, seed
npm run dev                 # http://localhost:3000
npm run worker              # second terminal — sans lui, les analyses n'avancent pas
```

`setup.sh` ne génère les secrets qu'au passage où il crée lui-même `.env` ; le copier à la main d'abord saute cette étape et laisse la clé d'exemple en place.

Ou, avec Docker :

```bash
cp .env.example .env && npm install && npm run keygen && docker compose up
```

`npm run keygen` s'exécute par `tsx` : il lui faut les dépendances installées, ce que la voie Docker ne fait pas pour vous.

Le moteur `mock` ne réclame aucune clé API : la chaîne complète — planification, file, exécution, extraction, scoring, agrégation, replay, export — se démontre sans dépense. Développez contre lui par défaut ; réservez les clés réelles à ce qui exige une vraie charge utile fournisseur.

## Avant d'ouvrir une pull request

Les cinq commandes de la CI, dans l'ordre :

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm audit --audit-level=moderate
```

La CI les exécute sur un PostgreSQL 16 éphémère après `prisma migrate deploy`, et
chacune est bloquante : un échec ferme la pull request, il n'y a pas d'étape
tolérée.

L'audit vient en dernier, à dessein. Un avis de sécurité est publié par le monde
extérieur, pas par l'auteur de la branche qu'il fait échouer : placé en tête, il
effaçait d'un coup les retours de lint, de typage, de test et de build sur toutes
les branches ouvertes. Après eux, un audit rouge ajoute une information au lieu
d'en masquer quatre.

Il porte sur l'arbre complet, dépendances de développement comprises, et le seuil
est `moderate`. Ce n'est pas un excès de zèle : le `Dockerfile` copie l'intégralité
de `node_modules` de l'étage `builder` vers l'étage `runner` — l'entrypoint a
besoin de la CLI Prisma et le worker exécute du TypeScript via tsx. Les
dépendances de développement partent donc réellement en production ici, et
`--omit=dev` sous-estimerait l'exposition réelle. Dans cette image, la catégorie
« paquet de build uniquement » n'existe pas.

## Les couches de test

| Couche | Où | Ce qu'elle couvre | Dépendances |
|---|---|---|---|
| **Unitaire pur** | à côté du module, `src/**/*.test.ts` | statistiques, extraction, normalisation d'URL, règles de score, parseurs fournisseurs, taxonomie d'erreurs, backoff | aucune |
| **Handlers et modules d'orchestration** | `src/worker/**/*.test.ts` | chemins de sortie d'un handler, arrêt gracieux, idempotence | Prisma et fournisseurs simulés |
| **Transverse et intégration** | `tests/**/*.test.ts` | ce qui traverse plusieurs modules, et la file : réclamation concurrente, baux, balayeur, comptage transactionnel | PostgreSQL réel via `DATABASE_URL` pour les tests de file |

Vitest tourne en environnement `node`, avec l'alias `@` vers `src/`. Les tests de file sont volontairement optionnels et se sautent d'eux-mêmes sans base : ils exigent un PostgreSQL réel, et rien de ce qui touche `FOR UPDATE SKIP LOCKED`, les baux ou les compteurs transactionnels ne se démontre correctement contre un simulacre.

Ce que doit couvrir une contribution :

- toute règle de score ou de correspondance : les cas limites, pas seulement le cas nominal — marque absente, réponse vide, aucune source, égalité de sentiments, concurrent nommé en premier ;
- tout ce qui touche la file : le comportement en reprise, c'est-à-dire l'exécution du même job deux fois ;
- tout changement de statistique : la reproductibilité à graine fixée.

Les tests sont déterministes. Un test qui dépend d'une horloge, d'un aléa global ou du réseau sera refusé : `stats.ts` prend sa graine en paramètre et `makeRng` est exporté précisément pour cela.

## Règle 1 — une version publiée ne se modifie jamais

`src/lib/scoring/versions/v2.ts` et `src/lib/parsing/extract/v2.ts` ne sont **pas** éditables. Tout changement de comportement — un poids, un seuil, une règle de correspondance, une normalisation — est **un nouveau fichier de version**, enregistré dans le registre correspondant.

La raison est directe : les scores et l'évidence sont persistés avec la version qui les a produits, et les analyses conservent la leur. Modifier un fichier publié rendrait irreproductible tout ce qui a été calculé sous ce nom, sans aucune trace. Une comparaison entre deux mesures deviendrait alors une comparaison entre deux barèmes.

Pour livrer une nouvelle version :

1. Créer `versions/v3.ts` (ou `extract/v3.ts`) — copier, puis modifier, n'est pas un aveu d'échec ici, c'est l'objectif.
2. L'enregistrer dans `scoring/registry.ts` ou `parsing/registry.ts` et déplacer `CURRENT_*_VERSION`.
3. Une version de scoring déclare l'`extractionVersion` qu'elle attend.
4. Documenter dans [`docs/06-measurement.md`](docs/06-measurement.md) ce qui change et pourquoi.
5. Vérifier sur un corpus réel : rejouer une analyse existante sous la nouvelle version, puis comparer. Les deux générations coexistent en base — les versions participent aux clés uniques de l'évidence et des scores — donc la comparaison porte sur le même corpus, sans rien détruire.

Un utilitaire partagé refactorisé ne doit pas davantage changer le comportement d'une version publiée. En cas de doute, dupliquez le code dans le fichier de version : la reproductibilité prime sur la factorisation.

Corriger un commentaire ou un typage dans un fichier de version publiée est acceptable tant qu'aucune sortie ne change.

## Règle 2 — les identifiants de modèle restent en configuration

Aucun identifiant de modèle ne doit apparaître dans le code applicatif. Les fournisseurs retirent leurs modèles selon leur propre calendrier, et un identifiant en dur devient une panne silencieuse le jour où il disparaît.

- Le défaut vit dans `src/lib/env.ts`, exposé par `modelFor(providerCode)`.
- Il est documenté dans `.env.example` et repris dans les deux fichiers de composition Docker.
- Un moteur le lit via `defaultModel()`, et un appelant peut le surcharger par `ProviderQueryInput.model`.
- Le worker journalise les modèles résolus à son démarrage : ce qui sera réellement interrogé se vérifie d'un coup d'œil.

Cette règle vaut aussi pour la documentation : le README pointe `.env.example` plutôt que d'imprimer des chaînes de version qui se périment.

## Style et attentes

- **TypeScript strict.** Alias `@/*` vers `./src/*`. Pas de `any`, pas de `@ts-ignore` ; un typage qui résiste signale généralement un problème de conception.
- **Identifiants en anglais, texte produit en français.** Messages d'erreur, libellés d'interface et textes de documentation s'adressent à l'utilisateur, donc en français ; le code se lit en anglais.
- **Les fichiers voisins sont le guide de style.** Nommage, gestion d'erreurs, journalisation, disposition des tests : imitez ce qui existe autour du fichier que vous touchez.
- **Les commentaires expliquent le pourquoi.** Le quoi se lit dans le code. Les commentaires les plus utiles du dépôt documentent une contrainte non évidente — pourquoi le scoring précède la transaction terminale, pourquoi le bootstrap n'est pas BCa, pourquoi le fuseau horaire est explicite en SQL brut.
- **Le plus petit diff qui règle le problème.** Pas de reformatage de lignes non touchées, pas de refonte opportuniste.
- **Aucune dépendance nouvelle sans justification.** Ce projet en compte peu, et c'est délibéré.

## Ce qui exige une attention particulière

| Zone | Pourquoi |
|---|---|
| `lib/queue/**` | correction sous concurrence ; toute modification du SQL de réclamation ou de bail demande un test d'intégration |
| `worker/handlers/**` | chaque chemin de sortie doit mener l'échantillon à un état terminal exactement une fois, ou ne rien toucher |
| `lib/crypto/**` | données authentifiées, versions de clés ; une erreur ici est une fuite ou une perte définitive |
| `lib/scoring/**`, `lib/parsing/**` | voir la règle 1 |
| `app/api/**` | toute route passe par `withAuth` ou `withProject` ; une route qui vérifie la propriété à la main sera refusée |

Les changements touchant l'API, le schéma ou les scripts mettent à jour la documentation adjacente et les tests **dans la même contribution**.

## Migrations

```bash
npm run db:migrate      # crée et applique en développement
npm run db:deploy       # applique en CI et en production
```

Une migration est réversible dans les faits ou explicitement documentée comme destructive. Toute nouvelle table portant de l'évidence ou des scores inclut sa colonne de version dans sa clé unique, faute de quoi deux versions ne peuvent pas coexister.

## Signaler un problème

Une issue utile contient : la version, la commande exacte, ce qui était attendu, ce qui s'est produit, et l'extrait de log pertinent. Pour un écart de mesure, indiquez l'identifiant de l'analyse et la version de scoring — la vue de détail d'un run fournit la décomposition complète, qui est presque toujours la réponse.

**Ne joignez jamais de clé API à une issue.** Une faille de sécurité se signale en privé, selon [SECURITY.md](SECURITY.md).

## Licence

Toute contribution est publiée sous licence MIT, comme le reste du projet.
