# 02 — Installation et déploiement

## Installer sa propre instance

Chaque utilisateur installe et exploite sa propre instance **auto-hébergée**, avec une base PostgreSQL, des volumes et des secrets distincts. Aucun hébergement SaaS central n'est fourni. Le code source peut être public sans que votre instance ou vos données le soient.

Prérequis pour la pile de production :

- Votre machine ou votre serveur, avec Docker et Docker Compose v2 prenant en charge `up --wait` et `--wait-timeout`. PostgreSQL 16 est fourni par la pile et son port n'est pas publié sur l'hôte.
- **Node 22 et npm sur la machine de préparation**, avec les dépendances verrouillées installées par `npm ci`, pour utiliser le [générateur de secrets existant](#secrets). Les images utilisent aussi Node 22, mais n'embarquent pas ce script : cette préparation n'est pas Docker-only.
- Un accès privé à la machine : navigateur local ou SSH. Aucun domaine n'est nécessaire pour rester en boucle locale ; tout accès réseau direct, y compris sur un LAN, nécessite un HTTPS géré par l'exploitant.

Parcours d'une **nouvelle installation** :

1. Placez la révision choisie dans un répertoire dédié. Utilisez un projet Compose et un volume propres à cette instance, sans réutiliser la base de démonstration.
2. Copiez [`.env.production.example`](../.env.production.example) vers un fichier `.env.production` non versionné, sans écraser une configuration existante, et limitez ses droits au compte exploitant (`chmod 600` sous POSIX, droits équivalents ailleurs). Renseignez toutes les valeurs requises selon les [instructions de préparation](production-runbook.md#secrets-and-preparation), avec un mot de passe PostgreSQL indépendant et les quatre affectations imprimées par `npm run keygen`.
3. Gardez `APP_BIND_ADDRESS=127.0.0.1`, `REGISTRATION_ENABLED=false` et `TRUSTED_PROXY_HOPS=0` pour l'accès direct privé. Définissez `NEXTAUTH_URL` sur l'adresse réellement ouverte dans le navigateur, par exemple `http://127.0.0.1:3000` en local ou via le tunnel SSH. L'HTTP est réservé à cette boucle locale ; ne publiez pas encore de proxy.
4. Suivez la [première installation du runbook](production-runbook.md#first-installation-empty-database) : construction, PostgreSQL sain, migration ponctuelle, puis démarrage du web et du worker **uniquement après succès**. Une base existante ou restaurée relève de la procédure de mise à niveau, pas de ce premier démarrage.
5. Créez votre compte avec la [séquence privée de contrôle des inscriptions](access-control.md#créer-le-premier-compte-avant-toute-exposition-publique), puis refermez et vérifiez le refus `403`. Aucun compte ni mot de passe n'est fourni ; `setup.sh` et le seed de démonstration ne font pas partie de cette installation.
6. Vous pouvez conserver cet accès privé. Si vous choisissez une exposition réseau, configurez ensuite [HTTPS, l'URL finale et la confiance proxy](production-runbook.md#access-mode-and-https), en gardant les inscriptions fermées.

Vous êtes responsable des mises à jour, sauvegardes, restaurations et secrets de votre instance. Les requêtes et contenus nécessaires aux analyses sont envoyés aux API des fournisseurs sélectionnés ; les appels sont facturés sur vos comptes fournisseurs. Les limites de volume ne sont **pas** des budgets monétaires. La [qualification Docker réelle reste non exécutée](production-runbook.md#validation-boundary-and-external-work) : un succès sur Docker est requis avant de déclarer cette version qualifiée en conteneurs.

## Développement et démonstration

Les voies ci-dessous utilisent `.env.example` et une base isolée, pas la configuration de votre instance de production. Prérequis :

- Node ≥ 20.11
- PostgreSQL 16
- Docker et Docker Compose, pour la voie conteneurisée

### Voie Docker Compose

```bash
cp .env.example .env
npm install           # `keygen` s'exécute par tsx, livré avec les dépendances
npm run keygen        # imprime les secrets à coller dans .env
docker compose up
```

`docker-compose.yml` démarre quatre services :

| Service | Rôle |
|---|---|
| `postgres` | PostgreSQL 16, volume persistant, port publié sur la boucle locale uniquement |
| `migrate` | service ponctuel : applique les migrations et le seed après la disponibilité de PostgreSQL, puis se termine |
| `web` | attend le succès de `migrate`, puis lance Next.js en développement sur `APP_PORT` (3000 par défaut) |
| `worker` | attend le succès de `migrate`, puis lance `npm run worker` — sans lui, les analyses sont planifiées mais n'avancent pas |

Le fichier de composition exige explicitement `NEXTAUTH_SECRET`, `CREDENTIAL_KEYS` et `CREDENTIAL_FINGERPRINT_PEPPER` : une variable manquante fait échouer le démarrage avec un message plutôt que de rendre la pile fonctionnelle avec un secret connu de tous.

Dans les deux piles, seul le service ponctuel `migrate` passe la commande `migrate` à `docker-entrypoint.sh`, qui applique `prisma migrate deploy` puis exécute `prisma/seed.ts`. Le web et le worker dépendent de sa fin réussie (`service_completed_successfully`) : si la migration ou le seed échoue, ils ne démarrent pas. `RUN_MIGRATIONS` n'est plus utilisé. Pour réappliquer des migrations après un changement de code en développement : arrêtez le web et le worker, recréez `migrate` avec `docker compose up --no-deps --force-recreate --exit-code-from migrate migrate` (PostgreSQL doit déjà être sain), puis redémarrez les deux services uniquement si le code de sortie est zéro.

Le seed de développement actualise les moteurs et les capacités de leurs seaux de débit : ce sont des données de référence, et un seau absent échoue en refus. Le projet de démonstration dépend de `SEED_DEMO`, que seul le migrateur de développement porte à `true` par défaut. Le mot de passe du compte de démonstration est alors **généré à chaque exécution du seed et imprimé une seule fois** dans les logs du conteneur `migrate`. En production, le seed ne crée que les références manquantes et préserve les réglages existants ; le compte démo est interdit.

### Voie locale

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

Toutes les variables sont validées une fois au démarrage par `src/lib/env.ts` (Zod). Une configuration invalide arrête le processus avec la liste des problèmes, jamais avec un repli silencieux. Utilisez [`.env.production.example`](../.env.production.example) pour votre instance ; [`.env.example`](../.env.example) décrit aussi les options de développement. Le tableau ci-dessous résume les obligations.

| Variable | Requis | Rôle |
|---|---|---|
| `DATABASE_URL` | oui | connexion PostgreSQL |
| `NEXTAUTH_URL` | en production | origine utilisée par le navigateur : HTTP uniquement en boucle locale, HTTPS pour l'accès réseau |
| `NEXTAUTH_SECRET` | oui, ≥ 16 caractères | signature des sessions |
| `CREDENTIAL_KEYS` | oui | JSON `{"<version>": "<clé base64 de 32 octets>"}` |
| `CREDENTIAL_KEY_CURRENT` | oui | version utilisée pour les nouvelles écritures ; doit exister dans `CREDENTIAL_KEYS` |
| `CREDENTIAL_FINGERPRINT_PEPPER` | oui, ≥ 16 caractères | poivre HMAC des empreintes de clés |
| `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`, `PERPLEXITY_MODEL` | non | identifiants de modèle par moteur |
| `SENTIMENT_ENABLED`, `SENTIMENT_JUDGE_PROVIDER`, `SENTIMENT_JUDGE_MODEL` | non | juge de sentiment |
| `WORKER_ID` | non | identifie le worker dans les baux ; dérivé du nom d'hôte et du PID si vide |
| `WORKER_BATCH_SIZE` | non | jobs réclamés par tour, 1 à 50, défaut 5 |
| `TRUSTED_PROXY_HOPS` | non | nombre de reverses proxies devant l'application, 0 à 5, défaut 0 |
| `REGISTRATION_ENABLED` | non | `true` autorise l'inscription ; Compose production utilise `false` par défaut, développement `true` |
| `SEED_DEMO` | non | crée un compte de démonstration ; refusé en production |
| `LOG_LEVEL` | non | `debug`, `info`, `warn`, `error` |

Les identifiants de modèle sont de la configuration, pas du code : les fournisseurs retirent leurs modèles selon leur propre calendrier. Le worker journalise les modèles résolus à son démarrage, ce qui permet de vérifier d'un coup d'œil ce qui sera réellement interrogé.

`TRUSTED_PROXY_HOPS` déclare combien de reverses proxies écrivent devant l'application. À `0`, `X-Forwarded-For` et `X-Real-IP` sont ignorés : n'importe quel client peut les écrire, et les croire distribuerait un seau de limitation neuf à chaque requête. Renseignez le nombre exact de sauts que vous exploitez — l'adresse est alors lue depuis la droite de la chaîne, en remontant d'autant de sauts, et non depuis l'élément de gauche que le client contrôle. Sans proxy déclaré, l'inscription reste bornée par son seau global.

### Secrets

Sur la machine de préparation avec Node 22, installez les dépendances verrouillées avant de lancer le générateur :

```bash
npm ci
npm run keygen            # imprime les valeurs, sans écrire de fichier
```

Copiez les quatre affectations dans le fichier protégé `.env.production` de la **nouvelle** instance : `NEXTAUTH_SECRET`, `CREDENTIAL_KEYS`, `CREDENTIAL_KEY_CURRENT=1` et `CREDENTIAL_FINGERPRINT_PEPPER`. Le secret de session, la clé de chiffrement et le pepper sont chacun tirés de `randomBytes(32)`. Générez séparément le mot de passe PostgreSQL ; le script ne le produit pas. Ne partagez ni cette sortie ni vos fichiers de secrets.

Le commentaire imprimé par le script mentionne `.env`, mais ses valeurs peuvent être copiées manuellement dans `.env.production`. L'option `npx tsx scripts/keygen.ts --write` cible **uniquement `.env`** : elle est réservée à la préparation du développement et ne configure pas `.env.production`. Ne remplacez pas les secrets d'une instance existante lors d'une mise à jour ; conservez les anciennes versions de clés nécessaires à ses données et sauvegardes.

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

Le seed assure les cinq lignes `providers` et leurs seaux à jetons. En développement, il actualise les capacités et limites de débit. Avec `NODE_ENV=production`, il crée uniquement les références manquantes, sans écraser les modèles, limites ou seaux existants ; un seau manquant reprend le débit réellement configuré sur son moteur. Aucune analyse ne peut s'exécuter sans ces références.

## Déploiement

Suivez le [runbook de production](production-runbook.md) avec `.env.production`, en distinguant première installation et mise à niveau. Pour une base existante ou restaurée, prévoyez un créneau de maintenance : cette version exige l'arrêt de **tous les anciens web et workers avant migration**. Une simple commande `up --build` sur une pile active n'est pas une procédure de mise à niveau sûre. L'ouverture des comptes et la fermeture des inscriptions sont décrites dans [Contrôle d'accès](access-control.md).

Différences avec la pile de développement :

- **Aucune valeur de repli.** Chaque secret est déclaré `${VAR:?}` : une variable manquante fait échouer le déploiement au lieu de démarrer avec une valeur connue.
- **PostgreSQL n'est pas publié** sur l'hôte.
- **Une seule migration.** Le service ponctuel `migrate` est le seul à migrer et amorcer les références ; le web et le worker attendent sa fin réussie.
- **Inscription fermée par défaut.** `REGISTRATION_ENABLED=false` dans Compose production ; la création initiale de compte se fait en accès privé.
- **Horloges UTC** pour Node et PostgreSQL ; disponibilité web et progression du worker contrôlées par leurs sondes de santé.
- **Workers réplicables** via `WORKER_REPLICAS`. La réclamation par `FOR UPDATE SKIP LOCKED` et les seaux à jetons partagés en base rendent l'ajout d'instances sans effet sur la correction : le débit reste plafonné par moteur.

`docker-entrypoint.sh` ne migre que pour la commande `migrate` et transmet les autres commandes directement au processus demandé. Le seed de production préserve la configuration existante, avec `SEED_DEMO=false`. L'échec du seed interrompt le migrateur et bloque ses dépendants.

Le Dockerfile produit trois cibles exécutées sous l'UID non root 1001 : `web` utilise la sortie **standalone** de Next.js avec ses fichiers statiques et publics ; `worker` conserve ses sources TypeScript et les dépendances de production, dont `tsx` ; `migrate` seul conserve les outils Prisma et les dépendances de construction nécessaires aux migrations et au seed.

## Intégration continue

`.github/workflows/ci.yml` démarre un PostgreSQL 16 en service, applique les migrations et le seed, puis exécute `lint`, `typecheck`, la couverture Vitest, le build standalone, le smoke HTTP mock et l'audit des dépendances. Un job Docker distinct construit les trois cibles et appelle `scripts/container-smoke.sh` : pile jetable, santé web/worker, UID non root, smoke HTTP mock et refus de démarrage après une migration en échec. Les volumes supprimés appartiennent uniquement aux projets de test générés ; les logs d'échec sont conservés sept jours en artefact CI. Aucun push d'image ni déploiement n'est exécuté.

La qualification réelle des conteneurs **n'a pas été exécutée sur l'environnement Windows local**, où Docker n'est pas disponible. Le job Docker doit réussir sur un hôte Linux avant d'affirmer cette qualification ; les tests statiques ou simulés du script ne la remplacent pas.

## Vérifier le développement et la démonstration

1. `npm run dev` et `npm run worker` tournent, sans erreur d'environnement au démarrage. En Docker, les logs du conteneur `migrate` montrent les migrations puis `Seeded 5 providers and their rate-limit buckets.`, et son code de sortie vaut zéro.
2. Les logs du worker contiennent `resolved models` avec les cinq moteurs.
3. Créez un projet, une marque, une requête, puis lancez une analyse : le moteur `mock` seul suffit.
4. La progression avance dans la vue Analyses ; au terme, la synthèse affiche deux axes et un écart de récupération.

Si la progression reste figée à zéro, le worker n'est pas en cours d'exécution : c'est le premier point à vérifier.
