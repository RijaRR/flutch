'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, getEffectiveOwnerEmail, getAuthUserId } = require('../middleware/auth');
const { pool, getUserById } = require('../db');
const config = require('../config');

const router = express.Router();

/**
 * Vérifie si l'utilisateur a le droit d'accéder à un bien.
 * Admins et managers voient tout ; les agents ne voient que leurs propres biens.
 * Les sorteurs voient tous les biens (ils trient pour tout le monde).
 */
async function checkBienAccess(req, bienOwnerEmail) {
  const user = await getUserById(getAuthUserId(req));
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'manager') return true;
  if (config.SORTEUR_EMAILS.includes(user.email)) return true;
  const effectiveEmail = await getEffectiveOwnerEmail(req);
  if (effectiveEmail === '__sorteur__') return true;
  return effectiveEmail === bienOwnerEmail;
}

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 1) return res.json({ success: true, biens: [] });
  const like = `%${q}%`;
  const { rows } = await pool.query(`
    SELECT id, pipedrive_deal_id, titre, adresse, code_postal, ville,
           prix_fai, rentabilite, rentabilite_post_rev, occupation_status,
           surface, is_delegation, owner_name, photo_1, photo_2, photo_3,
           pipedrive_updated_at, pipedrive_created_at
    FROM biens WHERE archived = 0
      AND (titre ILIKE $1 OR CAST(pipedrive_deal_id AS TEXT) ILIKE $2 OR adresse ILIKE $3 OR code_postal ILIKE $4 OR ville ILIKE $5)
    ORDER BY COALESCE(pipedrive_updated_at, pipedrive_created_at, synced_at) DESC LIMIT 50
  `, [like, like, like, like, like]);
  res.json({ success: true, biens: rows });
}));

router.get('/recent', requireAuth, asyncHandler(async (req, res) => {
  const mode = req.query.mode === 'new' ? 'new' : 'modified';
  const orderCol = mode === 'new'
    ? 'COALESCE(pipedrive_created_at, synced_at)'
    : 'COALESCE(pipedrive_updated_at, pipedrive_created_at, synced_at)';
  const { rows } = await pool.query(`
    SELECT id, pipedrive_deal_id, titre, code_postal, ville, prix_fai, occupation_status,
           rentabilite_post_rev, pipedrive_updated_at, pipedrive_created_at, owner_name
    FROM biens WHERE archived = 0
    ORDER BY ${orderCol} DESC LIMIT 30
  `);
  res.json({ success: true, biens: rows });
}));

// FIX Audit 3.1 — IDOR: ownership check avant d'exposer les données financières
router.get('/:id/detail', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM biens WHERE id = $1 AND archived = 0', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Bien introuvable' });
  const bien = rows[0];
  if (!(await checkBienAccess(req, bien.owner_email))) {
    return res.status(403).json({ error: 'Accès non autorisé à ce bien' });
  }
  res.json({ success: true, bien });
}));

module.exports = router;
