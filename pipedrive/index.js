'use strict';

/**
 * Point d'entrée du module pipedrive.
 * Re-exporte toutes les fonctions depuis les sous-modules spécialisés.
 * Le monolithe pipedrive.js racine n'est plus nécessaire.
 */

const { pdGet, pdPut, pdPost } = require('./client');
const {
  getDealFieldsMap,
  getBienKeys,
  invalidateBienKeysCache,
  OCC_LABELS,
  OCC_MAP_SIMPLE,
  ACQ_KEYS,
  TVA_LABELS,
  MODALITE_LABELS,
  IMPUT_TF_LABELS,
  norm,
  resolveSet,
  resolveEnum,
  findPipelineId,
  findStageId,
} = require('./fieldMapping');
const { syncBiens, syncAcquereurs } = require('./sync');
const { syncSingleBien, syncSingleAcquereur } = require('./webhookSync');
const { integrityCheck } = require('./integrity');
const { pushCriteriaToP, createMatchActivity } = require('./activities');
const { archiveDeal } = require('./archive');
const { registerWebhooks } = require('./webhookRegistration');

module.exports = {
  // Client HTTP
  pdGet,
  pdPut,
  pdPost,
  // Field mapping
  getDealFieldsMap,
  getBienKeys,
  invalidateBienKeysCache,
  OCC_LABELS,
  OCC_MAP_SIMPLE,
  ACQ_KEYS,
  TVA_LABELS,
  MODALITE_LABELS,
  IMPUT_TF_LABELS,
  norm,
  resolveSet,
  resolveEnum,
  findPipelineId,
  findStageId,
  // Sync batch
  syncBiens,
  syncAcquereurs,
  // Sync webhook (temps réel)
  syncSingleBien,
  syncSingleAcquereur,
  // Integrity
  integrityCheck,
  // Activities
  pushCriteriaToP,
  createMatchActivity,
  // Archive
  archiveDeal,
  // Webhook registration
  registerWebhooks,
};
