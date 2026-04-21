const { Pool } = require('pg');
const crypto = require('crypto');

function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pwd, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pwd, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.pbkdf2Sync(pwd, salt, 100000, 64, 'sha512').toString('hex');
  if (h.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}

const fs = require('fs');

function buildSslConfig() {
  let host = process.env.PGHOST || '';
  if (!host && process.env.DATABASE_URL) {
    try {
      const parsed = new URL(process.env.DATABASE_URL);
      host = parsed.hostname;
    } catch (_) {}
  }
  const isLocal = !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal) return false;

  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && process.env.PG_CA_CERT) {
    return {
      rejectUnauthorized: true,
      ca: process.env.PG_CA_CERT,
    };
  }
  if (isProduction && process.env.PG_CA_CERT_PATH) {
    return {
      rejectUnauthorized: true,
      ca: fs.readFileSync(process.env.PG_CA_CERT_PATH, 'utf8'),
    };
  }

  const isDevelopment = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
  if (!isDevelopment) {
    require('./lib/logger').logger.warn('Non-development PostgreSQL: no CA certificate configured (PG_CA_CERT / PG_CA_CERT_PATH). Requiring rejectUnauthorized: true anyway.');
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: buildSslConfig(),
  max: 20,
  idleTimeoutMillis: 30000,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT UNIQUE NOT NULL,
      password    TEXT NOT NULL,
      role        TEXT DEFAULT 'agent',
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      impersonate_email TEXT,
      expires_at  TIMESTAMP NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS biens (
      id                  SERIAL PRIMARY KEY,
      pipedrive_deal_id   INTEGER UNIQUE NOT NULL,
      titre               TEXT,
      adresse             TEXT,
      code_postal         TEXT,
      ville               TEXT,
      prix_fai            DOUBLE PRECISION,
      rentabilite         DOUBLE PRECISION,
      rentabilite_post_rev DOUBLE PRECISION,
      occupation_status   TEXT,
      occupation_id       TEXT,
      mandat_id           INTEGER,
      surface             DOUBLE PRECISION,
      nombre_pieces       INTEGER,
      type_bien           TEXT,
      etage               INTEGER,
      ascenseur           INTEGER DEFAULT 0,
      balcon              INTEGER DEFAULT 0,
      terrasse            INTEGER DEFAULT 0,
      jardin              INTEGER DEFAULT 0,
      parking             INTEGER DEFAULT 0,
      cave                INTEGER DEFAULT 0,
      description         TEXT,
      photo_1             TEXT,
      photo_2             TEXT,
      photo_3             TEXT,
      photo_4             TEXT,
      autre_photo         TEXT,
      is_delegation       INTEGER DEFAULT 0,
      pipeline_stage      TEXT,
      owner_id            INTEGER,
      owner_email         TEXT,
      owner_name          TEXT,
      archived            INTEGER DEFAULT 0,
      synced_at           TIMESTAMP,
      pipedrive_updated_at TIMESTAMP,
      pipedrive_created_at TIMESTAMP,
      created_at          TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS acquereurs (
      id                  SERIAL PRIMARY KEY,
      pipedrive_deal_id   INTEGER UNIQUE NOT NULL,
      titre               TEXT,
      owner_id            INTEGER,
      owner_name          TEXT,
      owner_email         TEXT,
      contact_name        TEXT,
      contact_email       TEXT,
      contact_phone       TEXT,
      contact_org         TEXT,
      archived            INTEGER DEFAULT 0,
      synced_at           TIMESTAMP,
      pipedrive_updated_at TIMESTAMP,
      pipedrive_created_at TIMESTAMP,
      created_at          TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS acquereur_criteria (
      id                  SERIAL PRIMARY KEY,
      acquereur_id        INTEGER UNIQUE REFERENCES acquereurs(id) ON DELETE CASCADE,
      budget_min          DOUBLE PRECISION,
      budget_max          DOUBLE PRECISION,
      rentabilite_min     DOUBLE PRECISION,
      occupation_status   TEXT,
      occupation_ids      TEXT,
      secteurs            TEXT,
      apport              DOUBLE PRECISION,
      condition_pret      TEXT,
      updated_at          TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS todos (
      id                  SERIAL PRIMARY KEY,
      acquereur_id        INTEGER REFERENCES acquereurs(id) ON DELETE CASCADE,
      bien_id             INTEGER REFERENCES biens(id) ON DELETE CASCADE,
      statut              TEXT DEFAULT 'non_traite',
      created_by          INTEGER REFERENCES users(id),
      updated_by          INTEGER REFERENCES users(id),
      created_at          TIMESTAMP DEFAULT NOW(),
      updated_at          TIMESTAMP DEFAULT NOW(),
      UNIQUE(acquereur_id, bien_id)
    );

    CREATE TABLE IF NOT EXISTS action_logs (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id),
      action      TEXT NOT NULL,
      entity_type TEXT,
      entity_id   INTEGER,
      details     TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id          SERIAL PRIMARY KEY,
      type        TEXT,
      status      TEXT,
      count       INTEGER,
      message     TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_queue (
      id            SERIAL PRIMARY KEY,
      todo_id       INTEGER,
      bien_id       INTEGER REFERENCES biens(id),
      acquereur_id  INTEGER REFERENCES acquereurs(id),
      status        TEXT DEFAULT 'pending',
      error_message TEXT,
      attempts      INTEGER DEFAULT 0,
      created_at    TIMESTAMP DEFAULT NOW(),
      sent_at       TIMESTAMP
    );
  `);

  const migrations = [
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS taxe_fonciere DOUBLE PRECISION',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS charge_annuelle DOUBLE PRECISION',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS loyer_net_bailleur DOUBLE PRECISION',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS prise_effet_bail TEXT',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS loyer_post_revision DOUBLE PRECISION',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS assujettissement_tva TEXT',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS modalite_augmentation TEXT',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS point_vigilance TEXT',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS points_positifs TEXT',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS surface_rdc DOUBLE PRECISION',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS surface_etage DOUBLE PRECISION',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS surface_sous_sol DOUBLE PRECISION',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS surface_ponderee DOUBLE PRECISION',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS imputation_taxe_fonciere TEXT',
    'ALTER TABLE biens ADD COLUMN IF NOT EXISTS rentabilite_actuelle DOUBLE PRECISION',
    "ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'email'",
    "ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS brevo_message_id TEXT",
    "ALTER TABLE biens ADD COLUMN IF NOT EXISTS lien_drive TEXT",
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch (_) {}
  }

  // Migrations idempotentes — colonnes Ringover sur les utilisateurs (négociateurs).
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS ringover_number VARCHAR(20)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS ringover_user_id INTEGER');

  // Tokens d'activation pour première définition du mot de passe (lien expirant 7 jours).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_setup_tokens (
      token VARCHAR(64) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_setup_tokens_user ON password_setup_tokens(user_id)');
  // Nettoyage opportuniste des tokens d'activation expirés ou consommés depuis +30j.
  try {
    await pool.query(
      "DELETE FROM password_setup_tokens WHERE expires_at < NOW() OR (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '30 days')"
    );
  } catch (_) {}

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_biens_archived ON biens(archived)',
    'CREATE INDEX IF NOT EXISTS idx_biens_stage ON biens(pipeline_stage, archived)',
    'CREATE INDEX IF NOT EXISTS idx_acq_archived ON acquereurs(archived)',
    'CREATE INDEX IF NOT EXISTS idx_acq_owner ON acquereurs(owner_email, archived)',
    'CREATE INDEX IF NOT EXISTS idx_todos_acq ON todos(acquereur_id)',
    'CREATE INDEX IF NOT EXISTS idx_todos_bien ON todos(bien_id)',
    'CREATE INDEX IF NOT EXISTS idx_biens_prix ON biens(prix_fai)',
    'CREATE INDEX IF NOT EXISTS idx_biens_occupation ON biens(occupation_id)',
    'CREATE INDEX IF NOT EXISTS idx_biens_cp ON biens(code_postal)',
    'CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue(status)',
  ];
  for (const sql of indexes) {
    try { await pool.query(sql); } catch (_) {}
  }

  const { rows } = await pool.query('SELECT COUNT(*) as n FROM users');
  if (parseInt(rows[0].n) === 0) {
    await createUser('Daniel', 'daniel@leboutiquier.fr', 'flutch2024', 'admin');
    await createUser('Yankel', 'yankel@leboutiquier.fr', 'flutch2024', 'manager');
    await createUser('Gregory', 'gregory@leboutiquier.fr', 'flutch2024', 'agent');
    await createUser('Davy', 'davy@leboutiquier.fr', 'flutch2024', 'agent');
    await createUser('Samuel', 'samuel@leboutiquier.fr', 'flutch2024', 'agent');
    await createUser('Larissa', 'larissa@leboutiquier.fr', 'flutch2024', 'agent');
    require('./lib/logger').logger.info('Utilisateurs créés');
  }
}

async function getUser(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT id, name, email, role, ringover_number, ringover_user_id FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createUser(name, email, password, role = 'agent') {
  const hash = hashPassword(password);
  const { rows } = await pool.query('INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role]);
  return rows[0];
}

function checkPassword(user, password) {
  return verifyPassword(password, user.password);
}

async function createAuthToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await pool.query('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, expires]);
  return token;
}

async function getUserByToken(token) {
  if (!token) return null;
  const { rows } = await pool.query("SELECT user_id FROM auth_tokens WHERE token = $1 AND expires_at > NOW()", [token]);
  if (!rows[0]) return null;
  return getUserById(rows[0].user_id);
}

async function deleteAuthToken(token) {
  if (token) await pool.query('DELETE FROM auth_tokens WHERE token = $1', [token]);
}

async function createSetupToken(userId, ttlDays = 7) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  await pool.query('DELETE FROM password_setup_tokens WHERE user_id = $1', [userId]);
  await pool.query(
    'INSERT INTO password_setup_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, expires]
  );
  return { token, expiresAt: expires };
}

async function getValidSetupToken(token) {
  if (!token || typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) return null;
  const { rows } = await pool.query(
    `SELECT t.token, t.user_id, t.expires_at, u.name, u.email
     FROM password_setup_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token = $1 AND t.used_at IS NULL AND t.expires_at > NOW()`,
    [token]
  );
  return rows[0] || null;
}

async function consumeSetupToken(token, hashedPassword) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT user_id FROM password_setup_tokens
       WHERE token = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE`,
      [token]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const userId = rows[0].user_id;
    await client.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
    await client.query('UPDATE password_setup_tokens SET used_at = NOW() WHERE token = $1', [token]);
    await client.query('DELETE FROM auth_tokens WHERE user_id = $1', [userId]);
    await client.query('COMMIT');
    return userId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function log(userId, action, entityType, entityId, details) {
  await pool.query(
    'INSERT INTO action_logs (user_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [userId, action, entityType || null, entityId || null, details ? JSON.stringify(details) : null]
  );
}

async function matchAcquereurToBiens(acquereurId, hideelegation = true) {
  const { rows: critRows } = await pool.query('SELECT * FROM acquereur_criteria WHERE acquereur_id = $1', [acquereurId]);
  const criteria = critRows[0] || null;

  let criteriaConditions = [];
  const criteriaParams = [acquereurId];
  let paramIdx = 2;

  if (criteria) {
    if (criteria.budget_min && criteria.budget_min > 0) {
      criteriaConditions.push(`b.prix_fai >= $${paramIdx++}`);
      criteriaParams.push(criteria.budget_min);
    }
    if (criteria.budget_max && criteria.budget_max > 0) {
      criteriaConditions.push(`b.prix_fai <= $${paramIdx++}`);
      criteriaParams.push(criteria.budget_max);
    }
    if (criteria.rentabilite_min && criteria.rentabilite_min > 0) {
      criteriaConditions.push(`COALESCE(b.rentabilite_post_rev, b.rentabilite_actuelle, b.rentabilite) >= $${paramIdx++}`);
      criteriaParams.push(criteria.rentabilite_min);
    }
    if (criteria.occupation_ids) {
      try {
        const ids = JSON.parse(criteria.occupation_ids).map(String);
        if (ids.length > 0) {
          criteriaConditions.push(`b.occupation_id IN (${ids.map(() => `$${paramIdx++}`).join(',')})`);
          criteriaParams.push(...ids);
        }
      } catch (_) {}
    }
    if (criteria.secteurs) {
      const secs = JSON.parse(criteria.secteurs || '[]');
      const isTouteFrance = secs.some(s => s === '99');
      if (!isTouteFrance) {
        const IDF_HORS_75 = ['77', '78', '91', '92', '93', '94', '95'];
        let expanded = [];
        for (const s of secs) {
          if (s === '00') expanded.push(...IDF_HORS_75);
          else if (s && s !== '') expanded.push(s);
        }
        expanded = [...new Set(expanded)];
        if (expanded.length > 0) {
          const clauses = expanded.map(() => `b.code_postal LIKE ($${paramIdx++} || '%')`).join(' OR ');
          criteriaConditions.push(`(${clauses})`);
          criteriaParams.push(...expanded);
        }
      }
    }
  }

  const critWhere = criteriaConditions.length > 0 ? criteriaConditions.join(' AND ') : '1=1';
  const delegWhere = hideelegation ? 'AND (b.is_delegation = 0 OR b.is_delegation IS NULL)' : '';

  const query = `
    SELECT b.*,
           t.id as todo_id,
           t.statut as statut_todo
    FROM biens b
    LEFT JOIN todos t ON t.bien_id = b.id AND t.acquereur_id = $1
    WHERE b.archived = 0 ${delegWhere}
      AND (
        (${critWhere})
        OR t.id IS NOT NULL
      )
    ORDER BY COALESCE(b.pipedrive_updated_at, b.pipedrive_created_at, b.synced_at) DESC
  `;

  const { rows } = await pool.query(query, criteriaParams);
  return rows;
}

async function matchBienToAcquereurs(bienId, ownerEmail = null) {
  const { rows: bienRows } = await pool.query('SELECT * FROM biens WHERE id = $1', [bienId]);
  const bien = bienRows[0];
  if (!bien) return [];

  let fullQuery = `
    SELECT a.*,
           c.budget_min, c.budget_max, c.rentabilite_min,
           c.occupation_status as crit_occ, c.occupation_ids as crit_occ_ids,
           c.secteurs,
           t.id as todo_id,
           t.statut as statut_todo
    FROM acquereurs a
    LEFT JOIN acquereur_criteria c ON c.acquereur_id = a.id
    LEFT JOIN todos t ON t.acquereur_id = a.id AND t.bien_id = $1
    WHERE a.archived = 0
  `;
  const fullParams = [bienId];

  if (ownerEmail) {
    fullQuery += ' AND a.owner_email = $2';
    fullParams.push(ownerEmail);
  }

  const { rows: acquereurs } = await pool.query(fullQuery, fullParams);

  const bienRenta = bien.rentabilite_post_rev || bien.rentabilite;

  return acquereurs.filter(a => {
    try {
      if (a.todo_id) return true;
      if (a.budget_min && a.budget_min > 0 && bien.prix_fai < a.budget_min) return false;
      if (a.budget_max && a.budget_max > 0 && bien.prix_fai > a.budget_max) return false;
      if (a.rentabilite_min && a.rentabilite_min > 0 && bienRenta && bienRenta < a.rentabilite_min) return false;
      if (a.crit_occ_ids) {
        const ids = JSON.parse(a.crit_occ_ids).map(String);
        if (ids.length > 0 && !ids.includes(String(bien.occupation_id))) return false;
      }
      if (a.secteurs) {
        const secs = JSON.parse(a.secteurs);
        const isTouteFrance = secs.some(s => s === '99');
        if (!isTouteFrance && secs.length > 0) {
          const IDF_HORS_75 = ['77', '78', '91', '92', '93', '94', '95'];
          let expanded = [];
          for (const s of secs) {
            if (s === '00') expanded.push(...IDF_HORS_75);
            else if (s && s !== '') expanded.push(s);
          }
          const cpBien = bien.code_postal || '';
          const match = expanded.some(s => cpBien.startsWith(s));
          if (!match && cpBien) return false;
        }
      }
      return true;
    } catch (_) { return false; }
  });
}

module.exports = { pool, initSchema, getUser, getUserById, createUser, checkPassword, hashPassword, createAuthToken, getUserByToken, deleteAuthToken, createSetupToken, getValidSetupToken, consumeSetupToken, log, matchAcquereurToBiens, matchBienToAcquereurs };
