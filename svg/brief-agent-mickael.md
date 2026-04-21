# Brief Projet : Agent Mickael — Agent IA de relance acquéreurs "0 projet"

## Contexte

L'agence immobilière **Le Boutiquier** dispose d'un outil interne appelé **Le Flutch** qui :
- Synchronise les biens (propriétés commerciales) et les acquéreurs (acheteurs potentiels) depuis Pipedrive CRM
- Fait du matching automatique entre biens et acquéreurs selon leurs critères (budget, rentabilité, secteur, occupation)
- Permet aux agents humains d'envoyer des présentations de biens par email, SMS et WhatsApp

Le Flutch tourne déjà en production. Il expose une API REST complète.

**Mickael** est un agent IA autonome dont le rôle est de **relancer automatiquement les acquéreurs "0 projet"** — des prospects dormants dans Pipedrive (stade 300 : "Acquéreur 0 projet") que personne ne traite manuellement. Il doit les contacter, leur présenter des biens matchés, et qualifier leur intérêt.

---

## Architecture

```
┌──────────────┐         API REST          ┌──────────────┐
│              │ ◄──────────────────────── │              │
│   Le Flutch  │  login, acquéreurs, biens │    Mickael   │
│  (existant)  │  matching, envoi SMS/mail │  (nouveau)   │
│              │ ────────────────────────► │              │
└──────┬───────┘                           └──────┬───────┘
       │                                          │
       ▼                                          ▼
   PostgreSQL                              Sa propre logique :
   Pipedrive                               - Scheduler 9h-19h
   Brevo (email/SMS)                       - Priorisation
                                           - Suivi des relances
                                           - Reporting
```

Mickael **ne touche jamais à la base de données directement**. Il passe exclusivement par l'API du Flutch.

---

## Connexion au Flutch — API disponible

### Base URL
```
https://ff4479e9-581f-4bc8-9d43-0156f79ea709-00-13cj6o5qzpslg.riker.replit.dev
```
(À remplacer par l'URL de prod après déploiement)

### Authentification
```
POST /api/login
Body: { "email": "mickael@leboutiquier.fr", "password": "MickaelBoutiquier2026!" }
Réponse: { "success": true, "token": "abc123...", "user": { "id": 8, "role": "agent" } }
```
Le token est à passer dans le header `Authorization: Bearer <token>` pour tous les appels suivants.
Le token expire après 7 jours. Mickael doit re-login si un appel renvoie 401.

### Récupérer les acquéreurs "0 projet"
```
GET /api/acquereurs
Réponse: liste d'acquéreurs filtrés automatiquement par le stade 300 (grâce au compte sorteur)
```
Chaque acquéreur contient :
- `id`, `titre`, `contact_name`, `contact_email`, `contact_phone`
- `pipedrive_deal_id`, `pipedrive_stage_id` (= 300)
- `owner_name`, `owner_email` (agent Pipedrive d'origine)

Avec recherche :
```
GET /api/acquereurs?q=paris
```

### Récupérer les critères d'un acquéreur
```
GET /api/acquereurs/:id/detail
Réponse: acquéreur + critères (budget_min, budget_max, rentabilite_min, secteurs, occupation_status)
         + stats (nb biens envoyés, refusés, à traiter)
```

### Lancer le matching pour un acquéreur
```
POST /api/match/acquereur-bien
Body: { "acquereur_id": 123 }
Réponse: { "matches": [...], "count": 15 }
```
Retourne les biens qui correspondent aux critères de l'acquéreur.

### Dashboard : acquéreurs + leurs biens matchés
```
GET /api/todos/dashboard
Réponse: {
  "total_acquereurs": 235,
  "total_todos": 6472,
  "acquereurs": [
    {
      "id": 123,
      "titre": "...",
      "contact_name": "Jean Dupont",
      "contact_phone": "+33612345678",
      "contact_email": "jean@example.com",
      "todos": [
        { "bien_id": 83, "statut": "non_traite", "bien_titre": "Laverie Paris 18", "prix_fai": 125000 }
      ]
    }
  ]
}
```

### Envoyer un SMS + email (via la queue)
```
POST /api/email-queue/enqueue
Body: {
  "acquereur_id": 123,
  "bien_ids": [83, 45],
  "channel": "both"   // "sms", "email", ou "both" (SMS part en premier)
}
```
Le SMS part avant l'email quand `channel = "both"`.

### Envoyer un email personnalisé
```
POST /api/email-send-custom
Body: {
  "acquereur_id": 123,
  "bien_ids": [83],
  "subject": "Opportunité OFF MARKET — Laverie Paris 18e",
  "intro": "Bonjour Jean,\n\nJe me permets de vous contacter...",
  "outro": "Bien cordialement,\nMickael — Le Boutiquier",
  "channel": "email"
}
```

### Prévisualiser / envoyer un WhatsApp
```
POST /api/whatsapp-preview
Body: { "acquereur_id": 123, "bien_ids": [83] }
Réponse: { "text": "Bonjour Jean, ...", "phone": "33612345678" }

POST /api/whatsapp-send
Body: { "acquereur_id": 123, "bien_ids": [83], "message": "Bonjour Jean, ..." }
```
⚠️ WhatsApp est actuellement désactivé (compte Meta dev à réactiver).

### Mettre à jour le statut d'un todo
```
POST /api/todos
Body: { "acquereur_id": 123, "bien_id": 83, "statut": "envoye" }
Statuts possibles : "non_traite", "envoye", "refuse"
```

### Mise à jour en masse
```
POST /api/todos/bulk
Body: { "acquereur_id": 123, "items": [{ "bien_id": 83, "statut": "envoye" }, ...] }
```

### Détails d'un bien
```
GET /api/biens/:id/detail
Réponse: toutes les infos du bien (prix, surface, rentabilité, ville, photos, loyer, etc.)
```

### Historique des envois (vérifier si déjà contacté)
```
GET /api/email-queue/status
Réponse: { "pending": 0, "sending": 0, "sent": 12, "failed": 1 }
```

---

## Schéma des données clés

### Acquéreur
| Champ | Type | Description |
|-------|------|-------------|
| id | int | ID interne |
| contact_name | text | Nom complet |
| contact_email | text | Email |
| contact_phone | text | Téléphone (format variable : 06..., +33...) |
| pipedrive_stage_id | int | 300 = "0 projet" (ceux que Mickael traite) |

### Critères acquéreur
| Champ | Type | Description |
|-------|------|-------------|
| budget_min / budget_max | float | Fourchette budget en € |
| rentabilite_min | float | Rendement minimum attendu (ex: 6.0 = 6%) |
| secteurs | text | Villes/zones recherchées (séparées par virgule) |
| occupation_status | text | "Murs occupés", "Murs libres", "Location pure" |

### Bien
| Champ | Type | Description |
|-------|------|-------------|
| id | int | ID interne |
| titre | text | Ex: "OFF MARKET Murs occupés Laverie Paris 18" |
| prix_fai | float | Prix FAI en € |
| rentabilite | float | Rendement brut |
| surface | float | Surface en m² |
| ville | text | Ville |
| occupation_status | text | Type d'occupation |
| loyer_net_bailleur | float | Loyer annuel net |
| photo_1..4 | text | URLs des photos |

---

## Workflow de Mickael

### Boucle principale (toutes les X minutes, entre 9h et 19h)

```
1. Login au Flutch (ou réutiliser le token si encore valide)
2. GET /api/todos/dashboard → récupérer tous les acquéreurs "0 projet" avec leurs biens matchés
3. Pour chaque acquéreur non encore contacté :
   a. Filtrer les biens non traités (statut = "non_traite")
   b. Si aucun bien matché → passer
   c. Sélectionner les 1-3 meilleurs biens (par rentabilité, adéquation budget)
   d. POST /api/email-queue/enqueue avec channel "both" (SMS d'abord, puis email)
   e. Logger l'envoi localement
4. Attendre le prochain cycle
```

### Règles métier suggérées
- **Pas de double envoi** : vérifier que le bien n'a pas déjà statut "envoye" avant d'envoyer
- **Limite quotidienne** : ne pas envoyer plus de X acquéreurs/jour pour éviter le spam
- **Heures d'envoi** : uniquement entre 9h et 19h (heure de Paris)
- **Priorisation** : commencer par les acquéreurs les plus récents (pipedrive_updated_at DESC)
- **Espacement** : attendre quelques secondes entre chaque envoi pour ne pas surcharger Brevo

### Relance (v2)
- Si un acquéreur a été contacté il y a 7 jours sans réponse → relancer avec d'autres biens
- Si un acquéreur a ouvert l'email (via `/api/brevo/events/:email`) mais pas répondu → relancer

---

## Variables d'environnement nécessaires pour le projet Mickael

| Variable | Description |
|----------|-------------|
| `FLUTCH_API_URL` | URL de base du Flutch (ex: https://...replit.dev) |
| `FLUTCH_EMAIL` | mickael@leboutiquier.fr |
| `FLUTCH_PASSWORD` | MickaelBoutiquier2026! |
| `TIMEZONE` | Europe/Paris |
| `MAX_SENDS_PER_CYCLE` | Nombre max d'acquéreurs contactés par cycle (ex: 20) |
| `CYCLE_INTERVAL_MINUTES` | Intervalle entre les cycles (ex: 30) |
| `SEND_HOURS_START` | 9 |
| `SEND_HOURS_END` | 19 |

---

## Stack technique suggérée

- **Runtime** : Node.js (même stack que Le Flutch pour cohérence)
- **Scheduler** : `node-cron` ou simple `setInterval` avec vérification d'heure
- **HTTP client** : `fetch` natif (Node 18+)
- **Logging** : console + fichier de log rotatif
- **Pas de base de données** : Mickael peut stocker son état localement (JSON file ou SQLite léger) pour tracker qui il a contacté et quand
- **Pas de frontend** : c'est un worker headless, pas une app web

---

## Ce qui est déjà prêt côté Flutch

- ✅ Compte `mickael@leboutiquier.fr` créé (rôle agent, mode sorteur)
- ✅ Filtrage automatique : quand Mickael se connecte, il ne voit que les acquéreurs stade 300
- ✅ 319 acquéreurs "0 projet" synchronisés, dont 235 avec des biens matchés
- ✅ Envoi SMS via Brevo (fonctionne, crédits disponibles)
- ✅ Envoi email via Brevo (fonctionne)
- ✅ Ordre SMS avant email quand channel = "both"
- ❌ WhatsApp désactivé (compte Meta dev à réactiver par Daniel)

---

## Exemple de code de démarrage

```javascript
const FLUTCH_URL = process.env.FLUTCH_API_URL;
let token = null;

async function login() {
  const res = await fetch(`${FLUTCH_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.FLUTCH_EMAIL,
      password: process.env.FLUTCH_PASSWORD
    })
  });
  const data = await res.json();
  if (!data.success) throw new Error('Login failed');
  token = data.token;
  console.log('Connecté au Flutch');
}

async function api(method, path, body) {
  if (!token) await login();
  const res = await fetch(`${FLUTCH_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    await login();
    return api(method, path, body);
  }
  return res.json();
}

async function cycle() {
  const hour = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', hour12: false });
  if (hour < 9 || hour >= 19) {
    console.log('Hors heures ouvrées, en pause...');
    return;
  }

  const dashboard = await api('GET', '/api/todos/dashboard');
  console.log(`${dashboard.total_acquereurs} acquéreurs, ${dashboard.total_todos} biens matchés`);

  let sent = 0;
  const MAX = parseInt(process.env.MAX_SENDS_PER_CYCLE || '20');

  for (const acq of dashboard.acquereurs) {
    if (sent >= MAX) break;

    const nonTraites = acq.todos?.filter(t => t.statut === 'non_traite') || [];
    if (!nonTraites.length) continue;

    const bienIds = nonTraites.slice(0, 3).map(t => t.bien_id);

    try {
      await api('POST', '/api/email-queue/enqueue', {
        acquereur_id: acq.id,
        bien_ids: bienIds,
        channel: 'both'
      });
      console.log(`✅ ${acq.contact_name} — ${bienIds.length} bien(s) envoyé(s)`);
      sent++;
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.error(`❌ ${acq.contact_name}: ${e.message}`);
    }
  }

  console.log(`Cycle terminé : ${sent} acquéreurs contactés`);
}

// Lancer toutes les 30 minutes
login().then(() => {
  cycle();
  setInterval(cycle, 30 * 60 * 1000);
});
```

---

## Évolutions futures possibles

1. **Personnalisation IA** : utiliser un LLM pour rédiger des messages personnalisés selon le profil de l'acquéreur
2. **Analyse des réponses** : si l'acquéreur répond par email/SMS, analyser sa réponse et adapter la relance
3. **Scoring** : prioriser les acquéreurs par probabilité de conversion (budget renseigné, téléphone présent, etc.)
4. **Dashboard Mickael** : une petite interface pour que Daniel suive les performances de Mickael (combien contactés, taux d'ouverture, réponses)
5. **Passage de stade Pipedrive** : quand un acquéreur montre de l'intérêt, le passer automatiquement du stade 300 au stade 291 pour qu'un agent humain prenne le relais
