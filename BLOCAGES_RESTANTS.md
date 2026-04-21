# Blocages Restants — Le Flutch (Post-Audit)

## Items traités avec réserves

### 1. Suppression du fichier racine `pipedrive.js`
Le monolithe `pipedrive.js` (901 lignes) a été découpé en `pipedrive/client.js`, `pipedrive/fieldMapping.js` et `pipedrive/index.js`. Cependant le fichier racine `pipedrive.js` est toujours présent et utilisé par `pipedrive/index.js` via `require('../pipedrive')`. La suppression complète nécessite de migrer toutes les fonctions restantes (syncBiens, syncAcquereurs, syncSingleBien, syncSingleAcquereur, archiveDeal, etc.) vers des sous-modules dédiés dans `pipedrive/`. Ce travail est volumineux (~800 lignes de logique métier) et présente un risque de régression élevé sans tests d'intégration Pipedrive. **Recommandation** : migration incrémentale fonction par fonction avec tests manuels après chaque étape.

### 2. Tests d'intégration
L'application n'a que des tests unitaires (`tests/format.test.js`, `tests/security.test.js`, etc.). Il manque des tests d'intégration pour les routes critiques (auth, IDOR, webhook, email queue). **Recommandation** : ajouter `supertest` + un container PostgreSQL de test pour valider les parcours critiques.

### 3. Migration frontend vers framework
L'extraction CSS/JS de `search.html` (3978 → 580 lignes) est faite, mais le frontend reste en Vanilla JS (~2400 lignes dans `app.js`). La migration vers un framework (React/Vue/Svelte) n'était pas dans le périmètre de l'audit mais serait bénéfique pour la maintenabilité à moyen terme.

### 4. AbortController sur les fetch frontend
L'audit mentionne l'ajout d'`AbortController` sur les appels `fetch()` côté client pour annuler les requêtes obsolètes (changement rapide de filtre, double-click). Non implémenté car cela nécessite un refactoring profond du state management frontend qui serait mieux fait dans le cadre d'une migration framework (point 3).

### 5. Webhook advisory lock côté webhook handler
Le verrou advisory est implémenté côté auto-sync (`withSyncLock`). Côté webhook handler (`routes/webhooks.js`), le traitement est fire-and-forget après `res.status(200)`. L'ajout d'un `lockDeal()` dans le handler webhook nécessiterait de restructurer le traitement asynchrone en transactions, ce qui est un changement significatif. Le module `lib/syncLock.js` expose `lockDeal()` prêt à l'emploi pour une intégration future.

## Items non bloquants — notes techniques

- **CSP `unsafe-inline` pour les styles** : nécessaire car Font Awesome et les styles inline dans le HTML email templates en dépendent. Supprimable uniquement après migration vers des classes CSS pures.
- **`sameSite: 'none'` en dev** : requis pour la compatibilité iframe Replit. En production c'est `strict`.
- **Le backup JSON (`/admin/backup`)** charge tout en mémoire — pas de streaming. Acceptable tant que la base reste < 100 Mo.
