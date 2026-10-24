# pi-codex-quota

Extension locale pour [Pi](https://pi.dev) : coût mensuel estimé à gauche et quotas de l’abonnement OpenAI Codex à droite, sous le modèle et le niveau de réflexion.

```text
Pi · oct. 2026 · ≈48,12 $           Codex restant · 5h : 82% ↻ 2h15 · hebdo : 64% ↻ 3j4h
```

Les chiffres ci-dessus sont fictifs. L’affichage utilise le gris du thème Pi et s’adapte à la largeur du terminal, avec troncature si nécessaire.

## Prérequis

- Pi 1.4.0 : version ciblée par cette première version, sans garantie pour les autres versions.
- Mode terminal interactif.
- Pour les quotas : connexion OAuth via `/login` au fournisseur `openai-codex`, puis sélection d’un modèle de ce fournisseur.

Le coût mensuel reste affiché avec les autres fournisseurs. Une simple clé API OpenAI ne donne pas accès aux quotas de l’abonnement Codex.

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

**Ne chargez pas deux copies de cette extension.** Si vous utilisez déjà les fichiers locaux `~/.pi/agent/extensions/codex-quota.ts` et `codex-quota-support/monthly-cost.ts`, désactivez la copie locale avant d’activer le package.

## Actualisation

Les coûts et quotas sont actualisés :

- au chargement de la session et lors d’un changement de modèle ;
- à la fin complète d’une tâche agentique (`agent_settled`), et non à chaque appel d’outil ou réponse intermédiaire ;
- à la demande avec `/quota`, quand le fournisseur actif est `openai-codex`.

Le minuteur redessine uniquement les comptes à rebours chaque minute : il ne déclenche aucune lecture d’historique ni requête réseau périodique. Les données de quota sont signalées comme périmées après six minutes sans actualisation, ou si une actualisation échoue. OpenAI peut mettre un délai à refléter la consommation.

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
- Les requêtes de quota sont des `GET` vers `https://chatgpt.com/backend-api/wham/usage`, avec les en-têtes d’authentification du compte Codex ; les redirections sont refusées.
- Aucun reset de quota, achat, envoi de prompts ou télémétrie n’est effectué par cette extension.
- L’analyse des coûts lit les historiques locaux, mais ne les envoie pas à OpenAI. Aucun corps de réponse réseau ni identifiant n’est affiché dans les erreurs.

**L’endpoint de quota est interne et non documenté comme une API publique stable.** Son format ou son accessibilité peuvent changer. Les quotas concernent le compte Codex, pas uniquement les usages effectués dans Pi.

## Vérification manuelle

Aucune suite de tests automatisée n’est fournie pour cette première version.

1. Exécuter `/reload`, puis `/quota` : vérifier la ligne sous le modèle.
2. Comparer les quotas au tableau de bord Codex du même compte.
3. Terminer une tâche agentique : vérifier l’actualisation des chiffres à sa fin.
4. Redimensionner le terminal : vérifier l’alignement et la troncature.
5. Passer à un autre fournisseur : vérifier que seul le montant mensuel reste affiché.

Ces vérifications ne garantissent ni la stabilité future de l’endpoint, ni l’exhaustivité des coûts si des historiques manquent.
