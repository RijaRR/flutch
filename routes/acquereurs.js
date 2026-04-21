'use strict';

const express = require('express');
const config = require('../config');
const asyncHandler = require('../middleware/asyncHandler');
const validate = require('../middleware/validate');
const { updateAcquereurCriteriaSchema } = require('../schemas');
const {
  requireAuth,
  getAuthUserId,
  getEffectiveOwnerEmail,
  checkAcquereurOwnership,
} = require('../middleware/auth');
const { pool, log, matchAcquereurToBiens } = require('../db');
const { pushCriteriaToP } = require('../pipedrive');

const router = express.Router();

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { q } = req.query;
  const ownerEmail = await getEffectiveOwnerEmail(req);
  const isSearch = q && q.length >= 1;
  const limitVal = isSearch ? 100 : 20;
  const sorteurFilter = ownerEmail === '__sorteur__';
  let rows;

  if (isSearch) {
    const like = `%${q}%`;
    if (sorteurFilter) {
      ({ rows } = await pool.query(`
        SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.occupation_status, c.secteurs
        FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
        WHERE a.archived = 0 AND a.pipedrive_stage_id = $4
        AND (a.titre ILIKE $1 OR a.contact_name ILIKE $2 OR a.contact_email ILIKE $3)
        ORDER BY COALESCE(a.pipedrive_updated_at, a.pipedrive_created_at, a.synced_at) DESC LIMIT $5
      `, [like, like, like, config.SORTEUR_STAGE_ID, limitVal]));
    } else if (ownerEmail) {
      ({ rows } = await pool.query(`
        SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.occupation_status, c.secteurs
        FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
        WHERE a.archived = 0 AND (a.titre ILIKE $1 OR a.contact_name ILIKE $2 OR a.contact_email ILIKE $3) AND a.owner_email = $4
        ORDER BY COALESCE(a.pipedrive_updated_at, a.pipedrive_created_at, a.synced_at) DESC LIMIT $5
      `, [like, like, like, ownerEmail, limitVal]));
    } else {
      ({ rows } = await pool.query(`
        SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.occupation_status, c.secteurs
        FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
        WHERE a.archived = 0 AND (a.titre ILIKE $1 OR a.contact_name ILIKE $2 OR a.contact_email ILIKE $3)
        ORDER BY COALESCE(a.pipedrive_updated_at, a.pipedrive_created_at, a.synced_at) DESC LIMIT $4
      `, [like, like, like, limitVal]));
    }
  } else if (sorteurFilter) {
    ({ rows } = await pool.query(`
      SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.occupation_status, c.secteurs
      FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
      WHERE a.archived = 0 AND a.pipedrive_stage_id = $1
      ORDER BY COALESCE(a.pipedrive_updated_at, a.pipedrive_created_at, a.synced_at) DESC LIMIT $2
    `, [config.SORTEUR_STAGE_ID, limitVal]));
  } else if (ownerEmail) {
    ({ rows } = await pool.query(`
      SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.occupation_status, c.secteurs
      FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
      WHERE a.archived = 0 AND a.owner_email = $1
      ORDER BY COALESCE(a.pipedrive_updated_at, a.pipedrive_created_at, a.synced_at) DESC LIMIT $2
    `, [ownerEmail, limitVal]));
  } else {
    ({ rows } = await pool.query(`
      SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.occupation_status, c.secteurs
      FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
      WHERE a.archived = 0
      ORDER BY COALESCE(a.pipedrive_updated_at, a.pipedrive_created_at, a.synced_at) DESC LIMIT $1
    `, [limitVal]));
  }
  res.json({ success: true, acquereurs: rows });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' });
  const ownerEmail = await getEffectiveOwnerEmail(req);
  let acq;
  if (ownerEmail) {
    const { rows } = await pool.query(`
      SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.occupation_status, c.secteurs
      FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
      WHERE a.id = $1 AND a.owner_email = $2
    `, [id, ownerEmail]);
    acq = rows[0];
  } else {
    const { rows } = await pool.query(`
      SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.occupation_status, c.secteurs
      FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
      WHERE a.id = $1
    `, [id]);
    acq = rows[0];
  }
  if (!acq) return res.status(404).json({ error: 'Acquéreur introuvable' });
  res.json({ success: true, acquereur: acq });
}));

router.get('/:id/detail', requireAuth, asyncHandler(async (req, res) => {
  if (!(await checkAcquereurOwnership(req.params.id, getAuthUserId(req), req))) {
    return res.status(403).json({ error: 'Accès non autorisé à cet acquéreur' });
  }
  const { rows } = await pool.query(`
    SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.occupation_status, c.secteurs
    FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
    WHERE a.id = $1
  `, [req.params.id]);
  const acq = rows[0];
  if (!acq) return res.status(404).json({ error: 'Acquéreur introuvable' });

  const matchedBiens = await matchAcquereurToBiens(acq.id, false);
  acq.stats_envoyes = matchedBiens.filter((b) => b.statut_todo === 'envoye').length;
  acq.stats_refuses = matchedBiens.filter((b) => b.statut_todo === 'refuse').length;
  acq.stats_a_traiter = matchedBiens.filter((b) => !b.statut_todo || b.statut_todo === 'non_traite').length;

  res.json({ success: true, acquereur: acq });
}));

router.put('/:id/criteria', requireAuth, validate(updateAcquereurCriteriaSchema), asyncHandler(async (req, res) => {
  if (!(await checkAcquereurOwnership(req.params.id, getAuthUserId(req), req))) {
    return res.status(403).json({ error: 'Accès non autorisé à cet acquéreur' });
  }
  const { budget_min, budget_max, rentabilite_min, occupation_status, secteurs } = req.body;
  const OCC_LABEL_TO_IDS = {
    'Occupé': ['332', '352', '354'],
    'Libre': ['333', '351', '353'],
    'Location': ['334'],
  };
  let occupationIds = null;
  if (occupation_status && Array.isArray(occupation_status) && occupation_status.length > 0) {
    const ids = [];
    for (const label of occupation_status) {
      if (OCC_LABEL_TO_IDS[label]) ids.push(...OCC_LABEL_TO_IDS[label]);
    }
    if (ids.length > 0) occupationIds = JSON.stringify([...new Set(ids)]);
  }

  await pool.query(`
    INSERT INTO acquereur_criteria (acquereur_id, budget_min, budget_max, rentabilite_min, occupation_status, occupation_ids, secteurs, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT(acquereur_id) DO UPDATE SET
      budget_min=EXCLUDED.budget_min, budget_max=EXCLUDED.budget_max,
      rentabilite_min=EXCLUDED.rentabilite_min, occupation_status=EXCLUDED.occupation_status,
      occupation_ids=EXCLUDED.occupation_ids,
      secteurs=EXCLUDED.secteurs, updated_at=NOW()
  `, [
    req.params.id,
    budget_min || null, budget_max || null, rentabilite_min || null,
    occupation_status ? JSON.stringify(occupation_status) : null,
    occupationIds,
    secteurs ? JSON.stringify(secteurs) : null,
  ]);
  await log(getAuthUserId(req), 'update_criteria', 'acquereur', req.params.id, req.body);
  res.json({ success: true });
}));

router.post('/:id/push-pipedrive', requireAuth, asyncHandler(async (req, res) => {
  if (!(await checkAcquereurOwnership(req.params.id, getAuthUserId(req), req))) {
    return res.status(403).json({ error: 'Accès non autorisé à cet acquéreur' });
  }
  if (!config.PIPEDRIVE_API_TOKEN) {
    return res.status(400).json({ error: 'Clé Pipedrive non configurée' });
  }
  await pushCriteriaToP(req.params.id, config.PIPEDRIVE_API_TOKEN);
  await log(getAuthUserId(req), 'push_pipedrive', 'acquereur', req.params.id);
  res.json({ success: true });
}));

module.exports = router;
