'use strict';

/**
 * Scheduler robuste — remplace les setTimeout/setInterval naïfs.
 * FIX Audit Phase 4 — Évite le drift, le chevauchement des tâches et les erreurs silencieuses.
 *
 * Fonctionnalités :
 *  - Empêche le chevauchement (mutex par tâche)
 *  - Jitter aléatoire pour éviter les thundering-herd
 *  - Compteurs de run/erreurs pour monitoring
 *  - Arrêt propre via shutdown()
 */

const { logger } = require('./logger');

class ScheduledTask {
  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   * @param {{ intervalMs: number, jitterMs?: number, runAtStart?: boolean, delayMs?: number }} opts
   */
  constructor(name, fn, opts) {
    this.name = name;
    this.fn = fn;
    this.intervalMs = opts.intervalMs;
    this.jitterMs = opts.jitterMs || 0;
    this.runAtStart = opts.runAtStart || false;
    this.delayMs = opts.delayMs || 0;

    this.running = false;
    this.timer = null;
    this.runCount = 0;
    this.errorCount = 0;
    this.lastRun = null;
    this.lastError = null;
    this.stopped = false;
  }

  start() {
    if (this.stopped) return;

    const scheduleNext = () => {
      if (this.stopped) return;
      const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
      this.timer = setTimeout(() => this._tick(scheduleNext), this.intervalMs + jitter);
    };

    if (this.runAtStart) {
      // Lancement initial avec délai optionnel
      this.timer = setTimeout(() => this._tick(scheduleNext), this.delayMs);
    } else {
      scheduleNext();
    }

    logger.info(`⏰ Scheduler: "${this.name}" programmé (intervalle ${this.intervalMs / 1000}s, jitter ${this.jitterMs / 1000}s)`);
  }

  async _tick(scheduleNext) {
    if (this.stopped) return;

    // Mutex : si la tâche précédente tourne encore, on skip
    if (this.running) {
      logger.warn(`⏰ Scheduler: "${this.name}" — skip (encore en cours)`);
      scheduleNext();
      return;
    }

    this.running = true;
    this.lastRun = new Date();
    try {
      await this.fn();
      this.runCount++;
    } catch (e) {
      this.errorCount++;
      this.lastError = e.message;
      logger.error(`❌ Scheduler "${this.name}" erreur: ${e.message}`);
    } finally {
      this.running = false;
      scheduleNext();
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  stats() {
    return {
      name: this.name,
      running: this.running,
      runCount: this.runCount,
      errorCount: this.errorCount,
      lastRun: this.lastRun,
      lastError: this.lastError,
    };
  }
}

/** @type {ScheduledTask[]} */
const tasks = [];

/**
 * Enregistre et démarre une tâche planifiée.
 * @param {string} name
 * @param {() => Promise<void>} fn
 * @param {{ intervalMs: number, jitterMs?: number, runAtStart?: boolean, delayMs?: number }} opts
 * @returns {ScheduledTask}
 */
function schedule(name, fn, opts) {
  const task = new ScheduledTask(name, fn, opts);
  tasks.push(task);
  task.start();
  return task;
}

/**
 * Arrête toutes les tâches planifiées (shutdown propre).
 */
function shutdownAll() {
  logger.info('⏰ Scheduler: arrêt de toutes les tâches');
  tasks.forEach(t => t.stop());
}

/**
 * @returns {Array<ReturnType<ScheduledTask['stats']>>}
 */
function allStats() {
  return tasks.map(t => t.stats());
}

module.exports = { schedule, shutdownAll, allStats, ScheduledTask };
