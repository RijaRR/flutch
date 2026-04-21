'use strict';

/**
 * Repository pour la table `email_queue`.
 */

class EmailQueueRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async countByStatus(ownerEmail, status) {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) as n FROM email_queue eq
       JOIN acquereurs a ON a.id = eq.acquereur_id
       WHERE eq.status = $2 AND a.owner_email = $1`,
      [ownerEmail, status]
    );
    return parseInt(rows[0].n, 10);
  }

  async countPendingByOwner(ownerEmail) {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) as n FROM email_queue eq
       JOIN acquereurs a ON a.id = eq.acquereur_id
       WHERE eq.status IN ('pending','sending') AND a.owner_email = $1`,
      [ownerEmail]
    );
    return parseInt(rows[0].n, 10);
  }

  async countTotalPending() {
    const { rows } = await this.pool.query(
      "SELECT COUNT(*) as n FROM email_queue WHERE status = 'pending'"
    );
    return parseInt(rows[0].n, 10);
  }

  async findFailedByOwner(ownerEmail) {
    const { rows } = await this.pool.query(`
      SELECT eq.id, eq.error_message, eq.attempts, eq.created_at, eq.channel,
             b.titre as bien_titre, b.pipedrive_deal_id as bien_pd_id,
             a.titre as acquereur_titre, a.contact_name as acquereur_contact
      FROM email_queue eq
      LEFT JOIN biens b ON b.id = eq.bien_id
      LEFT JOIN acquereurs a ON a.id = eq.acquereur_id
      WHERE eq.status = 'failed' AND a.owner_email = $1
      ORDER BY eq.created_at DESC
    `, [ownerEmail]);
    return rows;
  }

  async findHistoryByOwner(ownerEmail, limit = 500) {
    const { rows } = await this.pool.query(`
      SELECT eq.id, eq.status, eq.error_message, eq.attempts, eq.created_at, eq.sent_at, eq.channel,
             eq.brevo_message_id,
             b.titre as bien_titre, b.pipedrive_deal_id as bien_pd_id,
             a.titre as acquereur_titre, a.contact_name as acquereur_contact,
             a.contact_email as acquereur_email
      FROM email_queue eq
      LEFT JOIN biens b ON b.id = eq.bien_id
      LEFT JOIN acquereurs a ON a.id = eq.acquereur_id
      WHERE a.owner_email = $1
      ORDER BY eq.created_at DESC
      LIMIT $2
    `, [ownerEmail, limit]);
    return rows;
  }

  async insert(bienId, acquereurId, channel, status = 'pending') {
    const { rows } = await this.pool.query(`
      INSERT INTO email_queue (bien_id, acquereur_id, status, channel)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [bienId, acquereurId, status, channel]);
    return rows[0];
  }

  async deleteByIdAndOwner(id, ownerEmail) {
    const result = await this.pool.query(
      `DELETE FROM email_queue WHERE id = $1
       AND acquereur_id IN (SELECT id FROM acquereurs WHERE owner_email = $2)`,
      [id, ownerEmail]
    );
    return result.rowCount;
  }
}

module.exports = EmailQueueRepository;
