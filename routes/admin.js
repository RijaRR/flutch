'use strict';

const express = require('express');
const fetch = require('node-fetch');
const { Transform } = require('stream');
const { logger } = require('../lib/logger');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, requireAdminAsync, getAuthUserId } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createUserSchema, updateUserRingoverSchema, updateUserRoleSchema, updateUserPasswordSchema } = require('../schemas');
const { pool, createUser, getUser, getUserById, hashPassword, createSetupToken, log } = require('../db');
const { sendSetupPasswordEmail } = require('../services/brevoService');
const { integrityCheck } = require('../pipedrive');

function buildSetupLink(req, token) {
  const base = (process.env.APP_URL || '').trim()
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/setup-password.html?token=${token}`;
}

async function sendActivationLink(req, user) {
  const { token } = await createSetupToken(user.id, 7);
  const link = buildSetupLink(req, token);
  const sender = await getUserById(getAuthUserId(req)).catch(() => null);
  await sendSetupPasswordEmail({
    name: user.name,
    email: user.email,
    link,
    fromName: sender?.name || null,
    fromEmail: sender?.email || null,
  });
  await log(getAuthUserId(req), 'send_setup_link', 'user', user.id, { email: user.email });
  return { token, link };
}

const BACKUP_TABLES = ['users', 'biens', 'acquereurs', 'acquereur_criteria', 'todos', 'action_logs', 'sync_log'];

const router = express.Router();

router.get('/admin/owners', requireAuth, requireAdminAsync, asyncHandler(async (req, res) => {
  const { rows: ownersBiens } = await pool.query(`
    SELECT owner_email, owner_name, COUNT(*) as nb_biens
    FROM biens WHERE owner_email IS NOT NULL GROUP BY owner_email, owner_name ORDER BY nb_biens DESC
  `);
  const { rows: ownersAcq } = await pool.query(`
    SELECT owner_email, owner_name, COUNT(*) as nb_acquereurs
    FROM acquereurs WHERE owner_email IS NOT NULL GROUP BY owner_email, owner_name ORDER BY nb_acquereurs DESC
  `);
  const { rows: users } = await pool.query('SELECT id, name, email, role FROM users');

  const allEmails = new Set([
    ...ownersBiens.map((o) => o.owner_email),
    ...ownersAcq.map((o) => o.owner_email),
  ]);
  const result = [];
  for (const email of allEmails) {
    const b = ownersBiens.find((o) => o.owner_email === email);
    const a = ownersAcq.find((o) => o.owner_email === email);
    const u = users.find((u) => u.email === email);
    result.push({
      owner_email: email,
      owner_name: b?.owner_name || a?.owner_name || '',
      nb_biens: parseInt(b?.nb_biens || 0, 10),
      nb_acquereurs: parseInt(a?.nb_acquereurs || 0, 10),
      compte_flutch: u ? { id: u.id, name: u.name, role: u.role } : null,
      manque_compte: !u,
    });
  }
  res.json({ success: true, owners: result, users });
}));

// FIX Audit Phase 4 — Consolidation des requêtes dashboard (N+1 → 1 requête + 2 parallèles)
router.get('/stats', requireAuth, requireAdminAsync, asyncHandler(async (req, res) => {
  const [countsResult, byUserResult, lastSyncResult] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM biens) AS biens,
        (SELECT COUNT(*) FROM acquereurs) AS acquereurs,
        (SELECT COUNT(*) FROM todos) AS todos,
        (SELECT COUNT(*) FROM todos WHERE statut = 'envoye') AS envoyes
    `),
    pool.query(`
      SELECT u.name, COUNT(*) as actions
      FROM action_logs l JOIN users u ON u.id = l.user_id
      WHERE l.created_at > NOW() - INTERVAL '30 days'
      GROUP BY u.id, u.name ORDER BY actions DESC
    `),
    pool.query('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 5'),
  ]);
  const c = countsResult.rows[0];
  const stats = {
    biens: parseInt(c.biens, 10),
    acquereurs: parseInt(c.acquereurs, 10),
    todos: parseInt(c.todos, 10),
    envoyes: parseInt(c.envoyes, 10),
  };
  res.json({ success: true, stats, byUser: byUserResult.rows, lastSync: lastSyncResult.rows });
}));

router.get('/users', requireAuth, requireAdminAsync, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, email, role, ringover_number, ringover_user_id, created_at FROM users ORDER BY name"
  );
  res.json({ success: true, users: rows });
}));

// PATCH /api/users/:id/ringover — édition des numéros Ringover.
// Admin : peut éditer n'importe quel utilisateur. Autres : uniquement leur propre fiche.
router.patch(
  '/users/:id/ringover',
  requireAuth,
  validate(updateUserRingoverSchema),
  asyncHandler(async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'ID utilisateur invalide' });
    }
    const authId = getAuthUserId(req);
    const me = await getUserById(authId);
    if (!me) return res.status(401).json({ error: 'Non authentifié' });
    if (me.role !== 'admin' && me.id !== targetId) {
      return res.status(403).json({ error: 'Vous ne pouvez modifier que vos propres informations Ringover' });
    }
    const { ringover_number, ringover_user_id } = req.body;
    const { rowCount, rows } = await pool.query(
      `UPDATE users SET ringover_number = $1, ringover_user_id = $2 WHERE id = $3
       RETURNING id, name, email, role, ringover_number, ringover_user_id`,
      [ringover_number, ringover_user_id, targetId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Utilisateur introuvable' });
    await log(authId, 'update_ringover', 'user', targetId, {
      ringover_number,
      ringover_user_id,
    });
    res.json({ success: true, user: rows[0] });
  })
);

// PATCH /api/users/:id/role — changement de rôle (admin only)
router.patch(
  '/users/:id/role',
  requireAuth,
  requireAdminAsync,
  validate(updateUserRoleSchema),
  asyncHandler(async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'ID utilisateur invalide' });
    }
    const authId = getAuthUserId(req);
    // Empêche un admin de se rétrograder lui-même
    if (authId === targetId) {
      return res.status(400).json({ error: 'Vous ne pouvez pas modifier votre propre rôle' });
    }
    const target = await getUserById(targetId);
    if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const oldRole = target.role;
    const { role } = req.body;
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, targetId]);
    await log(authId, 'update_role', 'user', targetId, { old_role: oldRole, new_role: role });
    logger.info(`👤 Rôle utilisateur #${targetId} changé: ${oldRole} → ${role} (par #${authId})`);
    res.json({ success: true, user: { ...target, role } });
  })
);

// PATCH /api/users/:id/password — reset mot de passe par admin
router.patch(
  '/users/:id/password',
  requireAuth,
  requireAdminAsync,
  validate(updateUserPasswordSchema),
  asyncHandler(async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'ID utilisateur invalide' });
    }
    const target = await getUserById(targetId);
    if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const hashed = hashPassword(req.body.password);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, targetId]);
    // Invalide toutes les sessions/tokens existants
    await pool.query('DELETE FROM auth_tokens WHERE user_id = $1', [targetId]);
    const authId = getAuthUserId(req);
    await log(authId, 'reset_password', 'user', targetId, { target_email: target.email });
    logger.info(`🔑 Mot de passe utilisateur #${targetId} (${target.email}) réinitialisé par admin #${authId}`);
    res.json({ success: true });
  })
);

// DELETE /api/users/:id — désactivation utilisateur (admin only)
// Ne supprime pas physiquement mais invalide le mot de passe et les tokens.
router.delete(
  '/users/:id',
  requireAuth,
  requireAdminAsync,
  asyncHandler(async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'ID utilisateur invalide' });
    }
    const authId = getAuthUserId(req);
    if (authId === targetId) {
      return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });
    }
    const target = await getUserById(targetId);
    if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
    // Invalide le mot de passe avec un hash impossible à deviner
    const crypto = require('crypto');
    const disabledHash = `DISABLED:${crypto.randomBytes(32).toString('hex')}`;
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [disabledHash, targetId]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = $1', [targetId]);
    await pool.query('DELETE FROM password_setup_tokens WHERE user_id = $1', [targetId]);
    await log(authId, 'disable_user', 'user', targetId, { target_email: target.email });
    logger.info(`🚫 Utilisateur #${targetId} (${target.email}) désactivé par admin #${authId}`);
    res.json({ success: true });
  })
);

router.post('/users', requireAuth, requireAdminAsync, validate(createUserSchema), asyncHandler(async (req, res) => {
  const { name, email, password, role, send_setup_link } = req.body;
  const wantsSetupLink = !password || send_setup_link === true;
  let user;
  try {
    const initialPwd = password && password.length >= 10
      ? password
      : require('crypto').randomBytes(32).toString('hex');
    await createUser(name, email, initialPwd, role || 'agent');
    user = await getUser(email);
    await log(getAuthUserId(req), 'user_create', 'user', user.id, { email, role: role || 'agent' });
  } catch (_e) {
    return res.status(400).json({ error: 'Email déjà utilisé' });
  }
  if (wantsSetupLink) {
    try {
      await sendActivationLink(req, user);
      return res.json({ success: true, setup_link_sent: true });
    } catch (e) {
      logger.error('Envoi lien activation échoué', { email, err: e.message });
      return res.json({ success: true, setup_link_sent: false, error_email: e.message });
    }
  }
  res.json({ success: true });
}));

router.post('/users/:id/send-setup-link', requireAuth, requireAdminAsync, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID invalide' });
  const user = await getUserById(id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  try {
    await sendActivationLink(req, user);
    res.json({ success: true, email: user.email });
  } catch (e) {
    logger.error('Envoi lien activation échoué', { user_id: id, err: e.message });
    res.status(500).json({ error: e.message || 'Envoi impossible' });
  }
}));

router.get('/admin/integrity', requireAuth, requireAdminAsync, asyncHandler(async (req, res) => {
  const report = await integrityCheck();
  await log(getAuthUserId(req), 'integrity_check', 'sync', null, { issues: report.issues.length });
  res.json({ success: true, ...report });
}));

// GET /api/admin/backup — streaming JSON backup (ne charge pas tout en mémoire)
router.get('/admin/backup', requireAuth, requireAdminAsync, asyncHandler(async (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  await log(getAuthUserId(req), 'backup_download', 'system', null, { tables: BACKUP_TABLES });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="flutch-backup-${date}.json"`);

  res.write('{\n');
  for (let i = 0; i < BACKUP_TABLES.length; i++) {
    const t = BACKUP_TABLES[i];
    res.write(`  "${t}": [\n`);
    // Stream table rows using a cursor to avoid loading everything in memory
    const client = await pool.connect();
    try {
      const cursor = `backup_${t}_${Date.now()}`;
      // t is from a constant whitelist, safe from injection
      await client.query('BEGIN');
      await client.query(`DECLARE ${cursor} CURSOR FOR SELECT * FROM ${t}`);
      let first = true;
      let batch;
      do {
        batch = await client.query(`FETCH 500 FROM ${cursor}`);
        for (const row of batch.rows) {
          if (!first) res.write(',\n');
          res.write('    ' + JSON.stringify(row));
          first = false;
        }
      } while (batch.rows.length === 500);
      await client.query(`CLOSE ${cursor}`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    res.write('\n  ]');
    if (i < BACKUP_TABLES.length - 1) res.write(',');
    res.write('\n');
  }
  res.write('}\n');
  res.end();
}));

// Throttle helper for Pipedrive API calls
async function throttledBatchFetch(urls, apiToken, batchSize = 5, delayMs = 500) {
  const results = [];
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((url) =>
      fetch(url).then((r) => r.json()).then((d) => d.data || []).catch(() => [])
    ));
    results.push(...batchResults);
    if (i + batchSize < urls.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

router.post('/admin/import-activities', requireAuth, requireAdminAsync, asyncHandler(async (req, res) => {
  const apiToken = process.env.PIPEDRIVE_API_TOKEN;
  if (!apiToken) return res.status(500).json({ error: 'PIPEDRIVE_API_TOKEN manquant' });

  const acqMap = {};
  const { rows: acqRows } = await pool.query('SELECT id, pipedrive_deal_id, owner_email FROM acquereurs WHERE archived=0');
  acqRows.forEach((a) => { acqMap[a.pipedrive_deal_id] = a; });
  const bienMap = {};
  const { rows: bienRows } = await pool.query('SELECT id, pipedrive_deal_id, titre FROM biens');
  bienRows.forEach((b) => { bienMap[b.pipedrive_deal_id] = b; });

  let allActivities = [];
  let start = 0;
  while (true) {
    const data = await fetch(`https://api.pipedrive.com/v1/activities?type=hellosend_sms&done=1&limit=500&start=${start}&api_token=${apiToken}`).then((r) => r.json());
    allActivities.push(...(data.data || []));
    if (!data.additional_data?.pagination?.more_items_in_collection) break;
    start = data.additional_data.pagination.next_start;
  }

  const seenDeals = new Set(allActivities.filter((a) => a.deal_id).map((a) => a.deal_id));
  const missingAcqDeals = Object.keys(acqMap).map(Number).filter((pdId) => !seenDeals.has(pdId));

  // Throttled batch fetch — 5 calls at a time with 500ms delay (FIX: API throttling)
  const urls = missingAcqDeals.map((pdId) =>
    `https://api.pipedrive.com/v1/deals/${pdId}/activities?type=hellosend_sms&done=1&limit=200&api_token=${apiToken}`
  );
  const batchResults = await throttledBatchFetch(urls, apiToken, 5, 500);
  batchResults.forEach((acts) => allActivities.push(...acts));

  const todos = new Map();
  const stats = { envoyer_new: 0, retirer_new: 0, match_old: 0, bulk_old: 0, skipped: 0 };

  for (const act of allActivities) {
    if (!act.deal_id) continue;
    const subject = act.subject || '';
    const note = (act.note || '').replace(/<[^>]*>/g, '');
    const date = act.due_date || '';
    const acq = acqMap[act.deal_id];
    if (!acq) { stats.skipped++; continue; }

    const addTodo = (bienPdId, statut, stat) => {
      const bien = bienMap[bienPdId];
      if (!bien) return;
      const key = acq.id + '-' + bien.id;
      if (!todos.has(key) || date > todos.get(key).date) {
        todos.set(key, { acqId: acq.id, bienId: bien.id, statut, date });
      }
      stats[stat]++;
    };

    if (subject.startsWith('[ENVOYER]') && !subject.includes('biens envoyés')) {
      const m = note.match(/\(ID:\s*(\d+)\)/);
      if (m) addTodo(parseInt(m[1], 10), 'envoye', 'envoyer_new');
      continue;
    }
    if (subject.startsWith('[RETIRER]') && !subject.includes('biens retirés')) {
      const m = note.match(/\(ID:\s*(\d+)\)/);
      if (m) addTodo(parseInt(m[1], 10), 'refuse', 'retirer_new');
      continue;
    }
    const bulkMatch = note.match(/bien\(s\) envoyé\(s\) .+?:\s*([\d,\s]+)/);
    if (bulkMatch) {
      bulkMatch[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
        .forEach((id) => addTodo(id, 'envoye', 'bulk_old'));
      continue;
    }
    if (subject.startsWith('Match ')) {
      const m = note.match(/pipedrive\.com\/deal\/(\d+)/);
      if (m) addTodo(parseInt(m[1], 10), 'envoye', 'match_old');
      continue;
    }
    stats.skipped++;
  }

  const adminId = getAuthUserId(req);
  let inserted = 0;
  let updated = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [, todo] of todos) {
      const { rows: existing } = await client.query(
        'SELECT id FROM todos WHERE acquereur_id=$1 AND bien_id=$2',
        [todo.acqId, todo.bienId]
      );
      await client.query(`
        INSERT INTO todos (acquereur_id, bien_id, statut, created_by, updated_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT(acquereur_id, bien_id) DO UPDATE SET
          statut=EXCLUDED.statut, updated_by=EXCLUDED.updated_by, updated_at=NOW()
      `, [todo.acqId, todo.bienId, todo.statut, adminId, adminId, todo.date || new Date().toISOString()]);
      if (existing.length) updated++; else inserted++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await log(adminId, 'import_activities', 'sync', null, {
    total: allActivities.length, parsed: todos.size, inserted, updated, stats,
  });
  res.json({
    success: true, activities_total: allActivities.length, unique_todos: todos.size,
    inserted, updated, stats,
  });
}));

void logger;
module.exports = router;
