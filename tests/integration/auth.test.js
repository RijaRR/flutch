'use strict';

/**
 * Tests d'intégration — routes d'authentification.
 * Mock la base de données pour tester le middleware stack complet.
 */

// Mock modules before require
jest.mock('../../db', () => {
  const testUser = {
    id: 1,
    name: 'Daniel',
    email: 'daniel@test.fr',
    password: 'salt:hash',
    role: 'admin',
  };
  const agentUser = {
    id: 2,
    name: 'Agent',
    email: 'agent@test.fr',
    password: 'salt:hash',
    role: 'agent',
  };
  return {
    pool: {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    },
    getUser: jest.fn(async (email) => {
      if (email === 'daniel@test.fr') return testUser;
      if (email === 'agent@test.fr') return agentUser;
      return null;
    }),
    getUserById: jest.fn(async (id) => {
      if (id === 1) return testUser;
      if (id === 2) return agentUser;
      return null;
    }),
    checkPassword: jest.fn((user, pwd) => pwd === 'correct-password'),
    createAuthToken: jest.fn(async () => 'test-token-abc123'),
    deleteAuthToken: jest.fn(async () => {}),
    getUserByToken: jest.fn(async (token) => {
      if (token === 'valid-token') return testUser;
      if (token === 'agent-token') return agentUser;
      return null;
    }),
    getValidSetupToken: jest.fn(async () => null),
    consumeSetupToken: jest.fn(async () => null),
    hashPassword: jest.fn(() => 'hashed'),
    log: jest.fn(async () => {}),
  };
});

jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../config', () => ({
  IS_PROD: false,
  CORS_ORIGIN: '',
  SESSION_SECRET: 'test-secret',
  SESSION_MAX_AGE_MS: 8 * 60 * 60 * 1000,
  COOKIE_DOMAIN: undefined,
  SORTEUR_EMAILS: [],
  SORTEUR_STAGE_ID: 300,
}));

const express = require('express');
const session = require('express-session');

let app;
let request;

beforeAll(async () => {
  // Dynamic import of supertest — installed during npm install
  try {
    request = require('supertest');
  } catch (_e) {
    // supertest not available, skip tests
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

  const authRoutes = require('../../routes/auth');
  app.use('/api', authRoutes);
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
});

const skipIfNoSupertest = () => {
  if (!request) return true;
  return false;
};

describe('POST /api/login', () => {
  test('retourne 401 pour un email inexistant', async () => {
    if (skipIfNoSupertest()) return;
    const res = await request(app)
      .post('/api/login')
      .send({ email: 'noone@test.fr', password: 'anything' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  test('retourne 401 pour un mauvais mot de passe', async () => {
    if (skipIfNoSupertest()) return;
    const res = await request(app)
      .post('/api/login')
      .send({ email: 'daniel@test.fr', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  test('retourne un token pour des identifiants valides', async () => {
    if (skipIfNoSupertest()) return;
    const res = await request(app)
      .post('/api/login')
      .send({ email: 'daniel@test.fr', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe('daniel@test.fr');
  });
});

describe('POST /api/logout', () => {
  test('retourne success même sans session', async () => {
    if (skipIfNoSupertest()) return;
    const res = await request(app).post('/api/logout');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/me', () => {
  test('retourne 401 sans authentification', async () => {
    if (skipIfNoSupertest()) return;
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  test('retourne le profil avec un Bearer token valide', async () => {
    if (skipIfNoSupertest()) return;
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('daniel@test.fr');
  });

  test('retourne 401 avec un Bearer token invalide', async () => {
    if (skipIfNoSupertest()) return;
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', 'Bearer invalid-token');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/impersonation/targets', () => {
  test('retourne une liste vide pour un agent', async () => {
    if (skipIfNoSupertest()) return;
    const res = await request(app)
      .get('/api/impersonation/targets')
      .set('Authorization', 'Bearer agent-token');
    expect(res.status).toBe(200);
    expect(res.body.targets).toEqual([]);
  });
});
