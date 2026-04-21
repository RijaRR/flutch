'use strict';

/**
 * Fonctions de sécurité utilitaires.
 * FIX Audit 1.3 — Suppression des fonctions mortes (escapeSqlLike, isSafeString, isValidEmail)
 * qui n'étaient appelées nulle part. Seul isBlockedHost est utilisé.
 */

const PRIVATE_RANGES_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\./,
  /^224\./,
  /^240\./,
];

/**
 * Indique si une IP/hostname pointe vers un réseau privé/local.
 * @param {string|null|undefined} hostname
 * @returns {boolean}
 */
function isBlockedHost(hostname) {
  if (!hostname) return true;
  const h = String(hostname).toLowerCase().trim();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '[::1]') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h.startsWith('fe80')) return true;
  if (h.startsWith('::ffff:')) return isBlockedHost(h.replace('::ffff:', ''));
  // Metadata endpoints cloud
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  return PRIVATE_RANGES_V4.some((re) => re.test(h));
}

module.exports = { isBlockedHost };
