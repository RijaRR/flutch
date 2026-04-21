'use strict';

/**
 * Couche d'abstraction autour de BullMQ pour les webhooks Pipedrive.
 *
 * Objectifs :
 * - Découpler la réception HTTP du traitement métier réel.
 * - Préparer une architecture résiliente basée sur Redis + worker dédié.
 * - Ne pas faire échouer l'application tant que bullmq / ioredis ne sont pas installés.
 *
 * Tant que les dépendances ou Redis ne sont pas disponibles, on garde un fallback
 * compatible avec l'existant : le job est lancé en arrière-plan dans le process web.
 * Cela permet de merger le refactoring maintenant, puis d'activer BullMQ plus tard
 * uniquement en ajoutant les dépendances et la configuration Redis.
 */

const config = require('../config');
const { logger } = require('../lib/logger');
const { pool } = require('../db');
const { syncSingleBien, syncSingleAcquereur, archiveDeal } = require('../pipedrive');
const { getCachedStageIds } = require('./pipedriveService');

let Queue;
let Worker;
let IORedis;

try {
  ({ Queue, Worker } = require('bullmq'));
  IORedis = require('ioredis');
} catch (err) {
  logger.warn('⚠️ Webhook queue: bullmq/ioredis non installés — fallback inline actif');
}

const WEBHOOK_QUEUE_NAME = 'pipedrive-webhooks';

let redisConnection = null;
let webhookQueue = null;
let webhookWorker = null;
let queueReady = false;

function hasRedisConfig() {
  return Boolean(config.REDIS_URL);
}

function hasBullMqRuntime() {
  return Boolean(Queue && Worker && IORedis);
}

function buildJobId(payload) {
  const dealId = payload?.current?.id || 'unknown';
  const event = payload?.event || 'unknown';
  const updateTime = payload?.current?.update_time || 'no-update-time';
  return `${event}:${dealId}:${updateTime}`;
}

function createRedisConnection() {
  if (redisConnection || !hasBullMqRuntime() || !hasRedisConfig()) return redisConnection;

  // maxRetriesPerRequest = null est recommandé par BullMQ pour éviter que Redis
  // coupe des commandes longues pendant le traitement d'un job.
  redisConnection = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  redisConnection.on('error', (err) => {
    logger.error('❌ Webhook queue Redis error: ' + err.message);
  });

  return redisConnection;
}

/**
 * Extrait le traitement métier du webhook hors de la route HTTP.
 * Cette fonction devient l'unité de travail que BullMQ exécutera côté worker.
 *
 * @param {{ event: string, current: Record<string, any> }} payload
 * @returns {Promise<void>}
 */
async function processWebhookEvent(payload) {
  const { event, current } = payload || {};
  if (!event || !current) return;

  const dealId = current.id;
  const stageId = current.stage_id;
  const status = current.status;

  logger.info(`📨 Worker webhook: ${event} deal #${dealId} stage=${stageId} status=${status}`);

  if (event === 'deleted.deal' || status === 'deleted' || status === 'lost') {
    await archiveDeal(dealId);
    return;
  }

  const { bienStageId, acqStageId } = getCachedStageIds();
  const isBienStage = stageId === bienStageId;
  const isAcqStage = stageId === acqStageId;

  if (isBienStage && status === 'open') {
    // On archive d'abord pour nettoyer un éventuel état précédent,
    // puis on reconstruit l'enregistrement courant à partir du payload Pipedrive.
    await archiveDeal(dealId);
    await syncSingleBien(current, config.PIPEDRIVE_API_TOKEN);
    return;
  }

  if (isAcqStage && status === 'open') {
    await archiveDeal(dealId);
    await syncSingleAcquereur(current);
    return;
  }

  // Si le deal a quitté les étapes suivies, on archive les éventuels enregistrements
  // encore visibles côté app pour garder la base alignée avec le pipeline Pipedrive.
  const { rows: existingBien } = await pool.query(
    'SELECT id FROM biens WHERE pipedrive_deal_id = $1 AND archived = 0',
    [dealId]
  );
  const { rows: existingAcq } = await pool.query(
    'SELECT id FROM acquereurs WHERE pipedrive_deal_id = $1 AND archived = 0',
    [dealId]
  );
  if (existingBien.length || existingAcq.length) {
    await archiveDeal(dealId);
    logger.info(`📨 Worker webhook: deal #${dealId} a quitté les étapes cibles -> archivé`);
  }
}

/**
 * Crée la queue BullMQ si l'environnement est prêt.
 * Si Redis ou les dépendances manquent, on reste en mode dégradé sans jeter d'erreur.
 */
function ensureQueue() {
  if (webhookQueue || !hasBullMqRuntime() || !hasRedisConfig()) return webhookQueue;

  const connection = createRedisConnection();
  webhookQueue = new Queue(WEBHOOK_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: config.WEBHOOK_QUEUE_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: config.WEBHOOK_QUEUE_BACKOFF_MS,
      },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });

  queueReady = true;
  logger.info('✅ Webhook queue BullMQ initialisée');
  return webhookQueue;
}

/**
 * Démarre le worker BullMQ dans le process courant.
 *
 * En production, on préférera souvent lancer ce worker dans un process séparé.
 * Ici, on le démarre dans le serveur pour préparer l'intégration sans casser
 * l'existant. Une fois l'architecture séparée, ce fichier pourra être réutilisé
 * par un binaire dédié de type `node workers/webhookWorker.js`.
 */
function startWebhookWorker() {
  if (webhookWorker || !hasBullMqRuntime() || !hasRedisConfig()) {
    if (!hasBullMqRuntime()) {
      logger.warn('⚠️ Webhook worker BullMQ inactif: dépendances manquantes');
    } else if (!hasRedisConfig()) {
      logger.warn('⚠️ Webhook worker BullMQ inactif: REDIS_URL manquante');
    }
    return null;
  }

  ensureQueue();
  const connection = createRedisConnection();

  webhookWorker = new Worker(
    WEBHOOK_QUEUE_NAME,
    async (job) => {
      await processWebhookEvent(job.data);
    },
    {
      connection,
      concurrency: config.WEBHOOK_WORKER_CONCURRENCY,
    }
  );

  webhookWorker.on('completed', (job) => {
    logger.info(`✅ Webhook job terminé: ${job.id}`);
  });

  webhookWorker.on('failed', (job, err) => {
    logger.error(`❌ Webhook job échec: ${job?.id || 'unknown'} - ${err.message}`);
  });

  logger.info(`✅ Webhook worker BullMQ démarré (concurrency=${config.WEBHOOK_WORKER_CONCURRENCY})`);
  return webhookWorker;
}

/**
 * Enfile un webhook dans BullMQ.
 *
 * Si la queue n'est pas disponible, on garde un fallback non bloquant via setImmediate.
 * Ce fallback n'apporte pas la résilience BullMQ, mais il évite de casser le flux tant
 * que les dépendances n'ont pas encore été ajoutées au projet.
 *
 * @param {{ event: string, current: Record<string, any> }} payload
 * @returns {Promise<{ queued: boolean, fallback: boolean, jobId: string }>}
 */
async function enqueueWebhookJob(payload) {
  const jobId = buildJobId(payload);

  if (!queueReady) ensureQueue();

  if (webhookQueue) {
    await webhookQueue.add('process-pipedrive-webhook', payload, {
      jobId,
    });
    return { queued: true, fallback: false, jobId };
  }

  // Fallback transitoire : on conserve le comportement "après la réponse HTTP"
  // mais sous une API centralisée. Cela facilitera la suppression du fallback plus tard.
  setImmediate(() => {
    processWebhookEvent(payload).catch((err) => {
      logger.error('❌ Webhook fallback error: ' + err.message);
    });
  });

  return { queued: false, fallback: true, jobId };
}

async function shutdownWebhookQueue() {
  if (webhookWorker) {
    await webhookWorker.close();
    webhookWorker = null;
  }
  if (webhookQueue) {
    await webhookQueue.close();
    webhookQueue = null;
  }
  if (redisConnection) {
    redisConnection.disconnect();
    redisConnection = null;
  }
  queueReady = false;
}

function getWebhookQueueStatus() {
  return {
    queue_name: WEBHOOK_QUEUE_NAME,
    bullmq_installed: hasBullMqRuntime(),
    redis_configured: hasRedisConfig(),
    queue_ready: queueReady,
    worker_running: Boolean(webhookWorker),
  };
}

module.exports = {
  WEBHOOK_QUEUE_NAME,
  processWebhookEvent,
  enqueueWebhookJob,
  startWebhookWorker,
  shutdownWebhookQueue,
  getWebhookQueueStatus,
};
