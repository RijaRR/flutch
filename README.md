# flutch

## Défi 2 - Évolution Fonctionnelle Full Stack

### Base de données

Migration SQL pour ajouter le champ `dpe` uniquement aux tables `biens` et `acquereur_criteria` :

```sql
ALTER TABLE biens ADD COLUMN IF NOT EXISTS dpe TEXT;
ALTER TABLE acquereur_criteria ADD COLUMN IF NOT EXISTS dpe TEXT;
```

Dans le projet, cette migration est intégrée dans `initSchema()` via [db.js](https://github.com/RijaRR/flutch/blob/defis2/db.js#L242):

```js
const migrations = [
  'ALTER TABLE biens ADD COLUMN IF NOT EXISTS dpe TEXT',
  'ALTER TABLE acquereur_criteria ADD COLUMN IF NOT EXISTS dpe TEXT',
];
```

### Intégration CRM

Le champ DPE est résolu depuis Pipedrive puis persisté dans PostgreSQL.

Dans [pipedrive/fieldMapping.js](https://github.com/RijaRR/flutch/blob/defis2/pipedrive/fieldMapping.js#L96), le mapping ajoute la clé DPE sur les biens :

```js
dpe: findKey('dpe'),
```

Dans [pipedrive/sync.js](https://github.com/RijaRR/flutch/blob/defis2/pipedrive/sync.js#L58), on extrait puis on sauvegarde le DPE des biens :

```js
const KEYS = {
  ...,
  dpe: findKey('dpe'),
};

const dpe = g(KEYS.dpe) || null;
```

Puis lors de l'`INSERT ... ON CONFLICT` sur `biens` :

```js
INSERT INTO biens (..., synced_at, dpe)
VALUES (..., NOW(), $51)
ON CONFLICT(pipedrive_deal_id) DO UPDATE SET
  ...,
  dpe=EXCLUDED.dpe
```

Pour les acquéreurs, le DPE est stocké dans `acquereur_criteria` :

```js
const KEYS = {
  ...ACQ_KEYS,
  dpe: findKey('dpe'),
};
```

Puis :

```js
INSERT INTO acquereur_criteria (
  acquereur_id, budget_min, budget_max, rentabilite_min,
  occupation_status, occupation_ids, secteurs, apport, condition_pret, dpe, updated_at
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
ON CONFLICT(acquereur_id) DO UPDATE SET
  ...,
  dpe=EXCLUDED.dpe,
  updated_at=NOW()
```

La même logique est aussi appliquée dans [pipedrive/webhookSync.js](https://github.com/RijaRR/flutch/blob/defis2/pipedrive/webhookSync.js) pour la synchronisation temps réel.

### Algorithmique

Le matching DPE repose sur trois fonctions utilitaires dans `db.js` :

```js
const DPE_VALUES = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G']);

function normalizeDpeLabel(value) {
  if (value == null) return null;
  const text = String(value).trim().toUpperCase();
  if (!text) return null;

  const tokens = text.match(/[A-Z]+/g) || [];
  const validTokens = tokens.filter((token) => DPE_VALUES.includes(token));
  if (validTokens.length > 0) return validTokens[validTokens.length - 1];

  return DPE_VALUES.includes(text) ? text : null;
}

function parseDpeCriteria(value) {
  if (value == null) return [];
  const matches = String(value).toUpperCase().match(/[A-G]/g) || [];
  return [...new Set(matches.filter((token) => DPE_VALUES.includes(token)))];
}

function dpeMatchesCriteria(bienDpe, criteriaDpe) {
  const allowedValues = parseDpeCriteria(criteriaDpe);
  if (allowedValues.length === 0) return true;
  const current = normalizeDpeLabel(bienDpe);
  if (!current) return false;
  return allowedValues.includes(current);
}
```

Cette logique garantit qu'un acquéreur qui exige `A` ou `B` ne reçoit jamais un bien `F`.

Application dans `matchAcquereurToBiens()` :

```js
if (!criteria?.dpe) return rows;

return rows.filter((bien) => bien.todo_id || dpeMatchesCriteria(bien.dpe, criteria.dpe));
```

Application dans `matchBienToAcquereurs()` :

```js
return acquereurs.filter(a => {
  try {
    if (a.todo_id) return true;
    if (a.dpe && !dpeMatchesCriteria(bien.dpe, a.dpe)) return false;
    ...
    return true;
  } catch (_) { return false; }
});
```

Comportement obtenu :

- Si un acquéreur demande `A`, seuls les biens `A` matchent.
- Si un acquéreur demande `A OU B`, seuls les biens `A` et `B` matchent.
- Un bien `F` ne peut donc jamais être proposé à un acquéreur qui exige `A` ou `B`.
- Les `todos` déjà existants restent visibles pour préserver l'historique métier.
