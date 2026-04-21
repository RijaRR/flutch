'use strict';

/**
 * Coordination webhook ↔ auto-sync via PostgreSQL advisory locks.
 * FIX Audit Phase 4 — Empêche les mutations concurrentes sur les mêmes deals.
 *
 * Deux niveaux de lock :
 *  - SYNC_LOCK (71001) : verrou exclusif pendant un full sync (syncBiens/syncAcquereurs)
 *  - DEAL_LOCK (71002 + dealId) : verrou par deal pour les webhooks
 *
 * Les advisory locks PostgreSQL sont automatiquement libérés en fin de transaction
 * ou de session — pas de risque de deadlock persistant.
 */

const { pool } = require('../db');
const { logger } = require('./logger');

const SYNC_LOCK_ID = 71001;

/**
 * Acquiert le verrou de sync global (non-bloquant).
 * @returns {Promise<boolean>} true si le verrou a été acquis
 */
async function tryAcquireSyncLock() {
  const { rows } = await pool.query('SELECT pg_try_advisory_lock($1) AS acquired', [SYNC_LOCK_ID]);
  return rows[0].acquired;
}

/**
 * Libère le verrou de sync global.
 */
async function releaseSyncLock() {
  await pool.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK_ID]);
}

/**
 * Exécute une fonction en tenant le verrou de sync global.
 * Si le verrou est déjà pris (sync en cours), la fonction n'est pas exécutée.
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ executed: boolean, result?: T }>}
 * @template T
 */
async function withSyncLock(fn) {
  const acquired = await tryAcquireSyncLock();
  if (!acquired) {
    logger.warn('🔒 Sync lock non disponible — skip (sync déjà en cours)');
    return { executed: false };
  }
  try {
    const result = await fn();
    return { executed: true, result };
  } finally {
    await releaseSyncLock();
  }
}

/**
 * Acquiert un verrou advisory par deal (bloquant avec timeout via statement_timeout).
 * Utilisé par les webhooks pour sérialiser les mutations sur un même deal.
 * @param {import('pg').PoolClient} client - Un client transactionnel
 * @param {number} dealId
 */
async function lockDeal(client, dealId) {
  // On utilise un espace de clés séparé (2 params) pour éviter les collisions avec le sync lock
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [SYNC_LOCK_ID + 1, dealId]);
}

module.exports = { tryAcquireSyncLock, releaseSyncLock, withSyncLock, lockDeal };
