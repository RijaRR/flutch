'use strict';

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const { logger } = require('./lib/logger');
const errorHandler = require('./middleware/errorHandler');
const { globalLimiter } = require('./middleware/rateLimiter');
const { pool, initSchema } = require('./db');
const { syncBiens, syncAcquereurs, integrityCheck, registerWebhooks } = require('./pipedrive');
const { resolveStageIds } = require('./services/pipedriveService');
const { schedule, shutdownAll } = require('./lib/scheduler');
const { withSyncLock } = require('./lib/syncLock');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// FIX Audit 3.5/3.9 — Activation du CSP en mode strict pour bloquer l'exfiltration XSS
// NOTE: 'unsafe-inline' (scripts + script-src-attr) requis tant que public/search.html
// embarque ses scripts en inline et utilise des handlers onclick="...". À retirer
// une fois la migration vers public/app.js (extraction prévue par l'audit) terminée.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// FIX Audit 3.9 — Protection CSRF via vérification du header Origin sur les requêtes mutatives
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Les webhooks Pipedrive n'envoient pas d'Origin — on les exclut
  if ((req.originalUrl || req.url || '').startsWith('/api/webhook')) return next();
  const origin = req.headers['origin'];
  if (!origin) return next(); // same-origin requests sans header Origin (forms classiques)
  const allowed = corsOrigins.length > 0 ? corsOrigins : [];
  // En dev, on est plus permissif
  if (!config.IS_PROD) return next();
  if (allowed.includes(origin)) return next();
  // Vérifier que l'origin correspond au host
  const host = req.headers['host'];
  if (host && (origin === `https://${host}` || origin === `http://${host}`)) return next();
  return res.status(403).json({ error: 'Requête cross-origin non autorisée' });
});

// CORS : par défaut bloque toute origine externe. CORS_ORIGIN (CSV) pour autoriser des front séparés.
const corsOrigins = config.CORS_ORIGIN
  ? config.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
app.use(cors({
  origin(origin, cb) {
    // Autorise les requêtes same-origin (pas de header Origin) et celles whitelistées.
    if (!origin) return cb(null, true);
    if (corsOrigins.length === 0) return cb(null, false);
    return cb(null, corsOrigins.includes(origin));
  },
  credentials: true,
}));

// Rate limiting global (100 req/min/IP) — scopé à l'API uniquement.
// Les fichiers statiques (express.static) ne sont pas comptés pour éviter les faux positifs.
app.use('/api', globalLimiter);

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// FIX Audit Phase 4 — dev-api uniquement monté hors production (double sécurité)
if (!config.IS_PROD) {
  app.use('/__dev', require('./routes/dev-api'));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  name: 'leflutch.sid',
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: config.SESSION_MAX_AGE_MS,
    // 'strict' en prod ; 'none' en dev pour rester compatible avec l'iframe Replit.
    sameSite: config.IS_PROD ? 'strict' : 'none',
    secure: true,
    httpOnly: true,
    path: '/',
    domain: config.COOKIE_DOMAIN,
  },
}));

app.use((req, _res, next) => {
  if (req.session && req.session.userId && req.session.cookie) {
    req.session.cookie.expires = new Date(Date.now() + config.SESSION_MAX_AGE_MS);
  }
  next();
});

// Routes thématiques
app.use('/', require('./routes/system'));               // /, /healthz, /api/health, /api/proxy-image, /api/bug-report
app.use('/api', require('./routes/auth'));              // /api/login, /api/logout, /api/me, /api/impersonate(/targets)?
app.use('/api/sync', require('./routes/sync'));
app.use('/api/acquereurs', require('./routes/acquereurs'));
app.use('/api/biens', require('./routes/biens'));
app.use('/api/match', require('./routes/matching'));
app.use('/api/todos', require('./routes/todos'));
app.use('/api/email-queue', require('./routes/emailQueue'));
app.use('/api', require('./routes/notifications'));     // email-test, sms-test, email-preview, email-send-custom, whatsapp-*
app.use('/api', require('./routes/admin'));             // admin/owners, stats, users, admin/integrity, admin/backup, admin/import-activities
app.use('/api/webhook', require('./routes/webhooks'));

// Catch-all pour les routes non trouvées — redirige vers la racine plutôt qu'un écran noir "Not Found"
app.use((req, res, next) => {
  const isApi = (req.originalUrl || req.url || '').startsWith('/api/');
  if (isApi) return res.status(404).json({ error: 'Route non trouvée' });
  // Pour les pages non-API, redirige vers l'accueil (qui gère auth → login/search)
  res.redirect('/');
});

app.use(errorHandler);

// FIX Audit Phase 4 — Fonctions auto-sync et intégrité (pilotées par lib/scheduler)
// Auto-sync protégé par un advisory lock PostgreSQL pour éviter les collisions avec les webhooks
async function runAutoSync() {
  if (!config.PIPEDRIVE_API_TOKEN) return;
  const { executed } = await withSyncLock(async () => {
    logger.info('⏰ Auto-sync Pipedrive...');
    await syncBiens(config.PIPEDRIVE_API_TOKEN, config.BIENS_STAGE, null, config.BIENS_PIPELINE);
    await syncAcquereurs(config.PIPEDRIVE_API_TOKEN, config.ACQUEREURS_PIPELINE, null, config.ACQUEREURS_STAGE);
    await syncAcquereurs(config.PIPEDRIVE_API_TOKEN, config.ACQUEREURS_PIPELINE, null, 'Acquéreur 0 projet');
  });
  if (!executed) {
    logger.info('⏰ Auto-sync skip — sync lock déjà pris');
    await pool.query(
      'INSERT INTO sync_log (type, status, count, message) VALUES ($1, $2, $3, $4)',
      ['auto_sync', 'skipped', 0, 'Sync lock unavailable']
    );
  }
}

async function runDailyIntegrity() {
  const report = await integrityCheck();
  if (report.issues.length) logger.warn('⚠️ Intégrité DB : ' + JSON.stringify(report.issues));
  else logger.info('✅ Intégrité DB : tout est clean');
}

async function startServer() {
  app.listen(config.PORT, async () => {
    await initSchema();
    logger.info('✅ PostgreSQL schema initialisé');
    logger.info(`\n🏠 Le Flutch démarré sur http://localhost:${config.PORT}`);
    logger.info(`   Base de données : PostgreSQL (Replit managed)`);
    logger.info(`   Biens         : pipeline "${config.BIENS_PIPELINE}" · étape "${config.BIENS_STAGE}"`);
    logger.info(`   Acquéreurs    : pipeline "${config.ACQUEREURS_PIPELINE}" · étape "${config.ACQUEREURS_STAGE}"`);
    logger.info(`   Auto-sync     : ${config.AUTO_SYNC_MINUTES > 0 ? `toutes les ${config.AUTO_SYNC_MINUTES} min` : 'désactivé'}`);
    logger.info(`   Webhooks      : temps réel activé`);
    logger.info(`   Intégrité     : quotidienne à ${config.DAILY_INTEGRITY_HOUR}h du matin\n`);

    if (config.PIPEDRIVE_API_TOKEN) {
      const baseUrl = config.REPLIT_DEV_DOMAIN
        ? `https://${config.REPLIT_DEV_DOMAIN}`
        : (config.REPL_SLUG ? `https://${config.REPL_SLUG}.${config.REPL_OWNER}.repl.co` : null);
      resolveStageIds()
        .then(() => {
          if (baseUrl) {
            registerWebhooks(config.PIPEDRIVE_API_TOKEN, baseUrl, config.WEBHOOK_SECRET)
              .catch((e) => logger.error('Webhook registration failed: ' + e.message));
          } else {
            logger.warn('⚠️ Pas de domaine public détecté — webhook non enregistré');
          }
        })
        .catch((err) => logger.error('Failed to resolve Pipedrive stage IDs at startup', err));
    }

    // FIX Audit Phase 4 — Utilisation du scheduler robuste avec mutex, jitter et arrêt propre
    if (config.AUTO_SYNC_MINUTES > 0 && config.PIPEDRIVE_API_TOKEN) {
      schedule('auto-sync', runAutoSync, {
        intervalMs: config.AUTO_SYNC_MINUTES * 60 * 1000,
        jitterMs: 30_000, // ±30s pour éviter les thundering-herd
        runAtStart: true,
        delayMs: 30_000,  // Premier run après 30s (temps de warm-up)
      });
    }

    // Intégrité quotidienne (toutes les 24h, premier run au prochain créneau prévu)
    const now = new Date();
    const nextIntegrity = new Date(now);
    nextIntegrity.setHours(config.DAILY_INTEGRITY_HOUR, 0, 0, 0);
    if (nextIntegrity <= now) nextIntegrity.setDate(nextIntegrity.getDate() + 1);
    schedule('daily-integrity', runDailyIntegrity, {
      intervalMs: 24 * 60 * 60 * 1000,
      runAtStart: true,
      delayMs: nextIntegrity - now,
    });
  });
}

// FIX Audit Phase 4 — Graceful shutdown
function gracefulShutdown(signal) {
  logger.info(`🛑 Signal ${signal} reçu — arrêt propre`);
  shutdownAll();
  pool.end().then(() => {
    logger.info('✅ Pool PostgreSQL fermé');
    process.exit(0);
  }).catch(() => process.exit(1));
  // Force exit après 10s
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer().catch((e) => {
  logger.error('❌ Erreur démarrage: ' + e.message);
  process.exit(1);
});
