#!/usr/bin/env node
/*
 * Renseigne les numéros Ringover (E.164) des négociateurs.
 *
 * Idempotent : peut être rejoué sans effet de bord.
 * Source : captures Ringover fournies le 18/04/2026 par le propriétaire
 * du compte (cf. attached_assets/Screenshot_20260418_170*Ringover*.jpg).
 *
 * Usage :
 *   node scripts/update-ringover-numbers.js
 *
 * Ce script ne fait QUE des UPDATE. Il ne crée pas d'utilisateur (la
 * création passe par le flux admin habituel pour éviter les mots de
 * passe par défaut commités). Si un email cible n'existe pas dans
 * `users`, il est listé en avertissement et l'exit code passe à 2.
 *
 * Cas reportés (numéros non fournis au 18/04/2026, à compléter
 * ultérieurement) :
 *   - Larissa  (larissa@leboutiquier.fr)
 *   - Mickael  (mickael@leboutiquier.fr)
 *   - Charlie Gouts (07 45 88 81 58) — email/rôle inconnus
 *
 * `ringover_user_id` n'est pas renseigné (pas fourni). Le routage SMS
 * sortant Ringover par numéro suffit, le champ reste optionnel.
 */

const { pool } = require('../db');

// email -> ringover_number (E.164)
const TARGETS = {
  'daniel@leboutiquier.fr':  '+33745896068',
  'yankel@leboutiquier.fr':  '+33755524067',
  'gregory@leboutiquier.fr': '+33745888392',
  'davy@leboutiquier.fr':    '+33757947947',
  'samuel@leboutiquier.fr':  '+33757946662',
  'dan@leboutiquier.fr':     '+33745886754',
  'mathieu@leboutiquier.fr': '+33755523763',
};

async function main() {
  const results = [];
  const missingUsers = [];

  for (const [email, number] of Object.entries(TARGETS)) {
    const { rowCount } = await pool.query(
      `UPDATE users SET ringover_number = $1
        WHERE LOWER(email) = LOWER($2)
        RETURNING id`,
      [number, email]
    );
    if (rowCount === 0) {
      missingUsers.push(email);
      results.push({ email, action: 'SKIPPED (user not in DB)', number });
    } else {
      results.push({ email, action: 'updated', number });
    }
  }

  console.table(results);

  // Rapport de couverture : qui n'a toujours pas de numéro Ringover ?
  const { rows } = await pool.query(
    `SELECT id, name, email, role,
            COALESCE(ringover_number, '') AS ringover_number
       FROM users
      ORDER BY id`
  );
  const missingNumber = rows.filter(r => !r.ringover_number);
  console.log('\nÉtat global users.ringover_number :');
  console.table(rows);

  if (missingNumber.length) {
    console.log(`\n⚠️  ${missingNumber.length} utilisateur(s) sans ringover_number (fallback Brevo) :`);
    missingNumber.forEach(m => console.log(`   - ${m.name} <${m.email}>`));
  } else {
    console.log('\n✅ Tous les utilisateurs ont un ringover_number.');
  }

  await pool.end();

  if (missingUsers.length) {
    console.error(
      `\n❌ ${missingUsers.length} email(s) cible(s) absent(s) de la table users : ` +
      missingUsers.join(', ') +
      `\n   Créez ces comptes via le flux admin habituel puis relancez le script.`
    );
    process.exit(2);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
