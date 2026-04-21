# Le Flutch — Moteur de Rapprochement Immobilier

## Overview
Le Flutch is a real estate matching engine designed to connect property buyers with available properties.
It synchronizes data from Pipedrive CRM, performs matching algorithms using a PostgreSQL database, and provides a web-based interface for real estate agents.
The primary goal is to streamline the matching process, allow agents to manage and act on matches, and push relevant activities back into Pipedrive.
The project aims to improve efficiency in real estate transactions by automating property-buyer matching and communication.

## User Preferences
Preferred communication style: Simple, everyday language. French-speaking user.

## System Architecture

### Backend
The application is a Node.js/Express web app running on Replit.
It features a single-file Express server (`server.js`) handling all API routes and serving static frontend files.
It includes session management with PostgreSQL persistence, supports Replit's HTTPS proxy, and performs hourly Pipedrive data synchronization with daily integrity checks.

### Database
A Replit-managed PostgreSQL database is used, with `pg` for connection pooling.
Key tables include `users`, `biens` (properties), `acquereurs` (buyers), `acquereur_criteria`, `todos`, and `email_queue`.
The schema is initialized at startup, and all database operations use async/await with parameterized queries.

### Authentication
Session-based authentication is implemented using `express-session` and a PostgreSQL session store. Token-based authentication serves as a fallback.
The system supports `admin`, `manager`, and `agent` roles, with an impersonation feature allowing higher-privileged roles to view data belonging to other agents.
**Activation par lien email** : un admin peut créer un compte agent sans saisir de mot de passe — un email est envoyé à l'agent avec un lien d'activation unique (token 256-bit, expire 7 jours, usage unique).
L'agent choisit lui-même son mot de passe (≥10 caractères, au moins 1 lettre + 1 chiffre) sur la page publique `/setup-password.html`.
Endpoints : `POST /api/users` (admin, password optionnel), `POST /api/users/:id/send-setup-link` (admin, renvoi), `GET /api/setup-password/validate?token=` et `POST /api/setup-password` (publics, rate-limités 10/15min).
Table `password_setup_tokens` avec nettoyage opportuniste au démarrage.

### Sorteur Mode
Special "sorteur" agents (defined in `SORTEUR_EMAILS` array, currently `agent-test@example.com`) bypass the normal owner-based filtering.
Instead of seeing only their own acquéreurs, they see all acquéreurs with 0 envois (no `envoye` status in todos).
This is designed for trainee agents to practice pitching on untouched prospects.
The `__sorteur__` sentinel value is used internally for ownership checks and query routing.

### Pipedrive Integration
Le Flutch synchronizes property listings (biens) and buyer profiles (acquéreurs) from specific Pipedrive pipelines and stages.
It uses hardcoded Pipedrive field keys for various property and buyer attributes (e.g., price, rentability, occupation, sectors).
The integration includes real-time webhooks for immediate data synchronization upon deal creation, updates, or deletions in Pipedrive.

### Matching Engine
The core matching logic is implemented using SQL-based filtering for matching acquirers to properties and JavaScript-based filtering for matching properties to acquirers.
Criteria include budget, rentability, occupation type, and geographical sectors (postal codes).

### Frontend
A static HTML/CSS frontend provides the user interface (`public/`).
It includes a login page and a main agent interface (`search.html`) with three tabs:
1.  **Biens à envoyer**: Dashboard for managing pending tasks (TODOs) grouped by acquéreur, with bulk actions for sending/retiring property suggestions.
2.  **Mon acquéreur → Biens agence**: Allows agents to select an acquéreur, edit their criteria, search for matching properties, and send/retire individual or bulk suggestions.
Criteria changes can be pushed back to Pipedrive.
3.  **Bien agence → Mes acquéreurs**: Enables selection of a property to find matching acquéreurs and perform sending/retiring actions.
The UI also features detailed modals for properties and acquéreurs, an impersonation system for admins/managers, and a responsive design.
An email editor allows previewing and customizing emails before sending, with contenteditable bien cards for inline text editing.
When multiple biens are selected, the user can choose between "grouped" (one email with all biens) or "separate" (one email per bien) send mode.
Supports multi-acquéreur bulk sends. Tab 3 shows "derniers rentrés" and "derniers modifiés" biens when no bien is selected.
A robust email queue system tracks send status (pending, sent, failed) with retry mechanisms and detailed history.

### UI/UX
The application features a dark burgundy/maroon header with a pink accent color (`--primary: #d6336c`).
Fully responsive design with three media query breakpoints (768px, 480px) for mobile optimization.
Mobile-specific features include: icon-only tab labels (`.tab-label-text` hidden on mobile), 44px minimum touch targets on all interactive elements, full-screen modals using `100dvh` with `100vh` fallback for iOS/Android compatibility, horizontal-scrollable header buttons, stacked stats/actions, and compact layouts.
The frontend includes detailed modals for property and buyer information, integration of Google Maps/Street View, and specialized fields for real estate specifics.

### Security
Security measures include custom session cookie names, `httpOnly`, `sameSite`, and `secure` flags for cookies, XSS protection using `escapeHtml()`, CDN SRI for external libraries, and TLS for PostgreSQL connections.
Sensitive data like API tokens are not logged. All dev-api routes (`/__dev/*`) are blocked in production via `NODE_ENV` guard.
The image proxy (`/api/proxy-image`) validates URLs against internal/private IP ranges and verifies `image/*` content-type to prevent SSRF.
Token comparisons (health, webhook, password) use `crypto.timingSafeEqual` to prevent timing attacks.
`HEALTH_TOKEN` uses a random fallback instead of a hardcoded value.

## External Dependencies

### NPM Packages
-   `express`: HTTP server and routing.
-   `pg`: PostgreSQL client.
-   `express-session`: Session management.
-   `connect-pg-simple`: PostgreSQL session store.
-   `node-fetch`: HTTP client for Pipedrive API.

### External Services
-   **Pipedrive CRM**: Primary data source for properties and buyer profiles.
-   **PostgreSQL**: Replit managed database.
-   **Brevo (formerly Sendinblue) API**: Used for transactional email and SMS sending, including WhatsApp messages via Meta Cloud API.
It supports HTML email templates, compact SMS, and tracks message status (open, click, delivered, bounce) by querying Brevo events.
-   **Meta Cloud API (WhatsApp Business)**: For sending WhatsApp messages.
-   **Ringover**: SMS sortants depuis le numéro perso de chaque négociateur. Le routage utilise `users.ringover_number` (E.164) ;
fallback Brevo si vide. Pour (re)remplir cette colonne, exécuter `node scripts/update-ringover-numbers.js` (idempotent).
Cas non couverts au 18/04/2026 : Agent A et Agent B (numéros à fournir).

### Environment Variables
-   `DATABASE_URL`, `PIPEDRIVE_API_TOKEN`, `BREVO_API_KEY`: Essential for database, Pipedrive, and Brevo integration.
-   `SESSION_SECRET`, `WEBHOOK_SECRET`: For security and webhook authentication.
-   `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`: Required for WhatsApp functionality.