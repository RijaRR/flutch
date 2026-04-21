'use strict';

const { logger } = require('../lib/logger');

/**
 * Express error handler centralisé. Doit être monté APRES toutes les routes.
 * @param {Error & {statusCode?: number, expose?: boolean}} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
module.exports = function errorHandler(err, req, res, _next) {
  const status = err.statusCode || 500;
  logger.error(`[${req.method} ${req.path}] ${err.message}`, {
    stack: err.stack,
    status,
  });
  if (res.headersSent) return;
  const message = status >= 500 && process.env.NODE_ENV === 'production'
    ? 'Erreur interne'
    : err.message || 'Erreur';
  res.status(status).json({ error: message });
};
