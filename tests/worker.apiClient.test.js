'use strict';

const { ApiError, FlutchApiClient } = require('../worker/apiClient');

function createResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe('FlutchApiClient', () => {
  test('se reconnecte automatiquement après un 401', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        token: 'token-1',
        user: { id: 8, role: 'agent' },
      }))
      .mockResolvedValueOnce(createResponse(401, { error: 'expired' }))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        token: 'token-2',
        user: { id: 8, role: 'agent' },
      }))
      .mockResolvedValueOnce(createResponse(200, {
        total_acquereurs: 1,
        total_todos: 2,
        acquereurs: [],
      }));

    const client = new FlutchApiClient({
      baseUrl: 'https://flutch.test',
      email: 'mickael@test',
      password: 'secret',
      fetchImpl,
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    const dashboard = await client.getDashboard();

    expect(dashboard.total_acquereurs).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[2][0]).toBe('https://flutch.test/api/login');
    expect(fetchImpl.mock.calls[3][1].headers.Authorization).toBe('Bearer token-2');
  });

  test('remonte une erreur API exploitable quand la réponse n’est pas OK', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        token: 'token-1',
        user: { id: 8, role: 'agent' },
      }))
      .mockResolvedValueOnce(createResponse(500, { error: 'boom' }));

    const client = new FlutchApiClient({
      baseUrl: 'https://flutch.test',
      email: 'mickael@test',
      password: 'secret',
      fetchImpl,
    });

    const failingPromise = client.getDashboard();

    await expect(failingPromise).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      payload: { error: 'boom' },
    });
    await expect(failingPromise).rejects.toBeInstanceOf(ApiError);
  });
});
