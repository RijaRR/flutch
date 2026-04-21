'use strict';

const { normalizeDpeLabel, parseDpeCriteria, dpeMatchesCriteria } = require('../db');

describe('DPE matching', () => {
  test('normalise les formats courants de DPE', () => {
    expect(normalizeDpeLabel('b')).toBe('B');
    expect(normalizeDpeLabel('Classe F')).toBe('F');
    expect(normalizeDpeLabel('DPE : A')).toBe('A');
  });

  test('parse un critère multi-valeurs', () => {
    expect(parseDpeCriteria('A ou B')).toEqual(['A', 'B']);
  });

  test('refuse un bien F pour un acquéreur exigeant A ou B', () => {
    expect(dpeMatchesCriteria('F', 'A ou B')).toBe(false);
  });

  test('accepte un bien A pour un acquéreur exigeant A ou B', () => {
    expect(dpeMatchesCriteria('A', 'A ou B')).toBe(true);
  });

  test('refuse un DPE inconnu quand un critère DPE est exigé', () => {
    expect(dpeMatchesCriteria(null, 'A ou B')).toBe(false);
  });
});
