'use strict';

const { pool } = require('../db');
const BiensRepository = require('./biens');
const AcquereursRepository = require('./acquereurs');
const TodosRepository = require('./todos');
const EmailQueueRepository = require('./emailQueue');

// Singleton instances — injectent le pool de production.
// Pour les tests, instancier directement la classe avec un mock pool.
const biensRepo = new BiensRepository(pool);
const acquereursRepo = new AcquereursRepository(pool);
const todosRepo = new TodosRepository(pool);
const emailQueueRepo = new EmailQueueRepository(pool);

module.exports = {
  biensRepo,
  acquereursRepo,
  todosRepo,
  emailQueueRepo,
  // Export des classes pour permettre l'injection de dépendances dans les tests
  BiensRepository,
  AcquereursRepository,
  TodosRepository,
  EmailQueueRepository,
};
