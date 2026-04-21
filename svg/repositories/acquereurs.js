'use strict';

/**
 * Repository pour la table `acquereurs` et `acquereur_criteria`.
 */

class AcquereursRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async findById(id) {
    const { rows } = await this.pool.query('SELECT * FROM acquereurs WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async findByIdWithCriteria(id) {
    const { rows } = await this.pool.query(
      `SELECT a.*, c.budget_min, c.budget_max, c.rentabilite_min, c.secteurs,
              c.occupation_status as crit_occ, c.occupation_ids as crit_occ_ids
       FROM acquereurs a
       LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
       WHERE a.id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  async findByPipedriveDealId(dealId) {
    const { rows } = await this.pool.query('SELECT id FROM acquereurs WHERE pipedrive_deal_id = $1', [dealId]);
    return rows[0] || null;
  }

  async findByOwnerEmail(ownerEmail, options = {}) {
    const { archived = 0 } = options;
    const { rows } = await this.pool.query(
      `SELECT a.id, a.titre, a.pipedrive_deal_id, a.contact_name, a.contact_email,
              a.contact_phone, a.owner_name, a.pipedrive_updated_at, a.pipedrive_created_at,
              c.budget_min, c.budget_max, c.rentabilite_min, c.secteurs
       FROM acquereurs a
       LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
       WHERE a.archived = $1 AND a.owner_email = $2
       ORDER BY a.titre`,
      [archived, ownerEmail]
    );
    return rows;
  }

  async findAll(options = {}) {
    const { archived = 0 } = options;
    const { rows } = await this.pool.query(
      `SELECT a.id, a.titre, a.pipedrive_deal_id, a.contact_name, a.contact_email,
              a.contact_phone, a.owner_name, a.pipedrive_updated_at, a.pipedrive_created_at,
              c.budget_min, c.budget_max, c.rentabilite_min, c.secteurs
       FROM acquereurs a
       LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
       WHERE a.archived = $1
       ORDER BY a.titre`,
      [archived]
    );
    return rows;
  }

  async archive(pipedriveDealId) {
    const result = await this.pool.query(
      'UPDATE acquereurs SET archived = 1 WHERE pipedrive_deal_id = $1 AND archived = 0',
      [pipedriveDealId]
    );
    return result.rowCount;
  }

  async countActive() {
    const { rows } = await this.pool.query('SELECT COUNT(*) as n FROM acquereurs WHERE archived = 0');
    return parseInt(rows[0].n, 10);
  }

  async countArchived() {
    const { rows } = await this.pool.query('SELECT COUNT(*) as n FROM acquereurs WHERE archived = 1');
    return parseInt(rows[0].n, 10);
  }

  async getDistinctOwners() {
    const { rows } = await this.pool.query(`
      SELECT DISTINCT owner_email, owner_name
      FROM acquereurs WHERE owner_email IS NOT NULL AND archived = 0
      ORDER BY owner_name
    `);
    return rows;
  }

  async checkOwnership(acquereurId, ownerEmail) {
    const { rows } = await this.pool.query(
      'SELECT id FROM acquereurs WHERE id = $1 AND owner_email = $2',
      [acquereurId, ownerEmail]
    );
    return rows.length > 0;
  }
}

module.exports = AcquereursRepository;
