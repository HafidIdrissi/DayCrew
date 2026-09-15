# DayCrew HQ — décisions de P0/P1

Date : 15 septembre 2026. Branche inspectée : `mvp`, initialement propre. La cible est le brief `DayCrew_PROMPT_COMPLET_CODEX.md` (PHASE_ACTIVE=1).

## Cartographie P0

- `App.tsx` distribue les routes hash. `components.tsx` fournit le shell. `HomePage.tsx` consomme `/api/home`; `OfficePage.tsx` consomme `/api/office`. Le HQ reprend `/api/home`, et Office reste une vue compatible du même état persistant.
- `ChatPage.tsx` gère la discussion, la création et la modification des membres ; `TeamPage.tsx` expose sessions, tâches, activité et Skills. Les routes profondes `#teams/<id>`, `#teams/<id>/overview`, `#tasks/<session>/<task>`, `#needs-you` sont conservées.
- `EngineSelectionSchema` persiste `mode`, `provider` et `model` dans `.daycrew/`. `AgentSpec` transmet le modèle par lancement. L'ajout optionnel `reasoningEffort` ne renomme pas `provider` et ne migre pas les fichiers historiques.
- `ENGINE_REGISTRY` et `EngineService` servent les catalogues et la disponibilité. `gemini` reste Antigravity, sans confusion avec Gemini CLI. Claude Code est le moteur Auto actionnable ; Codex, Cursor et Grok restent des previews sans approbation native ; la démo est simulée.
- `WorkspaceRoot`, les jetons de sélection, l'API locale, la politique d'autonomie et les limites de tours restent l'autorité. Aucun appel CLI ni secret n'entre dans le navigateur.

## Décisions durables

1. Le HQ garde les données réelles de `/api/home`, avec Living et Focus comme présentations locales de la même réponse. Une salle des managers en phase 1 annonce la phase 2, sans exécution fictive.
2. La navigation principale devient HQ, Needs You, Tasks, Meetings (aperçu) et Library ; les Teams sont contextuelles. Settings, changement de Workspace et Office demeurent accessibles.
3. Les livrables montrés sont des résumés de sessions terminées, tâches achevées et références enregistrées. Aucun stockage parallèle n'est créé.
4. Un effort explicite exige un modèle exact dont le catalogue annonce les niveaux. Codex utilise `supported_reasoning_levels` de `codex debug models` et un `--config model_reasoning_effort=…` par processus. Claude Code utilise `--effort` par session uniquement sur les identifiants vérifiés par [sa documentation officielle](https://code.claude.com/docs/en/model-config). Les autres moteurs utilisent leur défaut, sans échelle supposée. La référence [Codex](https://learn.chatgpt.com/docs/config-file/config-reference) décrit la clé native ; le catalogue local ne prouve pas la disponibilité du compte pour une génération.
5. Changer de moteur ou modèle conserve un effort incompatible dans le formulaire jusqu'à un choix explicite. Le serveur refuse le couple incompatible. Les configurations anciennes sans effort se chargent telles quelles ; `gemini` ne change pas d'identité.
6. Le badge global « Needs You » et la liste contextuelle des Teams utilisent une même réponse `/api/home` pour le Workspace sélectionné. Les résumés propres à une Team gardent leurs propres nombres ; un écran de Team ne masque pas les décisions d'une autre Team dans la navigation.

## Routes livrées en P1

- `#home` : HQ Living ou Focus ; la préférence de vue reste locale et propre au Workspace.
- `#teams/<id>` : discussion ; `#teams/<id>/members/<member-id>` ouvre un agent dans la conversation. `#teams/<id>/discussion` reste compatible.
- `#teams/<id>/tasks`, `#teams/<id>/deliverables`, `#teams/<id>/members` : sections de Team ; `#teams/<id>/overview` conserve configuration, Skills et protections.
- `#meetings` : salle des managers en aperçu seulement, sans démarrage possible. `#office`, `#teams`, `#tasks`, `#needs-you`, `#skills` et `#settings` restent accessibles.

## Risques et limites

- Les catalogues dynamiques et les authentifications peuvent être inconnus ou indisponibles. Un échec de découverte n'efface pas un modèle enregistré.
- Un modèle personnalisé est possible seulement si le moteur le déclare, mais son effort ne peut pas être inventé sans métadonnées exactes.
- Les previews ne deviennent pas actionnables par l'ajout d'un effort. Le lancement avec compte réel et les limites du navigateur sont consignés dans le journal de progression.
