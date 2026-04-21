'use strict';

/**
 * Tests d'intégration — routes admin.
 * Vérifie les contrôles d'accès et la validation.
 */

jest.mock('../../db', () => {
  const admin = { id: 1, name: 'Admin', email: 'admin@test.fr', role: 'admin' };
  const agent = { id: 2, name: 'Agent', email: 'agent@test.fr', role: 'agent' };
  return {
    pool: {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: jest.fn(async () => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: jest.fn(),
      })),
    },
    getUser: jest.fn(async (email) => {
      if (email === 'admin@test.fr') return admin;
      return null;
    }),
    getUserById: jest.fn(async (id) => {
      if (id === 1) return admin;
      if (id === 2) return agent;
      return null;
    }),
    getUserByToken: jest.fn(async (token) => {
      if (token === 'admin-token') return admin;
      if (token === 'agent-token') return agent;
      return null;
    }),
    createUser: jest.fn(async () => ({ id: 3 })),
    hashPassword: jest.fn(() => 'hashed'),
    createSetupToken: jest.fn(async () => ({ token: 'a'.repeat(64), expiresAt: new Date().toISOString() })),
    checkPassword: jest.fn(() => false),
    createAuthToken: jest.fn(async () => 'tok'),
    deleteAuthToken: jest.fn(async () => {}),
    log: jest.fn(async () => {}),
  };
});

jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../config', () => ({
  IS_PROD: false,
  CORS_ORIGIN: '',
  SESSION_SECRET: 'test',
  SESSION_MAX_AGE_MS: 1000,
  COOKIE_DOMAIN: undefined,
  SORTEUR_EMAILS: [],
  SORTEUR_STAGE_ID: 300,
}));

jest.mock('../../services/brevoService', () => ({
  sendSetupPasswordEmail: jest.fn(async () => {}),
}));

jest.mock('../../pipedrive', () => ({
  integrityCheck: jest.fn(async () => ({ ok: true, issues: [], counts: {} })),
}));

const express = require('express');
const session = require('express-session');

let app;
let request;

beforeAll(async () => {
  try {
    request = require('supertest');
  } catch (_e) {
    return;
  }

  app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  }));
  app.use('/api', require('../../routes/admin'));
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
});

const skip = () => !request;

describe('GET /api/stats', () => {
  test('refuse l\'accès à un agent', async () => {
    if (skip()) return;
    const res = await request(app)
      .get('/api/stats')
      .set('Authorization', 'Bearer agent-token');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/users', () => {
  test('refuse l\'accès sans authentification', async () => {
    if (skip()) return;
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  test('refuse l\'accès à un agent', async () => {
    if (skip()) return;
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', 'Bearer agent-token');
    expect(res.status).toBe(403);
  });

  test('autorise un admin', async () => {
    if (skip()) return;
    const { pool } = require('../../db');
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Admin', email: 'admin@test.fr', role: 'admin' }] });
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/users', () => {
  test('refuse un mot de passe faible', async () => {
    if (skip()) return;
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', 'Bearer admin-token')
      .send({ name: 'New', email: 'new@test.fr', password: 'weak' });
    expect(res.status).toBe(400);
  });

  test('accepte un utilisateur sans mot de passe (setup link)', async () => {
    if (skip()) return;
    const { getUser } = require('../../db');
    getUser.mockResolvedValueOnce({ id: 3, name: 'New', email: 'new@test.fr', role: 'agent' });
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', 'Bearer admin-token')
      .send({ name: 'New', email: 'new@test.fr' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('PATCH /api/users/:id/role', () => {
  test('refuse un changement de rôle par un agent', async () => {
    if (skip()) return;
    const res = await request(app)
      .patch('/api/users/2/role')
      .set('Authorization', 'Bearer agent-token')
      .send({ role: 'admin' });
    expect(res.status).toBe(403);
  });

  test('refuse un admin de se changer lui-même', async () => {
    if (skip()) return;
    const res = await request(app)
      .patch('/api/users/1/role')
      .set('Authorization', 'Bearer admin-token')
      .send({ role: 'agent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/propre rôle/);
  });

  test('refuse un rôle invalide', async () => {
    if (skip()) return;
    const res = await request(app)
      .patch('/api/users/2/role')
      .set('Authorization', 'Bearer admin-token')
      .send({ role: 'superadmin' });
    expect(res.status).toBe(400);
  });

  test('accepte un changement de rôle valide par un admin', async () => {
    if (skip()) return;
    const { pool } = require('../../db');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app)
      .patch('/api/users/2/role')
      .set('Authorization', 'Bearer admin-token')
      .send({ role: 'manager' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('DELETE /api/users/:id', () => {
  test('refuse la suppression par un agent', async () => {
    if (skip()) return;
    const res = await request(app)
      .delete('/api/users/2')
      .set('Authorization', 'Bearer agent-token');
    expect(res.status).toBe(403);
  });

  test('refuse l\'auto-suppression', async () => {
    if (skip()) return;
    const res = await request(app)
      .delete('/api/users/1')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/propre compte/);
  });

  test('autorise la désactivation d\'un autre utilisateur', async () => {
    if (skip()) return;
    const { pool } = require('../../db');
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await request(app)
      .delete('/api/users/2')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/admin/integrity', () => {
  test('refuse l\'accès à un agent', async () => {
    if (skip()) return;
    const res = await request(app)
      .get('/api/admin/integrity')
      .set('Authorization', 'Bearer agent-token');
    expect(res.status).toBe(403);
  });

  test('autorise un admin et retourne le rapport', async () => {
    if (skip()) return;
    const res = await request(app)
      .get('/api/admin/integrity')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
