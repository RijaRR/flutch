'use strict';

/**
 * Test helpers — builds a minimal Express app with the same middleware stack
 * as the real server.js, but with mockable database and no scheduler.
 */

const express = require('express');
const session = require('express-session');

function createTestApp(routes) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Minimal session for tests (in-memory store)
  app.use(session({
    secret: 'test-secret-key-for-integration-tests',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  }));

  // Mount routes
  for (const { path, router } of routes) {
    app.use(path, router);
  }

  // Error handler
  app.use((err, req, res, _next) => {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Erreur' });
  });

  return app;
}

/**
 * Creates a mock session middleware that injects userId.
 */
function withAuth(userId = 1) {
  return (req, _res, next) => {
    if (!req.session) req.session = {};
    req.session.userId = userId;
    next();
  };
}

module.exports = { createTestApp, withAuth };
