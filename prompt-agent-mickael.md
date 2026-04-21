# Prompt pour créer le projet Agent Test

Copie-colle ce texte dans le chat du nouveau projet Replit "Agent Relance".
---

## Prompt à coller :

Crée un agent IA autonome en Node.js appelé "Worker".
C'est un agent de relance pour une agence immobilière.
### Ce que fait l'agent

L'agent travaille sur les acquéreurs "0 projet" — ce sont des prospects dormants dans le CRM Pipedrive de l'agence que personne ne traite.
Son job : leur envoyer des biens immobiliers commerciaux qui correspondent à leurs critères, par SMS d'abord puis par email.
L'agent ne travaille pas en direct sur une base de données.
Il se connecte à un outil existant appelé Le Flutch via son API REST.
Le Flutch gère déjà tout : la synchronisation Pipedrive, le matching biens/acquéreurs, l'envoi SMS via Brevo, l'envoi email via Brevo.
### Connexion au Flutch

L'agent se connecte au Flutch avec ces credentials :
- URL : (à mettre en variable d'environnement FLUTCH_API_URL)
- Email : agent-test@example.com
- Mot de passe : [MOT_DE_PASSE_TEST]

Endpoint de login :
POST {FLUTCH_API_URL}/api/login
Body: { "email": "agent-test@example.com", "password": "[MOT_DE_PASSE_TEST]" }
Réponse: { "success": true, "token": "...", "user": { "id": 8, "role": "agent" } }

Le token va dans le header `Authorization: Bearer {token}` pour tous les appels.
Il expire après 7 jours. Si un appel renvoie 401, l'agent doit se re-connecter automatiquement.
### Les endpoints que l'agent utilise

1. Récupérer ses acquéreurs et leurs biens matchés :
GET /api/todos/dashboard

Retourne la liste des acquéreurs "0 projet" avec pour chacun les biens matchés et leur statut (non_traite, envoye, refuse).
L'agent ne voit que les acquéreurs du stade 300 grâce à son compte sorteur.
2. Envoyer des biens à un acquéreur (SMS d'abord, puis email) :
POST /api/email-queue/enqueue
Body: { "acquereur_id": 123, "bien_ids": [83, 45], "channel": "both" }

Quand channel = "both", le SMS part en premier, puis l'email suit.
Le Flutch gère l'envoi via Brevo.

3. Voir le détail d'un bien :
GET /api/biens/{id}/detail

4. Voir le détail d'un acquéreur et ses critères :
GET /api/acquereurs/{id}/detail

5. Vérifier le statut de la queue d'envoi :
GET /api/email-queue/status

### Comportement de l'agent

- Il tourne en boucle entre 9h et 19h heure de Paris.
En dehors de ces heures, il dort.
- À chaque cycle, il récupère le dashboard, identifie les acquéreurs qui ont des biens non traités (statut "non_traite"), et leur envoie les meilleurs biens.
- Il sélectionne maximum 3 biens par acquéreur par envoi.
- Il ne renvoie jamais un bien déjà envoyé (statut "envoye").
- Il espace les envois de quelques secondes entre chaque acquéreur pour ne pas surcharger le système.
- Il a une limite par cycle (configurable, par défaut 20 acquéreurs par cycle).
- Il tourne toutes les 30 minutes.
- Il logge tout ce qu'il fait dans la console.

### Variables d'environnement

| Variable | Valeur |
|----------|--------|
| FLUTCH_API_URL | L'URL du Flutch (fournie pour le test) |
| FLUTCH_EMAIL | agent-test@example.com |
| FLUTCH_PASSWORD | [MOT_DE_PASSE_TEST] |
| MAX_SENDS_PER_CYCLE | 20 |
| CYCLE_INTERVAL_MINUTES | 30 |

### Ce que l'agent n'est PAS

- Pas une app web, pas de frontend, pas d'interface. C'est un worker headless.
- Il ne touche pas à Pipedrive directement, il passe par Le Flutch.
- Il ne touche pas à Brevo directement, il passe par Le Flutch.
- Il n'envoie rien automatiquement sans que la logique de filtre (biens non traités, heures ouvrées, limite par cycle) soit respectée.

### Stack

- Node.js
- fetch natif pour les appels API
- Pas de framework web
- Un simple fichier JSON local pour tracker son état (qui il a contacté, quand)