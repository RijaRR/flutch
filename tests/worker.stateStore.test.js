'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkerStateStore } = require('../worker/stateStore');

describe('WorkerStateStore', () => {
  function createStore() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mickael-store-'));
    const filePath = path.join(tempDir, 'state.json');
    let tick = 0;
    return new WorkerStateStore({
      filePath,
      clock: () => new Date(Date.UTC(2026, 3, 21, 9, 0, tick++)),
    });
  }

  test('réserve puis confirme un envoi en persistant les biens déjà traités', () => {
    const store = createStore();
    const reservationId = store.reserveSend(42, [7, 8], { channel: 'both' });

    expect(store.hasBien(42, 7)).toBe(true);
    expect(store.hasBien(42, 8)).toBe(true);

    store.markSent(reservationId, { response: { queued: true } });

    const reloaded = new WorkerStateStore({ filePath: store.filePath });
    expect(reloaded.hasBien(42, 7)).toBe(true);
    expect(reloaded.hasBien(42, 8)).toBe(true);
    expect(reloaded.getState().reservations).toEqual({});
    expect(reloaded.getState().acquereurs['42'].history).toHaveLength(1);
  });

  test('libère une réservation sur erreur API explicite', () => {
    const store = createStore();
    const reservationId = store.reserveSend(12, [99], { channel: 'both' });

    store.releaseReservation(reservationId, { reason: 'api_500' });

    expect(store.hasBien(12, 99)).toBe(false);
    expect(store.getState().acquereurs['12'].history[0]).toMatchObject({
      type: 'released',
      reason: 'api_500',
    });
  });
});
