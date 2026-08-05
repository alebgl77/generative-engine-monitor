# Politique de sécurité

Cette application stocke des clés API tierces facturées à l'usage. C'est le bien à protéger en priorité, et le modèle de menace ci-dessous en découle.

## Signaler une vulnérabilité

Écrivez à **alexandre.beguel@gmail.com**, avec `SECURITY` en objet. N'ouvrez pas d'issue publique et ne joignez jamais de clé API réelle.

Un signalement utile contient :

- le type de faille et le composant concerné ;
- les étapes de reproduction, ou un correctif minimal qui la démontre ;
- l'impact que vous estimez ;
- la version ou le commit testé.

Engagement : accusé de réception sous 72 heures, première évaluation sous 7 jours, et information de l'avancement jusqu'à la publication du correctif. La divulgation coordonnée est bienvenue ; le crédit vous revient, sauf demande contraire.

## Périmètre

Le projet est **auto-hébergé et mono-locataire**. Vous exécutez le code, vous détenez la base, vous fournissez les secrets. Cela délimite ce que le projet peut garantir.

### Couvert

- Chiffrement au repos des identifiants fournisseurs, et rotation de ces clés.
- Authentification et contrôle de propriété sur les routes de l'API.
- Validation des entrées, y compris celles qui atterrissent dans un fichier exporté ou un en-tête de réponse.
- Neutralisation de l'injection de formule à l'export CSV.
- Refus de démarrer en production avec des secrets d'exemple.
- En-têtes de sécurité et politique de sécurité de contenu.
- Absence de fuite de secret dans les logs, les messages d'erreur et les réponses de l'API.

### Non couvert

- **Isolation multi-locataire.** Un utilisateur ne voit que ses projets et ses identifiants, et c'est vérifié sur chaque route ; mais il n'existe ni rôles, ni organisations, ni séparation au niveau de la base. Le modèle est « une instance, une équipe qui se fait confiance ».
- **Sécurité de l'infrastructure hôte.** Chiffrement disque, sauvegardes, TLS, pare-feu, durcissement du système : à votre charge.
- **Un administrateur système de l'instance.** Quiconque dispose d'un accès applicatif à la base *et* des variables d'environnement peut déchiffrer les identifiants. C'est inhérent au chiffrement applicatif : la protection vise le vol de la base seule, pas l'administrateur légitime de la machine.
- **Le comportement des fournisseurs.** Le contenu des réponses, leurs politiques de conservation et leurs incidents leur appartiennent.
- **Abus de coût.** L'application limite le débit des lancements et des appels, mais une clé valide entre les mains d'un utilisateur légitime peut engager des dépenses réelles. Fixez vos plafonds côté fournisseur.
- **Déni de service.** Aucune protection applicative au-delà des seaux à jetons décrits plus bas.

## Chiffrement des identifiants

`src/lib/crypto/credentials.ts`.

**AES-256-GCM**, IV de 12 octets tiré au hasard par écriture, étiquette d'authentification de 16 octets. Chaque clé API est chiffrée avant d'atteindre la base ; le texte clair n'existe qu'en mémoire, le temps d'un appel fournisseur ou d'une validation.

**Données additionnelles authentifiées.** La paire propriétaire `(userId, providerId)` est liée au chiffré. Un chiffré recopié sur la ligne d'un autre utilisateur, ou d'un autre moteur, échoue au déchiffrement au lieu de livrer silencieusement une clé payante à quelqu'un d'autre. L'étiquette n'est vérifiée qu'au `final()`, et rien n'est renvoyé avant.

**Empreinte.** Un HMAC-SHA-256 poivré permet de reconnaître une clé déjà enregistrée sans rien déchiffrer. Seuls les quatre derniers caractères sont conservés en clair, pour l'affichage masqué.

**Le texte clair ne sort jamais.** Aucune route ne le renvoie, aucun log ne le contient, aucune erreur levée par ce module ne le porte. La revalidation d'une clé stockée la déchiffre à l'intérieur de l'appel et n'en publie rien.

### Rotation

Chaque ligne enregistre la version de clé qui l'a chiffrée, et le déchiffrement cherche **cette** version, pas la version courante.

```bash
# 1. générer une clé de 32 octets en base64
npm run keygen

# 2. l'ajouter sous une nouvelle version
CREDENTIAL_KEYS={"1":"<ancienne>","2":"<nouvelle>"}

# 3. les nouvelles écritures utilisent la version 2
CREDENTIAL_KEY_CURRENT=2
```

La version 1 reste en place tant que des lignes l'utilisent : `needsRotation()` les signale, et une simple réécriture les migre. **Retirer une version rend définitivement illisibles les identifiants écrits avec elle** — le module échoue alors explicitement, avec la liste des versions présentes, plutôt que de dégrader silencieusement.

En cas de compromission suspectée d'une clé de chiffrement : effectuez la rotation, réécrivez toutes les lignes, puis **révoquez et remplacez les clés API concernées chez les fournisseurs**. La rotation protège le futur, pas ce qui a déjà pu être lu.

## Contrôles applicatifs

**Authentification.** NextAuth avec fournisseur `credentials`, session JWT de 7 jours, mots de passe hachés en bcrypt (coût 12). Le proxy protège les pages ; chaque route API porte sa propre garde, `withAuth` ou `withProject`, seule voie supportée vers une ressource de projet. Les entités enfants sont recherchées avec leur `projectId`, si bien qu'un identifiant valide d'un autre projet donne un `404` et non une écriture croisée.

**Inscription.** Seule mutation non authentifiée, et bornée deux fois. Un seau global de 30 inscriptions par heure est débité **en premier** : c'est lui qui tient réellement, car un client qui invente son adresse frapperait sinon un seau neuf à chaque requête. S'y ajoute un seau de 5 par heure et par adresse, qui n'existe que lorsque `TRUSTED_PROXY_HOPS` déclare un proxy et rend donc l'adresse connaissable. Le reste : mot de passe d'au moins 10 caractères mêlant lettre et chiffre, réponse à un doublon qui ne révèle pas quelles adresses possèdent déjà un compte, unicité laissée à l'index de la base plutôt qu'à une vérification préalable exposée aux courses.

**Adresse du client.** `src/lib/net/client-ip.ts` ne lit `X-Forwarded-For` que si `TRUSTED_PROXY_HOPS` est renseignée, et le lit **depuis la droite**, en remontant exactement le nombre de sauts déclaré : l'élément de gauche est toujours celui que le client a choisi d'écrire. Sans proxy déclaré, l'en-tête est ignoré et l'appelant retombe sur la garde grossière. L'en-tête brut est tout de même conservé dans la piste d'audit, à côté de l'adresse retenue — une assertion du client et une observation du serveur ne se rangent pas dans la même colonne.

**Limitation de débit.** Seaux à jetons persistés en base, donc partagés entre tous les processus : inscriptions, lancements d'analyses par utilisateur, appels par moteur. Un seau absent échoue en refus — un moteur inconnu ne reçoit pas une allocation illimitée.

**Validation.** Chaque corps et chaque chaîne de requête passe par un schéma Zod. Les domaines sont normalisés et validés, les alias contrôlés élément par élément, les longueurs et les cardinalités bornées.

**Export.** Les cellules CSV commençant par `=`, `+`, `-`, `@`, une tabulation ou un retour chariot sont préfixées d'une apostrophe : noms de concurrents et URL proviennent de sorties de modèles, et un tableur les exécuterait comme des formules. Le nom de fichier est translittéré et filtré avant d'atteindre l'en-tête `Content-Disposition`.

**En-têtes.** La `Content-Security-Policy` est émise **par requête** depuis `src/proxy.ts`, pas depuis `next.config.mjs` : elle porte un nonce tiré à chaque requête, posé à la fois sur la requête — Next.js y lit le nonce à appliquer à ses scripts — et sur la réponse. Le App Router expédie sa charge React par des `<script>` inline ; un `script-src 'self'` statique refuserait le bootstrap du framework et laisserait chaque page non hydratée. `strict-dynamic` accompagne le nonce pour que le bootstrap tire ses propres fragments sans qu'il faille les énumérer. La politique est appliquée avant la vérification de session, celle-ci renvoyant tôt pour la page de connexion : l'imbriquer laisserait justement le formulaire de connexion sans politique, donc sans scripts. Le segment `(auth)` est rendu par requête (`dynamic = "force-dynamic"`) pour la même raison — un document prérendu au build porterait un nonce ne correspondant à rien.

Contenu : `default-src 'self'`, `connect-src 'self'` — le navigateur ne parle jamais à une API fournisseur, tout appel sortant part du serveur ou du worker — `frame-ancestors 'none'`, `form-action 'self'`, `object-src 'none'`, `base-uri 'self'`. `style-src` admet `'unsafe-inline'`, Tailwind injectant ses styles à l'exécution sans point d'accroche pour un nonce, et `'unsafe-eval'` n'est ajouté à `script-src` qu'en développement, pour l'overlay Next.js.

Les en-têtes qui ne dépendent pas de la requête viennent de `next.config.mjs` : `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restrictive, `X-DNS-Prefetch-Control: off`, et HSTS en production. La CSP en est délibérément absente : un second en-tête de politique serait intersecté avec le premier par le navigateur, ce qui rebloquerait les scripts que le nonce existe pour autoriser.

**Erreurs.** Une défaillance inattendue renvoie `{"error":"Erreur interne"}` ; la trace et le détail vont aux logs. Aucune trace d'exécution ni fragment de requête n'atteint le client.

**Audit.** Inscriptions, création et invalidation d'identifiants, lancements et annulations d'analyses, replays et exports sont journalisés avec l'IP et l'agent utilisateur. Ces traces survivent à la suppression du compte concerné.

## Configuration en production

L'application **refuse de démarrer** si :

- `NEXTAUTH_SECRET` porte une valeur d'exemple ;
- `NEXTAUTH_URL` est absente ;
- `SEED_DEMO` est activé — il crée un compte dont les identifiants sont imprimés ;
- `CREDENTIAL_KEYS` contient encore la clé de développement de `.env.example` ;
- `CREDENTIAL_FINGERPRINT_PEPPER` en porte la valeur d'exemple ;
- `CREDENTIAL_KEY_CURRENT` désigne une version absente de `CREDENTIAL_KEYS` (vérifié dans tous les environnements).

Le silence eût été pire : c'est ainsi qu'un déploiement auto-hébergé se retrouve à tourner avec un secret de session public, dont quiconque peut forger un jeton.

Recommandations d'exploitation :

- servir derrière un TLS terminé, avec `NEXTAUTH_URL` en `https://` ;
- déclarer `TRUSTED_PROXY_HOPS` avec le nombre exact de reverses proxies devant l'application, faute de quoi la limitation par adresse ne s'active pas — et jamais un nombre supérieur, qui reviendrait à croire un saut que personne ne contrôle ;
- ne pas publier le port PostgreSQL — la composition de production ne le fait pas ;
- sauvegarder la base **et** `CREDENTIAL_KEYS` séparément : une sauvegarde sans les clés est inutilisable, une sauvegarde avec les clés au même endroit annule le chiffrement ;
- fixer des plafonds de dépense côté fournisseur ;
- surveiller `audit_logs` pour les invalidations d'identifiants, souvent le premier signe d'une clé partagée ou révoquée ailleurs.

## Versions prises en charge

Les correctifs de sécurité s'appliquent à la branche `main`. Le projet ne maintient pas de branches de correction rétroactives ; mettez à jour.
