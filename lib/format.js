'use strict';

/**
 * @typedef {Object} Bien
 * @property {number|string} id
 * @property {string} [title]
 * @property {number} [prix]
 * @property {number} [rendement]
 * @property {string} [ville]
 */

/**
 * @typedef {Object} Acquereur
 * @property {number|string} id
 * @property {string} [name]
 * @property {string} [email]
 * @property {string} [phone]
 */

/**
 * Échappe les caractères HTML dangereux.
 * @param {unknown} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formate un prix en euros (format français).
 * @param {number|string|null|undefined} v
 * @returns {string}
 */
function formatPrice(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(n) + ' €';
}

/**
 * Formate un pourcentage (1 décimale).
 * @param {number|string|null|undefined} v
 * @returns {string}
 */
function formatPercent(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(1).replace('.', ',') + ' %';
}

/**
 * Formate une date au format JJ/MM/AAAA.
 * @param {Date|string|number|null|undefined} d
 * @returns {string}
 */
function formatDateFR(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yy = date.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

/**
 * Normalise un téléphone au format E.164 (FR par défaut).
 * @param {string|null|undefined} phone
 * @returns {string}
 */
function formatPhoneE164(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('33')) return '+' + digits;
  if (digits.startsWith('0')) return '+33' + digits.substring(1);
  return '+' + digits;
}

/**
 * Calcule le retard en jours par rapport à aujourd'hui.
 * @param {Date|string|number} dateRef
 * @param {Date} [now=new Date()]
 * @returns {number} Nombre de jours (négatif si futur).
 */
function calculateDelayDays(dateRef, now = new Date()) {
  const ref = dateRef instanceof Date ? dateRef : new Date(dateRef);
  if (Number.isNaN(ref.getTime())) return 0;
  const diffMs = now.getTime() - ref.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

module.exports = {
  escapeHtml,
  formatPrice,
  formatPercent,
  formatDateFR,
  formatPhoneE164,
  calculateDelayDays,
};
