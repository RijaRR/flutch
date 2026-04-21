'use strict';

const { ApiError } = require('../worker/apiClient');
const { MickaelWorker } = require('../worker/agent');

describe('MickaelWorker', () => {
  function createLogger() {
    return {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  }

  function createStateStore() {
    const reservations = new Map();
    const sent = new Map();
    let nextId = 1;

    return {
      getProtectedBienIds(acquereurId) {
        const ids = new Set(sent.get(acquereurId) || []);
        for (const reservation of reservations.values()) {
          if (reservation.acquereurId !== acquereurId) continue;
          for (const bienId of reservation.bienIds) ids.add(bienId);
        }
        return ids;
      },
      reserveSend(acquereurId, bienIds) {
        const id = `r${nextId++}`;
        reservations.set(id, { acquereurId, bienIds });
        return id;
      },
      markSent(reservationId) {
        const reservation = reservations.get(reservationId);
        const ids = new Set(sent.get(reservation.acquereurId) || []);
        for (const bienId of reservation.bienIds) ids.add(bienId);
        sent.set(reservation.acquereurId, Array.from(ids));
        reservations.delete(reservationId);
      },
      releaseReservation(reservationId) {
        reservations.delete(reservationId);
      },
    };
  }

  test('ignore les cycles hors fenêtre horaire', async () => {
    const worker = new MickaelWorker({
      api: { getDashboard: jest.fn() },
      stateStore: createStateStore(),
      logger: createLogger(),
      timezone: 'Europe/Paris',
      clock: () => new Date('2026-04-21T05:00:00.000Z'),
    });

    const result = await worker.runCycle();

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'outside_send_window',
      sent: 0,
    });
    expect(worker.api.getDashboard).not.toHaveBeenCalled();
  });

  test('envoie au plus 3 biens et respecte la limite par cycle', async () => {
    const api = {
      getDashboard: jest.fn().mockResolvedValue({
        total_acquereurs: 2,
        total_todos: 6,
        acquereurs: [
          {
            id: 1,
            contact_name: 'Jean',
            pipedrive_updated_at: '2026-04-21T08:00:00.000Z',
            biens: [
              { id: 10, statut_todo: 'non_traite', prix_fai: 100000 },
              { id: 11, statut_todo: 'non_traite', prix_fai: 110000 },
              { id: 12, statut_todo: 'non_traite', prix_fai: 120000 },
              { id: 13, statut_todo: 'non_traite', prix_fai: 130000 },
            ],
          },
          {
            id: 2,
            contact_name: 'Claire',
            pipedrive_updated_at: '2026-04-20T08:00:00.000Z',
            biens: [
              { id: 20, statut_todo: 'non_traite', prix_fai: 90000 },
            ],
          },
        ],
      }),
      getAcquereurDetail: jest.fn().mockResolvedValue({
        budget_min: 90000,
        budget_max: 125000,
        secteurs: 'Paris',
      }),
      getBienDetail: jest.fn((bienId) => Promise.resolve({
        id: bienId,
        prix_fai: bienId === 13 ? 300000 : 100000 + bienId,
        rentabilite: bienId === 12 ? 8 : 6,
        ville: 'Paris',
      })),
      enqueueEmail: jest.fn().mockResolvedValue({ success: true }),
    };

    const worker = new MickaelWorker({
      api,
      stateStore: createStateStore(),
      logger: createLogger(),
      timezone: 'Europe/Paris',
      clock: () => new Date('2026-04-21T08:30:00.000Z'),
      maxSendsPerCycle: 1,
      delayBetweenSendsMs: 1,
      sleep: jest.fn().mockResolvedValue(undefined),
    });

    const result = await worker.runCycle();

    expect(result).toMatchObject({
      status: 'completed',
      sent: 1,
      errors: 0,
    });
    expect(api.enqueueEmail).toHaveBeenCalledTimes(1);
    expect(api.enqueueEmail).toHaveBeenCalledWith(1, [12, 10, 11], 'both');
  });

  test('utilise le format dashboard réel avec biens + statut_todo', async () => {
    const api = {
      getDashboard: jest.fn().mockResolvedValue({
        total_acquereurs: 1,
        total_todos: 2,
        acquereurs: [
          {
            id: 33,
            contact_name: 'Alice',
            biens: [
              { id: 501, statut_todo: null, prix_fai: 100000 },
              { id: 502, statut_todo: 'envoye', prix_fai: 90000 },
              { id: 503, statut_todo: 'non_traite', prix_fai: 95000 },
            ],
          },
        ],
      }),
      enqueueEmail: jest.fn().mockResolvedValue({ success: true }),
    };

    const worker = new MickaelWorker({
      api,
      stateStore: createStateStore(),
      logger: createLogger(),
      timezone: 'Europe/Paris',
      clock: () => new Date('2026-04-21T08:30:00.000Z'),
      maxSendsPerCycle: 1,
    });

    const result = await worker.runCycle();

    expect(result.sent).toBe(1);
    expect(api.enqueueEmail).toHaveBeenCalledWith(33, [501, 503], 'both');
  });

  test('relâche la réservation quand l’API répond en erreur claire', async () => {
    const stateStore = createStateStore();
    const api = {
      getDashboard: jest.fn().mockResolvedValue({
        total_acquereurs: 1,
        total_todos: 1,
        acquereurs: [
          {
            id: 7,
            contact_name: 'Nadia',
            biens: [{ id: 88, statut_todo: 'non_traite', prix_fai: 100000 }],
          },
        ],
      }),
      enqueueEmail: jest.fn().mockRejectedValue(new ApiError('boom', { status: 500 })),
    };

    const worker = new MickaelWorker({
      api,
      stateStore,
      logger: createLogger(),
      timezone: 'Europe/Paris',
      clock: () => new Date('2026-04-21T08:30:00.000Z'),
    });

    const result = await worker.runCycle();

    expect(result.errors).toBe(1);
    expect(stateStore.getProtectedBienIds(7).has(88)).toBe(false);
  });
});
