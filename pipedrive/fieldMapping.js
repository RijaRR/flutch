'use strict';

/**
 * Centralisation du mapping des champs Pipedrive.
 * Un seul objet KEYS, un seul OCC_LABELS, une seule source de vérité.
 * FIX Audit 1.2 — Élimine la triple définition de KEYS.
 */

const { pdGet } = require('./client');
const { logger } = require('../lib/logger');

function norm(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─── Champs statiques (hashes constants) ────────────────────────────────

const ADRESSE_FIELD = '7dae704151dd042a6dfef1c152b03670441a0332';

/** Labels d'occupation Pipedrive — source unique */
const OCC_LABELS = {
  333: 'Murs libres', 332: 'Murs occupés', 351: 'Immeuble libre',
  352: 'Immeuble occupé', 353: 'Bureaux libres', 354: 'Bureaux occupés',
  334: 'Location pure', 390: 'Hors cible',
};

/** Labels d'occupation simplifiés pour les critères acquéreurs */
const OCC_MAP_SIMPLE = {
  333: 'Libre', 332: 'Occupé', 351: 'Libre', 352: 'Occupé',
  353: 'Libre', 354: 'Occupé', 334: 'Location',
};

const TVA_LABELS = { 74: 'Assujetti', 75: 'Non assujetti' };
const MODALITE_LABELS = {
  369: 'Révision triennale légale', 370: 'Indexation conventionnelle annuelle',
  371: 'ILC', 372: 'ICC', 373: 'Autre', 463: 'Murs libres',
};
const IMPUT_TF_LABELS = {
  195: 'Imputée au locataire', 196: '50/50',
  197: 'Non imputée au locataire', 464: 'Murs libres',
};

/** Clés statiques pour les acquéreurs (pas besoin de résolution dynamique) */
const ACQ_KEYS = {
  budget_min: '4f22c33e84cb1e27c3f43e5c6113a3075b27a732',
  budget_max: '77536372ffdd85fad871278ffa82b56877cc8347',
  rentabilite_min: '0e23eafbe69625f6a4d8a8c56d07755a28dddaf1',
  occupation: 'ff88b708d9d16f9729825144ab907171364ef744',
  secteurs: '128fa9e5c711bd57384dccff920fb4b2fff28f8a',
  apport: 'cb21e7d0444ab342f723ab1061f247911a35bd06',
  condition_pret: '34dded16ece2a316aaebdbb8d7c9260c6a8dca37',
};

// ─── Résolution dynamique des champs biens ──────────────────────────────

/** @type {Record<string, string> | null} */
let cachedBienKeys = null;
/** @type {number} */
let cachedBienKeysAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 heure (FIX Audit 4.4 — TTL sur le cache)

async function getDealFieldsMap(apiToken) {
  const data = await pdGet('/dealFields?limit=200', apiToken);
  const map = {};
  if (data?.data) {
    data.data.forEach(f => { map[f.key] = f.name; });
  }
  return map;
}

async function getBienKeys(apiToken) {
  // FIX Audit 1.2 — Cache avec TTL pour éviter les clés obsolètes
  if (cachedBienKeys && (Date.now() - cachedBienKeysAt) < CACHE_TTL_MS) return cachedBienKeys;

  const fieldMap = await getDealFieldsMap(apiToken);
  const findKey = (name) => Object.entries(fieldMap).find(([, v]) => norm(v) === norm(name))?.[0];

  cachedBienKeys = {
    adresse: ADRESSE_FIELD,
    code_postal: ADRESSE_FIELD + '_postal_code',
    ville: ADRESSE_FIELD + '_locality',
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
  cachedBienKeysAt = Date.now();
  logger.info('📌 Bien field keys cached');
  return cachedBienKeys;
}

/** Invalidate le cache (utile si les champs Pipedrive changent) */
function invalidateBienKeysCache() {
  cachedBienKeys = null;
  cachedBienKeysAt = 0;
}

// ─── Helpers de résolution ──────────────────────────────────────────────

function resolveSet(raw, labels) {
  if (!raw) return null;
  return String(raw).split(',').map(id => labels[parseInt(id.trim())] || '').filter(Boolean).join(', ');
}

function resolveEnum(raw, labels) {
  if (!raw) return null;
  return labels[parseInt(String(raw))] || String(raw);
}

async function findPipelineId(pipelineName, apiToken) {
  const data = await pdGet('/pipelines', apiToken);
  if (!data?.data) return null;
  const n = norm(pipelineName);
  const p = data.data.find(p => norm(p.name) === n);
  return p ? p.id : null;
}

async function findStageId(stageName, apiToken, pipelineId = null) {
  const url = pipelineId ? `/stages?pipeline_id=${pipelineId}` : '/stages';
  const data = await pdGet(url, apiToken);
  if (!data?.data) return null;
  const n = norm(stageName);
  const s = data.data.find(s => norm(s.name) === n);
  return s ? s.id : null;
}

module.exports = {
  norm,
  OCC_LABELS,
  OCC_MAP_SIMPLE,
  TVA_LABELS,
  MODALITE_LABELS,
  IMPUT_TF_LABELS,
  ACQ_KEYS,
  getDealFieldsMap,
  getBienKeys,
  invalidateBienKeysCache,
  resolveSet,
  resolveEnum,
  findPipelineId,
  findStageId,
};
