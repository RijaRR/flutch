'use strict';

const express = require('express');
const crypto = require('crypto');
const dns = require('dns');
const { promisify } = require('util');
const fetch = require('node-fetch');
const config = require('../config');
const { logger } = require('../lib/logger');
const { isBlockedHost } = require('../lib/security'); // FIX Audit 1.3 — Centralisé
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, getAuthUserId } = require('../middleware/auth');
const { pool, getUserById, log } = require('../db');
const { sendBugReportEmail } = require('../services/brevoService');

const router = express.Router();
const resolve4 = promisify(dns.resolve4);

// FIX Audit 4.7 — Health check applicatif réel (vérifie PostgreSQL, pool, file d'emails)
router.get('/healthz', asyncHandler(async (req, res) => {
  try {
    const dbStart = Date.now();
    await pool.query('SELECT 1');
    const dbMs = Date.now() - dbStart;
    const status = dbMs > 5000 ? 'degraded' : 'ok';
    res.json({
      status,
      time: new Date().toISOString(),
      db: {
        connected: true,
        response_ms: dbMs,
        pool_total: pool.totalCount,
        pool_idle: pool.idleCount,
        pool_waiting: pool.waitingCount,
      },
    });
  } catch (e) {
    res.status(503).json({
      status: 'error',
      time: new Date().toISOString(),
      error: 'Database unreachable',
    });
  }
}));

router.get('/api/health', asyncHandler(async (req, res) => {
  const token = req.query.token || req.headers['x-health-token'];
  const expected = config.HEALTH_TOKEN;
  if (!token || typeof token !== 'string' || token.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Token invalide' });
  }
  try {
    const dbStart = Date.now();
    const { rows: [dbCheck] } = await pool.query('SELECT COUNT(*) as biens FROM biens WHERE archived = 0');
    const { rows: [acqCheck] } = await pool.query('SELECT COUNT(*) as acquereurs FROM acquereurs WHERE archived = 0');
    const { rows: [queueCheck] } = await pool.query("SELECT COUNT(*) as pending FROM email_queue WHERE status = 'pending'");
    const dbMs = Date.now() - dbStart;
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      database: {
        connected: true,
        response_ms: dbMs,
        biens: parseInt(dbCheck.biens, 10),
        acquereurs: parseInt(acqCheck.acquereurs, 10),
        queue_pending: parseInt(queueCheck.pending, 10),
      },
    });
  } catch (e) {
    res.status(500).json({ status: 'error', timestamp: new Date().toISOString(), error: e.message });
  }
}));

// FIX Audit 1.3 — isBlockedHost est maintenant importé depuis lib/security.js

router.get('/api/proxy-image', requireAuth, asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url manquante');
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).send('Protocole non autorisé');
    if (isBlockedHost(parsed.hostname)) return res.status(403).send('URL interne non autorisée');
    try {
      const ips = await resolve4(parsed.hostname);
      if (ips.some((ip) => isBlockedHost(ip))) return res.status(403).send('URL résout vers une adresse interne');
    } catch (_) {}
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'manual',
      timeout: config.PROXY_IMAGE_TIMEOUT_MS,
    });
    if (response.status >= 300 && response.status < 400) {
      return res.status(403).send('Redirections non autorisées pour le proxy image');
    }
    if (!response.ok) return res.status(response.status).send('Image non accessible');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return res.status(400).send("Le contenu n'est pas une image");
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > config.PROXY_IMAGE_MAX_BYTES) return res.status(413).send('Image trop volumineuse');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    response.body.pipe(res);
  } catch (_e) {
    res.status(500).send('Erreur proxy image');
  }
}));

router.post('/api/bug-report', requireAuth, asyncHandler(async (req, res) => {
  const { note, screenshot } = req.body;
  if (!note && !screenshot) return res.status(400).json({ error: 'Note ou capture requise' });
  const userId = getAuthUserId(req);
  const user = await getUserById(userId);
  const userName = user ? user.name : 'Inconnu';
  const userEmail = user ? user.email : 'inconnu';

  await sendBugReportEmail({ userName, userEmail, note, screenshot });
  await log(userId, 'bug_report', 'system', null, { note: (note || '').substring(0, 200) });
  res.json({ success: true });
}));

router.get('/', (req, res) => {
  if (req.session?.userId) return res.redirect('/search.html');
  res.redirect('/login.html');
});

void logger;
module.exports = router;
