'use strict';

/**
 * Création d'activités Pipedrive pour le matching (envoi/retrait de biens).
 */

const { pool } = require('../db');
const { pdPost } = require('./client');
const { pdPut } = require('./client');

async function pushCriteriaToP(acquereurId, apiToken) {
  const { rows: acqRows } = await pool.query('SELECT * FROM acquereurs WHERE id = $1', [acquereurId]);
  const acq = acqRows[0];
  const { rows: critRows } = await pool.query('SELECT * FROM acquereur_criteria WHERE acquereur_id = $1', [acquereurId]);
  const crit = critRows[0];
  if (!acq || !crit) return;

  const PUSH_KEYS = {
    budget_min: '4f22c33e84cb1e27c3f43e5c6113a3075b27a732',
    budget_max: '77536372ffdd85fad871278ffa82b56877cc8347',
    rentabilite_min: '0e23eafbe69625f6a4d8a8c56d07755a28dddaf1',
    occupation: 'ff88b708d9d16f9729825144ab907171364ef744',
    secteurs: '128fa9e5c711bd57384dccff920fb4b2fff28f8a',
    apport: 'cb21e7d0444ab342f723ab1061f247911a35bd06',
    condition_pret: '34dded16ece2a316aaebdbb8d7c9260c6a8dca37',
  };

  const body = {};
  if (crit.budget_min) body[PUSH_KEYS.budget_min] = crit.budget_min;
  if (crit.budget_max) body[PUSH_KEYS.budget_max] = crit.budget_max;
  if (crit.rentabilite_min) body[PUSH_KEYS.rentabilite_min] = crit.rentabilite_min;
  if (crit.occupation_ids) {
    const ids = JSON.parse(crit.occupation_ids);
    body[PUSH_KEYS.occupation] = ids.join(',');
  }
  if (crit.secteurs) {
    const secs = JSON.parse(crit.secteurs);
    body[PUSH_KEYS.secteurs] = secs.join(',');
  }
  if (crit.apport) body[PUSH_KEYS.apport] = crit.apport;
  if (crit.condition_pret) {
    body[PUSH_KEYS.condition_pret] = crit.condition_pret === 'Oui' ? 320 : crit.condition_pret === 'Non' ? 321 : null;
  }

  if (Object.keys(body).length > 0) {
    await pdPut(`/deals/${acq.pipedrive_deal_id}`, body, apiToken);
  }
}

async function createMatchActivity(acquereurId, bienIdOrIds, apiToken, action = 'envoyer') {
  const { rows: acqRows } = await pool.query('SELECT * FROM acquereurs WHERE id = $1', [acquereurId]);
  const acq = acqRows[0];
  if (!acq) throw new Error('Acquéreur introuvable');

  const today = new Date().toISOString().slice(0, 10);

  if (action === 'envoyer') {
    const { rows: bienRows } = await pool.query('SELECT * FROM biens WHERE id = $1', [bienIdOrIds]);
    const bien = bienRows[0];
    if (!bien) throw new Error('Bien introuvable');
    await pdPost('/activities', {
      subject: `[ENVOYER] ${bien.titre}`, type: 'hellosend_sms',
      deal_id: acq.pipedrive_deal_id, due_date: today, done: 1,
      note: `Le bien "${bien.titre}" (ID: ${bien.pipedrive_deal_id}) a été envoyé à l'acquéreur ${acq.titre}.`,
    }, apiToken);
    await pdPost('/activities', {
      subject: `[ENVOYER] Envoyé à ${acq.titre}`, type: 'hellosend_sms',
      deal_id: bien.pipedrive_deal_id, due_date: today, done: 1,
      note: `Ce bien a été envoyé à l'acquéreur "${acq.titre}" le ${today}.`,
    }, apiToken);
  } else if (action === 'retirer') {
    const { rows: bienRows } = await pool.query('SELECT * FROM biens WHERE id = $1', [bienIdOrIds]);
    const bien = bienRows[0];
    if (!bien) throw new Error('Bien introuvable');
    await pdPost('/activities', {
      subject: `[RETIRER] Bien retiré - ${bien.titre}`, type: 'hellosend_sms',
      deal_id: acq.pipedrive_deal_id, due_date: today, done: 1,
      note: `Le bien "${bien.titre}" (ID: ${bien.pipedrive_deal_id}) a été retiré pour l'acquéreur ${acq.titre}.`,
    }, apiToken);
    await pdPost('/activities', {
      subject: `[RETIRER] Retiré pour ${acq.titre}`, type: 'hellosend_sms',
      deal_id: bien.pipedrive_deal_id, due_date: today, done: 1,
      note: `Ce bien a été retiré pour l'acquéreur "${acq.titre}" le ${today}.`,
    }, apiToken);
  } else if (action === 'envoyer_bulk') {
    const bienIds = Array.isArray(bienIdOrIds) ? bienIdOrIds : [bienIdOrIds];
    const biens = [];
    for (const id of bienIds) {
      const { rows } = await pool.query('SELECT * FROM biens WHERE id = $1', [id]);
      if (rows[0]) biens.push(rows[0]);
    }
    if (!biens.length) throw new Error('Aucun bien trouvé');
    const liste = biens.map(b => `- ${b.titre}`).join('\n');
    await pdPost('/activities', {
      subject: `[ENVOYER] ${biens.length} biens envoyés`, type: 'hellosend_sms',
      deal_id: acq.pipedrive_deal_id, due_date: today, done: 1,
      note: `${biens.length} biens envoyés à l'acquéreur ${acq.titre} :\n${liste}`,
    }, apiToken);
    for (const bien of biens) {
      await pdPost('/activities', {
        subject: `[ENVOYER] Envoyé à ${acq.titre}`, type: 'hellosend_sms',
        deal_id: bien.pipedrive_deal_id, due_date: today, done: 1,
        note: `Ce bien a été envoyé à l'acquéreur "${acq.titre}" le ${today}.`,
      }, apiToken);
    }
  } else if (action === 'retirer_bulk') {
    const bienIds = Array.isArray(bienIdOrIds) ? bienIdOrIds : [bienIdOrIds];
    const biens = [];
    for (const id of bienIds) {
      const { rows } = await pool.query('SELECT * FROM biens WHERE id = $1', [id]);
      if (rows[0]) biens.push(rows[0]);
    }
    if (!biens.length) throw new Error('Aucun bien trouvé');
    const liste = biens.map(b => `- ${b.titre}`).join('\n');
    await pdPost('/activities', {
      subject: `[RETIRER] ${biens.length} biens retirés`, type: 'hellosend_sms',
      deal_id: acq.pipedrive_deal_id, due_date: today, done: 1,
      note: `${biens.length} biens retirés pour l'acquéreur ${acq.titre} :\n${liste}`,
    }, apiToken);
    for (const bien of biens) {
      await pdPost('/activities', {
        subject: `[RETIRER] Retiré pour ${acq.titre}`, type: 'hellosend_sms',
        deal_id: bien.pipedrive_deal_id, due_date: today, done: 1,
        note: `Ce bien a été retiré pour l'acquéreur "${acq.titre}" le ${today}.`,
      }, apiToken);
    }
  }
}

module.exports = { pushCriteriaToP, createMatchActivity };
