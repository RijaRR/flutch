'use strict';

/**
 * Repository pour la table `todos`.
 */

class TodosRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async upsert(acquereurId, bienId, statut, userId) {
    await this.pool.query(`
      INSERT INTO todos (acquereur_id, bien_id, statut, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(acquereur_id, bien_id) DO UPDATE SET
        statut=EXCLUDED.statut, updated_by=EXCLUDED.updated_by, updated_at=NOW()
    `, [acquereurId, bienId, statut || 'non_traite', userId, userId]);
  }

  async bulkUpsert(acquereurId, bienIds, statut, userId, client = null) {
    const db = client || this.pool;
    for (const bienId of bienIds) {
      await db.query(`
        INSERT INTO todos (acquereur_id, bien_id, statut, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(acquereur_id, bien_id) DO UPDATE SET
          statut=EXCLUDED.statut, updated_by=EXCLUDED.updated_by, updated_at=NOW()
      `, [acquereurId, bienId, statut, userId, userId]);
    }
  }

  async findByAcquereurAndBien(acquereurId, bienId) {
    const { rows } = await this.pool.query(
      'SELECT id, statut FROM todos WHERE acquereur_id = $1 AND bien_id = $2',
      [acquereurId, bienId]
    );
    return rows[0] || null;
  }

  async countByStatut() {
    const { rows } = await this.pool.query(`
      SELECT statut, COUNT(*) as n FROM todos GROUP BY statut
    `);
    const result = {};
    for (const row of rows) result[row.statut] = parseInt(row.n, 10);
    return result;
  }

  async totalCount() {
    const { rows } = await this.pool.query('SELECT COUNT(*) as n FROM todos');
    return parseInt(rows[0].n, 10);
  }
}

module.exports = TodosRepository;
