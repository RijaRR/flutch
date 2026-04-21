'use strict';

/**
 * Client HTTP pour l'API Pipedrive.
 * Centralise pdGet, pdPut, pdPost avec gestion des retries.
 */

const fetch = require('node-fetch');
const { withRetry } = require('../lib/retry');

const PIPEDRIVE_BASE = 'https://api.pipedrive.com/v1';

function isRetryablePdError(err) {
  if (!err) return false;
  const m = String(err.message || '');
  if (/Pipedrive (5\d\d|429|408)/.test(m)) return true;
  if (/ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|ECONNREFUSED/.test(m)) return true;
  return false;
}

async function pdGet(path, apiToken) {
  const sep = path.includes('?') ? '&' : '?';
  return withRetry(async () => {
    const res = await fetch(`${PIPEDRIVE_BASE}${path}${sep}api_token=${apiToken}`);
    if (!res.ok) throw new Error(`Pipedrive ${res.status}: ${path}`);
    return res.json();
  }, { retries: 3, label: `pdGet ${path.split('?')[0]}`, shouldRetry: isRetryablePdError });
}

async function pdPut(path, body, apiToken) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${PIPEDRIVE_BASE}${path}${sep}api_token=${apiToken}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function pdPost(path, body, apiToken) {
  const res = await fetch(`${PIPEDRIVE_BASE}${path}?api_token=${apiToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

module.exports = { pdGet, pdPut, pdPost, PIPEDRIVE_BASE };
