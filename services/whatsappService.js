'use strict';

const fetch = require('node-fetch');
const config = require('../config');

class WhatsAppNotConfiguredError extends Error {
  constructor() {
    super('WhatsApp non configuré. Variables WHATSAPP_TOKEN et WHATSAPP_PHONE_ID requises.');
    this.statusCode = 500;
  }
}

/**
 * Traduit un payload d'erreur WhatsApp en message lisible.
 * @param {number} status
 * @param {string} errBody
 * @param {string} contactPhone
 * @returns {string}
 */
function translateWhatsAppError(status, errBody, contactPhone) {
  let msg = `Erreur WhatsApp (${status})`;
  try {
    const errJson = JSON.parse(errBody);
    const code = errJson?.error?.code;
    if (status === 401 || code === 190) msg = 'Token WhatsApp invalide ou expiré. Vérifiez le secret WHATSAPP_TOKEN.';
    else if (code === 131030) msg = `Le numéro ${contactPhone} n'est pas enregistré sur WhatsApp.`;
    else if (code === 131047) msg = "Vous devez d'abord envoyer un template — le destinataire n'a pas initié de conversation (fenêtre 24h expirée).";
    else if (code === 131026) msg = `Numéro invalide pour WhatsApp : ${contactPhone}`;
    else if (code === 100) msg = 'Paramètre invalide. Vérifiez PHONE_NUMBER_ID dans les secrets.';
    else msg = errJson?.error?.message || msg;
  } catch (_) {}
  return msg;
}

/**
 * Envoie un message WhatsApp texte via la Cloud API Meta.
 * @param {string} phoneE164NoPlus - Numéro sans le "+" (ex: 33612345678)
 * @param {string} message
 * @param {string} [contactPhoneOriginal=''] - Pour traduire les erreurs
 * @returns {Promise<{messageId: string|null}>}
 */
async function sendWhatsAppMessage(phoneE164NoPlus, message, contactPhoneOriginal = '') {
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_ID) throw new WhatsAppNotConfiguredError();

  const response = await fetch(`https://graph.facebook.com/v19.0/${config.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phoneE164NoPlus,
      type: 'text',
      text: { body: message },
    }),
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(translateWhatsAppError(response.status, errBody, contactPhoneOriginal));
  }
  const result = await response.json();
  return { messageId: result?.messages?.[0]?.id || null };
}

module.exports = { sendWhatsAppMessage, WhatsAppNotConfiguredError };
