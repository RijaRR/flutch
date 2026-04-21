'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const {
  requireAuth,
  getAuthUserId,
  getEffectiveOwnerEmail,
  checkAcquereurOwnership,
} = require('../middleware/auth');
const { log, matchAcquereurToBiens, matchBienToAcquereurs } = require('../db');

const router = express.Router();

router.post('/acquereur-bien', requireAuth, asyncHandler(async (req, res) => {
  const { acquereurId, hideelegation = true } = req.body;
  if (!acquereurId) return res.status(400).json({ error: 'acquereurId requis' });
  if (!(await checkAcquereurOwnership(acquereurId, getAuthUserId(req), req))) {
    return res.status(403).json({ error: 'Accès non autorisé à cet acquéreur' });
  }
  const biens = await matchAcquereurToBiens(acquereurId, hideelegation);
  await log(getAuthUserId(req), 'match', 'acquereur', acquereurId, { count: biens.length, hideelegation });
  res.json({ success: true, count: biens.length, biens });
}));

// FIX Audit 3.2 — IDOR: vérifier l'ownership du bien avant de retourner les acquéreurs matchés
router.post('/bien-acquereur', requireAuth, asyncHandler(async (req, res) => {
  const { bienId } = req.body;
  if (!bienId) return res.status(400).json({ error: 'bienId requis' });

  // Vérifier que le bien appartient à l'agent connecté (ou admin/manager)
  const { pool } = require('../db');
  const { getUserById } = require('../db');
  const config = require('../config');
  const user = await getUserById(getAuthUserId(req));
  if (user && user.role !== 'admin' && user.role !== 'manager' && !config.SORTEUR_EMAILS.includes(user.email)) {
    const effectiveEmail = await getEffectiveOwnerEmail(req);
    if (effectiveEmail && effectiveEmail !== '__sorteur__') {
      const { rows: bienRows } = await pool.query('SELECT owner_email FROM biens WHERE id = $1 AND archived = 0', [bienId]);
      if (!bienRows[0]) return res.status(404).json({ error: 'Bien introuvable' });
      if (bienRows[0].owner_email !== effectiveEmail) {
        return res.status(403).json({ error: 'Accès non autorisé à ce bien' });
      }
    }
  }

  const ownerEmail = await getEffectiveOwnerEmail(req);
  const acquereurs = await matchBienToAcquereurs(bienId, ownerEmail);
  await log(getAuthUserId(req), 'match', 'bien', bienId, { count: acquereurs.length });
  res.json({ success: true, count: acquereurs.length, acquereurs });
}));

module.exports = router;
