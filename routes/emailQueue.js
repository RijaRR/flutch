'use strict';

const express = require('express');
const config = require('../config');
const { logger } = require('../lib/logger');
const asyncHandler = require('../middleware/asyncHandler');
const validate = require('../middleware/validate');
const { enqueueEmailSchema } = require('../schemas');
const {
  requireAuth,
  getAuthUserId,
  getEffectiveOwnerEmail,
  checkAcquereurOwnership,
} = require('../middleware/auth');
const { pool, log } = require('../db');
const { createMatchActivity } = require('../pipedrive');
const { processEmailQueue } = require('../services/emailQueueService');
const { fetchBrevoEvents } = require('../services/brevoService');

const router = express.Router();

router.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const ownerEmail = await getEffectiveOwnerEmail(req);
  const q = (status) => pool.query(
    "SELECT COUNT(*) as n FROM email_queue eq JOIN acquereurs a ON a.id = eq.acquereur_id WHERE eq.status = $2 AND a.owner_email = $1",
    [ownerEmail, status]
  ).then((r) => parseInt(r.rows[0].n, 10));

  const [pending, sending, sent, failed] = await Promise.all([
    q('pending'), q('sending'), q('sent'), q('failed'),
  ]);

  const { rows: failedItems } = await pool.query(`
    SELECT eq.id, eq.error_message, eq.attempts, eq.created_at, eq.channel,
           b.titre as bien_titre, b.pipedrive_deal_id as bien_pd_id,
           a.titre as acquereur_titre, a.contact_name as acquereur_contact
    FROM email_queue eq
    LEFT JOIN biens b ON b.id = eq.bien_id
    LEFT JOIN acquereurs a ON a.id = eq.acquereur_id
    WHERE eq.status = 'failed' AND a.owner_email = $1
    ORDER BY eq.created_at DESC
  `, [ownerEmail]);

  res.json({ success: true, pending, sending, sent, failed, failedItems });
}));

router.get('/history', requireAuth, asyncHandler(async (req, res) => {
  const ownerEmail = await getEffectiveOwnerEmail(req);
  const { rows: items } = await pool.query(`
    SELECT eq.id, eq.status, eq.error_message, eq.attempts, eq.created_at, eq.sent_at, eq.channel,
           eq.brevo_message_id,
           b.titre as bien_titre, b.pipedrive_deal_id as bien_pd_id,
           a.titre as acquereur_titre, a.contact_name as acquereur_contact,
           a.contact_email as acquereur_email
    FROM email_queue eq
    LEFT JOIN biens b ON b.id = eq.bien_id
    LEFT JOIN acquereurs a ON a.id = eq.acquereur_id
    WHERE a.owner_email = $1
    ORDER BY eq.created_at DESC
    LIMIT 500
  `, [ownerEmail]);
  res.json({ success: true, items });
}));

// FIX Audit 3.12 — Cap sur les retries même avec force: true (max 3 tentatives)
router.post('/retry', requireAuth, asyncHandler(async (req, res) => {
  const ownerEmail = await getEffectiveOwnerEmail(req);
  const MAX_RETRY_ATTEMPTS = 3;
  // Même avec force=true, on ne relance que les items avec < MAX_RETRY_ATTEMPTS tentatives
  const sql = `UPDATE email_queue SET status = 'pending', error_message = NULL
    WHERE status = 'failed' AND attempts < $2
    AND acquereur_id IN (SELECT id FROM acquereurs WHERE owner_email = $1)`;
  const result = await pool.query(sql, [ownerEmail, MAX_RETRY_ATTEMPTS]);
  await log(getAuthUserId(req), 'email_queue_retry', 'email', null, { count: result.rowCount });
  res.json({ success: true, retried: result.rowCount });
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const ownerEmail = await getEffectiveOwnerEmail(req);
  const result = await pool.query(
    "DELETE FROM email_queue WHERE id = $1 AND acquereur_id IN (SELECT id FROM acquereurs WHERE owner_email = $2)",
    [req.params.id, ownerEmail]
  );
  if (result.rowCount === 0) return res.status(403).json({ error: 'Non autorisé ou élément introuvable' });
  res.json({ success: true });
}));

router.post('/enqueue', requireAuth, validate(enqueueEmailSchema), asyncHandler(async (req, res) => {
  const { acquereur_id, bien_ids, channel } = req.body;
  if (!acquereur_id || !bien_ids?.length) return res.status(400).json({ error: 'acquereur_id et bien_ids requis' });
  const channels = channel === 'both' ? ['sms', 'email'] : (channel === 'sms' ? ['sms'] : ['email']);

  if (!(await checkAcquereurOwnership(acquereur_id, getAuthUserId(req), req))) {
    return res.status(403).json({ error: 'Accès non autorisé à cet acquéreur' });
  }
  if (channels.includes('sms')) {
    const { rows: [acqCheck] } = await pool.query("SELECT contact_phone FROM acquereurs WHERE id = $1", [acquereur_id]);
    if (!acqCheck?.contact_phone) {
      return res.status(400).json({ error: 'Aucun numéro de téléphone pour cet acquéreur. SMS impossible.' });
    }
  }

  const client = await pool.connect();
  const userId = getAuthUserId(req);
  const alreadySent = [];
  const queued = [];
  try {
    await client.query('BEGIN');
    for (const bienId of bien_ids) {
      const { rows: existing } = await client.query(
        `SELECT id, statut FROM todos WHERE acquereur_id=$1 AND bien_id=$2`, [acquereur_id, bienId]
      );
      if (existing.length && existing[0].statut === 'envoye') {
        alreadySent.push(bienId);
        continue;
      }
      await client.query(`
        INSERT INTO todos (acquereur_id, bien_id, statut, created_by, updated_by)
        VALUES ($1, $2, 'envoye', $3, $4)
        ON CONFLICT(acquereur_id, bien_id) DO UPDATE SET
          statut='envoye', updated_by=EXCLUDED.updated_by, updated_at=NOW()
      `, [acquereur_id, bienId, userId, userId]);
      for (const ch of channels) {
        const { rows: dupCheck } = await client.query(
          `SELECT id FROM email_queue WHERE acquereur_id=$1 AND bien_id=$2 AND channel=$3 AND status='pending'`,
          [acquereur_id, bienId, ch]
        );
        if (!dupCheck.length) {
          await client.query(`
            INSERT INTO email_queue (todo_id, bien_id, acquereur_id, status, channel)
            VALUES (NULL, $1, $2, 'pending', $3)
          `, [bienId, acquereur_id, ch]);
        }
      }
      queued.push(bienId);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  if (config.PIPEDRIVE_API_TOKEN && queued.length > 0) {
    createMatchActivity(acquereur_id, queued, config.PIPEDRIVE_API_TOKEN, queued.length === 1 ? 'envoyer' : 'envoyer_bulk')
      .catch((e) => logger.error('⚠️ Activité non créée: ' + e.message));
  }

  if (queued.length > 0) processEmailQueue();

  await log(userId, 'email_enqueue', 'acquereur', acquereur_id, { count: queued.length, skipped: alreadySent.length, channels });
  res.json({ success: true, queued: queued.length, skipped_duplicates: alreadySent.length, channels });
}));

router.get('/brevo/events/:email', requireAuth, asyncHandler(async (req, res) => {
  const email = req.params.email;
  const ownerEmail = await getEffectiveOwnerEmail(req);
  const { rows } = await pool.query(
    "SELECT 1 FROM acquereurs WHERE contact_email = $1 AND owner_email = $2 LIMIT 1",
    [email, ownerEmail]
  );
  if (!rows.length) return res.status(403).json({ error: 'Accès non autorisé' });
  const events = await fetchBrevoEvents(email);
  res.json({ success: true, events });
}));

module.exports = router;
