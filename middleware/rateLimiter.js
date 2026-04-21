'use strict';

const rateLimit = require('express-rate-limit');

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // Exclut les health checks et le webhook entrant Pipedrive (peut burst légitimement).
  skip: (req) => {
    const url = req.originalUrl || req.url || '';
    return (
      url.startsWith('/api/health') ||
      url.startsWith('/healthz') ||
      url.startsWith('/api/webhook')
    );
  },
  message: { error: 'Trop de requêtes, réessayez dans une minute' },
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Trop de tentatives de connexion, réessayez dans une minute' },
});

const setupPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes' },
});

// FIX Audit 3.7 — Rate limiter dédié pour /api/impersonate (5 req/min/IP)
const impersonateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives d'impersonation, réessayez dans une minute" },
});

module.exports = { globalLimiter, loginLimiter, setupPasswordLimiter, impersonateLimiter };
