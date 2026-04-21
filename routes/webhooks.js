'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { logger } = require('../lib/logger');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, requireAdminAsync } = require('../middleware/auth');
const { pool } = require('../db');
const { syncSingleBien, syncSingleAcquereur, archiveDeal } = require('../pipedrive');
const { getCachedStageIds, listWebhooks } = require('../services/pipedriveService');

const router = express.Router();

// FIX Audit 3.6 — Cache d'idempotence pour rejeter les webhooks rejoués (LRU borné)
const IDEMPOTENCE_MAX = 10000;
const IDEMPOTENCE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const idempotenceCache = new Map();

function isWebhookDuplicate(event, dealId, timestamp) {
  const key = `${event}:${dealId}:${timestamp || ''}`;
  if (idempotenceCache.has(key)) return true;
  // Nettoyage si le cache dépasse la borne (FIX Audit 4.4)
  if (idempotenceCache.size >= IDEMPOTENCE_MAX) {
    const now = Date.now();
    for (const [k, ts] of idempotenceCache) {
      if (now - ts > IDEMPOTENCE_TTL_MS) idempotenceCache.delete(k);
    }
    // Si toujours plein, supprimer le plus ancien
    if (idempotenceCache.size >= IDEMPOTENCE_MAX) {
      const firstKey = idempotenceCache.keys().next().value;
      idempotenceCache.delete(firstKey);
    }
  }
  idempotenceCache.set(key, Date.now());
  return false;
}

router.post('/pipedrive', (req, res) => {
  const token = req.query.token;
  const expected = config.WEBHOOK_SECRET;
  if (!token || typeof token !== 'string' || token.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    logger.warn('⚠️ Webhook: token invalide rejeté');
    return res.status(403).json({ error: 'forbidden' });
  }

  // FIX Audit 3.6 — Vérification de timestamp pour rejeter les webhooks trop vieux
  const dateHeader = req.headers['date'] || req.headers['x-pipedrive-timestamp'];
  if (dateHeader) {
    const webhookTime = new Date(dateHeader).getTime();
    const now = Date.now();
    if (!isNaN(webhookTime) && Math.abs(now - webhookTime) > 5 * 60 * 1000) {
      logger.warn(`⚠️ Webhook: timestamp trop ancien/futur rejeté (${dateHeader})`);
      return res.status(403).json({ error: 'webhook expired' });
    }
  }

  const { event, current } = req.body || {};
  if (!current || !event) {
    return res.status(200).json({ ok: true });
  }

  // FIX Audit 3.6 — Vérification d'idempotence
  const dealId = current.id;
  const updateTime = current.update_time || '';
  if (isWebhookDuplicate(event, dealId, updateTime)) {
    logger.info(`📨 Webhook: ${event} deal #${dealId} ignoré (doublon détecté)`);
    return res.status(200).json({ ok: true, deduplicated: true });
  }

  res.status(200).json({ ok: true });

  (async () => {
    try {
      const stageId = current.stage_id;
      const status = current.status;

      logger.info(`📨 Webhook: ${event} deal #${dealId} stage=${stageId} status=${status}`);

      if (event === 'deleted.deal' || status === 'deleted' || status === 'lost') {
        await archiveDeal(dealId);
        return;
      }

      const { bienStageId, acqStageId } = getCachedStageIds();
      const isBienStage = stageId === bienStageId;
      const isAcqStage = stageId === acqStageId;

      if (isBienStage && status === 'open') {
        await archiveDeal(dealId);
        await syncSingleBien(current, config.PIPEDRIVE_API_TOKEN);
      } else if (isAcqStage && status === 'open') {
        await archiveDeal(dealId);
        await syncSingleAcquereur(current);
      } else {
        const { rows: existingBien } = await pool.query('SELECT id FROM biens WHERE pipedrive_deal_id = $1 AND archived = 0', [dealId]);
        const { rows: existingAcq } = await pool.query('SELECT id FROM acquereurs WHERE pipedrive_deal_id = $1 AND archived = 0', [dealId]);
        if (existingBien.length || existingAcq.length) {
          await archiveDeal(dealId);
          logger.info(`📨 Webhook: deal #${dealId} a quitté les étapes cibles → archivé`);
        }
      }
    } catch (e) {
      logger.error('❌ Webhook error: ' + e.message);
    }
  })();
});

router.get('/status', requireAuth, requireAdminAsync, asyncHandler(async (req, res) => {
  try {
    const hooks = await listWebhooks();
    const { bienStageId, acqStageId } = getCachedStageIds();
    res.json({ webhooks: hooks, bien_stage_id: bienStageId, acq_stage_id: acqStageId });
  } catch (e) {
    res.json({ error: e.message });
  }
}));

module.exports = router;
