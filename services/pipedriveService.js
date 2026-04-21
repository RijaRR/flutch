'use strict';

const fetch = require('node-fetch');
const config = require('../config');
const { logger } = require('../lib/logger');

const PIPEDRIVE_BASE = 'https://api.pipedrive.com/v1';

let cachedBienStageId = null;
let cachedAcqStageId = null;

/**
 * @returns {{ bienStageId: number|null, acqStageId: number|null }}
 */
function getCachedStageIds() {
  return { bienStageId: cachedBienStageId, acqStageId: cachedAcqStageId };
}

/**
 * Résout les identifiants de stages Pipedrive en cache (idempotent).
 * @returns {Promise<void>}
 */
async function resolveStageIds() {
  if (cachedBienStageId && cachedAcqStageId) return;
  if (!config.PIPEDRIVE_API_TOKEN) return;
  try {
    const pdGet = async (path) => {
      const sep = path.includes('?') ? '&' : '?';
      const res = await fetch(`${PIPEDRIVE_BASE}${path}${sep}api_token=${config.PIPEDRIVE_API_TOKEN}`);
      return res.json();
    };
    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const pipelines = await pdGet('/pipelines');
    let bienPipelineId = null;
    let acqPipelineId = null;
    if (pipelines?.data) {
      for (const p of pipelines.data) {
        if (norm(p.name) === norm(config.BIENS_PIPELINE)) bienPipelineId = p.id;
        if (norm(p.name) === norm(config.ACQUEREURS_PIPELINE)) acqPipelineId = p.id;
      }
    }

    const stages = await pdGet('/stages');
    if (stages?.data) {
      for (const s of stages.data) {
        const n = norm(s.name);
        if (n === norm(config.BIENS_STAGE) && s.pipeline_id === bienPipelineId) cachedBienStageId = s.id;
        if (n === norm(config.ACQUEREURS_STAGE) && s.pipeline_id === acqPipelineId) cachedAcqStageId = s.id;
      }
    }
    logger.info(`📌 Stage IDs résolus — Biens: ${cachedBienStageId} (pipeline ${bienPipelineId}), Acquéreurs: ${cachedAcqStageId} (pipeline ${acqPipelineId})`);
  } catch (e) {
    logger.error('❌ Erreur résolution stage IDs:', e.message);
  }
}

/**
 * Liste les webhooks Pipedrive enregistrés.
 * @returns {Promise<Array<unknown>>}
 */
async function listWebhooks() {
  const sep = '?';
  const r = await fetch(`${PIPEDRIVE_BASE}/webhooks${sep}api_token=${config.PIPEDRIVE_API_TOKEN}`);
  const data = await r.json();
  return (data?.data || []).filter((h) => h.subscription_url?.includes('/api/webhook/pipedrive'));
}

module.exports = { resolveStageIds, getCachedStageIds, listWebhooks };
