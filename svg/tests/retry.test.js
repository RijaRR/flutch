'use strict';

jest.mock('../lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  redact: (x) => x,
}));

const { withRetry } = require('../lib/retry');

describe('withRetry', () => {
  test('réussit du premier coup', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('réessaie puis réussit', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      n++;
      if (n < 3) throw new Error('boom');
      return 'ok';
    });
    await expect(
      withRetry(fn, { retries: 3, minDelayMs: 1, maxDelayMs: 2 })
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('échoue après épuisement des tentatives', async () => {
    const fn = jest.fn(async () => {
      throw new Error('always fail');
    });
    await expect(
      withRetry(fn, { retries: 2, minDelayMs: 1, maxDelayMs: 2, label: 'test' })
    ).rejects.toThrow('always fail');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('respecte shouldRetry', async () => {
    const fn = jest.fn(async () => {
      throw new Error('fatal');
    });
    await expect(
      withRetry(fn, { retries: 5, minDelayMs: 1, shouldRetry: () => false })
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
