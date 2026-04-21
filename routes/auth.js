'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { logger } = require('../lib/logger');
const { loginLimiter, setupPasswordLimiter, impersonateLimiter } = require('../middleware/rateLimiter');
const { requireAuth, getAuthUserId, getEffectiveOwnerEmail, getOwnerEmail } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { setupPasswordSchema } = require('../schemas');
const {
  pool,
  getUser,
  getUserById,
  checkPassword,
  hashPassword,
  createAuthToken,
  deleteAuthToken,
  getValidSetupToken,
  consumeSetupToken,
  log,
} = require('../db');

const router = express.Router();

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await getUser(email);
  if (!user || !checkPassword(user, password)) {
    // Log de tentative échouée — IP et email uniquement, JAMAIS le mot de passe.
    logger.warn('Login échoué', {
      ip: req.ip,
      email: typeof email === 'string' ? email : null,
      at: new Date().toISOString(),
    });
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }
  req.session.userId = user.id;
  const token = await createAuthToken(user.id);
  await log(user.id, 'login', 'user', user.id);
  res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) await deleteAuthToken(token);
  req.session.destroy();
  res.json({ success: true });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await getUserById(getAuthUserId(req));
  const effectiveEmail = await getEffectiveOwnerEmail(req);
  const ownEmail = await getOwnerEmail(getAuthUserId(req));
  const impersonating = (effectiveEmail && effectiveEmail !== ownEmail) ? effectiveEmail : null;
  let impersonateName = null;
  if (impersonating) {
    const { rows } = await pool.query(
      'SELECT DISTINCT owner_name FROM acquereurs WHERE owner_email = $1 LIMIT 1',
      [impersonating]
    );
    impersonateName = rows[0]?.owner_name || impersonating;
  }
  res.json({ success: true, user, impersonating, impersonateName });
}));

router.get('/impersonation/targets', requireAuth, asyncHandler(async (req, res) => {
  const user = await getUserById(getAuthUserId(req));
  if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
    return res.json({ success: true, targets: [] });
  }
  const { rows: owners } = await pool.query(`
    SELECT DISTINCT owner_email, owner_name
    FROM acquereurs WHERE owner_email IS NOT NULL AND archived = 0
    ORDER BY owner_name
  `);
  let targets;
  if (user.role === 'admin') {
    targets = owners.filter((o) => o.owner_email !== user.email);
  } else {
    const { rows: admins } = await pool.query("SELECT email FROM users WHERE role = 'admin'");
    const adminEmails = admins.map((u) => u.email);
    targets = owners.filter((o) => o.owner_email !== user.email && !adminEmails.includes(o.owner_email));
  }
  res.json({ success: true, targets });
}));

// FIX Audit 3.7 — Rate limiter + logging des échecs d'impersonation
router.post('/impersonate', requireAuth, impersonateLimiter, asyncHandler(async (req, res) => {
  const user = await getUserById(getAuthUserId(req));
  if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
    logger.warn('Impersonation refusée (rôle insuffisant)', { ip: req.ip, userId: user?.id });
    return res.status(403).json({ error: 'Non autorisé' });
  }
  const email = req.body.email ? req.body.email.trim().toLowerCase() : null;
  const authHeader = req.headers['authorization'] || '';
  const tokenVal = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!email) {
    req.session.impersonateEmail = null;
    if (tokenVal) await pool.query("UPDATE auth_tokens SET impersonate_email = NULL WHERE token = $1", [tokenVal]);
    await log(user.id, 'impersonate_stop', 'user', user.id);
    return res.json({ success: true, impersonating: null });
  }

  const { rows: ownerRows } = await pool.query(`
    SELECT DISTINCT owner_email FROM acquereurs WHERE owner_email IS NOT NULL AND archived = 0
  `);
  const ownerEmails = ownerRows.map((o) => o.owner_email);
  if (!ownerEmails.includes(email) || email === user.email) {
    // FIX Audit 3.7 — Logger les échecs d'impersonation (pas seulement les succès)
    logger.warn('Impersonation refusée (cible non autorisée)', { ip: req.ip, userId: user.id, target: email });
    await log(user.id, 'impersonate_denied', 'user', user.id, { target: email, reason: 'target_not_allowed' });
    return res.status(403).json({ error: 'Cible non autorisée' });
  }
  if (user.role === 'manager') {
    const { rows: admins } = await pool.query("SELECT email FROM users WHERE role = 'admin'");
    if (admins.map((u) => u.email).includes(email)) {
      logger.warn('Impersonation refusée (admin protégé)', { ip: req.ip, userId: user.id, target: email });
      await log(user.id, 'impersonate_denied', 'user', user.id, { target: email, reason: 'admin_protected' });
      return res.status(403).json({ error: 'Impossible de voir les données du fondateur' });
    }
  }

  req.session.impersonateEmail = email;
  if (tokenVal) await pool.query("UPDATE auth_tokens SET impersonate_email = $1 WHERE token = $2", [email, tokenVal]);
  await log(user.id, 'impersonate_start', 'user', user.id, { target: email });
  const { rows: nameRows } = await pool.query(
    'SELECT DISTINCT owner_name FROM acquereurs WHERE owner_email = $1 LIMIT 1', [email]
  );
  const targetName = nameRows[0]?.owner_name || email;
  res.json({ success: true, impersonating: email, impersonateName: targetName });
}));

router.get('/setup-password/validate', setupPasswordLimiter, asyncHandler(async (req, res) => {
  const token = String(req.query.token || '');
  const row = await getValidSetupToken(token);
  if (!row) return res.status(400).json({ error: 'Ce lien a expiré, demande à Daniel un nouveau lien' });
  res.json({ success: true, name: row.name, email: row.email, expires_at: row.expires_at });
}));

router.post('/setup-password', setupPasswordLimiter, validate(setupPasswordSchema), asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  const hash = hashPassword(password);
  const userId = await consumeSetupToken(token, hash);
  if (!userId) return res.status(400).json({ error: 'Ce lien a expiré, demande à Daniel un nouveau lien' });
  await log(userId, 'password_setup', 'user', userId);
  const user = await getUserById(userId);
  res.json({ success: true, redirect: '/login.html?activated=1', email: user?.email || null });
}));

module.exports = router;
