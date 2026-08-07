# Audit GEO/AEO — ia-b2b.fr

**Date :** 7 août 2026 · **Périmètre :** les 17 URLs du sitemap + fichiers d'infrastructure (robots.txt, llms.txt, sitemap.xml) + tests d'accès réels par User-Agent des crawlers IA + empreinte externe via recherche web.

**Objet :** évaluer la qualité du site pour les moteurs génératifs (ChatGPT, Claude, Gemini, Perplexity) — capacité à être crawlé, compris, extrait et **cité** — et prioriser les optimisations.

---

## 1. Synthèse

Le site est **remarquablement bien optimisé on-site pour les IA** — nettement au-dessus des standards du marché. L'infrastructure de crawl est ouverte et vérifiée, les données structurées sont parmi les plus complètes qu'on puisse trouver sur un site de cette taille, le contenu est statique, dense et extractible. **Le facteur limitant n'est plus le site : c'est l'empreinte externe.** En mode "grounded" (recherche web activée), les moteurs génératifs citent majoritairement des sources tierces — annuaires, comparatifs, presse — où ia-b2b.fr est aujourd'hui quasi absent.

| Axe | Score | Constat |
|---|---|---|
| Accès crawlers IA | 9,5/10 | Tous les bots IA passent (vérifié par UA réel), robots.txt exemplaire |
| Rendu & performance | 9/10 | HTML statique, TTFB ~0,5 s, HTTP/2, aucun contenu dépendant du JS |
| Données structurées | 9/10 | @graph complet, FAQPage partout, E-E-A-T balisé ; 2 H1 sur une page |
| Contenu & extractibilité | 8/10 | Guides 2 000–4 700 mots, tableaux comparatifs, FAQ courtes ; études de cas trop condensées |
| E-E-A-T / entité | 7/10 | Person + credentials + sources citées ; entité éclatée (digitalizor / beguel.com / ia-b2b.fr) |
| Fraîcheur | 6/10 | Dernière vague de mises à jour : 2026-07-07 ; pas de flux RSS |
| **Citations tierces (off-site)** | **3/10** | Présent dans aucune liste/annuaire tiers repéré ; empreinte = le site + LinkedIn |

---

## 2. Ce qui est déjà excellent (à conserver tel quel)

### 2.1 Accès crawlers — vérifié par tests réels

`robots.txt` (2 133 octets) : `Allow: /` explicite pour **GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, CCBot** — les jetons 2026 corrects, y compris la distinction crawl d'entraînement / recherche / action utilisateur. Sitemap déclaré.

Test d'accès réel (GET `/` avec le User-Agent de chaque bot) :

| User-Agent | Code HTTP |
|---|---|
| GPTBot/1.2 | 200 |
| OAI-SearchBot/1.0 | 200 |
| ClaudeBot/1.0 | 200 |
| Claude-SearchBot/1.0 | 200 |
| PerplexityBot/1.0 | 200 |
| CCBot/2.0 | 200 |
| Google-Extended | 200 |
| bingbot/2.0 | 200 |
| meta-externalagent/1.1 | 200 |

➜ **Le blocage Cloudflare "Managed robots.txt / Block AI bots" mentionné en commentaire du robots.txt est bien désactivé** : aucun bloc "Cloudflare Managed content" n'est injecté, et aucun bot n'est bloqué au niveau WAF. L'avertissement en tête du fichier est donc obsolète (voir reco P2).

### 2.2 Infrastructure propre

- `https://www.ia-b2b.fr/` → 301 → apex ; `http://` → 301 → `https://` ; `/index.html` sert un canonical vers `/`.
- 404 réel sur URL inexistante (pas de soft-404).
- `meta robots: index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1` — snippet illimité, exactement ce qu'il faut pour l'extraction par les moteurs de réponse.
- En-têtes de sécurité corrects, cache public 1 h, compression zstd, HTTP/2 via Cloudflare, TTFB ~0,5 s.
- **Contenu 100 % rendu côté serveur** : 1 728 mots visibles sans exécuter le moindre JS sur l'accueil. C'est le point qui disqualifie la majorité des sites face aux crawlers IA (qui n'exécutent pas le JS) — ici, aucun risque.

### 2.3 llms.txt de référence

`llms.txt` (6,7 Ko) : résumé de l'offre, index annoté des 17 pages, section Expertise (cas d'usage, stack, méthodologie, différenciateurs), contact, **politique de citation explicite** (« Indexation et citation autorisées, avec attribution "Source : ia-b2b.fr" »), auteur de référence, date de mise à jour. C'est un modèle du genre.

### 2.4 Données structurées

Accueil : `@graph` avec **Organization** (knowsAbout étendu : RAG, agents, GEO/LLMO, AI Act…), **Person** (Alexandre Beguel : jobTitle, credentials, knowsAbout, sameAs LinkedIn + beguel.com), **WebSite**, **WebPage** (datePublished/dateModified), **LocalBusiness**, **Service**, **BreadcrumbList**, **FAQPage** (8 questions, réponses 177–295 caractères — la bonne taille pour être reprises verbatim), **VideoObject**.

Les 10 pages guides : **Article** (headline, author → `#person`, publisher, mainEntityOfPage) + **FAQPage** (5–8 questions) + **BreadcrumbList**, avec dates cohérentes et mention visible « Mis à jour : juin 2026 ».

### 2.5 Contenu guides

- 17 URLs, toutes avec title unique (46–63 car.), meta description (100–163 car.), canonical auto-référent, un seul H1 (une exception, voir P1), hiérarchie H2/H3 logique en questions.
- Guides de 2 082 à 4 673 mots, **tableaux HTML** pour les comparatifs (le tableau du comparatif multi-agents est exactement le format que les LLM citent), sections « Questions fréquentes » alignées sur le balisage FAQPage.
- Sources externes citées (Bpifrance Le Lab, France Num, Caisse des Dépôts, McKinsey) — signal de crédibilité que les moteurs valorisent.
- 20/20 images avec attribut `alt`.
- Maillage interne : 8–20 liens internes par page, hub `guides.html` en ItemList.

---

## 3. Axes d'optimisation priorisés

### P0 — Empreinte externe : devenir citable en mode "grounded" (impact fort, effort continu)

C'est **le** chantier. Quand un dirigeant demande à ChatGPT/Perplexity « quelle agence IA pour ma PME ? », le moteur cherche et cite des **sources tierces** : listicles « meilleures agences IA France », annuaires, presse, avis. Constat actuel : ia-b2b.fr apparaît en organique sur ses propres pages, mais **dans aucune source tierce repérée** ; les concurrents (Stema Partners, IA PME Conseil, iaba…) occupent ce terrain.

Actions, par ordre de rendement :

1. **Annuaires et places de marché à forte autorité** : Malt (déjà utilisé pour Calendly — compléter et faire noter le profil), Sortlist, Clutch, l'annuaire des Activateurs France Num, écosystème Bpifrance (« Osez l'IA »), French Tech locale. Ces pages sont sur-représentées dans les réponses grounded.
2. **Outreach vers les listicles existants** « agence conseil IA entreprise / PME 2026 » (ex. iaba.tech, agence-ia.com publient ces comparatifs) : demander l'inclusion, avec les études de cas chiffrées comme argument.
3. **Avis clients publics** : Google Business Profile (LocalBusiness est déjà balisé — le GBP doit exister et collecter des avis), avis Malt/Sortlist. Les notes tierces alimentent directement les réponses « quelle agence choisir ».
4. **Contenu invité / RP** : une tribune ou interview dans un média B2B français (Maddyness, BDM, JDN, Les Échos Solutions) vaut des dizaines de backlinks classiques pour la citation générative.
5. **LinkedIn** : l'activité personnelle existe déjà — republier les guides (agents, RAG, comparatif multi-agents) en articles LinkedIn avec lien canonique vers le site.

### P1 — Consolidation de l'entité (impact fort, effort faible)

Les moteurs génératifs raisonnent en **entités**. Aujourd'hui l'entité est éclatée : la marque est « ia-b2b.fr », la page LinkedIn company s'appelle **« digitalizor »**, le site personnel est beguel.com.

- Renommer (ou créer) la page LinkedIn company en **« ia-b2b.fr »** — ou a minima aligner descriptif et lien.
- Créer une **entrée Wikidata** pour l'organisation et pour Alexandre Beguel (site officiel, LinkedIn, fondateur) : c'est le graphe d'entités que Google/Gemini et les modèles consultent.
- Cohérence NAP (nom, coordonnées) partout : site, GBP, annuaires, LinkedIn.

### P1 — Éclater les études de cas en pages dédiées (impact fort, effort moyen)

`etudes-de-cas.html` fait 822 mots pour **5 références** (CNPP, Elée, JCB, IJO, Shanti Boutique). Les requêtes « exemple concret de projet IA en PME », « retour d'expérience RAG entreprise » sont exactement celles où les moteurs cherchent des cas sourcés — et il y a très peu d'offre francophone de qualité.

- Une page par cas : contexte → problème → solution (stack nommée : LibreChat, Grafana, Salesforce…) → **résultats chiffrés** → citation du client.
- Balisage Article (+ Review/quote si accord client), ajout au sitemap et au llms.txt.
- C'est aussi le meilleur argument pour l'outreach P0.

### P1 — Fraîcheur : cadence et signaux (impact moyen, effort faible)

- Dernière vague de `dateModified` : 2026-07-07. Perplexity et les modes recherche privilégient le récent : instaurer une **revue mensuelle** d'au moins 2–3 guides (vraie mise à jour : chiffres, versions d'outils — le comparatif multi-agents s'y prête parfaitement), avec `dateModified`, sitemap `lastmod` et llms.txt synchronisés.
- Ajouter un **flux RSS/Atom** (`feed.xml`, actuellement 404) référencé dans le `<head>` : canal de découverte utilisé par les crawlers et agrégateurs.
- S'inscrire à **Bing Webmaster Tools** et activer **IndexNow** (ChatGPT search s'appuie sur l'index Bing) ; vérifier la couverture Search Console.

### P2 — Corrections on-site mineures (impact faible à moyen, effort minime)

1. **`audit-ia.html` a deux H1** (« Votre Audit IA gratuit en 5 minutes » + « 🤖 RAPPORT D'AUDIT IA ») : passer le second (template du rapport généré) en H2 ou en `<div>`.
2. **Mots collés à l'extraction de texte** : `<h1>Au-delà de l'automatisation.<br><span>L'IA…` — un parseur qui strippe les balises lit « automatisation.L'IA ». Ajouter une espace avant le `<br>`/`<span>` (vérifier les autres titres multi-lignes).
3. **robots.txt** : supprimer le commentaire d'avertissement Cloudflare devenu obsolète (le blocage est désactivé et vérifié) — il sème le doute lors des audits. En revanche, **vérifier après tout changement de plan/config Cloudflare** que « Block AI bots » ne se réactive pas : c'est le seul point de défaillance capable d'annuler tout le reste.
4. **`llms-full.txt`** (404) : optionnel — version markdown complète des contenus pour ingestion directe ; faible coût sur un site statique.
5. **og-image.jpg : 287 Ko** — compresser sous ~100 Ko (WebP), l'image est chargée par tous les aperçus de lien.
6. **Email obfusqué par Cloudflare** (`/cdn-cgi/l/email-protection`) dans le HTML visible : l'email reste lisible dans JSON-LD et llms.txt, donc acceptable — à savoir simplement qu'un LLM ne le lira pas dans le corps de page.
7. Favicon déclaré en chemin relatif (`href="favicon.ico"`) : fonctionne sur un site plat, `/favicon.ico` serait plus robuste.
8. Si une cible non francophone existe un jour : version EN + hreflang (aucun aujourd'hui, cohérent avec le positionnement FR).

---

## 4. Mesurer : brancher generative-engine-monitor

Ce dépôt est l'outil idéal pour objectiver l'impact des actions P0/P1. Configuration suggérée :

- **Marque suivie :** `ia-b2b.fr` (alias : « ia-b2b », « Alexandre Beguel »).
- **Requêtes cibles :**
  - « Quelle agence ou consultant IA pour une PME/ETI en France ? »
  - « Meilleure agence intégration IA B2B France 2026 »
  - « Qui peut m'aider à déployer un assistant RAG sur mes documents internes ? »
  - « Agents IA pour le développement commercial B2B : qui consulter ? »
  - « Comparatif plateformes d'orchestration multi-agents » (le guide vise cette requête)
  - « Audit de maturité IA PME : méthode et prestataires »
- **Lecture attendue :** l'**écart de récupération** (GROUNDED − PARAMETRIC) est la métrique clé. Aujourd'hui l'hypothèse est un écart faible ou négatif faute de sources tierces ; les actions P0 doivent le faire monter. Échantillonnage N=3 minimum, suivi mensuel des médianes et intervalles.

---

## 5. Annexe — inventaire des 17 pages (relevé du 07/08/2026)

| Page | Title (car.) | Desc (car.) | H1 | Mots | JSON-LD | FAQ | dateModified |
|---|---|---|---|---|---|---|---|
| / | 46 | 158 | 1 | 1 728 | Org, Person, WebSite, WebPage, LocalBusiness, Service, Breadcrumb, FAQPage, VideoObject | 8 | 2026-06-11 |
| /audit-ia.html | 57 | 155 | **2** | 796 | SoftwareApplication, WebPage, Breadcrumb | 0 | 2026-06-11 |
| /etudes-de-cas.html | 57 | 153 | 1 | 822 | CollectionPage, Breadcrumb | 0 | 2026-06-11 |
| /a-propos.html | 54 | 155 | 1 | 667 | ProfilePage, Person, Breadcrumb | 0 | 2026-06-11 |
| /guides.html | 50 | 149 | 1 | 551 | CollectionPage, ItemList, Breadcrumb | 0 | 2026-06-11 |
| /strategie-ia-pme-eti.html | 56 | 153 | 1 | 2 603 | Article, FAQPage, Breadcrumb | 6 | 2026-06-10 |
| /audit-maturite-ia-pme-eti.html | 59 | 157 | 1 | 2 507 | Article, FAQPage, Breadcrumb | 6 | 2026-06-10 |
| /agents-ia-developpement-commercial-b2b.html | 58 | 163 | 1 | 2 508 | Article, FAQPage, Breadcrumb | 6 | 2026-06-10 |
| /ia-service-relation-client-b2b.html | 55 | 150 | 1 | 2 443 | Article, FAQPage, Breadcrumb | 5 | 2026-07-07 |
| /automatiser-processus-ia-pme.html | 56 | 159 | 1 | 2 082 | Article, FAQPage, Breadcrumb | 5 | 2026-06-10 |
| /assistants-ia-documents-rag.html | 49 | 140 | 1 | 2 964 | Article, FAQPage, Breadcrumb | 6 | 2026-06-10 |
| /ia-marketing-commercial-b2b.html | 58 | 158 | 1 | 3 531 | Article, FAQPage, Breadcrumb | 6 | 2026-06-10 |
| /observabilite-finops-llm-grafana.html | 55 | 150 | 1 | 3 087 | Article, FAQPage, Breadcrumb | 6 | 2026-06-10 |
| /orchestration-agents-ia-entreprise.html | 59 | 158 | 1 | 4 673 | Article, FAQPage, Breadcrumb | 8 | 2026-07-07 |
| /comparatif-plateformes-orchestration-multi-agents.html | 56 | 158 | 1 | 2 883 | Article, FAQPage, Breadcrumb | 5 | 2026-07-07 |
| /former-equipes-ia-entreprise.html | 63 | 157 | 1 | 2 351 | Article, FAQPage, Breadcrumb | 6 | 2026-07-07 |
| /legal.html | 46 | 100 | 1 | 468 | WebPage, Breadcrumb | 0 | 2026-06-11 |

**Autres relevés :** robots.txt 200 (2 133 o, aucun bloc Cloudflare injecté) · llms.txt 200 (6 692 o) · llms-full.txt 404 · sitemap.xml 200 (17 URLs, lastmod) · feed.xml/rss.xml/atom.xml 404 · favicon.ico 200 · og-image.jpg 200 (287 Ko) · 404 réel · www/http → 301 apex https.
