'use strict';

const express = require('express');
const config = require('../config');
const { logger } = require('../lib/logger');
const asyncHandler = require('../middleware/asyncHandler');
const {
  requireAuth,
  requireAdminAsync,
  getAuthUserId,
  checkAcquereurOwnership,
} = require('../middleware/auth');
const { pool, log } = require('../db');
const { createMatchActivity } = require('../pipedrive');
const {
  sendBrevoEmail,
  sendBrevoSMS,
  sendBrevoCustomEmail,
  verifyBrevoAccount,
} = require('../services/brevoService');
const { sendDealSMS: sendRingoverDealSMS } = require('../services/ringoverService');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const {
  formatPhoneE164,
  buildBienCard,
  buildWhatsAppText,
} = require('../services/templates');

const router = express.Router();

router.post('/email-test', requireAuth, requireAdminAsync, asyncHandler(async (req, res) => {
  await verifyBrevoAccount();
  const { rows: biens } = await pool.query("SELECT * FROM biens LIMIT 2");
  if (!biens.length) return res.status(400).json({ error: 'Aucun bien en base' });

  const fakeAcq = {
    contact_email: 'daniel@leboutiquier.fr',
    contact_name: 'Daniel (TEST)',
    owner_name: 'Daniel',
    owner_email: 'daniel@leboutiquier.fr',
    pipedrive_deal_id: '00000',
  };
  await sendBrevoEmail(fakeAcq, biens);
  res.json({ success: true, message: `Email test envoyé à daniel@leboutiquier.fr avec ${biens.length} bien(s)` });
}));

router.post('/sms-test', requireAuth, requireAdminAsync, asyncHandler(async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Numéro de téléphone requis' });
  const { rows: biens } = await pool.query("SELECT * FROM biens LIMIT 2");
  if (!biens.length) return res.status(400).json({ error: 'Aucun bien en base' });

  // Récupère le négo connecté pour utiliser SON numéro Ringover s'il en a un.
  const userId = getAuthUserId(req);
  const { rows: [me] } = await pool.query(
    'SELECT id, name, email, ringover_number, ringover_user_id FROM users WHERE id = $1',
    [userId]
  );

  const fakeAcq = {
    contact_phone: phone,
    contact_name: 'Daniel (TEST)',
    owner_name: me?.name || 'Daniel',
    titre: 'Test SMS',
  };

  let sentVia = 'brevo';
  if (config.RINGOVER_API_KEY && me?.ringover_number) {
    try {
      await sendRingoverDealSMS(fakeAcq, me, biens);
      sentVia = 'ringover';
    } catch (ringErr) {
      logger.warn(`⚠️ Ringover a échoué pour /sms-test (${ringErr.message}) — fallback Brevo SMS`);
      await sendBrevoSMS(fakeAcq, biens);
      sentVia = 'brevo (fallback Ringover)';
    }
  } else {
    await sendBrevoSMS(fakeAcq, biens);
  }
  res.json({ success: true, message: `SMS test (${sentVia}) envoyé à ${phone} avec ${biens.length} bien(s)` });
}));

router.post('/email-preview', requireAuth, asyncHandler(async (req, res) => {
  const { acquereur_id, bien_ids } = req.body;
  if (!acquereur_id || !bien_ids?.length) return res.status(400).json({ error: 'acquereur_id et bien_ids requis' });
  if (!(await checkAcquereurOwnership(acquereur_id, getAuthUserId(req), req))) {
    return res.status(403).json({ error: 'Accès non autorisé à cet acquéreur' });
  }
  const { rows: [acq] } = await pool.query(
    "SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.secteurs FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id WHERE a.id = $1",
    [acquereur_id]
  );
  if (!acq) return res.status(404).json({ error: 'Acquéreur introuvable' });

  const placeholders = bien_ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows: biens } = await pool.query(`SELECT * FROM biens WHERE id IN (${placeholders})`, bien_ids);
  if (!biens.length) return res.status(404).json({ error: 'Aucun bien trouvé' });

  const contactName = acq.contact_name || acq.titre || '';
  const ownerName = acq.owner_name || 'Le Boutiquier';
  const ownerEmail = acq.owner_email || 'contact@leboutiquier.fr';
  const nbBiens = biens.length;

  const subject = nbBiens === 1
    ? `[LE BOUTIQUIER] - ${biens[0].titre || 'Nouveau bien'} correspondant à vos critères`
    : `[LE BOUTIQUIER] - sélections de plusieurs correspondant à vos critères`;
  const intro = `Bonjour ${contactName},\n\nJe vous propose ${nbBiens} bien${nbBiens > 1 ? 's' : ''} correspondant à vos critères de recherche :`;
  const outro = `Cordialement,\n${ownerName}`;
  const bienCardsHtml = biens.map((b, i) => buildBienCard(b, i + 1)).join('');

  res.json({
    success: true,
    to: acq.contact_email,
    toName: contactName,
    subject, intro, outro, bienCardsHtml,
    ownerName, ownerEmail,
    acqId: acq.id,
    bienIds: biens.map((b) => b.id),
  });
}));

router.post('/email-send-custom', requireAuth, asyncHandler(async (req, res) => {
  const { acquereur_id, bien_ids, subject, intro, outro, bienHtml } = req.body;
  if (!acquereur_id || !bien_ids?.length) return res.status(400).json({ error: 'Données manquantes' });
  if (!(await checkAcquereurOwnership(acquereur_id, getAuthUserId(req), req))) {
    return res.status(403).json({ error: 'Accès non autorisé à cet acquéreur' });
  }
  const { rows: [acq] } = await pool.query(
    "SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.secteurs FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id WHERE a.id = $1",
    [acquereur_id]
  );
  if (!acq) return res.status(404).json({ error: 'Acquéreur introuvable' });

  const placeholders = bien_ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows: biens } = await pool.query(`SELECT * FROM biens WHERE id IN (${placeholders})`, bien_ids);
  if (!biens.length) return res.status(404).json({ error: 'Aucun bien trouvé' });

  const brevoResult = await sendBrevoCustomEmail(acq, biens, { subject, intro, outro, bienHtml });
  const msgId = brevoResult?.messageId || null;

  const userId = getAuthUserId(req);
  for (const bienId of bien_ids) {
    await pool.query(`
      INSERT INTO todos (acquereur_id, bien_id, statut, created_by, updated_by)
      VALUES ($1, $2, 'envoye', $3, $4)
      ON CONFLICT(acquereur_id, bien_id) DO UPDATE SET statut='envoye', updated_by=EXCLUDED.updated_by, updated_at=NOW()
    `, [acquereur_id, bienId, userId, userId]);
    await pool.query(`
      INSERT INTO email_queue (bien_id, acquereur_id, status, channel, brevo_message_id, sent_at)
      VALUES ($1, $2, 'sent', 'email', $3, NOW())
    `, [bienId, acquereur_id, msgId]);
    if (config.PIPEDRIVE_API_TOKEN) {
      createMatchActivity(acquereur_id, bienId, config.PIPEDRIVE_API_TOKEN, 'envoyer')
        .catch((e) => logger.error('⚠️ Activité non créée: ' + e.message));
    }
  }
  await log(userId, 'email_custom_send', 'acquereur', acquereur_id, { bien_ids, channel: 'email', messageId: msgId });
  res.json({ success: true });
}));

router.post('/whatsapp-preview', requireAuth, asyncHandler(async (req, res) => {
  const { acquereur_id, bien_ids } = req.body;
  if (!acquereur_id || !bien_ids?.length) return res.status(400).json({ error: 'acquereur_id et bien_ids requis' });
  if (!(await checkAcquereurOwnership(acquereur_id, getAuthUserId(req), req))) {
    return res.status(403).json({ error: 'Accès non autorisé à cet acquéreur' });
  }
  const { rows: [acq] } = await pool.query(
    "SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.secteurs FROM acquereurs a LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id WHERE a.id = $1",
    [acquereur_id]
  );
  if (!acq) return res.status(404).json({ error: 'Acquéreur introuvable' });
  if (!acq.contact_phone) return res.status(400).json({ error: 'Aucun numéro de téléphone pour cet acquéreur' });

  const placeholders = bien_ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows: biens } = await pool.query(`SELECT * FROM biens WHERE id IN (${placeholders})`, bien_ids);
  if (!biens.length) return res.status(404).json({ error: 'Aucun bien trouvé' });

  const ownerName = acq.owner_name || 'Le Boutiquier';
  const phone = formatPhoneE164(acq.contact_phone);
  const phoneClean = phone.replace('+', '');
  if (!phoneClean || phoneClean.length < 8 || !/^\d+$/.test(phoneClean)) {
    return res.status(400).json({ error: `Numéro invalide : "${acq.contact_phone}". Impossible d'envoyer via WhatsApp.` });
  }
  const message = buildWhatsAppText(acq, biens, ownerName);
  res.json({
    success: true, phone, phoneDisplay: acq.contact_phone,
    contactName: acq.contact_name || acq.titre || '',
    message, acqId: acq.id, bienIds: biens.map((b) => b.id), bienCount: biens.length,
  });
}));

router.post('/whatsapp-send', requireAuth, asyncHandler(async (req, res) => {
  const { acquereur_id, bien_ids, message } = req.body;
  if (!acquereur_id || !bien_ids?.length || !message) return res.status(400).json({ error: 'Données manquantes' });
  if (!(await checkAcquereurOwnership(acquereur_id, getAuthUserId(req), req))) {
    return res.status(403).json({ error: 'Accès non autorisé à cet acquéreur' });
  }
  const { rows: [acq] } = await pool.query("SELECT * FROM acquereurs WHERE id = $1", [acquereur_id]);
  if (!acq) return res.status(404).json({ error: 'Acquéreur introuvable' });
  if (!acq.contact_phone) return res.status(400).json({ error: 'Aucun numéro de téléphone pour cet acquéreur' });

  const phone = formatPhoneE164(acq.contact_phone).replace('+', '');
  if (!phone || phone.length < 8 || !/^\d+$/.test(phone)) {
    return res.status(400).json({ error: `Numéro de téléphone invalide : "${acq.contact_phone}". Format attendu : international sans +, ex: 336XXXXXXXX` });
  }

  const { messageId: waMessageId } = await sendWhatsAppMessage(phone, message, acq.contact_phone);

  const userId = getAuthUserId(req);
  for (const bienId of bien_ids) {
    await pool.query(`
      INSERT INTO todos (acquereur_id, bien_id, statut, created_by, updated_by)
      VALUES ($1, $2, 'envoye', $3, $4)
      ON CONFLICT(acquereur_id, bien_id) DO UPDATE SET statut='envoye', updated_by=EXCLUDED.updated_by, updated_at=NOW()
    `, [acquereur_id, bienId, userId, userId]);
    await pool.query(`
      INSERT INTO email_queue (bien_id, acquereur_id, status, channel, brevo_message_id, sent_at)
      VALUES ($1, $2, 'sent', 'whatsapp', $3, NOW())
    `, [bienId, acquereur_id, waMessageId]);
  }

  if (config.PIPEDRIVE_API_TOKEN) {
    for (const bId of bien_ids) {
      createMatchActivity(acquereur_id, bId, config.PIPEDRIVE_API_TOKEN, 'envoyer')
        .catch((e) => logger.error('⚠️ Activité non créée: ' + e.message));
    }
  }

  await log(userId, 'whatsapp_send', 'acquereur', acquereur_id, { bien_ids, waMessageId });
  logger.info(`📲 WhatsApp envoyé à ${acq.contact_phone} — ${bien_ids.length} bien(s)`);
  res.json({ success: true, messageId: waMessageId });
}));

module.exports = router;
