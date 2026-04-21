'use strict';

/**
 * Vérification d'intégrité de la base de données.
 */

const { pool } = require('../db');

async function integrityCheck() {
  const issues = [];

  const { rows: orphanCriteria } = await pool.query(`
    SELECT c.id FROM acquereur_criteria c LEFT JOIN acquereurs a ON a.id = c.acquereur_id WHERE a.id IS NULL
  `);
  if (orphanCriteria.length) issues.push({ type: 'orphan_criteria', count: orphanCriteria.length });

  const { rows: orphanTodos } = await pool.query(`
    SELECT t.id FROM todos t LEFT JOIN acquereurs a ON a.id = t.acquereur_id LEFT JOIN biens b ON b.id = t.bien_id WHERE a.id IS NULL OR b.id IS NULL
  `);
  if (orphanTodos.length) issues.push({ type: 'orphan_todos', count: orphanTodos.length });

  const biensNoOwner = parseInt((await pool.query(
    "SELECT COUNT(*) as n FROM biens WHERE (owner_email IS NULL OR owner_email = '') AND archived = 0"
  )).rows[0].n);
  if (biensNoOwner > 0) issues.push({ type: 'biens_sans_owner', count: biensNoOwner });

  const acqNoOwner = parseInt((await pool.query(
    "SELECT COUNT(*) as n FROM acquereurs WHERE (owner_email IS NULL OR owner_email = '') AND archived = 0"
  )).rows[0].n);
  if (acqNoOwner > 0) issues.push({ type: 'acquereurs_sans_owner', count: acqNoOwner });

  const { rows: dupBiens } = await pool.query(
    "SELECT pipedrive_deal_id, COUNT(*) as n FROM biens GROUP BY pipedrive_deal_id HAVING COUNT(*) > 1"
  );
  if (dupBiens.length) issues.push({ type: 'doublons_biens', count: dupBiens.length });

  const biensBadPrice = parseInt((await pool.query(
    "SELECT COUNT(*) as n FROM biens WHERE (prix_fai < 0 OR prix_fai > 100000000) AND archived = 0"
  )).rows[0].n);
  if (biensBadPrice > 0) issues.push({ type: 'biens_prix_aberrant', count: biensBadPrice });

  const incohBudget = parseInt((await pool.query(
    "SELECT COUNT(*) as n FROM acquereur_criteria WHERE budget_min IS NOT NULL AND budget_max IS NOT NULL AND budget_min > budget_max"
  )).rows[0].n);
  if (incohBudget > 0) issues.push({ type: 'budget_incoherent', count: incohBudget });

  if (orphanCriteria.length) await pool.query('DELETE FROM acquereur_criteria WHERE acquereur_id NOT IN (SELECT id FROM acquereurs)');
  if (orphanTodos.length) await pool.query('DELETE FROM todos WHERE acquereur_id NOT IN (SELECT id FROM acquereurs) OR bien_id NOT IN (SELECT id FROM biens)');

  const report = {
    ok: issues.length === 0,
    issues,
    counts: {
      biens_actifs: parseInt((await pool.query('SELECT COUNT(*) as n FROM biens WHERE archived = 0')).rows[0].n),
      biens_archives: parseInt((await pool.query('SELECT COUNT(*) as n FROM biens WHERE archived = 1')).rows[0].n),
      acquereurs_actifs: parseInt((await pool.query('SELECT COUNT(*) as n FROM acquereurs WHERE archived = 0')).rows[0].n),
      acquereurs_archives: parseInt((await pool.query('SELECT COUNT(*) as n FROM acquereurs WHERE archived = 1')).rows[0].n),
    },
    checked_at: new Date().toISOString(),
  };

  await pool.query('INSERT INTO sync_log (type, status, count, message) VALUES ($1, $2, $3, $4)',
    ['integrity', issues.length ? 'warnings' : 'ok', issues.length, JSON.stringify(issues)]);

  return report;
}

module.exports = { integrityCheck };
