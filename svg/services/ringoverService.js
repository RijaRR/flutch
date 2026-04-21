'use strict';

/**
 * Client Ringover SMS — envoi depuis le numéro propre de chaque négociateur.
 * Endpoint utilisé : POST https://public-api.ringover.com/v2/push/sms
 * Doc : https://developer.ringover.com/#tag/sms
 */

const fetch = require('node-fetch');
const config = require('../config');
const { logger } = require('../lib/logger');
const { withRetry } = require('../lib/retry');
const { buildSMSText, formatPhoneE164 } = require('./templates');

const RINGOVER_BASE_URL = 'https://public-api.ringover.com/v2';

class RingoverConfigError extends Error {
  constructor() {
    super('RINGOVER_API_KEY non configurée');
    this.statusCode = 500;
    this.code = 'RINGOVER_NOT_CONFIGURED';
  }
}

function requireRingoverKey() {
  if (!config.RINGOVER_API_KEY) throw new RingoverConfigError();
  return config.RINGOVER_API_KEY;
}

function isRetryableHttpError(err) {
  const m = String((err && err.message) || '');
  return /\b(5\d\d|429|408)\b/.test(m) || /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(m);
}

/**
 * Envoie un SMS via Ringover depuis le numéro d'un négociateur.
 * @param {string} fromNumber Numéro Ringover du négo, format E.164 (ex: +33612345678).
 * @param {string} toNumber Numéro du destinataire, format E.164.
 * @param {string} message Contenu du SMS.
 * @param {number|null} [userIdForced=null] Ringover user ID du négo (optionnel).
 * @returns {Promise<{message_id?: number, conv_id?: number}>}
 */
async function sendSMS(fromNumber, toNumber, message, userIdForced = null) {
  const key = requireRingoverKey();
  const body = {
    archived_auto: false,
    from_number: fromNumber,
    to_number: toNumber,
    content: message,
  };
  if (userIdForced) body.user_id_forced = Number(userIdForced);

  return withRetry(async () => {
    const response = await fetch(`${RINGOVER_BASE_URL}/push/sms`, {
      method: 'POST',
      headers: {
        Authorization: key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Ringover SMS ${response.status}: ${errBody}`);
    }
    const data = await response.json().catch(() => ({}));
    logger.info(`📱 Ringover : ${fromNumber} → ${toNumber} (message_id: ${data.message_id || '?'})`);
    return data;
  }, { retries: 2, label: `ringover SMS → ${toNumber}`, shouldRetry: isRetryableHttpError });
}

/**
 * Envoie un SMS de prospection à un acquéreur, depuis le numéro de SON négociateur.
 * @param {Record<string, unknown>} acquereur Doit contenir `contact_phone`.
 * @param {Record<string, unknown>} nego Doit contenir `ringover_number` ; `ringover_user_id` optionnel.
 * @param {Array<Record<string, unknown>>} biens Liste de biens à inclure dans le SMS.
 * @returns {Promise<{message_id?: number}|null>}
 */
async function sendDealSMS(acquereur, nego, biens) {
  if (!nego || !nego.ringover_number) {
    logger.warn(`Ringover : négo "${nego?.name || nego?.email || nego?.id || '?'}" sans numéro Ringover, SMS non envoyé`);
    return null;
  }
  if (!acquereur || !acquereur.contact_phone) {
    logger.warn(`Ringover : acquéreur #${acquereur?.id || '?'} sans téléphone, SMS non envoyé`);
    return null;
  }

  const fromNumber = formatPhoneE164(nego.ringover_number) || nego.ringover_number;
  const toNumber = formatPhoneE164(acquereur.contact_phone);
  if (!toNumber) {
    throw new Error(`Numéro de téléphone destinataire invalide : "${acquereur.contact_phone}"`);
  }

  const message = buildSMSText(acquereur, biens);
  return sendSMS(fromNumber, toNumber, message, nego.ringover_user_id || null);
}

module.exports = {
  RingoverConfigError,
  sendSMS,
  sendDealSMS,
};
