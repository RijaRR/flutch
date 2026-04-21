'use strict';

const { z } = require('zod');

const email = z.string().trim().toLowerCase().email('Email invalide');
const positiveInt = z.coerce.number().int().positive('Doit être un entier positif');
const nonNegativeNumber = z.coerce.number().nonnegative('Doit être un nombre positif ou nul');
const optionalNonNegativeNumber = z
  .union([z.literal(''), z.null(), z.undefined(), nonNegativeNumber])
  .transform((v) => (v === '' || v == null ? null : Number(v)))
  .nullable();

const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Nom requis'),
  email,
  password: z
    .string()
    .min(10, 'Mot de passe : 10 caractères minimum')
    .max(200, 'Mot de passe trop long')
    .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), {
      message: 'Doit contenir au moins une lettre et un chiffre',
    })
    .optional()
    .or(z.literal('')),
  role: z.enum(['admin', 'manager', 'agent']).optional(),
  send_setup_link: z.boolean().optional(),
});

const strongPassword = z
  .string()
  .min(10, 'Mot de passe : 10 caractères minimum')
  .max(200, 'Mot de passe trop long')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), {
    message: 'Doit contenir au moins une lettre et un chiffre',
  });

const updateUserRoleSchema = z.object({
  role: z.enum(['admin', 'manager', 'agent']),
});

const updateUserPasswordSchema = z.object({
  password: strongPassword,
});

const setupPasswordSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/i, 'Token invalide'),
  password: strongPassword,
});

const updateAcquereurCriteriaSchema = z
  .object({
    budget_min: optionalNonNegativeNumber,
    budget_max: optionalNonNegativeNumber,
    rentabilite_min: optionalNonNegativeNumber,
    occupation_status: z.union([z.array(z.string()), z.null()]).optional(),
    secteurs: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
  })
  .refine(
    (d) => d.budget_min == null || d.budget_max == null || d.budget_min <= d.budget_max,
    { message: 'budget_min doit être ≤ budget_max', path: ['budget_min'] }
  );

const createTodoSchema = z.object({
  acquereur_id: positiveInt,
  bien_id: positiveInt,
  statut: z.enum(['non_traite', 'envoye', 'refuse']).optional(),
});

const bulkTodoSchema = z.object({
  acquereur_id: positiveInt,
  bien_ids: z.array(positiveInt).min(1, 'Au moins un bien_id requis'),
  statut: z.enum(['non_traite', 'envoye', 'refuse']),
});

const enqueueEmailSchema = z.object({
  acquereur_id: positiveInt,
  bien_ids: z.array(positiveInt).min(1, 'Au moins un bien_id requis'),
  channel: z.enum(['email', 'sms', 'both']).optional(),
});

// Ringover : numéro E.164 normalisé (commence par + suivi de 8 à 15 chiffres)
function formatPhoneE164(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('0') && s.length === 10) s = '+33' + s.slice(1);
  if (!s.startsWith('+')) s = '+' + s;
  return s;
}

const ringoverNumber = z
  .union([z.literal(''), z.null(), z.undefined(), z.string()])
  .transform((v) => (v === '' || v == null ? null : formatPhoneE164(v)))
  .refine((v) => v === null || /^\+[1-9]\d{7,14}$/.test(v), {
    message: 'Numéro Ringover invalide (format E.164 attendu, ex: +33612345678)',
  });

const ringoverUserId = z
  .union([z.literal(''), z.null(), z.undefined(), z.coerce.number().int().positive()])
  .transform((v) => (v === '' || v == null ? null : Number(v)))
  .nullable();

const updateUserRingoverSchema = z.object({
  ringover_number: ringoverNumber,
  ringover_user_id: ringoverUserId,
});

module.exports = {
  createUserSchema,
  setupPasswordSchema,
  updateAcquereurCriteriaSchema,
  createTodoSchema,
  bulkTodoSchema,
  enqueueEmailSchema,
  updateUserRingoverSchema,
  updateUserRoleSchema,
  updateUserPasswordSchema,
  formatPhoneE164,
};
