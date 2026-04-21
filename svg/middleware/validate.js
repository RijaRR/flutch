'use strict';

/**
 * Crée un middleware Express qui parse req.body avec un schéma Zod.
 * En cas de succès, remplace req.body par les données parsées (typées/coercées).
 * En cas d'échec, renvoie 400 avec le détail des erreurs.
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('express').RequestHandler}
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      return res.status(400).json({ error: 'Données invalides', details });
    }
    req.body = result.data;
    next();
  };
}

module.exports = validate;
