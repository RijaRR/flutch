'use strict';

const express = require('express');
const config = require('../config');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, getAuthUserId } = require('../middleware/auth');
const { pool } = require('../db');
const { syncBiens, syncAcquereurs } = require('../pipedrive');

const router = express.Router();

router.post('/biens', requireAuth, asyncHandler(async (req, res) => {
  const count = await syncBiens(
    config.PIPEDRIVE_API_TOKEN,
    config.BIENS_STAGE,
    getAuthUserId(req),
    config.BIENS_PIPELINE
  );
  res.json({ success: true, count });
}));

router.post('/acquereurs', requireAuth, asyncHandler(async (req, res) => {
  const count = await syncAcquereurs(
    config.PIPEDRIVE_API_TOKEN,
    config.ACQUEREURS_PIPELINE,
    getAuthUserId(req),
    config.ACQUEREURS_STAGE
  );
  const count0 = await syncAcquereurs(
    config.PIPEDRIVE_API_TOKEN,
    config.ACQUEREURS_PIPELINE,
    getAuthUserId(req),
    'Acquéreur 0 projet'
  );
  res.json({ success: true, count: count + count0 });
}));

router.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [biens] } = await pool.query("SELECT COUNT(*) as n, MAX(synced_at) as last FROM biens");
  const { rows: [acqs] } = await pool.query("SELECT COUNT(*) as n, MAX(synced_at) as last FROM acquereurs");
  res.json({ biens, acquereurs: acqs });
}));

module.exports = router;
