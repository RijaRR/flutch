'use strict';

const express = require('express');
const config = require('../config');
const { logger } = require('../lib/logger');
const asyncHandler = require('../middleware/asyncHandler');
const validate = require('../middleware/validate');
const { createTodoSchema, bulkTodoSchema } = require('../schemas');
const {
  requireAuth,
  getAuthUserId,
  getEffectiveOwnerEmail,
  checkAcquereurOwnership,
} = require('../middleware/auth');
const { pool, log, matchAcquereurToBiens } = require('../db');
const { createMatchActivity } = require('../pipedrive');

const router = express.Router();

router.get('/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const hideDelegation = req.query.hideDelegation !== 'false';
  const ownerEmail = await getEffectiveOwnerEmail(req);
  const sorteurMode = ownerEmail === '__sorteur__';

  let acquereurs;
  if (sorteurMode) {
    const { rows } = await pool.query(`
      SELECT a.id, a.titre, a.pipedrive_deal_id, a.contact_name, a.contact_email, a.contact_phone, a.owner_name,
             a.pipedrive_updated_at, a.pipedrive_created_at,
             c.budget_min, c.budget_max, c.rentabilite_min, c.secteurs
      FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
      WHERE a.archived = 0 AND a.pipedrive_stage_id = $1
      ORDER BY a.titre
    `, [config.SORTEUR_STAGE_ID]);
    acquereurs = rows;
  } else if (!ownerEmail) {
    const { rows } = await pool.query(`
      SELECT a.id, a.titre, a.pipedrive_deal_id, a.contact_name, a.contact_email, a.contact_phone, a.owner_name,
             a.pipedrive_updated_at, a.pipedrive_created_at,
             c.budget_min, c.budget_max, c.rentabilite_min, c.secteurs
      FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
      WHERE a.archived = 0 ORDER BY a.titre
    `);
    acquereurs = rows;
  } else {
    const { rows } = await pool.query(`
      SELECT a.id, a.titre, a.pipedrive_deal_id, a.contact_name, a.contact_email, a.contact_phone, a.owner_name,
             a.pipedrive_updated_at, a.pipedrive_created_at,
             c.budget_min, c.budget_max, c.rentabilite_min, c.secteurs
      FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
      WHERE a.archived = 0 AND a.owner_email = $1 ORDER BY a.titre
    `, [ownerEmail]);
    acquereurs = rows;
  }

  const result = [];
  let totalTodos = 0;
  let totalTraites = 0;

  for (const acq of acquereurs) {
    const biens = await matchAcquereurToBiens(acq.id, hideDelegation);
    if (!biens.length) continue;
    const nonTraite = biens.filter((b) => !b.statut_todo || b.statut_todo === 'non_traite').length;
    const envoye = biens.filter((b) => b.statut_todo === 'envoye').length;
    const refuse = biens.filter((b) => b.statut_todo === 'refuse').length;
    totalTodos += nonTraite;
    totalTraites += envoye + refuse;
    result.push({
      id: acq.id, titre: acq.titre, pipedrive_deal_id: acq.pipedrive_deal_id,
      contact_name: acq.contact_name, contact_email: acq.contact_email, contact_phone: acq.contact_phone, owner_name: acq.owner_name,
      pipedrive_updated_at: acq.pipedrive_updated_at, pipedrive_created_at: acq.pipedrive_created_at,
      budget_min: acq.budget_min, budget_max: acq.budget_max,
      rentabilite_min: acq.rentabilite_min, secteurs: acq.secteurs,
      total: biens.length, non_traite: nonTraite, envoye, refuse, biens,
    });
  }

  let pendingQueue = 0;
  if (!sorteurMode) {
    pendingQueue = parseInt((await pool.query(
      "SELECT COUNT(*) as n FROM email_queue eq JOIN acquereurs a ON a.id = eq.acquereur_id WHERE eq.status IN ('pending','sending') AND a.owner_email = $1",
      [ownerEmail]
    )).rows[0].n, 10);
  }

  res.json({
    acquereurs: result,
    total_acquereurs: result.length,
    total_todos: totalTodos,
    total_traites: totalTraites,
    pending_queue: pendingQueue,
  });
}));

router.post('/', requireAuth, validate(createTodoSchema), asyncHandler(async (req, res) => {
  const { acquereur_id, bien_id, statut } = req.body;
  if (statut === 'envoye') {
    return res.status(400).json({ error: 'Utilisez /api/email-queue/enqueue pour les envois' });
  }
  if (!(await checkAcquereurOwnership(acquereur_id, getAuthUserId(req), req))) {
    return res.status(403).json({ error: 'Accès non autorisé à cet acquéreur' });
  }
  await pool.query(`
    INSERT INTO todos (acquereur_id, bien_id, statut, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(acquereur_id, bien_id) DO UPDATE SET
      statut=EXCLUDED.statut, updated_by=EXCLUDED.updated_by, updated_at=NOW()
  `, [acquereur_id, bien_id, statut || 'non_traite', getAuthUserId(req), getAuthUserId(req)]);
  await log(getAuthUserId(req), 'todo_' + (statut || 'create'), 'bien', bien_id, { acquereur_id });

  if (config.PIPEDRIVE_API_TOKEN) {
    if (statut === 'envoye') {
      createMatchActivity(acquereur_id, bien_id, config.PIPEDRIVE_API_TOKEN, 'envoyer')
        .catch((e) => logger.error('⚠️ Activité [ENVOYER] non créée: ' + e.message));
    } else if (statut === 'refuse') {
      createMatchActivity(acquereur_id, bien_id, config.PIPEDRIVE_API_TOKEN, 'retirer')
        .catch((e) => logger.error('⚠️ Activité [RETIRER] non créée: ' + e.message));
    }
  }
  res.json({ success: true });
}));

router.post('/bulk', requireAuth, validate(bulkTodoSchema), asyncHandler(async (req, res) => {
  const { acquereur_id, bien_ids, statut } = req.body;
  if (statut === 'envoye') {
    return res.status(400).json({ error: 'Utilisez /api/email-queue/enqueue pour les envois' });
  }
  if (!(await checkAcquereurOwnership(acquereur_id, getAuthUserId(req), req))) {
    return res.status(403).json({ error: 'Accès non autorisé à cet acquéreur' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const bid of bien_ids) {
      await client.query(`
        INSERT INTO todos (acquereur_id, bien_id, statut, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(acquereur_id, bien_id) DO UPDATE SET
          statut=EXCLUDED.statut, updated_by=EXCLUDED.updated_by, updated_at=NOW()
      `, [acquereur_id, bid, statut, getAuthUserId(req), getAuthUserId(req)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await log(getAuthUserId(req), 'todo_bulk_' + statut, 'acquereur', acquereur_id, { count: bien_ids.length });

  if (config.PIPEDRIVE_API_TOKEN && bien_ids.length > 0) {
    if (statut === 'envoye') {
      createMatchActivity(acquereur_id, bien_ids, config.PIPEDRIVE_API_TOKEN, 'envoyer_bulk')
        .catch((e) => logger.error('⚠️ Activité [ENVOYER] bulk non créée: ' + e.message));
    } else if (statut === 'refuse') {
      createMatchActivity(acquereur_id, bien_ids, config.PIPEDRIVE_API_TOKEN, 'retirer_bulk')
        .catch((e) => logger.error('⚠️ Activité [RETIRER] bulk non créée: ' + e.message));
    }
  }
  res.json({ success: true, count: bien_ids.length });
}));

module.exports = router;
