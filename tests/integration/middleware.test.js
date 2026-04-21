'use strict';

/**
 * Tests d'intégration — middleware (auth, validation, error handling, rate limiting).
 */

const validate = require('../../middleware/validate');
const asyncHandler = require('../../middleware/asyncHandler');
const errorHandler = require('../../middleware/errorHandler');
const { isBlockedHost } = require('../../lib/security');

jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('validate middleware', () => {
  const { z } = require('zod');
  const schema = z.object({ name: z.string().min(1) });
  const mw = validate(schema);

  test('appelle next() pour des données valides', () => {
    const req = { body: { name: 'test' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.body.name).toBe('test');
  });

  test('retourne 400 pour des données invalides', () => {
    const req = { body: { name: '' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Données invalides' }));
  });
});

describe('asyncHandler', () => {
  test('transmet les erreurs au next()', async () => {
    const error = new Error('Test error');
    const handler = asyncHandler(async () => { throw error; });
    const req = {};
    const res = {};
    const next = jest.fn();
    handler(req, res, next);
    await new Promise(r => setTimeout(r, 10));
    expect(next).toHaveBeenCalledWith(error);
  });

  test('ne transmet rien si pas d\'erreur', async () => {
    const handler = asyncHandler(async (req, res) => { res.sent = true; });
    const req = {};
    const res = {};
    const next = jest.fn();
    handler(req, res, next);
    await new Promise(r => setTimeout(r, 10));
    expect(next).not.toHaveBeenCalled();
    expect(res.sent).toBe(true);
  });
});

describe('errorHandler', () => {
  test('retourne le status code de l\'erreur', () => {
    const err = new Error('Not found');
    err.statusCode = 404;
    const req = { method: 'GET', path: '/test' };
    const res = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    errorHandler(err, req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found' });
  });

  test('retourne 500 par défaut', () => {
    const err = new Error('Oops');
    const req = { method: 'GET', path: '/test' };
    const res = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    errorHandler(err, req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('ne renvoie rien si headers déjà envoyés', () => {
    const err = new Error('Too late');
    const req = { method: 'GET', path: '/test' };
    const res = {
      headersSent: true,
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    errorHandler(err, req, res, jest.fn());
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('isBlockedHost — extended', () => {
  test('bloque les adresses link-local IPv4', () => {
    expect(isBlockedHost('169.254.169.254')).toBe(true);
    expect(isBlockedHost('169.254.0.1')).toBe(true);
  });

  test('bloque les adresses de Shared Address Space', () => {
    expect(isBlockedHost('100.64.0.1')).toBe(true);
    expect(isBlockedHost('100.127.255.254')).toBe(true);
  });

  test('autorise les adresses publiques', () => {
    expect(isBlockedHost('93.184.216.34')).toBe(false);
    expect(isBlockedHost('1.1.1.1')).toBe(false);
  });
});
