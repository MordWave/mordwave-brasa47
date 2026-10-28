import { describe, expect, it, vi } from 'vitest';
import { applyHttpServerTimeouts, configureHttpApp } from './app.setup.js';

describe('applyHttpServerTimeouts', () => {
  it('sets keepAlive 65s, headers 66s and request 120s', () => {
    const server = { keepAliveTimeout: 0, headersTimeout: 0, requestTimeout: 0 };
    applyHttpServerTimeouts(server);
    expect(server).toEqual({ keepAliveTimeout: 65_000, headersTimeout: 66_000, requestTimeout: 120_000 });
  });

  it('keeps headersTimeout above keepAliveTimeout (required by Node)', () => {
    const server = { keepAliveTimeout: 0, headersTimeout: 0, requestTimeout: 0 };
    applyHttpServerTimeouts(server);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.requestTimeout).toBeGreaterThan(server.headersTimeout);
  });
});

describe('configureHttpApp', () => {
  it('registers only the JSON parser (200kb limit) and the urlencoded parser (extended), both with inflate: false', () => {
    const useBodyParser = vi.fn();
    configureHttpApp({ useBodyParser } as never);
    expect(useBodyParser.mock.calls).toEqual([
      ['json', { limit: '200kb', inflate: false }],
      ['urlencoded', { extended: true, inflate: false }],
    ]);
  });
});
