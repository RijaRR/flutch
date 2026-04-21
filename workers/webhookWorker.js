'use strict';

const config = require('../config');
const { logger } = require('../lib/logger');
const { pool } = require('../db');
const { resolveStageIds } = require('../services/pipedriveService');
const { startWebhookWorker, shutdownWebhookQueue } = require('../services/webhookQueueService');

async function start() {
  if (!config.REDIS_URL) {
    logger.warn('⚠️ Worker webhook dédié inactif: REDIS_URL manquante');
    process.exit(1);
  }

  if (config.PIPEDRIVE_API_TOKEN) {
    await resolveStageIds();
  } else {
    logger.warn('⚠️ Worker webhook dédié: PIPEDRIVE_API_TOKEN manquant, résolution des stages ignorée');
  }

  const worker = startWebhookWorker();
  if (!worker) {
    logger.error('❌ Impossible de démarrer le worker webhook dédié');
    process.exit(1);
  }

  logger.info(`✅ Worker webhook dédié prêt (concurrency=${config.WEBHOOK_WORKER_CONCURRENCY})`);
}

function gracefulShutdown(signal) {
  logger.info(`🛑 Signal ${signal} reçu — arrêt propre du worker webhook`);
  Promise.all([
    shutdownWebhookQueue().catch(() => {}),
    pool.end(),
  ]).then(() => {
    logger.info('✅ Worker webhook arrêté');
    process.exit(0);
  }).catch((err) => {
    logger.error('❌ Erreur arrêt worker webhook: ' + err.message);
    process.exit(1);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

start().catch((err) => {
  logger.error('❌ Erreur démarrage worker webhook: ' + err.message);
  process.exit(1);
});
