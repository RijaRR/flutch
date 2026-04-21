'use strict';

/**
 * Tests des schémas Zod — validation des entrées utilisateur.
 */
const {
  createUserSchema,
  setupPasswordSchema,
  updateAcquereurCriteriaSchema,
  createTodoSchema,
  bulkTodoSchema,
  enqueueEmailSchema,
  updateUserRoleSchema,
  updateUserPasswordSchema,
  formatPhoneE164,
} = require('../../schemas');

describe('createUserSchema', () => {
  test('accepte un utilisateur valide avec mot de passe fort', () => {
    const result = createUserSchema.safeParse({
      name: 'Test User',
      email: 'test@example.com',
      password: 'SecurePass1',
      role: 'agent',
    });
    expect(result.success).toBe(true);
  });

  test('refuse un mot de passe trop court (< 10 caractères)', () => {
    const result = createUserSchema.safeParse({
      name: 'Test User',
      email: 'test@example.com',
      password: 'Short1',
    });
    expect(result.success).toBe(false);
  });

  test('refuse un mot de passe sans chiffre', () => {
    const result = createUserSchema.safeParse({
      name: 'Test User',
      email: 'test@example.com',
      password: 'NoDigitsHere',
    });
    expect(result.success).toBe(false);
  });

  test('refuse un mot de passe sans lettre', () => {
    const result = createUserSchema.safeParse({
      name: 'Test User',
      email: 'test@example.com',
      password: '1234567890',
    });
    expect(result.success).toBe(false);
  });

  test('accepte un utilisateur sans mot de passe (setup link)', () => {
    const result = createUserSchema.safeParse({
      name: 'Test User',
      email: 'test@example.com',
    });
    expect(result.success).toBe(true);
  });

  test('accepte le rôle manager', () => {
    const result = createUserSchema.safeParse({
      name: 'Test',
      email: 'a@b.com',
      role: 'manager',
    });
    expect(result.success).toBe(true);
  });

  test('refuse un rôle invalide', () => {
    const result = createUserSchema.safeParse({
      name: 'Test',
      email: 'a@b.com',
      role: 'superadmin',
    });
    expect(result.success).toBe(false);
  });

  test('refuse un email invalide', () => {
    const result = createUserSchema.safeParse({
      name: 'Test',
      email: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });

  test('refuse un nom vide', () => {
    const result = createUserSchema.safeParse({
      name: '',
      email: 'a@b.com',
    });
    expect(result.success).toBe(false);
  });
});

describe('setupPasswordSchema', () => {
  test('accepte un token hex 64 + mot de passe fort', () => {
    const result = setupPasswordSchema.safeParse({
      token: 'a'.repeat(64),
      password: 'StrongPass123',
    });
    expect(result.success).toBe(true);
  });

  test('refuse un token trop court', () => {
    const result = setupPasswordSchema.safeParse({
      token: 'abc123',
      password: 'StrongPass123',
    });
    expect(result.success).toBe(false);
  });

  test('refuse un mot de passe faible', () => {
    const result = setupPasswordSchema.safeParse({
      token: 'a'.repeat(64),
      password: 'short',
    });
    expect(result.success).toBe(false);
  });
});

describe('updateAcquereurCriteriaSchema', () => {
  test('accepte des critères valides', () => {
    const result = updateAcquereurCriteriaSchema.safeParse({
      budget_min: 100000,
      budget_max: 500000,
      rentabilite_min: 5,
    });
    expect(result.success).toBe(true);
  });

  test('refuse budget_min > budget_max', () => {
    const result = updateAcquereurCriteriaSchema.safeParse({
      budget_min: 500000,
      budget_max: 100000,
    });
    expect(result.success).toBe(false);
  });

  test('accepte des budgets null', () => {
    const result = updateAcquereurCriteriaSchema.safeParse({
      budget_min: null,
      budget_max: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('createTodoSchema', () => {
  test('accepte un todo valide', () => {
    const result = createTodoSchema.safeParse({ acquereur_id: 1, bien_id: 2 });
    expect(result.success).toBe(true);
  });

  test('refuse un id négatif', () => {
    const result = createTodoSchema.safeParse({ acquereur_id: -1, bien_id: 2 });
    expect(result.success).toBe(false);
  });
});

describe('bulkTodoSchema', () => {
  test('accepte un bulk todo valide', () => {
    const result = bulkTodoSchema.safeParse({
      acquereur_id: 1,
      bien_ids: [1, 2, 3],
      statut: 'envoye',
    });
    expect(result.success).toBe(true);
  });

  test('refuse un tableau vide de bien_ids', () => {
    const result = bulkTodoSchema.safeParse({
      acquereur_id: 1,
      bien_ids: [],
      statut: 'envoye',
    });
    expect(result.success).toBe(false);
  });

  test('refuse un statut invalide', () => {
    const result = bulkTodoSchema.safeParse({
      acquereur_id: 1,
      bien_ids: [1],
      statut: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});

describe('enqueueEmailSchema', () => {
  test('accepte une requête email valide', () => {
    const result = enqueueEmailSchema.safeParse({
      acquereur_id: 1,
      bien_ids: [1, 2],
      channel: 'email',
    });
    expect(result.success).toBe(true);
  });

  test('refuse un channel invalide', () => {
    const result = enqueueEmailSchema.safeParse({
      acquereur_id: 1,
      bien_ids: [1],
      channel: 'telegram',
    });
    expect(result.success).toBe(false);
  });
});

describe('updateUserRoleSchema', () => {
  test('accepte les rôles valides', () => {
    for (const role of ['admin', 'manager', 'agent']) {
      const result = updateUserRoleSchema.safeParse({ role });
      expect(result.success).toBe(true);
    }
  });

  test('refuse un rôle invalide', () => {
    const result = updateUserRoleSchema.safeParse({ role: 'superuser' });
    expect(result.success).toBe(false);
  });
});

describe('updateUserPasswordSchema', () => {
  test('accepte un mot de passe fort', () => {
    const result = updateUserPasswordSchema.safeParse({ password: 'StrongPass123' });
    expect(result.success).toBe(true);
  });

  test('refuse un mot de passe faible', () => {
    const result = updateUserPasswordSchema.safeParse({ password: 'weak' });
    expect(result.success).toBe(false);
  });
});

describe('formatPhoneE164', () => {
  test('normalise un numéro français 06', () => {
    expect(formatPhoneE164('06 12 34 56 78')).toBe('+33612345678');
  });

  test('conserve un numéro E.164 valide', () => {
    expect(formatPhoneE164('+33612345678')).toBe('+33612345678');
  });

  test('convertit un numéro avec 00', () => {
    expect(formatPhoneE164('0033612345678')).toBe('+33612345678');
  });

  test('retourne null pour une valeur vide', () => {
    expect(formatPhoneE164('')).toBeNull();
    expect(formatPhoneE164(null)).toBeNull();
    expect(formatPhoneE164(undefined)).toBeNull();
  });
});
