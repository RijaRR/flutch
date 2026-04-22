# flutch

## Défi 3 - Worker autonome Mickael

Cette réponse implémente un worker Node.js headless qui consomme l'API du Flutch pour relancer automatiquement les acquereurs "0 projet". Le worker est basé sur les fichiers [worker/apiClient.js](/home/rija/Documents/le-flutch-code-20260420-1551/worker/apiClient.js), [worker/agent.js](/home/rija/Documents/le-flutch-code-20260420-1551/worker/agent.js), [worker/stateStore.js](/home/rija/Documents/le-flutch-code-20260420-1551/worker/stateStore.js) et [worker/run.js](/home/rija/Documents/le-flutch-code-20260420-1551/worker/run.js).

### Ce que fait le worker

- Authentification HTTP sur `/api/login` avec récupération du token Bearer.
- Reconnexion automatique si un appel API renvoie `401`.
- Récupération des prospects via `GET /api/todos/dashboard`.
- Filtrage des biens non traités à partir du format réel `acquereur.biens` avec `statut_todo`.
- Selection de 1 a 3 biens maximum par acquereur.
- Envoi via `POST /api/email-queue/enqueue` avec le payload `{ acquereur_id, bien_ids, channel: "both" }`.
- Respect d'une fenêtre d'envoi Paris 9h-19h, d'une limite par cycle, et d'un délai entre deux envois pour ménager l'API.

### Authentification

Le client API du worker encapsule tout le cycle d'authentification :

- login HTTP sur `/api/login`
- stockage du token en mémoire
- ajout automatique du header `Authorization: Bearer <token>`
- re-login automatique puis replay de la requête si l'API retourne `401`

La logique est centralisee dans `FlutchApiClient` afin que `worker/agent.js` puisse piloter le cycle metier sans dupliquer la gestion du token.

### Consommation API

Le cycle principal du worker :

1. vérifie que l'heure courante est dans la plage autorisée
2. appelle `GET /api/todos/dashboard`
3. trie les acquereurs par `pipedrive_updated_at` décroissant
4. garde uniquement les biens dont `statut_todo` est absent ou égal à `non_traite`
5. choisit au maximum 3 biens
6. appelle `POST /api/email-queue/enqueue`

Quand plusieurs biens sont disponibles, le worker peut affiner la sélection avec :

- `GET /api/acquereurs/:id/detail`
- `GET /api/biens/:id/detail`

Le scoring reste simple et pragmatique : budget, rentabilité, occupation et ville servent à départager les biens.

### Gestion d'etat et anti-doublon

Le worker conserve un état local JSON dans `data/mickael-state.json`.

Cet état sert à :

- enregistrer les biens déjà envoyés par acquereur
- réserver un envoi avant l'appel réseau
- éviter qu'un même bien soit renvoyé après crash ou restart
- relâcher la réservation uniquement quand l'API renvoie une erreur explicite

Le choix de persister avant l'appel réseau privilégie l'absence de doublon. En cas d'erreur réseau ambiguë, la réservation est conservée pour éviter un second envoi potentiel.

### Lancement

Scripts disponibles dans `package.json` :

- `npm run worker:mickael`
- `npm run worker:mickael:once`

Variables attendues :

- `FLUTCH_API_URL`
- `FLUTCH_EMAIL`
- `FLUTCH_PASSWORD`
- `TIMEZONE`
- `MAX_SENDS_PER_CYCLE`
- `CYCLE_INTERVAL_MINUTES`
- `SEND_HOURS_START`
- `SEND_HOURS_END`

### Vérification

La vérification a été faite à deux niveaux :

- tests unitaires ajoutés pour le worker dans `tests/worker.apiClient.test.js`, `tests/worker.stateStore.test.js` et `tests/worker.agent.test.js`
- vérification manuelle du login et du format réel retourné par `GET /api/todos/dashboard`

Points vérifiés :

- login conforme
- token Bearer conforme
- reconnexion sur `401`
- format réel du dashboard basé sur `biens` et `statut_todo`
- envoi borné à 3 biens maximum
- protection anti-doublon après persistance locale
