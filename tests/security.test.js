'use strict';

const { isBlockedHost } = require('../lib/security');

describe('isBlockedHost', () => {
  test.each([
    ['localhost'],
    ['127.0.0.1'],
    ['10.0.0.1'],
    ['192.168.1.1'],
    ['172.16.0.1'],
    ['172.31.255.254'],
    ['169.254.169.254'],
    ['100.64.0.1'],
    ['::1'],
    ['fc00::1'],
    ['fe80::1'],
    [''],
    [null],
  ])('bloque %s', (host) => {
    expect(isBlockedHost(host)).toBe(true);
  });

  test.each([
    ['google.com'],
    ['8.8.8.8'],
    ['172.15.0.1'],
    ['172.32.0.1'],
    ['11.0.0.1'],
  ])('autorise %s', (host) => {
    expect(isBlockedHost(host)).toBe(false);
  });
});

