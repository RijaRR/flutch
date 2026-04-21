# flutch

## Defi 3 - Worker autonome Mickael

Cette reponse implemente un worker Node.js headless qui consomme l'API du Flutch pour relancer automatiquement les acquereurs "0 projet". Le worker est base sur les fichiers [worker/apiClient.js](/home/rija/Documents/le-flutch-code-20260420-1551/worker/apiClient.js), [worker/agent.js](/home/rija/Documents/le-flutch-code-20260420-1551/worker/agent.js), [worker/stateStore.js](/home/rija/Documents/le-flutch-code-20260420-1551/worker/stateStore.js) et [worker/run.js](/home/rija/Documents/le-flutch-code-20260420-1551/worker/run.js).

### Ce que fait le worker

- Authentification HTTP sur `/api/login` avec recuperation du token Bearer.
- Reconnexion automatique si un appel API renvoie `401`.
- Recuperation des prospects via `GET /api/todos/dashboard`.
- Filtrage des biens non traites a partir du format reel valide en `curl`, c'est-a-dire `acquereur.biens` avec `statut_todo`.
- Selection de 1 a 3 biens maximum par acquereur.
- Envoi via `POST /api/email-queue/enqueue` avec le payload `{ acquereur_id, bien_ids, channel: "both" }`.
- Respect d'une fenetre d'envoi Paris 9h-19h, d'une limite par cycle, et d'un delai entre deux envois pour menager l'API.

### Authentification

Le client API du worker encapsule tout le cycle d'authentification :

- login HTTP sur `/api/login`
- stockage du token en memoire
- ajout automatique du header `Authorization: Bearer <token>`
- re-login automatique puis replay de la requete si l'API retourne `401`

La logique est centralisee dans `FlutchApiClient` afin que `worker/agent.js` puisse piloter le cycle metier sans dupliquer la gestion du token.

### Consommation API

Le cycle principal du worker :

1. verifie que l'heure courante est dans la plage autorisee
2. appelle `GET /api/todos/dashboard`
3. trie les acquereurs par `pipedrive_updated_at` decroissant
4. garde uniquement les biens dont `statut_todo` est absent ou egal a `non_traite`
5. choisit au maximum 3 biens
6. appelle `POST /api/email-queue/enqueue`

Quand plusieurs biens sont disponibles, le worker peut affiner la selection avec :

- `GET /api/acquereurs/:id/detail`
- `GET /api/biens/:id/detail`

Le scoring reste simple et pragmatique : budget, rentabilite, occupation et ville servent a departager les biens.

### Gestion d'etat et anti-doublon

Le worker conserve un etat local JSON dans `data/mickael-state.json`.

Cet etat sert a :

- enregistrer les biens deja envoyes par acquereur
- reserver un envoi avant l'appel reseau
- eviter qu'un meme bien soit renvoye apres crash ou restart
- relacher la reservation uniquement quand l'API renvoie une erreur explicite

Le choix de persister avant l'appel reseau privilegie l'absence de doublon. En cas d'erreur reseau ambigue, la reservation est conservee pour eviter un second envoi potentiel.

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

### Verification

La verification a ete faite a deux niveaux :

- tests unitaires ajoutes pour le worker dans `tests/worker.apiClient.test.js`, `tests/worker.stateStore.test.js` et `tests/worker.agent.test.js`
- verification manuelle en `curl` du login et du format reel retourne par `GET /api/todos/dashboard`

Points verifies :

- login conforme
- token Bearer conforme
- reconnexion sur `401`
- format reel du dashboard base sur `biens` et `statut_todo`
- envoi borne a 3 biens maximum
- protection anti-doublon apres persistance locale
