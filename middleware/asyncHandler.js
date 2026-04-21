'use strict';

/**
 * Enveloppe une route async pour transmettre les erreurs au errorHandler.
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<unknown>} fn
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => void}
 */
module.exports = function asyncHandler(fn) {
  return function asyncHandlerWrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
