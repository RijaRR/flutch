'use strict';

/**
 * Repository pour la table `biens`.
 * Isole toutes les requêtes SQL pour permettre le test par injection de mock.
 */

class BiensRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async findById(id) {
    const { rows } = await this.pool.query('SELECT * FROM biens WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async findByIdActive(id) {
    const { rows } = await this.pool.query('SELECT * FROM biens WHERE id = $1 AND archived = 0', [id]);
    return rows[0] || null;
  }

  async findByPipedriveDealId(dealId) {
    const { rows } = await this.pool.query('SELECT * FROM biens WHERE pipedrive_deal_id = $1', [dealId]);
    return rows[0] || null;
  }

  async findByIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await this.pool.query(`SELECT * FROM biens WHERE id IN (${placeholders})`, ids);
    return rows;
  }

  async search(query, limit = 50) {
    const like = `%${query}%`;
    const { rows } = await this.pool.query(`
      SELECT id, pipedrive_deal_id, titre, adresse, code_postal, ville,
             prix_fai, rentabilite, rentabilite_post_rev, occupation_status,
             surface, is_delegation, owner_name, photo_1, photo_2, photo_3,
             pipedrive_updated_at, pipedrive_created_at
      FROM biens WHERE archived = 0
        AND (titre ILIKE $1 OR CAST(pipedrive_deal_id AS TEXT) ILIKE $2 OR adresse ILIKE $3 OR code_postal ILIKE $4 OR ville ILIKE $5)
      ORDER BY COALESCE(pipedrive_updated_at, pipedrive_created_at, synced_at) DESC LIMIT $6
    `, [like, like, like, like, like, limit]);
    return rows;
  }

  async findRecent(mode = 'modified', limit = 30) {
    const orderCol = mode === 'new'
      ? 'COALESCE(pipedrive_created_at, synced_at)'
      : 'COALESCE(pipedrive_updated_at, pipedrive_created_at, synced_at)';
    const { rows } = await this.pool.query(`
      SELECT id, pipedrive_deal_id, titre, code_postal, ville, prix_fai, occupation_status,
             rentabilite_post_rev, pipedrive_updated_at, pipedrive_created_at, owner_name
      FROM biens WHERE archived = 0
      ORDER BY ${orderCol} DESC LIMIT $1
    `, [limit]);
    return rows;
  }

  async archive(pipedriveDealId) {
    const result = await this.pool.query(
      'UPDATE biens SET archived = 1 WHERE pipedrive_deal_id = $1 AND archived = 0',
      [pipedriveDealId]
    );
    return result.rowCount;
  }

  async countActive() {
    const { rows } = await this.pool.query('SELECT COUNT(*) as n FROM biens WHERE archived = 0');
    return parseInt(rows[0].n, 10);
  }

  async countArchived() {
    const { rows } = await this.pool.query('SELECT COUNT(*) as n FROM biens WHERE archived = 1');
    return parseInt(rows[0].n, 10);
  }
}

module.exports = BiensRepository;
