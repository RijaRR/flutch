'use strict';

const fetch = require('node-fetch');
const sanitizeHtml = require('sanitize-html');
const config = require('../config');
const { logger } = require('../lib/logger');
const { withRetry } = require('../lib/retry');
const {
  escapeHtml,
  formatPhoneE164,
  buildBienCard,
  buildSMSText,
} = require('./templates');

// FIX Audit 3.8 — Politique de sanitisation stricte pour le HTML des emails personnalisés
const SANITIZE_OPTIONS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img', 'style', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'hr', 'br', 'b', 'i', 'u', 'strong', 'em', 'font', 'center',
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor'],
    img: ['src', 'alt', 'width', 'height', 'style'],
    a: ['href', 'target', 'style'],
    font: ['color', 'size', 'face'],
    td: ['colspan', 'rowspan', 'style', 'width', 'height', 'bgcolor', 'align', 'valign'],
    th: ['colspan', 'rowspan', 'style', 'width', 'height', 'bgcolor', 'align', 'valign'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Bloque tous les handlers d'événements et javascript:
  disallowedTagsMode: 'discard',
};

const BREVO_API = 'https://api.brevo.com/v3';

class BrevoConfigError extends Error {
  constructor() {
    super('BREVO_API_KEY non configurée');
    this.statusCode = 500;
    this.code = 'BREVO_NOT_CONFIGURED';
  }
}

function requireBrevoKey() {
  if (!config.BREVO_API_KEY) throw new BrevoConfigError();
  return config.BREVO_API_KEY;
}

/**
 * Cache des évènements Brevo par email (TTL config.BREVO_CACHE_TTL_MS).
 * FIX Audit Phase 4 — Cache borné (LRU) pour éviter une fuite mémoire.
 * @type {Map<string, { ts: number, events: unknown[] }>}
 */
const BREVO_CACHE_MAX = 500;
const brevoEventsCache = new Map();

function isRetryableHttpError(err) {
  const m = String(err && err.message || '');
  return /\b(5\d\d|429|408)\b/.test(m) || /ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(m);
}

/**
 * Envoie un SMS transactionnel Brevo.
 * @param {Record<string, unknown>} acq
 * @param {Array<Record<string, unknown>>} biens
 * @returns {Promise<unknown>}
 */
async function sendBrevoSMS(acq, biens) {
  const key = requireBrevoKey();
  const phone = formatPhoneE164(acq.contact_phone);
  if (!phone) throw new Error('Numéro de téléphone invalide');
  const content = buildSMSText(acq, biens);

  return withRetry(async () => {
    const response = await fetch(`${BREVO_API}/transactionalSMS/sms`, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'transactional',
        unicodeEnabled: true,
        sender: 'Boutiquier',
        recipient: phone,
        content,
      }),
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Brevo SMS ${response.status}: ${errBody}`);
    }
    return response.json();
  }, { retries: 2, label: 'brevo SMS', shouldRetry: isRetryableHttpError });
}

/**
 * Construit le HTML d'email standard de prospection.
 * @param {Record<string, unknown>} acq
 * @param {Array<Record<string, unknown>>} biens
 * @returns {{ subject: string, html: string }}
 */
function buildStandardEmail(acq, biens) {
  const contactName = acq.contact_name || acq.titre || '';
  const ownerName = acq.owner_name || 'Le Boutiquier';
  const ownerEmail = acq.owner_email || 'contact@leboutiquier.fr';
  const bienCards = biens.map((b, i) => buildBienCard(b, i + 1)).join('');
  const nbBiens = biens.length;

  const subject = nbBiens === 1
    ? `[LE BOUTIQUIER] - ${biens[0].titre || 'Nouveau bien'} correspondant à vos critères`
    : `[LE BOUTIQUIER] - sélections de plusieurs correspondant à vos critères`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"/></head>
    <body style="font-family:Arial,Helvetica,sans-serif;color:#333;max-width:700px;margin:0 auto;padding:20px;">
      <p>Bonjour ${escapeHtml(contactName)},</p>
      <p>Je vous propose <span style="color:#d6336c;font-weight:bold;">${nbBiens} bien${nbBiens > 1 ? 's' : ''}</span> correspondant à vos critères de recherche :</p>
      ${bienCards}
      <div style="border-top:1px solid #ddd;margin:30px 0 20px;padding-top:20px;">
        <p style="font-size:13px;color:#666;">
          Vous avez reçu ce dossier en amont, car vous êtes un client de l'agence Le Boutiquier.<br/>
          Aidez nous en laissant votre avis ici (6 secondes max)
          <a href="https://g.page/r/CbPH4cxV4HUREBI/review" style="color:#d6336c;">[Lien vers Avis]</a>
        </p>
      </div>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0;"/>
      <p>Cordialement,</p>
      <p style="color:#d6336c;font-weight:bold;font-size:16px;">${escapeHtml(ownerName)}</p>
      <p style="color:#666;font-size:13px;">${escapeHtml(ownerEmail)}</p>
    </body>
    </html>
  `;
  return { subject, html };
}

/**
 * Envoie l'email de prospection standard.
 * @param {Record<string, unknown>} acq
 * @param {Array<Record<string, unknown>>} biens
 * @returns {Promise<{messageId?: string}>}
 */
async function sendBrevoEmail(acq, biens) {
  const key = requireBrevoKey();
  const { subject, html } = buildStandardEmail(acq, biens);
  const ownerName = acq.owner_name || 'Le Boutiquier';
  const ownerEmail = acq.owner_email || 'contact@leboutiquier.fr';
  const contactName = acq.contact_name || acq.titre || '';
  const bcc = `leboutiquier+deal${acq.pipedrive_deal_id}@pipedriveemail.com`;

  return withRetry(async () => {
    const response = await fetch(`${BREVO_API}/smtp/email`, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: `${ownerName} - Le Boutiquier`, email: ownerEmail },
        replyTo: { email: ownerEmail, name: ownerName },
        to: [{ email: acq.contact_email, name: contactName }],
        bcc: [{ email: bcc }],
        subject,
        htmlContent: html,
      }),
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Brevo ${response.status}: ${errBody}`);
    }
    return response.json();
  }, { retries: 2, label: 'brevo email', shouldRetry: isRetryableHttpError });
}

/**
 * Envoie un email entièrement personnalisé (intro/outro/HTML personnalisé).
 * @param {Record<string, unknown>} acq
 * @param {Array<Record<string, unknown>>} biens
 * @param {{ subject: string, intro: string, outro: string, bienHtml?: string }} opts
 * @returns {Promise<{messageId?: string}>}
 */
async function sendBrevoCustomEmail(acq, biens, opts) {
  const key = requireBrevoKey();
  const ownerName = acq.owner_name || 'Le Boutiquier';
  const ownerEmail = acq.owner_email || 'contact@leboutiquier.fr';
  const contactName = acq.contact_name || acq.titre || '';

  // FIX Audit 3.8 — Remplacement de la sanitisation regex contournable par sanitize-html
  let bienCards;
  if (opts.bienHtml && typeof opts.bienHtml === 'string') {
    bienCards = sanitizeHtml(opts.bienHtml, SANITIZE_OPTIONS);
  } else {
    bienCards = biens.map((b, i) => buildBienCard(b, i + 1)).join('');
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
    <body style="font-family:Arial,Helvetica,sans-serif;color:#333;max-width:700px;margin:0 auto;padding:20px;">
      <p>${escapeHtml(opts.intro || '').replace(/\n/g, '<br/>')}</p>
      ${bienCards}
      <div style="border-top:1px solid #ddd;margin:30px 0 20px;padding-top:20px;">
        <p style="font-size:13px;color:#666;">
          Vous avez reçu ce dossier en amont, car vous êtes un client de l'agence Le Boutiquier.<br/>
          Aidez nous en laissant votre avis ici (6 secondes max)
          <a href="https://g.page/r/CbPH4cxV4HUREBI/review" style="color:#d6336c;">[Lien vers Avis]</a>
        </p>
      </div>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0;"/>
      <p>${escapeHtml(opts.outro || '').replace(/\n/g, '<br/>')}</p>
      <p style="color:#666;font-size:13px;">${escapeHtml(ownerEmail)}</p>
    </body></html>`;

  const bcc = `leboutiquier+deal${acq.pipedrive_deal_id}@pipedriveemail.com`;

  return withRetry(async () => {
    const response = await fetch(`${BREVO_API}/smtp/email`, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: `${ownerName} - Le Boutiquier`, email: ownerEmail },
        replyTo: { email: ownerEmail, name: ownerName },
        to: [{ email: acq.contact_email, name: contactName }],
        bcc: [{ email: bcc }],
        subject: opts.subject,
        htmlContent: html,
      }),
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Brevo ${response.status}: ${errBody}`);
    }
    return response.json();
  }, { retries: 2, label: 'brevo custom email', shouldRetry: isRetryableHttpError });
}

/**
 * Envoie un email de signalement de bug (interne).
 * @param {{ userName: string, userEmail: string, note?: string, screenshot?: string }} payload
 * @returns {Promise<unknown>}
 */
async function sendBugReportEmail({ userName, userEmail, note, screenshot }) {
  const key = requireBrevoKey();
  const imgTag = screenshot
    ? `<div style="margin:16px 0"><img src="${escapeHtml(screenshot)}" style="max-width:100%;border:2px solid #d6336c;border-radius:8px;" alt="Capture"></div>`
    : '';
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:linear-gradient(135deg,#4a1942,#d6336c);padding:16px 24px;border-radius:12px 12px 0 0">
        <h2 style="color:#fff;margin:0">🐛 Signalement — Le Flutch</h2>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #eee;border-radius:0 0 12px 12px">
        <p><strong>De :</strong> ${escapeHtml(userName)} (${escapeHtml(userEmail)})</p>
        <p><strong>Date :</strong> ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</p>
        <p><strong>Note :</strong></p>
        <div style="background:#f8f9fa;padding:12px 16px;border-radius:8px;border-left:4px solid #d6336c;margin:8px 0">${escapeHtml(note || 'Aucune note').replace(/\n/g, '<br>')}</div>
        ${imgTag}
      </div>
    </div>`;
  return fetch(`${BREVO_API}/smtp/email`, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Le Flutch — Bug Report', email: 'daniel@leboutiquier.fr' },
      to: [{ email: 'daniel@leboutiquier.fr', name: 'Daniel' }],
      subject: `🐛 Bug signalé par ${userName} — Le Flutch`,
      htmlContent,
    }),
  });
}

/**
 * Vérifie la validité de la clé Brevo en interrogeant /account.
 * @returns {Promise<void>}
 */
async function sendSetupPasswordEmail({ name, email, link, fromName, fromEmail }) {
  const key = requireBrevoKey();
  const senderName = fromName ? `${fromName} - Le Boutiquier` : 'Le Flutch';
  const senderEmail = fromEmail || 'daniel@leboutiquier.fr';
  const safeName = escapeHtml(name || 'Bonjour');
  const safeLink = escapeHtml(link);
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:linear-gradient(135deg,#4a1942,#d6336c);padding:20px 24px;border-radius:12px 12px 0 0">
        <h2 style="color:#fff;margin:0;font-size:22px">Bienvenue sur Le Flutch</h2>
      </div>
      <div style="background:#fff;padding:28px 24px;border:1px solid #eee;border-radius:0 0 12px 12px">
        <p style="font-size:15px;color:#2C3E50;margin:0 0 16px">Bonjour ${safeName},</p>
        <p style="font-size:15px;color:#2C3E50;line-height:1.6;margin:0 0 20px">
          Ton compte agent vient d'être créé sur <strong>Le Flutch</strong>, le moteur de matching immobilier de l'agence.
          Pour démarrer, choisis ton mot de passe en cliquant sur le bouton ci-dessous :
        </p>
        <div style="text-align:center;margin:28px 0">
          <a href="${safeLink}" style="display:inline-block;background:#d6336c;color:#fff;padding:14px 32px;border-radius:10px;font-weight:700;font-size:16px;text-decoration:none">
            Choisir mon mot de passe
          </a>
        </div>
        <p style="font-size:13px;color:#7F8C8D;line-height:1.6;margin:20px 0 0">
          Ce lien est <strong>valable 7 jours</strong> et utilisable une seule fois.<br>
          Si le bouton ne fonctionne pas, copie-colle cette adresse dans ton navigateur :<br>
          <span style="word-break:break-all;color:#d6336c">${safeLink}</span>
        </p>
        <p style="font-size:12px;color:#7F8C8D;margin:24px 0 0;border-top:1px solid #eee;padding-top:14px">
          Tu n'attendais pas ce message ? Ignore-le simplement, aucun compte ne sera activé sans ton mot de passe.
        </p>
      </div>
    </div>`;
  const response = await fetch(`${BREVO_API}/smtp/email`, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email, name: name || email }],
      replyTo: { email: senderEmail, name: senderName },
      subject: 'Bienvenue sur Le Flutch — choisis ton mot de passe',
      htmlContent,
    }),
  });
  if (!response.ok) {
    const errBody = await response.text();
    const e = new Error(`Brevo email échoué: ${errBody}`);
    e.statusCode = response.status;
    throw e;
  }
  return response.json().catch(() => ({}));
}

async function verifyBrevoAccount() {
  const key = requireBrevoKey();
  const accountCheck = await fetch(`${BREVO_API}/account`, {
    headers: { 'api-key': key, 'accept': 'application/json' },
  });
  if (!accountCheck.ok) {
    const err = await accountCheck.text();
    const e = new Error(`Clé Brevo invalide: ${err}`);
    e.statusCode = 500;
    throw e;
  }
}

/**
 * Récupère les évènements Brevo pour un email (avec cache).
 * @param {string} email
 * @param {number} [limit=50]
 * @returns {Promise<unknown[]>}
 */
async function fetchBrevoEvents(email, limit = 50) {
  const key = requireBrevoKey();
  const cached = brevoEventsCache.get(email);
  if (cached && Date.now() - cached.ts < config.BREVO_CACHE_TTL_MS) return cached.events;

  const response = await fetch(
    `${BREVO_API}/smtp/statistics/events?limit=${limit}&email=${encodeURIComponent(email)}&sort=desc`,
    { headers: { 'accept': 'application/json', 'api-key': key } }
  );
  if (!response.ok) {
    const errBody = await response.text();
    const e = new Error(errBody);
    e.statusCode = response.status;
    throw e;
  }
  const data = await response.json();
  const events = data.events || [];

  // FIX Audit Phase 4 — Éviction LRU : supprimer les entrées expirées puis les plus anciennes
  if (brevoEventsCache.size >= BREVO_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of brevoEventsCache) {
      if (now - v.ts > config.BREVO_CACHE_TTL_MS) brevoEventsCache.delete(k);
    }
    // Si toujours plein, supprimer le plus ancien (FIFO Map order)
    if (brevoEventsCache.size >= BREVO_CACHE_MAX) {
      const firstKey = brevoEventsCache.keys().next().value;
      brevoEventsCache.delete(firstKey);
    }
  }
  brevoEventsCache.set(email, { ts: Date.now(), events });
  return events;
}

module.exports = {
  BrevoConfigError,
  sendBrevoSMS,
  sendBrevoEmail,
  sendBrevoCustomEmail,
  sendBugReportEmail,
  sendSetupPasswordEmail,
  verifyBrevoAccount,
  fetchBrevoEvents,
};

// Mark logger as referenced for clarity (used indirectly through retry).
void logger;
