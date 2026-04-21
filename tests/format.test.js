'use strict';

const {
  escapeHtml,
  formatPrice,
  formatPercent,
  formatDateFR,
  formatPhoneE164,
  calculateDelayDays,
} = require('../lib/format');

describe('escapeHtml', () => {
  test('échappe les caractères HTML dangereux', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
    );
  });
  test('gère null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
  test('échappe les apostrophes et &', () => {
    expect(escapeHtml("Tom & Jerry's")).toBe('Tom &amp; Jerry&#39;s');
  });
});

describe('formatPrice', () => {
  test('formate un nombre en euros', () => {
    expect(formatPrice(150000)).toMatch(/150[\s\u00a0]000\s?€/);
  });
  test('retourne — pour valeur invalide', () => {
    expect(formatPrice(null)).toBe('—');
    expect(formatPrice('abc')).toBe('—');
    expect(formatPrice('')).toBe('—');
  });
});

describe('formatPercent', () => {
  test('formate avec virgule française', () => {
    expect(formatPercent(7.5)).toBe('7,5 %');
    expect(formatPercent(10)).toBe('10,0 %');
  });
  test('— si invalide', () => {
    expect(formatPercent(undefined)).toBe('—');
  });
});

describe('formatDateFR', () => {
  test('formate JJ/MM/AAAA', () => {
    expect(formatDateFR(new Date('2026-04-17T10:00:00Z'))).toBe('17/04/2026');
  });
  test('— si invalide', () => {
    expect(formatDateFR('not a date')).toBe('—');
    expect(formatDateFR(null)).toBe('—');
  });
});

describe('formatPhoneE164', () => {
  test('numéro français commençant par 0', () => {
    expect(formatPhoneE164('06 12 34 56 78')).toBe('+33612345678');
  });
  test('numéro déjà avec 33', () => {
    expect(formatPhoneE164('33612345678')).toBe('+33612345678');
  });
  test('vide si null', () => {
    expect(formatPhoneE164(null)).toBe('');
    expect(formatPhoneE164('')).toBe('');
  });
});

describe('calculateDelayDays', () => {
  test('retourne le nombre de jours écoulés', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const past = new Date('2026-04-10T12:00:00Z');
    expect(calculateDelayDays(past, now)).toBe(7);
  });
  test('valeur négative si date future', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    const future = new Date('2026-04-20T12:00:00Z');
    expect(calculateDelayDays(future, now)).toBe(-3);
  });
  test('0 si date invalide', () => {
    expect(calculateDelayDays('garbage')).toBe(0);
  });
});
