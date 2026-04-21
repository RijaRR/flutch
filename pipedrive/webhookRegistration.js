'use strict';

/**
 * Enregistrement automatique des webhooks Pipedrive.
 */

const fetch = require('node-fetch');
const { logger } = require('../lib/logger');
const { pdGet, pdPost } = require('./client');

async function registerWebhooks(apiToken, baseUrl, webhookSecret) {
  const webhookUrl = baseUrl + '/api/webhook/pipedrive?token=' + webhookSecret;
  const webhookUrlBase = baseUrl + '/api/webhook/pipedrive';
  try {
    const existing = await pdGet('/webhooks', apiToken);
    const hooks = existing?.data || [];
    const oldHooks = hooks.filter(h => h.subscription_url?.includes('/api/webhook/pipedrive') && h.is_active);
    for (const h of oldHooks) {
      if (h.subscription_url === webhookUrl) {
        logger.info(`✅ Webhook Pipedrive déjà enregistré (id: ${h.id})`);
        return h.id;
      }
      try {
        await fetch(`https://api.pipedrive.com/v1/webhooks/${h.id}?api_token=${apiToken}`, { method: 'DELETE' });
        logger.info(`🗑️ Ancien webhook supprimé (id: ${h.id})`);
      } catch (e) {}
    }
    const res = await pdPost('/webhooks', {
      subscription_url: webhookUrl, event_action: '*', event_object: 'deal',
    }, apiToken);
    if (res?.data?.id) {
      logger.info(`✅ Webhook Pipedrive enregistré (id: ${res.data.id}) → ${webhookUrlBase}`);
      return res.data.id;
    } else {
      return null;
    }
  } catch (e) {
    logger.error('❌ Erreur enregistrement webhook:', e.message);
    return null;
  }
}

module.exports = { registerWebhooks };
