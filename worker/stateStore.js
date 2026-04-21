'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class WorkerStateStore {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(process.cwd(), 'data', 'mickael-state.json');
    this.clock = options.clock || (() => new Date());
    this.state = this.load();
  }

  createDefaultState() {
    return {
      version: 1,
      acquereurs: {},
      reservations: {},
    };
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return this.createDefaultState();
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version || 1,
      acquereurs: parsed.acquereurs || {},
      reservations: parsed.reservations || {},
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getState() {
    return clone(this.state);
  }

  ensureAcquereur(acquereurId) {
    const key = String(acquereurId);
    if (!this.state.acquereurs[key]) {
      this.state.acquereurs[key] = {
        sentBienIds: [],
        history: [],
        lastSentAt: null,
      };
    }
    return this.state.acquereurs[key];
  }

  getProtectedBienIds(acquereurId) {
    const record = this.ensureAcquereur(acquereurId);
    const protectedIds = new Set(record.sentBienIds.map(Number));
    // Une réservation en cours protège aussi le bien contre un second envoi après crash/restart.
    for (const reservation of Object.values(this.state.reservations)) {
      if (String(reservation.acquereurId) !== String(acquereurId)) continue;
      for (const bienId of reservation.bienIds || []) {
        protectedIds.add(Number(bienId));
      }
    }
    return protectedIds;
  }

  hasBien(acquereurId, bienId) {
    return this.getProtectedBienIds(acquereurId).has(Number(bienId));
  }

  reserveSend(acquereurId, bienIds, metadata = {}) {
    const reservationId = crypto.randomUUID();
    const now = this.clock().toISOString();

    // On persiste avant l'appel réseau pour privilégier l'absence de doublons.
    this.state.reservations[reservationId] = {
      id: reservationId,
      acquereurId: Number(acquereurId),
      bienIds: bienIds.map(Number),
      channel: metadata.channel || 'both',
      createdAt: now,
      contactName: metadata.contactName || null,
    };

    this.save();
    return reservationId;
  }

  markSent(reservationId, metadata = {}) {
    const reservation = this.state.reservations[reservationId];
    if (!reservation) {
      throw new Error(`Réservation inconnue: ${reservationId}`);
    }

    // Une fois l'envoi confirmé, les biens rejoignent l'historique permanent de l'acquéreur.
    const record = this.ensureAcquereur(reservation.acquereurId);
    const sent = new Set(record.sentBienIds.map(Number));
    for (const bienId of reservation.bienIds) {
      sent.add(Number(bienId));
    }

    const sentAt = this.clock().toISOString();
    record.sentBienIds = Array.from(sent).sort((a, b) => a - b);
    record.lastSentAt = sentAt;
    record.history.push({
      type: 'sent',
      reservationId,
      bienIds: reservation.bienIds,
      sentAt,
      channel: reservation.channel,
      response: metadata.response || null,
    });

    delete this.state.reservations[reservationId];
    this.save();
  }

  releaseReservation(reservationId, metadata = {}) {
    const reservation = this.state.reservations[reservationId];
    if (!reservation) return;

    // On relâche uniquement les réservations pour les erreurs API explicites et rejouables.
    const record = this.ensureAcquereur(reservation.acquereurId);
    record.history.push({
      type: 'released',
      reservationId,
      bienIds: reservation.bienIds,
      releasedAt: this.clock().toISOString(),
      reason: metadata.reason || 'unknown',
    });

    delete this.state.reservations[reservationId];
    this.save();
  }
}

module.exports = {
  WorkerStateStore,
};
