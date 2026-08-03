# 08 — Dashboard

Les pages vivent sous `src/app/(dashboard)/`. Le middleware protège `/projects/**` ; toute donnée affichée provient des routes documentées en [04 — Référence API](04-api-reference.md) et typée par `src/types/api.ts`.

Un principe traverse toutes les vues : **aucune ne recalcule un score d'échantillon**. Elles lisent des agrégats écrits par le worker, et rendent la décomposition telle qu'elle a été persistée.

## Conventions d'affichage

| Élément | Lecture |
|---|---|
| Un score | médiane sur `n` échantillons, jamais un tirage |
| `[a – b]` | intervalle de confiance bootstrap à 95 % sur la médiane |
| Stabilité | 0 à 1, dérivée de la MAD ; basse = les moteurs se contredisent d'un tirage à l'autre |
| `n faible` | l'échantillon est trop petit pour lire l'intervalle comme une affirmation : bande directionnelle, pas un chiffre |
| Badge `Groundé` | recherche web native activée |
| Badge `Paramétrique` | sans recherche web : ce que le modèle a retenu de son entraînement |

Les infobulles rappellent ces définitions à l'endroit où elles servent, plutôt que dans une légende que personne ne lit.

## Liste des projets — `/projects`

Point d'entrée. Chaque carte porte le nom, le domaine, le pays et la langue cibles, le nombre de marques, concurrents et requêtes, et la date de la dernière analyse. Le formulaire de création demande le nom, le domaine facultatif, le pays et la langue.

## Synthèse — `/projects/:projectId`

La vue de diagnostic. Elle lit la dernière analyse `COMPLETED` ou `PARTIAL`.

En l'absence d'analyse exploitable, elle propose de configurer le projet ou d'en lancer une, plutôt que d'afficher des cadres vides.

### En-tête

Version de scoring du run affiché, statut, progression, date de fin, et les actions : lancer une analyse, ouvrir l'historique. Les cellules écartées à la planification — un moteur qui ne sert pas un mode — sont listées explicitement : elles expliquent une couverture plus faible qu'attendu sans qu'on ait à la déduire.

### Les deux axes

Deux cartes côte à côte, **jamais fusionnées** : visibilité groundée et visibilité paramétrique. Chacune affiche sa médiane, son intervalle, sa stabilité, son `n` et le taux de présence de la marque. Une carte absente signifie que le run n'a planifié aucune cellule dans ce mode.

### Écart de récupération

`médiane groundée − médiane paramétrique`, en points de score. C'est la métrique qui indique **où agir**.

| Lecture | Interprétation | Action |
|---|---|---|
| Écart positif | la recherche vous sert : les moteurs vous trouvent quand ils cherchent | investir dans le contenu que les moteurs vont chercher |
| Écart proche de zéro | les deux canaux concordent | rien de spécifique à cet axe |
| Écart négatif | les modèles vous connaissent mais cessent de vous citer dès qu'ils consultent leurs sources | investir dans les sources qui font autorité pour eux |

Une bande neutre autour de zéro évite de faire lire une différence de deux points comme un diagnostic. Le chevauchement des deux intervalles est signalé : deux médianes distinctes dont les intervalles se recouvrent ne constituent pas un écart établi.

### Part de voix

Marque et concurrents sur la même échelle : part de mentions, taux de présence, part de citations, rang moyen d'apparition. Les modes sont regroupés en pondérant par le nombre d'échantillons, afin qu'un mode moins échantillonné ne domine pas le classement.

### Score par moteur et par mode

Une ligne par couple (moteur, mode), avec médiane, intervalle et stabilité. C'est ce qui révèle qu'une marque est bien traitée par un moteur et absente d'un autre — information qu'un score global unique effacerait. L'intervalle est recomposé à partir des médianes de tâches avec une graine dérivée de l'identité de la cellule : il ne bouge pas d'une lecture à l'autre.

### Sources les plus citées

Les dix domaines les plus cités du run, avec le compte de citations, le nombre d'échantillons concernés, la part de citations et le marquage des domaines de la marque. Lien vers la vue Sources complète.

## Requêtes — `/projects/:projectId/queries`

Une ligne par requête, une colonne par couple (moteur, mode). Chaque cellule porte la médiane, l'intervalle et la stabilité de la tâche correspondante.

Une cellule est affichée pour **chaque tâche planifiée**, scorée ou non : une cellule vide portant son statut est ce qui indique qu'un moteur a échoué à cet endroit. L'absence de cellule et l'échec d'une cellule ne se confondent pas.

Chaque ligne affiche aussi le taux de présence de la marque toutes cellules confondues, les concurrents détectés avec leur part de mentions, et le nombre moyen de citations par échantillon.

Export CSV et JSON depuis cette vue.

## Sources — `/projects/:projectId/sources`

Tous les domaines cités par le run, décroissants. Par domaine : compte de citations, part de citations, nombre d'échantillons distincts qui l'ont cité, modes concernés, moteurs concernés, requêtes associées, et le marquage des domaines de la marque.

C'est la vue à ouvrir quand l'écart de récupération est négatif : elle nomme les sources que les moteurs lisent réellement à votre place.

Une source citée deux fois dans la même réponse ne compte qu'une fois — la normalisation d'URL fait partie de la mesure, pas de l'affichage.

## Analyses — `/projects/:projectId/runs`

L'historique, jusqu'aux vingt analyses les plus récentes, et la vue d'explicabilité.

### Niveau analyse

Statut, versions de scoring et d'extraction, répétitions, modes, progression en échantillons, horodatages. Actions : rafraîchir, lancer une analyse, **rejouer** les réponses stockées sous la version courante, **annuler** une analyse en cours. Le rejeu indique explicitement qu'aucun crédit API n'est consommé.

Une analyse `PARTIAL` porte un bandeau : certains échantillons ont échoué, le reste a bien été mesuré. Une analyse `FAILED` porte son message d'erreur.

### Niveau tâche

Chaque cellule (requête × moteur × mode) est dépliable : statut, échantillons planifiés / réussis / échoués, score agrégé avec intervalle, message d'erreur du moteur le cas échéant.

### Niveau échantillon — l'explicabilité

Déplier une tâche donne accès à chacun de ses appels :

- le **texte de la réponse** tel que le fournisseur l'a renvoyé, tronqué à 4000 caractères ;
- le **modèle réellement utilisé**, la latence, le statut, l'erreur éventuelle ;
- les **mentions** avec leur type, leur décalage dans le texte, leur rang d'apparition, leur nombre d'occurrences, leur sentiment et leur extrait de contexte ;
- les **citations** avec leur domaine, leur intitulé, leur origine (`NATIVE`, `INLINE_MARKDOWN`, `BARE_URL`) et le marquage du domaine de la marque ;
- la **décomposition du score**, règle par règle.

Le composant de décomposition affiche pour chaque règle son libellé, sa contribution signée, son poids, et deux marqueurs qui sont l'essentiel de la lecture : **Non applicable** quand la règle n'a aucune prise sur ce contexte — la marque est absente, ou le mode paramétrique n'offre rien à citer — et **redistribuée** quand la règle a absorbé le budget d'une règle inapplicable. Sélectionner une règle **surligne dans le texte de la réponse les passages** que ses décalages désignent : le lien entre le chiffre et sa cause est visible, pas argumenté.

Mentions et citations sont filtrées sur la version d'extraction du run : un échantillon rejoué sous un extracteur plus récent porte les deux générations de lignes, et chaque analyse ne montre que la sienne.

## Configuration — `/projects/:projectId/settings`

Tout ce qui détermine la prochaine analyse, sur une seule page.

**Marque surveillée** — nom, domaine, alias. Le domaine sert au marquage `isBrandDomain` des citations et à la correspondance de type `DOMAIN`. Les alias alimentent directement l'extracteur : un alias oublié devient une mention manquante, jamais une erreur visible.

**Concurrents** — même forme. Ils déterminent la part de voix et la règle `competitorLead`.

**Requêtes** — création à l'unité ou en volume (une par ligne, jusqu'à 200), activation et désactivation. Seules les requêtes actives sont planifiées ; désactiver plutôt que supprimer conserve l'historique des analyses qui les contenaient.

**Échantillonnage** — répétitions par cellule (1 à 10) et modes retenus. Le coût d'une analyse est `requêtes × moteurs × modes × répétitions` appels payants : le formulaire l'énonce, plutôt que de laisser le lecteur multiplier lui-même. Augmenter les répétitions resserre les intervalles et fait reculer le drapeau `n faible`.

**Clés API des moteurs** — une entrée par moteur, avec l'état de la clé enregistrée. Une clé est vérifiée auprès du moteur avant d'être stockée ; une clé refusée est conservée avec sa raison, pour que la page montre ce qui ne va pas au lieu de perdre la saisie. Les actions sont revalider et supprimer.

**Aucune clé n'est jamais réaffichée** : seuls un masque à quatre caractères et la version de chiffrement sont montrés. Le moteur `mock` apparaît sans champ de saisie — il ne réclame aucune clé.

Une clé invalidée en cours d'analyse est signalée ici : le moteur ne sera pas interrogé tant qu'elle n'est pas remplacée.
