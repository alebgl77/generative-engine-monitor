# 09 — Guide utilisateur

Parcours complet, du projet vide au diagnostic exploitable. Il suppose l'application démarrée — voir [02 — Installation](02-installation.md) — avec **le web et le worker en cours d'exécution**. Sans worker, les analyses sont planifiées mais n'avancent jamais.

## 1. Ouvrir un compte

Rendez-vous sur `/signup`. Le mot de passe fait au moins 10 caractères et contient au moins une lettre et un chiffre. Les inscriptions sont limitées à cinq par heure et par adresse IP.

Si la pile a été démarrée avec `SEED_DEMO=true`, un compte de démonstration existe déjà, avec un projet, une marque, des concurrents, des requêtes et une analyse. **Son mot de passe est généré à chaque exécution du seed et imprimé une seule fois** dans la sortie du seed — logs du conteneur `web` sous Docker, terminal en local. Il n'existe aucun mot de passe de démonstration fixe : un mot de passe publié dans un dépôt est un mot de passe compromis. Si vous l'avez laissé défiler, relancez `npm run db:seed` : il en génère un nouveau et le réimprime.

## 2. Créer un projet

Depuis `/projects`, « Nouveau projet ».

| Champ | Ce qu'il change |
|---|---|
| Nom | libellé, et base du nom de fichier d'export |
| Domaine | rien pour l'instant — le domaine décisif est celui de la marque |
| Pays cible | injecté dans le prompt système : « pour une audience située en … » |
| Langue cible | langue demandée aux moteurs |

Pays et langue ne sont pas décoratifs : ils changent les réponses, donc la mesure. Un projet français interrogé en anglais mesure autre chose.

## 3. Déclarer la marque et les concurrents

Onglet **Configuration**.

**La marque.** Nom, domaine, alias.

- Le **domaine** est ce qui permet de reconnaître une citation comme vôtre (`isBrandDomain`), et déclenche une correspondance de type `DOMAIN` quand il apparaît dans le texte.
- Les **alias** sont l'outil le plus rentable de la page. Un moteur écrit « Sellsy CRM », « sellsy.com » ou « Sellsy France » sans prévenir. Chaque alias oublié est une mention manquée qui ne produit aucune erreur visible — le score baisse simplement, pour une mauvaise raison. Déclarez les variantes, les formes courtes, les anciens noms.

**Les concurrents.** Même forme. Ils déterminent la part de voix et la règle `competitorLead` (concurrents nommés avant vous). Prenez ceux que le marché cite réellement, pas ceux que votre plan produit désigne : la mesure porte sur ce que les moteurs répondent.

## 4. Écrire les requêtes

Les bonnes requêtes sont celles que pose un utilisateur qui **ne vous connaît pas encore**. « meilleur CRM pour PME », « alternative à Salesforce », « logiciel de facturation pour indépendants ». Une requête contenant votre nom mesure votre notoriété, ce qui est une autre question.

Saisie à l'unité ou en volume, une requête par ligne, jusqu'à 200. Désactivez plutôt que de supprimer : une requête désactivée sort des prochaines analyses tout en gardant son historique.

## 5. Régler l'échantillonnage

**Répétitions par cellule** (1 à 10, trois par défaut). Chaque répétition est un appel payant. Une répétition unique ne mesure rien d'exploitable : deux appels identiques au même modèle ne rendent pas la même réponse, et un tirage isolé est un tirage, pas une mesure. Trois répétitions donnent un intervalle lisible, cinq le resserrent nettement et font tomber le drapeau `n faible` au grain tâche.

**Modes.** Gardez les deux. Leur différence — l'écart de récupération — est la seule information qui dise *où* agir.

Le coût d'une analyse est :

```
requêtes × moteurs × modes × répétitions = appels payants
```

Dix requêtes, trois moteurs, deux modes, trois répétitions font 180 appels.

## 6. Enregistrer les clés API

Section **Clés API des moteurs**.

Chaque clé est vérifiée auprès du moteur avant d'être stockée : une faute de frappe se voit immédiatement, plutôt qu'au terme d'une analyse entièrement échouée. Une clé refusée est conservée avec sa raison, ce qui laisse la possibilité de la corriger.

Une clé n'est jamais réaffichée : la page ne montre qu'un masque à quatre caractères. Elle est chiffrée en AES-256-GCM avec votre identifiant de compte en donnée authentifiée.

**Vous pouvez sauter cette étape.** Le moteur `mock` ne demande aucune clé et couvre les deux modes : la chaîne complète se démontre gratuitement, avec des réponses réalistes, des mentions et des citations. C'est la bonne façon d'apprendre l'outil avant d'engager des crédits — et ses chiffres ne sont qu'une démonstration, jamais une mesure. Dès que vous enregistrez une clé valide, `mock` cesse d'être planifié et vos analyses ne portent plus que sur de vraies réponses.

Perplexity n'apparaîtra qu'en groundé : il interroge toujours le web, le mode paramétrique n'a pas de sens pour lui, et les cellules correspondantes sont écartées à la planification.

## 7. Lancer une analyse

Bouton « Lancer une analyse », depuis la synthèse ou l'historique. La réponse est immédiate : le plan est enregistré, l'exécution appartient au worker.

L'onglet **Analyses** affiche la progression en échantillons. Les cellules écartées sont listées, avec leur raison.

Vous pouvez **annuler** à tout moment. Les appels en attente sont abandonnés immédiatement ; ceux déjà en vol s'arrêtent d'eux-mêmes dans les vingt-cinq secondes — ils sont payés, ils enregistrent leur résultat plutôt que de disparaître. Le statut passe par `CANCELLING` avant `CANCELLED`.

Si la progression reste à zéro, le worker n'est pas en cours d'exécution.

## 8. Lire la synthèse

### Les deux axes, d'abord séparément

**Visibilité groundée** : ce que les moteurs trouvent quand ils cherchent. **Visibilité paramétrique** : ce qu'ils ont retenu de leur entraînement. Chacune est une médiane assortie d'un intervalle. Lisez l'intervalle, pas la médiane seule : `62 [48 – 71]` et `62 [60 – 64]` ne racontent pas la même histoire.

La **stabilité** complète la lecture. Basse, elle signifie que les moteurs se contredisent d'un tirage à l'autre : votre présence est fragile, même si la médiane paraît correcte.

Un `n faible` indique que l'échantillon est trop petit pour lire l'intervalle comme une affirmation. Augmentez les répétitions ou le nombre de requêtes.

### L'écart de récupération, ensuite

| Écart | Ce qu'il dit | Ce qu'il faut faire |
|---|---|---|
| **Positif** | la recherche vous sert : dès qu'un moteur va chercher, il vous trouve | produire et maintenir le contenu que les moteurs vont chercher — pages comparatives, documentation, contenu à jour |
| **Proche de zéro** | les deux canaux concordent | travailler le score absolu, pas l'écart |
| **Négatif** | les modèles vous connaissent, mais cessent de vous citer dès qu'ils consultent leurs sources | agir sur les sources qu'ils lisent : présence dans les comparatifs, annuaires, tests et publications que la vue Sources vous nomme |

Si les intervalles des deux axes se recouvrent, l'écart n'est pas établi : c'est signalé, et cela vaut mieux que d'agir sur du bruit.

### Puis le détail

**Part de voix** : votre position relative face aux concurrents, en mentions, en présence et en citations. **Score par moteur et par mode** : là où un moteur vous traite bien et un autre vous ignore — un score global unique effacerait cette information. **Sources les plus citées** : les domaines sur lesquels les moteurs s'appuient.

## 9. Descendre à la requête, puis à la preuve

L'onglet **Requêtes** croise requêtes et couples (moteur, mode). Une cellule vide portant un statut signale un moteur en échec à cet endroit, ce qui n'a rien à voir avec une absence de mesure.

L'onglet **Analyses** descend jusqu'à l'appel individuel : la réponse telle qu'elle a été renvoyée, les mentions avec leur position, les citations avec leur origine, et la **décomposition du score règle par règle**. Sélectionner une règle surligne dans le texte les passages qui l'ont déclenchée.

Deux marqueurs y méritent attention :

- **Non applicable** — la règle n'a pas de prise ici. En mode paramétrique, la règle `citation` porte cette marque : il n'y a rien à citer, et ce n'est pas votre faute.
- **Redistribuée** — la règle a absorbé le budget d'une règle inapplicable. C'est ce qui rend les deux axes comparables sur la même échelle.

C'est la vue à ouvrir quand un chiffre surprend. Elle répond toujours.

## 10. Exporter

Depuis l'onglet **Requêtes**, CSV ou JSON. Une ligne par cellule, avec médiane, bornes de l'intervalle, stabilité, `n`, drapeau `n faible`, taux de présence, concurrents et URL citées.

Le CSV s'ouvre directement dans Excel et LibreOffice : encodage UTF-8 avec BOM, et les cellules issues de sorties de modèles sont désamorcées pour ne pas être interprétées comme des formules.

## 11. Rejouer une analyse

Bouton **Rejouer**, dans l'onglet Analyses.

Les réponses brutes de chaque appel sont conservées. Rejouer relit ces textes et recalcule évidence et scores sous la version courante, **sans appeler un seul moteur**. Aucun crédit n'est consommé, y compris sur des analyses vieilles de plusieurs mois.

À quoi cela sert :

- comparer deux versions de scoring sur exactement le même corpus, plutôt que sur deux campagnes tirées séparément ;
- récupérer un score après un incident d'analyse — le texte a été conservé, la mesure se rattrape ;
- réappliquer une extraction améliorée à tout l'historique, par exemple après avoir ajouté un alias oublié.

Une analyse encore en cours ne peut pas être rejouée. Le rejeu passe par la même file que les analyses réelles : il progresse, se reprend et s'annule de la même façon.

## Erreurs fréquentes

| Symptôme | Cause | Correction |
|---|---|---|
| La progression reste à zéro | worker arrêté | `npm run worker` |
| « Aucune requête active » | toutes les requêtes désactivées ou aucune saisie | en activer ou en ajouter |
| « Aucun moteur disponible » | aucune clé valide | enregistrer une clé, ou compter sur le moteur `mock` |
| Score bas mais marque manifestement citée | alias manquant | ajouter les variantes, puis rejouer l'analyse |
| Intervalles très larges | trop peu de répétitions | passer à 5, relancer |
| Analyse `PARTIAL` | certains appels ont échoué | consulter le détail des tâches ; le reste de la mesure est exploitable |
| Un moteur échoue entièrement | clé invalidée en cours d'analyse | la revalider en Configuration |
| Écart de récupération absent | un seul mode planifié | activer les deux modes |
