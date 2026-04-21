'use strict';

const { logger } = require('./logger');

/**
 * @typedef {Object} RetryOptions
 * @property {number} [retries=3]      - Nombre de tentatives supplémentaires
 * @property {number} [minDelayMs=300] - Délai initial avant réessai
 * @property {number} [maxDelayMs=5000]- Délai maximum
 * @property {number} [factor=2]       - Facteur d'exponentielle
 * @property {string} [label='task']   - Libellé pour les logs
 * @property {(err: Error, attempt: number) => boolean} [shouldRetry] - Predicate
 */

/**
 * Exécute une fonction avec retry exponentiel.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {RetryOptions} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const {
    retries = 3,
    minDelayMs = 300,
    maxDelayMs = 5000,
    factor = 2,
    label = 'task',
    shouldRetry = () => true,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err, attempt)) {
        logger.error(`[retry:${label}] échec définitif après ${attempt + 1} tentative(s)`, {
          message: err && err.message,
        });
        throw err;
      }
      const delay = Math.min(maxDelayMs, minDelayMs * Math.pow(factor, attempt));
      logger.warn(`[retry:${label}] tentative ${attempt + 1} échouée, retry dans ${delay}ms`, {
        message: err && err.message,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
