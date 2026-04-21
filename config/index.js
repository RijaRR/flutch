'use strict';

const crypto = require('crypto');

const sanitize = (val) => (val == null ? '' : String(val)).replace(/\s+/g, '');
const num = (val, def) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
};

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

if (IS_PROD && !process.env.SESSION_SECRET) {
  // eslint-disable-next-line no-console
  console.error('❌ SESSION_SECRET non défini en production — refus de démarrer.');
  console.error('   Définissez la variable d\'environnement SESSION_SECRET (chaîne aléatoire ≥ 32 caractères).');
  process.exit(1);
}

const config = {
  NODE_ENV,
  IS_PROD,
  PORT: num(process.env.PORT, 3000),

  SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  CORS_ORIGIN: process.env.CORS_ORIGIN || '',
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || undefined,

  HEALTH_TOKEN: process.env.HEALTH_TOKEN || crypto.randomBytes(32).toString('hex'),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex'),

  BREVO_API_KEY: sanitize(process.env.BREVO_API_KEY),
  RINGOVER_API_KEY: sanitize(process.env.RINGOVER_API_KEY),
  PIPEDRIVE_API_TOKEN: process.env.PIPEDRIVE_API_TOKEN || '',

  BIENS_PIPELINE: process.env.BIENS_PIPELINE || 'Murs',
  BIENS_STAGE: process.env.BIENS_STAGE || 'Commercialisé',
  ACQUEREURS_PIPELINE: process.env.ACQUEREURS_PIPELINE || 'Acquéreurs',
  ACQUEREURS_STAGE: process.env.ACQUEREURS_STAGE || 'Matching commercialisé',

  AUTO_SYNC_MINUTES: num(process.env.AUTO_SYNC_MINUTES, 60),

  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID || process.env.PHONE_NUMBER_ID || '',

  REPLIT_DEV_DOMAIN: process.env.REPLIT_DEV_DOMAIN || '',
  REPL_OWNER: process.env.REPL_OWNER || '',
  REPL_SLUG: process.env.REPL_SLUG || '',

  SORTEUR_EMAILS: ['mickael@leboutiquier.fr'],
  SORTEUR_STAGE_ID: 300,

  BREVO_CACHE_TTL_MS: 5 * 60 * 1000,
  SESSION_MAX_AGE_MS: 8 * 60 * 60 * 1000,
  PROXY_IMAGE_MAX_BYTES: 10 * 1024 * 1024,
  PROXY_IMAGE_TIMEOUT_MS: 10 * 1000,
  DAILY_INTEGRITY_HOUR: 3,
};

module.exports = config;
