'use strict';

const { pool } = require('../db');
const { logger } = require('../lib/logger');
const { sendBrevoEmail, sendBrevoSMS } = require('./brevoService');
const { sendDealSMS: sendRingoverDealSMS } = require('./ringoverService');
const config = require('../config');

/**
 * Récupère le négociateur (table users) lié à un acquéreur via owner_email.
 * Renvoie null si non trouvé.
 */
async function findNegoForAcquereur(acq) {
  if (!acq || !acq.owner_email) return null;
  const { rows } = await pool.query(
    'SELECT id, name, email, ringover_number, ringover_user_id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [acq.owner_email]
  );
  return rows[0] || null;
}

// FIX Audit 2.2 — Mutex pour empêcher le traitement parallèle de la file d'emails
let processing = false;

/** Nombre maximum de tentatives par item (FIX Audit 3.12) */
const MAX_ATTEMPTS = 3;

/**
 * Vide la file d'envoi (50 items max), groupe par acquéreur+canal.
 * Met à jour les statuts en base (sending → sent/failed).
 * Protégé par un mutex module-level ET par SELECT ... FOR UPDATE SKIP LOCKED (Phase 2).
 * @returns {Promise<void>}
 */
async function processEmailQueue() {
  if (processing) return;
  processing = true;
  try {
    await _processEmailQueueInternal();
  } finally {
    processing = false;
  }
}

async function _processEmailQueueInternal() {
  // FIX Audit 2.2 — Utilisation de FOR UPDATE SKIP LOCKED pour éviter les doublons en multi-process
  const client = await pool.connect();
  let pending;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM email_queue WHERE status = 'pending' AND attempts < $1
       ORDER BY created_at ASC LIMIT 50
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS]
    );
    pending = rows;
    if (!pending.length) {
      await client.query('COMMIT');
      return;
    }
    // Marquer immédiatement comme 'sending' dans la transaction
    for (const item of pending) {
      await client.query(
        "UPDATE email_queue SET status = 'sending', attempts = attempts + 1 WHERE id = $1",
        [item.id]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    logger.error('❌ Email queue lock error: ' + e.message);
    return;
  } finally {
    client.release();
  }

  if (!pending.length) return;

  /** @type {Record<string, {acqId: number, channel: string, items: Array<{id:number, bien_id:number}>}>} */
  const grouped = {};
  for (const item of pending) {
    const ch = item.channel || 'email';
    const key = `${item.acquereur_id}__${ch}`;
    if (!grouped[key]) grouped[key] = { acqId: item.acquereur_id, channel: ch, items: [] };
    grouped[key].items.push(item);
  }

  for (const { acqId, channel, items } of Object.values(grouped)) {
    const queueIds = items.map((i) => i.id);
    // Status déjà mis à 'sending' dans la transaction FOR UPDATE SKIP LOCKED ci-dessus

    try {
      const { rows: [acq] } = await pool.query(
        "SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.secteurs FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id WHERE a.id = $1",
        [acqId]
      );

      if (channel === 'sms' && !acq?.contact_phone) {
        for (const id of queueIds) {
          await pool.query("UPDATE email_queue SET status = 'failed', error_message = 'Aucun numéro de téléphone' WHERE id = $1", [id]);
        }
        continue;
      }
      if (channel === 'email' && !acq?.contact_email) {
        for (const id of queueIds) {
          await pool.query("UPDATE email_queue SET status = 'failed', error_message = 'Acquéreur ou email introuvable' WHERE id = $1", [id]);
        }
        continue;
      }

      const bienIds = [...new Set(items.map((i) => i.bien_id))];
      const placeholders = bienIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows: biens } = await pool.query(`SELECT * FROM biens WHERE id IN (${placeholders})`, bienIds);

      if (!biens.length) {
        for (const id of queueIds) {
          await pool.query("UPDATE email_queue SET status = 'failed', error_message = 'Aucun bien trouvé' WHERE id = $1", [id]);
        }
        continue;
      }

      if (channel === 'sms') {
        // Préfère Ringover (envoi depuis le numéro du négo). Fallback Brevo SMS :
        //  - si la clé Ringover est absente
        //  - si le négo n'a pas de numéro Ringover (pas mappé sur owner_email)
        //  - si Ringover échoue à l'exécution (timeout, 4xx/5xx, etc.)
        const nego = await findNegoForAcquereur(acq);
        let sentVia = 'brevo';
        let fallbackReason = null;
        if (!config.RINGOVER_API_KEY) fallbackReason = 'no_key';
        else if (!nego) fallbackReason = `no_nego(owner_email=${acq.owner_email || 'null'})`;
        else if (!nego.ringover_number) fallbackReason = `no_ringover_number(nego=${nego.email})`;

        if (!fallbackReason) {
          try {
            await sendRingoverDealSMS(acq, nego, biens);
            sentVia = 'ringover';
          } catch (ringErr) {
            logger.warn(`⚠️ Ringover a échoué pour acq #${acqId} (${ringErr.message}) — fallback Brevo SMS`);
            await sendBrevoSMS(acq, biens);
            sentVia = 'brevo (fallback Ringover)';
          }
        } else {
          logger.info(`ℹ️ SMS via Brevo pour acq #${acqId} (raison: ${fallbackReason})`);
          await sendBrevoSMS(acq, biens);
        }
        logger.info(`📱 SMS (${sentVia}) envoyé à ${acq.contact_phone} — ${biens.length} bien(s)`);
        for (const id of queueIds) {
          await pool.query("UPDATE email_queue SET status = 'sent', sent_at = NOW() WHERE id = $1", [id]);
        }
      } else {
        const emailResult = await sendBrevoEmail(acq, biens);
        const msgId = emailResult?.messageId || null;
        logger.info(`📧 Email envoyé à ${acq.contact_email} — ${biens.length} bien(s)${msgId ? ' (msgId: ' + msgId + ')' : ''}`);
        for (const id of queueIds) {
          await pool.query("UPDATE email_queue SET status = 'sent', sent_at = NOW(), brevo_message_id = $1 WHERE id = $2", [msgId, id]);
        }
      }
    } catch (e) {
      logger.error(`❌ ${channel === 'sms' ? 'SMS' : 'Email'} échoué pour acquéreur #${acqId}: ${e.message}`);
      for (const id of queueIds) {
        await pool.query("UPDATE email_queue SET status = 'failed', error_message = $1 WHERE id = $2", [e.message, id]);
      }
    }
  }
}

module.exports = { processEmailQueue };
