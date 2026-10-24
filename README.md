# pi-codex-quota

Extension locale pour [Pi](https://pi.dev) : coût mensuel estimé à gauche et quotas restants de l’abonnement du fournisseur actif à droite, sous le modèle et le niveau de réflexion.

```text
Pi · oct. 2026 · ≈48,12 $           Codex restant · 5h : 82% ↻ 2h15 · hebdo : 64% ↻ 3j4h
Pi · oct. 2026 · ≈48,12 $           Anthropic restant · 5h : 75% ↻ 1h30 · hebdo : 50% ↻ 4j2h
```

Le fournisseur du modèle sélectionné détermine les quotas affichés :

| Fournisseur Pi | Quotas affichés |
| --- | --- |
| `openai-codex` | Abonnement OpenAI Codex : 5 h et semaine |
| `anthropic` | Abonnement Anthropic Claude : 5 h et semaine, tous modèles confondus |
| Tout autre fournisseur | Partie quota masquée, sans requête de quota |

Les limites Anthropic propres à une famille de modèles et les crédits supplémentaires ne sont pas affichés. Le nom du modèle ou son protocole API ne détermine pas le fournisseur : un modèle Claude via OpenRouter, par exemple, ne déclenche pas de requête Anthropic.

Les chiffres ci-dessus sont fictifs. L’affichage utilise le gris du thème Pi et s’adapte à la largeur du terminal, avec troncature si nécessaire.

## Prérequis

- Pi 1.4.0 : version ciblée par cette première version, sans garantie pour les autres versions.
- Mode terminal interactif.
- Pour les quotas : connexion OAuth via `/login` au fournisseur `openai-codex` ou `anthropic`, puis sélection d’un modèle de ce fournisseur.

Le coût mensuel reste global et affiché avec tous les fournisseurs. Une simple clé API OpenAI ou Anthropic ne donne pas accès aux quotas de l’abonnement. Pour Anthropic, le jeton OAuth doit autoriser la lecture du profil (`user:profile`) ; en cas de refus HTTP 403, reconnectez-vous via `/login`.

## Installation

Les extensions s’exécutent avec les permissions de votre utilisateur : examinez le code avant de l’installer.

```bash
pi install git:github.com/Necsus/pi-codex-quota
```

Dans Pi, exécutez ensuite :

```text
/reload
```

Pour une installation depuis un clone local :

```bash
git clone https://github.com/Necsus/pi-codex-quota.git
pi install ./pi-codex-quota
```

**Ne chargez pas deux copies de cette extension.** Si vous utilisez déjà une copie locale dans `~/.pi/agent/extensions/codex-quota.ts` avec son dossier `codex-quota-support/`, désactivez cette copie avant d’activer le package.

## Actualisation

Les coûts et quotas sont actualisés :

- au chargement de la session et lors d’un changement de modèle ;
- à la fin complète d’une tâche agentique (`agent_settled`), et non à chaque appel d’outil ou réponse intermédiaire ;
- à la demande avec `/quota`, quand le fournisseur actif est `openai-codex` ou `anthropic`.

Un changement de modèle efface les quotas précédents et annule la requête en cours, afin de ne jamais afficher les données d’un autre fournisseur. Avec un fournisseur non pris en charge, seule la partie coût reste visible.

Le minuteur redessine uniquement les comptes à rebours chaque minute : il ne déclenche aucune lecture d’historique ni requête réseau périodique. Un astérisque discret après « Codex restant » ou « Anthropic restant » signale des données périmées après six minutes sans actualisation, ou si une actualisation échoue. Les valeurs affichées restent les dernières connues, sauf après un refus d’authentification (HTTP 401/403), qui les efface ; `/quota` permet de demander une actualisation. Les fournisseurs peuvent mettre un délai à refléter la consommation. Une fenêtre absente est indiquée « non communiqué » ; un compte à rebours expiré est indiqué « à actualiser ».

## Calcul du coût mensuel

- Addition des champs `usage.cost.total` enregistrés dans les historiques JSONL de Pi, y compris les usages enregistrés pour les outils, résumés et compactions.
- Période : mois civil courant dans le fuseau local de la machine.
- Sources : répertoire `sessions` de l’agent Pi, plus le répertoire de la session active s’il se trouve en dehors de celui-ci.
- Exclusion des entrées copiées ayant les mêmes identifiants et métadonnées.
- Les fichiers inchangés sont mis en cache en mémoire ; les fichiers modifiés sont relus intégralement. Seuls les coûts et métadonnées utiles sont conservés dans ce cache.
- Les erreurs de lecture ou de parsing produisent un indicateur `incomplet`. Les entrées sans coût exploitable ne sont pas valorisées.

**Le montant est une estimation en dollars US, pas une facture ni un supplément à un abonnement.** Il ne couvre pas les historiques supprimés, les autres machines ni les autres répertoires personnalisés non découverts. Un historique volumineux peut rendre l’actualisation plus coûteuse, surtout au premier chargement. Chaque instance Pi possède son propre cache.

## Authentification et confidentialité

- L’extension demande l’authentification à Pi via `getProviderAuth()` ; Pi gère lui-même le renouvellement OAuth normal.
- Elle ne lit ni ne modifie directement `auth.json` et n’enregistre aucun identifiant.
- Les requêtes de quota sont des `GET` vers un endpoint fixe du fournisseur actif :
  - OpenAI Codex : `https://chatgpt.com/backend-api/wham/usage`, avec le jeton OAuth et l’identifiant du compte Codex ;
  - Anthropic : `https://api.anthropic.com/api/oauth/usage`, avec le jeton OAuth et l’en-tête `anthropic-beta: oauth-2025-04-20`.
- Les redirections sont refusées. Aucun jeton n’est envoyé à l’autre fournisseur ni au fournisseur non pris en charge sélectionné.
- Aucun reset de quota, achat, envoi de prompts ou télémétrie n’est effectué par cette extension.
- L’analyse des coûts lit les historiques locaux, mais ne les envoie à aucun fournisseur. Aucun corps de réponse réseau ni identifiant n’est affiché dans les erreurs.

**Les endpoints de quota sont internes et non documentés comme des API publiques stables.** Leur format ou leur accessibilité peuvent changer. Les quotas concernent l’abonnement du compte du fournisseur, pas uniquement les usages effectués dans Pi.

## Tests automatisés

Avec Node.js 22.18 ou plus récent (prise en charge native de TypeScript), sans dépendance de test supplémentaire :

```bash
npm test
```

Les tests couvrent le routage par fournisseur, les formats de réponse, les pourcentages restants, les erreurs d’authentification et réseau, `/quota`, les requêtes concurrentes et les changements rapides de fournisseur. Les appels réseau, l’historique de coûts et les fonctions d’affichage de Pi sont simulés : aucun compte réel n’est utilisé.

## Vérification manuelle

1. Exécuter `/reload`, sélectionner un modèle `openai-codex`, puis `/quota` : vérifier la ligne sous le modèle et comparer au tableau de bord Codex du même compte.
2. Sélectionner un modèle `anthropic` connecté via OAuth, puis `/quota` : comparer les quotas 5 h et semaine à ceux du même compte Claude.
3. Terminer une tâche agentique : vérifier l’actualisation des chiffres à sa fin.
4. Redimensionner le terminal : vérifier l’alignement et la troncature.
5. Passer à un fournisseur non pris en charge : vérifier que seul le montant mensuel reste affiché.
6. Changer rapidement entre Codex, Anthropic et un autre fournisseur : vérifier qu’aucun ancien quota ne réapparaît.

Ces vérifications ne garantissent ni la stabilité future des endpoints, ni l’exhaustivité des coûts si des historiques manquent.
