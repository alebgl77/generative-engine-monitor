# 02 — Installation et déploiement

## Prérequis

- Node ≥ 20.11
- PostgreSQL 16
- Docker et Docker Compose, pour la voie conteneurisée

## Voie Docker Compose

```bash
cp .env.example .env
npm install           # `keygen` s'exécute par tsx, livré avec les dépendances
npm run keygen        # imprime les secrets à coller dans .env
docker compose up
```

`docker-compose.yml` démarre trois services :

| Service | Rôle |
|---|---|
| `postgres` | PostgreSQL 16, volume persistant, port publié sur la boucle locale uniquement |
| `web` | `RUN_MIGRATIONS=true` : l'entrypoint applique les migrations et le seed, puis lance Next.js en développement sur `APP_PORT` (3000 par défaut) |
| `worker` | `RUN_MIGRATIONS=false` : l'entrypoint attend le schéma, puis `npm run worker` — sans lui, les analyses sont planifiées mais n'avancent pas |

Le fichier de composition exige explicitement `NEXTAUTH_SECRET`, `CREDENTIAL_KEYS` et `CREDENTIAL_FINGERPRINT_PEPPER` : une variable manquante fait échouer le démarrage avec un message plutôt que de rendre la pile fonctionnelle avec un secret connu de tous.

Les deux services passent par `docker-entrypoint.sh`, dans les deux piles. C'est `RUN_MIGRATIONS` qui départage : le conteneur qui le porte à `true` applique `prisma migrate deploy` puis exécute `prisma/seed.ts`, celui qui le porte à `false` attend que `prisma migrate status` réponde, jusqu'à cinq minutes, avant de démarrer. Un seul processus migre — deux `migrate deploy` concurrents peuvent laisser le verrou de migration incohérent.

Le seed écrit toujours les moteurs et leurs seaux de débit : ce sont des données de référence, et un seau absent échoue en refus. Le projet de démonstration, lui, dépend de `SEED_DEMO`, que la pile de développement porte à `true` par défaut. Le mot de passe du compte de démonstration est alors **généré à chaque exécution du seed et imprimé une seule fois** dans les logs du conteneur `web`.

## Voie locale

```bash
./setup.sh                    # crée .env, installe, génère les secrets, s'arrête
#   ajustez DATABASE_URL dans le .env qui vient d'être créé
./setup.sh                    # client Prisma, migrations, seed
```

`setup.sh` ne génère les secrets qu'au passage où `.env` n'existe pas encore : il copie alors `.env.example`, installe les dépendances, écrit de vrais secrets via `scripts/keygen.ts --write` et s'arrête pour vous laisser pointer `DATABASE_URL`. Créer `.env` à la main avant de l'appeler saute cette étape et laisse la clé de chiffrement d'exemple en place. Au second passage, il installe, génère le client Prisma, applique les migrations et exécute le seed — moteurs et seaux de débit dans tous les cas, projet de démonstration si `SEED_DEMO=true`.

Ensuite, deux processus :

```bash
npm run dev       # http://localhost:3000
npm run worker    # dans un second terminal
```

Le moteur `mock` ne réclame aucune clé API : la chaîne complète se démontre immédiatement, sans dépense.

## Configuration

Toutes les variables sont validées une fois au démarrage par `src/lib/env.ts` (Zod). Une configuration invalide arrête le processus avec la liste des problèmes, jamais avec un repli silencieux. La référence complète et commentée est `.env.example` ; le tableau ci-dessous en résume les obligations.

| Variable | Requis | Rôle |
|---|---|---|
| `DATABASE_URL` | oui | connexion PostgreSQL |
| `NEXTAUTH_URL` | en production | URL publique de l'application |
| `NEXTAUTH_SECRET` | oui, ≥ 16 caractères | signature des sessions |
| `CREDENTIAL_KEYS` | oui | JSON `{"<version>": "<clé base64 de 32 octets>"}` |
| `CREDENTIAL_KEY_CURRENT` | oui | version utilisée pour les nouvelles écritures ; doit exister dans `CREDENTIAL_KEYS` |
| `CREDENTIAL_FINGERPRINT_PEPPER` | oui, ≥ 16 caractères | poivre HMAC des empreintes de clés |
| `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`, `PERPLEXITY_MODEL` | non | identifiants de modèle par moteur |
| `SENTIMENT_ENABLED`, `SENTIMENT_JUDGE_PROVIDER`, `SENTIMENT_JUDGE_MODEL` | non | juge de sentiment |
| `WORKER_ID` | non | identifie le worker dans les baux ; dérivé du nom d'hôte et du PID si vide |
| `WORKER_BATCH_SIZE` | non | jobs réclamés par tour, 1 à 50, défaut 5 |
| `TRUSTED_PROXY_HOPS` | non | nombre de reverses proxies devant l'application, 0 à 5, défaut 0 |
| `SEED_DEMO` | non | crée un compte de démonstration ; refusé en production |
| `RUN_MIGRATIONS` | non, conteneurs | `true` fait migrer et semer l'entrypoint, `false` lui fait attendre le schéma |
| `LOG_LEVEL` | non | `debug`, `info`, `warn`, `error` |

Les identifiants de modèle sont de la configuration, pas du code : les fournisseurs retirent leurs modèles selon leur propre calendrier. Le worker journalise les modèles résolus à son démarrage, ce qui permet de vérifier d'un coup d'œil ce qui sera réellement interrogé.

`TRUSTED_PROXY_HOPS` déclare combien de reverses proxies écrivent devant l'application. À `0`, `X-Forwarded-For` et `X-Real-IP` sont ignorés : n'importe quel client peut les écrire, et les croire distribuerait un seau de limitation neuf à chaque requête. Renseignez le nombre exact de sauts que vous exploitez — l'adresse est alors lue depuis la droite de la chaîne, en remontant d'autant de sauts, et non depuis l'élément de gauche que le client contrôle. Sans proxy déclaré, l'inscription reste bornée par son seau global.

### Secrets

```bash
npm run keygen            # imprime les valeurs
npx tsx scripts/keygen.ts --write   # les écrit dans .env
```

Le générateur produit `NEXTAUTH_SECRET`, une `CREDENTIAL_KEYS` en version 1 et un pepper d'empreinte, tous tirés de `randomBytes(32)`.

En production, l'application **refuse de démarrer** si : `NEXTAUTH_SECRET` porte une valeur d'exemple, `NEXTAUTH_URL` est absente, `SEED_DEMO` est activé, `CREDENTIAL_KEYS` contient encore la clé de développement de `.env.example`, ou `CREDENTIAL_FINGERPRINT_PEPPER` en porte la valeur d'exemple. `CREDENTIAL_KEY_CURRENT` est également vérifiée dans tous les environnements : elle doit désigner une version présente dans `CREDENTIAL_KEYS`.

### Rotation des clés de chiffrement

Chaque identifiant fournisseur stocke la version de clé qui l'a chiffré, et le déchiffrement cherche cette version-là.

1. Générez une clé de 32 octets en base64.
2. Ajoutez-la sous une nouvelle version : `CREDENTIAL_KEYS={"1":"…","2":"…"}`.
3. Passez `CREDENTIAL_KEY_CURRENT=2`.
4. Conservez la version 1 tant que des lignes l'utilisent : `needsRotation()` signale celles à réécrire, et une clé retirée rend définitivement illisibles les identifiants écrits avec elle.

## Base de données

```bash
npm run db:migrate    # crée et applique une migration (développement)
npm run db:deploy     # applique les migrations existantes (production, CI)
npm run db:seed       # moteurs, seaux de débit, données de démonstration optionnelles
npm run db:studio     # explorateur Prisma
```

Le seed est idempotent sur les moteurs : il upsert les cinq lignes `providers` avec leurs capacités, leurs limites de débit et leurs seaux à jetons associés. Aucune analyse ne peut s'exécuter sans lui, un seau à jetons manquant échouant en refus.

## Déploiement

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Différences avec la pile de développement :

- **Aucune valeur de repli.** Chaque secret est déclaré `${VAR:?}` : une variable manquante fait échouer le déploiement au lieu de démarrer avec une valeur connue.
- **PostgreSQL n'est pas publié** sur l'hôte.
- **Une seule migration.** Le conteneur `web` porte `RUN_MIGRATIONS=true`, le worker `false` : deux processus exécutant `migrate deploy` en concurrence peuvent laisser le verrou de migration incohérent.
- **Workers réplicables** via `WORKER_REPLICAS`. La réclamation par `FOR UPDATE SKIP LOCKED` et les seaux à jetons partagés en base rendent l'ajout d'instances sans effet sur la correction : le débit reste plafonné par moteur.

`docker-entrypoint.sh` applique les migrations puis exécute le seed quand `RUN_MIGRATIONS` vaut `true`, sinon attend le schéma, et passe ensuite la main au processus demandé. Le seed écrit les moteurs et leurs seaux de débit dans tous les cas — c'est le seed lui-même qui garde le projet de démonstration derrière `SEED_DEMO`, refusé en production. L'échec du seed n'est pas avalé : il interrompt le démarrage plutôt que de masquer une erreur derrière un boot apparemment sain.

L'image de production est un build multi-étapes exécuté sous un utilisateur non root. Elle n'utilise **pas** la sortie `standalone` de Next.js : les deux conteneurs partagent la même image et le worker y exécute du TypeScript par `tsx`, ce qui exige l'arbre de dépendances complet et les sources — une sortie `standalone` ne contient que ce que le serveur web trace.

## Intégration continue

`.github/workflows/ci.yml` démarre un PostgreSQL 16 en service, applique les migrations, puis enchaîne `lint`, `typecheck`, `test` et `build`. Les secrets utilisés y sont réservés à la CI. Ces quatre commandes sont exactement celles à passer en local avant d'ouvrir une pull request.

## Vérifier l'installation

1. `npm run dev` et `npm run worker` tournent, sans erreur d'environnement au démarrage. En Docker, les logs du conteneur `web` montrent les migrations puis `Seeded 5 providers and their rate-limit buckets.`
2. Les logs du worker contiennent `resolved models` avec les cinq moteurs.
3. Créez un projet, une marque, une requête, puis lancez une analyse : le moteur `mock` seul suffit.
4. La progression avance dans la vue Analyses ; au terme, la synthèse affiche deux axes et un écart de récupération.

Si la progression reste figée à zéro, le worker n'est pas en cours d'exécution : c'est le premier point à vérifier.
