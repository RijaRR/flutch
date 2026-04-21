'use strict';

const { pool, getUserById, getUserByToken } = require('../db');
const config = require('../config');

/**
 * Extrait l'identifiant de l'utilisateur authentifié.
 * @param {import('express').Request} req
 * @returns {number|undefined}
 */
function getAuthUserId(req) {
  return req.session?.userId || req.tokenUserId;
}

/**
 * Middleware exigeant une session ou un Bearer token valide.
 * Pour les routes /api/*, retourne 401 ; sinon redirige vers /login.html.
 * @type {import('express').RequestHandler}
 */
function requireAuth(req, res, next) {
  // Utilise originalUrl pour préserver le chemin complet, même monté sous un sous-routeur.
  const isApi = (req.originalUrl || req.url || '').startsWith('/api/');
  if (req.session?.userId) return next();

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    getUserByToken(token)
      .then((user) => {
        if (user) {
          req.session.userId = user.id;
          req.tokenUserId = user.id;
          return next();
        }
        if (isApi) return res.status(401).json({ error: 'Non authentifié' });
        return res.redirect('/login.html');
      })
      .catch(() => {
        if (isApi) return res.status(401).json({ error: 'Non authentifié' });
        return res.redirect('/login.html');
      });
    return;
  }

  if (isApi) return res.status(401).json({ error: 'Non authentifié' });
  return res.redirect('/login.html');
}

/**
 * Middleware exigeant un utilisateur admin.
 * @type {import('express').RequestHandler}
 */
async function requireAdminAsync(req, res, next) {
  const user = await getUserById(getAuthUserId(req));
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: "Accès réservé à l'administrateur" });
  }
  next();
}

/**
 * @param {number|undefined} userId
 * @returns {Promise<string|null>}
 */
async function getOwnerEmail(userId) {
  const user = await getUserById(userId);
  return user ? user.email : null;
}

/**
 * @param {import('express').Request} req
 * @returns {Promise<boolean>}
 */
async function isSorteur(req) {
  const user = await getUserById(getAuthUserId(req));
  return !!(user && config.SORTEUR_EMAILS.includes(user.email));
}

/**
 * @param {import('express').Request} req
 * @returns {Promise<string|null>}
 */
async function getEffectiveOwnerEmail(req) {
  if (req.session?.impersonateEmail) return req.session.impersonateEmail;
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    const { rows } = await pool.query(
      'SELECT impersonate_email FROM auth_tokens WHERE token = $1 AND expires_at > NOW()',
      [token]
    );
    if (rows[0]?.impersonate_email) return rows[0].impersonate_email;
  }
  const user = await getUserById(getAuthUserId(req));
  if (user && config.SORTEUR_EMAILS.includes(user.email)) return '__sorteur__';
  return user ? user.email : null;
}

/**
 * @param {number|string} acquereurId
 * @param {number|undefined} userId
 * @param {import('express').Request} [req]
 * @returns {Promise<boolean>}
 */
async function checkAcquereurOwnership(acquereurId, userId, req) {
  const ownerEmail = req ? await getEffectiveOwnerEmail(req) : await getOwnerEmail(userId);
  // FIX Audit 3.4 — fail-closed: si on ne peut pas déterminer le propriétaire, on refuse l'accès
  if (!ownerEmail) return false;
  if (ownerEmail === '__sorteur__') {
    const { rows } = await pool.query(
      'SELECT id FROM acquereurs WHERE id = $1 AND archived = 0 AND pipedrive_stage_id = $2',
      [acquereurId, config.SORTEUR_STAGE_ID]
    );
    return rows.length > 0;
  }
  const { rows } = await pool.query(
    'SELECT id FROM acquereurs WHERE id = $1 AND owner_email = $2',
    [acquereurId, ownerEmail]
  );
  return rows.length > 0;
}

module.exports = {
  requireAuth,
  requireAdminAsync,
  getAuthUserId,
  getOwnerEmail,
  isSorteur,
  getEffectiveOwnerEmail,
  checkAcquereurOwnership,
};
