# Le Flutch

Moteur de rapprochement immobilier. Synchronise les données Pipedrive (biens et acquéreurs), exécute le matching côté PostgreSQL, et expose une interface web pour les agents.

## Stack

- **Runtime** : Node.js ≥ 18
- **Serveur** : Express 4
- **Base de données** : PostgreSQL (via `pg`)
- **Sessions** : `express-session` + `connect-pg-simple`
- **Source CRM** : Pipedrive API v1
- **Notifications** : Brevo (email + SMS)
- **Logs** : Winston avec rotation quotidienne
- **Tests** : Jest

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                       Navigateur                           │
│  public/login.html · public/search.html (UI agents)        │
└──────────────────────────┬─────────────────────────────────┘
                           │ HTTPS (cookies session)
┌──────────────────────────▼─────────────────────────────────┐
│                       server.js                            │
│  - Routage Express (auth, /api/*, /healthz)                │
│  - Auth par session + jeton Bearer                         │
│  - Proxy d'images sécurisé (anti-SSRF)                     │
│  - File d'envoi mails/SMS (Brevo)                          │
│  - Cron interne : autoSync, dailyIntegrity                 │
└──────┬──────────────────────┬──────────────────────────────┘
       │                      │
       │                      │
┌──────▼──────────┐    ┌──────▼────────────────┐
│     db.js       │    │     pipedrive.js      │
│  - Pool pg      │    │  - sync biens/acq.    │
│  - Schéma       │    │  - matching activité  │
│  - Auth/users   │    │  - retry exponentiel  │
│  - Matching SQL │    │  - webhooks           │
└──────┬──────────┘    └──────┬────────────────┘
       │                      │
┌──────▼──────────────────────▼──────────────────────────────┐
│                     PostgreSQL                             │
│  users · auth_tokens · biens · acquereurs · action_logs    │
│  email_queue · webhook_events · ...                        │
└────────────────────────────────────────────────────────────┘
```

## Modules transverses

```
lib/
├── logger.js     Winston + rotation quotidienne (logs/app-YYYY-MM-DD.log)
│                 Redaction automatique des champs sensibles.
├── retry.js      withRetry() : retry exponentiel paramétrable.
├── format.js     Helpers d'affichage (prix, %, dates, téléphone) typés JSDoc.
└── security.js   isBlockedHost (anti-SSRF), isValidEmail, escapeSqlLike, ...

routes/
└── dev-api.js    Endpoints de développement, BLOQUÉS en production
                  (NODE_ENV=production désactive le routeur entier).

tests/
├── format.test.js
├── retry.test.js
└── security.test.js
```

## Variables d'environnement

| Variable                 | Description                                           |
|--------------------------|-------------------------------------------------------|
| `DATABASE_URL`           | URL PostgreSQL                                        |
| `PIPEDRIVE_API_TOKEN`    | Jeton API Pipedrive                                   |
| `BREVO_API_KEY`          | Jeton API Brevo (mails / SMS)                         |
| `WEBHOOK_SECRET`         | Jeton attendu par `/api/webhook/pipedrive`            |
| `HEALTH_TOKEN`           | Jeton attendu par `/api/health`                       |
| `DEV_API_TOKEN`          | Jeton attendu par `/__dev/*` (dev uniquement)         |
| `SESSION_SECRET`         | Secret de signature des sessions                      |
| `AUTO_SYNC_MINUTES`      | Intervalle de synchronisation auto (défaut : 60)      |
| `LOG_LEVEL`              | `debug`, `info`, `warn`, `error` (défaut : `info`)    |
| `NODE_ENV`               | `production` désactive `/__dev/*` et durcit la TLS    |

## Démarrage

```bash
npm install
npm start         # node server.js
npm test          # exécute la suite Jest
```

## Sécurité

- Authentification par session signée + jeton Bearer (table `auth_tokens`).
- Mots de passe : `scrypt` + sel ; vérification `crypto.timingSafeEqual`.
- Proxy d'image : validation hôte/DNS contre les plages privées (`lib/security.js`),
  redirections refusées, content-type vérifié, taille plafonnée à 10 Mo.
- `/__dev/*` est bloqué entièrement en production (router middleware).
- Logs : aucun secret n'est journalisé (redaction automatique sur clés sensibles).

## Robustesse

- Tous les appels Pipedrive sont enveloppés par `withRetry` (3 tentatives,
  backoff exponentiel) et retentent uniquement les erreurs transitoires
  (HTTP 5xx/429/408, ETIMEDOUT, ECONNRESET, EAI_AGAIN, ENOTFOUND, ECONNREFUSED).
- Logs de rotation : 14 jours pour `app-*.log`, 30 jours pour `error-*.log`,
  rotation à 10 Mo, archivage gzip.

## Tests

```bash
npm test
```

Les tests unitaires couvrent les fonctions pures critiques (formatage,
sécurité, retry). Les routes Express sont testées en bout-en-bout via le
harnais Playwright lors des audits manuels.
