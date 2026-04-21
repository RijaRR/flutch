'use strict';

/**
 * Sync temps réel pour les webhooks Pipedrive.
 * syncSingleBien, syncSingleAcquereur : mise à jour d'un deal unique.
 */

const { logger } = require('../lib/logger');
const { pool } = require('../db');
const {
  getBienKeys,
  OCC_LABELS,
  ACQ_KEYS,
  OCC_MAP_SIMPLE,
  TVA_LABELS,
  MODALITE_LABELS,
  IMPUT_TF_LABELS,
  resolveSet,
  resolveEnum,
} = require('./fieldMapping');

async function syncSingleBien(deal, apiToken) {
  const KEYS = await getBienKeys(apiToken);
  const g = (key) => key ? deal[key] : null;
  const toFloat = (v) => v ? parseFloat(String(v).replace(/[^0-9.]/g, '')) || null : null;
  const toBool = (v) => v === true || v === 'Oui' || v === '1' || v === 1 ? 1 : 0;

  const cp = g(KEYS.code_postal) || null;
  const rawOcc = g(KEYS.occupation);
  const occIdStr = rawOcc ? String(rawOcc).split(',')[0].trim() : null;
  const occId = occIdStr ? parseInt(occIdStr) : null;
  const occLabel = occId ? (OCC_LABELS[occId] || String(rawOcc)) : null;
  const rawMandat = g(KEYS.mandat);
  const mandatId = rawMandat ? parseInt(String(rawMandat)) : null;
  const isDeleg = mandatId === 387 ? 1 : 0;

  const surfaceVal = toFloat(g(KEYS.surface_totale)) || toFloat(g(KEYS.surface));
  const photo1 = g(KEYS.photo_couverture) || g(KEYS.photo_1);
  const photo2 = g(KEYS.photo_2_real) || g(KEYS.photo_2);
  const photo3 = g(KEYS.photo_3_real) || g(KEYS.photo_3);

  const { rows: existing } = await pool.query('SELECT pipedrive_updated_at FROM biens WHERE pipedrive_deal_id = $1', [deal.id]);
  if (existing[0] && existing[0].pipedrive_updated_at && deal.update_time && deal.update_time < existing[0].pipedrive_updated_at) {
    logger.info(`⚡ Webhook: bien #${deal.id} ignoré (événement obsolète)`);
    return;
  }

  await pool.query(`
    INSERT INTO biens (pipedrive_deal_id, titre, adresse, code_postal, ville, prix_fai, rentabilite,
      rentabilite_post_rev, occupation_status, occupation_id, mandat_id, surface, nombre_pieces,
      type_bien, etage, ascenseur, balcon, terrasse, jardin, parking, cave, description,
      photo_1, photo_2, photo_3, photo_4, autre_photo,
      is_delegation, pipeline_stage, owner_id, owner_email, owner_name,
      pipedrive_updated_at, pipedrive_created_at, synced_at, archived,
      taxe_fonciere, charge_annuelle, loyer_net_bailleur, prise_effet_bail,
      loyer_post_revision, assujettissement_tva, modalite_augmentation,
      point_vigilance, points_positifs, surface_rdc, surface_etage, surface_sous_sol,
      surface_ponderee, imputation_taxe_fonciere, rentabilite_actuelle, lien_drive)
    VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,NOW(),0,
      $34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49)
    ON CONFLICT(pipedrive_deal_id) DO UPDATE SET
      titre=EXCLUDED.titre, adresse=EXCLUDED.adresse, code_postal=EXCLUDED.code_postal,
      ville=EXCLUDED.ville, prix_fai=EXCLUDED.prix_fai,
      rentabilite_post_rev=EXCLUDED.rentabilite_post_rev,
      occupation_status=EXCLUDED.occupation_status, occupation_id=EXCLUDED.occupation_id,
      mandat_id=EXCLUDED.mandat_id, surface=EXCLUDED.surface,
      nombre_pieces=EXCLUDED.nombre_pieces, type_bien=EXCLUDED.type_bien, etage=EXCLUDED.etage,
      ascenseur=EXCLUDED.ascenseur, balcon=EXCLUDED.balcon, terrasse=EXCLUDED.terrasse,
      jardin=EXCLUDED.jardin, parking=EXCLUDED.parking, cave=EXCLUDED.cave,
      description=EXCLUDED.description, photo_1=EXCLUDED.photo_1, photo_2=EXCLUDED.photo_2,
      photo_3=EXCLUDED.photo_3, photo_4=EXCLUDED.photo_4, autre_photo=EXCLUDED.autre_photo,
      is_delegation=EXCLUDED.is_delegation, owner_id=EXCLUDED.owner_id,
      owner_email=EXCLUDED.owner_email, owner_name=EXCLUDED.owner_name,
      pipedrive_updated_at=EXCLUDED.pipedrive_updated_at,
      taxe_fonciere=EXCLUDED.taxe_fonciere, charge_annuelle=EXCLUDED.charge_annuelle,
      loyer_net_bailleur=EXCLUDED.loyer_net_bailleur, prise_effet_bail=EXCLUDED.prise_effet_bail,
      loyer_post_revision=EXCLUDED.loyer_post_revision, assujettissement_tva=EXCLUDED.assujettissement_tva,
      modalite_augmentation=EXCLUDED.modalite_augmentation, point_vigilance=EXCLUDED.point_vigilance,
      points_positifs=EXCLUDED.points_positifs, surface_rdc=EXCLUDED.surface_rdc,
      surface_etage=EXCLUDED.surface_etage, surface_sous_sol=EXCLUDED.surface_sous_sol,
      surface_ponderee=EXCLUDED.surface_ponderee, imputation_taxe_fonciere=EXCLUDED.imputation_taxe_fonciere,
      rentabilite_actuelle=EXCLUDED.rentabilite_actuelle, lien_drive=EXCLUDED.lien_drive,
      synced_at=NOW(), archived=0
  `, [
    deal.id, deal.title || '', g(KEYS.adresse) || deal.title, cp, g(KEYS.ville),
    toFloat(g(KEYS.prix_fai)) || toFloat(deal.value),
    toFloat(g(KEYS.rentabilite_post_rev)), occLabel, occId ? String(occId) : null,
    mandatId, surfaceVal,
    g(KEYS.nb_pieces) ? parseInt(g(KEYS.nb_pieces)) : null,
    g(KEYS.type_bien), g(KEYS.etage) ? parseInt(g(KEYS.etage)) : null,
    toBool(g(KEYS.ascenseur)), toBool(g(KEYS.balcon)), toBool(g(KEYS.terrasse)),
    toBool(g(KEYS.jardin)), toBool(g(KEYS.parking)), toBool(g(KEYS.cave)),
    g(KEYS.description) || g(KEYS.descriptif), photo1, photo2, photo3,
    g(KEYS.photo_4), g(KEYS.autre_photo),
    isDeleg, 'Commercialisé', deal.user_id?.id || null, deal.user_id?.email || null,
    deal.user_id?.name || null, deal.update_time || null, deal.add_time || null,
    toFloat(g(KEYS.taxe_fonciere)), toFloat(g(KEYS.charge_annuelle)),
    toFloat(g(KEYS.loyer_net_bailleur)), g(KEYS.prise_effet_bail) || null,
    toFloat(g(KEYS.loyer_post_revision)),
    resolveEnum(g(KEYS.assujettissement_tva), TVA_LABELS),
    resolveSet(g(KEYS.modalite_augmentation), MODALITE_LABELS),
    g(KEYS.point_vigilance), g(KEYS.points_positifs),
    toFloat(g(KEYS.surface_rdc)), toFloat(g(KEYS.surface_etage)), toFloat(g(KEYS.surface_sous_sol)),
    toFloat(g(KEYS.surface_ponderee)),
    resolveSet(g(KEYS.imputation_taxe_fonciere), IMPUT_TF_LABELS),
    toFloat(g(KEYS.rentabilite_actuelle)),
    g(KEYS.lien_drive) || null,
  ]);
  logger.info(`⚡ Webhook: bien #${deal.id} "${deal.title}" sync OK`);
}

async function syncSingleAcquereur(deal) {
  const g = (key) => key ? deal[key] : null;
  const toFloat = (v) => v ? parseFloat(String(v).replace(/[^0-9.]/g, '')) || null : null;

  const { rows: existing } = await pool.query('SELECT pipedrive_updated_at FROM acquereurs WHERE pipedrive_deal_id = $1', [deal.id]);
  if (existing[0] && existing[0].pipedrive_updated_at && deal.update_time && deal.update_time < existing[0].pipedrive_updated_at) {
    logger.info(`⚡ Webhook: acquéreur #${deal.id} ignoré (événement obsolète)`);
    return;
  }

  await pool.query(`
    INSERT INTO acquereurs (pipedrive_deal_id, titre, owner_id, owner_name, owner_email,
      contact_name, contact_email, contact_phone, contact_org,
      pipedrive_updated_at, pipedrive_created_at, synced_at, archived)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),0)
    ON CONFLICT(pipedrive_deal_id) DO UPDATE SET
      titre=EXCLUDED.titre, owner_id=EXCLUDED.owner_id, owner_name=EXCLUDED.owner_name,
      owner_email=EXCLUDED.owner_email,
      contact_name=EXCLUDED.contact_name, contact_email=EXCLUDED.contact_email,
      contact_phone=EXCLUDED.contact_phone, contact_org=EXCLUDED.contact_org,
      pipedrive_updated_at=EXCLUDED.pipedrive_updated_at,
      synced_at=NOW(), archived=0
  `, [
    deal.id, deal.title || '', deal.user_id?.id || null, deal.user_id?.name || '',
    deal.user_id?.email || null, deal.person_id?.name || '',
    deal.person_id?.email?.[0]?.value || '', deal.person_id?.phone?.[0]?.value || '',
    deal.org_id?.name || '', deal.update_time || null, deal.add_time || null,
  ]);

  const { rows: acqRows } = await pool.query('SELECT id FROM acquereurs WHERE pipedrive_deal_id = $1', [deal.id]);
  const acq = acqRows[0];
  if (acq) {
    let secteurs = g(ACQ_KEYS.secteurs);
    if (secteurs) {
      const arr = String(secteurs).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
      secteurs = JSON.stringify(arr);
    }
    const rawOcc = g(ACQ_KEYS.occupation);
    let occIds = null;
    let occLabels = null;
    if (rawOcc) {
      const ids = String(rawOcc).split(',').map(s => s.trim()).filter(Boolean);
      occIds = JSON.stringify(ids);
      const labels = [...new Set(ids.map(id => OCC_MAP_SIMPLE[parseInt(id)]).filter(Boolean))];
      occLabels = JSON.stringify(labels);
    }
    const rawCondPret = g(ACQ_KEYS.condition_pret);
    const condPretLabel = rawCondPret === 320 || rawCondPret === '320' ? 'Oui'
                        : rawCondPret === 321 || rawCondPret === '321' ? 'Non' : null;

    await pool.query(`
      INSERT INTO acquereur_criteria (acquereur_id, budget_min, budget_max, rentabilite_min,
        occupation_status, occupation_ids, secteurs, apport, condition_pret, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT(acquereur_id) DO UPDATE SET
        budget_min=EXCLUDED.budget_min, budget_max=EXCLUDED.budget_max,
        rentabilite_min=EXCLUDED.rentabilite_min,
        occupation_status=EXCLUDED.occupation_status,
        occupation_ids=EXCLUDED.occupation_ids, secteurs=EXCLUDED.secteurs,
        apport=EXCLUDED.apport, condition_pret=EXCLUDED.condition_pret,
        updated_at=NOW()
    `, [
      acq.id, toFloat(g(ACQ_KEYS.budget_min)), toFloat(g(ACQ_KEYS.budget_max)),
      toFloat(g(ACQ_KEYS.rentabilite_min)), occLabels, occIds, secteurs || null,
      toFloat(g(ACQ_KEYS.apport)), condPretLabel,
    ]);
  }
  logger.info(`⚡ Webhook: acquéreur #${deal.id} "${deal.title}" sync OK`);
}

module.exports = { syncSingleBien, syncSingleAcquereur };
