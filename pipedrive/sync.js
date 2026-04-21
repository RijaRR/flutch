'use strict';

/**
 * Sync batch Pipedrive → PostgreSQL.
 * syncBiens : synchronise les biens depuis un stage donné.
 * syncAcquereurs : synchronise les acquéreurs depuis un pipeline/stage.
 */

const { logger } = require('../lib/logger');
const { pool, log } = require('../db');
const { pdGet } = require('./client');
const {
  getDealFieldsMap,
  norm,
  findPipelineId,
  findStageId,
  OCC_LABELS,
  TVA_LABELS,
  MODALITE_LABELS,
  IMPUT_TF_LABELS,
  ACQ_KEYS,
  resolveSet,
  resolveEnum,
} = require('./fieldMapping');

async function syncBiens(apiToken, stageName = 'Commercialisé', userId = null, pipelineName = null) {
  logger.info('🔄 Sync biens...');

  let pipelineIdFilter = null;
  if (pipelineName) {
    pipelineIdFilter = await findPipelineId(pipelineName, apiToken);
    if (!pipelineIdFilter) logger.warn(`⚠️ Pipeline "${pipelineName}" introuvable, recherche de l'étape dans tous les pipelines`);
  }

  const stageId = await findStageId(stageName, apiToken, pipelineIdFilter);
  if (!stageId) throw new Error(`Étape "${stageName}" introuvable${pipelineName ? ` dans le pipeline "${pipelineName}"` : ''}`);

  const fieldMap = await getDealFieldsMap(apiToken);
  const findKey = (name) => Object.entries(fieldMap).find(([, v]) => norm(v) === norm(name))?.[0];

  const ADRESSE_FIELD = '7dae704151dd042a6dfef1c152b03670441a0332';
  const KEYS = {
    adresse: ADRESSE_FIELD, code_postal: ADRESSE_FIELD + '_postal_code', ville: ADRESSE_FIELD + '_locality',
    prix_fai: 'e47953f94beac00febac89a76afb3860cdb51fef',
    rentabilite_post_rev: 'd90975abce5b5abb909d65bba327ec4936c2da0e',
    occupation: 'ff88b708d9d16f9729825144ab907171364ef744',
    mandat: 'e00ab03bb0bfdb3118bddfb18d02c02036c8a49d',
    surface: findKey('Surface') || findKey('surface'),
    nb_pieces: findKey('Nombre de pièces') || findKey('Pièces') || findKey('pieces'),
    type_bien: findKey('Type de bien') || findKey('Type'),
    etage: findKey('Étage') || findKey('Etage'),
    ascenseur: findKey('Ascenseur'), balcon: findKey('Balcon'), terrasse: findKey('Terrasse'),
    jardin: findKey('Jardin'), parking: findKey('Parking'), cave: findKey('Cave'),
    photo_1: findKey('Photo 1') || findKey('Photo principale'),
    photo_2: findKey('Photo 2'), photo_3: findKey('Photo 3'), photo_4: findKey('Photo 4'),
    autre_photo: findKey('Autre photo'),
    description: findKey('Description') || findKey('Descriptif'),
    classe_actifs: 'fddda5e38e41f34e60fa29e673fdfcb616400714',
    qualite_emplacement: '7c1fc74a248984e86233964b915267757dac7463',
    regime_propriete: 'bf3b56e01ab05315c1bf7e594f98353c9cc83b72',
    taxe_fonciere: '68952aa99715f630b6008951f5456149e68862e8',
    imputation_taxe_fonciere: 'db1cbc34063f81940f220f385113fd9ace7f22af',
    charge_annuelle: findKey('Charge annuelle') || findKey('Charges annuelles'),
    loyer_net_bailleur: '992e4b7155938077abd257eb335e1636ed23cada',
    prise_effet_bail: '5184aff71c51c12733aa7ae70ded5d6258d5fd21',
    loyer_post_revision: findKey('Loyer post-révision') || findKey('Loyer post revision') || findKey('Loyer post-revision'),
    assujettissement_tva: 'd80001fb080f075131f7c6913793b12214bd59ed',
    modalite_augmentation: 'b5d60aa066361be0ee3daab054712b9f0942d475',
    point_vigilance: 'f85f09a9b00fee2068b49e35fe65ca7adcec40b0',
    points_positifs: '6cbc95083ce14b748ba74dc5c65d4f25e3d060c6',
    surface_totale: 'e076db25cd27a7063fbaefda83beadf05dc6d164',
    surface_rdc: '9e8f4aa6c60543d2a263433f38fda0b21822da52',
    surface_etage: '239568e5ae63df64edd731ef1fa25db4cf76d2d8',
    surface_sous_sol: 'f25ee0c5cc58626b06ed1bbbcea550cdce5fd3c2',
    surface_ponderee: 'd2291bf2e4450ce095d3223d0467da9dea6fa2f1',
    rentabilite_actuelle: '3760c7c6ceef3dbf3c9f02e45b1645f9e2474311',
    descriptif: '64a1fc355d42e14a523831810120de6f6f831009',
    lien_drive: '6892d428773133b48a4a8b441548f038c7bf214c',
    photo_couverture: 'ed56fa0611b44379812c33dc28635f8ba0506c26',
    photo_2_real: 'e332d3138ff156857f74e3200bfa95ff740e1d41',
    photo_3_real: 'fd5c069993e79456623057d9d96060aa53f2c875',
  };

  let allDeals = [];
  let start = 0;
  const limit = 200;
  let moreItems = true;
  while (moreItems) {
    const data = await pdGet(`/deals?stage_id=${stageId}&status=open&start=${start}&limit=${limit}`, apiToken);
    if (!data?.data?.length) break;
    allDeals = allDeals.concat(data.data);
    moreItems = data.additional_data?.pagination?.more_items_in_collection;
    start += limit;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const deal of allDeals) {
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

      const resolvedModalite = resolveSet(g(KEYS.modalite_augmentation), MODALITE_LABELS);
      const resolvedTva = resolveEnum(g(KEYS.assujettissement_tva), TVA_LABELS);
      const resolvedImputTF = resolveSet(g(KEYS.imputation_taxe_fonciere), IMPUT_TF_LABELS);
      const descriptif = g(KEYS.descriptif) || null;
      const lienDrive = g(KEYS.lien_drive) || null;
      const photoCouv = g(KEYS.photo_couverture) || g(KEYS.photo_1) || null;
      const photo2 = g(KEYS.photo_2_real) || g(KEYS.photo_2) || null;
      const photo3 = g(KEYS.photo_3_real) || g(KEYS.photo_3) || null;

      await client.query(`
        INSERT INTO biens (pipedrive_deal_id, titre, adresse, code_postal, ville, prix_fai, rentabilite,
          rentabilite_post_rev, occupation_status, occupation_id, mandat_id, surface, nombre_pieces,
          type_bien, etage, ascenseur, balcon, terrasse, jardin, parking, cave, description,
          photo_1, photo_2, photo_3, photo_4, autre_photo,
          is_delegation, pipeline_stage, owner_id, owner_email, owner_name,
          taxe_fonciere, charge_annuelle, loyer_net_bailleur, prise_effet_bail,
          loyer_post_revision, assujettissement_tva, modalite_augmentation,
          point_vigilance, points_positifs,
          surface_rdc, surface_etage, surface_sous_sol, surface_ponderee,
          imputation_taxe_fonciere, rentabilite_actuelle, lien_drive,
          pipedrive_updated_at, pipedrive_created_at, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,NOW())
        ON CONFLICT(pipedrive_deal_id) DO UPDATE SET
          titre=EXCLUDED.titre, adresse=EXCLUDED.adresse, code_postal=EXCLUDED.code_postal,
          ville=EXCLUDED.ville, prix_fai=EXCLUDED.prix_fai, rentabilite=EXCLUDED.rentabilite,
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
          taxe_fonciere=EXCLUDED.taxe_fonciere, charge_annuelle=EXCLUDED.charge_annuelle,
          loyer_net_bailleur=EXCLUDED.loyer_net_bailleur, prise_effet_bail=EXCLUDED.prise_effet_bail,
          loyer_post_revision=EXCLUDED.loyer_post_revision, assujettissement_tva=EXCLUDED.assujettissement_tva,
          modalite_augmentation=EXCLUDED.modalite_augmentation,
          point_vigilance=EXCLUDED.point_vigilance, points_positifs=EXCLUDED.points_positifs,
          surface_rdc=EXCLUDED.surface_rdc, surface_etage=EXCLUDED.surface_etage,
          surface_sous_sol=EXCLUDED.surface_sous_sol, surface_ponderee=EXCLUDED.surface_ponderee,
          imputation_taxe_fonciere=EXCLUDED.imputation_taxe_fonciere,
          rentabilite_actuelle=EXCLUDED.rentabilite_actuelle,
          lien_drive=EXCLUDED.lien_drive,
          pipedrive_updated_at=EXCLUDED.pipedrive_updated_at,
          pipedrive_created_at=EXCLUDED.pipedrive_created_at,
          synced_at=NOW()
      `, [
        deal.id, deal.title || '', g(KEYS.adresse) || deal.title, cp, g(KEYS.ville),
        toFloat(g(KEYS.prix_fai)) || toFloat(deal.value), null,
        toFloat(g(KEYS.rentabilite_post_rev)), occLabel, occId ? String(occId) : null,
        mandatId, toFloat(g(KEYS.surface_totale)) || toFloat(g(KEYS.surface)),
        g(KEYS.nb_pieces) ? parseInt(g(KEYS.nb_pieces)) : null,
        g(KEYS.type_bien), g(KEYS.etage) ? parseInt(g(KEYS.etage)) : null,
        toBool(g(KEYS.ascenseur)), toBool(g(KEYS.balcon)), toBool(g(KEYS.terrasse)),
        toBool(g(KEYS.jardin)), toBool(g(KEYS.parking)), toBool(g(KEYS.cave)),
        descriptif, photoCouv, photo2, photo3,
        g(KEYS.photo_4), g(KEYS.autre_photo),
        isDeleg, stageName, deal.user_id?.id || null, deal.user_id?.email || null,
        deal.user_id?.name || null,
        toFloat(g(KEYS.taxe_fonciere)), toFloat(g(KEYS.charge_annuelle)),
        toFloat(g(KEYS.loyer_net_bailleur)), g(KEYS.prise_effet_bail) || null,
        toFloat(g(KEYS.loyer_post_revision)), resolvedTva,
        resolvedModalite, g(KEYS.point_vigilance) || null,
        g(KEYS.points_positifs) || null,
        toFloat(g(KEYS.surface_rdc)), toFloat(g(KEYS.surface_etage)),
        toFloat(g(KEYS.surface_sous_sol)), toFloat(g(KEYS.surface_ponderee)),
        resolvedImputTF, toFloat(g(KEYS.rentabilite_actuelle)),
        lienDrive,
        deal.update_time || null, deal.add_time || null,
      ]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const currentIds = allDeals.map(d => d.id);
  let archivedCount = 0;
  if (currentIds.length) {
    const placeholders = currentIds.map((_, i) => `$${i + 1}`).join(',');
    const archResult = await pool.query(
      `UPDATE biens SET archived = 1 WHERE pipedrive_deal_id NOT IN (${placeholders}) AND archived = 0`,
      currentIds
    );
    archivedCount = archResult.rowCount;
    await pool.query(
      `UPDATE biens SET archived = 0 WHERE pipedrive_deal_id IN (${placeholders}) AND archived = 1`,
      currentIds
    );
  } else {
    const archResult = await pool.query('UPDATE biens SET archived = 1 WHERE archived = 0');
    archivedCount = archResult.rowCount;
  }

  await pool.query('INSERT INTO sync_log (type, status, count, message) VALUES ($1, $2, $3, $4)',
    ['biens', 'ok', allDeals.length, `${stageName} · ${archivedCount} archivés`]);
  if (userId) await log(userId, 'sync_biens', 'sync', null, { count: allDeals.length, archived: archivedCount });
  logger.info(`✅ ${allDeals.length} biens synchronisés · ${archivedCount} archivés`);
  return allDeals.length;
}

async function syncAcquereurs(apiToken, pipelineNameOrId, userId = null, stageName = null) {
  logger.info('🔄 Sync acquéreurs...');
  const fieldMap = await getDealFieldsMap(apiToken);
  const findKey = (name) => Object.entries(fieldMap).find(([, v]) => norm(v) === norm(name))?.[0];

  const KEYS = ACQ_KEYS;

  let allDeals = [];
  let start = 0;
  const limit = 200;
  let moreItems = true;

  let pipelineId = null;
  if (typeof pipelineNameOrId === 'number' || /^\d+$/.test(pipelineNameOrId)) {
    pipelineId = parseInt(pipelineNameOrId);
  } else {
    pipelineId = await findPipelineId(pipelineNameOrId, apiToken);
  }
  if (!pipelineId) {
    logger.warn(`⚠️ Pipeline "${pipelineNameOrId}" introuvable, sync annulée`);
    return 0;
  }

  let stageIdFilter = null;
  if (stageName) {
    stageIdFilter = await findStageId(stageName, apiToken, pipelineId);
    if (!stageIdFilter) {
      logger.warn(`⚠️ Étape "${stageName}" introuvable dans le pipeline, fallback sur tout le pipeline`);
    }
  }

  while (moreItems) {
    const filterParam = stageIdFilter ? `stage_id=${stageIdFilter}` : `pipeline_id=${pipelineId}`;
    const data = await pdGet(`/deals?${filterParam}&status=open&start=${start}&limit=${limit}`, apiToken);
    if (!data?.data?.length) break;
    allDeals = allDeals.concat(data.data);
    moreItems = data.additional_data?.pagination?.more_items_in_collection;
    start += limit;
  }

  const OCC_MAP = { 333: 'Libre', 332: 'Occupé', 351: 'Libre', 352: 'Occupé', 353: 'Libre', 354: 'Occupé', 334: 'Location' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const deal of allDeals) {
      const g = (key) => key ? deal[key] : null;
      const toFloat = (v) => v ? parseFloat(String(v).replace(/[^0-9.]/g, '')) || null : null;

      await client.query(`
        INSERT INTO acquereurs (pipedrive_deal_id, titre, owner_id, owner_name, owner_email,
          contact_name, contact_email, contact_phone, contact_org,
          pipedrive_updated_at, pipedrive_created_at, synced_at, pipedrive_stage_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)
        ON CONFLICT(pipedrive_deal_id) DO UPDATE SET
          titre=EXCLUDED.titre, owner_id=EXCLUDED.owner_id, owner_name=EXCLUDED.owner_name,
          owner_email=EXCLUDED.owner_email,
          contact_name=EXCLUDED.contact_name, contact_email=EXCLUDED.contact_email,
          contact_phone=EXCLUDED.contact_phone, contact_org=EXCLUDED.contact_org,
          pipedrive_updated_at=EXCLUDED.pipedrive_updated_at,
          pipedrive_created_at=EXCLUDED.pipedrive_created_at,
          synced_at=NOW(), pipedrive_stage_id=EXCLUDED.pipedrive_stage_id
      `, [
        deal.id, deal.title || '', deal.user_id?.id || null, deal.user_id?.name || '',
        deal.user_id?.email || null, deal.person_id?.name || '',
        deal.person_id?.email?.[0]?.value || '', deal.person_id?.phone?.[0]?.value || '',
        deal.org_id?.name || '', deal.update_time || null, deal.add_time || null,
        deal.stage_id || null,
      ]);

      const { rows: acqRows } = await client.query('SELECT id FROM acquereurs WHERE pipedrive_deal_id = $1', [deal.id]);
      const acq = acqRows[0];
      if (acq) {
        let secteurs = g(KEYS.secteurs);
        if (secteurs) {
          const arr = String(secteurs).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
          secteurs = JSON.stringify(arr);
        }
        const rawOcc = g(KEYS.occupation);
        let occIds = null;
        let occLabels = null;
        if (rawOcc) {
          const ids = String(rawOcc).split(',').map(s => s.trim()).filter(Boolean);
          occIds = JSON.stringify(ids);
          const labels = [...new Set(ids.map(id => OCC_MAP[parseInt(id)]).filter(Boolean))];
          occLabels = JSON.stringify(labels);
        }
        const rawCondPret = g(KEYS.condition_pret);
        const condPretLabel = rawCondPret === 320 || rawCondPret === '320' ? 'Oui'
                            : rawCondPret === 321 || rawCondPret === '321' ? 'Non' : null;

        await client.query(`
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
          acq.id, toFloat(g(KEYS.budget_min)), toFloat(g(KEYS.budget_max)),
          toFloat(g(KEYS.rentabilite_min)), occLabels, occIds, secteurs || null,
          toFloat(g(KEYS.apport)), condPretLabel,
        ]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const currentIds = allDeals.map(d => d.id);
  const syncedStageId = stageIdFilter || null;
  let archivedCount = 0;
  if (currentIds.length) {
    const placeholders = currentIds.map((_, i) => `$${i + 1}`).join(',');
    if (syncedStageId) {
      const archResult = await pool.query(
        `UPDATE acquereurs SET archived = 1 WHERE pipedrive_deal_id NOT IN (${placeholders}) AND archived = 0 AND pipedrive_stage_id = $${currentIds.length + 1}`,
        [...currentIds, syncedStageId]
      );
      archivedCount = archResult.rowCount;
    } else {
      const archResult = await pool.query(
        `UPDATE acquereurs SET archived = 1 WHERE pipedrive_deal_id NOT IN (${placeholders}) AND archived = 0`,
        currentIds
      );
      archivedCount = archResult.rowCount;
    }
    await pool.query(
      `UPDATE acquereurs SET archived = 0 WHERE pipedrive_deal_id IN (${placeholders}) AND archived = 1`,
      currentIds
    );
  } else {
    if (syncedStageId) {
      const archResult = await pool.query('UPDATE acquereurs SET archived = 1 WHERE archived = 0 AND pipedrive_stage_id = $1', [syncedStageId]);
      archivedCount = archResult.rowCount;
    } else {
      const archResult = await pool.query('UPDATE acquereurs SET archived = 1 WHERE archived = 0');
      archivedCount = archResult.rowCount;
    }
  }

  await pool.query('INSERT INTO sync_log (type, status, count, message) VALUES ($1, $2, $3, $4)',
    ['acquereurs', 'ok', allDeals.length, `${archivedCount} archivés`]);
  if (userId) await log(userId, 'sync_acquereurs', 'sync', null, { count: allDeals.length, archived: archivedCount });
  logger.info(`✅ ${allDeals.length} acquéreurs synchronisés · ${archivedCount} archivés`);
  return allDeals.length;
}

module.exports = { syncBiens, syncAcquereurs };
