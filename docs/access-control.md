# Contrôle des inscriptions

`REGISTRATION_ENABLED` contrôle uniquement la création de nouveaux comptes :

| Valeur | Page `/signup` | `POST /api/auth/register` |
| --- | --- | --- |
| `true` | Formulaire d'inscription | Validation, quotas et création habituels |
| `false` | Message de fermeture et lien de connexion | `403` avec `Les inscriptions sont fermées.` |

Seules les chaînes exactes `true` et `false` sont acceptées. Une valeur absente
vaut `true` pour préserver les installations existantes ; l'exemple de production
et Compose de production utilisent explicitement `false` pour un lancement privé.
Ne recopiez pas la configuration de développement pour une exposition publique.

La fermeture intervient côté serveur, avant la lecture du corps, les quotas,
le hachage, la base de données et l'audit. Masquer le formulaire ne constitue pas
la protection : l'API refuse aussi les appels directs. Les connexions et sessions
des comptes existants continuent de fonctionner. Le premier compte n'est pas
un administrateur : l'application ne fournit ni rôles administrateur ni invitations.

## Appliquer un changement

La variable reste côté serveur et n'est jamais une variable `NEXT_PUBLIC_*`.
Sa validation est mise en cache par le processus. Redémarrez le serveur après
chaque modification ; avec Compose, recréez le service web afin de charger les
nouvelles variables (un simple `docker compose restart` ne recharge pas le fichier
d'environnement) :

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-deps --force-recreate web
```

Aucune reconstruction de l'image n'est nécessaire. La page d'inscription est
rendue dynamiquement avec le paramètre du serveur en cours d'exécution. Un onglet
déjà ouvert peut encore afficher l'ancien formulaire ; son envoi reste refusé
par l'API après la fermeture.

## Créer le premier compte, avant toute exposition publique

1. Préparez les secrets et démarrez la pile selon le [runbook de production](production-runbook.md).
   Gardez `APP_BIND_ADDRESS=127.0.0.1` et `REGISTRATION_ENABLED=false`.
   N'attachez pas encore de proxy public et n'ouvrez pas de port public vers le web.
2. Sur votre propre machine, utilisez directement `http://127.0.0.1:3000`.
   Pour une machine distante, accédez-y par SSH. Depuis votre poste, ouvrez un tunnel privé vers
   le port web local, par exemple `ssh -L 3000:127.0.0.1:3000 utilisateur@serveur`.
   Adaptez les ports si nécessaire. La valeur de `NEXTAUTH_URL` doit correspondre
   à l'URL de votre accès privé pendant cette étape.
3. Seulement lorsque cet accès privé est confirmé, passez temporairement
   `REGISTRATION_ENABLED=true` dans `.env.production` et recréez `web` avec la
   commande ci-dessus. Ouvrez `/signup` en local ou via le tunnel, créez votre propre compte
   avec un mot de passe unique d'au moins 10 caractères contenant une lettre et
   un chiffre, puis vérifiez la connexion. Aucun compte ni mot de passe n'est créé
   automatiquement ; n'activez pas le seed de démonstration en production.
4. Repassez immédiatement `REGISTRATION_ENABLED=false`, recréez `web`, puis
   rafraîchissez `/signup` pour constater sa fermeture. Vérifiez également depuis
   l'accès privé que cet appel direct renvoie **HTTP 403**, sans créer de compte :

   ```sh
   curl -i -X POST http://127.0.0.1:3000/api/auth/register \
     -H 'Content-Type: application/json' --data '{}'
   ```

   Vérifiez aussi que votre compte existant peut toujours se connecter.
5. **Seulement si vous souhaitez un accès réseau**, configurez ensuite l'URL HTTPS
   finale, le proxy et la confiance proxy selon le [runbook](production-runbook.md#access-mode-and-https), en laissant les inscriptions fermées.
   Recréez `web` après toute modification d'environnement et vérifiez encore
   `/signup` et le refus `403` sur l'URL finale.

Conserver une instance privée sur la boucle locale, directement ou par tunnel
SSH, est un mode d'utilisation normal : ni domaine ni proxy public ne sont
obligatoires. L'HTTP est réservé à cet accès en boucle locale ; tout accès réseau
direct, même sur un LAN, nécessite HTTPS.

Pour tout compte supplémentaire, répétez la séquence privée après avoir retiré
l'accès public au service. Ouvrir temporairement l'inscription sur une URL publique
permet à n'importe qui de créer un compte pendant cette fenêtre.
