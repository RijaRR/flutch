'use strict';

const path = require('path');
const { logger: defaultLogger } = require('../lib/logger');
const { ApiError, FlutchApiClient } = require('./apiClient');
const { WorkerStateStore } = require('./stateStore');

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseSecteurs(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MickaelWorker {
  constructor(options = {}) {
    this.logger = options.logger || defaultLogger;
    this.clock = options.clock || (() => new Date());
    this.sleep = options.sleep || sleep;
    this.timezone = options.timezone || process.env.TIMEZONE || 'Europe/Paris';
    this.sendHoursStart = toNumber(options.sendHoursStart ?? process.env.SEND_HOURS_START) ?? 9;
    this.sendHoursEnd = toNumber(options.sendHoursEnd ?? process.env.SEND_HOURS_END) ?? 19;
    this.maxSendsPerCycle = toNumber(options.maxSendsPerCycle ?? process.env.MAX_SENDS_PER_CYCLE) ?? 20;
    this.maxBiensPerSend = toNumber(options.maxBiensPerSend) ?? 3;
    this.delayBetweenSendsMs = toNumber(options.delayBetweenSendsMs ?? process.env.DELAY_BETWEEN_SENDS_MS) ?? 3000;
    this.stateStore = options.stateStore || new WorkerStateStore({
      filePath: options.stateFilePath || path.join(process.cwd(), 'data', 'mickael-state.json'),
      clock: this.clock,
    });
    this.api = options.api || new FlutchApiClient({
      baseUrl: options.baseUrl || process.env.FLUTCH_API_URL,
      email: options.email || process.env.FLUTCH_EMAIL,
      password: options.password || process.env.FLUTCH_PASSWORD,
      fetchImpl: options.fetchImpl,
      logger: this.logger,
    });
  }

  // ============================================================================
  // DEFI 3 - GESTION DES HEURES D'ENVOI
  // Le worker ne doit agir qu'entre 9h et 19h heure de Paris.
  // Cette conversion horaire est faite ici pour éviter tout envoi hors créneau.
  // ============================================================================
  getCurrentHour(date = this.clock()) {
    // formatToParts évite les variations de format localisé qui casseraient un parse naïf.
    const formatter = new Intl.DateTimeFormat('fr-FR', {
      hour: 'numeric',
      hour12: false,
      timeZone: this.timezone,
    });
    const part = formatter.formatToParts(date).find((item) => item.type === 'hour');
    return Number(part && part.value);
  }

  isWithinSendWindow(date = this.clock()) {
    const hour = this.getCurrentHour(date);
    return hour >= this.sendHoursStart && hour < this.sendHoursEnd;
  }

  sortAcquereurs(acquereurs = []) {
    // Le brief suggère de prioriser les acquéreurs les plus récents.
    return [...acquereurs].sort((left, right) => {
      const leftDate = Date.parse(left.pipedrive_updated_at || 0);
      const rightDate = Date.parse(right.pipedrive_updated_at || 0);
      return rightDate - leftDate;
    });
  }

  // ============================================================================
  // DEFI 3 - CONSOMMATION API
  // Le dashboard réel renvoie les prospects avec un tableau `biens`.
  // On transforme ici ce retour API en structure minimale exploitable par le worker:
  // - bien_id
  // - statut
  // - prix_fai
  //
  // C'est ce filtre qui permet ensuite de ne garder QUE les biens non traités
  // avant d'appeler l'endpoint d'envoi `/api/email-queue/enqueue`.
  // ============================================================================
  getEligibleTodos(acquereur) {
    const protectedIds = this.stateStore.getProtectedBienIds(acquereur.id);
    return (acquereur.biens || []).map((bien) => ({
      bien_id: Number(bien.id),
      statut: bien.statut_todo || 'non_traite',
      prix_fai: bien.prix_fai,
    })).filter((todo) => {
      if (todo.statut !== 'non_traite') return false;
      // On exclut aussi les réservations locales pour éviter les renvois après incident.
      if (protectedIds.has(Number(todo.bien_id))) return false;
      return true;
    });
  }

  scoreBien(todo, bienDetail, acquereurDetail) {
    // Heuristique simple: budget, rentabilité, occupation et ville servent à départager les matches.
    let score = 0;
    const prix = toNumber(bienDetail?.prix_fai ?? todo.prix_fai);
    const rentabilite = toNumber(bienDetail?.rentabilite);
    const budgetMin = toNumber(acquereurDetail?.budget_min);
    const budgetMax = toNumber(acquereurDetail?.budget_max);
    const occupation = String(acquereurDetail?.occupation_status || '').trim().toLowerCase();
    const bienOccupation = String(bienDetail?.occupation_status || '').trim().toLowerCase();
    const secteurs = parseSecteurs(acquereurDetail?.secteurs);
    const bienVille = String(bienDetail?.ville || '').trim().toLowerCase();

    if (rentabilite != null) score += rentabilite * 10;
    if (budgetMin != null && prix != null && prix >= budgetMin) score += 15;
    if (budgetMax != null && prix != null && prix <= budgetMax) score += 40;
    if (budgetMax != null && prix != null && prix > budgetMax) {
      score -= Math.min(60, Math.round(((prix - budgetMax) / budgetMax) * 100));
    }
    if (occupation && bienOccupation && occupation === bienOccupation) score += 20;
    if (secteurs.length && bienVille && secteurs.includes(bienVille)) score += 20;

    return score;
  }

  // ============================================================================
  // DEFI 3 - GESTION DES LIMITES
  // La consigne impose un maximum de 3 biens par envoi.
  // Quand il y a plus de 3 matches, on trie les biens pour garder les plus pertinents,
  // puis on coupe strictement à `this.maxBiensPerSend` (3 par défaut).
  // ============================================================================
  async pickBienIds(acquereur, eligibleTodos) {
    if (eligibleTodos.length <= this.maxBiensPerSend) {
      return eligibleTodos.slice(0, this.maxBiensPerSend).map((todo) => Number(todo.bien_id));
    }

    try {
      // Quand il y a trop de matches, on affine avec les endpoints détail du brief.
      const acquereurDetail = await this.api.getAcquereurDetail(acquereur.id);
      const detailsEntries = await Promise.all(
        eligibleTodos.map(async (todo) => {
          const bienDetail = await this.api.getBienDetail(todo.bien_id);
          return {
            bienId: Number(todo.bien_id),
            score: this.scoreBien(todo, bienDetail, acquereurDetail),
          };
        })
      );

      return detailsEntries
        .sort((left, right) => right.score - left.score)
        .slice(0, this.maxBiensPerSend)
        .map((entry) => entry.bienId);
    } catch (error) {
      this.logger.warn(`Scoring détaillé indisponible pour l'acquéreur ${acquereur.id}, fallback dashboard`, {
        message: error.message,
      });
      return eligibleTodos.slice(0, this.maxBiensPerSend).map((todo) => Number(todo.bien_id));
    }
  }

  // ============================================================================
  // DEFI 3 - CONSOMMATION API + GESTION D'ETAT
  //
  // 1. On récupère les biens encore éligibles pour ce prospect.
  // 2. On réserve localement l'envoi dans le fichier JSON via stateStore AVANT l'appel réseau.
  //    Cette réservation protège contre les doublons en cas de crash ou de redémarrage.
  // 3. On déclenche ensuite l'endpoint du défi:
  //      POST /api/email-queue/enqueue
  //      { acquereur_id, bien_ids, channel: "both" }
  // 4. Si l'API confirme, on marque l'envoi comme définitif dans l'état local.
  // 5. Si l'API répond par une erreur explicite, on relâche la réservation.
  //    Si l'erreur est ambiguë (réseau, timeout), on garde la réservation pour éviter
  //    qu'un même bien soit potentiellement renvoyé deux fois au même acquéreur.
  // ============================================================================
  async sendToAcquereur(acquereur) {
    // liste des biens non traités
    const eligibleTodos = this.getEligibleTodos(acquereur);
    if (!eligibleTodos.length) {
      return { status: 'skipped', reason: 'no_eligible_todos', acquereurId: acquereur.id };
    }

    const bienIds = await this.pickBienIds(acquereur, eligibleTodos);
    if (!bienIds.length) {
      return { status: 'skipped', reason: 'no_bien_selected', acquereurId: acquereur.id };
    }

    const reservationId = this.stateStore.reserveSend(acquereur.id, bienIds, {
      channel: 'both',
      contactName: acquereur.contact_name,
    });

    try {
      // Le brief impose l'envoi via /api/email-queue/enqueue avec channel "both".
      const response = await this.api.enqueueEmail(acquereur.id, bienIds, 'both');
      this.stateStore.markSent(reservationId, { response });
      this.logger.info(`Envoi réussi vers ${acquereur.contact_name || acquereur.id}`, {
        acquereurId: acquereur.id,
        bienIds,
      });
      return {
        status: 'sent',
        acquereurId: acquereur.id,
        bienIds,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        // Réponse API claire: on peut relâcher, l'appel n'a pas été accepté côté Flutch.
        this.stateStore.releaseReservation(reservationId, {
          reason: `api_${error.status || 'error'}`,
        });
      } else {
        // Erreur ambiguë: on conserve la réservation pour éviter un doublon au cycle suivant.
        this.logger.error(`Erreur réseau ambiguë, réservation conservée pour ${acquereur.id}`, {
          acquereurId: acquereur.id,
          bienIds,
          message: error.message,
        });
      }

      throw error;
    }
  }

  // ============================================================================
  // DEFI 3 - SCRIPT COMPLET DU WORKER
  //
  // Cette méthode orchestre le cycle complet demandé dans l'énoncé:
  // - vérifier la fenêtre horaire
  // - interroger l'API Flutch pour récupérer les prospects
  // - filtrer les biens non traités
  // - envoyer les biens sélectionnés
  // - limiter le nombre de prospects traités par cycle
  // - respecter le rate limiting avec une pause entre deux envois
  //
  // AUTHENTIFICATION:
  // Le login HTTP, le stockage du token JWT et la reconnexion automatique sur 401
  // sont encapsulés dans `this.api` (voir `worker/apiClient.js`), puis utilisés ici
  // de façon transparente via `getDashboard()` et `enqueueEmail()`.
  //
  // GESTION D'ETAT:
  // `this.stateStore` persiste localement l'historique et les réservations pour
  // garantir qu'après un crash, un bien déjà réservé ou déjà envoyé ne reparte pas.
  // ============================================================================
  async runCycle() {
    if (!this.isWithinSendWindow()) {
      this.logger.info('Worker Mickael en pause: hors heures d’envoi');
      return {
        status: 'skipped',
        reason: 'outside_send_window',
        sent: 0,
      };
    }

    const dashboard = await this.api.getDashboard();
    const acquereurs = this.sortAcquereurs(dashboard.acquereurs || []);
    let sent = 0;
    let errors = 0;

    for (const acquereur of acquereurs) {
      if (sent >= this.maxSendsPerCycle) break;

      try {
        const result = await this.sendToAcquereur(acquereur);
        if (result.status === 'sent') {
          sent += 1;
          if (sent < this.maxSendsPerCycle) {
            // Petit délai volontaire pour ménager la queue et rester proche du brief.
            await this.sleep(this.delayBetweenSendsMs);
          }
        }
      } catch (error) {
        errors += 1;
        this.logger.error(`Échec d'envoi pour l'acquéreur ${acquereur.id}`, {
          acquereurId: acquereur.id,
          message: error.message,
        });
      }
    }

    return {
      status: 'completed',
      totalAcquereurs: dashboard.total_acquereurs || acquereurs.length,
      totalTodos: dashboard.total_todos || 0,
      sent,
      errors,
    };
  }
}

module.exports = {
  MickaelWorker,
  sleep,
};
