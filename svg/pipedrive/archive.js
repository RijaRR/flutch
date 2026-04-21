'use strict';

/**
 * Archivage de deals Pipedrive (biens et acquéreurs).
 */

const { logger } = require('../lib/logger');
const { pool } = require('../db');

async function archiveDeal(pipedriveDealId) {
  const bienResult = await pool.query('UPDATE biens SET archived = 1 WHERE pipedrive_deal_id = $1 AND archived = 0', [pipedriveDealId]);
  const acqResult = await pool.query('UPDATE acquereurs SET archived = 1 WHERE pipedrive_deal_id = $1 AND archived = 0', [pipedriveDealId]);
  logger.info(`⚡ Webhook: deal #${pipedriveDealId} archivé (biens: ${bienResult.rowCount}, acq: ${acqResult.rowCount})`);
}

module.exports = { archiveDeal };
